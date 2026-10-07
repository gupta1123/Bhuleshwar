import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import sharp from "sharp";

import { summarizeCase } from "@/lib/case-summary";
import { DEFAULT_COMPARISON_OPTIONS, normalizeComparableValue, readComparisonOptions } from "@/lib/comparison";
import {
  ACTIVE_FIELD_DEFINITIONS,
  FIELD_LABELS,
  getFieldKeysForDocType,
  omitIgnoredFields,
} from "@/lib/document-schema";
import { getPersistedPacketFieldConfiguration } from "@/lib/field-settings-service";
import { applyInvoiceCommercialFieldFallback } from "@/lib/invoice-commercial-fields";
import {
  enrichDocumentsWithPacketGstTaxContext,
  isCommercialDocType,
  normalizeExtractedCommercialLineItems,
  sanitizeLineItems,
} from "@/lib/line-items";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isActionableTermsComplianceStatus, TERMS_COMPLIANCE_FIELD } from "@/lib/terms-compliance";
import { verifyGroupedCaseDocuments } from "@/services/verification";
import type {
  CaseAnalysisMode,
  CaseDoc,
  CommercialLineItem,
  DocType,
  ExtractionQualityIssue,
  FieldKey,
  Mismatch,
} from "@/types/pipeline";

import {
  callExtractionReviewModel,
  callOpenRouter,
  getExtractionReviewProvider,
  getExtractionReviewModel,
  getExtractionReviewReasoningEffort,
  getQualityExtractionModel,
  getQualityExtractionReasoning,
} from "./openrouter";

const STORAGE_BUCKET = "packet-files";
const execFileAsync = promisify(execFile);
const PDF_RENDER_DPI = Number(process.env.PACKET_PDF_RENDER_DPI ?? 160);
const PDF_RENDER_MAX_PAGES = Number(process.env.PACKET_PDF_RENDER_MAX_PAGES ?? 8);
const PDF_SMART_SPLIT_MAX_PAGES = Number(process.env.PACKET_PDF_SMART_SPLIT_MAX_PAGES ?? 20);
const PROVIDER_IMAGE_HARD_LIMIT_BYTES = Number(process.env.PACKET_PROVIDER_IMAGE_HARD_LIMIT_BYTES ?? 20 * 1024 * 1024);
const PROVIDER_IMAGE_TARGET_BYTES = Number(process.env.PACKET_PROVIDER_IMAGE_TARGET_BYTES ?? 8 * 1024 * 1024);
const PROVIDER_IMAGE_MAX_DIMENSION = Number(process.env.PACKET_PROVIDER_IMAGE_MAX_DIMENSION ?? 3200);
const PACKET_AI_CONCURRENCY = Math.max(
  1,
  Math.min(6, Number(process.env.PACKET_AI_CONCURRENCY ?? 3) || 3)
);
const PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY = "Vehicle number is not clearly visible in this image.";
const PO_NUMBER_FIELD_KEYS: FieldKey[] = ["poNumber", "referencePoNumber"];
const INDENT_LABEL_PATTERN = /\b(?:indent|ind\.?\s*no|indent\s*(?:no|number|form|ref|reference)?)\b/i;
const PURCHASE_ORDER_LABEL_PATTERN = /\b(?:(?:p\.?\s*o\.?|po|purchase\s+order)\s*(?:no|number|#)?|order\s*(?:no|number|#))\b/i;
const INTERNAL_PO_REFERENCE_PATTERN = /\b[A-Z]{1,4}\/(?:[A-Z]{1,4}\/)?\d{2}-\d{2}\/[A-Z0-9][A-Z0-9/-]{2,}\b/g;
const IMAGE_HANDWRITTEN_EXTRACTION_INSTRUCTION =
  "Some packet documents are handwritten/manual or mixed printed and handwritten. Treat handwritten entries as first-class visible text, not as noise. Carefully inspect handwritten numbers, dates, party names, vehicle numbers, challan/receipt/permit/certificate numbers, financial amounts, weights, quantities, table cells, stamps, and signatures. Preserve readable handwriting in visibleText. Do not infer a handwritten value from other documents, file names, or nearby labels; if a value is only partly legible, omit the structured field and keep the uncertain transcription in visibleText. ";
const TEXT_HANDWRITTEN_EXTRACTION_INSTRUCTION =
  "This text may come from PDF embedded text/OCR and can omit handwritten entries. Use only the provided text; do not guess handwritten values that are not present. If the text shows manual or handwritten content, preserve it in visibleText and extract it when clearly labelled. ";
const AMOUNT_EXTRACTION_INSTRUCTION =
  "Copy financial amounts exactly as printed, preserving digit count and decimal placement after removing separators. Do not add or drop zeros. Cross-check quantity x rate, taxable amount + tax amount, and subtotal + tax amount before returning totals; if arithmetic conflicts with a visually uncertain amount, prefer the arithmetically consistent value visible in the row/summary. Extract visible GST/tax percentage fields as taxRate, cgstRate, sgstRate, and igstRate; do not put tax percentages into taxAmount. For invoices, extract printed total GST as taxAmount and separately extract freightAmount and freightGstRate; normal income-tax TDS under section 194Q as tds194qAmount and tds194qRate; goods-transport TDS as transportTdsAmount and transportTdsRate; GST withholding as cgstTdsAmount, sgstTdsAmount, igstTdsAmount, and gstTdsRate; and TCS and round-off as tcsAmount and roundOffAmount. Keep deductions separate and never infer an amount that is absent. Use tdsAmount and tdsRate only when the document does not identify the TDS type. Use GSTIN state codes for GST type: same-state or state code 27 means CGST+SGST split, while different-state/non-27 means IGST. ";
const CONSIGNEE_EXTRACTION_INSTRUCTION =
  "If a party is labelled Consignee, Ship To, or Recipient, map it to buyerName/buyerGstin only when that party is Kalika or Kalika Steel Alloys. If the consignee/ship-to/recipient is any other party, do not use that value as buyerName or buyerGstin; keep it only in visibleText or address fields when applicable. ";
const CONSIGNEE_NAME_ALIASES = new Set(["consigneeName", "consignee", "shipToName", "recipientName"]);
const CONSIGNEE_GSTIN_ALIASES = new Set(["consigneeGstin", "shipToGstin", "recipientGstin"]);
const INTERNAL_CONSIGNEE_GSTINS = new Set(["27AACCK1502A1ZD"]);
const CONSIGNEE_CONTEXT_PATTERN = /\b(?:consignee|ship\s*to|ship-to|recipient)\b/i;
const DIRECT_BUYER_CONTEXT_PATTERN = /\b(?:buyer|bill\s*to|bill-to|customer|purchaser)\b/i;
const STORE_EVIDENCE_DOC_TYPES = new Set<DocType>(["Invoice", "Tax Invoice", "Delivery Challan", "Delivery Note"]);
const STAMP_SIGNATURE_EXTRACTION_INSTRUCTION =
  "For stamp/signature presence fields, return only Yes, No, or Unclear. Use Yes only when the mark is visibly present, No only when the relevant area is visible and clearly absent, otherwise Unclear. For invoice/delivery receiving evidence, a buyer or receiver stamp block such as Kalika, SMS Division, Store, Gate, or Security with Date and Name & Sign lines means hasStoreStamp=Yes; if handwritten marks or signatures appear on those Name & Sign lines, hasStoreSignature=Yes. Do not confuse the supplier Authorized Signatory with store signature. ";

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<R>
) {
  if (!items.length) return [] as R[];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await handler(items[currentIndex], currentIndex);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function resolvePdfJsWorkerSrc() {
  const candidates = [
    path.resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    path.resolve(process.cwd(), "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    path.resolve(process.cwd(), "../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
    path.resolve(process.cwd(), "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ];

  const existingPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existingPath) {
    throw new Error("Unable to locate pdfjs-dist worker file in node_modules.");
  }

  return pathToFileURL(existingPath).href;
}

const PDFJS_WORKER_SRC = resolvePdfJsWorkerSrc();

const SUPPORTED_DOC_TYPES: DocType[] = [
  "Purchase Order",
  "Amended Purchase Order",
  "Invoice",
  "Tax Invoice",
  "E-Way Bill",
  "Weighment Slip",
  "Lorry Receipt",
  "Vehicle Registration Certificate",
  "Driving Licence",
  "PAN Card",
  "FASTag Toll Proof",
  "Material Test Certificate",
  "Photo Evidence",
  "Transport Permit",
  "Receipt",
  "Delivery Note",
  "Delivery Challan",
  "Bank Statement",
  "Map Printout",
  "Payment Screenshot",
  "Unknown",
];

const ALL_ALLOWED_FIELD_KEYS = ACTIVE_FIELD_DEFINITIONS.map((field) => field.key);

const FIELD_MAPPINGS: Partial<Record<FieldKey, string[]>> = {
  vendorName: ["vendorName", "sellerName", "supplierName", "vendor", "seller", "supplier", "consignorName", "issuerName"],
  supplierGstin: ["supplierGstin", "vendorGstin", "sellerGstin", "gstin", "gstinUin"],
  buyerName: ["buyerName", "customerName", "consigneeName", "buyer", "customer", "consignee", "billToName", "shipToName", "recipientName", "purchaserName"],
  buyerGstin: ["buyerGstin", "customerGstin", "consigneeGstin", "shipToGstin", "billToGstin", "recipientGstin", "purchaserGstin"],
  poNumber: ["poNumber", "purchaseOrderNumber"],
  poAmendmentNumber: ["poAmendmentNumber", "amendmentNumber", "poVersion", "revisionNumber"],
  invoiceNumber: ["invoiceNumber", "billNumber"],
  receiptNumber: ["receiptNumber"],
  deliveryNoteNumber: ["deliveryNoteNumber", "challanNumber"],
  referencePoNumber: ["referencePoNumber", "poReference", "purchaseOrderReference"],
  referenceInvoiceNumber: ["referenceInvoiceNumber", "invoiceReference", "documentNumber", "docNumber", "docNo"],
  eWayBillNumber: ["eWayBillNumber", "ewayBillNumber", "ewayNumber", "wayBillNumber"],
  weighmentNumber: ["weighmentNumber", "weighmentReceiptNumber", "weighmentSlipNumber"],
  weighbridgeName: ["weighbridgeName", "weighBridgeName", "weightBridgeName"],
  lorryReceiptNumber: ["lorryReceiptNumber", "lrNumber", "transportReceiptNumber", "transporterDocNumber", "transporterDocumentNumber", "consignmentNumber"],
  certificateNumber: ["certificateNumber", "testCertificateNumber", "mtcNumber", "mtrNumber"],
  certificateDate: ["certificateDate", "testCertificateDate", "mtcDate", "certificateIssuedDate"],
  permitNumber: ["permitNumber", "authorisationNumber", "authorizationNumber"],
  permitType: ["permitType", "authorizationType", "permitClass"],
  licenseNumber: ["licenseNumber", "licenceNumber", "drivingLicenseNumber", "drivingLicenceNumber"],
  chassisNumber: ["chassisNumber", "vin", "vehicleIdentificationNumber"],
  engineNumber: ["engineNumber", "motorNumber"],
  vehicleClass: ["vehicleClass", "vehicleType"],
  documentDate: ["documentDate", "invoiceDate", "poDate", "receiptDate", "deliveryDate", "generatedDate", "eWayBillDate"],
  ackDate: ["ackDate", "acknowledgementDate", "acknowledgmentDate"],
  transactionDate: ["transactionDate", "transactionTime", "transactionDateTime", "paymentDate", "statementDate"],
  validityDate: ["validityDate", "validUpto", "validUntil", "permitValidityDate", "licenseValidityDate", "licenceValidityDate", "registrationValidityDate"],
  dateOfBirth: ["dateOfBirth", "dob", "birthDate"],
  currency: ["currency"],
  subtotal: ["subtotal", "subTotal"],
  totalTaxableAmount: ["totalTaxableAmount", "totalTaxableAmt", "taxableAmount", "taxableValue", "taxableAmountRs"],
  taxAmount: ["taxAmount", "tax", "gstAmount"],
  taxRate: ["taxRate", "gstRate", "taxPercent", "taxPercentage", "gstPercent", "gstPercentage"],
  cgstRate: ["cgstRate", "centralGstRate", "cgstPercent", "cgstPercentage"],
  sgstRate: ["sgstRate", "stateGstRate", "sgstPercent", "sgstPercentage"],
  igstRate: ["igstRate", "integratedGstRate", "igstPercent", "igstPercentage"],
  tdsAmount: ["tdsAmount", "taxDeductedAtSource", "tdsDeducted", "tds"],
  tdsRate: ["tdsRate", "tdsPercent", "tdsPercentage"],
  tds194qAmount: ["tds194qAmount", "section194qAmount", "tdsPayable194q"],
  tds194qRate: ["tds194qRate", "section194qRate"],
  transportTdsAmount: ["transportTdsAmount", "goodsTransportTdsAmount", "freightTdsAmount"],
  transportTdsRate: ["transportTdsRate", "goodsTransportTdsRate", "freightTdsRate"],
  cgstTdsAmount: ["cgstTdsAmount", "cgstWithholdingAmount"],
  sgstTdsAmount: ["sgstTdsAmount", "sgstWithholdingAmount"],
  igstTdsAmount: ["igstTdsAmount", "igstWithholdingAmount"],
  gstTdsRate: ["gstTdsRate", "gstWithholdingRate"],
  tcsAmount: ["tcsAmount", "taxCollectedAtSource", "tcsCollected", "tcs"],
  roundOffAmount: ["roundOffAmount", "roundoffAmount", "roundingAmount", "roundOff"],
  totalAmount: ["totalAmount", "grandTotal", "documentTotal"],
  paymentTerms: ["paymentTerms", "paymentTerm", "termsOfPayment", "paymentCondition"],
  deliveryTerms: ["deliveryTerms", "deliveryTerm", "deliveryPeriod", "deliverySchedule", "deliveryCondition"],
  freightTerms: ["freightTerms", "freightTerm", "transportTerms", "transportationTerms", "freightCondition"],
  packingForwardingTerms: ["packingForwardingTerms", "packingTerms", "forwardingTerms", "pfTerms", "pAndFTerms", "packingAndForwarding"],
  priceBasis: ["priceBasis", "basisOfPrice", "pricingBasis", "rateBasis"],
  taxTerms: ["taxTerms", "gstTerms", "taxCondition", "dutiesAndTaxes"],
  inspectionTerms: ["inspectionTerms", "qualityTerms", "testingTerms", "testCertificateTerms"],
  warrantyTerms: ["warrantyTerms", "guaranteeTerms", "warrantyGuaranteeTerms"],
  termsAndConditions: ["termsAndConditions", "termsConditions", "commercialTerms", "specialTerms", "generalTerms", "remarks"],
  paidAmount: ["paidAmount", "amountPaid", "paidTollAmount", "tollAmount", "amountReceived", "receivedAmount"],
  statementAmount: ["statementAmount", "availableBalance", "availableBal", "avblBal", "balance", "debitAmount", "creditAmount", "transactionAmount"],
  freightAmount: ["freightAmount", "freight", "transportCharge"],
  freightGstRate: ["freightGstRate", "freightTaxRate", "transportGstRate"],
  advanceAmount: ["advanceAmount", "advancePaid"],
  toPayAmount: ["toPayAmount", "toPay", "ttbAmount"],
  itemDescription: ["itemDescription", "description", "productDescription"],
  materialGrade: ["materialGrade", "grade", "steelGrade"],
  itemQuantity: ["itemQuantity", "quantity", "qty"],
  unit: ["unit", "uom"],
  hsnSac: ["hsnSac", "hsn", "sac", "hsnCode"],
  batchNumber: ["batchNumber", "batchNo", "lotNumber"],
  heatNumber: ["heatNumber", "heatNo", "castLotNo"],
  vehicleNumber: ["vehicleNumber", "truckNumber", "lorryNumber", "vehicleNo", "truckNo"],
  registrationNumber: ["registrationNumber", "registrationNo", "rcNumber", "regnNumber"],
  ownerName: ["ownerName", "registeredOwnerName"],
  transporterName: ["transporterName", "transporter", "transportName", "carrierName"],
  driverName: ["driverName", "licenceHolderName", "licenseHolderName"],
  holderName: ["holderName", "nameOnCard", "panHolderName"],
  fatherName: ["fatherName", "fatherOrSpouseName"],
  panNumber: ["panNumber", "panNo"],
  fuelType: ["fuelType"],
  grossWeight: ["grossWeight", "grossWt"],
  tareWeight: ["tareWeight", "tareWt"],
  netWeight: ["netWeight", "netWt"],
  bankName: ["bankName"],
  accountNumber: ["accountNumber", "accountNo"],
  irnNumber: ["irnNumber", "irn"],
  ackNumber: ["ackNumber", "acknowledgementNumber", "acknowledgmentNumber"],
  transactionReference: ["transactionReference", "utrNumber", "referenceNumber", "paymentReference"],
  fastagReference: ["fastagReference", "fastagId", "tagId", "tagNumber", "tag", "transactionId"],
  fastagStatementReference: ["fastagStatementReference", "statementReferenceNumber", "statementReference"],
  fastagCustomerId: ["fastagCustomerId", "customerId", "customerID"],
  fastagCustomerName: ["fastagCustomerName", "customerName", "tagCustomerName"],
  statementPeriod: ["statementPeriod", "period"],
  statementDate: ["statementDate"],
  openingBalance: ["openingBalance", "openingBal"],
  creditAmount: ["creditAmount", "credit", "totalCredit"],
  debitAmount: ["debitAmount", "debit", "totalDebit"],
  closingBalance: ["closingBalance", "closingBal"],
  tripCount: ["tripCount", "totalTrips"],
  tollTransactionSummary: ["tollTransactionSummary", "transactionSummary", "tripSummary"],
  tollPlaza: ["tollPlaza", "plazaName", "tollLocation"],
  dispatchFrom: ["dispatchFrom", "originAddress", "dispatchAddress"],
  shipTo: ["shipTo", "deliveryAddress", "consigneeAddress"],
  routeFrom: ["routeFrom", "origin", "fromLocation"],
  routeTo: ["routeTo", "destination", "toLocation"],
  mapLocation: ["mapLocation", "address", "registeredAddress", "holderAddress"],
  photoTimestamp: ["photoTimestamp", "captureTimestamp", "evidenceTimestamp"],
  evidenceDescription: ["evidenceDescription", "photoDescription", "observation"],
  hasAuthorizedSignature: ["hasAuthorizedSignature", "authorizedSignature", "authorisedSignature", "signaturePresent", "hasSignature"],
  hasVendorStamp: ["hasVendorStamp", "vendorStamp", "supplierStamp", "sellerStamp", "stampPresent"],
  hasStoreStamp: ["hasStoreStamp", "storeStamp", "receivingStoreStamp", "warehouseStamp"],
  hasStoreSignature: ["hasStoreSignature", "storeSignature", "receivingSignature", "warehouseSignature"],
  hasGateStamp: ["hasGateStamp", "gateStamp", "gateEntryStamp", "securityStamp"],
};

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    const jsonString = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
    return JSON.parse(jsonString) as T;
  } catch {
    return fallback;
  }
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((entry) => toText(entry)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return Object.values(value).map((entry) => toText(entry)).filter(Boolean).join("\n");
  }
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function formatDocType(docType: DocType) {
  return docType === "Unknown" ? "Document" : docType;
}

function getAllowedFieldKeysForDocType(docType: DocType) {
  const docTypeFieldKeys = getFieldKeysForDocType(docType);
  return docTypeFieldKeys.length > 0 ? docTypeFieldKeys : ALL_ALLOWED_FIELD_KEYS;
}

function getLineItemExtractionInstruction(docType: DocType) {
  if (!isCommercialDocType(docType)) {
    return "";
  }

  return (
    "Also extract every commercial table row into a top-level lineItems array. " +
    "Each line item may contain lineNumber, itemCode, description, hsnSac, quantity, unit, rate, discountPercent, netRate, taxableAmount, cgstRate, cgstAmount, sgstRate, sgstAmount, igstRate, igstAmount, taxRate, taxAmount, lineTotal, referencePoLineNumber, rawText, and sourcePage. " +
    "When the prompt text or rendered images contain multiple pages, set sourcePage to the visible page number where the row appears. " +
    "When the item description cell contains a generic item name plus a product/model/specification code, split it: put the generic item name in description and put the remaining product/model/specification text in itemCode. For example, extract \"Guide Roller 5374 ERG150\" as description \"Guide Roller\" and itemCode \"5374 ERG150\". " +
    "Preserve one entry per visible PO, invoice, delivery challan/note, or e-way bill goods row; do not merge different rows or sum unlike units. Use rawText for the original row text when OCR is uncertain. " +
    "Do not extract HSN/SAC-wise tax summary rows as lineItems. Rows that only contain HSN/SAC, taxable value, and tax amount are summary rows, not product/service lines. " +
    "When invoice GST rates appear only in an HSN/SAC tax summary, map the visible CGST, SGST, IGST, or GST rates from that summary onto the matching product/service lineItems by HSN/SAC and taxable amount. " +
    "For invoice rows, taxableAmount is the row amount before GST; when the row shows only quantity, rate, and amount, use that amount as taxableAmount and lineTotal. Do not treat packing, freight, P&F, or other charge percentages as GST rates unless the row or tax summary explicitly labels CGST, SGST, IGST, GST, or tax. " +
    "Only set taxableAmount or lineTotal when a monetary amount/value column is visible. Do not use quantity totals such as TOTAL 1.000 as monetary amounts, and omit amount fields instead of writing 0 when the document does not show an amount. " +
    "For product/service rows, keep item name only in description, keep product/model/specification identifiers in itemCode, and keep HSN/SAC only in hsnSac. Never copy HSN/SAC codes, GST labels, quantities, units, rates, tax rates, taxable amounts, tax amounts, or totals into description or itemCode. "
  );
}

function getDocumentSpecificExtractionInstruction(docType: DocType) {
  switch (docType) {
    case "Purchase Order":
    case "Amended Purchase Order":
      return (
        "For Purchase Order documents, poNumber must be the value explicitly labelled PO No, P.O. No, Purchase Order No, or Order No. " +
        "Never use Indent No, Indent Number, Indent Form, requisition number, or internal indent reference as poNumber; omit poNumber if only an indent number is visible. " +
        "Extract Order Date, PO Date, P.O. Date, or Purchase Order Date as documentDate. Prefer Order Date over Party Ref Date, delivery date, or validity date. " +
        "Capture PO commercial terms from header, footer, remarks, notes, special instructions, and Terms & Conditions sections. " +
        "Extract paymentTerms, deliveryTerms, freightTerms, packingForwardingTerms, priceBasis, taxTerms, inspectionTerms, and warrantyTerms when visible. " +
        "Also fill termsAndConditions with a compact semicolon-separated summary of all visible PO clauses, preserving the original commercial meaning. Do not invent missing terms. "
      );
    case "Tax Invoice":
    case "Invoice":
      return (
        "For invoice documents, extract the supplier invoice date as documentDate. It may be labelled Invoice Date, Date of Invoice, Date, or Dated beside the Invoice No.; return it as YYYY-MM-DD. Do not substitute Ack Date, dispatch date, LR date, e-Way Bill generated date, digitally signed timestamp, or a footer/print date. " +
        "For invoice documents, referencePoNumber must be a value explicitly labelled PO No, P.O. No, Purchase Order No, Buyer PO, or Order No. " +
        "If the same order block contains an internal PO number shaped like IF/25-26/PF25Y-04165 or RM/25-26/PR25Y-00001 and another buyer/document reference, use the internal PO-shaped value as referencePoNumber. " +
        "For invoice documents, eWayBillNumber must be the 12-digit E-Way Bill number only. Do not use transporter document numbers, online order tracking numbers, LR numbers, acknowledgement numbers, or receipt numbers as eWayBillNumber. Do not put a 12-digit E-Way Bill number into irnNumber; IRN is the long invoice reference hash. " +
        "Never use Indent No, Indent Number, Indent Form, requisition number, or internal indent reference as referencePoNumber. "
      );
    case "Delivery Challan":
    case "Delivery Note":
      return (
        "For Delivery Challan or Delivery Note documents, itemQuantity must be the actual goods/item quantity from a goods row. " +
        "Never set itemQuantity from Total Packages, No. of packages, boxes, cartons, bundles, bags, coils packed, packing count, or shipment count. " +
        "If only package count is visible and no actual goods quantity is shown, omit itemQuantity. "
      );
    case "E-Way Bill":
      return (
        "For E-Way Bill documents, vendorName is the From party name in Address Details after the first GSTIN, and buyerName is the To party name after the second GSTIN. " +
        "Do not use Dispatch From or Ship To address text as party names; those belong in dispatchFrom and shipTo. " +
        "Extract Generated Date as documentDate, Valid Upto/Valid Until as validityDate, Tot. Tax'ble Amt or Taxable Amount as totalTaxableAmount and subtotal, Total Inv. Amt as totalAmount, CGST+SGST+IGST+Cess amounts or total minus taxable amount as taxAmount, and derive taxRate from taxAmount/subtotal when the percentage is not printed. " +
        "Extract Transporter ID & Name into transporterName, Transporter Doc. No into lorryReceiptNumber, and the Part-B Vehicle/Trans number into vehicleNumber. " +
        "If Part-A shows Doc No, Document No, Invoice No, Tax Invoice No, or Delivery Challan No, extract that value as referenceInvoiceNumber unless it is the E-Way Bill No itself. "
      );
    case "Lorry Receipt":
      return (
        "For Lorry Receipt documents, prioritize lorryReceiptNumber, vehicleNumber, routeFrom, routeTo, transporterName, netWeight, and authorized signature presence. " +
        "Extract the receipt/consignment date as documentDate. Preserve the printed weight unit (for example KG, MT, or MTS) in netWeight; a declared weight in MTS must not be returned as a unitless number. " +
        "Lorry No is the vehicleNumber. G.C. Note, LR No, Consignment No, or Transporter Doc No is lorryReceiptNumber. " +
        "Do not return package, freight, weight, amount, total, to-pay, or to-be-billed rows as lineItems; keep logistics quantities and weights in fields only. " +
        "Read Indian vehicle numbers carefully from the image; distinguish letters from similar-looking digits, especially G/9, J/S, O/0, S/5, T/7, D/G, and C/G. "
      );
    case "PAN Card":
      return (
        "For PAN Card documents, prioritize panNumber, holderName, fatherName, and dateOfBirth. " +
        "PAN number is a 10-character Indian PAN like ABCDE1234F; do not leave it blank if visible. "
      );
    case "Driving Licence":
      return (
        "For Driving Licence documents, prioritize licenseNumber, driverName, dateOfBirth, validityDate, and mapLocation/address. " +
        "The licence number may be labelled DL No, Licence No, License No, or DL Number. "
      );
    case "Vehicle Registration Certificate":
      return (
        "For Vehicle Registration Certificate documents, prioritize registrationNumber, vehicleNumber, ownerName, chassisNumber, engineNumber, vehicleClass, fuelType, validityDate, and address. "
      );
    case "Weighment Slip":
      return (
        "For Weighment Slip documents, prioritize vehicleNumber/lorry number, grossWeight, tareWeight, netWeight, weighmentNumber, weighbridgeName, and authorized signature presence. " +
        "Extract the weighment date or date-time as documentDate. Preserve the printed unit (for example KG, MT, or MTS) in grossWeight, tareWeight, and netWeight. " +
        "Lorry No or Vehicle No on a weighment slip is the vehicleNumber, not lorryReceiptNumber. Do not use RST No, receipt number, ticket number, tare/gross/net weight, date, or charges as vehicleNumber. " +
        "Do not return weighment rows or weight tables as lineItems; keep gross, tare, and net weights in fields only. " +
        "Read Indian vehicle numbers carefully from the image; distinguish letters from similar-looking digits, especially G/9, L/1, O/0, S/5, T/7, D/G, and C/G. "
      );
    case "Photo Evidence":
      return (
        "For Photo Evidence documents, only return vehicleNumber when the full registration plate characters are clearly readable in the image itself. " +
        `Do not infer a vehicle number from the file name, surrounding documents, or a partial/blurred/cropped plate. If the plate is not clearly visible, omit vehicleNumber and set evidenceDescription to "${PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY}" `
      );
    default:
      return "";
  }
}

function isNonVisibleVehicleNumberValue(value?: string) {
  const compact = value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  if (!compact) return true;

  return (
    compact === "na" ||
    compact === "notavailable" ||
    compact === "unknown" ||
    compact === "unclear" ||
    compact === "illegible" ||
    compact === "unreadable" ||
    compact.includes("notvisible") ||
    compact.includes("notclearlyvisible") ||
    compact.includes("notreadable") ||
    compact.includes("numbernotvisible") ||
    compact.includes("platenotvisible") ||
    compact.includes("blurred") ||
    compact.includes("obscured") ||
    compact.includes("cropped") ||
    compact.includes("partial")
  );
}

function isLikelyVisibleVehicleNumber(value?: string) {
  if (!value || isNonVisibleVehicleNumberValue(value)) return false;
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.length >= 7 && compact.length <= 12 && /[A-Z]/.test(compact) && /\d/.test(compact);
}

function applyPhotoEvidenceVehicleVisibilityCopy(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType
) {
  if (docType !== "Photo Evidence") return fields;

  const next = { ...fields };
  if (isLikelyVisibleVehicleNumber(next.vehicleNumber)) return next;

  delete next.vehicleNumber;
  const description = next.evidenceDescription?.trim();
  if (!description) {
    next.evidenceDescription = PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY;
    return next;
  }

  const compactDescription = description.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!compactDescription.includes("vehiclenumber") || !compactDescription.includes("visible")) {
    next.evidenceDescription = `${description} ${PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY}`;
  }

  return next;
}

function normalizeIdentifierForContext(value?: string) {
  return value?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
}

function getValueContexts(visibleText: string, value: string) {
  const candidate = normalizeIdentifierForContext(value);
  if (!candidate) return [];

  const lines = visibleText
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const contexts = new Set<string>();

  lines.forEach((line, index) => {
    if (normalizeIdentifierForContext(line).includes(candidate)) {
      contexts.add(line);
      if (index > 0) contexts.add(`${lines[index - 1]} ${line}`);
      if (index < lines.length - 1) contexts.add(`${line} ${lines[index + 1]}`);
    }
  });

  return [...contexts];
}

function normalizeCompanySignal(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (["kaliko", "xarika", "xarixa"].includes(token)) return "kalika";
      return token;
    })
    .join(" ");
}

function isInternalConsigneeName(value?: string) {
  return Boolean(value && normalizeCompanySignal(value).split(/\s+/).includes("kalika"));
}

function normalizeGstinSignal(value?: string) {
  return value?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
}

function isInternalConsigneeGstin(value?: string) {
  const normalized = normalizeGstinSignal(value);
  return Boolean(normalized && INTERNAL_CONSIGNEE_GSTINS.has(normalized));
}

function shouldAcceptMappedAlias(fieldKey: FieldKey, alias: string, value: string) {
  if (fieldKey === "buyerName" && CONSIGNEE_NAME_ALIASES.has(alias)) {
    return isInternalConsigneeName(value);
  }

  if (fieldKey === "buyerGstin" && CONSIGNEE_GSTIN_ALIASES.has(alias)) {
    return isInternalConsigneeGstin(value);
  }

  return true;
}

function isConsigneeOnlyContext(visibleText: string, value: string) {
  const contexts = getValueContexts(visibleText, value);
  if (!contexts.length) return false;

  return contexts.some((context) => {
    if (!CONSIGNEE_CONTEXT_PATTERN.test(context)) return false;
    return !DIRECT_BUYER_CONTEXT_PATTERN.test(context);
  });
}

function applyConsigneeBuyerGuard(
  fields: Partial<Record<FieldKey, string>>,
  visibleText: string
) {
  if (!visibleText.trim()) return fields;

  const next = { ...fields };
  let changed = false;
  let droppedConsigneeBuyerName = false;

  if (
    next.buyerName &&
    !isInternalConsigneeName(next.buyerName) &&
    isConsigneeOnlyContext(visibleText, next.buyerName)
  ) {
    delete next.buyerName;
    droppedConsigneeBuyerName = true;
    changed = true;
  }

  if (
    next.buyerGstin &&
    !isInternalConsigneeGstin(next.buyerGstin) &&
    (droppedConsigneeBuyerName || isConsigneeOnlyContext(visibleText, next.buyerGstin))
  ) {
    delete next.buyerGstin;
    changed = true;
  }

  return changed ? next : fields;
}

function isIndentNumberMasqueradingAsPo(value: string, visibleText: string) {
  const contexts = getValueContexts(visibleText, value);
  if (!contexts.length) return false;

  const hasIndentContext = contexts.some((context) => INDENT_LABEL_PATTERN.test(context));
  const hasExplicitPoContext = contexts.some(
    (context) => PURCHASE_ORDER_LABEL_PATTERN.test(context) && !INDENT_LABEL_PATTERN.test(context)
  );

  return hasIndentContext && !hasExplicitPoContext;
}

function applyPoNumberLabelGuard(
  fields: Partial<Record<FieldKey, string>>,
  visibleText: string
) {
  if (!visibleText.trim()) return fields;

  const next = { ...fields };
  PO_NUMBER_FIELD_KEYS.forEach((fieldKey) => {
    const value = next[fieldKey];
    if (value && isIndentNumberMasqueradingAsPo(value, visibleText)) {
      delete next[fieldKey];
    }
  });

  return next;
}

function isInvoiceDocType(docType: DocType) {
  return docType === "Invoice" || docType === "Tax Invoice";
}

function cleanPoReferenceCandidate(value: string) {
  return value.replace(/[.,;:)\]]+$/, "").trim();
}

function isInternalPoReference(value?: string) {
  if (!value) return false;
  const normalized = cleanPoReferenceCandidate(value.toUpperCase());
  return new RegExp(`^${INTERNAL_PO_REFERENCE_PATTERN.source}$`).test(normalized);
}

function findBestInternalPoReference(visibleText: string) {
  const labelledReference = visibleText.match(
    /\b(?:reference\s+po|p\.?\s*o\.?\s*(?:no|number)?|purchase\s+order\s*(?:no|number)?)\s*[:#-]?\s*([A-Z]{1,4}\/(?:[A-Z]{1,4}\/)?\d{2}-\d{2}\/[A-Z0-9][A-Z0-9/-]{2,})\b/i
  )?.[1];
  if (labelledReference) return cleanPoReferenceCandidate(labelledReference.toUpperCase());

  const matches = [...visibleText.toUpperCase().matchAll(INTERNAL_PO_REFERENCE_PATTERN)]
    .map((match) => ({
      value: cleanPoReferenceCandidate(match[0]),
      index: match.index ?? 0,
    }))
    .filter((match, index, all) => all.findIndex((candidate) => candidate.value === match.value) === index);

  if (!matches.length) return undefined;

  return matches
    .map((match) => {
      const contexts = getValueContexts(visibleText, match.value);
      const contextText = contexts.join(" ");
      const score =
        (PURCHASE_ORDER_LABEL_PATTERN.test(contextText) ? 5 : 0) +
        (/\bbuyer'?s?\s+order\b/i.test(contextText) ? 2 : 0) +
        (/\b(?:dated|dtd)\b/i.test(contextText) ? 1 : 0) +
        (/\/P[FR][A-Z0-9-]*/i.test(match.value) ? 2 : 0);
      return { ...match, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.value;
}

function applyInvoicePoReferenceFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string
) {
  if (!isInvoiceDocType(docType) || !visibleText.trim()) return fields;

  const candidate = findBestInternalPoReference(visibleText);
  if (!candidate) return fields;

  const current = fields.referencePoNumber;
  if (current && isInternalPoReference(current)) return fields;

  return { ...fields, referencePoNumber: candidate };
}

const PO_TERMS_FIELD_KEYS: FieldKey[] = [
  "paymentTerms",
  "deliveryTerms",
  "freightTerms",
  "packingForwardingTerms",
  "priceBasis",
  "taxTerms",
  "inspectionTerms",
  "warrantyTerms",
];
const TERMS_FIELD_KEYS: FieldKey[] = [...PO_TERMS_FIELD_KEYS, "termsAndConditions"];
const TERMS_COMPLIANCE_MISMATCH_PREFIX = "terms-compliance";

const PO_TERM_LABELS: Array<{ field: FieldKey; label: string; pattern: RegExp }> = [
  { field: "paymentTerms", label: "Payment", pattern: /^(?:payment\s+terms?|terms?\s+of\s+payment|payment)$/i },
  { field: "deliveryTerms", label: "Delivery", pattern: /^(?:delivery\s+(?:terms?|period|schedule|date)|delivery)$/i },
  { field: "freightTerms", label: "Freight", pattern: /^(?:freight|transport(?:ation)?\s+terms?|transport|dispatch)$/i },
  { field: "packingForwardingTerms", label: "Packing / Forwarding", pattern: /^(?:packing(?:\s*&\s*forwarding)?|p\s*&\s*f|p\s+and\s+f|forwarding)$/i },
  { field: "priceBasis", label: "Price Basis", pattern: /^(?:price\s+basis|basis\s+of\s+price|rate\s+basis|basis)$/i },
  { field: "taxTerms", label: "Tax", pattern: /^(?:tax(?:es)?|gst|duties(?:\s*&\s*taxes)?|tax\s+terms?)$/i },
  { field: "inspectionTerms", label: "Inspection", pattern: /^(?:inspection|quality|testing|test\s+certificate|tc)$/i },
  { field: "warrantyTerms", label: "Warranty", pattern: /^(?:warranty|guarantee|warranty\s*\/\s*guarantee)$/i },
];

function isPurchaseOrderDocType(docType: DocType) {
  return docType === "Purchase Order" || docType === "Amended Purchase Order";
}

const PURCHASE_ORDER_DOCUMENT_DATE_PATTERN =
  "(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{1,2}\\s*[-/.]\\s*[A-Za-z]{3,9}\\s*[-/.]\\s*\\d{2,4})";

function cleanPurchaseOrderDocumentDate(value?: string) {
  return value
    ?.replace(/\s*([-/])\s*/g, "$1")
    .replace(/\s*\.\s*/g, ".")
    .trim()
    .toUpperCase();
}

function extractPurchaseOrderDocumentDate(visibleText: string) {
  const text = visibleText.replace(/\s+/g, " ").trim();
  const dateLabel =
    "(?:(?:Purchase\\s+Order|P\\.?\\s*O\\.?|PO|Order)\\s+Date|Date\\s+of\\s+(?:Purchase\\s+Order|P\\.?\\s*O\\.?|PO|Order))";
  const direct = text.match(new RegExp(`\\b${dateLabel}\\s*:?\\s*${PURCHASE_ORDER_DOCUMENT_DATE_PATTERN}`, "i"))?.[1];
  const reversed = text.match(new RegExp(`${PURCHASE_ORDER_DOCUMENT_DATE_PATTERN}\\s*${dateLabel}\\b`, "i"))?.[1];
  return cleanPurchaseOrderDocumentDate(direct ?? reversed);
}

function applyPurchaseOrderDateFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string
) {
  if (!isPurchaseOrderDocType(docType) || fields.documentDate || !visibleText.trim()) return fields;

  const documentDate = extractPurchaseOrderDocumentDate(visibleText);
  return documentDate ? { ...fields, documentDate } : fields;
}

function removeNonRequiredPurchaseOrderPresenceFields(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType
) {
  if (!isPurchaseOrderDocType(docType) || !fields.hasVendorStamp) return fields;

  const next = { ...fields };
  delete next.hasVendorStamp;
  return next;
}

function normalizeEvidenceText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasReceivingStoreStampEvidence(visibleText: string) {
  const normalized = normalizeEvidenceText(visibleText);
  const hasInternalReceiver =
    normalized.includes("kalika") &&
    (normalized.includes("sms division") ||
      normalized.includes("s m s division") ||
      normalized.includes("steels") ||
      normalized.includes("steel alloys"));
  const hasReceivingStampLanguage =
    /\b(?:store|stores|warehouse|receiv(?:ed|ing)|gate|security)\b[\s\S]{0,100}\b(?:stamp|seal|division)\b/i.test(
      visibleText
    ) ||
    /\b(?:stamp|seal)\b[\s\S]{0,100}\b(?:store|stores|warehouse|receiv(?:ed|ing)|gate|security)\b/i.test(
      visibleText
    );
  const hasNameSignBlock = /\b(?:name\s*&\s*sign|name\s+and\s+sign|name\s*\/\s*sign)\b/i.test(visibleText);

  return hasReceivingStampLanguage || (hasInternalReceiver && hasNameSignBlock);
}

function hasReceivingStoreSignatureEvidence(visibleText: string) {
  if (!hasReceivingStoreStampEvidence(visibleText)) return false;
  return /\b(?:name\s*&\s*sign|name\s+and\s+sign|name\s*\/\s*sign|signature|signed|signatory)\b/i.test(visibleText);
}

function applyVisibleStoreEvidenceFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string
) {
  if (!STORE_EVIDENCE_DOC_TYPES.has(docType) || !visibleText.trim()) return fields;

  const hasStoreStamp = hasReceivingStoreStampEvidence(visibleText);
  const hasStoreSignature = hasReceivingStoreSignatureEvidence(visibleText);
  if (!hasStoreStamp && !hasStoreSignature) return fields;

  const next = { ...fields };
  if (hasStoreStamp && next.hasStoreStamp !== "Yes") {
    next.hasStoreStamp = "Yes";
  }
  if (hasStoreSignature && next.hasStoreSignature !== "Yes") {
    next.hasStoreSignature = "Yes";
  }
  return next;
}

function cleanPoTermText(value?: string) {
  const cleaned = value
    ?.replace(/\s+/g, " ")
    .replace(/^[\s:;,\-.•*#]+/, "")
    .replace(/[\s;,\-.]+$/, "")
    .trim();
  if (!cleaned || cleaned.length < 2) return undefined;
  return cleaned.slice(0, 1800);
}

function splitPoTermLine(line: string) {
  const colonIndex = line.search(/[:：]/);
  if (colonIndex >= 0) {
    return {
      label: line.slice(0, colonIndex).replace(/^\d+\s*[)./-]?\s*/, "").trim(),
      value: line.slice(colonIndex + 1).trim(),
    };
  }

  const spaced = line.match(/^(.{3,45}?)\s{2,}(.+)$/);
  if (spaced) {
    return {
      label: spaced[1].replace(/^\d+\s*[)./-]?\s*/, "").trim(),
      value: spaced[2].trim(),
    };
  }

  return { label: line.replace(/^\d+\s*[)./-]?\s*/, "").trim(), value: "" };
}

function isPoTermsSectionStart(line: string) {
  return /^(?:terms?\s*(?:&|and)?\s*conditions?|commercial\s+terms?|special\s+terms?|general\s+terms?|remarks?|notes?|other\s+terms?)\b/i.test(line.trim());
}

function isPoTermsStopLine(line: string) {
  return /^(?:for\s+[A-Z].*|authori[sz]ed\s+signatory|prepared\s+by|checked\s+by|approved\s+by|receiver'?s?\s+signature|page\s+\d+\s+of\s+\d+)\b/i.test(line.trim());
}

function collectPoContinuation(lines: string[], startIndex: number) {
  const collected: string[] = [];
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 3); index += 1) {
    const line = lines[index];
    if (!line || isPoTermsStopLine(line) || isPoTermsSectionStart(line)) break;
    const { label, value } = splitPoTermLine(line);
    if (value && PO_TERM_LABELS.some((term) => term.pattern.test(label))) break;
    collected.push(line);
  }
  return collected.join(" ");
}

function extractPoTermsSection(lines: string[]) {
  const startIndex = lines.findIndex(isPoTermsSectionStart);
  if (startIndex < 0) return undefined;

  const sectionLines: string[] = [];
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 45); index += 1) {
    const line = lines[index];
    if (!line) {
      if (sectionLines.length > 8) break;
      continue;
    }
    if (index > startIndex && isPoTermsStopLine(line)) break;
    sectionLines.push(line);
  }

  return cleanPoTermText(sectionLines.join("; "));
}

function extractPoTermsFromVisibleText(visibleText: string): Partial<Record<FieldKey, string>> {
  const lines = visibleText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const terms: Partial<Record<FieldKey, string>> = {};

  lines.forEach((line, index) => {
    const { label, value } = splitPoTermLine(line);
    const matched = PO_TERM_LABELS.find((term) => term.pattern.test(label));
    if (!matched || terms[matched.field]) return;
    const candidate = cleanPoTermText(value || collectPoContinuation(lines, index + 1));
    if (candidate) terms[matched.field] = candidate;
  });

  const termsSection = extractPoTermsSection(lines);
  const structuredSummary = PO_TERMS_FIELD_KEYS
    .map((field) => {
      const value = terms[field];
      const label = PO_TERM_LABELS.find((term) => term.field === field)?.label;
      return value && label ? `${label}: ${value}` : null;
    })
    .filter(Boolean)
    .join("; ");
  const termsAndConditions = cleanPoTermText(termsSection ?? structuredSummary);
  if (termsAndConditions) {
    terms.termsAndConditions = termsAndConditions;
  }

  return terms;
}

function applyPurchaseOrderTermsFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string
) {
  if (!isPurchaseOrderDocType(docType) || !visibleText.trim()) return fields;

  const terms = extractPoTermsFromVisibleText(visibleText);
  return Object.entries(terms).reduce(
    (acc, [key, value]) => {
      const fieldKey = key as FieldKey;
      if (value && !acc[fieldKey]) acc[fieldKey] = value;
      return acc;
    },
    { ...fields } as Partial<Record<FieldKey, string>>
  );
}

type TermsComplianceAssessment = {
  sourceDocId?: unknown;
  sourceClause?: unknown;
  obligation?: unknown;
  category?: unknown;
  status?: unknown;
  evidenceDocIds?: unknown;
  evidence?: unknown;
  reason?: unknown;
  severity?: unknown;
};

export type TermsComplianceChecklistItem = {
  sourceDocId: string;
  sourceClause: string;
  obligation: string;
  category: string;
  status: "fulfilled" | "not_fulfilled" | "unknown" | "not_applicable";
  evidenceDocIds: string[];
  evidence: string;
  reason: string;
  severity: "high" | "medium" | "low" | "none";
};

function compactPromptText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 20).trim()} ... [truncated]`;
}

function getTermsFieldSummary(doc: CaseDoc) {
  return TERMS_FIELD_KEYS
    .map((field) => {
      const value = doc.fields[field];
      return value && String(value).trim() ? `${FIELD_LABELS[field]}: ${String(value).trim()}` : null;
    })
    .filter((value): value is string => Boolean(value));
}

function fieldSummaryForTermsAssessment(doc: CaseDoc) {
  return Object.entries(doc.fields)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim().length > 0)
    .slice(0, 80)
    .map(([key, value]) => `${FIELD_LABELS[key as FieldKey] ?? key}: ${String(value).trim()}`)
    .join("; ");
}

function lineItemSummaryForTermsAssessment(doc: CaseDoc) {
  if (!doc.lineItems?.length) return "";
  return doc.lineItems
    .slice(0, 20)
    .map((item, index) =>
      [
        item.lineNumber || `line ${index + 1}`,
        item.itemCode,
        item.description,
        item.quantity && item.unit ? `${item.quantity} ${item.unit}` : item.quantity,
        item.rate ? `rate ${item.rate}` : "",
        item.taxableAmount ? `taxable ${item.taxableAmount}` : "",
        item.lineTotal ? `total ${item.lineTotal}` : "",
      ]
        .filter(Boolean)
        .join(" | ")
    )
    .join("\n");
}

function buildTermsAssessmentPrompt(documents: CaseDoc[]) {
  return documents
    .map((doc) => {
      const termsFields = getTermsFieldSummary(doc);
      return [
        `DOC_ID: ${doc.id}`,
        `TYPE: ${doc.type}`,
        `TITLE: ${doc.title}`,
        `SOURCE: ${doc.sourceFileName ?? doc.sourceHint ?? "uploaded"}`,
        termsFields.length ? `EXTRACTED_TERMS:\n${termsFields.join("\n")}` : "",
        `FIELDS: ${fieldSummaryForTermsAssessment(doc) || "No extracted fields"}`,
        lineItemSummaryForTermsAssessment(doc) ? `LINE_ITEMS:\n${lineItemSummaryForTermsAssessment(doc)}` : "",
        `VISIBLE_TEXT:\n${compactPromptText(doc.md ?? "", termsFields.length ? 5000 : 3500)}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n")
    .slice(0, 52000);
}

function normalizeTermsStatus(value: unknown) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z_]/g, "");
  if (normalized === "notfulfilled" || normalized === "failed" || normalized === "breach") return "not_fulfilled";
  if (normalized === "fulfilled" || normalized === "satisfied" || normalized === "ok") return "fulfilled";
  if (normalized === "notapplicable" || normalized === "na") return "not_applicable";
  if (normalized === "unknown" || normalized === "needsreview" || normalized === "insufficientevidence") return "unknown";
  return "";
}

function normalizeStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function stableMismatchPart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "terms";
}

function normalizeTermsSeverity(value: unknown) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "critical") return "high";
  if (normalized === "high" || normalized === "medium" || normalized === "low") return normalized;
  return "";
}

function buildTermsComplianceMismatch(
  assessment: TermsComplianceAssessment,
  documentsById: Map<string, CaseDoc>,
  index: number
): Mismatch | null {
  const sourceDocId = String(assessment.sourceDocId ?? "").trim();
  const sourceDoc = documentsById.get(sourceDocId);
  if (!sourceDoc) return null;

  const status = normalizeTermsStatus(assessment.status);
  if (!isActionableTermsComplianceStatus(status)) return null;

  const sourceClause = compactPromptText(String(assessment.sourceClause ?? "").trim(), 700);
  const obligation = compactPromptText(String(assessment.obligation ?? "").trim(), 500);
  if (!sourceClause || !obligation) return null;

  const reason = compactPromptText(String(assessment.reason ?? "").trim(), 700);
  const evidence = compactPromptText(String(assessment.evidence ?? "").trim(), 700);
  const category = compactPromptText(String(assessment.category ?? "Terms compliance").trim(), 80);
  const evidenceDocIds = normalizeStringList(assessment.evidenceDocIds).filter((docId) => documentsById.has(docId));
  const valueDocIds = [sourceDocId, ...evidenceDocIds].filter((docId, docIndex, ids) => ids.indexOf(docId) === docIndex);
  const statusLabel = status === "not_fulfilled" ? "Not fulfilled" : "Needs review";
  const issueValue = [
    `${statusLabel}: ${obligation}`,
    `Clause: ${sourceClause}`,
    reason ? `Reason: ${reason}` : "",
    evidence ? `Evidence: ${evidence}` : "",
  ].filter(Boolean).join("\n");

  return {
    id: `${TERMS_COMPLIANCE_MISMATCH_PREFIX}-${stableMismatchPart(sourceDocId)}-${index}-${stableMismatchPart(obligation)}`,
    field: TERMS_COMPLIANCE_FIELD,
    values: valueDocIds.map((docId) => ({
      docId,
      value: docId === sourceDocId ? issueValue : `Evidence reviewed for clause: ${obligation}`,
    })),
    analysis:
      status === "not_fulfilled"
        ? `A terms and conditions obligation is not fulfilled. Source: ${sourceDoc.title}. Category: ${category}. ${reason || evidence || obligation}`
        : `A terms and conditions obligation needs manual review because the packet does not contain enough clear evidence. Source: ${sourceDoc.title}. Category: ${category}. ${reason || obligation}`,
    fixPlan:
      `1. Review the source clause: ${sourceClause}\n` +
      `2. Add or correct the packet evidence needed to satisfy: ${obligation}\n` +
      "3. Re-run analysis so the terms compliance issue can be cleared.",
  };
}

function buildTermsComplianceChecklistItem(
  assessment: TermsComplianceAssessment,
  documentsById: Map<string, CaseDoc>
): TermsComplianceChecklistItem | null {
  const sourceDocId = String(assessment.sourceDocId ?? "").trim();
  if (!documentsById.has(sourceDocId)) return null;

  const status = normalizeTermsStatus(assessment.status);
  if (!status) return null;

  const sourceClause = compactPromptText(String(assessment.sourceClause ?? "").trim(), 700);
  const obligation = compactPromptText(String(assessment.obligation ?? "").trim(), 500);
  if (!sourceClause || !obligation) return null;

  const severity = normalizeTermsSeverity(assessment.severity) || "none";
  const evidenceDocIds = normalizeStringList(assessment.evidenceDocIds).filter((docId) => documentsById.has(docId));

  return {
    sourceDocId,
    sourceClause,
    obligation,
    category: compactPromptText(String(assessment.category ?? "Terms compliance").trim(), 80),
    status: status as TermsComplianceChecklistItem["status"],
    evidenceDocIds,
    evidence: compactPromptText(String(assessment.evidence ?? "").trim(), 700),
    reason: compactPromptText(String(assessment.reason ?? "").trim(), 700),
    severity: severity as TermsComplianceChecklistItem["severity"],
  };
}

export async function assessCaseTermsComplianceDetailed(documents: CaseDoc[]): Promise<{
  mismatches: Mismatch[];
  checklist: TermsComplianceChecklistItem[];
}> {
  const assessableDocuments = documents.filter(
    (doc) =>
      doc.md?.trim() ||
      Object.values(doc.fields).some((value) => value !== undefined && value !== null && String(value).trim()) ||
      Boolean(doc.lineItems?.length)
  );
  if (!assessableDocuments.length) return { mismatches: [], checklist: [] };

  const hasExplicitTerms = assessableDocuments.some((doc) => {
    if (TERMS_FIELD_KEYS.some((field) => Boolean(doc.fields[field]?.trim()))) {
      return true;
    }
    const visibleText = getVisibleTextFromMarkdown(doc.md);
    return /\b(?:terms?\s*(?:&|and)\s*conditions?|payment\s+terms?|delivery\s+terms?|freight\s+terms?|commercial\s+terms?|special\s+terms?|warranty|guarantee|inspection\s+terms?)\b/i.test(
      visibleText
    );
  });
  if (!hasExplicitTerms) return { mismatches: [], checklist: [] };

  const documentsById = new Map(assessableDocuments.map((doc) => [doc.id, doc]));
  const packetContext = buildTermsAssessmentPrompt(assessableDocuments);
  if (!packetContext.trim()) return { mismatches: [], checklist: [] };

  let raw = "";
  try {
    raw = await callOpenRouter(
      [
        {
          role: "system",
          content:
            "You assess procurement packet terms and conditions compliance. Return only JSON with key obligations. " +
            "Terms can appear in any document type, not only purchase orders. Use only explicit visible clauses and packet evidence. " +
            "First identify whether the packet contains any explicit terms, conditions, commercial clauses, special instructions, or document requirements. If not, return {\"obligations\":[]}. " +
            "Do not compare wording between documents. Convert each explicit clause into a checkable obligation only when it can be assessed from the uploaded packet. " +
            "Statuses must be one of fulfilled, not_fulfilled, unknown, not_applicable. " +
            "Use not_fulfilled only when packet evidence clearly violates or misses a required obligation. Use unknown when the obligation is material but evidence is insufficient. " +
            "Use not_applicable for generic legal boilerplate, jurisdiction, future warranty/interest clauses, or clauses not testable from current packet evidence. " +
            "For conditional clauses like 'if applicable', do not mark not_fulfilled unless applicability is clear from the packet. " +
            "Unknown means manual review only; it must stay in the checklist and must not be treated as a mismatch or rejection. " +
            "Set severity to high, medium, low, or none. Use high/medium only for obligations that can block packet approval. " +
            "Each obligation object must include sourceDocId, sourceClause, obligation, category, status, evidenceDocIds, evidence, reason, severity.",
        },
        {
          role: "user",
          content:
            "Assess this packet. Return JSON like {\"obligations\":[...]} and keep only concise evidence from the packet.\n\n" +
            packetContext,
        },
      ],
      {
        expectJson: true,
        model: getQualityExtractionModel(),
        reasoning: getQualityExtractionReasoning(),
      }
    );
  } catch (error) {
    console.warn("Failed to assess terms compliance", error);
    return { mismatches: [], checklist: [] };
  }

  const parsed = safeJsonParse<{ obligations?: unknown }>(raw, {});
  const obligations = Array.isArray(parsed.obligations) ? parsed.obligations : [];
  const checklist = obligations
    .map((entry) => buildTermsComplianceChecklistItem(entry as TermsComplianceAssessment, documentsById))
    .filter((entry): entry is TermsComplianceChecklistItem => Boolean(entry))
    .slice(0, 30);
  const mismatches = obligations
    .map((entry, index) =>
      buildTermsComplianceMismatch(entry as TermsComplianceAssessment, documentsById, index + 1)
    )
    .filter((mismatch): mismatch is Mismatch => Boolean(mismatch))
    .slice(0, 10);

  return { mismatches, checklist };
}

export async function assessCaseTermsCompliance(documents: CaseDoc[]): Promise<Mismatch[]> {
  const result = await assessCaseTermsComplianceDetailed(documents);
  return result.mismatches;
}

type ExtractionReviewCorrection = {
  docId?: unknown;
  documentType?: unknown;
  fields?: unknown;
  unsetFields?: unknown;
  quarantineFields?: unknown;
  lineItems?: unknown;
  reason?: unknown;
};

type ExtractionReviewPayload = {
  corrections?: unknown;
  notes?: unknown;
};

export type ExtractionReviewSummary = {
  enabled: boolean;
  reviewedAt?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  correctionCount: number;
  corrections: Array<{
    docId: string;
    title: string;
    reason?: string;
    changedFields: string[];
    unsetFields: string[];
    quarantinedFields: string[];
    documentType?: string;
    lineItemsReplaced?: boolean;
  }>;
  warnings: string[];
  error?: string;
};

function isKnownDocType(value: unknown): value is DocType {
  return typeof value === "string" && SUPPORTED_DOC_TYPES.includes(value as DocType);
}

function isKnownFieldKey(value: unknown): value is FieldKey {
  return typeof value === "string" && ALL_ALLOWED_FIELD_KEYS.includes(value as FieldKey);
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function normalizeReviewFieldList(value: unknown) {
  return normalizeStringArray(value).filter(isKnownFieldKey);
}

function normalizeReviewQuarantineFields(value: unknown): Array<{ field: FieldKey; reason?: string }> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (isKnownFieldKey(entry)) return [{ field: entry }];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const field = record.field;
    if (!isKnownFieldKey(field)) return [];
    const reason = String(record.reason ?? "").trim();
    return [{ field, ...(reason ? { reason } : {}) }];
  });
}

function getVisibleTextFromMarkdown(markdown: string | undefined) {
  const raw = String(markdown ?? "");
  const marker = "## Visible Text";
  const markerIndex = raw.indexOf(marker);
  if (markerIndex >= 0) {
    return raw.slice(markerIndex + marker.length).replace(/^#+\s+Page\s+\d+\s*$/gim, "").trim();
  }
  return raw.trim();
}

function buildExtractionReviewPrompt(documents: CaseDoc[]) {
  return documents.map((doc, index) => ({
    index: index + 1,
    docId: doc.id,
    documentType: doc.type,
    title: doc.title,
    sourceFileName: doc.sourceFileName,
    sourceHint: doc.sourceHint,
    fields: doc.fields,
    lineItems: (doc.lineItems ?? []).slice(0, 40),
    qualityIssues: doc.qualityIssues ?? [],
    visibleText: compactPromptText(getVisibleTextFromMarkdown(doc.md), 6500),
  }));
}

function rebuildReviewedMarkdown(doc: CaseDoc, originalMarkdown: string | undefined) {
  const visibleText = getVisibleTextFromMarkdown(originalMarkdown);
  return buildMarkdown(doc, visibleText ? [visibleText] : []);
}

function appendReviewQualityIssue(
  issues: ExtractionQualityIssue[],
  field: FieldKey,
  originalValue: string,
  action: ExtractionQualityIssue["action"],
  reason: string
) {
  const alreadyPresent = issues.some(
    (issue) =>
      issue.field === field &&
      issue.originalValue === originalValue &&
      issue.action === action &&
      issue.reason === reason
  );
  if (!alreadyPresent) {
    issues.push({ field, originalValue, action, reason });
  }
}

function applyExtractionReviewCorrections(
  documents: CaseDoc[],
  payload: ExtractionReviewPayload
): { documents: CaseDoc[]; summary: ExtractionReviewSummary } {
  const warnings: string[] = [];
  const rawCorrections = Array.isArray(payload.corrections) ? payload.corrections : [];
  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  const correctedById = new Map<string, CaseDoc>();
  const applied: ExtractionReviewSummary["corrections"] = [];

  for (const rawCorrection of rawCorrections.slice(0, 80)) {
    if (!rawCorrection || typeof rawCorrection !== "object" || Array.isArray(rawCorrection)) {
      warnings.push("Ignored malformed extraction review correction.");
      continue;
    }

    const correction = rawCorrection as ExtractionReviewCorrection;
    const docId = String(correction.docId ?? "").trim();
    const originalDoc = correctedById.get(docId) ?? documentsById.get(docId);
    if (!docId || !originalDoc) {
      warnings.push(`Ignored extraction review correction for unknown document id: ${docId || "<missing>"}.`);
      continue;
    }

    let nextDoc: CaseDoc = { ...originalDoc, fields: { ...originalDoc.fields }, qualityIssues: [...(originalDoc.qualityIssues ?? [])] };
    const changedFields: string[] = [];
    const unsetFields: string[] = [];
    const quarantinedFields: string[] = [];
    let documentType: string | undefined;
    let lineItemsReplaced = false;
    const reason = compactPromptText(String(correction.reason ?? "").trim(), 500);

    if (correction.documentType !== undefined) {
      if (isKnownDocType(correction.documentType) && correction.documentType !== nextDoc.type) {
        nextDoc = {
          ...nextDoc,
          type: correction.documentType,
          title: `${formatDocType(correction.documentType)} — ${nextDoc.sourceHint ?? nextDoc.sourceFileName ?? nextDoc.title}`,
        };
        documentType = correction.documentType;
      } else if (correction.documentType && !isKnownDocType(correction.documentType)) {
        warnings.push(`Ignored invalid documentType from extraction review for ${docId}: ${String(correction.documentType)}.`);
      }
    }

    const allowedFields = new Set(getAllowedFieldKeysForDocType(nextDoc.type));
    if (correction.fields && typeof correction.fields === "object" && !Array.isArray(correction.fields)) {
      for (const [rawKey, rawValue] of Object.entries(correction.fields as Record<string, unknown>)) {
        if (!isKnownFieldKey(rawKey)) {
          warnings.push(`Ignored invalid field key from extraction review for ${docId}: ${rawKey}.`);
          continue;
        }
        if (!allowedFields.has(rawKey)) {
          warnings.push(`Ignored field ${rawKey} for ${docId} because it is not allowed on ${nextDoc.type}.`);
          continue;
        }

        if (rawValue === null) {
          const originalValue = nextDoc.fields[rawKey];
          if (originalValue) {
            delete nextDoc.fields[rawKey];
            unsetFields.push(rawKey);
            appendReviewQualityIssue(
              nextDoc.qualityIssues ?? [],
              rawKey,
              originalValue,
              "quarantined",
              reason || "Second-pass extraction review removed this unsupported value."
            );
          }
          continue;
        }

        const value = normalizeFieldValue(rawValue);
        if (!value) continue;
        const oldValue = nextDoc.fields[rawKey];
        if (oldValue !== value) {
          nextDoc.fields[rawKey] = value;
          changedFields.push(rawKey);
          appendReviewQualityIssue(
            nextDoc.qualityIssues ?? [],
            rawKey,
            oldValue ?? "<missing>",
            "corrected",
            reason || "Second-pass extraction review corrected this value from packet evidence."
          );
        }
      }
    }

    for (const field of normalizeReviewFieldList(correction.unsetFields)) {
      if (!allowedFields.has(field)) continue;
      const originalValue = nextDoc.fields[field];
      if (!originalValue) continue;
      delete nextDoc.fields[field];
      unsetFields.push(field);
      appendReviewQualityIssue(
        nextDoc.qualityIssues ?? [],
        field,
        originalValue,
        "quarantined",
        reason || "Second-pass extraction review removed this value as unsupported by packet evidence."
      );
    }

    for (const entry of normalizeReviewQuarantineFields(correction.quarantineFields)) {
      if (!allowedFields.has(entry.field)) continue;
      const originalValue = nextDoc.fields[entry.field];
      if (!originalValue) continue;
      delete nextDoc.fields[entry.field];
      quarantinedFields.push(entry.field);
      appendReviewQualityIssue(
        nextDoc.qualityIssues ?? [],
        entry.field,
        originalValue,
        "quarantined",
        entry.reason || reason || "Second-pass extraction review quarantined this uncertain value."
      );
    }

    if (Array.isArray(correction.lineItems)) {
      const visibleText = getVisibleTextFromMarkdown(nextDoc.md);
      nextDoc.lineItems = normalizeExtractedCommercialLineItems({
        docType: nextDoc.type,
        lineItems: sanitizeLineItems(correction.lineItems),
        visibleTextPages: visibleText ? [visibleText] : [],
        documentFields: nextDoc.fields,
      });
      lineItemsReplaced = true;
    }

    if (
      documentType ||
      changedFields.length ||
      unsetFields.length ||
      quarantinedFields.length ||
      lineItemsReplaced
    ) {
      nextDoc.fields = omitIgnoredFields(nextDoc.fields) as Partial<Record<FieldKey, string>>;
      nextDoc.md = rebuildReviewedMarkdown(nextDoc, originalDoc.md);
      correctedById.set(docId, nextDoc);
      applied.push({
        docId,
        title: nextDoc.title,
        ...(reason ? { reason } : {}),
        changedFields,
        unsetFields,
        quarantinedFields,
        ...(documentType ? { documentType } : {}),
        ...(lineItemsReplaced ? { lineItemsReplaced } : {}),
      });
    }
  }

  return {
    documents: documents.map((doc) => correctedById.get(doc.id) ?? doc),
    summary: {
      enabled: true,
      reviewedAt: new Date().toISOString(),
      model: getExtractionReviewModel(),
      provider: getExtractionReviewProvider(),
      reasoningEffort: getExtractionReviewReasoningEffort(),
      correctionCount: applied.length,
      corrections: applied,
      warnings: [
        ...warnings,
        ...normalizeStringArray(payload.notes).map((note) => compactPromptText(note, 400)),
      ].filter(Boolean),
    },
  };
}

export async function reviewAndCorrectExtractedDocuments(
  documents: CaseDoc[],
  options?: { candidateDocumentIds?: Iterable<string> }
): Promise<{
  documents: CaseDoc[];
  review: ExtractionReviewSummary;
}> {
  if (process.env.PACKET_EXTRACTION_REVIEW_ENABLED === "false") {
    return {
      documents,
      review: {
        enabled: false,
        correctionCount: 0,
        corrections: [],
        warnings: ["Second-pass extraction review is disabled by PACKET_EXTRACTION_REVIEW_ENABLED=false."],
      },
    };
  }

  const candidateDocumentIds = new Set(options?.candidateDocumentIds ?? []);
  const assessableDocuments = documents.filter((doc) => {
    const hasExtractedContent = Boolean(doc.md?.trim() || Object.keys(doc.fields).length || doc.lineItems?.length);
    if (!hasExtractedContent) return false;

    return (
      candidateDocumentIds.has(doc.id) ||
      doc.type === "Unknown" ||
      Boolean(doc.qualityIssues?.length) ||
      isWeakExtraction(doc) ||
      hasIncompleteVisibleInvoiceLines(doc)
    );
  });
  if (!assessableDocuments.length) {
    return {
      documents,
      review: {
        enabled: true,
        reviewedAt: new Date().toISOString(),
        model: getExtractionReviewModel(),
        provider: getExtractionReviewProvider(),
        reasoningEffort: getExtractionReviewReasoningEffort(),
        correctionCount: 0,
        corrections: [],
        warnings: ["Second-pass extraction review skipped because the first-pass extraction was strong and produced no comparison conflicts."],
      },
    };
  }

  let raw = "";
  try {
    raw = await callExtractionReviewModel(
      [
        {
          role: "system",
          content:
            "You are a strict procurement packet extraction reviewer. Return only JSON. " +
            "Review all extracted documents against their visibleText and correct only values that are explicitly supported by visible packet evidence. " +
            "Do not invent data from file names, nearby documents, expectations, or arithmetic alone. " +
            "You may correct documentType, fields, lineItems, and quarantine unsupported fields. " +
            "For every Invoice or Tax Invoice with a visible commercial item table, ensure lineItems contains every visible goods or service row. Do not move an invoice row to another document merely because the same HSN or amount also appears there. " +
            "E-Way Bill numbers must be exactly 12 digits. If an extracted eWayBillNumber is not 12 digits, remove it. " +
            "Do not automatically move an invalid e-way value into referenceInvoiceNumber unless the visible page explicitly labels it as Doc No, Document No, Invoice No, Tax Invoice No, or Delivery Challan No for that same document. " +
            "If a page is a PASS OUT DOCUMENT, delivery summary, logistics summary, or contains multiple delivery refs such as EM5032/EM5033, avoid creating a strong invoice reference unless the label and line amounts clearly support that exact invoice. " +
            "For consignee/ship-to/recipient, buyerName/buyerGstin may be Kalika only; non-Kalika consignee values must not become buyer fields. " +
            "For GST, preserve visible tax percentages separately from tax amounts. Same Maharashtra/Kalika state code 27 means CGST+SGST split unless the document explicitly shows IGST. " +
            "Return JSON shape: {\"corrections\":[{\"docId\":\"...\",\"documentType\":\"Invoice\",\"fields\":{\"fieldKey\":\"value or null\"},\"unsetFields\":[\"fieldKey\"],\"quarantineFields\":[{\"field\":\"fieldKey\",\"reason\":\"...\"}],\"lineItems\":[...],\"reason\":\"concise evidence\"}],\"notes\":[\"...\"]}. " +
            "Use null in fields or quarantineFields to remove unsupported values. Use empty corrections when extraction is already strong.",
        },
        {
          role: "user",
          content:
            "Review this completed first-pass extraction before mismatch generation. " +
            "Only return corrections that are clearly supported by visibleText.\n\n" +
            JSON.stringify({
              allowedDocumentTypes: SUPPORTED_DOC_TYPES,
              allowedFieldKeys: ALL_ALLOWED_FIELD_KEYS,
              documents: buildExtractionReviewPrompt(assessableDocuments),
            }),
        },
      ]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
    console.warn("Second-pass extraction review failed; continuing with first-pass extraction.", message);
    return {
      documents,
      review: {
        enabled: true,
        reviewedAt: new Date().toISOString(),
        model: getExtractionReviewModel(),
        provider: getExtractionReviewProvider(),
        reasoningEffort: getExtractionReviewReasoningEffort(),
        correctionCount: 0,
        corrections: [],
        warnings: [],
        error: message,
      },
    };
  }

  const payload = safeJsonParse<ExtractionReviewPayload>(raw, {});
  const applied = applyExtractionReviewCorrections(assessableDocuments, payload);
  const correctedById = new Map(applied.documents.map((doc) => [doc.id, doc]));
  return {
    documents: documents.map((doc) => correctedById.get(doc.id) ?? doc),
    review: applied.summary,
  };
}

function mapFields(fields: Record<string, unknown>, docType?: DocType): Partial<Record<FieldKey, string>> {
  const result: Partial<Record<FieldKey, string>> = {};
  const allowedFieldKeys = docType ? getAllowedFieldKeysForDocType(docType) : ALL_ALLOWED_FIELD_KEYS;

  allowedFieldKeys.forEach((fieldKey) => {
    const aliases = FIELD_MAPPINGS[fieldKey] ?? [];
    for (const alias of aliases) {
      const value = fields[alias];
      const normalizedValue = normalizeFieldValue(value);
      if (normalizedValue && shouldAcceptMappedAlias(fieldKey, alias, normalizedValue)) {
        result[fieldKey] = normalizedValue;
        break;
      }
    }
  });

  if (!result.subtotal && result.totalTaxableAmount) {
    result.subtotal = result.totalTaxableAmount;
  }
  if (docType === "E-Way Bill" && !result.totalTaxableAmount && result.subtotal) {
    result.totalTaxableAmount = result.subtotal;
  }

  return omitIgnoredFields(result) as Partial<Record<FieldKey, string>>;
}

function mergeFieldRecords(
  primary: Partial<Record<FieldKey, string>>,
  fallback: Partial<Record<FieldKey, string>>
) {
  return {
    ...fallback,
    ...Object.fromEntries(
      Object.entries(primary).filter(([, value]) => value !== undefined && value !== null && String(value).trim())
    ),
  } as Partial<Record<FieldKey, string>>;
}

function mergeExtractedDocs(primary: CaseDoc, fallback: CaseDoc): CaseDoc {
  return {
    ...primary,
    fields: mergeFieldRecords(primary.fields, fallback.fields),
    lineItems: primary.lineItems?.length ? primary.lineItems : fallback.lineItems,
    md: primary.md?.trim() ? primary.md : fallback.md,
  };
}

const INVOICE_COPY_LABEL_PATTERN =
  /\b(?:(?:original|duplicate|triplicate|quadruplicate)(?:\s+(?:for|to))?(?:\s+(?:recipient|buyer|customer|transporter|supplier|seller))?|(?:buyer|seller|supplier|recipient|customer|transporter|office|extra)\s+copy|copy\s+(?:for|to)?\s*(?:buyer|seller|supplier|recipient|customer|transporter))\b/i;
const INVOICE_COPY_TOKEN_PATTERN =
  /\b(?:original|duplicate|triplicate|quadruplicate|copy|customer|buyer|seller|supplier|recipient|transporter|office|extra|for|to)\b/g;
const INVOICE_COPY_MIN_COMMON_TOKENS = 25;
const INVOICE_COPY_SIMILARITY_THRESHOLD = 0.82;
const INVOICE_COPY_LINE_OVERLAP_THRESHOLD = 0.6;
const INVOICE_AMOUNT_IDENTITY_FIELDS: FieldKey[] = ["totalAmount", "subtotal", "taxAmount"];
const INVOICE_LINE_ITEM_KEYS: Array<keyof CommercialLineItem> = [
  "lineNumber",
  "itemCode",
  "description",
  "hsnSac",
  "quantity",
  "unit",
  "rate",
  "discountPercent",
  "netRate",
  "taxableAmount",
  "cgstRate",
  "cgstAmount",
  "sgstRate",
  "sgstAmount",
  "igstRate",
  "igstAmount",
  "taxRate",
  "taxAmount",
  "lineTotal",
  "referencePoLineNumber",
  "rawText",
  "sourcePage",
];

function getInvoiceCopyText(doc: CaseDoc) {
  return [doc.title, doc.sourceFileName, doc.sourceHint, doc.md].filter(Boolean).join("\n");
}

function hasInvoiceCopyLabel(doc: CaseDoc) {
  return INVOICE_COPY_LABEL_PATTERN.test(getInvoiceCopyText(doc));
}

function getInvoiceCopyRank(doc: CaseDoc) {
  const text = getInvoiceCopyText(doc);
  if (/\b(?:original(?:\s+(?:for|to))?\s*(?:recipient|buyer|customer)?|recipient\s+copy|buyer\s+copy|customer\s+copy)\b/i.test(text)) {
    return 0;
  }
  if (/\b(?:duplicate(?:\s+(?:for|to))?\s*(?:transporter|buyer|customer)?|transporter\s+copy)\b/i.test(text)) {
    return 1;
  }
  if (/\b(?:triplicate(?:\s+(?:for|to))?\s*(?:supplier|seller)?|supplier\s+copy|seller\s+copy)\b/i.test(text)) {
    return 2;
  }
  if (/\b(?:quadruplicate|office\s+copy|extra\s+copy)\b/i.test(text)) {
    return 3;
  }
  return 4;
}

function normalizeInvoiceCopyTokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(INVOICE_COPY_TOKEN_PATTERN, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
  );
}

function compareTokenSets(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return { score: 0, common: 0 };

  let common = 0;
  for (const token of left) {
    if (right.has(token)) common += 1;
  }

  const union = left.size + right.size - common;
  return { score: union > 0 ? common / union : 0, common };
}

function compareInvoiceCopyText(left: CaseDoc, right: CaseDoc) {
  return compareTokenSets(
    normalizeInvoiceCopyTokens(getInvoiceCopyText(left)),
    normalizeInvoiceCopyTokens(getInvoiceCopyText(right))
  );
}

function normalizeInvoiceIdentity(value?: string) {
  const normalized = normalizePacketValue(value, "invoiceNumber")?.toLowerCase().replace(/\s+/g, "");
  if (!normalized) return null;

  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (compact.length < 3 || !/\d/.test(compact)) return null;
  return compact;
}

function normalizeGstinIdentity(value?: string) {
  const normalized = normalizePacketValue(value)?.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  return normalized && normalized.length >= 10 ? normalized : null;
}

function hasMatchingInvoiceGstin(left: CaseDoc, right: CaseDoc) {
  const leftSupplier = normalizeGstinIdentity(left.fields.supplierGstin);
  const rightSupplier = normalizeGstinIdentity(right.fields.supplierGstin);
  const leftBuyer = normalizeGstinIdentity(left.fields.buyerGstin);
  const rightBuyer = normalizeGstinIdentity(right.fields.buyerGstin);

  return Boolean(
    (leftSupplier && rightSupplier && leftSupplier === rightSupplier) ||
      (leftBuyer && rightBuyer && leftBuyer === rightBuyer)
  );
}

function hasMatchingInvoiceAmount(left: CaseDoc, right: CaseDoc) {
  return INVOICE_AMOUNT_IDENTITY_FIELDS.some((field) => {
    const leftAmount = parseLooseNumber(left.fields[field]);
    const rightAmount = parseLooseNumber(right.fields[field]);
    if (leftAmount === null || rightAmount === null || leftAmount <= 0 || rightAmount <= 0) return false;
    return numbersClose(leftAmount, rightAmount, Math.max(1, Math.abs(leftAmount) * 0.002));
  });
}

function normalizeInvoiceLineText(value: unknown) {
  if (value === undefined || value === null) return null;
  const text = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return text || null;
}

function normalizeInvoiceLineAmount(value: unknown) {
  const parsed = parseLooseNumber(typeof value === "string" || typeof value === "number" ? value : undefined);
  return parsed === null ? normalizeInvoiceLineText(value) : formatNumberForField(parsed);
}

function buildInvoiceLineCopySignature(item: CommercialLineItem) {
  const productParts = [
    normalizeInvoiceLineText(item.itemCode),
    normalizeInvoiceLineText(item.hsnSac),
    normalizeInvoiceLineText(item.description),
  ].filter(Boolean);
  const commercialParts = [
    normalizeInvoiceLineAmount(item.quantity),
    normalizeInvoiceLineText(item.unit),
    normalizeInvoiceLineAmount(item.rate),
    normalizeInvoiceLineAmount(item.taxableAmount ?? item.lineTotal),
  ].filter(Boolean);

  if (!productParts.length || !commercialParts.length) return null;
  return [...productParts, ...commercialParts].join("|");
}

function compareInvoiceLineItems(left: CaseDoc, right: CaseDoc) {
  const leftSignatures = new Set(
    sanitizeLineItems(left.lineItems ?? [])
      .map(buildInvoiceLineCopySignature)
      .filter((signature): signature is string => Boolean(signature))
  );
  const rightSignatures = new Set(
    sanitizeLineItems(right.lineItems ?? [])
      .map(buildInvoiceLineCopySignature)
      .filter((signature): signature is string => Boolean(signature))
  );

  return compareTokenSets(leftSignatures, rightSignatures);
}

function mergeInvoiceLineItem(primary: CommercialLineItem, fallback: CommercialLineItem) {
  const next = { ...primary };

  for (const key of INVOICE_LINE_ITEM_KEYS) {
    if ((next[key] === undefined || next[key] === null || String(next[key]).trim() === "") && fallback[key] !== undefined) {
      next[key] = fallback[key] as never;
    }
  }

  return next;
}

function mergeInvoiceCopyLineItems(primary: CommercialLineItem[] | undefined, fallback: CommercialLineItem[] | undefined) {
  const result: CommercialLineItem[] = [];
  const indexBySignature = new Map<string, number>();

  for (const item of sanitizeLineItems([...(primary ?? []), ...(fallback ?? [])])) {
    const signature = buildInvoiceLineCopySignature(item);
    const existingIndex = signature ? indexBySignature.get(signature) : undefined;

    if (existingIndex !== undefined) {
      result[existingIndex] = mergeInvoiceLineItem(result[existingIndex], item);
      continue;
    }

    const nextIndex = result.push(item) - 1;
    if (signature) indexBySignature.set(signature, nextIndex);
  }

  return result;
}

function getInvoiceDocCompletenessScore(doc: CaseDoc) {
  const fields = countMeaningfulFields(doc.fields);
  const lineItems = sanitizeLineItems(doc.lineItems ?? []).length;
  const amountFields = INVOICE_AMOUNT_IDENTITY_FIELDS.filter((field) => doc.fields[field]).length;
  const textScore = Math.min(6, Math.floor((doc.md?.trim().length ?? 0) / 500));
  return fields * 4 + lineItems * 10 + amountFields * 3 + textScore;
}

function shouldPreferInvoiceCopyCandidate(candidate: CaseDoc, current: CaseDoc) {
  const candidateScore = getInvoiceDocCompletenessScore(candidate);
  const currentScore = getInvoiceDocCompletenessScore(current);
  if (Math.abs(candidateScore - currentScore) >= 12) return candidateScore > currentScore;

  const candidateRank = getInvoiceCopyRank(candidate);
  const currentRank = getInvoiceCopyRank(current);
  if (candidateRank !== currentRank) return candidateRank < currentRank;

  return candidateScore > currentScore;
}

function areDuplicateInvoiceCopies(left: CaseDoc, right: CaseDoc) {
  const leftInvoice = normalizeInvoiceIdentity(left.fields.invoiceNumber);
  const rightInvoice = normalizeInvoiceIdentity(right.fields.invoiceNumber);
  const invoiceMatches = Boolean(leftInvoice && rightInvoice && leftInvoice === rightInvoice);
  const amountMatches = hasMatchingInvoiceAmount(left, right);
  const gstinMatches = hasMatchingInvoiceGstin(left, right);
  const textMatch = compareInvoiceCopyText(left, right);
  const lineMatch = compareInvoiceLineItems(left, right);
  const strongTextMatch =
    textMatch.common >= INVOICE_COPY_MIN_COMMON_TOKENS && textMatch.score >= INVOICE_COPY_SIMILARITY_THRESHOLD;
  const lineItemsOverlap =
    lineMatch.common > 0 && lineMatch.score >= INVOICE_COPY_LINE_OVERLAP_THRESHOLD;
  const copyEvidence = hasInvoiceCopyLabel(left) || hasInvoiceCopyLabel(right) || strongTextMatch || lineItemsOverlap;

  if (invoiceMatches) {
    return copyEvidence && (amountMatches || gstinMatches || strongTextMatch || lineItemsOverlap);
  }

  return copyEvidence && amountMatches && gstinMatches && (strongTextMatch || lineItemsOverlap);
}

function mergeInvoiceCopyDocuments(primary: CaseDoc, fallback: CaseDoc) {
  const merged = mergeExtractedDocs(primary, fallback);
  return {
    ...merged,
    fields: mergeFieldRecords(primary.fields, fallback.fields),
    lineItems: mergeInvoiceCopyLineItems(primary.lineItems, fallback.lineItems),
    md: primary.md?.trim() ? primary.md : fallback.md,
  };
}

function collapseDuplicateInvoiceCopies(documents: CaseDoc[]) {
  const result: CaseDoc[] = [];

  for (const document of documents) {
    if (!isInvoiceDocType(document.type)) {
      result.push(document);
      continue;
    }

    const existingIndex = result.findIndex(
      (candidate) => isInvoiceDocType(candidate.type) && areDuplicateInvoiceCopies(candidate, document)
    );

    if (existingIndex === -1) {
      result.push(document);
      continue;
    }

    const existing = result[existingIndex];
    result[existingIndex] = shouldPreferInvoiceCopyCandidate(document, existing)
      ? mergeInvoiceCopyDocuments(document, existing)
      : mergeInvoiceCopyDocuments(existing, document);
  }

  return result;
}

function countMeaningfulFields(fields: Partial<Record<FieldKey, string>>) {
  return Object.values(fields).filter((value) => value !== undefined && value !== null && String(value).trim()).length;
}

function hasVisibleCommercialItemTable(doc: CaseDoc) {
  const visibleText = String(doc.md ?? "").toLowerCase();
  if (!visibleText) return false;
  const hasItemHeading = /\b(description|particulars?|item\s+description|invoice\s+items?)\b/.test(visibleText);
  const hasQuantityHeading = /\b(qty|quantity)\b/.test(visibleText);
  const hasCommercialHeading = /\b(hsn|sac|rate|taxable|amount|value)\b/.test(visibleText);
  return hasItemHeading && hasQuantityHeading && hasCommercialHeading;
}

function hasPositiveInvoiceValue(doc: CaseDoc) {
  return ["totalTaxableAmount", "subtotal", "totalAmount"].some((key) => {
    const value = parseLooseNumber(doc.fields?.[key as FieldKey]);
    return value !== null && value > 0;
  });
}

function hasIncompleteVisibleInvoiceLines(doc: CaseDoc) {
  return (
    (doc.type === "Tax Invoice" || doc.type === "Invoice") &&
    !doc.lineItems?.length &&
    hasPositiveInvoiceValue(doc) &&
    hasVisibleCommercialItemTable(doc)
  );
}

function isWeakExtraction(doc: CaseDoc) {
  const fields = doc.fields ?? {};
  const meaningfulFieldCount = countMeaningfulFields(fields);
  const hasLineItems = Boolean(doc.lineItems?.length);
  const hasAnyField = (...keys: FieldKey[]) =>
    keys.some((key) => Boolean(fields[key]?.trim()));

  switch (doc.type) {
    case "Purchase Order":
    case "Amended Purchase Order":
      return !hasAnyField("poNumber", "totalAmount", "itemDescription", "itemQuantity") && !hasLineItems;
    case "PAN Card":
      return !fields.panNumber && !fields.holderName;
    case "Driving Licence":
      return !fields.licenseNumber && !fields.driverName;
    case "Vehicle Registration Certificate":
      return !fields.registrationNumber && !fields.vehicleNumber && !fields.ownerName;
    case "FASTag Toll Proof":
      return !fields.vehicleNumber && !fields.fastagReference && !fields.tollTransactionSummary;
    case "E-Way Bill":
      return !fields.eWayBillNumber && !fields.vehicleNumber;
    case "Tax Invoice":
    case "Invoice":
      return (
        hasIncompleteVisibleInvoiceLines(doc) ||
        (!hasAnyField("invoiceNumber", "totalAmount", "itemDescription", "itemQuantity") && !hasLineItems)
      );
    case "Receipt":
      return !hasAnyField("receiptNumber", "referenceInvoiceNumber", "paidAmount", "transactionDate");
    case "Delivery Challan":
    case "Delivery Note":
      return !hasAnyField("deliveryNoteNumber", "referencePoNumber", "itemDescription", "itemQuantity", "vehicleNumber") && !hasLineItems;
    case "Weighment Slip":
      return !fields.netWeight && !fields.grossWeight && !fields.vehicleNumber;
    case "Lorry Receipt":
      return !hasAnyField("lorryReceiptNumber", "vehicleNumber", "netWeight", "routeFrom", "routeTo");
    case "Material Test Certificate":
      return !hasAnyField("certificateNumber", "batchNumber", "heatNumber", "itemQuantity", "grossWeight", "netWeight");
    case "Transport Permit":
      return !hasAnyField("permitNumber", "permitType", "vehicleNumber", "validityDate");
    case "Bank Statement":
      return !hasAnyField("bankName", "accountNumber", "transactionDate", "transactionReference", "statementAmount");
    case "Map Printout":
      return !hasAnyField("routeFrom", "routeTo", "mapLocation");
    case "Payment Screenshot":
      return !hasAnyField("transactionDate", "transactionReference", "paidAmount", "statementAmount");
    default:
      return doc.type !== "Unknown" && meaningfulFieldCount === 0;
  }
}

function needsImageFallbackForTextExtraction(doc: CaseDoc) {
  if (isWeakExtraction(doc)) return true;

  const fields = doc.fields ?? {};
  const hasLineItems = Boolean(doc.lineItems?.length);
  const hasAnyField = (...keys: FieldKey[]) =>
    keys.some((key) => Boolean(fields[key]?.trim()));

  switch (doc.type) {
    case "Purchase Order":
    case "Amended Purchase Order":
      return !fields.poNumber || (!hasLineItems && !fields.itemDescription);
    case "Tax Invoice":
    case "Invoice":
      return !fields.invoiceNumber || (!hasLineItems && !fields.itemDescription);
    case "Receipt":
      return !hasAnyField("receiptNumber", "paidAmount");
    case "Delivery Challan":
    case "Delivery Note":
      return !fields.deliveryNoteNumber || (!hasLineItems && !fields.itemQuantity);
    case "E-Way Bill":
      return !fields.eWayBillNumber || !fields.vehicleNumber;
    case "Weighment Slip":
      return !fields.vehicleNumber || !hasAnyField("grossWeight", "tareWeight", "netWeight");
    case "Lorry Receipt":
      return !fields.lorryReceiptNumber || !fields.vehicleNumber;
    case "Material Test Certificate":
      return !fields.certificateNumber || !hasAnyField("batchNumber", "heatNumber");
    case "Transport Permit":
      return !fields.permitNumber || !fields.vehicleNumber;
    case "Bank Statement":
      return !hasAnyField("accountNumber", "transactionDate", "transactionReference", "statementAmount");
    case "Payment Screenshot":
      return !hasAnyField("transactionDate", "transactionReference", "paidAmount", "statementAmount");
    default:
      return false;
  }
}

function normalizeFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => {
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const parts = [
            normalizeFieldValue(record.date ?? record.dateTime ?? record.transactionDate),
            normalizeFieldValue(record.plaza ?? record.tollPlaza ?? record.location),
            normalizeFieldValue(record.amount ?? record.debitAmount ?? record.paidAmount),
          ].filter(Boolean);
          return parts.length ? parts.join(" - ") : normalizeFieldValue(record.description ?? record.summary);
        }
        return normalizeFieldValue(entry);
      })
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = normalizeFieldValue(record.value ?? record.text ?? record.summary ?? record.description);
    if (text) return text;
    const fallback = Object.entries(record)
      .map(([key, entry]) => `${key}: ${normalizeFieldValue(entry) ?? ""}`.trim())
      .filter((entry) => !entry.endsWith(":"))
      .join(", ");
    return fallback || undefined;
  }
  const text = String(value).trim();
  return text || undefined;
}

function cleanEWayAddress(value?: string) {
  const cleaned = value
    ?.replace(/\s+/g, " ")
    .replace(/\b(Address\s+Details|Dispatch\s+From|Ship\s+To|GSTIN|State|Pin\s*Code)\b\s*:*/gi, " ")
    .replace(/^[\s:;,\-.]+/, "")
    .replace(/[\s,.;:-]+$/, "")
    .trim();
  return cleaned || undefined;
}

const EWAY_PARTY_STOP_PATTERN =
  /\b(?:::?\s*)?(?:Dispatch\s+From|Dispatched\s+From|Ship\s+To|Ship-to|Goods\s+Details|Vehicle\s+Details|Part\s+B|Transporter\s+Details|Total\s+Invoice|Taxable\s+Amount|Recipient)\b/i;
const EWAY_PARTY_NAME_END_PATTERN =
  /\b(?:PRIVATE\s+LIMITED|PVT\.?\s*LTD\.?|LTD\.?|LIMITED|LLP|ENTERPRISES|INDUSTRIES|IMPEX|LOGISTICS|MARKETING|FABRICATORS|SYSTEMS|SOLUTIONS|TRADE\s+LINK|WIRES\s*&\s*INFRA\s+LIMITED)\b/i;
const INDIAN_STATE_SUFFIX_PATTERN =
  /\b(?:ANDHRA\s+PRADESH|ARUNACHAL\s+PRADESH|ASSAM|BIHAR|CHHATTISGARH|CHATTISGARH|GOA|GUJARAT|HARYANA|HIMACHAL\s+PRADESH|JHARKHAND|KARNATAKA|KERALA|MADHYA\s+PRADESH|MAHARASHTRA|MANIPUR|MEGHALAYA|MIZORAM|NAGALAND|ODISHA|ORISSA|PUNJAB|RAJASTHAN|SIKKIM|TAMIL\s+NADU|TELANGANA|TRIPURA|UTTAR\s+PRADESH|UTTARAKHAND|WEST\s+BENGAL|DELHI|CHANDIGARH|PUDUCHERRY|JAMMU\s+AND\s+KASHMIR|LADAKH|INDIA|MAH)\b\.?$/i;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingGstinToken(value: string, knownGstin?: string) {
  const compactKnownGstin = knownGstin?.replace(/[^a-z0-9]/gi, "");
  if (compactKnownGstin && compactKnownGstin.length >= 10) {
    const knownPattern = new RegExp(`^\\s*${compactKnownGstin.split("").map(escapeRegExp).join("\\s*")}\\s*`, "i");
    const stripped = value.replace(knownPattern, "");
    if (stripped !== value) return stripped;
  }

  if (!/^\s*\d{2}/.test(value)) return value;

  let alnumCount = 0;
  let endIndex = -1;

  for (let index = 0; index < value.length; index += 1) {
    if (/[a-z0-9]/i.test(value[index])) {
      alnumCount += 1;
      if (alnumCount >= 15) {
        endIndex = index + 1;
        break;
      }
    }
  }

  return endIndex > 0 ? value.slice(endIndex) : value;
}

function cleanEWayPartyName(value?: string, knownGstin?: string) {
  if (!value) return undefined;
  const beforeStop = value.split(EWAY_PARTY_STOP_PATTERN)[0] ?? value;
  let cleaned = stripLeadingGstinToken(beforeStop, knownGstin)
    .replace(/\s+/g, " ")
    .replace(/\b(?:Address\s+Details|From|To|GSTIN|State|Portal)\b\s*:*/gi, " ")
    .replace(/^\W*\d+\s+/, "")
    .replace(/^[\s:;,\-.]+/, "")
    .replace(/[\s,.;:-]+$/, "")
    .trim();

  while (INDIAN_STATE_SUFFIX_PATTERN.test(cleaned)) {
    cleaned = cleaned.replace(INDIAN_STATE_SUFFIX_PATTERN, "").replace(/[\s,.;:-]+$/, "").trim();
  }

  if (/\b(?:ltd|limited|private|pvt|llp|industries|enterprises|logistics|alloys|steel|link|wires|solutions)\b/i.test(cleaned)) {
    cleaned = cleaned.replace(/,\s*[^,]+$/i, "").trim();
  }

  const legalPrefix = extractEWayLegalNamePrefix(cleaned);
  if (legalPrefix && (cleaned.length > 90 || /@|\b(?:building\s+no|flat\s+no|name\s+of\s+building|phone|plot\s+no|survey\s+no)\b/i.test(cleaned))) {
    cleaned = legalPrefix;
  }

  if (!/[a-z]/i.test(cleaned)) return undefined;
  if (cleaned.length > 90) return undefined;
  if (/\*/.test(cleaned)) return undefined;
  if (/\b(?:recipient|consignor|building\s+no|flat\s+no|name\s+of\s+building|phone|survey\s+no|plot\s+no|moudha|phase\s+\d|@)\b/i.test(cleaned)) {
    return undefined;
  }
  if (/\bkalika\b/i.test(cleaned) && !/^kalika\b/i.test(cleaned)) return undefined;

  return cleaned;
}

function extractEWayLegalNamePrefix(value: string) {
  const match = value.match(EWAY_PARTY_NAME_END_PATTERN);
  if (!match || match.index === undefined) return undefined;
  return value.slice(0, match.index + match[0].length).trim();
}

function splitEWayPartyPair(value?: string): Partial<Record<"vendorName" | "buyerName", string>> {
  const candidate = value
    ?.split(EWAY_PARTY_STOP_PATTERN)[0]
    ?.replace(/\s+/g, " ")
    .replace(/\b(?:Address\s+Details|From|To|GSTIN|State|Portal)\b\s*:*/gi, " ")
    .trim();
  if (!candidate) return {};

  const kalikaMatch = candidate.match(/\bKALIKA\b/i);
  if (kalikaMatch?.index && kalikaMatch.index > 0) {
    return {
      vendorName: cleanEWayPartyName(candidate.slice(0, kalikaMatch.index)),
      buyerName: cleanEWayPartyName(candidate.slice(kalikaMatch.index)),
    };
  }

  const firstParty = extractEWayLegalNamePrefix(candidate);
  if (!firstParty) return {};
  const secondCandidate = candidate.slice(firstParty.length).trim();
  const secondParty = extractEWayLegalNamePrefix(secondCandidate) ?? secondCandidate;

  return {
    vendorName: cleanEWayPartyName(firstParty),
    buyerName: cleanEWayPartyName(secondParty),
  };
}

function extractEWayBillPartyNames(
  visibleText: string,
  fields: Partial<Record<FieldKey, string>>
): Partial<Record<FieldKey, string>> {
  const text = visibleText.replace(/\s+/g, " ").trim();
  const section = text.match(/\bAddress\s+Details\b\s*(.+?)(?=\b(?:Vehicle\s+Details|Part\s+B|Transporter\s+Details|Total\s+Invoice|Taxable\s+Amount)\b|$)/i)?.[1] ?? text;
  const namesBeforeGstin = section.match(/\bFrom\s+To\s+(.+?)\bGSTIN\s*:?\s*/i)?.[1];
  const preGstinPair = splitEWayPartyPair(namesBeforeGstin);
  const gstinBlocks = section.split(/\bGSTIN\s*:?\s*/i).slice(1);
  const postGstinText = stripLeadingGstinToken(gstinBlocks[1] ?? "", fields.buyerGstin);
  const postGstinPair = splitEWayPartyPair(postGstinText);

  return {
    vendorName:
      cleanEWayPartyName(gstinBlocks[0], fields.supplierGstin) ??
      preGstinPair.vendorName ??
      (postGstinPair.buyerName ? postGstinPair.vendorName : undefined),
    buyerName:
      preGstinPair.buyerName ??
      postGstinPair.buyerName ??
      cleanEWayPartyName(gstinBlocks[1], fields.buyerGstin) ??
      postGstinPair.vendorName ??
      cleanEWayPartyName(postGstinText),
  };
}

function extractEWayBillAddresses(visibleText: string): Partial<Record<FieldKey, string>> {
  const text = visibleText.replace(/\s+/g, " ").trim();
  const match = text.match(/(?:Address\s+Details\s*)?(?:[:：]\s*)?(?:Dispatch\s+From|Dispatched\s+From)\s*[:：]?\s*(.+?)\s*(?:Ship\s+To|Ship-to)\s*[:：]?\s*(.+?)(?=\s*(?:Vehicle\s+Details|Part\s+B|Item\s+Details|Total|$))/i);
  if (!match) return {};
  return {
    dispatchFrom: cleanEWayAddress(match[1]),
    shipTo: cleanEWayAddress(match[2]),
  };
}

function normalizeEWayReferenceText(value: string) {
  const withoutDocumentType = value
    .replace(/^\s*(?:tax\s*invoice|invoice|delivery\s*challan|document|doc(?:ument)?\s*no\.?)\s*[-:/]?\s*/i, "")
    .replace(/^\s*(?:taxinvoice|deliverychallan|invoice|document|docno)\s*[-:/]?\s*/i, "");
  const normalized = withoutDocumentType
    .replace(/[ΚK]\s*[ΑA]/g, "KA")
    .replace(/[ΟO]/g, "O")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9/-]/gi, "")
    .toUpperCase();
  const withoutTrailingDate = normalized.replace(/-\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/, "");
  return /[A-Z]/.test(withoutTrailingDate) && withoutTrailingDate.length >= 5
    ? withoutTrailingDate
    : normalized;
}

function extractEWayBillReferenceInvoiceNumber(visibleText: string) {
  const text = visibleText.replace(/\s+/g, " ").trim();
  const documentDetails = text.match(/\bDocument\s+Details\s*:?\s*([\s\S]{0,220}?)(?=\s+\b(?:IRN|RN|Address\s+Details|GSTIN|Goods\s+Details)\b|$)/i)?.[1];
  if (!documentDetails) return undefined;

  const seriesPrefix = normalizeEWayReferenceText(
    documentDetails.match(/\b(?:Tax\s+Invoice|Invoice|Delivery\s+Challan)\s*[-:'"]+\s*([A-ZΑ-Ω]{1,8})(?=\s+(?:Transaction\s*type|Portal|Regular|\d)|\s*[-/]?\s*\d)/i)?.[1] ?? ""
  );
  const cleanedDetails = documentDetails
    .replace(/\bTransaction\s*type\s*[:;]?\s*[A-Z]+\b/gi, " ")
    .replace(/\bPortal\s*:?\s*\d+\b/gi, " ")
    .replace(/\b(?:Tax\s+Invoice|Invoice|Delivery\s+Challan)\b/gi, " ");
  const candidates = [...cleanedDetails.matchAll(/\b(?:[A-ZΑ-Ω]{1,8}\s*[-/]?\s*)?\d{2,}[A-ZΑ-Ω0-9]*(?:[/-]\d{1,4}){0,5}\b/gi)]
    .map((match) => normalizeEWayReferenceText(match[0]))
    .filter((candidate) => isEWayReferenceCandidate(candidate));
  const withSeries = candidates.find((candidate) => /[A-ZΑ-Ω]/.test(candidate));
  const numericOnly = candidates.find((candidate) => !/[A-ZΑ-Ω]/.test(candidate));

  if (seriesPrefix && numericOnly) return `${seriesPrefix}-${numericOnly}`;
  return withSeries ? formatEWaySeriesReference(withSeries) : numericOnly;
}

function cleanExistingEWayReferenceInvoiceNumber(value?: string) {
  if (!value) return undefined;
  const normalized = normalizeEWayReferenceText(value);
  return normalized.length >= 2 && /\d/.test(normalized) ? normalized : undefined;
}

function formatEWaySeriesReference(value: string) {
  return value.replace(/^([A-ZΑ-Ω]{1,12})[-/]?(\d)/, "$1-$2");
}

function isEWayReferenceCandidate(value: string) {
  const compact = value.replace(/[^A-Z0-9Α-Ω]/gi, "");
  if (compact.length < 4 || !/\d/.test(compact)) return false;
  return !/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/i.test(value);
}

function compactEWayReference(value?: string) {
  return value?.replace(/[^A-Z0-9Α-Ω]/gi, "").toUpperCase() ?? "";
}

function stripEWayReferenceSeries(value: string) {
  return value.replace(/^[A-ZΑ-Ω]{1,12}(?=\d)/, "");
}

function chooseEWayReferenceInvoiceNumber(existing?: string, extracted?: string) {
  const cleanedExisting = cleanExistingEWayReferenceInvoiceNumber(existing);
  const cleanedExtracted = cleanExistingEWayReferenceInvoiceNumber(extracted);
  if (!cleanedExisting) return cleanedExtracted;
  if (!cleanedExtracted) return cleanedExisting;

  const existingCompact = compactEWayReference(cleanedExisting);
  const extractedCompact = compactEWayReference(cleanedExtracted);
  if (existingCompact === extractedCompact) return cleanedExisting;

  const existingHasSeries = /^[A-ZΑ-Ω]{1,12}\d{6,}$/.test(existingCompact);
  const extractedHasSeries = /^[A-ZΑ-Ω]{1,12}\d{6,}$/.test(extractedCompact);
  const existingBody = stripEWayReferenceSeries(existingCompact);
  const extractedBody = stripEWayReferenceSeries(extractedCompact);

  if (extractedHasSeries && !existingHasSeries && extractedBody === existingCompact) {
    return cleanedExtracted;
  }
  if (existingHasSeries && !extractedHasSeries && existingBody === extractedCompact) {
    return cleanedExisting;
  }

  return cleanedExisting;
}

const EWAY_DATE_PATTERN =
  "(?:\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}|\\d{1,2}[/. -]\\d{1,2}[/. -]\\d{2,4}|\\d{1,2}-[A-Za-z]{3}-\\d{2,4})(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:AM|PM)?)?";
const EWAY_VEHICLE_PATTERN = /\b[A-Z]{2}\s*\d{1,2}\s*[A-Z]{1,3}\s*\d{3,4}\b/gi;
const EWAY_GSTIN_PATTERN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/gi;

function cleanEWayDateValue(value?: string) {
  const raw = value?.match(new RegExp(EWAY_DATE_PATTERN, "i"))?.[0];
  return raw
    ?.replace(/\s*([/-])\s*/g, "$1")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEWayDate(text: string, labelPattern: string) {
  const direct = text.match(new RegExp(`\\b${labelPattern}\\s*:?\\s*(${EWAY_DATE_PATTERN})`, "i"))?.[1];
  if (direct) return cleanEWayDateValue(direct);

  const context = text.match(new RegExp(`\\b${labelPattern}\\b([\\s\\S]{0,140})`, "i"))?.[1];
  return cleanEWayDateValue(context);
}

function normalizeEWayAmount(value?: string) {
  if (!value) return null;
  let compact = value.replace(/[₹$€£\s]/g, "");
  if (/^-?\d+,\d{2}$/.test(compact) && !compact.includes(".")) {
    compact = compact.replace(/,(\d{2})$/, ".$1");
  }
  compact = compact.replace(/,/g, "");
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatEWayNumberForField(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function extractEWayAmounts(value: string) {
  return [...value.matchAll(/-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|-?\d+,\d{2}\b|-?\d+\.\d{1,2}\b/g)]
    .map((match) => normalizeEWayAmount(match[0]))
    .filter((amount): amount is number => amount !== null);
}

function extractEWayCommercialAmounts(text: string, fields: Partial<Record<FieldKey, string>>) {
  const summaryBlock =
    text.match(/\b(?:Tot\.?\s*Tax'?ble\s*Amt|Total\s+Taxable\s+Amt)\b[\s\S]{0,700}?(?=\b(?:Transportation\s+Details|Transporter\s+ID|Vehicle\s+Details|Part\s*-?\s*B)\b|$)/i)?.[0] ??
    text.match(/\b(?:Taxable\s+Amount|Taxable\s+Value)\b[\s\S]{0,700}?(?=\b(?:Transportation\s+Details|Transporter\s+ID|Vehicle\s+Details|Part\s*-?\s*B)\b|$)/i)?.[0];
  const amounts = summaryBlock ? extractEWayAmounts(summaryBlock) : [];
  const existingSubtotal = normalizeEWayAmount(fields.subtotal);
  const existingTax = normalizeEWayAmount(fields.taxAmount);
  const existingTotal = normalizeEWayAmount(fields.totalAmount);
  const subtotal = existingSubtotal ?? amounts[0] ?? null;
  const blockTotal = amounts.length >= 2 ? amounts[amounts.length - 1] : null;
  const total = existingTotal ?? (blockTotal !== null && subtotal !== null && blockTotal >= subtotal ? blockTotal : null);
  const taxAmount =
    existingTax ??
    (subtotal !== null && total !== null && total >= subtotal
      ? Math.round((total - subtotal) * 100) / 100
      : null);
  const derivedSubtotal =
    subtotal ??
    (total !== null && taxAmount !== null && total >= taxAmount
      ? Math.round((total - taxAmount) * 100) / 100
      : null);
  const taxRate =
    derivedSubtotal !== null && derivedSubtotal > 0 && taxAmount !== null
      ? Math.round((taxAmount / derivedSubtotal) * 10000) / 100
      : null;

  return {
    subtotal: derivedSubtotal === null ? undefined : formatEWayNumberForField(derivedSubtotal),
    totalTaxableAmount: derivedSubtotal === null ? undefined : formatEWayNumberForField(derivedSubtotal),
    taxAmount: taxAmount === null ? undefined : formatEWayNumberForField(taxAmount),
    taxRate: taxRate === null || taxRate < 0 || taxRate > 40 ? undefined : formatEWayNumberForField(taxRate),
    totalAmount: total === null ? undefined : formatEWayNumberForField(total),
  } satisfies Partial<Record<FieldKey, string>>;
}

function cleanEWayTransporterName(value?: string) {
  const cleaned = value
    ?.replace(/^\s*(?:\d{2}\s*[A-Z]{5}\s*\d{4}\s*[A-Z]\s*[0-9A-Z]\s*Z\s*[0-9A-Z]|[0-9A-Z\s]{10,20})\s*&\s*/i, "")
    .replace(EWAY_GSTIN_PATTERN, "")
    .replace(/^[\s&:;,\-.]+/, "")
    .replace(/\b(?:Transporter\s+Doc|Vehicle\s+Details|Part\s*-?\s*B|Vehicle\s*\/\s*Trans|Mode\s+From|Entered\s+Date)\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,.;:-]+$/, "")
    .trim();
  if (!cleaned || !/[a-z]/i.test(cleaned) || cleaned.length > 90) return undefined;
  return cleaned;
}

function formatEWayVehicleNumber(value?: string) {
  const compact = value?.replace(/\s+/g, "").toUpperCase();
  return compact && /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4}$/.test(compact) ? compact : undefined;
}

function extractEWayVehicleNumber(text: string) {
  const vehicleBlock = text.match(/\b(?:Vehicle\s+Details|Part\s*-?\s*B)\b([\s\S]{0,900})/i)?.[1] ?? text;
  const roadVehicle = formatEWayVehicleNumber(
    vehicleBlock.match(new RegExp(`\\bRoad\\s+(${EWAY_VEHICLE_PATTERN.source})`, "i"))?.[1]
  );
  if (roadVehicle) return roadVehicle;

  return [...vehicleBlock.matchAll(EWAY_VEHICLE_PATTERN)]
    .map((match) => formatEWayVehicleNumber(match[0]))
    .find((value): value is string => Boolean(value));
}

function extractEWayTransporterDocFromVehicleRow(text: string, vehicleNumber?: string) {
  if (!vehicleNumber) return undefined;
  const vehicleWithSpaces = vehicleNumber.replace(/([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{3,4})/, "$1\\s*$2\\s*$3\\s*$4");
  const rowDoc = text.match(new RegExp(`\\bRoad\\s+${vehicleWithSpaces}\\s*&\\s*([A-Z0-9/-]{2,})\\s*&\\s*${EWAY_DATE_PATTERN}`, "i"))?.[1];
  return rowDoc && rowDoc !== "0" ? rowDoc.trim() : undefined;
}

function extractEWayTransportDetails(text: string) {
  const transporterName = cleanEWayTransporterName(
    text.match(/\bTransporter\s+ID\s*&\s*Name\s*:?\s*(?:[0-9A-Z\s]{10,20}\s*&\s*)?(.+?)(?=\s*(?:Transporter\s+Doc|Vehicle\s+Details|Part\s*-?\s*B|$))/i)?.[1]
  );
  const vehicleNumber = extractEWayVehicleNumber(text);
  const transporterDoc = text
    .match(/\bTransporter\s+Doc\.?\s*(?:No\.?|Number)?\s*&\s*Date\s*:?\s*([A-Z0-9/-]+)(?=\s*&|\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\s|$)/i)?.[1]
    ?.trim() ?? extractEWayTransporterDocFromVehicleRow(text, vehicleNumber);

  return {
    transporterName,
    lorryReceiptNumber: transporterDoc && transporterDoc !== "0" ? transporterDoc : undefined,
    vehicleNumber,
  } satisfies Partial<Record<FieldKey, string>>;
}

function applyEWayBillAddressFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string
) {
  if (docType !== "E-Way Bill" || !visibleText.trim()) return fields;
  const text = visibleText.replace(/\s+/g, " ").trim();
  const addresses = extractEWayBillAddresses(visibleText);
  const parties = extractEWayBillPartyNames(visibleText, fields);
  const referenceInvoiceNumber = chooseEWayReferenceInvoiceNumber(
    fields.referenceInvoiceNumber,
    extractEWayBillReferenceInvoiceNumber(visibleText)
  );
  const amounts = extractEWayCommercialAmounts(text, fields);
  const transport = extractEWayTransportDetails(text);
  const transporterName = transport.transporterName ?? cleanEWayTransporterName(fields.transporterName);
  const vehicleNumber = formatEWayVehicleNumber(fields.vehicleNumber) ?? transport.vehicleNumber;
  const documentDate = extractEWayDate(text, "(?:Generated\\s+Date|E-?Way\\s+Bill\\s+Date|Way\\s+Bill\\s+Date)");
  const validityDate =
    cleanEWayDateValue(fields.validityDate) ??
    extractEWayDate(text, "(?:Valid\\s*(?:Upto|Up\\s*To|Until|Till))");
  return {
    ...fields,
    ...(fields.vendorName || !parties.vendorName ? {} : { vendorName: parties.vendorName }),
    ...(fields.buyerName || !parties.buyerName ? {} : { buyerName: parties.buyerName }),
    ...(!referenceInvoiceNumber || referenceInvoiceNumber === fields.referenceInvoiceNumber ? {} : { referenceInvoiceNumber }),
    ...(fields.documentDate || !documentDate ? {} : { documentDate }),
    ...(!validityDate || validityDate === fields.validityDate ? {} : { validityDate }),
    ...(fields.subtotal || !amounts.subtotal ? {} : { subtotal: amounts.subtotal }),
    ...(fields.totalTaxableAmount || !(amounts.totalTaxableAmount ?? amounts.subtotal)
      ? {}
      : { totalTaxableAmount: amounts.totalTaxableAmount ?? amounts.subtotal }),
    ...(fields.taxAmount || !amounts.taxAmount ? {} : { taxAmount: amounts.taxAmount }),
    ...(fields.taxRate || !amounts.taxRate ? {} : { taxRate: amounts.taxRate }),
    ...(fields.totalAmount || !amounts.totalAmount ? {} : { totalAmount: amounts.totalAmount }),
    ...(!transporterName ? {} : { transporterName }),
    ...(fields.lorryReceiptNumber || !transport.lorryReceiptNumber ? {} : { lorryReceiptNumber: transport.lorryReceiptNumber }),
    ...(!vehicleNumber || vehicleNumber === fields.vehicleNumber ? {} : { vehicleNumber }),
    ...(fields.dispatchFrom || !addresses.dispatchFrom ? {} : { dispatchFrom: addresses.dispatchFrom }),
    ...(fields.shipTo || !addresses.shipTo ? {} : { shipTo: addresses.shipTo }),
  };
}

function extractFirstMatch(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

function extractFastagTransactions(visibleText: string) {
  const lines = visibleText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const entries: Array<{ dateTime: string; plaza: string; lane?: string; amount: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const dateTime = lines[index].match(/\d{2}[-/]\d{2}[-/]\d{4}\s+\d{2}:\d{2}:\d{2}/)?.[0];
    if (!dateTime) continue;

    const block: string[] = [lines[index]];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/\d{2}[-/]\d{2}[-/]\d{4}\s+\d{2}:\d{2}:\d{2}/.test(lines[next])) break;
      block.push(lines[next]);
    }

    const blockText = block.join(" ");
    if (!/Plaza\s+Name/i.test(blockText)) continue;

    const plaza = blockText
      .match(/Plaza\s+Name\s*:?\s*([A-Za-z][A-Za-z0-9 ()]+?)(?=\s*-\s*Lane|\s+Lane\s+ID|\s+0\.00|\s+\/?\d{8,}|$)/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    if (!plaza) continue;

    const lane = blockText.match(/Lane\s+ID\s*:?\s*([A-Z0-9 ]+?)(?=\s+0\.00|\s+\d{1,3}(?:,\d{3})*(?:\.\d{2})|$)/i)?.[1]?.replace(/\s+/g, " ").trim();
    const amounts = [...blockText.matchAll(/\b\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/g)].map((match) => match[0]);
    const amount = amounts.at(-1);
    if (!amount) continue;

    entries.push({ dateTime, plaza, lane, amount });
  }

  return entries;
}

function extractFastagDetails(visibleText: string): Partial<Record<FieldKey, string>> {
  const compact = visibleText.replace(/\s+/g, " ").trim();
  if (!compact) return {};

  const summaryMatch = compact.match(
    /(\d{6,})\s+([A-Z]{2}\d{2}[A-Z]{1,3}\d{4})\s+\S+\s+(\d+)\s+([\d,.]+)\s+([\d,.]+)\s+-?\s*([\d,.]+)\s+([\d,.]+)/i
  );
  const tagVehicleBlock = compact.match(/Tag\s+Account\s+No\.\s+Licence\s+Plate\s+No\..*?(\d{6,})\s+([A-Z]{2}\d{2}[A-Z]{1,3}\d{4})/i);
  const vehicleTagMatch = compact.match(/\b([A-Z]{2}\d{2}[A-Z0-9]{1,4}\d{3,4})\s*[-–]\s*(\d{6,})\b/i);
  const paymentMatch = compact.match(/\bPayment\b.*?([\d,]+\.\d{2})\s+0\.00/i);
  const transactionRows = extractFastagTransactions(visibleText);
  const transactionSummary = transactionRows
    .slice(0, 12)
    .map((entry) => {
      const lane = entry.lane ? ` Lane ID:${entry.lane}` : "";
      return `${entry.dateTime} Plaza Name: ${entry.plaza}${lane} Amount (DR) ${entry.amount}`;
    })
    .join("\n");
  const statementDate = extractFirstMatch(compact, /Statement\s+Date\s*:?\s*(\d{2}[-/]\d{2}[-/]\d{4})/i);
  const statementReference = (
    extractFirstMatch(compact, /Statement\s+Reference\s+Number\s+([A-Z0-9/.-]+)/i) ??
    extractFirstMatch(compact, /Statement\s+Reference\s+(?:Number\s+)?([A-Z0-9/.-]+)/i)
  )?.replace(/t/gi, "/");
  const customerId = extractFirstMatch(compact, /Customer\s+[Il1]?D\s*:?\s*(?:[A-Z0-9/.-]+\s+)?(\d{7,})/i);
  const customerName = [...compact.matchAll(/Name\s*:\s*([A-Z][A-Z .'-]+?)(?=\s+(?:Branch|Statement\s+Period|Bill\s+From|GSTIN|Address:|supply:))/gi)]
    .map((match) => match[1].replace(/\s+/g, " ").trim())
    .find((name) => !/ICICI|BANK|BRANCH/i.test(name)) ??
    extractFirstMatch(compact, /Address\s*:\s*([A-Z][A-Z .'-]+?)\s+\d{1,5}[,\s]/i);

  return {
    fastagStatementReference: statementReference,
    fastagCustomerId: customerId,
    fastagCustomerName: customerName,
    statementPeriod: extractFirstMatch(compact, /Statement\s+Period\s*:?\s*(\d{2}[-/]\d{2}[-/]\d{4}\s+to\s+\d{2}[-/]\d{2}[-/]\d{4})/i),
    statementDate,
    transactionDate: statementDate,
    ...(summaryMatch
      ? {
          fastagReference: summaryMatch[1],
          vehicleNumber: summaryMatch[2],
          tripCount: summaryMatch[3],
          openingBalance: summaryMatch[4],
          creditAmount: summaryMatch[5],
          debitAmount: summaryMatch[6].replace(/^-/, ""),
          closingBalance: summaryMatch[7],
          statementAmount: summaryMatch[7],
        }
      : {}),
    ...(!summaryMatch && tagVehicleBlock ? { fastagReference: tagVehicleBlock[1], vehicleNumber: tagVehicleBlock[2] } : {}),
    ...(!summaryMatch && !tagVehicleBlock && vehicleTagMatch ? { vehicleNumber: vehicleTagMatch[1], fastagReference: vehicleTagMatch[2] } : {}),
    ...(paymentMatch?.[1] ? { paidAmount: paymentMatch[1] } : {}),
    ...(transactionRows[0]?.plaza ? { tollPlaza: transactionRows[0].plaza } : {}),
    ...(transactionSummary ? { tollTransactionSummary: transactionSummary } : {}),
  };
}

function applyFastagDetailsFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string
) {
  if (docType !== "FASTag Toll Proof" || !visibleText.trim()) return fields;
  const details = extractFastagDetails(visibleText);
  return Object.entries(details).reduce(
    (acc, [key, value]) => {
      if (value) acc[key as FieldKey] = value;
      return acc;
    },
    { ...fields } as Partial<Record<FieldKey, string>>
  );
}

const FASTAG_CONTEXT_FIELDS: FieldKey[] = [
  "vehicleNumber",
  "fastagReference",
  "fastagStatementReference",
  "fastagCustomerId",
  "fastagCustomerName",
  "statementPeriod",
  "statementDate",
];

const PARTY_CONTEXT_DOC_TYPES = new Set<DocType>([
  "Purchase Order",
  "Amended Purchase Order",
  "Invoice",
  "Tax Invoice",
]);

const COMMERCIAL_TOTAL_DOC_TYPES = new Set<DocType>([
  "Purchase Order",
  "Amended Purchase Order",
  "Invoice",
  "Tax Invoice",
]);

const WEIGHT_MISMATCH_FIELDS = new Set<FieldKey>(["grossWeight", "tareWeight", "netWeight"]);
const VEHICLE_CONSENSUS_DOC_TYPE_WEIGHT: Partial<Record<DocType, number>> = {
  "E-Way Bill": 4,
  "Tax Invoice": 3,
  Invoice: 3,
  "Delivery Challan": 3,
  "Delivery Note": 3,
  "Lorry Receipt": 3,
  "Vehicle Registration Certificate": 2,
  "Transport Permit": 2,
  "Photo Evidence": 1,
};
const VEHICLE_OCR_CORRECTABLE_DOC_TYPES = new Set<DocType>([
  "Delivery Challan",
  "Delivery Note",
  "Lorry Receipt",
  "Weighment Slip",
  "Transport Permit",
  "Photo Evidence",
]);

function normalizePacketValue(value: string | number | null | undefined, field?: FieldKey) {
  return normalizeComparableValue(value, DEFAULT_COMPARISON_OPTIONS, field) || null;
}

function getSinglePacketValue(documents: CaseDoc[], field: FieldKey) {
  const values = [
    ...new Set(
      documents
        .map((doc) => normalizePacketValue(doc.fields[field], field))
        .filter((value): value is string => Boolean(value))
    ),
  ];
  return values.length === 1 ? documents.find((doc) => normalizePacketValue(doc.fields[field], field) === values[0])?.fields[field] : undefined;
}

function hasOnlyTransactionSummary(fields: Partial<Record<FieldKey, string>>) {
  const identityFields: FieldKey[] = [
    "vehicleNumber",
    "fastagReference",
    "fastagStatementReference",
    "fastagCustomerId",
    "fastagCustomerName",
    "statementPeriod",
    "statementDate",
  ];

  return Boolean(fields.tollTransactionSummary && identityFields.every((field) => !fields[field]));
}

function findBestFastagContext(documents: CaseDoc[]) {
  const fastagDocs = documents.filter((doc) => doc.type === "FASTag Toll Proof");
  return fastagDocs
    .filter((doc) => FASTAG_CONTEXT_FIELDS.some((field) => doc.fields[field]))
    .sort((left, right) => {
      const leftScore = FASTAG_CONTEXT_FIELDS.filter((field) => left.fields[field]).length;
      const rightScore = FASTAG_CONTEXT_FIELDS.filter((field) => right.fields[field]).length;
      return rightScore - leftScore;
    })[0];
}

function enrichFastagContinuationDocs(documents: CaseDoc[]) {
  const bestFastag = findBestFastagContext(documents);
  const packetVehicleNumber = bestFastag?.fields.vehicleNumber ?? getSinglePacketValue(documents, "vehicleNumber");

  return documents.map((doc) => {
    if (doc.type !== "FASTag Toll Proof") return doc;
    if (!hasOnlyTransactionSummary(doc.fields) && !FASTAG_CONTEXT_FIELDS.some((field) => !doc.fields[field] && bestFastag?.fields[field])) {
      return doc;
    }

    const fields = { ...doc.fields };
    for (const field of FASTAG_CONTEXT_FIELDS) {
      const sourceValue = bestFastag?.id !== doc.id ? bestFastag?.fields[field] : undefined;
      if (!fields[field] && sourceValue) {
        fields[field] = sourceValue;
      }
    }
    if (!fields.vehicleNumber && packetVehicleNumber) {
      fields.vehicleNumber = packetVehicleNumber;
    }

    return { ...doc, fields };
  });
}

function getBestPartyNameByGstin(
  documents: CaseDoc[],
  gstinField: "supplierGstin" | "buyerGstin",
  nameField: "vendorName" | "buyerName",
  gstin: string | undefined
) {
  const normalizedGstin = normalizePacketValue(gstin, gstinField);
  if (!normalizedGstin) return undefined;

  const candidates = documents
    .filter((doc) => PARTY_CONTEXT_DOC_TYPES.has(doc.type))
    .filter((doc) => normalizePacketValue(doc.fields[gstinField], gstinField) === normalizedGstin)
    .map((doc) => doc.fields[nameField])
    .filter((name): name is string => Boolean(name && /[a-z]/i.test(name)))
    .filter((name) => !/\b(?:pcr|portal|address|dispatch|ship|recipient)\b/i.test(name));

  return candidates.sort((left, right) => right.length - left.length)[0];
}

function enrichEWayBillParties(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (doc.type !== "E-Way Bill") return doc;

    const vendorName = getBestPartyNameByGstin(documents, "supplierGstin", "vendorName", doc.fields.supplierGstin);
    const buyerName = getBestPartyNameByGstin(documents, "buyerGstin", "buyerName", doc.fields.buyerGstin);
    const fields = { ...doc.fields };

    if (vendorName && vendorName !== fields.vendorName) {
      fields.vendorName = vendorName;
    }
    if (buyerName && buyerName !== fields.buyerName) {
      fields.buyerName = buyerName;
    }

    return fields.vendorName === doc.fields.vendorName && fields.buyerName === doc.fields.buyerName
      ? doc
      : { ...doc, fields };
  });
}

function areFieldRecordsEqual(
  left: Partial<Record<FieldKey, string>>,
  right: Partial<Record<FieldKey, string>>
) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key as FieldKey] === right[key as FieldKey]);
}

function enrichEWayBillCoreFields(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (doc.type !== "E-Way Bill" || !doc.md?.trim()) return doc;

    const fields = applyEWayBillAddressFallback(doc.fields, doc.type, doc.md);
    return areFieldRecordsEqual(doc.fields, fields) ? doc : { ...doc, fields };
  });
}

function enrichPurchaseOrderCoreFields(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (!isPurchaseOrderDocType(doc.type)) return doc;

    const fields = removeNonRequiredPurchaseOrderPresenceFields(
      applyPurchaseOrderDateFallback(doc.fields, doc.type, doc.md ?? ""),
      doc.type
    );
    return areFieldRecordsEqual(doc.fields, fields) ? doc : { ...doc, fields };
  });
}

function normalizeVehicleNumberForDisplay(value: string | undefined) {
  const normalized = normalizePacketValue(value, "vehicleNumber");
  return normalized && /^[a-z]{2}\d{1,2}[a-z]{1,3}\d{3,4}$/i.test(normalized)
    ? normalized.toUpperCase()
    : value;
}

function isValidIndianVehicleNumber(value: string | undefined) {
  const normalized = normalizePacketValue(value, "vehicleNumber");
  return Boolean(normalized && /^[a-z]{2}\d{1,2}[a-z]{1,3}\d{3,4}$/i.test(normalized));
}

function isNumericOnlyIdentifier(value: string | undefined) {
  return Boolean(value && /^\d{5,14}$/.test(value.replace(/\D/g, "")) && !/[a-z]/i.test(value));
}

function vehicleCore(value: string | undefined) {
  const normalized = normalizeVehicleNumberForDisplay(value);
  if (!normalized) return null;
  const compact = normalized.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.match(/^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{3,4})$/);
}

function editDistanceValue(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function normalizeWeighmentVehicleOcrText(value: string) {
  return value
    .toUpperCase()
    .replace(/[ΑА]/g, "A")
    .replace(/[ΒВ]/g, "B")
    .replace(/[СϹ]/g, "C")
    .replace(/[ΕЕ]/g, "E")
    .replace(/[ΗН]/g, "H")
    .replace(/[ΙІ]/g, "I")
    .replace(/[ΚК]/g, "K")
    .replace(/[ΜМ]/g, "M")
    .replace(/[ΝИ]/g, "N")
    .replace(/[ΟО]/g, "O")
    .replace(/[ΡР]/g, "P")
    .replace(/[ΤТ]/g, "T")
    .replace(/[ΥУ]/g, "Y")
    .replace(/[ΧХ]/g, "X");
}

function extractLooseVehicleCandidates(value: string) {
  const normalized = normalizeWeighmentVehicleOcrText(value);
  const candidates = [
    ...normalized.matchAll(/\b([A-Z]{1,2})\s*[-.]?\s*(\d{1,2})\s*[-.]?\s*([A-Z]{1,3})\s*[-.]?\s*(\d{3,4})\b/g),
  ]
    .map((match) => `${match[1]}${match[2]}${match[3]}${match[4]}`.toUpperCase())
    .filter((candidate) => /[A-Z]{1,2}\d{1,2}[A-Z]{1,3}\d{3,4}/.test(candidate));
  return [...new Set(candidates)];
}

function looseVehicleSupportsCanonical(candidate: string, canonicalVehicle: string) {
  const canonical = vehicleCore(canonicalVehicle);
  const loose = candidate.match(/^([A-Z]{1,2})(\d{1,2})([A-Z]{1,3})(\d{3,4})$/);
  if (!canonical || !loose) return false;

  const [, canonicalState, canonicalDistrict, canonicalSeries, canonicalNumber] = canonical;
  const [, looseState, looseDistrict, looseSeries, looseNumber] = loose;
  if (canonicalDistrict !== looseDistrict) return false;

  const stateClose =
    canonicalState === looseState ||
    canonicalState.endsWith(looseState) ||
    looseState.endsWith(canonicalState) ||
    editDistanceValue(canonicalState, looseState) <= 1;
  if (!stateClose) return false;

  if (canonicalNumber === looseNumber) {
    return editDistanceValue(canonicalSeries, looseSeries) <= Math.max(1, canonicalSeries.length - 1);
  }

  return canonicalSeries === looseSeries && editDistanceValue(canonicalNumber, looseNumber) <= 1;
}

function weighmentTextSupportsVehicle(doc: CaseDoc, vehicleNumber: string) {
  const normalizedVehicle = normalizeVehicleNumberForDisplay(vehicleNumber);
  if (!normalizedVehicle) return false;
  const compactVisibleText = normalizeWeighmentVehicleOcrText(doc.md ?? "").replace(/[^A-Z0-9]/g, "");
  if (compactVisibleText.includes(normalizedVehicle)) return true;
  return extractLooseVehicleCandidates(doc.md ?? "").some((candidate) =>
    looseVehicleSupportsCanonical(candidate, normalizedVehicle)
  );
}

function getVehicleConsensus(documents: CaseDoc[]) {
  const scores = new Map<string, { value: string; score: number; docIds: Set<string>; docTypes: Set<DocType> }>();

  for (const doc of documents) {
    if (doc.type === "Weighment Slip") continue;
    const weight = VEHICLE_CONSENSUS_DOC_TYPE_WEIGHT[doc.type] ?? 0;
    if (!weight) continue;
    const displayValue = normalizeVehicleNumberForDisplay(doc.fields.vehicleNumber ?? doc.fields.registrationNumber);
    const normalizedValue = normalizePacketValue(displayValue, "vehicleNumber");
    if (!displayValue || !normalizedValue) continue;
    const current = scores.get(normalizedValue) ?? {
      value: displayValue,
      score: 0,
      docIds: new Set<string>(),
      docTypes: new Set<DocType>(),
    };
    current.score += weight;
    current.docIds.add(doc.id);
    current.docTypes.add(doc.type);
    scores.set(normalizedValue, current);
  }

  return [...scores.values()]
    .filter(
      (entry) =>
        entry.docIds.size >= 2 ||
        (entry.docTypes.has("E-Way Bill") && entry.score >= 4) ||
        ((entry.docTypes.has("Invoice") || entry.docTypes.has("Tax Invoice")) && entry.score >= 3)
    )
    .sort((left, right) => right.score - left.score || right.docIds.size - left.docIds.size)[0];
}

function enrichWeighmentVehicleNumbers(documents: CaseDoc[]) {
  const consensus = getVehicleConsensus(documents);
  if (!consensus) return documents;

  return documents.map((doc) => {
    if (doc.type !== "Weighment Slip") return doc;
    const consensusVehicle = normalizeVehicleNumberForDisplay(consensus.value);
    if (!consensusVehicle || !weighmentTextSupportsVehicle(doc, consensusVehicle)) return doc;

    const currentVehicle = normalizeVehicleNumberForDisplay(doc.fields.vehicleNumber);
    if (currentVehicle === consensusVehicle) return doc;

    return {
      ...doc,
      fields: {
        ...doc.fields,
        vehicleNumber: consensusVehicle,
      },
    };
  });
}

function isCorrectableVehicleOcrValue(current: string | undefined, consensus: string) {
  if (!current) return false;

  const currentCompact = normalizeWeighmentVehicleOcrText(current).replace(/[^A-Z0-9]/g, "");
  const consensusCompact = normalizeVehicleNumberForDisplay(consensus)?.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!currentCompact || !consensusCompact || currentCompact === consensusCompact) return false;
  if (!currentCompact.startsWith(consensusCompact.slice(0, 2))) return false;
  if (currentCompact.slice(-4) !== consensusCompact.slice(-4)) return false;

  return editDistanceValue(currentCompact, consensusCompact) <= 3;
}

function enrichCorroboratedVehicleNumbers(documents: CaseDoc[]) {
  const consensus = getVehicleConsensus(documents);
  const consensusVehicle = normalizeVehicleNumberForDisplay(consensus?.value);
  if (!consensusVehicle) return documents;

  return documents.map((doc) => {
    if (!VEHICLE_OCR_CORRECTABLE_DOC_TYPES.has(doc.type)) return doc;

    const currentVehicle = normalizeVehicleNumberForDisplay(doc.fields.vehicleNumber);
    if (currentVehicle === consensusVehicle) return doc;

    const supportedByText = weighmentTextSupportsVehicle(doc, consensusVehicle);
    const supportedByOcrShape = isCorrectableVehicleOcrValue(doc.fields.vehicleNumber, consensusVehicle);
    if (!supportedByText && !supportedByOcrShape) return doc;

    return {
      ...doc,
      fields: {
        ...doc.fields,
        vehicleNumber: consensusVehicle,
      },
    };
  });
}

function normalizeGstinForDisplay(value: string | undefined, field: "supplierGstin" | "buyerGstin") {
  const normalized = normalizeComparableValue(value, DEFAULT_COMPARISON_OPTIONS, field);
  return normalized && /^[0-9A-Z]{15}$/.test(normalized) ? normalized : value;
}

const GSTIN_CONSENSUS_FIELDS = ["supplierGstin", "buyerGstin"] as const;

function getGstinConsensus(documents: CaseDoc[], field: (typeof GSTIN_CONSENSUS_FIELDS)[number]) {
  const counts = new Map<string, { value: string; docIds: Set<string> }>();
  for (const doc of documents) {
    const value = normalizeGstinForDisplay(doc.fields[field], field);
    if (!value) continue;
    const current = counts.get(value) ?? { value, docIds: new Set<string>() };
    current.docIds.add(doc.id);
    counts.set(value, current);
  }

  return [...counts.values()]
    .filter((entry) => entry.docIds.size >= 2)
    .sort((left, right) => right.docIds.size - left.docIds.size)[0]?.value;
}

function visibleTextSupportsGstin(doc: CaseDoc, gstin: string) {
  return (doc.md ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").includes(gstin);
}

function isCorrectableGstinOcrValue(current: string | undefined, consensus: string) {
  if (!current || current.length !== 15 || consensus.length !== 15) return false;
  return current.slice(0, 2) === consensus.slice(0, 2) && editDistanceValue(current, consensus) <= 2;
}

function enrichGstinConsensusValues(documents: CaseDoc[]) {
  const consensusByField = Object.fromEntries(
    GSTIN_CONSENSUS_FIELDS.map((field) => [field, getGstinConsensus(documents, field)])
  ) as Partial<Record<(typeof GSTIN_CONSENSUS_FIELDS)[number], string>>;

  if (!Object.values(consensusByField).some(Boolean)) return documents;

  return documents.map((doc) => {
    const fields = { ...doc.fields };
    let changed = false;

    for (const field of GSTIN_CONSENSUS_FIELDS) {
      const consensus = consensusByField[field];
      const current = normalizeGstinForDisplay(fields[field], field);
      if (
        consensus &&
        current !== consensus &&
        (visibleTextSupportsGstin(doc, consensus) || isCorrectableGstinOcrValue(current, consensus))
      ) {
        fields[field] = consensus;
        changed = true;
      }
    }

    return changed ? { ...doc, fields } : doc;
  });
}

function normalizeEWayBillNumberForDisplay(value: string | undefined) {
  if (!value) return value;
  const digits = value.replace(/\D/g, "");
  return digits.length === 12 ? digits : value;
}

function getValidEWayBillNumber(value: string | undefined) {
  const digits = value?.replace(/\D/g, "");
  return digits && digits.length === 12 ? digits : undefined;
}

function normalizeInvoiceLikeReference(value: string | undefined) {
  const compact = value?.toUpperCase().replace(/[^A-Z0-9/-]/g, "") ?? "";
  return compact && /[A-Z]/.test(compact) && /\d/.test(compact) && compact.length >= 5 ? compact : undefined;
}

function addQualityIssue(
  issues: ExtractionQualityIssue[],
  field: FieldKey,
  originalValue: string,
  action: ExtractionQualityIssue["action"],
  reason: string,
  targetField?: FieldKey
) {
  issues.push({
    field,
    originalValue,
    action,
    ...(targetField ? { targetField } : {}),
    reason,
  });
}

function applyIdentifierQualityGuard(doc: CaseDoc): CaseDoc {
  const fields = { ...doc.fields };
  const qualityIssues = [...(doc.qualityIssues ?? [])];
  let changed = false;

  if (fields.vehicleNumber && !isValidIndianVehicleNumber(fields.vehicleNumber)) {
    const originalValue = fields.vehicleNumber;
    if (doc.type === "Weighment Slip" && isNumericOnlyIdentifier(originalValue) && !fields.weighmentNumber) {
      fields.weighmentNumber = originalValue.replace(/\D/g, "");
      addQualityIssue(
        qualityIssues,
        "vehicleNumber",
        originalValue,
        "moved",
        "Numeric-only lorry/weighment value is not a valid Indian vehicle registration.",
        "weighmentNumber"
      );
    } else {
      addQualityIssue(
        qualityIssues,
        "vehicleNumber",
        originalValue,
        "quarantined",
        "Value is not a valid Indian vehicle registration and was excluded from packet comparison."
      );
    }
    delete fields.vehicleNumber;
    changed = true;
  }

  if (fields.registrationNumber && !isValidIndianVehicleNumber(fields.registrationNumber)) {
    const originalValue = fields.registrationNumber;
    addQualityIssue(
      qualityIssues,
      "registrationNumber",
      originalValue,
      "quarantined",
      "Registration value is not a valid Indian vehicle registration and was excluded from packet comparison."
    );
    delete fields.registrationNumber;
    changed = true;
  }

  if (fields.eWayBillNumber && !getValidEWayBillNumber(fields.eWayBillNumber)) {
    const originalValue = fields.eWayBillNumber;
    const invoiceLikeReference = normalizeInvoiceLikeReference(originalValue);
    if (doc.type === "E-Way Bill" && invoiceLikeReference && !fields.referenceInvoiceNumber) {
      fields.referenceInvoiceNumber = invoiceLikeReference;
      addQualityIssue(
        qualityIssues,
        "eWayBillNumber",
        originalValue,
        "moved",
        "E-Way Bill number must be 12 digits; this value looks like a document or invoice reference.",
        "referenceInvoiceNumber"
      );
    } else {
      addQualityIssue(
        qualityIssues,
        "eWayBillNumber",
        originalValue,
        "quarantined",
        "E-Way Bill number must be 12 digits and was excluded from packet comparison."
      );
    }
    delete fields.eWayBillNumber;
    changed = true;
  }

  return changed ? { ...doc, fields, qualityIssues } : doc;
}

function applyIdentifierQualityGuards(documents: CaseDoc[]) {
  return documents.map(applyIdentifierQualityGuard);
}

function visibleTextSupportsEWayBillNumber(doc: CaseDoc, eWayBillNumber: string) {
  return (doc.md ?? "").replace(/\D/g, "").includes(eWayBillNumber);
}

function getEWayBillNumberConsensus(documents: CaseDoc[]) {
  const counts = new Map<string, { value: string; score: number }>();

  for (const doc of documents) {
    const value = getValidEWayBillNumber(doc.fields.eWayBillNumber);
    if (!value) continue;
    const current = counts.get(value) ?? { value, score: 0 };
    current.score += doc.type === "E-Way Bill" ? 5 : 1;
    counts.set(value, current);
  }

  return [...counts.values()].sort((left, right) => right.score - left.score)[0]?.value;
}

function enrichInvoiceEWayBillNumbers(documents: CaseDoc[]) {
  const consensus = getEWayBillNumberConsensus(documents);
  if (!consensus) return documents;

  return documents.map((doc) => {
    if (!isInvoiceDocType(doc.type)) return doc;
    const current = getValidEWayBillNumber(doc.fields.eWayBillNumber);
    if (current === consensus) return doc;
    if (current && current !== consensus) return doc;

    const irnFieldHasConsensus = getValidEWayBillNumber(doc.fields.irnNumber) === consensus;
    if (!irnFieldHasConsensus && !visibleTextSupportsEWayBillNumber(doc, consensus)) return doc;

    return {
      ...doc,
      fields: {
        ...doc.fields,
        eWayBillNumber: consensus,
      },
    };
  });
}

function normalizeCompactReferenceForDisplay(value: string | undefined) {
  if (!value) return value;
  const compact = value.toUpperCase().replace(/\s+/g, "");
  return /[A-Z]/.test(compact) && /\d/.test(compact) ? compact : value;
}

function normalizeLineItemUnitForDisplay(value: string | undefined) {
  if (!value) return value;
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["ea", "each", "nos", "no", "nr", "number", "numbers", "pcs", "piece", "pieces", "pc"].includes(compact)) return "Nos";
  if (["kg", "kgs", "kilogram", "kilograms"].includes(compact)) return "KG";
  if (["mt", "mts", "mton", "mtons", "metricton", "metrictons", "metrictonne", "metrictonnes", "tonne", "tonnes"].includes(compact)) return "MT";
  if (["ltr", "liter", "litre", "liters", "litres"].includes(compact)) return "LTR";
  return value;
}

function cleanVisibleItemCodeCandidate(value: string, hsnSac?: string) {
  const cleaned = value
    .replace(/^[•*\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 80) return null;
  if (/^\*{0,2}\s*(?:item\s*)?(?:quantity|qty|unit|hsn(?:\/sac)?|sac|rate|taxable|amount|total|gst|cgst|sgst|igst|description)\s*\*{0,2}\s*:/i.test(cleaned)) return null;

  const compact = cleaned.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const hsnCompact = hsnSac?.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (!compact || compact === hsnCompact) return null;
  if (!/\d/.test(compact)) return null;
  if (/^\d{1,2}$/.test(compact)) return null;
  if (/^\d{1,2}%$/.test(cleaned)) return null;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(cleaned) || /^\d+\.\d{2}$/.test(cleaned)) return null;
  if (/^(?:hsn|sac|gst|qty|unit|nos|inr|rate|total|value)$/i.test(cleaned)) return null;

  return cleaned;
}

function extractVisibleItemCodesBeforeHsn(visibleText: string, hsnSac?: string) {
  const hsnCompact = hsnSac?.replace(/\D/g, "");
  if (!visibleText.trim() || !hsnCompact || hsnCompact.length < 4) return [];

  const lines = visibleText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const codes: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (!line.replace(/\D/g, "").startsWith(hsnCompact)) continue;

    for (let cursor = index - 1; cursor >= Math.max(0, index - 5); cursor -= 1) {
      const candidate = cleanVisibleItemCodeCandidate(lines[cursor], hsnSac);
      if (!candidate) continue;
      codes.push(candidate);
      break;
    }
  }

  return codes;
}

function isWeakExtractedItemCode(value?: string, description?: string) {
  if (!value) return true;
  const compact = value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (compact.length <= 2) return true;
  if (description && compact === description.replace(/[^A-Z0-9]/gi, "").toUpperCase()) return true;
  if (/^\*{0,2}\s*(?:item\s*)?(?:quantity|qty|unit|hsn(?:\/sac)?|sac|rate|taxable|amount|total|gst|cgst|sgst|igst|description)\b/i.test(value)) return true;
  return /\b(?:guide|roller|cylinder|gas|spares?|parts?)\b/i.test(value);
}

function fillVisibleItemCodes(lineItems: CommercialLineItem[] | undefined, visibleText: string) {
  if (!lineItems?.length || !visibleText.trim()) return lineItems;

  const codesByHsn = new Map<string, string[]>();
  let changed = false;

  const next = lineItems.map((item) => {
    const hsnKey = item.hsnSac?.replace(/\D/g, "");
    if (!hsnKey) return item;

    const codes = codesByHsn.get(hsnKey) ?? extractVisibleItemCodesBeforeHsn(visibleText, item.hsnSac);
    codesByHsn.set(hsnKey, codes);
    const candidate = codes.shift();
    if (!isWeakExtractedItemCode(item.itemCode, item.description)) return item;
    if (!candidate) {
      if (!item.itemCode) return item;
      changed = true;
      const withoutItemCode = { ...item };
      delete withoutItemCode.itemCode;
      return withoutItemCode;
    }
    if (candidate === item.itemCode) return item;

    changed = true;
    return { ...item, itemCode: candidate };
  });

  return changed ? next : lineItems;
}

const WEIGHT_FIELD_KEYS: FieldKey[] = ["grossWeight", "tareWeight", "netWeight"];

function restoreVisibleDocumentDate(
  docType: DocType,
  current: string | undefined,
  visibleText: string
) {
  if (current || !visibleText.trim()) return current;
  const label =
    docType === "E-Way Bill"
      ? "(?:generated(?:\\s+date|\\s+on)|e-?way\\s+bill\\s+date)"
      : docType === "Lorry Receipt"
        ? "(?:receipt|consignment|lr)\\s+date"
        : docType === "Weighment Slip"
          ? "(?:weighment\\s+)?date(?:\\s*\\/\\s*time)?"
          : null;
  if (!label) return current;
  return visibleText.match(new RegExp(`\\b${label}\\s*[:#-]?\\s*(${EWAY_DATE_PATTERN})`, "i"))?.[1]?.trim();
}

function restoreVisibleWeightUnit(
  field: FieldKey,
  value: string | undefined,
  visibleText: string
) {
  if (!value || /\b(?:kg|kgs?|m\.?t\.?s?\.?|metric\s*ton(?:ne)?s?|tonnes?|tons?)\b/i.test(value)) return value;
  const numeric = parseLooseNumber(value);
  if (numeric === null) return value;

  const label = field === "grossWeight" ? "gross" : field === "tareWeight" ? "tare" : "(?:net|declared)";
  const labelled = new RegExp(`${label}\\s*(?:weight)?[^\\d]{0,30}([\\d,.]+)\\s*(kg|kgs?|m\\.?t\\.?s?\\.?|metric\\s*ton(?:ne)?s?|tonnes?|tons?)`, "i");
  const labelledMatch = visibleText.match(labelled);
  if (labelledMatch && numbersClose(parseLooseNumber(labelledMatch[1]) ?? Number.NaN, numeric)) {
    return `${value.trim()} ${labelledMatch[2].toUpperCase().replace(/\.$/, "")}`;
  }

  const candidates = [...visibleText.matchAll(/([\d,.]+)\s*(kg|kgs?|m\.?t\.?s?\.?|metric\s*ton(?:ne)?s?|tonnes?|tons?)\b/gi)];
  const match = candidates.find((candidate) => numbersClose(parseLooseNumber(candidate[1]) ?? Number.NaN, numeric));
  return match ? `${value.trim()} ${match[2].toUpperCase().replace(/\.$/, "")}` : value;
}

function normalizeLineItemDisplayFields(lineItems: CommercialLineItem[] | undefined, visibleText = "") {
  if (!lineItems?.length) return lineItems;

  const withVisibleCodes = fillVisibleItemCodes(lineItems, visibleText) ?? lineItems;
  let changed = false;
  const normalized = withVisibleCodes.map((item) => {
    const unit = normalizeLineItemUnitForDisplay(item.unit);
    if (!unit || unit === item.unit) return item;
    changed = true;
    return { ...item, unit };
  });

  return changed || withVisibleCodes !== lineItems ? normalized : lineItems;
}

function normalizeIdentifierDisplayFields(documents: CaseDoc[]) {
  return documents.map((doc) => {
    const fields = { ...doc.fields };
    const visibleText = getVisibleTextFromMarkdown(doc.md);
    let changed = false;

    const supplierGstin = normalizeGstinForDisplay(fields.supplierGstin, "supplierGstin");
    if (supplierGstin && supplierGstin !== fields.supplierGstin) {
      fields.supplierGstin = supplierGstin;
      changed = true;
    }

    const buyerGstin = normalizeGstinForDisplay(fields.buyerGstin, "buyerGstin");
    if (buyerGstin && buyerGstin !== fields.buyerGstin) {
      fields.buyerGstin = buyerGstin;
      changed = true;
    }

    if (
      isPurchaseOrderDocType(doc.type) &&
      fields.supplierGstin &&
      fields.buyerGstin &&
      normalizePacketValue(fields.supplierGstin, "supplierGstin") === normalizePacketValue(fields.buyerGstin, "buyerGstin")
    ) {
      delete fields.supplierGstin;
      changed = true;
    }

    if (isInvoiceDocType(doc.type) && fields.invoiceNumber) {
      for (const field of PO_NUMBER_FIELD_KEYS) {
        if (
          fields[field] &&
          normalizePacketValue(fields[field], field) === normalizePacketValue(fields.invoiceNumber, "invoiceNumber")
        ) {
          delete fields[field];
          changed = true;
        }
      }
    }

    const eWayBillNumber = normalizeEWayBillNumberForDisplay(fields.eWayBillNumber);
    if (eWayBillNumber && eWayBillNumber !== fields.eWayBillNumber) {
      fields.eWayBillNumber = eWayBillNumber;
      changed = true;
    }

    for (const field of PO_NUMBER_FIELD_KEYS) {
      const reference = normalizeCompactReferenceForDisplay(fields[field]);
      if (reference && reference !== fields[field]) {
        fields[field] = reference;
        changed = true;
      }
    }

    const vehicleNumber = normalizeVehicleNumberForDisplay(fields.vehicleNumber);
    if (vehicleNumber && vehicleNumber !== fields.vehicleNumber) {
      fields.vehicleNumber = vehicleNumber;
      changed = true;
    }

    const registrationNumber = normalizeVehicleNumberForDisplay(fields.registrationNumber);
    if (registrationNumber && registrationNumber !== fields.registrationNumber) {
      fields.registrationNumber = registrationNumber;
      changed = true;
    }

    for (const field of WEIGHT_FIELD_KEYS) {
      const restored = restoreVisibleWeightUnit(field, fields[field], visibleText);
      if (restored && restored !== fields[field]) {
        fields[field] = restored;
        changed = true;
      }
    }

    const fieldsWithPoReference = applyInvoicePoReferenceFallback(fields, doc.type, visibleText);
    if (fieldsWithPoReference !== fields) {
      Object.assign(fields, fieldsWithPoReference);
      changed = true;
    }

    const documentDate = restoreVisibleDocumentDate(doc.type, fields.documentDate, visibleText);
    if (documentDate && documentDate !== fields.documentDate) {
      fields.documentDate = documentDate;
      changed = true;
    }

    const lineItems = normalizeLineItemDisplayFields(doc.lineItems, visibleText);
    if (lineItems !== doc.lineItems) {
      changed = true;
    }

    return changed ? { ...doc, fields, lineItems } : doc;
  });
}

function parseLooseNumber(value: string | number | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value) return null;

  const compact = String(value).replace(/[₹$€£,\s]/g, "");
  const match = compact.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeWeightForDisplay(value: string | number | null | undefined) {
  const parsed = parseLooseNumber(value);
  if (parsed === null) return null;

  const raw = String(value ?? "").toLowerCase();
  const kg = /\b(?:m\.?t\.?s?\.?|metric\s*ton(?:ne)?s?|tonnes?|tons?)\b/i.test(raw) ? parsed * 1000 : parsed;
  return {
    raw: String(value ?? ""),
    kg,
  };
}

function formatNumberForField(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function numbersClose(left: number, right: number, tolerance = 0.01) {
  return Math.abs(left - right) <= Math.max(tolerance, Math.abs(right) * 0.001);
}

function isClearMagnitudeError(current: number, expected: number) {
  if (expected <= 0 || current <= 0) return false;
  if (numbersClose(current, expected)) return false;

  const ratio = current / expected;
  return [10, 100, 1000, 0.1, 0.01, 0.001].some((factor) => Math.abs(ratio - factor) <= factor * 0.02);
}

function normalizeTaxRateValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  return rounded >= 0 && rounded <= 40 ? rounded : null;
}

function parseTaxRateField(value: string | number | null | undefined) {
  return normalizeTaxRateValue(parseLooseNumber(value));
}

function selectDominantTaxRate(rates: number[]) {
  const counts = new Map<string, { value: number; count: number }>();
  rates.forEach((rate) => {
    const normalized = normalizeTaxRateValue(rate);
    if (normalized === null) return;
    const key = formatNumberForField(normalized);
    const current = counts.get(key) ?? { value: normalized, count: 0 };
    current.count += 1;
    counts.set(key, current);
  });

  return [...counts.values()].sort((left, right) => right.count - left.count || right.value - left.value)[0]?.value ?? null;
}

function getLineItemTaxRate(item: CommercialLineItem) {
  const taxRate = parseTaxRateField(item.taxRate);
  if (taxRate !== null) return taxRate;

  const igstRate = parseTaxRateField(item.igstRate);
  if (igstRate !== null) return igstRate;

  const cgstRate = parseTaxRateField(item.cgstRate);
  const sgstRate = parseTaxRateField(item.sgstRate);
  if (cgstRate !== null && sgstRate !== null) return normalizeTaxRateValue(cgstRate + sgstRate);

  return cgstRate ?? sgstRate;
}

type TaxRateFieldKey = "taxRate" | "cgstRate" | "sgstRate" | "igstRate";
type GstTaxMode = "igst" | "split" | "unknown";

const HOME_GST_STATE_CODE = "27";
const DEFAULT_GST_RATE = 18;
const STANDARD_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

function inferTaxRateFromAmounts(fields: Partial<Record<FieldKey, string>>) {
  let taxableBase = parseLooseNumber(fields.subtotal);
  let taxAmount = parseLooseNumber(fields.taxAmount);
  const totalAmount = parseLooseNumber(fields.totalAmount);

  if ((taxAmount === null || taxAmount <= 0) && taxableBase !== null && totalAmount !== null && totalAmount > taxableBase) {
    taxAmount = totalAmount - taxableBase;
  }

  if ((taxableBase === null || taxableBase <= 0) && taxAmount !== null && totalAmount !== null && totalAmount > taxAmount) {
    taxableBase = totalAmount - taxAmount;
  }

  if (taxableBase === null || taxableBase <= 0 || taxAmount === null || taxAmount <= 0) return null;
  return normalizeTaxRateValue((taxAmount / taxableBase) * 100);
}

function normalizeKnownGstRate(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  let closest: number | null = null;
  let closestDelta = Number.POSITIVE_INFINITY;
  for (const rate of STANDARD_GST_RATES) {
    const delta = Math.abs(rate - value);
    if (delta < closestDelta) {
      closest = rate;
      closestDelta = delta;
    }
  }
  return closestDelta <= 0.25 ? closest : null;
}

function getDominantLineItemSpecificTaxRate(
  lineItems: CommercialLineItem[] | undefined,
  field: TaxRateFieldKey
) {
  const rates = (lineItems ?? [])
    .map((item) => parseTaxRateField(item[field]))
    .filter((value): value is number => value !== null);
  return selectDominantTaxRate(rates);
}

function getGstinStateCode(value: string | undefined) {
  const normalized = value?.toUpperCase().replace(/[^0-9A-Z]/g, "") ?? "";
  const match = normalized.match(/\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]/);
  return match?.[0].slice(0, 2) ?? null;
}

function inferTaxModeFromGstins(fields: Partial<Record<FieldKey, string>>): GstTaxMode {
  const supplierState = getGstinStateCode(fields.supplierGstin);
  const buyerState = getGstinStateCode(fields.buyerGstin);

  if (supplierState && buyerState) {
    return supplierState === buyerState ? "split" : "igst";
  }

  const knownState = buyerState ?? supplierState;
  if (!knownState) return "unknown";
  return knownState === HOME_GST_STATE_CODE ? "split" : "igst";
}

function getLineItemTaxRateForMode(item: CommercialLineItem, taxMode: GstTaxMode) {
  const taxRate = parseTaxRateField(item.taxRate);
  const igstRate = parseTaxRateField(item.igstRate);
  const cgstRate = parseTaxRateField(item.cgstRate);
  const sgstRate = parseTaxRateField(item.sgstRate);
  const singleSplitRate = cgstRate ?? sgstRate;
  const taxRateLooksLikeSingleSplitComponent =
    taxRate !== null &&
    singleSplitRate !== null &&
    Math.abs(taxRate - singleSplitRate) <= 0.25;

  if (taxMode === "igst") {
    if (igstRate !== null) return igstRate;
    if (cgstRate !== null && sgstRate !== null) return normalizeTaxRateValue(cgstRate + sgstRate);
    if (taxRate !== null && !taxRateLooksLikeSingleSplitComponent) return taxRate;
    return null;
  }

  if (taxMode === "split") {
    if (cgstRate !== null && sgstRate !== null) return normalizeTaxRateValue(cgstRate + sgstRate);
    if (igstRate !== null) return igstRate;
    if (taxRate !== null && !taxRateLooksLikeSingleSplitComponent) return taxRate;
    return null;
  }

  if (taxRate !== null) return taxRate;
  return getLineItemTaxRate(item);
}

function getDominantLineItemTaxRateForMode(
  lineItems: CommercialLineItem[] | undefined,
  taxMode: GstTaxMode
) {
  const rates = (lineItems ?? [])
    .map((item) => getLineItemTaxRateForMode(item, taxMode))
    .filter((value): value is number => value !== null);
  return selectDominantTaxRate(rates);
}

function setDocumentTaxRateField(
  fields: Partial<Record<FieldKey, string>>,
  key: TaxRateFieldKey,
  rate: number
) {
  const formatted = formatNumberForField(rate);
  if (fields[key] === formatted) return false;
  fields[key] = formatted;
  return true;
}

function enrichDocumentTaxRateFields(doc: CaseDoc) {
  const fields = { ...doc.fields };
  let changed = false;
  const taxMode = inferTaxModeFromGstins(fields);
  const lineRates = (doc.lineItems ?? [])
    .map((item) => getLineItemTaxRateForMode(item, taxMode))
    .filter((value): value is number => value !== null);
  const amountDerivedRate = inferTaxRateFromAmounts(fields);
  const totalRate =
    amountDerivedRate ??
    parseTaxRateField(fields.taxRate) ??
    getDominantLineItemTaxRateForMode(doc.lineItems, taxMode) ??
    selectDominantTaxRate(lineRates) ??
    null;

  if (taxMode !== "unknown") {
    const resolvedTotalRate =
      normalizeKnownGstRate(amountDerivedRate) ??
      normalizeKnownGstRate(parseTaxRateField(fields.taxRate)) ??
      normalizeKnownGstRate(getDominantLineItemTaxRateForMode(doc.lineItems, taxMode)) ??
      normalizeKnownGstRate(selectDominantTaxRate(lineRates)) ??
      normalizeKnownGstRate(totalRate) ??
      DEFAULT_GST_RATE;
    changed = setDocumentTaxRateField(fields, "taxRate", resolvedTotalRate) || changed;

    if (taxMode === "split") {
      changed = setDocumentTaxRateField(fields, "cgstRate", resolvedTotalRate / 2) || changed;
      changed = setDocumentTaxRateField(fields, "sgstRate", resolvedTotalRate / 2) || changed;
      if (fields.igstRate) {
        delete fields.igstRate;
        changed = true;
      }
    } else {
      changed = setDocumentTaxRateField(fields, "igstRate", resolvedTotalRate) || changed;
      if (fields.cgstRate) {
        delete fields.cgstRate;
        changed = true;
      }
      if (fields.sgstRate) {
        delete fields.sgstRate;
        changed = true;
      }
    }

    return changed ? { ...doc, fields } : doc;
  }

  if (totalRate !== null && !fields.taxRate) {
    fields.taxRate = formatNumberForField(totalRate);
    changed = true;
  }

  const cgstRate = parseTaxRateField(fields.cgstRate) ?? getDominantLineItemSpecificTaxRate(doc.lineItems, "cgstRate");
  const sgstRate = parseTaxRateField(fields.sgstRate) ?? getDominantLineItemSpecificTaxRate(doc.lineItems, "sgstRate");
  const igstRate = parseTaxRateField(fields.igstRate) ?? getDominantLineItemSpecificTaxRate(doc.lineItems, "igstRate");

  if (cgstRate !== null && !fields.cgstRate) {
    fields.cgstRate = formatNumberForField(cgstRate);
    changed = true;
  }
  if (sgstRate !== null && !fields.sgstRate) {
    fields.sgstRate = formatNumberForField(sgstRate);
    changed = true;
  }
  if (igstRate !== null && !fields.igstRate) {
    fields.igstRate = formatNumberForField(igstRate);
    changed = true;
  }

  return changed ? { ...doc, fields } : doc;
}

function parseVisibleTaxRate(value: string) {
  const normalized = value.startsWith(".") ? `0${value}` : value;
  return normalizeTaxRateValue(Number(normalized));
}

function extractPurchaseOrderTaxRatesFromText(visibleText: string) {
  const rates: number[] = [];
  const ratePattern =
    /\b(?:I\s*\/\s*)?(?:CGST|SGST|IGST|GST)\b(?:[ \t]*(?:rate)?[ \t]*)?(?:[:/-][ \t]*)?(\d{1,2}(?:\.\d+)?|\.\d+)[ \t]*%?/gi;

  visibleText.split(/\r?\n/).forEach((line) => {
    for (const match of line.matchAll(ratePattern)) {
      const rate = parseVisibleTaxRate(match[1]);
      if (rate !== null) rates.push(rate);
    }
  });

  return rates;
}

function inferPurchaseOrderTaxRate(doc: CaseDoc, lineItems: CommercialLineItem[]) {
  if (!isPurchaseOrderDocType(doc.type)) return null;

  const lineRates = lineItems
    .map(getLineItemTaxRate)
    .filter((value): value is number => value !== null);
  const directRate = selectDominantTaxRate(lineRates);
  if (directRate !== null) return directRate;

  const visibleText = doc.md ?? "";
  const textRate = selectDominantTaxRate(extractPurchaseOrderTaxRatesFromText(visibleText));
  if (textRate === null || textRate === 0) return textRate;

  const hasCgst = /\bcgst\b/i.test(visibleText);
  const hasSgst = /\bsgst\b/i.test(visibleText);
  const hasIgst = /\bigst\b/i.test(visibleText);
  if (hasCgst && hasSgst && !hasIgst && textRate <= 14) {
    return normalizeTaxRateValue(textRate * 2);
  }

  return textRate;
}

function fillPurchaseOrderLineItemTaxRates(lineItems: CommercialLineItem[], taxRate: number | null) {
  if (taxRate === null) return lineItems;

  let changed = false;
  const formattedTaxRate = formatNumberForField(taxRate);
  const next = lineItems.map((item) => {
    const amount = parseLooseNumber(item.taxableAmount ?? item.lineTotal);
    if (amount === null || amount <= 0 || item.taxRate) return item;
    changed = true;
    return { ...item, taxRate: formattedTaxRate };
  });

  return changed ? next : lineItems;
}

function correctLineItemAmounts(
  lineItems: CommercialLineItem[] | undefined,
  fields: Partial<Record<FieldKey, string>>
) {
  if (!lineItems?.length) return lineItems;

  let changed = false;
  const documentTaxAmount = parseLooseNumber(fields.taxAmount);
  const documentTotalAmount = parseLooseNumber(fields.totalAmount);
  const corrected = lineItems.map((item) => {
    const quantity = parseLooseNumber(item.quantity);
    const rate = parseLooseNumber(item.rate ?? item.netRate);
    if (quantity === null || rate === null || quantity <= 0 || rate < 0) return item;

    const expected = quantity * rate;
    const next = { ...item };
    const lineTotal = parseLooseNumber(item.lineTotal);
    const taxableAmount = parseLooseNumber(item.taxableAmount);

    if (lineTotal !== null && isClearMagnitudeError(lineTotal, expected)) {
      next.lineTotal = formatNumberForField(expected);
      changed = true;
    }
    if (taxableAmount !== null && isClearMagnitudeError(taxableAmount, expected)) {
      next.taxableAmount = formatNumberForField(expected);
      changed = true;
    }

    const correctedTaxableAmount = parseLooseNumber(next.taxableAmount);
    if (
      lineItems.length === 1 &&
      lineTotal !== null &&
      correctedTaxableAmount !== null &&
      documentTaxAmount !== null &&
      documentTotalAmount !== null &&
      numbersClose(lineTotal, documentTotalAmount, 0.5) &&
      numbersClose(correctedTaxableAmount + documentTaxAmount, documentTotalAmount, 0.5)
    ) {
      next.lineTotal = formatNumberForField(correctedTaxableAmount);
      changed = true;
    }

    return next;
  });

  return changed ? corrected : lineItems;
}

function getDocumentTaxRateFromFields(fields: Partial<Record<FieldKey, string>>) {
  const explicitRate =
    parseTaxRateField(fields.taxRate) ??
    parseTaxRateField(fields.igstRate) ??
    (() => {
      const cgstRate = parseTaxRateField(fields.cgstRate);
      const sgstRate = parseTaxRateField(fields.sgstRate);
      return cgstRate !== null && sgstRate !== null ? normalizeTaxRateValue(cgstRate + sgstRate) : null;
    })();

  return normalizeKnownGstRate(explicitRate);
}

function correctInvoiceTotalMisreadAsTaxableValue(doc: CaseDoc) {
  if (!isInvoiceDocType(doc.type)) return doc;

  const fields = { ...doc.fields };
  const subtotal = parseLooseNumber(fields.subtotal);
  const totalAmount = parseLooseNumber(fields.totalAmount);
  const taxAmount = parseLooseNumber(fields.taxAmount);
  if (subtotal !== null || totalAmount === null || totalAmount <= 0 || taxAmount === null || taxAmount <= 0) {
    return doc;
  }

  const fieldRate = getDocumentTaxRateFromFields(fields);
  const amountDerivedRate = normalizeKnownGstRate((taxAmount / totalAmount) * 100);
  const taxRate = fieldRate ?? amountDerivedRate;
  if (taxRate === null) return doc;

  const expectedTax = totalAmount * (taxRate / 100);
  if (!numbersClose(taxAmount, expectedTax, Math.max(1, taxAmount * 0.002))) {
    return doc;
  }

  fields.subtotal = formatNumberForField(totalAmount);
  fields.totalAmount = formatNumberForField(totalAmount + taxAmount);
  return { ...doc, fields };
}

function correctCommercialTotals(doc: CaseDoc) {
  doc = correctInvoiceTotalMisreadAsTaxableValue(doc);
  if (!COMMERCIAL_TOTAL_DOC_TYPES.has(doc.type) || !doc.lineItems?.length) return doc;

  let lineItems = correctLineItemAmounts(doc.lineItems, doc.fields) ?? doc.lineItems;
  const lineSum = lineItems
    ?.map((item) => parseLooseNumber(item.taxableAmount ?? item.lineTotal))
    .filter((value): value is number => value !== null && value >= 0)
    .reduce((total, value) => total + value, 0);
  if (!lineSum || lineSum <= 0) {
    return lineItems === doc.lineItems ? doc : { ...doc, lineItems };
  }

  const fields = { ...doc.fields };
  let subtotal = parseLooseNumber(fields.subtotal);
  let totalAmount = parseLooseNumber(fields.totalAmount);
  let taxAmount = parseLooseNumber(fields.taxAmount);
  let changed = lineItems !== doc.lineItems;

  if (isPurchaseOrderDocType(doc.type)) {
    const purchaseOrderTaxRate = inferPurchaseOrderTaxRate(doc, lineItems);
    const lineItemsWithTaxRates = fillPurchaseOrderLineItemTaxRates(lineItems, purchaseOrderTaxRate);
    if (lineItemsWithTaxRates !== lineItems) {
      lineItems = lineItemsWithTaxRates;
      changed = true;
    }

    if (subtotal === null) {
      subtotal = lineSum;
      fields.subtotal = formatNumberForField(lineSum);
      changed = true;
    }

    if (taxAmount === null && subtotal !== null && totalAmount !== null && totalAmount >= subtotal) {
      taxAmount = Math.max(0, totalAmount - subtotal);
      fields.taxAmount = formatNumberForField(taxAmount);
      changed = true;
    }

    if (taxAmount === null && subtotal !== null && purchaseOrderTaxRate !== null) {
      taxAmount = subtotal * (purchaseOrderTaxRate / 100);
      fields.taxAmount = formatNumberForField(taxAmount);
      changed = true;
    }

    if (totalAmount === null && subtotal !== null && taxAmount !== null) {
      totalAmount = subtotal + taxAmount;
      fields.totalAmount = formatNumberForField(totalAmount);
      changed = true;
    }
  }

  if (subtotal !== null && isClearMagnitudeError(subtotal, lineSum)) {
    fields.subtotal = formatNumberForField(lineSum);
    changed = true;
  }

  const expectedTotal = taxAmount !== null ? lineSum + taxAmount : lineSum;
  if (totalAmount !== null && isClearMagnitudeError(totalAmount, expectedTotal)) {
    fields.totalAmount = formatNumberForField(expectedTotal);
    changed = true;
  }

  return changed ? { ...doc, fields, lineItems } : doc;
}

function enrichCommercialAmounts(documents: CaseDoc[]) {
  return enrichDocumentsWithPacketGstTaxContext(
    documents.map((doc) => enrichDocumentTaxRateFields(correctCommercialTotals(doc)))
  );
}

function applyConsigneeBuyerGuardToDocuments(documents: CaseDoc[]) {
  return documents.map((doc) => {
    const fields = applyConsigneeBuyerGuard(doc.fields, doc.md ?? "");
    return areFieldRecordsEqual(doc.fields, fields) ? doc : { ...doc, fields };
  });
}

export function enrichProcessedDocuments(documents: CaseDoc[]) {
  const withFastag = enrichFastagContinuationDocs(documents);
  const withGstin = enrichGstinConsensusValues(withFastag);
  const withPoCore = enrichPurchaseOrderCoreFields(withGstin);
  const withEWayCore = enrichEWayBillCoreFields(withPoCore);
  const withIdentifierQuality = applyIdentifierQualityGuards(withEWayCore);
  const withInvoiceEWay = enrichInvoiceEWayBillNumbers(withIdentifierQuality);
  const withParties = enrichEWayBillParties(withInvoiceEWay);
  const withVehicles = enrichCorroboratedVehicleNumbers(enrichWeighmentVehicleNumbers(withParties));
  const withConsigneeGuard = applyConsigneeBuyerGuardToDocuments(withVehicles);
  return applyIdentifierQualityGuards(normalizeIdentifierDisplayFields(enrichCommercialAmounts(withConsigneeGuard)));
}

function buildProcessedVerificationResult(
  verificationResult: ReturnType<typeof verifyGroupedCaseDocuments>
) {
  const mismatches: Mismatch[] = verificationResult.mismatches.map((mismatch) => ({
    ...mismatch,
    ...buildMismatchCopy(mismatch),
  }));

  return {
    verificationGroups: verificationResult.groups,
    mismatches,
  };
}

function inferDocTypeFromFilename(fileName: string): DocType {
  const lower = fileName.toLowerCase();
  if (lower.includes("amended") && lower.includes("po")) return "Amended Purchase Order";
  if (lower.includes("test") || lower.includes("mtc") || lower.includes("mtr")) return "Material Test Certificate";
  if (lower.includes("licence") || lower.includes("license") || lower.includes("dl")) return "Driving Licence";
  if (lower.includes("permit") || lower.includes("authorisation") || lower.includes("authorization")) return "Transport Permit";
  if (lower.includes("photo") || lower.includes("camera")) return "Photo Evidence";
  if (lower.includes("tax") && lower.includes("invoice")) return "Tax Invoice";
  if (lower.includes("eway") || lower.includes("e-way")) return "E-Way Bill";
  if (lower.includes("weighment") || lower.includes("weight")) return "Weighment Slip";
  if ((lower.includes("transport") && lower.includes("challan")) || lower.includes("lorry") || lower.includes("consignment") || lower.includes("lr")) return "Lorry Receipt";
  if (lower.includes("rc") || lower.includes("registration")) return "Vehicle Registration Certificate";
  if (lower.includes("pan")) return "PAN Card";
  if (lower.includes("fastag") || lower.includes("toll")) return "FASTag Toll Proof";
  if (lower.includes("bank") && lower.includes("statement")) return "Bank Statement";
  if (lower.includes("map")) return "Map Printout";
  if (lower.includes("payment") || lower.includes("sms")) return "Payment Screenshot";
  if (lower.includes("purchase-order") || lower.includes("purchase_order") || lower.includes("po")) return "Purchase Order";
  if (lower.includes("invoice")) return "Tax Invoice";
  if (lower.includes("receipt")) return "Receipt";
  if (lower.includes("delivery-note") || lower.includes("delivery_note") || lower.includes("delivery note")) return "Delivery Note";
  if (lower.includes("challan")) return "Delivery Challan";
  if (lower.includes("delivery")) return "Delivery Note";
  return "Unknown";
}

function normaliseDocType(raw?: string): DocType {
  if (!raw) return "Unknown";
  const value = raw.toLowerCase();
  if (value.includes("amended purchase order")) return "Amended Purchase Order";
  if (value.includes("material test") || value.includes("test certificate") || value.includes("quality certificate") || value.includes("mill test")) return "Material Test Certificate";
  if (value.includes("driving licence") || value.includes("driving license") || value.includes("licence")) return "Driving Licence";
  if (value.includes("transport permit") || value.includes("authorisation") || value.includes("authorization") || value.includes("permit")) return "Transport Permit";
  if (value.includes("photo") || value.includes("camera") || value.includes("loading") || value.includes("unloading")) return "Photo Evidence";
  if (value.includes("tax invoice")) return "Tax Invoice";
  if (value.includes("e-way") || value.includes("eway")) return "E-Way Bill";
  if (value.includes("weighment") || value.includes("weighbridge")) return "Weighment Slip";
  if (value.includes("lorry receipt") || value.includes("transport receipt") || value.includes("consignment")) return "Lorry Receipt";
  if (value.includes("vehicle registration") || value.includes("registration certificate") || value.includes("rc book")) return "Vehicle Registration Certificate";
  if (value.includes("pan card") || value === "pan") return "PAN Card";
  if (value.includes("fastag") || value.includes("toll")) return "FASTag Toll Proof";
  if (value.includes("bank statement")) return "Bank Statement";
  if (value.includes("map")) return "Map Printout";
  if (value.includes("payment screenshot") || value.includes("payment proof") || value.includes("sms")) return "Payment Screenshot";
  if (value.includes("delivery challan") || value.includes("challan")) return "Delivery Challan";
  if (value.includes("delivery")) return "Delivery Note";
  if (value.includes("purchase order") || value === "po") return "Purchase Order";
  if (value.includes("invoice")) return "Invoice";
  if (value.includes("receipt")) return "Receipt";
  return "Unknown";
}

function normalizeVisibleEvidenceText(textPages: string[]) {
  return textPages
    .join("\n")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function refineDocTypeFromVisibleText(docType: DocType, textPages: string[]) {
  if (!textPages.some((page) => page.trim())) return docType;
  const text = normalizeVisibleEvidenceText(textPages);
  const hasDeliveryChallanSignal =
    text.includes("delivery challan") ||
    text.includes("challan no") ||
    text.includes("challan number") ||
    text.includes("challan date");
  const headingText = text.slice(0, 600);
  const hasTaxInvoiceSignal =
    headingText.includes("tax invoice") ||
    text.includes("invoice no") ||
    text.includes("invoice number");

  if (hasTaxInvoiceSignal && (docType === "Unknown" || docType === "Purchase Order" || docType === "Amended Purchase Order")) {
    return "Tax Invoice";
  }

  if (
    hasDeliveryChallanSignal &&
    !hasTaxInvoiceSignal &&
    (docType === "Purchase Order" || docType === "Amended Purchase Order" || docType === "Unknown")
  ) {
    return "Delivery Challan";
  }

  return docType;
}

function retitleDocumentForType(title: string, type: DocType) {
  const label = formatDocType(type);
  const separator = " — ";
  const separatorIndex = title.indexOf(separator);
  return separatorIndex >= 0 ? `${label}${title.slice(separatorIndex)}` : title;
}

function retitleMarkdownForType(markdown: string | undefined, type: DocType) {
  if (!markdown) return markdown;
  const label = formatDocType(type);
  return markdown.replace(/^# .+?(?=\n)/, (heading) => {
    const separator = " — ";
    const separatorIndex = heading.indexOf(separator);
    return separatorIndex >= 0 ? `# ${label}${heading.slice(separatorIndex)}` : `# ${label}`;
  });
}

function getMarkdownVisibleText(markdown: string | undefined) {
  if (!markdown) return "";
  const marker = "## Visible Text";
  const markerIndex = markdown.indexOf(marker);
  return markerIndex >= 0 ? markdown.slice(markerIndex + marker.length) : markdown;
}

function getRefinementTextPages(doc: CaseDoc, textPages: string[]) {
  const usableTextPages = textPages.filter((page) => page.trim().length > 0);
  if (usableTextPages.length) return usableTextPages;

  const visibleText = getMarkdownVisibleText(doc.md);
  return visibleText.trim() ? [visibleText] : [];
}

function isZeroAmount(value: string | number | null | undefined) {
  const parsed = parseLooseNumber(value);
  return parsed !== null && Math.abs(parsed) === 0;
}

function removePlaceholderZeroAmountsFromLine(line: CommercialLineItem) {
  const next = { ...line };
  const hasPositiveMonetarySignal = [
    next.rate,
    next.netRate,
    next.taxableAmount,
    next.taxAmount,
    next.cgstAmount,
    next.sgstAmount,
    next.igstAmount,
  ].some((value) => {
    const parsed = parseLooseNumber(value);
    return parsed !== null && Math.abs(parsed) > 0;
  });

  if (!hasPositiveMonetarySignal) {
    if (isZeroAmount(next.lineTotal)) delete next.lineTotal;
    if (isZeroAmount(next.taxableAmount)) delete next.taxableAmount;
  }

  return next;
}

function adaptFieldsForRefinedDocType(
  fields: CaseDoc["fields"],
  previousType: DocType,
  refinedType: DocType
) {
  const next = { ...fields };

  if (
    (refinedType === "Delivery Challan" || refinedType === "Delivery Note") &&
    (previousType === "Purchase Order" || previousType === "Amended Purchase Order" || previousType === "Unknown")
  ) {
    if (!next.referencePoNumber && next.poNumber) {
      next.referencePoNumber = next.poNumber;
    }
    delete next.poNumber;

    for (const key of ["subtotal", "taxAmount", "totalAmount"] as const) {
      if (isZeroAmount(next[key])) delete next[key];
    }
  }

  return next;
}

function applyVisibleDocTypeRefinement(doc: CaseDoc, textPages: string[]) {
  const refinementTextPages = getRefinementTextPages(doc, textPages);
  const refinedType = refineDocTypeFromVisibleText(doc.type, refinementTextPages);
  if (refinedType === doc.type) return doc;

  const fields = adaptFieldsForRefinedDocType(doc.fields, doc.type, refinedType);
  return {
    ...doc,
    type: refinedType,
    title: retitleDocumentForType(doc.title, refinedType),
    fields,
    lineItems: doc.lineItems?.map(removePlaceholderZeroAmountsFromLine),
    md: retitleMarkdownForType(doc.md, refinedType) ?? doc.md ?? "",
  };
}

function formatLineItemRateLabel(label: string, value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return `${label} ${trimmed.endsWith("%") ? trimmed : `${trimmed}%`}`;
}

function getLineItemTaxAmount(item: CommercialLineItem) {
  if (item.taxAmount) return item.taxAmount;
  if (item.igstAmount) return item.igstAmount;

  const cgstAmount = parseLooseNumber(item.cgstAmount);
  const sgstAmount = parseLooseNumber(item.sgstAmount);
  if (cgstAmount !== null && sgstAmount !== null) {
    return formatNumberForField(cgstAmount + sgstAmount);
  }

  return item.cgstAmount ?? item.sgstAmount ?? "";
}

function buildMarkdown(doc: CaseDoc, visibleTextPages: string[] = []) {
  const lines = [`# ${doc.title}`, "", `Source: **${doc.sourceHint ?? "uploaded"}**`, ""];
  for (const key of getAllowedFieldKeysForDocType(doc.type)) {
    const value = doc.fields[key];
    if (value) {
      if (!lines.includes("## Extracted Fields")) {
        lines.push("## Extracted Fields", "");
      }
      lines.push(`- **${FIELD_LABELS[key]}**: ${value}`);
    }
  }

  if (doc.lineItems?.length) {
    lines.push("", "## Line Items", "");
    doc.lineItems.forEach((item, index) => {
      const label = item.lineNumber ? `Line ${item.lineNumber}` : `Line ${index + 1}`;
      const taxAmount = getLineItemTaxAmount(item);
      const parts = [
        item.itemCode,
        item.description,
        item.hsnSac ? `HSN ${item.hsnSac}` : "",
        item.quantity && item.unit ? `${item.quantity} ${item.unit}` : item.quantity,
        item.rate ? `rate ${item.rate}` : "",
        item.taxableAmount ? `taxable ${item.taxableAmount}` : "",
        formatLineItemRateLabel("GST", item.taxRate),
        formatLineItemRateLabel("CGST", item.cgstRate),
        formatLineItemRateLabel("SGST", item.sgstRate),
        formatLineItemRateLabel("IGST", item.igstRate),
        taxAmount ? `tax ${taxAmount}` : "",
        item.lineTotal ? `total ${item.lineTotal}` : "",
      ].filter(Boolean);
      lines.push(`- **${label}**: ${parts.join(" | ") || item.rawText || "Extracted row"}`);
    });
  }

  const visibleText = visibleTextPages.map((text) => text.trim()).filter(Boolean);
  if (visibleText.length) {
    lines.push("", "## Visible Text", "");
    visibleText.forEach((text, index) => {
      if (visibleText.length > 1) {
        lines.push(`### Page ${index + 1}`, "");
      }
      lines.push(text, "");
    });
  }

  return lines.join("\n").trim();
}

function fallbackDoc(fileName: string, docType?: DocType, options?: { pages?: number; visibleTextPages?: string[] }) {
  const resolvedType = docType && docType !== "Unknown" ? docType : inferDocTypeFromFilename(fileName);
  const fallback: CaseDoc = {
    id: `${resolvedType.toLowerCase().replace(/[^a-z0-9]+/g, "_")}-${Date.now()}`,
    type: resolvedType,
    title: `${formatDocType(resolvedType)} — ${fileName}`,
    pages: options?.pages ?? 1,
    fields: omitIgnoredFields({}) as Partial<Record<FieldKey, string>>,
    md: "",
    sourceHint: fileName,
  };
  fallback.md = buildMarkdown(fallback, options?.visibleTextPages ?? []);
  return fallback;
}

function getFileMimeType(fileName: string, mimeType: string | null) {
  if (mimeType) return mimeType;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function bufferToDataUrl(data: Uint8Array, mimeType: string) {
  return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function normalizeImageMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  if (lower.startsWith("image/")) return lower;
  return "image/jpeg";
}

function isProviderSafeImageMimeType(mimeType: string) {
  return ["image/jpeg", "image/png", "image/webp"].includes(normalizeImageMimeType(mimeType));
}

async function compressImageForProvider(input: Buffer, label: string) {
  const dimensionSteps = [
    PROVIDER_IMAGE_MAX_DIMENSION,
    2800,
    2400,
    2000,
    1600,
    1200,
  ].filter((value, index, values) => Number.isFinite(value) && value > 0 && values.indexOf(value) === index);
  const qualitySteps = [86, 80, 74, 68, 62, 56];
  let smallest: Buffer | null = null;
  let lastError: unknown = null;

  for (const dimension of dimensionSteps) {
    for (const quality of qualitySteps) {
      try {
        const output = await sharp(input, { failOn: "none" })
          .rotate()
          .resize({
            width: dimension,
            height: dimension,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({
            quality,
            progressive: true,
            force: true,
          })
          .toBuffer();

        if (!smallest || output.byteLength < smallest.byteLength) {
          smallest = output;
        }
        if (output.byteLength <= PROVIDER_IMAGE_TARGET_BYTES) {
          return { bytes: output, mimeType: "image/jpeg" };
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (smallest && smallest.byteLength <= PROVIDER_IMAGE_HARD_LIMIT_BYTES) {
    return { bytes: smallest, mimeType: "image/jpeg" };
  }

  const reason = lastError instanceof Error ? lastError.message : "compression did not reach a safe size";
  throw new Error(
    `Unable to prepare "${label}" for analysis. Image remains above the ${formatBytes(PROVIDER_IMAGE_HARD_LIMIT_BYTES)} provider limit after compression (${reason}).`
  );
}

async function imageBytesToProviderDataUrl(data: Uint8Array, mimeType: string, label: string) {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  const input = Buffer.from(data);
  if (input.byteLength <= PROVIDER_IMAGE_TARGET_BYTES && isProviderSafeImageMimeType(normalizedMimeType)) {
    return bufferToDataUrl(input, normalizedMimeType);
  }

  try {
    const compressed = await compressImageForProvider(input, label);
    if (compressed.bytes.byteLength < input.byteLength || input.byteLength > PROVIDER_IMAGE_HARD_LIMIT_BYTES) {
      console.info(
        `[packet-processing] compressed image for provider: ${label} ${formatBytes(input.byteLength)} -> ${formatBytes(compressed.bytes.byteLength)}`
      );
    }
    return bufferToDataUrl(compressed.bytes, compressed.mimeType);
  } catch (error) {
    if (input.byteLength <= PROVIDER_IMAGE_HARD_LIMIT_BYTES && isProviderSafeImageMimeType(normalizedMimeType)) {
      console.warn(
        `[packet-processing] image compression failed for ${label}; using original ${formatBytes(input.byteLength)} image. ${error instanceof Error ? error.message : String(error ?? "")}`
      );
      return bufferToDataUrl(input, normalizedMimeType);
    }
    throw error;
  }
}

function hasMeaningfulTextPages(textPages: string[]) {
  return textPages.some((page) => page.replace(/\s+/g, "").length > 20);
}

function renderedPageNumber(fileName: string) {
  const match = fileName.match(/-(\d+)\.png$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function renderPdfToImagePages(data: Uint8Array, options?: { maxPages?: number; sourceName?: string }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "packet-pdf-"));
  const inputPath = path.join(tmpDir, "input.pdf");
  const outputPrefix = path.join(tmpDir, "page");
  const maxPages = options?.maxPages ?? PDF_RENDER_MAX_PAGES;

  try {
    fs.writeFileSync(inputPath, Buffer.from(data));
    await execFileAsync("pdftoppm", [
      "-r",
      String(PDF_RENDER_DPI),
      "-png",
      "-f",
      "1",
      "-l",
      String(maxPages),
      inputPath,
      outputPrefix,
    ]);

    const pageFileNames = fs
      .readdirSync(tmpDir)
      .filter((fileName) => fileName.startsWith("page-") && fileName.endsWith(".png"))
      .sort((left, right) => renderedPageNumber(left) - renderedPageNumber(right));

    const pageImages: string[] = [];
    for (const fileName of pageFileNames) {
      const bytes = fs.readFileSync(path.join(tmpDir, fileName));
      pageImages.push(await imageBytesToProviderDataUrl(bytes, "image/png", `${options?.sourceName ?? "PDF"} ${fileName}`));
    }

    return pageImages;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function extractPdfTextPages(data: Uint8Array) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if ("GlobalWorkerOptions" in pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  }
  const pdf = await (pdfjsLib as typeof pdfjsLib & {
    getDocument(source: Record<string, unknown>): {
      promise: Promise<{
        numPages: number;
        getPage(pageNumber: number): Promise<{
          getTextContent(): Promise<{
            items: Array<{ str?: string }>;
          }>;
        }>;
      }>;
    };
  }).getDocument({
    data,
    disableWorker: true,
  }).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(text);
  }

  return pages;
}

async function classifyDocumentFromImage(image: string, fileName = ""): Promise<DocType> {
  const inferred = inferDocTypeFromFilename(fileName);
  if (!image.startsWith("data:image/")) {
    return inferred;
  }

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content:
          `Classify procurement packet pages. Return only JSON like {"documentType":"Purchase Order"} using one of: ${SUPPORTED_DOC_TYPES.join(", ")}. ` +
          "Some pages may be handwritten/manual or mixed printed and handwritten; classify by the document layout and purpose, not only by machine-readable printed text. " +
          "If the page is headed Delivery Challan or shows Challan No/Challan Date, classify it as Delivery Challan even when it references a PO No; PO No on logistics documents is only a reference.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Classify this file: ${fileName}` },
          { type: "image_url", image_url: { url: image } },
        ],
      },
    ],
    { expectJson: true }
  );

  const parsed = safeJsonParse<{ documentType?: string }>(raw, {});
  const classified = normaliseDocType(parsed.documentType);
  return classified === "Unknown" ? inferred : classified;
}

async function classifyDocumentFromText(textPages: string[], fileName = ""): Promise<DocType> {
  const inferred = inferDocTypeFromFilename(fileName);
  const visibleText = textPages.map((page, index) => `Page ${index + 1}: ${page}`).join("\n").slice(0, 12000);

  if (!visibleText.trim()) {
    return inferred;
  }

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content:
          `Classify procurement packet text. Return only JSON like {"documentType":"Purchase Order"} using one of: ${SUPPORTED_DOC_TYPES.join(", ")}. ` +
          "The text may omit handwritten entries, so use file name hints and any visible labels when the embedded text is sparse. " +
          "If the text is headed Delivery Challan or shows Challan No/Challan Date, classify it as Delivery Challan even when it references a PO No; PO No on logistics documents is only a reference.",
      },
      {
        role: "user",
        content: `File name: ${fileName}\n\nVisible text:\n${visibleText}`,
      },
    ],
    { expectJson: true }
  );

  const parsed = safeJsonParse<{ documentType?: string }>(raw, {});
  const classified = normaliseDocType(parsed.documentType);
  return refineDocTypeFromVisibleText(classified === "Unknown" ? inferred : classified, textPages);
}

type PdfDocumentGroup = {
  documentType: DocType;
  pageStart: number;
  pageEnd: number;
  confidence?: number;
  documentNumber?: string;
  primaryPartyName?: string;
  vehicleNumber?: string;
  splitReason?: string;
};

function pageRangeLabel(group: PdfDocumentGroup) {
  return group.pageStart === group.pageEnd
    ? `page ${group.pageStart}`
    : `pages ${group.pageStart}-${group.pageEnd}`;
}

function normalizePageNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue) : NaN;
}

function normalizePdfGroupIdentity(value: unknown) {
  return toText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function readPdfGroupIdentityValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const normalized = normalizePdfGroupIdentity(record[key]);
    if (normalized) return normalized;
  }
  return undefined;
}

function hasConflictingPdfGroupIdentity(left?: string, right?: string) {
  return Boolean(left && right && left !== right);
}

function shouldMergeAdjacentPdfGroups(previous: PdfDocumentGroup, current: PdfDocumentGroup) {
  if (previous.documentType !== current.documentType || previous.pageEnd + 1 !== current.pageStart) {
    return false;
  }

  return !(
    hasConflictingPdfGroupIdentity(previous.documentNumber, current.documentNumber) ||
    hasConflictingPdfGroupIdentity(previous.primaryPartyName, current.primaryPartyName) ||
    hasConflictingPdfGroupIdentity(previous.vehicleNumber, current.vehicleNumber)
  );
}

function normalizePdfDocumentGroups(
  rawGroups: unknown,
  pageCount: number,
  fileName: string
): PdfDocumentGroup[] {
  const inferred = inferDocTypeFromFilename(fileName);
  const groups = Array.isArray(rawGroups) ? rawGroups : [];
  const parsedGroups = groups
    .map((entry): PdfDocumentGroup | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const pageValues = Array.isArray(record.pages) ? record.pages : [];
      const pageStart = normalizePageNumber(record.pageStart ?? record.startPage ?? record.fromPage ?? pageValues[0]);
      const pageEnd = normalizePageNumber(record.pageEnd ?? record.endPage ?? record.toPage ?? pageValues[1] ?? pageValues[0]);
      if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd)) return null;

      const group: PdfDocumentGroup = {
        documentType: normaliseDocType(String(record.documentType ?? record.type ?? record.docType ?? "")),
        pageStart: Math.max(1, Math.min(pageCount, pageStart)),
        pageEnd: Math.max(1, Math.min(pageCount, pageEnd)),
        documentNumber: readPdfGroupIdentityValue(record, [
          "documentNumber",
          "invoiceNumber",
          "poNumber",
          "ewayBillNumber",
          "challanNumber",
          "billNumber",
          "number",
        ]),
        primaryPartyName: readPdfGroupIdentityValue(record, [
          "primaryPartyName",
          "partyName",
          "buyerName",
          "vendorName",
          "supplierName",
          "customerName",
        ]),
        vehicleNumber: readPdfGroupIdentityValue(record, ["vehicleNumber", "lorryNumber", "truckNumber"]),
        splitReason: toText(record.splitReason ?? record.reason) || undefined,
      };

      if (typeof record.confidence === "number") {
        group.confidence = record.confidence;
      }

      return group;
    })
    .filter((entry): entry is PdfDocumentGroup => entry !== null)
    .map((entry): PdfDocumentGroup => {
      const pageStart = Math.min(entry.pageStart, entry.pageEnd);
      const pageEnd = Math.max(entry.pageStart, entry.pageEnd);
      return { ...entry, pageStart, pageEnd };
    })
    .sort((left, right) => left.pageStart - right.pageStart || left.pageEnd - right.pageEnd);

  if (pageCount <= 0) {
    return [];
  }

  if (!parsedGroups.length) {
    return [{ documentType: inferred, pageStart: 1, pageEnd: pageCount }];
  }

  const seen = new Set<string>();
  const normalized = parsedGroups.filter((group) => {
    const key = [
      group.documentType,
      group.pageStart,
      group.pageEnd,
      group.documentNumber ?? "",
      group.primaryPartyName ?? "",
      group.vehicleNumber ?? "",
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const isPageCovered = (pageNumber: number) =>
    normalized.some((group) => group.pageStart <= pageNumber && group.pageEnd >= pageNumber);

  let cursor = 1;
  while (cursor <= pageCount) {
    if (isPageCovered(cursor)) {
      cursor += 1;
      continue;
    }

    let gapEnd = cursor;
    while (gapEnd + 1 <= pageCount && !isPageCovered(gapEnd + 1)) {
      gapEnd += 1;
    }

    normalized.push({
      documentType: "Unknown",
      pageStart: cursor,
      pageEnd: gapEnd,
    });
    cursor = gapEnd + 1;
  }

  normalized.sort((left, right) => left.pageStart - right.pageStart || left.pageEnd - right.pageEnd);

  return normalized.length ? normalized : [{ documentType: inferred, pageStart: 1, pageEnd: pageCount }];
}

function isCollapsedPdfSplit(groups: PdfDocumentGroup[], pageCount: number) {
  return (
    pageCount > 1 &&
    groups.length === 1 &&
    groups[0]?.pageStart === 1 &&
    groups[0]?.pageEnd === pageCount
  );
}

function compactConsecutivePdfGroups(groups: PdfDocumentGroup[]) {
  const sorted = [...groups].sort((left, right) => left.pageStart - right.pageStart || left.pageEnd - right.pageEnd);
  const compacted: PdfDocumentGroup[] = [];

  for (const group of sorted) {
    const previous = compacted[compacted.length - 1];
    if (previous && shouldMergeAdjacentPdfGroups(previous, group)) {
      previous.pageEnd = group.pageEnd;
      previous.confidence =
        typeof previous.confidence === "number" && typeof group.confidence === "number"
          ? Math.min(previous.confidence, group.confidence)
          : previous.confidence ?? group.confidence;
      previous.documentNumber = previous.documentNumber ?? group.documentNumber;
      previous.primaryPartyName = previous.primaryPartyName ?? group.primaryPartyName;
      previous.vehicleNumber = previous.vehicleNumber ?? group.vehicleNumber;
      previous.splitReason = previous.splitReason ?? group.splitReason;
      continue;
    }

    compacted.push({ ...group });
  }

  return compacted;
}

async function splitPdfPagesIndividually(params: {
  fileName: string;
  textPages: string[];
  pageImages: string[];
  pageCount: number;
}) {
  const systemPrompt =
    `Classify one page from a procurement packet PDF. Return only JSON with a top-level "documents" array. ` +
    `Each item must contain documentType and confidence. Also include documentNumber, primaryPartyName, vehicleNumber, and splitReason when visible. ` +
    `Use only these documentType values: ${SUPPORTED_DOC_TYPES.join(", ")}. ` +
    `Use the rendered page image as the source of truth when available; use text only as supporting context. ` +
    `If this one page visibly contains multiple separate documents or cards, return multiple records. ` +
    `If a page contains a separate invoice, identify that invoice by visible invoice number and party/customer/supplier name. ` +
    `Do not infer document type from the file name when the page image/text shows a different document. ` +
    `A page headed Delivery Challan or showing Challan No/Challan Date is Delivery Challan even if it contains PO No as a reference.`;

  const pageGroups = await mapWithConcurrency(
    Array.from({ length: params.pageCount }, (_, index) => index),
    PACKET_AI_CONCURRENCY,
    async (index) => {
    const pageNumber = index + 1;
    const pageText = params.textPages[index] || "[No text extracted]";
    const pageImage = params.pageImages[index];

    const raw = pageImage
      ? await callOpenRouter(
          [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    `File name: ${params.fileName}. Classify rendered page ${pageNumber} of ${params.pageCount}.\n\n` +
                    `OCR text for this page:\n${pageText.slice(0, 8000)}`,
                },
                { type: "image_url" as const, image_url: { url: pageImage } },
              ],
            },
          ],
          {
            expectJson: true,
            model: getQualityExtractionModel(),
            reasoning: getQualityExtractionReasoning(),
          }
        )
      : await callOpenRouter(
          [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content:
                `File name: ${params.fileName}. Classify page ${pageNumber} of ${params.pageCount}.\n\n` +
                `Visible text:\n${pageText.slice(0, 12000)}`,
            },
          ],
          {
            expectJson: true,
            model: getQualityExtractionModel(),
            reasoning: getQualityExtractionReasoning(),
          }
        );

    const parsed = safeJsonParse<{ documents?: unknown }>(raw, {});
    const pageDocuments = Array.isArray(parsed.documents) ? parsed.documents : [];
    const normalizedPageGroups = normalizePdfDocumentGroups(
      pageDocuments.map((entry) =>
        entry && typeof entry === "object"
          ? {
              ...(entry as Record<string, unknown>),
              pageStart: pageNumber,
              pageEnd: pageNumber,
            }
          : entry
      ),
      params.pageCount,
      params.fileName
    )
      .map((group) => ({
        ...group,
        documentType: refineDocTypeFromVisibleText(group.documentType, [params.textPages[pageNumber - 1] ?? ""]),
      }))
      .filter((group) => group.pageStart === pageNumber && group.pageEnd === pageNumber);

      return normalizedPageGroups.length
        ? normalizedPageGroups
        : [{ documentType: "Unknown" as DocType, pageStart: pageNumber, pageEnd: pageNumber }];
    }
  );

  return compactConsecutivePdfGroups(pageGroups.flat());
}

async function splitPdfIntoDocumentGroups(params: {
  fileName: string;
  textPages: string[];
  pageImages: string[];
}) {
  const pageCount = Math.max(params.textPages.length, params.pageImages.length);
  if (pageCount <= 1) {
    return [
      {
        documentType: params.textPages.some((page) => page.trim())
          ? await classifyDocumentFromText(params.textPages, params.fileName)
          : await classifyDocumentFromImage(params.pageImages[0] ?? "", params.fileName),
        pageStart: 1,
        pageEnd: 1,
      },
    ];
  }

  const hasText = hasMeaningfulTextPages(params.textPages);
  const systemPrompt =
    `You split uploaded procurement packet PDFs into separate documents. Return only JSON with a top-level "documents" array. ` +
    `Each item must contain documentType, pageStart, pageEnd, and confidence. Also include documentNumber, primaryPartyName, vehicleNumber, and splitReason when visible. ` +
    `Use only these documentType values: ${SUPPORTED_DOC_TYPES.join(", ")}. ` +
    `Group consecutive pages belonging to the same physical/logical document. Do not merge different document types just because they are in one PDF. ` +
    `Do not merge separate documents just because they have the same documentType. Split same-type documents when invoice number, bill number, PO number, party/customer/supplier name, GSTIN, vehicle number, page numbering, letterhead, total section, or document heading resets or changes. ` +
    `A single uploaded PDF can contain two or more invoices for the same vehicle but different parties; emit each invoice as its own Invoice document with its own page range and party identity. ` +
    `If one scanned page visibly contains multiple separate cards/documents, output multiple records with the same pageStart and pageEnd. ` +
    `For example, one page may contain Vehicle Registration Certificate, Driving Licence, and PAN Card together; emit three records all pointing to that page. ` +
    `Do not invent PAN Card or Driving Licence records on later pages just because they appeared on an earlier multi-document scan. ` +
    `Pages showing camera overlays, vehicle loading/unloading photos, gate photos, or timestamped vehicle photos are Photo Evidence. ` +
    `Use PAN Card only when the page visibly contains Income Tax/Permanent Account Number/PAN card content. Use Driving Licence only when the page visibly contains a licence card. ` +
    `A page headed Delivery Challan or showing Challan No/Challan Date is Delivery Challan even if it contains PO No as a reference.`;

  const pageTextSummary = params.textPages
    .map((page, index) => `Page ${index + 1} text:\n${page || "[No text extracted]"}`)
    .join("\n\n")
    .slice(0, 30000);

  if (!params.pageImages.length && !hasText) {
    return [{ documentType: inferDocTypeFromFilename(params.fileName), pageStart: 1, pageEnd: pageCount }];
  }

  const raw = hasText
    ? await callOpenRouter(
        [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content:
              `File name: ${params.fileName}\n` +
              `There are ${params.textPages.length} pages. Identify which document is on which pages.\n\n` +
              pageTextSummary,
          },
        ],
        {
          expectJson: true,
          model: getQualityExtractionModel(),
          reasoning: getQualityExtractionReasoning(),
        }
      )
    : params.pageImages.length
    ? await callOpenRouter(
        [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `File name: ${params.fileName}. There are ${pageCount} pages. Identify which document is on which pages. ` +
                  `Use the rendered page images as the source of truth; use the OCR text only as supporting context.\n\n${pageTextSummary}`,
              },
              ...params.pageImages.flatMap((image, index) => [
                { type: "text" as const, text: `Rendered page ${index + 1}` },
                { type: "image_url" as const, image_url: { url: image } },
              ]),
            ],
          },
        ],
        {
          expectJson: true,
          model: getQualityExtractionModel(),
          reasoning: getQualityExtractionReasoning(),
        }
      )
    : await callOpenRouter(
        [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `File name: ${params.fileName}. There are ${params.pageImages.length} rendered pages. Identify which document is on which pages.`,
              },
              ...params.pageImages.flatMap((image, index) => [
                { type: "text" as const, text: `Page ${index + 1}` },
                { type: "image_url" as const, image_url: { url: image } },
              ]),
            ],
          },
        ],
        { expectJson: true }
      );

  const parsed = safeJsonParse<{ documents?: unknown; groups?: unknown }>(raw, {});
  const normalized = normalizePdfDocumentGroups(parsed.documents ?? parsed.groups, pageCount, params.fileName).map((group) => ({
    ...group,
    documentType: refineDocTypeFromVisibleText(
      group.documentType,
      params.textPages.slice(group.pageStart - 1, group.pageEnd)
    ),
  }));

  if (isCollapsedPdfSplit(normalized, pageCount)) {
    try {
      const pageLevelGroups = await splitPdfPagesIndividually({ ...params, pageCount });
      if (
        pageLevelGroups.length > 1 ||
        (pageLevelGroups.length === 1 && pageLevelGroups[0]?.documentType !== normalized[0]?.documentType)
      ) {
        return pageLevelGroups;
      }
    } catch (error) {
      console.warn("Page-level smart split fallback failed", error);
    }
  }

  return normalized;
}

async function extractPdfDocumentGroups(params: {
  fileName: string;
  textPages: string[];
  pageImages: string[];
  groups: PdfDocumentGroup[];
  onGroupProgress?: (details: { current: number; total: number; group: PdfDocumentGroup }) => Promise<void> | void;
}) {
  const hasText = hasMeaningfulTextPages(params.textPages);

  return mapWithConcurrency(params.groups, PACKET_AI_CONCURRENCY, async (group, index) => {
    await params.onGroupProgress?.({
      current: index + 1,
      total: params.groups.length,
      group,
    });

    const pageStartIndex = group.pageStart - 1;
    const pageEndIndex = group.pageEnd;
    const sourceHint = `${params.fileName} (${pageRangeLabel(group)})`;
    const groupFileName = sourceHint;
    const groupTextPages = params.textPages.slice(pageStartIndex, pageEndIndex);
    const groupPageImages = params.pageImages.slice(pageStartIndex, pageEndIndex);
    const hasGroupText = groupTextPages.some((page) => page.replace(/\s+/g, "").length > 20);

    let document =
      hasText && hasGroupText
        ? await extractDataFromTextPages({
              fileName: groupFileName,
              textPages: groupTextPages,
              documentType: group.documentType,
            })
        : groupPageImages.length
          ? await extractDataFromImagePages({
              fileName: groupFileName,
              pageImages: groupPageImages,
              documentType: group.documentType,
            })
          : fallbackDoc(groupFileName, group.documentType, {
              pages: Math.max(1, group.pageEnd - group.pageStart + 1),
              visibleTextPages: groupTextPages,
            });

    const needsQualityRetry = hasGroupText
      ? needsImageFallbackForTextExtraction(document)
      : isWeakExtraction(document);
    if (needsQualityRetry && group.documentType !== "Unknown") {
      const qualityModel = getQualityExtractionModel();
      const qualityReasoning = getQualityExtractionReasoning();
      const retryDocument =
        groupPageImages.length
          ? await extractDataFromImagePages({
              fileName: groupFileName,
              pageImages: groupPageImages,
              documentType: group.documentType,
              model: qualityModel,
              reasoning: qualityReasoning,
              qualityRetry: true,
            })
          : hasText && groupTextPages.some((page) => page.trim())
          ? await extractDataFromTextPages({
              fileName: groupFileName,
              textPages: groupTextPages,
              documentType: group.documentType,
              model: qualityModel,
              reasoning: qualityReasoning,
              qualityRetry: true,
            })
          : null;

      if (retryDocument && !isWeakExtraction(retryDocument)) {
        document = mergeExtractedDocs(retryDocument, document);
      } else if (retryDocument) {
        document = mergeExtractedDocs(document, retryDocument);
      }
    }

    document = applyVisibleDocTypeRefinement(document, groupTextPages);
    document.sourceHint = sourceHint;
    document.sourceFileName = params.fileName;
    document.pages = Math.max(1, group.pageEnd - group.pageStart + 1);
    return document;
  });
}

async function extractDataFromImagePages(params: {
  fileName: string;
  pageImages: string[];
  documentType: DocType;
  model?: string;
  reasoning?: ReturnType<typeof getQualityExtractionReasoning>;
  qualityRetry?: boolean;
}) {
  const allowedFieldKeys = getAllowedFieldKeysForDocType(params.documentType);
  const allowedFieldKeysText = allowedFieldKeys.join(", ");
  const lineItemInstruction = getLineItemExtractionInstruction(params.documentType);
  const documentSpecificInstruction = getDocumentSpecificExtractionInstruction(params.documentType);
  const qualityInstruction = params.qualityRetry
    ? "This is a quality retry because the first extraction was incomplete. Re-read the page carefully, including every visible commercial item row, handwritten/manual entries, small text, IDs, stamps, QR-adjacent text, and rotated/cropped regions. If the document has an item table, return each goods or service row in lineItems with its visible description, HSN/SAC, quantity, unit, rate, taxable amount, and tax values. Do not return empty fields when any requested value is visible. "
    : "";

  const extracted = await mapWithConcurrency(
    params.pageImages,
    PACKET_AI_CONCURRENCY,
    async (image, index) => {
    const raw = await callOpenRouter(
      [
        {
          role: "system",
          content:
            `Extract structured fields and visible text from procurement, logistics, transport, vehicle KYC, FASTag, quality certificate, and photo-evidence documents and return only JSON with keys "fields", "lineItems", and "visibleText". ` +
            `This document is a ${params.documentType}. Use only these field keys for this document type: ${allowedFieldKeysText}. ` +
            "visibleText must be a raw OCR-style transcription of the important visible text on the page. " +
            IMAGE_HANDWRITTEN_EXTRACTION_INSTRUCTION +
            AMOUNT_EXTRACTION_INSTRUCTION +
            CONSIGNEE_EXTRACTION_INSTRUCTION +
            qualityInstruction +
            documentSpecificInstruction +
            lineItemInstruction +
            STAMP_SIGNATURE_EXTRACTION_INSTRUCTION +
            "For FASTag Toll Proof documents, extract statement reference, customer ID/name, statement period/date, vehicle number, tag account number, trip count, opening/credit/debit/closing balances, recharge/payment amount, toll plaza, and a compact toll transaction summary using the canonical FASTag keys. " +
            "For seller-issued documents, vendorName is the issuing supplier/seller/consignor and buyerName is the receiving buyer, excluding non-Kalika consignee/ship-to/recipient parties. " +
            "For Purchase Order or Amended Purchase Order documents, vendorName is the supplier/vendor receiving the order and buyerName is the purchaser issuing the order.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Extract only clearly visible ${params.documentType} fields from ${params.fileName}. ` +
                "Treat printed and handwritten entries equally when they are readable.",
            },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      { expectJson: true, model: params.model, reasoning: params.reasoning }
    );

    const parsed = safeJsonParse<{ fields?: Record<string, unknown>; lineItems?: unknown; visibleText?: unknown; text?: unknown; ocrText?: unknown }>(raw, {});
      return {
      fields: parsed.fields ?? {},
      lineItems: sanitizeLineItems(parsed.lineItems).map((item) => ({ ...item, sourcePage: item.sourcePage ?? index + 1 })),
      visibleText: toText(parsed.visibleText) || toText(parsed.ocrText) || toText(parsed.text),
      };
    }
  );

  const combinedFields = extracted.reduce((acc, current) => ({ ...acc, ...current.fields }), {});
  const visibleTextPages = extracted.map((page) => page.visibleText).filter(Boolean);
  const visibleText = visibleTextPages.join("\n");
  const mappedFields = mapFields(combinedFields, params.documentType);
  const lineItems = normalizeExtractedCommercialLineItems({
    docType: params.documentType,
    lineItems: extracted.flatMap((page) => page.lineItems),
    visibleTextPages,
    documentFields: mappedFields,
  });
  const fields = applyPoNumberLabelGuard(
    applyVisibleStoreEvidenceFallback(
      applyInvoicePoReferenceFallback(
        applyPhotoEvidenceVehicleVisibilityCopy(
          applyFastagDetailsFallback(
            applyEWayBillAddressFallback(
              applyConsigneeBuyerGuard(
                applyPurchaseOrderTermsFallback(
                  applyPurchaseOrderDateFallback(
                    applyInvoiceCommercialFieldFallback(
                      mappedFields,
                      params.documentType,
                      visibleText
                    ),
                    params.documentType,
                    visibleText
                  ),
                  params.documentType,
                  visibleText
                ),
                visibleText
              ),
              params.documentType,
              visibleText
            ),
            params.documentType,
            visibleText
          ),
          params.documentType
        ),
        params.documentType,
        visibleText
      ),
      params.documentType,
      visibleText
    ),
    visibleText
  );

  let doc: CaseDoc = {
    id: `${params.fileName}-${Date.now()}`,
    type: params.documentType,
    title: `${formatDocType(params.documentType)} — ${params.fileName}`,
    pages: params.pageImages.length,
    fields,
    lineItems,
    md: "",
    sourceHint: params.fileName,
    sourceFileName: params.fileName,
  };
  doc = applyVisibleDocTypeRefinement(doc, visibleTextPages);
  doc.md = buildMarkdown(doc, visibleTextPages);
  return doc;
}

async function extractDataFromTextPages(params: {
  fileName: string;
  textPages: string[];
  documentType: DocType;
  model?: string;
  reasoning?: ReturnType<typeof getQualityExtractionReasoning>;
  qualityRetry?: boolean;
}) {
  const allowedFieldKeys = getAllowedFieldKeysForDocType(params.documentType);
  const allowedFieldKeysText = allowedFieldKeys.join(", ");
  const lineItemInstruction = getLineItemExtractionInstruction(params.documentType);
  const documentSpecificInstruction = getDocumentSpecificExtractionInstruction(params.documentType);
  const qualityInstruction = params.qualityRetry
    ? "This is a quality retry because the first extraction was incomplete. Re-read the text carefully, capture every visible commercial item row in lineItems, and do not return empty fields when any requested value is visible. "
    : "";
  const visibleText = params.textPages.map((page, index) => `Page ${index + 1}: ${page}`).join("\n\n");

  if (!visibleText.trim()) {
    return fallbackDoc(params.fileName, params.documentType, {
      pages: Math.max(1, params.textPages.length),
    });
  }

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content:
          `Extract structured fields from procurement packet text and return only JSON with keys "fields", "lineItems", and "visibleText". ` +
          `This document is a ${params.documentType}. Use only these field keys for this document type: ${allowedFieldKeysText}. ` +
          TEXT_HANDWRITTEN_EXTRACTION_INSTRUCTION +
          AMOUNT_EXTRACTION_INSTRUCTION +
          CONSIGNEE_EXTRACTION_INSTRUCTION +
          qualityInstruction +
          documentSpecificInstruction +
          lineItemInstruction +
          STAMP_SIGNATURE_EXTRACTION_INSTRUCTION +
          "Use only information present in the visible text. For seller-issued documents, vendorName is the issuing supplier and buyerName is the receiving buyer, excluding non-Kalika consignee/ship-to/recipient parties. " +
          "For Purchase Order or Amended Purchase Order documents, vendorName is the supplier/vendor receiving the order and buyerName is the purchaser issuing the order.",
      },
      {
        role: "user",
        content: `File name: ${params.fileName}\n\nVisible text:\n${visibleText.slice(0, 24000)}`,
      },
    ],
    { expectJson: true, model: params.model, reasoning: params.reasoning }
  );

  const parsed = safeJsonParse<{ fields?: Record<string, unknown>; lineItems?: unknown; visibleText?: unknown }>(raw, {});
  const mappedFields = mapFields(parsed.fields ?? {}, params.documentType);
  const fields = applyPoNumberLabelGuard(
    applyVisibleStoreEvidenceFallback(
      applyInvoicePoReferenceFallback(
        applyPhotoEvidenceVehicleVisibilityCopy(
          applyFastagDetailsFallback(
            applyEWayBillAddressFallback(
              applyConsigneeBuyerGuard(
                applyPurchaseOrderTermsFallback(
                  applyPurchaseOrderDateFallback(
                    applyInvoiceCommercialFieldFallback(
                      mappedFields,
                      params.documentType,
                      visibleText
                    ),
                    params.documentType,
                    visibleText
                  ),
                  params.documentType,
                  visibleText
                ),
                visibleText
              ),
              params.documentType,
              visibleText
            ),
            params.documentType,
            visibleText
          ),
          params.documentType
        ),
        params.documentType,
        visibleText
      ),
      params.documentType,
      visibleText
    ),
    visibleText
  );
  const visibleTextPages = params.textPages;
  const lineItems = normalizeExtractedCommercialLineItems({
    docType: params.documentType,
    lineItems: sanitizeLineItems(parsed.lineItems),
    visibleTextPages,
    documentFields: mappedFields,
  });

  let doc: CaseDoc = {
    id: `${params.fileName}-${Date.now()}`,
    type: params.documentType,
    title: `${formatDocType(params.documentType)} — ${params.fileName}`,
    pages: Math.max(1, params.textPages.length),
    fields,
    lineItems,
    md: "",
    sourceHint: params.fileName,
    sourceFileName: params.fileName,
  };
  doc = applyVisibleDocTypeRefinement(doc, params.textPages);
  doc.md = buildMarkdown(doc, params.textPages);
  return doc;
}

async function retryWeakImageExtraction(params: {
  document: CaseDoc;
  fileName: string;
  pageImages: string[];
  documentType: DocType;
}) {
  if (!params.pageImages.length || params.documentType === "Unknown" || !isWeakExtraction(params.document)) {
    return params.document;
  }

  const retryDocument = await extractDataFromImagePages({
    fileName: params.fileName,
    pageImages: params.pageImages,
    documentType: params.documentType,
    model: getQualityExtractionModel(),
    reasoning: getQualityExtractionReasoning(),
    qualityRetry: true,
  });

  return !isWeakExtraction(retryDocument)
    ? mergeExtractedDocs(retryDocument, params.document)
    : mergeExtractedDocs(params.document, retryDocument);
}

async function retryWeakPdfTextExtractionFromImages(params: {
  document: CaseDoc;
  fileName: string;
  bytes: Uint8Array;
  documentType: DocType;
}) {
  if (!needsImageFallbackForTextExtraction(params.document)) {
    return params.document;
  }

  const pageImages = await renderPdfToImagePages(params.bytes, { sourceName: params.fileName });
  if (!pageImages.length) {
    return params.document;
  }

  const imageDocumentType =
    params.documentType === "Unknown"
      ? await classifyDocumentFromImage(pageImages[0], params.fileName)
      : params.documentType;

  if (imageDocumentType === "Unknown") {
    return params.document;
  }

  const retryDocument = await extractDataFromImagePages({
    fileName: params.fileName,
    pageImages,
    documentType: imageDocumentType,
    model: getQualityExtractionModel(),
    reasoning: getQualityExtractionReasoning(),
    qualityRetry: true,
  });

  return !isWeakExtraction(retryDocument)
    ? mergeExtractedDocs(retryDocument, params.document)
    : mergeExtractedDocs(params.document, retryDocument);
}

function buildMismatchCopy(mismatch: Omit<Mismatch, "analysis" | "fixPlan">): Pick<Mismatch, "analysis" | "fixPlan"> {
  const lineItemLabels: Record<string, string> = {
    "lineItems.unmatchedDocumentLine": "Document line item",
    "lineItems.unmatchedInvoiceLine": "Invoice line item",
    "lineItems.uninvoicedPoLine": "PO line item",
    "lineItems.quantityExceeded": "Line item quantity",
    "lineItems.quantityMismatch": "Line item quantity",
    "lineItems.rateMismatch": "Line item rate",
    "lineItems.unitMismatch": "Line item unit",
    "lineItems.hsnSacMismatch": "Line item HSN/SAC",
    "lineItems.amountMismatch": "Line item amount",
  };
  const label = lineItemLabels[mismatch.field] ?? FIELD_LABELS[mismatch.field as FieldKey] ?? mismatch.field;

  if (WEIGHT_MISMATCH_FIELDS.has(mismatch.field as FieldKey)) {
    const normalizedWeights = mismatch.values
      .map((entry) => normalizeWeightForDisplay(entry.value))
      .filter((value): value is { raw: string; kg: number } => Boolean(value));

    if (normalizedWeights.length >= 2) {
      const [first, second] = normalizedWeights;
      const difference = Math.abs(first.kg - second.kg);
      return {
        analysis:
          `${label} differs after unit normalization: ${first.raw} = ${formatNumberForField(first.kg)} kg, ` +
          `${second.raw} = ${formatNumberForField(second.kg)} kg. Difference: ${formatNumberForField(difference)} kg.`,
        fixPlan:
          `1. Confirm the correct ${label.toLowerCase()} from the source document.\n` +
          "2. If one document is rounded, verify the allowed tolerance with operations.\n" +
          "3. Correct or replace the inconsistent file, then run analysis again.",
      };
    }
  }

  return {
    analysis: `${label} does not reconcile across the uploaded documents. Review the packet before approval.`,
    fixPlan: `1. Confirm the correct ${label.toLowerCase()} from the source document.\n2. Correct or replace the inconsistent file.\n3. Run analysis again before accepting the case.`,
  };
}

export function verifyProcessedDocuments(
  documents: CaseDoc[],
  comparisonOptions: ReturnType<typeof readComparisonOptions>
) {
  const verificationResult = verifyGroupedCaseDocuments(
    enrichProcessedDocuments(collapseDuplicateInvoiceCopies(documents)),
    comparisonOptions
  );
  return buildProcessedVerificationResult(verificationResult);
}

// Extracts every document from one file (image or PDF). Shared by stored-case processing and the
// extraction test endpoint so both run the same classification and extraction path.
export async function extractFileDocuments(params: {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string | null;
  analysisMode: CaseAnalysisMode;
  position?: string;
  onProgress?: (phase: number, stage: string) => Promise<void> | void;
}): Promise<CaseDoc[]> {
  const { bytes, fileName, analysisMode } = params;
  const position = params.position ?? "1 of 1";
  const mimeType = getFileMimeType(fileName, params.mimeType ?? null);

  let fileDocuments: CaseDoc[] = [];
  if (mimeType.startsWith("image/")) {
    await params.onProgress?.(0.35, `Extracting file ${position}: ${fileName}`);
    const image = await imageBytesToProviderDataUrl(bytes, mimeType, fileName);
    const documentType = await classifyDocumentFromImage(image, fileName);
    let document = await extractDataFromImagePages({
      fileName,
      pageImages: [image],
      documentType,
    });
    document = await retryWeakImageExtraction({
      document,
      fileName,
      pageImages: [image],
      documentType,
    });
    fileDocuments = [document];
  } else if (mimeType === "application/pdf") {
    const textPages = await extractPdfTextPages(bytes.slice());
    if (analysisMode === "smart_split") {
      await params.onProgress?.(0.18, `Organizing PDF ${position}: ${fileName}`);

      let pageImages: string[] = [];
      try {
        pageImages = await renderPdfToImagePages(bytes, {
          maxPages: PDF_SMART_SPLIT_MAX_PAGES,
          sourceName: fileName,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? "Unknown error");
        if (!hasMeaningfulTextPages(textPages)) {
          throw new Error(
            `Unable to render scanned PDF "${fileName}". Install poppler-utils/pdftoppm in the API runtime. ${reason}`
          );
        }
        console.warn(`Unable to render PDF "${fileName}" for smart split image fallback. Continuing with text only. ${reason}`);
      }

      const groups = await splitPdfIntoDocumentGroups({
        fileName,
        textPages,
        pageImages,
      });

      fileDocuments = await extractPdfDocumentGroups({
        fileName,
        textPages,
        pageImages,
        groups,
        onGroupProgress: async ({ current, total, group }) => {
          await params.onProgress?.(
            0.2 + (current / Math.max(1, total)) * 0.72,
            `Extracting document ${current} of ${total} from PDF ${position}: ${formatDocType(group.documentType)}`
          );
        },
      });
    } else if (hasMeaningfulTextPages(textPages)) {
      const documentType = await classifyDocumentFromText(textPages, fileName);
      let document = await extractDataFromTextPages({
        fileName,
        textPages,
        documentType,
      });
      if (needsImageFallbackForTextExtraction(document)) {
        await params.onProgress?.(0.45, `Rereading PDF images for handwritten content ${position}: ${fileName}`);

        try {
          document = await retryWeakPdfTextExtractionFromImages({
            document,
            fileName,
            bytes,
            documentType,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error ?? "Unknown error");
          console.warn(`Unable to render PDF "${fileName}" for handwritten image fallback. Continuing with text extraction. ${reason}`);
        }
      }
      fileDocuments = [document];
    } else {
      await params.onProgress?.(0.25, `Rendering scanned PDF ${position}: ${fileName}`);

      let pageImages: string[] = [];
      try {
        pageImages = await renderPdfToImagePages(bytes, { sourceName: fileName });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? "Unknown error");
        throw new Error(
          `Unable to render scanned PDF "${fileName}". Install poppler-utils/pdftoppm in the API runtime. ${reason}`
        );
      }

      if (pageImages.length === 0) {
        const document = fallbackDoc(fileName, inferDocTypeFromFilename(fileName), {
          pages: Math.max(1, textPages.length),
        });
        fileDocuments = [document];
      } else {
        const documentType = await classifyDocumentFromImage(pageImages[0], fileName);
        let document = await extractDataFromImagePages({
          fileName,
          pageImages,
          documentType,
        });
        document = await retryWeakImageExtraction({
          document,
          fileName,
          pageImages,
          documentType,
        });
        fileDocuments = [document];
      }
    }
  } else {
    fileDocuments = [fallbackDoc(fileName, inferDocTypeFromFilename(fileName))];
  }

  for (const document of fileDocuments) {
    document.sourceHint = document.sourceHint ?? fileName;
    document.sourceFileName = document.sourceFileName ?? fileName;
  }
  return fileDocuments;
}

export async function processStoredCaseFiles(params: {
  caseId: string;
  fieldConfiguration?: Awaited<ReturnType<typeof getPersistedPacketFieldConfiguration>>;
  analysisMode?: CaseAnalysisMode;
  comparisonOptions?: unknown;
  onProgress?: (details: { progress: number; stage: string }) => Promise<void> | void;
}) {
  const supabase = createSupabaseAdminClient();
  if(process.env.TEAM_ACCESS_ENFORCEMENT==='true'&&!params.fieldConfiguration) {
    throw new Error('Authorized organization field configuration is required.');
  }
  const fieldConfiguration = params.fieldConfiguration ?? await getPersistedPacketFieldConfiguration();
  const comparisonOptions = readComparisonOptions(params.comparisonOptions ?? DEFAULT_COMPARISON_OPTIONS);
  const analysisMode = params.analysisMode ?? "standard";

  const { data: files, error: filesError } = await supabase
    .from("packet_case_files")
    .select("id, original_name, storage_bucket, storage_path, mime_type")
    .eq("case_id", params.caseId)
    .order("created_at", { ascending: true });

  if (filesError) {
    throw filesError;
  }

  if (!files?.length) {
    throw new Error("No files found for this case.");
  }

  const documents: CaseDoc[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const bucket = file.storage_bucket || STORAGE_BUCKET;
    const fileProgress = (phase: number) =>
      Math.min(79, Math.max(5, Math.round(5 + ((index + phase) / files.length) * 72)));

    await params.onProgress?.({
      progress: fileProgress(0.05),
      stage: `Reading file ${index + 1} of ${files.length}: ${file.original_name}`,
    });

    const download = await supabase.storage.from(bucket).download(file.storage_path);
    if (download.error) {
      throw download.error;
    }

    const fileDocuments = await extractFileDocuments({
      bytes: new Uint8Array(await download.data.arrayBuffer()),
      fileName: file.original_name,
      mimeType: file.mime_type,
      analysisMode,
      position: `${index + 1} of ${files.length}`,
      onProgress: (phase, stage) => params.onProgress?.({ progress: fileProgress(phase), stage }),
    });
    documents.push(...fileDocuments);
  }

  return finalizeExtractedDocuments({
    documents,
    comparisonOptions,
    analysisMode,
    fieldConfiguration,
    onProgress: params.onProgress,
  });
}

// Collapses duplicate invoice copies, enriches, compares and summarizes extracted documents.
export async function finalizeExtractedDocuments(params: {
  documents: CaseDoc[];
  comparisonOptions: ReturnType<typeof readComparisonOptions>;
  analysisMode: CaseAnalysisMode;
  fieldConfiguration: Awaited<ReturnType<typeof getPersistedPacketFieldConfiguration>>;
  onProgress?: (details: { progress: number; stage: string }) => Promise<void> | void;
}) {
  const { comparisonOptions, analysisMode, fieldConfiguration } = params;
  const canonicalDocuments = collapseDuplicateInvoiceCopies(params.documents);
  const enrichedDocuments = enrichProcessedDocuments(canonicalDocuments);
  const verificationResult = buildProcessedVerificationResult(
    verifyGroupedCaseDocuments(enrichedDocuments, comparisonOptions)
  );
  await params.onProgress?.({
    progress: 80,
    stage: `Comparing ${enrichedDocuments.length} extracted documents across ${verificationResult.verificationGroups.length} packet group${verificationResult.verificationGroups.length === 1 ? "" : "s"}`,
  });

  await params.onProgress?.({ progress: 92, stage: "Finalizing case summary" });
  const summary = summarizeCase(enrichedDocuments, verificationResult.mismatches, fieldConfiguration);

  return {
    documents: enrichedDocuments,
    mismatches: verificationResult.mismatches,
    summary,
    comparisonOptions,
    analysisMode,
    fieldConfiguration,
    verificationGroups: verificationResult.verificationGroups,
  };
}

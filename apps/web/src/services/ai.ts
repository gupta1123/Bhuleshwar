import type { CaseDoc, CommercialLineItem, DocType, FieldKey, Mismatch } from "@/types/pipeline";
import { apiFetch } from "@/lib/api-client";
import {
  ACTIVE_FIELD_DEFINITIONS,
  FIELD_LABELS,
  getFieldKeysForDocType,
  omitIgnoredFields,
} from "@/lib/document-schema";
import {
  enrichDocumentsWithPacketGstTaxContext,
  isCommercialDocType,
  normalizeExtractedCommercialLineItems,
  sanitizeLineItems,
} from "@/lib/line-items";
import { DEFAULT_COMPARISON_OPTIONS, normalizeComparableValue } from "@/lib/comparison";

let aiUnavailableReason: string | null = null;
const CLIENT_MAX_RETRIES = Number(
  process.env.NEXT_PUBLIC_OPENROUTER_MAX_RETRIES ??
    process.env.NEXT_PUBLIC_GEMINI_MAX_RETRIES ??
    1
);
const CLIENT_RETRY_BASE_MS = Number(
  process.env.NEXT_PUBLIC_OPENROUTER_RETRY_BASE_MS ??
    process.env.NEXT_PUBLIC_GEMINI_RETRY_BASE_MS ??
    900
);
const PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY = "Vehicle number is not clearly visible in this image.";
const PO_NUMBER_FIELD_KEYS: FieldKey[] = ["poNumber", "referencePoNumber"];
const INDENT_LABEL_PATTERN = /\b(?:indent|ind\.?\s*no|indent\s*(?:no|number|form|ref|reference)?)\b/i;
const PURCHASE_ORDER_LABEL_PATTERN = /\b(?:(?:p\.?\s*o\.?|po|purchase\s+order)\s*(?:no|number|#)?|order\s*(?:no|number|#))\b/i;
const INTERNAL_PO_REFERENCE_PATTERN = /\b[A-Z]{1,4}\/\d{2}-\d{2}\/[A-Z0-9][A-Z0-9/-]{2,}\b/g;
const IMAGE_HANDWRITTEN_EXTRACTION_INSTRUCTION =
  "Some packet documents are handwritten/manual or mixed printed and handwritten. Treat handwritten entries as first-class visible text, not as noise. Carefully inspect handwritten numbers, dates, party names, vehicle numbers, challan/receipt/permit/certificate numbers, financial amounts, weights, quantities, table cells, stamps, and signatures. Preserve readable handwriting in visibleText. Do not infer a handwritten value from other documents, file names, or nearby labels; if a value is only partly legible, omit the structured field and keep the uncertain transcription in visibleText. ";
const AMOUNT_EXTRACTION_INSTRUCTION =
  "Copy financial amounts exactly as printed, preserving digit count and decimal placement after removing separators. Do not add or drop zeros. Cross-check quantity x rate, taxable amount + tax amount, and subtotal + tax amount before returning totals; if arithmetic conflicts with a visually uncertain amount, prefer the arithmetically consistent value visible in the row/summary. Extract visible GST/tax percentage fields as taxRate, cgstRate, sgstRate, and igstRate; do not put tax percentages into taxAmount. For invoices, separately extract freightAmount and freightGstRate; normal income-tax TDS under section 194Q as tds194qAmount and tds194qRate; goods-transport TDS as transportTdsAmount and transportTdsRate; GST withholding as cgstTdsAmount, sgstTdsAmount, igstTdsAmount, and gstTdsRate; and visible TCS and round-off as tcsAmount and roundOffAmount. Keep these deductions separate and never infer an amount that is absent. Use tdsAmount and tdsRate only when the document does not identify the TDS type. Use GSTIN state codes for GST type: same-state or state code 27 means CGST+SGST split, while different-state/non-27 means IGST. ";
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

type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
};

const SUPPORTED_DOC_TYPES: DocType[] = [
  "Purchase Order",
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

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "Unknown error");
}

function isQuotaOrRateLimitError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("quota exceeded") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("billing") ||
    message.includes("free tier") ||
    message.includes("limit: 0")
  );
}

function isRetryableProviderError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("quota exceeded") || message.includes("billing") || message.includes("limit: 0")) {
    return false;
  }
  return (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("timeout") ||
    message.includes("network")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markAiUnavailable(error: unknown) {
  aiUnavailableReason = errorMessage(error);
  console.warn(
    "OpenRouter temporarily unavailable. Falling back to local/sample mode.",
    aiUnavailableReason
  );
}

async function callOpenRouter(messages: OpenRouterMessage[], label: string, expectJson = false) {
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= CLIENT_MAX_RETRIES) {
    try {
      const response = await apiFetch("/api/ai/openrouter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          expectJson,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || `OpenRouter request failed (${response.status})`);
      }
      return String(payload?.content || "");
    } catch (error) {
      lastError = error;
      if (!isRetryableProviderError(error) || attempt === CLIENT_MAX_RETRIES) {
        throw error;
      }
      const delayMs = CLIENT_RETRY_BASE_MS * Math.pow(2, attempt);
      console.warn(
        `OpenRouter ${label} failed on attempt ${attempt + 1}. Retrying in ${delayMs}ms.`,
        errorMessage(error)
      );
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`OpenRouter ${label} failed`);
}

const ALL_ALLOWED_FIELD_KEYS = ACTIVE_FIELD_DEFINITIONS.map((field) => field.key);

const FIELD_MAPPINGS: Partial<Record<FieldKey, string[]>> = {
  vendorName: [
    "vendorName",
    "sellerName",
    "supplierName",
    "vendor",
    "seller",
    "supplier",
    "consignorName",
    "issuerName",
  ],
  supplierGstin: ["supplierGstin", "vendorGstin", "sellerGstin", "gstin", "gstinUin"],
  buyerName: [
    "buyerName",
    "customerName",
    "consigneeName",
    "buyer",
    "customer",
    "consignee",
    "billToName",
    "shipToName",
    "recipientName",
    "purchaserName",
  ],
  buyerGstin: [
    "buyerGstin",
    "customerGstin",
    "consigneeGstin",
    "shipToGstin",
    "billToGstin",
    "recipientGstin",
    "purchaserGstin",
  ],
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

function normaliseDocType(raw?: string): DocType {
  if (!raw) return "Unknown";
  const value = raw.toLowerCase();
  if (value.includes("amended") && value.includes("po")) return "Purchase Order";
  if (value.includes("material test") || value.includes("test certificate") || value.includes("quality certificate") || value.includes("mill test")) {
    return "Material Test Certificate";
  }
  if (value.includes("driving licence") || value.includes("driving license") || value.includes("licence")) {
    return "Driving Licence";
  }
  if (value.includes("transport permit") || value.includes("authorisation") || value.includes("authorization") || value.includes("permit")) {
    return "Transport Permit";
  }
  if (value.includes("photo") || value.includes("camera") || value.includes("loading") || value.includes("unloading")) {
    return "Photo Evidence";
  }
  if (value.includes("tax invoice")) return "Tax Invoice";
  if (value.includes("e-way") || value.includes("eway")) return "E-Way Bill";
  if (value.includes("weighment") || value.includes("weighbridge")) return "Weighment Slip";
  if (
    value.includes("lorry receipt") ||
    value.includes("lr copy") ||
    value.includes("transport receipt") ||
    value.includes("consignment") ||
    value.includes("transport challan")
  ) {
    return "Lorry Receipt";
  }
  if (value.includes("vehicle registration") || value.includes("registration certificate") || value.includes("rc book")) {
    return "Vehicle Registration Certificate";
  }
  if (value.includes("pan card") || value === "pan") return "PAN Card";
  if (value.includes("fastag") || value.includes("toll")) return "FASTag Toll Proof";
  if (value.includes("bank statement")) return "Bank Statement";
  if (value.includes("map") || value.includes("location print")) return "Map Printout";
  if (value.includes("payment screenshot") || value.includes("payment proof") || value.includes("sms")) {
    return "Payment Screenshot";
  }
  if (value.includes("delivery challan") || value.includes("challan")) return "Delivery Challan";
  if (value.includes("delivery")) return "Delivery Note";
  if (value.includes("purchase order") || value === "po") return "Purchase Order";
  if (value.includes("amended") && value.includes("po")) return "Purchase Order";
  if (value.includes("invoice")) return "Tax Invoice";
  if (value.includes("receipt")) return "Receipt";
  return "Unknown";
}

function inferDocTypeFromFilename(fileName: string): DocType {
  const lower = fileName.toLowerCase();
  if (lower.includes("amended") && lower.includes("po")) return "Purchase Order";
  if (lower.includes("test") || lower.includes("mtc") || lower.includes("mtr")) return "Material Test Certificate";
  if (lower.includes("licence") || lower.includes("license") || lower.includes("dl")) return "Driving Licence";
  if (lower.includes("permit") || lower.includes("authorisation") || lower.includes("authorization")) {
    return "Transport Permit";
  }
  if (lower.includes("photo") || lower.includes("camera")) return "Photo Evidence";
  if (lower.includes("tax") && lower.includes("invoice")) return "Tax Invoice";
  if (lower.includes("eway") || lower.includes("e-way")) return "E-Way Bill";
  if (lower.includes("weighment") || lower.includes("weight")) return "Weighment Slip";
  if ((lower.includes("transport") && lower.includes("challan")) || lower.includes("lorry") || lower.includes("consignment") || lower.includes("lr")) {
    return "Lorry Receipt";
  }
  if (lower.includes("rc") || lower.includes("registration")) return "Vehicle Registration Certificate";
  if (lower.includes("pan")) return "PAN Card";
  if (lower.includes("fastag") || lower.includes("toll")) return "FASTag Toll Proof";
  if (lower.includes("bank") && lower.includes("statement")) return "Bank Statement";
  if (lower.includes("map")) return "Map Printout";
  if (lower.includes("payment") || lower.includes("sms")) return "Payment Screenshot";
  if (lower.includes("purchase-order") || lower.includes("purchase_order") || lower.includes("po")) {
    return "Purchase Order";
  }
  if (lower.includes("amended") && lower.includes("po")) return "Purchase Order";
  if (lower.includes("inv no") || lower.includes(" inv.") || lower.includes("invoice")) {
    return "Tax Invoice";
  }
  if (lower.includes("receipt")) return "Receipt";
  if (lower.includes("delivery-note") || lower.includes("delivery_note") || lower.includes("delivery note")) {
    return "Delivery Note";
  }
  if (lower.includes("challan")) return "Delivery Challan";
  if (lower.includes("delivery")) return "Delivery Note";
  return "Unknown";
}

function formatDocType(docType: DocType): string {
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

function getPhotoEvidenceVehicleInstruction(docType: DocType) {
  if (docType !== "Photo Evidence") return "";
  return (
    "For Photo Evidence documents, only return vehicleNumber when the full registration plate characters are clearly readable in the image itself. " +
    `Do not infer a vehicle number from the file name, surrounding documents, or a partial/blurred/cropped plate. If the plate is not clearly visible, omit vehicleNumber and set evidenceDescription to "${PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY}" `
  );
}

function getPoNumberExtractionInstruction(docType: DocType) {
  if (docType === "Purchase Order") {
    return (
      "For Purchase Order documents, poNumber must be the value explicitly labelled PO No, P.O. No, Purchase Order No, or Order No. " +
      "Never use Indent No, Indent Number, Indent Form, requisition number, or internal indent reference as poNumber; omit poNumber if only an indent number is visible. " +
      "Extract Order Date, PO Date, P.O. Date, or Purchase Order Date as documentDate. Prefer Order Date over Party Ref Date, delivery date, or validity date. " +
      "Capture PO commercial terms from header, footer, remarks, notes, special instructions, and Terms & Conditions sections. " +
      "Extract paymentTerms, deliveryTerms, freightTerms, packingForwardingTerms, priceBasis, taxTerms, inspectionTerms, and warrantyTerms when visible. " +
      "Also fill termsAndConditions with a compact semicolon-separated summary of all visible PO clauses, preserving the original commercial meaning. Do not invent missing terms. "
    );
  }

  if (docType === "Tax Invoice" || docType === "Invoice") {
    return (
      "For invoice documents, referencePoNumber must be a value explicitly labelled PO No, P.O. No, Purchase Order No, Buyer PO, or Order No. " +
      "If the same order block contains an internal PO number shaped like IF/25-26/PF25Y-04165 or RM/25-26/PR25Y-00001 and another buyer/document reference, use the internal PO-shaped value as referencePoNumber. " +
      "For invoice documents, eWayBillNumber must be the 12-digit E-Way Bill number only. Do not use transporter document numbers, online order tracking numbers, LR numbers, acknowledgement numbers, or receipt numbers as eWayBillNumber. Do not put a 12-digit E-Way Bill number into irnNumber; IRN is the long invoice reference hash. " +
      "Never use Indent No, Indent Number, Indent Form, requisition number, or internal indent reference as referencePoNumber. "
    );
  }

  return "";
}

function getDeliveryQuantityExtractionInstruction(docType: DocType) {
  if (docType !== "Delivery Challan" && docType !== "Delivery Note") return "";

  return (
    "For Delivery Challan or Delivery Note documents, itemQuantity must be the actual goods/item quantity from a goods row. " +
    "Never set itemQuantity from Total Packages, No. of packages, boxes, cartons, bundles, bags, coils packed, packing count, or shipment count. " +
    "If only package count is visible and no actual goods quantity is shown, omit itemQuantity. "
  );
}

function getWeighmentSlipExtractionInstruction(docType: DocType) {
  if (docType !== "Weighment Slip") return "";
  return (
    "For Weighment Slip documents, prioritize vehicleNumber/lorry number, grossWeight, tareWeight, netWeight, weighmentNumber, weighbridgeName, and authorized signature presence. " +
    "Lorry No or Vehicle No on a weighment slip is the vehicleNumber, not lorryReceiptNumber. Do not use RST No, receipt number, ticket number, tare/gross/net weight, date, or charges as vehicleNumber. " +
    "Do not return weighment rows or weight tables as lineItems; keep gross, tare, and net weights in fields only. " +
    "Read Indian vehicle numbers carefully from the image; distinguish letters from similar-looking digits, especially G/9, L/1, O/0, S/5, T/7, D/G, and C/G. "
  );
}

function getLorryReceiptExtractionInstruction(docType: DocType) {
  if (docType !== "Lorry Receipt") return "";
  return (
    "For Lorry Receipt documents, prioritize lorryReceiptNumber, vehicleNumber, routeFrom, routeTo, transporterName, netWeight, and authorized signature presence. " +
    "Lorry No is the vehicleNumber. G.C. Note, LR No, Consignment No, or Transporter Doc No is lorryReceiptNumber. " +
    "Do not return package, freight, weight, amount, total, to-pay, or to-be-billed rows as lineItems; keep logistics quantities and weights in fields only. " +
    "Read Indian vehicle numbers carefully from the image; distinguish letters from similar-looking digits, especially G/9, J/S, O/0, S/5, T/7, D/G, and C/G. "
  );
}

function getEWayBillExtractionInstruction(docType: DocType) {
  if (docType !== "E-Way Bill") return "";

  return (
    "For E-Way Bill documents, vendorName is the From party name in Address Details after the first GSTIN, and buyerName is the To party name after the second GSTIN. " +
    "Do not use Dispatch From or Ship To address text as party names; those belong in dispatchFrom and shipTo. " +
    "Extract Generated Date as documentDate, Valid Upto/Valid Until as validityDate, Tot. Tax'ble Amt or Taxable Amount as totalTaxableAmount and subtotal, Total Inv. Amt as totalAmount, CGST+SGST+IGST+Cess amounts or total minus taxable amount as taxAmount, and derive taxRate from taxAmount/subtotal when the percentage is not printed. " +
    "Extract Transporter ID & Name into transporterName, Transporter Doc. No into lorryReceiptNumber, and the Part-B Vehicle/Trans number into vehicleNumber. " +
    "If Part-A shows Doc No, Document No, Invoice No, Tax Invoice No, or Delivery Challan No, extract that value as referenceInvoiceNumber unless it is the E-Way Bill No itself. "
  );
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

function cleanPoReferenceCandidate(value: string) {
  return value.replace(/[.,;:)\]]+$/, "").trim();
}

function isInternalPoReference(value?: string) {
  if (!value) return false;
  const normalized = cleanPoReferenceCandidate(value.toUpperCase());
  return new RegExp(`^${INTERNAL_PO_REFERENCE_PATTERN.source}$`).test(normalized);
}

function findBestInternalPoReference(visibleText: string) {
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

function getOrderedFieldKeysForDocument(doc: CaseDoc): FieldKey[] {
  const orderedKeys = [...getAllowedFieldKeysForDocType(doc.type)];
  const seen = new Set<FieldKey>(orderedKeys);

  for (const { key } of ACTIVE_FIELD_DEFINITIONS) {
    if (doc.fields[key] && !seen.has(key)) {
      orderedKeys.push(key);
      seen.add(key);
    }
  }

  return orderedKeys;
}

function mapFields(
  fields: Record<string, unknown>,
  docType?: DocType
): Partial<Record<FieldKey, string>> {
  const result: Partial<Record<FieldKey, string>> = {};
  const allowedFieldKeys = docType
    ? getAllowedFieldKeysForDocType(docType)
    : ALL_ALLOWED_FIELD_KEYS;

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
  return result;
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
    .filter((entry) => entry.docIds.size >= 2 || (entry.docTypes.has("E-Way Bill") && entry.score >= 5))
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

function normalizeLineItemDisplayFields(lineItems: CommercialLineItem[] | undefined) {
  if (!lineItems?.length) return lineItems;

  let changed = false;
  const normalized = lineItems.map((item) => {
    const unit = normalizeLineItemUnitForDisplay(item.unit);
    if (!unit || unit === item.unit) return item;
    changed = true;
    return { ...item, unit };
  });

  return changed ? normalized : lineItems;
}

function normalizeIdentifierDisplayFields(documents: CaseDoc[]) {
  return documents.map((doc) => {
    const fields = { ...doc.fields };
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

    const lineItems = normalizeLineItemDisplayFields(doc.lineItems);
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

function correctCommercialTotals(doc: CaseDoc) {
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
  const withInvoiceEWay = enrichInvoiceEWayBillNumbers(withEWayCore);
  const withParties = enrichEWayBillParties(withInvoiceEWay);
  const withVehicles = enrichWeighmentVehicleNumbers(withParties);
  const withConsigneeGuard = applyConsigneeBuyerGuardToDocuments(withVehicles);
  return normalizeIdentifierDisplayFields(enrichCommercialAmounts(withConsigneeGuard));
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => toText(entry))
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    return Object.values(value)
      .map((entry) => toText(entry))
      .filter(Boolean)
      .join("\n");
  }
  if (value === null || value === undefined) return "";
  return String(value).trim();
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

function buildMarkdown(doc: CaseDoc, visibleTextPages: string[] = []): string {
  const lines = [`# ${doc.title}`, "", `Source: **${doc.sourceHint ?? "uploaded"}**`, ""];
  let hasFields = false;

  for (const key of getOrderedFieldKeysForDocument(doc)) {
    const value = doc.fields[key];
    if (value) {
      if (!hasFields) {
        lines.push("## Extracted Fields", "");
        hasFields = true;
      }
      lines.push(`- **${FIELD_LABELS[key]}**: ${value}`);
    }
  }

  if (doc.lineItems?.length) {
    if (hasFields) lines.push("");
    lines.push("## Line Items", "");
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
    hasFields = true;
  }

  const visibleText = visibleTextPages.map((text) => text.trim()).filter(Boolean);
  if (visibleText.length) {
    if (hasFields) lines.push("");
    lines.push("## Visible Text", "");
    visibleText.forEach((text, index) => {
      if (visibleText.length > 1) {
        lines.push(`### Page ${index + 1}`, "");
      }
      lines.push(text);
      if (index < visibleText.length - 1) {
        lines.push("");
      }
    });
  }

  return lines.join("\n");
}

function fallbackDoc(fileName: string, docType?: DocType): CaseDoc {
  const resolvedType =
    docType && docType !== "Unknown" ? docType : inferDocTypeFromFilename(fileName);

  const fallback: CaseDoc = {
    id: `fallback_${resolvedType.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${Date.now()}`,
    type: resolvedType,
    title: `${formatDocType(resolvedType)} — ${fileName}`,
    pages: 1,
    fields: omitIgnoredFields({}) as Partial<Record<FieldKey, string>>,
    md: "",
    sourceHint: fileName,
  };
  fallback.md = buildMarkdown(fallback);
  return fallback;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    const jsonString =
      start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
    return JSON.parse(jsonString) as T;
  } catch {
    return fallback;
  }
}

export async function classifyDocumentFromImage(image: string, fileName = ""): Promise<DocType> {
  const inferred = inferDocTypeFromFilename(fileName);
  if (!image || !image.startsWith("data:image/")) {
    return inferred;
  }

  if (aiUnavailableReason) {
    return inferred;
  }

  try {
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
      "classification",
      true
    );
    const parsed = safeJsonParse<{ documentType?: string }>(raw, {});
    const classified = normaliseDocType(parsed.documentType);
    return classified === "Unknown" ? inferred : classified;
  } catch (error) {
    if (isQuotaOrRateLimitError(error)) {
      markAiUnavailable(error);
    } else {
      console.warn("Failed to classify document with OpenRouter", error);
    }
    return inferred;
  }
}

export async function extractDataFromImages(params: {
  fileName: string;
  pageImages: string[];
  documentType: DocType;
}): Promise<{ doc: CaseDoc; extractedDocuments: Array<{ documentType: DocType; fields: Record<string, unknown> }> }> {
  const { fileName, pageImages, documentType } = params;
  const allowedFieldKeys = getAllowedFieldKeysForDocType(documentType);
  const allowedFieldKeysText = allowedFieldKeys.join(", ");
  const lineItemInstruction = getLineItemExtractionInstruction(documentType);
  const photoEvidenceVehicleInstruction = getPhotoEvidenceVehicleInstruction(documentType);
  const poNumberExtractionInstruction = getPoNumberExtractionInstruction(documentType);
  const deliveryQuantityExtractionInstruction = getDeliveryQuantityExtractionInstruction(documentType);
  const weighmentSlipExtractionInstruction = getWeighmentSlipExtractionInstruction(documentType);
  const lorryReceiptExtractionInstruction = getLorryReceiptExtractionInstruction(documentType);
  const eWayBillExtractionInstruction = getEWayBillExtractionInstruction(documentType);

  if (!pageImages.length || pageImages.some((image) => !image.startsWith("data:image/"))) {
    return { doc: fallbackDoc(fileName, documentType), extractedDocuments: [] };
  }

  if (aiUnavailableReason) {
    return { doc: fallbackDoc(fileName, documentType), extractedDocuments: [] };
  }

  try {
    const extracted: Array<{ fields: Record<string, unknown>; lineItems: CommercialLineItem[]; visibleText: string }> = [];

    for (let index = 0; index < pageImages.length; index += 1) {
      const image = pageImages[index];
      const raw = await callOpenRouter(
        [
            {
              role: "system",
              content:
              `Extract structured fields and visible text from procurement, logistics, transport, vehicle KYC, FASTag, quality certificate, and photo-evidence documents and return only JSON with keys "fields", "lineItems", and "visibleText". ` +
              `This document is a ${documentType}. Use only these field keys for this document type: ${allowedFieldKeysText}. ` +
              "visibleText must be a raw OCR-style transcription of the important visible text on the page, preserving line breaks where useful. " +
              IMAGE_HANDWRITTEN_EXTRACTION_INSTRUCTION +
              AMOUNT_EXTRACTION_INSTRUCTION +
              CONSIGNEE_EXTRACTION_INSTRUCTION +
              lineItemInstruction +
              photoEvidenceVehicleInstruction +
              poNumberExtractionInstruction +
              deliveryQuantityExtractionInstruction +
              weighmentSlipExtractionInstruction +
              lorryReceiptExtractionInstruction +
              eWayBillExtractionInstruction +
              STAMP_SIGNATURE_EXTRACTION_INSTRUCTION +
              "For FASTag Toll Proof documents, extract statement reference, customer ID/name, statement period/date, vehicle number, tag account number, trip count, opening/credit/debit/closing balances, recharge/payment amount, toll plaza, and a compact toll transaction summary using the canonical FASTag keys. " +
              "For party roles on seller-issued documents, vendorName is the issuing supplier/seller/consignor and buyerName is the receiving buyer, bill-to party, customer, or purchaser. Only use ship-to/consignee/recipient as buyerName when that party is Kalika. " +
              "For Purchase Order documents, vendorName is the supplier/vendor receiving the order and buyerName is the purchaser issuing the order. Never swap these roles. " +
              "Omit any field that is not visible or not applicable to this document type. If structured fields are hard to identify, still return visibleText. Do not hallucinate.",
            },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `This upload is likely a ${documentType}. ` +
                  "Pages may include invoices, purchase orders, e-way bills, weighment slips, lorry receipts, RC/DL/PAN cards, FASTag toll proofs, test certificates, permits, or photo evidence. " +
                  `Extract only clearly visible ${documentType}-specific fields from this allowed schema: ${allowedFieldKeysText}. ` +
                  "Also transcribe the visible text into visibleText even if the structured fields object is empty. " +
                  "Treat printed and handwritten entries equally when they are readable. " +
                  "If both supplier and receiver are visible, map seller-issued documents as seller/consignor to vendorName and receiving buyer/bill-to/customer/purchaser to buyerName. Only use ship-to/consignee/recipient as buyerName when that party is Kalika. For purchase orders, map the supplier/vendor receiving the order to vendorName. " +
                  "Preserve exact document numbers, vehicle ids, GSTINs, weights, dates, and financial totals.",
              },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
        "extraction",
        true
      );

      const parsed = safeJsonParse<{
        fields?: Record<string, unknown>;
        lineItems?: unknown;
        visibleText?: unknown;
        text?: unknown;
        ocrText?: unknown;
        markdown?: unknown;
      }>(raw, {});
      extracted.push({
        fields: parsed.fields ?? {},
        lineItems: sanitizeLineItems(parsed.lineItems).map((item) => ({ ...item, sourcePage: item.sourcePage ?? index + 1 })),
        visibleText:
          toText(parsed.visibleText) ||
          toText(parsed.ocrText) ||
          toText(parsed.text) ||
          toText(parsed.markdown),
      });
    }

    const combinedFields = extracted.reduce(
      (acc, current) => ({ ...acc, ...current.fields }),
      {}
    );
    const visibleTextPages = extracted.map((page) => page.visibleText).filter(Boolean);
    const visibleText = visibleTextPages.join("\n");
    const mappedFields = mapFields(combinedFields, documentType);
    const lineItems = normalizeExtractedCommercialLineItems({
      docType: documentType,
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
                  applyPurchaseOrderDateFallback(mappedFields, documentType, visibleText),
                  visibleText
                ),
                documentType,
                visibleText
              ),
              documentType,
              visibleText
            ),
            documentType
          ),
          documentType,
          visibleText
        ),
        documentType,
        visibleText
      ),
      visibleText
    );

    const caseDoc: CaseDoc = {
      id: `${fileName}-${Date.now()}`,
      type: documentType,
      title: `${formatDocType(documentType)} — ${fileName}`,
      pages: pageImages.length,
      fields,
      lineItems,
      md: "",
      sourceHint: fileName,
    };
    caseDoc.md = buildMarkdown(caseDoc, visibleTextPages);

    return { doc: caseDoc, extractedDocuments: [] };
  } catch (error) {
    if (isQuotaOrRateLimitError(error)) {
      markAiUnavailable(error);
    } else {
      console.warn("Failed to analyze document with OpenRouter", error);
    }
    return { doc: fallbackDoc(fileName, documentType), extractedDocuments: [] };
  }
}

export async function generateMismatchAnalysis(
  mismatches: Omit<Mismatch, "analysis" | "fixPlan">[],
  documents: CaseDoc[]
): Promise<Mismatch[]> {
  if (aiUnavailableReason || mismatches.length === 0) {
    return mismatches.map((mismatch) => ({
      ...mismatch,
      analysis: aiUnavailableReason
        ? "OpenRouter quota or rate limit reached. Automated analysis was skipped for this run."
        : "Automated analysis pending. Configure OpenRouter to enable risk insights.",
      fixPlan: "Review the conflicting procurement documents and align the source records.",
    }));
  }

  const documentLookup = new Map<string, CaseDoc>(documents.map((doc) => [doc.id, doc]));

  const buildRuleBasedMismatchCopy = (mismatch: Omit<Mismatch, "analysis" | "fixPlan">) => {
    const values = mismatch.values
      .map((entry) => {
        const doc = documentLookup.get(entry.docId);
        return {
          docTitle: doc?.title ?? entry.docId,
          docType: doc?.type ?? "Document",
          value: entry.value == null ? "—" : String(entry.value),
        };
      });

    const observed = values
      .map((entry) => `${entry.docType}: ${entry.value}`)
      .join("; ");

    switch (mismatch.field) {
      case "poNumber":
        return {
          analysis:
            `PO reference mismatch detected. Observed values: ${observed}. ` +
            "If the invoice or delivery note points to a different PO than the approved purchase order, finance may hold payment, receiving may book goods against the wrong order, and audit traceability breaks.",
          fixPlan:
            `1. Confirm the approved PO number with procurement.\n` +
            `2. Update the incorrect invoice or delivery note references.\n` +
            `3. Reissue any supplier document that still references the wrong PO.\n` +
            `4. Reconcile the packet again before approval.`,
        };
      case "invoiceNumber":
        return {
          analysis:
            `Invoice reference mismatch detected. Observed values: ${observed}. ` +
            "This can break receipt-to-invoice matching, cause duplicate-payment risk, and make it unclear which bill the receipt settles.",
          fixPlan:
            `1. Verify the supplier's correct invoice number.\n` +
            `2. Correct the receipt or linked document reference.\n` +
            `3. Ensure only one invoice id is used across the packet.\n` +
            `4. Re-run the comparison before posting payment.`,
        };
      case "currency":
        return {
          analysis:
            `Currency mismatch detected. Observed values: ${observed}. ` +
            "Mixed currencies can invalidate amount comparisons, tax calculations, and settlement values. A payment could be approved in the wrong currency or converted incorrectly.",
          fixPlan:
            `1. Confirm the contractual billing currency.\n` +
            `2. Correct the document using the wrong currency code.\n` +
            `3. Recalculate totals and taxes if any document was converted incorrectly.\n` +
            `4. Only approve the packet once all documents use the same intended currency.`,
        };
      case "eWayBillNumber":
        return {
          analysis:
            `E-Way Bill mismatch detected. Observed values: ${observed}. ` +
            "If transport documents point to different e-way references, dispatch compliance and shipment traceability break. This can block movement validation and create audit issues.",
          fixPlan:
            `1. Confirm the correct e-way bill from the transport record.\n` +
            `2. Correct the invoice, challan, or logistics document carrying the wrong e-way reference.\n` +
            `3. Revalidate vehicle and shipment details against the final e-way bill.`,
        };
      case "weighmentNumber":
      case "grossWeight":
      case "tareWeight":
      case "netWeight":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Weight discrepancies typically mean the weighbridge slip, challan, and invoiced quantity are not aligned. That creates receiving disputes and billing risk.",
          fixPlan:
            `1. Confirm the weighbridge slip used for settlement.\n` +
            `2. Reconcile gross, tare, and net weights with the challan and invoice quantity.\n` +
            `3. Correct the source logistics or billing document before approval.`,
        };
      case "lorryReceiptNumber":
      case "vehicleNumber":
      case "registrationNumber":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Transport identity mismatches make it unclear which vehicle and carriage record belongs to the shipment. This weakens dispatch control and proof-of-movement.",
          fixPlan:
            `1. Confirm the actual vehicle and LR used for the shipment.\n` +
            `2. Correct the incorrect logistics document.\n` +
            `3. Ensure e-way bill, LR, weighment slip, and registration copy all reference the same vehicle.`,
        };
      case "panNumber":
      case "ownerName":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Identity inconsistencies across PAN, RC, and commercial documents can point to master-data errors or incorrect supporting paperwork.",
          fixPlan:
            `1. Confirm the legal identity detail from the source document.\n` +
            `2. Update the incorrect supporting document.\n` +
            `3. Re-run comparison after standardizing the identity fields.`,
        };
      case "transactionReference":
      case "statementAmount":
      case "transactionDate":
      case "bankName":
      case "accountNumber":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Payment-supporting documents do not reconcile cleanly. That creates settlement ambiguity and increases the risk of posting or matching the wrong payment entry.",
          fixPlan:
            `1. Confirm the bank transaction or payment proof used for settlement.\n` +
            `2. Correct the payment record or supporting screenshot.\n` +
            `3. Reconcile amount, reference, and date before marking the packet paid.`,
        };
      case "routeFrom":
      case "routeTo":
      case "mapLocation":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Route and location support documents disagree, which can weaken dispatch traceability and delivery proof.",
          fixPlan:
            `1. Confirm the actual origin, destination, and mapped delivery point.\n` +
            `2. Correct the support document carrying the wrong route/location.\n` +
            `3. Keep the packet aligned before final review.`,
        };
      case "totalAmount":
        return {
          analysis:
            `Total amount mismatch detected. Observed values: ${observed}. ` +
            "This directly affects payment accuracy. It may indicate quantity differences, tax inconsistencies, or a receipt recorded against the wrong amount.",
          fixPlan:
            `1. Compare line quantities, subtotal, and tax across PO, invoice, receipt, and delivery note.\n` +
            `2. Confirm the supplier's final billable amount.\n` +
            `3. Correct the document with the wrong total.\n` +
            `4. Reconcile payment only after the packet totals align.`,
        };
      case "taxAmount":
        return {
          analysis:
            `Tax amount mismatch detected. Observed values: ${observed}. ` +
            "GST amount differences usually mean the taxable value, tax breakup, or document basis is not aligned across the packet. That can create compliance issues and distort the final payable amount.",
          fixPlan:
            `1. Confirm the correct GST amount from the final billing document.\n` +
            `2. Reconcile taxable value and tax treatment across invoice and e-way bill.\n` +
            `3. Correct the document carrying the wrong tax amount.\n` +
            `4. Re-run the comparison before approval.`,
        };
      case "itemQuantity":
        return {
          analysis:
            `Item quantity mismatch detected. Observed values: ${observed}. ` +
            "This usually means goods receipt and billing are out of sync. Paying against a higher quantity than delivered creates overpayment risk, while a lower quantity may signal partial delivery or under-billing.",
          fixPlan:
            `1. Confirm delivered quantity with receiving or warehouse records.\n` +
            `2. Update the delivery note or invoice if one is incorrect.\n` +
            `3. If the delivery was partial, document the remaining balance clearly.\n` +
            `4. Reconcile quantity before releasing payment.`,
        };
      case "vendorName":
      case "buyerName":
        return {
          analysis:
            `${FIELD_LABELS[mismatch.field as FieldKey]} mismatch detected. Observed values: ${observed}. ` +
            "Entity-name inconsistencies create vendor master and audit issues, and can cause approval or payment to be routed to the wrong party.",
          fixPlan:
            `1. Confirm the legal entity name from the source system or master record.\n` +
            `2. Correct the inconsistent documents.\n` +
            `3. Standardize the exact naming convention used across the packet.\n` +
            `4. Re-run the comparison after correction.`,
        };
      default:
        return null;
    }
  };

  const tasks = mismatches.map(async (mismatch) => {
    const ruleBased = buildRuleBasedMismatchCopy(mismatch);
    if (ruleBased) {
      return {
        ...mismatch,
        analysis: ruleBased.analysis,
        fixPlan: ruleBased.fixPlan,
      };
    }

    const context = mismatch.values
      .map((value) => {
        const doc = documentLookup.get(value.docId);
        return `- Document: ${doc?.title ?? value.docId} (type: ${doc?.type ?? "unknown"}) -> value: "${value.value}"`;
      })
      .join("\n");

    const prompt =
      `A discrepancy was detected for the field "${mismatch.field}" in a procurement document packet.\n` +
      `${context}\n\n` +
      "Provide:\n## Analysis\nExplain only the risks specific to this field mismatch. Avoid generic boilerplate and avoid discussing unrelated controls.\n" +
      "## Fix Plan\nGive a short field-specific checklist to resolve this exact mismatch across PO, invoice, receipt, and delivery note records.";

    try {
      const markdown = await callOpenRouter(
        [{ role: "user", content: prompt }],
        "mismatch-analysis",
        false
      );

      const [analysisPart, fixPart] = markdown.split("## Fix Plan");

      return {
        ...mismatch,
        analysis: analysisPart?.replace("## Analysis", "").trim() || markdown.trim(),
        fixPlan: fixPart?.trim() ?? "Please review the documents manually to plan remediation.",
      };
    } catch (error) {
      if (isQuotaOrRateLimitError(error)) {
        markAiUnavailable(error);
      } else {
        console.warn("Failed to generate mismatch analysis with OpenRouter", error);
      }
      return {
        ...mismatch,
        analysis: "AI analysis unavailable. Please review the mismatch manually.",
        fixPlan: "Validate the source documents and correct the inconsistent procurement records.",
      };
    }
  });

  return Promise.all(tasks);
}

export function mockMismatchAnalysis(mismatches: Mismatch[]): Mismatch[] {
  return mismatches.map((mismatch) => ({
    ...mismatch,
    analysis: mismatch.analysis ?? "Automated analysis pending.",
    fixPlan: mismatch.fixPlan ?? "Review the conflicting documents manually.",
  }));
}

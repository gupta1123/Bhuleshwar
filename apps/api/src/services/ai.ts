import type { CaseDoc, DocType, FieldKey, Mismatch } from "@/types/pipeline";
import {
  ACTIVE_FIELD_DEFINITIONS,
  FIELD_LABELS,
  getFieldKeysForDocType,
  omitIgnoredFields,
} from "@/lib/document-schema";
import { applyInvoiceCommercialFieldFallback } from "@/lib/invoice-commercial-fields";

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
      const response = await fetch("/api/ai/openrouter", {
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
    "buyer",
    "customer",
    "billToName",
    "recipientName",
    "purchaserName",
  ],
  buyerGstin: [
    "buyerGstin",
    "customerGstin",
    "billToGstin",
    "recipientGstin",
    "purchaserGstin",
  ],
  shipToName: ["shipToName", "consigneeName", "shipTo", "consignee"],
  shipToGstin: ["shipToGstin", "consigneeGstin"],
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

function normaliseDocType(raw?: string): DocType {
  if (!raw) return "Unknown";
  const value = raw.toLowerCase();
  if (value.includes("amended purchase order")) return "Amended Purchase Order";
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
  if (value.includes("invoice")) return "Invoice";
  if (value.includes("receipt")) return "Receipt";
  return "Unknown";
}

function inferDocTypeFromFilename(fileName: string): DocType {
  const lower = fileName.toLowerCase();
  if (lower.includes("amended") && lower.includes("po")) return "Amended Purchase Order";
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

function getPhotoEvidenceVehicleInstruction(docType: DocType) {
  if (docType !== "Photo Evidence") return "";
  return (
    "For Photo Evidence documents, only return vehicleNumber when the full registration plate characters are clearly readable in the image itself. " +
    `Do not infer a vehicle number from the file name, surrounding documents, or a partial/blurred/cropped plate. If the plate is not clearly visible, omit vehicleNumber and set evidenceDescription to "${PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY}" `
  );
}

function getPoNumberExtractionInstruction(docType: DocType) {
  if (docType === "Purchase Order" || docType === "Amended Purchase Order") {
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
      "For invoice documents, extract the supplier invoice date as documentDate. It may be labelled Invoice Date, Date of Invoice, Date, or Dated beside the Invoice No.; return it as YYYY-MM-DD. Do not substitute Ack Date, dispatch date, LR date, e-Way Bill generated date, digitally signed timestamp, or a footer/print date. " +
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
    "Read Indian vehicle numbers carefully from the image; distinguish letters from similar-looking digits, especially G/9, L/1, O/0, S/5, T/7, D/G, and C/G. "
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
      if (normalizedValue) {
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
const HOME_GST_STATE_CODE = "27";
const DEFAULT_GST_RATE = 18;
const STANDARD_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];
type GstTaxMode = "igst" | "split" | "unknown";

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

function inferTopLevelTaxRate(fields: Partial<Record<FieldKey, string>>) {
  let taxableBase = normalizeEWayAmount(fields.subtotal);
  let taxAmount = normalizeEWayAmount(fields.taxAmount);
  const totalAmount = normalizeEWayAmount(fields.totalAmount);

  if ((taxAmount === null || taxAmount <= 0) && taxableBase !== null && totalAmount !== null && totalAmount > taxableBase) {
    taxAmount = totalAmount - taxableBase;
  }
  if ((taxableBase === null || taxableBase <= 0) && taxAmount !== null && totalAmount !== null && totalAmount > taxAmount) {
    taxableBase = totalAmount - taxAmount;
  }
  if (taxableBase === null || taxableBase <= 0 || taxAmount === null || taxAmount <= 0) {
    return null;
  }

  const rate = Math.round((taxAmount / taxableBase) * 10000) / 100;
  return rate >= 0 && rate <= 40 ? rate : null;
}

function applyGstinTaxMode(fields: Partial<Record<FieldKey, string>>) {
  const taxMode = inferTaxModeFromGstins(fields);
  if (taxMode === "unknown") return fields;

  const totalRate =
    normalizeKnownGstRate(inferTopLevelTaxRate(fields)) ??
    normalizeKnownGstRate(normalizeEWayAmount(fields.taxRate)) ??
    DEFAULT_GST_RATE;
  const next = { ...fields, taxRate: formatEWayNumberForField(totalRate) };

  if (taxMode === "split") {
    next.cgstRate = formatEWayNumberForField(totalRate / 2);
    next.sgstRate = formatEWayNumberForField(totalRate / 2);
    delete next.igstRate;
  } else {
    next.igstRate = formatEWayNumberForField(totalRate);
    delete next.cgstRate;
    delete next.sgstRate;
  }

  return next;
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
  const photoEvidenceVehicleInstruction = getPhotoEvidenceVehicleInstruction(documentType);
  const poNumberExtractionInstruction = getPoNumberExtractionInstruction(documentType);
  const deliveryQuantityExtractionInstruction = getDeliveryQuantityExtractionInstruction(documentType);
  const weighmentSlipExtractionInstruction = getWeighmentSlipExtractionInstruction(documentType);
  const eWayBillExtractionInstruction = getEWayBillExtractionInstruction(documentType);

  if (!pageImages.length || pageImages.some((image) => !image.startsWith("data:image/"))) {
    return { doc: fallbackDoc(fileName, documentType), extractedDocuments: [] };
  }

  if (aiUnavailableReason) {
    return { doc: fallbackDoc(fileName, documentType), extractedDocuments: [] };
  }

  try {
    const extracted: Array<{ fields: Record<string, unknown>; visibleText: string }> = [];

    for (const image of pageImages) {
      const raw = await callOpenRouter(
        [
            {
              role: "system",
              content:
              `Extract structured fields and visible text from procurement, logistics, transport, vehicle KYC, FASTag, quality certificate, and photo-evidence documents and return only JSON with keys "fields" and "visibleText". ` +
              `This document is a ${documentType}. Use only these field keys for this document type: ${allowedFieldKeysText}. ` +
              "visibleText must be a raw OCR-style transcription of the important visible text on the page, preserving line breaks where useful. " +
              IMAGE_HANDWRITTEN_EXTRACTION_INSTRUCTION +
              AMOUNT_EXTRACTION_INSTRUCTION +
              photoEvidenceVehicleInstruction +
              poNumberExtractionInstruction +
              deliveryQuantityExtractionInstruction +
              weighmentSlipExtractionInstruction +
              eWayBillExtractionInstruction +
              "For stamp/signature presence fields, return only Yes, No, or Unclear. Use Yes only when the mark is visibly present, No only when the relevant area is visible and clearly absent, otherwise Unclear. " +
              "For FASTag Toll Proof documents, extract statement reference, customer ID/name, statement period/date, vehicle number, tag account number, trip count, opening/credit/debit/closing balances, recharge/payment amount, toll plaza, and a compact toll transaction summary using the canonical FASTag keys. " +
              "For party roles on seller-issued documents, vendorName is the issuing supplier/seller/consignor and buyerName is strictly the billed buyer or bill-to customer. Put a different delivery recipient in shipToName and shipToGstin; never replace the billed buyer with a ship-to party or consignee. " +
              "For Purchase Order or Amended Purchase Order documents, vendorName is the supplier/vendor receiving the order and buyerName is the purchaser issuing the order. Never swap these roles. " +
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
                  "If both supplier and receiver are visible, map seller-issued documents as seller/consignor to vendorName and the billed buyer/bill-to party to buyerName. Map a different ship-to or consignee to shipToName and shipToGstin. Never substitute ship-to for buyer. For purchase orders, map the supplier/vendor receiving the order to vendorName. " +
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
        visibleText?: unknown;
        text?: unknown;
        ocrText?: unknown;
        markdown?: unknown;
      }>(raw, {});
      extracted.push({
        fields: parsed.fields ?? {},
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
  const fields = applyGstinTaxMode(
    applyPoNumberLabelGuard(
      applyInvoicePoReferenceFallback(
        applyPhotoEvidenceVehicleVisibilityCopy(
          applyFastagDetailsFallback(
            applyEWayBillAddressFallback(
              applyPurchaseOrderDateFallback(
                applyInvoiceCommercialFieldFallback(
                  mappedFields,
                  documentType,
                  visibleText
                ),
                documentType,
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
      visibleText
    )
  );

    const caseDoc: CaseDoc = {
      id: `${fileName}-${Date.now()}`,
      type: documentType,
      title: `${formatDocType(documentType)} — ${fileName}`,
      pages: pageImages.length,
      fields,
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

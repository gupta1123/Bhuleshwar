export type FieldKey =
  | "vendorName"
  | "supplierGstin"
  | "buyerName"
  | "buyerGstin"
  | "poNumber"
  | "poAmendmentNumber"
  | "invoiceNumber"
  | "receiptNumber"
  | "deliveryNoteNumber"
  | "referencePoNumber"
  | "referenceInvoiceNumber"
  | "eWayBillNumber"
  | "weighmentNumber"
  | "weighbridgeName"
  | "lorryReceiptNumber"
  | "certificateNumber"
  | "certificateDate"
  | "permitNumber"
  | "permitType"
  | "licenseNumber"
  | "chassisNumber"
  | "engineNumber"
  | "vehicleClass"
  | "documentDate"
  | "ackDate"
  | "transactionDate"
  | "validityDate"
  | "dateOfBirth"
  | "currency"
  | "subtotal"
  | "totalTaxableAmount"
  | "taxAmount"
  | "taxRate"
  | "cgstRate"
  | "sgstRate"
  | "igstRate"
  | "tdsAmount"
  | "tcsAmount"
  | "roundOffAmount"
  | "totalAmount"
  | "paymentTerms"
  | "deliveryTerms"
  | "freightTerms"
  | "packingForwardingTerms"
  | "priceBasis"
  | "taxTerms"
  | "inspectionTerms"
  | "warrantyTerms"
  | "termsAndConditions"
  | "paidAmount"
  | "statementAmount"
  | "freightAmount"
  | "advanceAmount"
  | "toPayAmount"
  | "itemDescription"
  | "materialGrade"
  | "itemQuantity"
  | "unit"
  | "hsnSac"
  | "batchNumber"
  | "heatNumber"
  | "vehicleNumber"
  | "registrationNumber"
  | "ownerName"
  | "transporterName"
  | "driverName"
  | "holderName"
  | "fatherName"
  | "panNumber"
  | "fuelType"
  | "grossWeight"
  | "tareWeight"
  | "netWeight"
  | "bankName"
  | "accountNumber"
  | "irnNumber"
  | "ackNumber"
  | "transactionReference"
  | "fastagReference"
  | "fastagStatementReference"
  | "fastagCustomerId"
  | "fastagCustomerName"
  | "statementPeriod"
  | "statementDate"
  | "openingBalance"
  | "creditAmount"
  | "debitAmount"
  | "closingBalance"
  | "tripCount"
  | "tollTransactionSummary"
  | "tollPlaza"
  | "dispatchFrom"
  | "shipTo"
  | "routeFrom"
  | "routeTo"
  | "mapLocation"
  | "photoTimestamp"
  | "evidenceDescription"
  | "hasAuthorizedSignature"
  | "hasVendorStamp"
  | "hasStoreStamp"
  | "hasStoreSignature"
  | "hasGateStamp";

export type DocType =
  | "Purchase Order"
  | "Amended Purchase Order"
  | "Invoice"
  | "Tax Invoice"
  | "Receipt"
  | "Delivery Note"
  | "Delivery Challan"
  | "E-Way Bill"
  | "Weighment Slip"
  | "Lorry Receipt"
  | "Vehicle Registration Certificate"
  | "Driving Licence"
  | "PAN Card"
  | "FASTag Toll Proof"
  | "Material Test Certificate"
  | "Photo Evidence"
  | "Transport Permit"
  | "Bank Statement"
  | "Map Printout"
  | "Payment Screenshot"
  | "Unknown";

export interface CaseDoc {
  id: string;
  type: DocType;
  title: string;
  pages: number;
  fields: Partial<Record<FieldKey, string>>;
  lineItems?: CommercialLineItem[];
  md: string;
  sourceFileName?: string;
  sourceHint?: string;
}

export interface CommercialLineItem {
  lineNumber?: string;
  itemCode?: string;
  description?: string;
  hsnSac?: string;
  quantity?: string;
  unit?: string;
  rate?: string;
  discountPercent?: string;
  netRate?: string;
  taxableAmount?: string;
  cgstRate?: string;
  cgstAmount?: string;
  sgstRate?: string;
  sgstAmount?: string;
  igstRate?: string;
  igstAmount?: string;
  taxRate?: string;
  taxAmount?: string;
  lineTotal?: string;
  referencePoLineNumber?: string;
  rawText?: string;
  sourcePage?: number;
}

export type PipelineStageId =
  | "upload_received"
  | "classifying"
  | "ocr"
  | "extracting"
  | "validating"
  | "complete"
  | "failed";

export type PipelineStageStatus = "pending" | "active" | "done" | "complete" | "error";

export interface PipelineStageProgress {
  stage: PipelineStageId;
  status: PipelineStageStatus;
  message?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface QueuedUpload {
  id: string;
  name: string;
  file?: File;
  files?: File[];
  source?: "file" | "gallery" | "camera_scan";
  stages: PipelineStageProgress[];
  classifiedType?: DocType;
  resultDoc?: CaseDoc;
  error?: string;
}

export interface ExtractedDocument {
  id: string;
  fileName: string;
  pageNumber: number;
  documentType: DocType | "Processing Error";
  fields: Record<string, unknown>;
  imageUrl?: string;
}

export interface MismatchValue {
  value: string | number | null | undefined;
  docId: string;
}

export interface Mismatch {
  id: string;
  field: string;
  values: MismatchValue[];
  analysis?: string;
  fixPlan?: string;
}

export interface ComparisonOptions {
  considerFormatting: boolean;
}

export type ProcessingStep =
  | "idle"
  | "reading_files"
  | "ocr_extraction"
  | "cross_verification"
  | "risk_analysis"
  | "complete"
  | "error";

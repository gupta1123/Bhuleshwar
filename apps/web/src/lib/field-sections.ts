export type FieldSectionKey =
  | "REFERENCE"
  | "PARTIES"
  | "MATERIAL"
  | "VEHICLE"
  | "CHECKS"
  | "FINANCIALS"
  | "DATES"
  | "OTHER";

export const FIELD_SECTION_MAP: Record<string, FieldSectionKey> = {
  // REFERENCE
  deliveryNoteNumber: "REFERENCE",
  poNumber: "REFERENCE",
  poAmendmentNumber: "REFERENCE",
  invoiceNumber: "REFERENCE",
  receiptNumber: "REFERENCE",
  referencePoNumber: "REFERENCE",
  referenceInvoiceNumber: "REFERENCE",
  eWayBillNumber: "REFERENCE",
  weighmentNumber: "REFERENCE",
  lorryReceiptNumber: "REFERENCE",
  certificateNumber: "REFERENCE",
  permitNumber: "REFERENCE",
  permitType: "REFERENCE",
  irnNumber: "REFERENCE",
  ackNumber: "REFERENCE",
  transactionReference: "REFERENCE",
  fastagReference: "REFERENCE",
  fastagStatementReference: "REFERENCE",
  fastagCustomerId: "REFERENCE",
  batchNumber: "REFERENCE",
  heatNumber: "REFERENCE",

  // PARTIES
  vendorName: "PARTIES",
  supplierGstin: "PARTIES",
  buyerName: "PARTIES",
  buyerGstin: "PARTIES",
  shipToName: "PARTIES",
  shipToGstin: "PARTIES",
  transporterName: "PARTIES",
  ownerName: "PARTIES",
  driverName: "PARTIES",
  holderName: "PARTIES",
  fatherName: "PARTIES",
  panNumber: "PARTIES",
  licenseNumber: "PARTIES",
  fastagCustomerName: "PARTIES",
  bankName: "PARTIES",
  accountNumber: "PARTIES",

  // MATERIAL
  itemDescription: "MATERIAL",
  itemQuantity: "MATERIAL",
  unit: "MATERIAL",
  materialGrade: "MATERIAL",
  hsnSac: "MATERIAL",
  grossWeight: "MATERIAL",
  tareWeight: "MATERIAL",
  netWeight: "MATERIAL",

  // VEHICLE
  vehicleNumber: "VEHICLE",
  registrationNumber: "VEHICLE",
  chassisNumber: "VEHICLE",
  engineNumber: "VEHICLE",
  vehicleClass: "VEHICLE",
  fuelType: "VEHICLE",
  routeFrom: "VEHICLE",
  routeTo: "VEHICLE",
  dispatchFrom: "VEHICLE",
  shipTo: "VEHICLE",
  weighbridgeName: "VEHICLE",
  mapLocation: "VEHICLE",
  tollPlaza: "VEHICLE",
  tripCount: "VEHICLE",
  tollTransactionSummary: "VEHICLE",

  // CHECKS
  hasAuthorizedSignature: "CHECKS",
  hasVendorStamp: "CHECKS",
  hasStoreStamp: "CHECKS",
  hasStoreSignature: "CHECKS",
  hasGateStamp: "CHECKS",

  // FINANCIALS
  currency: "FINANCIALS",
  subtotal: "FINANCIALS",
  totalTaxableAmount: "FINANCIALS",
  taxAmount: "FINANCIALS",
  taxRate: "FINANCIALS",
  cgstRate: "FINANCIALS",
  sgstRate: "FINANCIALS",
  igstRate: "FINANCIALS",
  tdsAmount: "FINANCIALS",
  tdsRate: "FINANCIALS",
  tds194qAmount: "FINANCIALS",
  tds194qRate: "FINANCIALS",
  transportTdsAmount: "FINANCIALS",
  transportTdsRate: "FINANCIALS",
  cgstTdsAmount: "FINANCIALS",
  sgstTdsAmount: "FINANCIALS",
  igstTdsAmount: "FINANCIALS",
  gstTdsRate: "FINANCIALS",
  tcsAmount: "FINANCIALS",
  roundOffAmount: "FINANCIALS",
  totalAmount: "FINANCIALS",
  paymentTerms: "FINANCIALS",
  deliveryTerms: "FINANCIALS",
  freightTerms: "FINANCIALS",
  packingForwardingTerms: "FINANCIALS",
  priceBasis: "FINANCIALS",
  taxTerms: "FINANCIALS",
  paidAmount: "FINANCIALS",
  statementAmount: "FINANCIALS",
  freightAmount: "FINANCIALS",
  freightGstRate: "FINANCIALS",
  advanceAmount: "FINANCIALS",
  toPayAmount: "FINANCIALS",
  openingBalance: "FINANCIALS",
  creditAmount: "FINANCIALS",
  debitAmount: "FINANCIALS",
  closingBalance: "FINANCIALS",

  // DATES
  documentDate: "DATES",
  ackDate: "DATES",
  transactionDate: "DATES",
  validityDate: "DATES",
  certificateDate: "DATES",
  dateOfBirth: "DATES",
  statementPeriod: "DATES",
  statementDate: "DATES",
  photoTimestamp: "DATES",
};

export const FIELD_SECTION_ORDER: FieldSectionKey[] = [
  "REFERENCE",
  "PARTIES",
  "MATERIAL",
  "VEHICLE",
  "CHECKS",
  "FINANCIALS",
  "DATES",
  "OTHER",
];

export function getFieldSection(fieldKey: string): FieldSectionKey {
  return FIELD_SECTION_MAP[fieldKey] || "OTHER";
}

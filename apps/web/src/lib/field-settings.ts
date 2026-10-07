import type { DocType, FieldKey } from "@/types/pipeline";

export type FieldConfig = {
  fieldKey: FieldKey;
  label: string;
  enabled: boolean;
  category: "identity" | "financial" | "transport" | "reference" | "quantity" | "party" | "terms";
};

export type DocumentTypeConfig = {
  docType: DocType;
  label: string;
  icon: string;
  enabled: boolean;
  fields: FieldConfig[];
};

export const FIELD_CATEGORIES: Record<string, string> = {
  identity: "Identity & License",
  financial: "Financial & Amount",
  transport: "Transport & Vehicle",
  reference: "Reference Numbers",
  quantity: "Quantity & Weight",
  party: "Party Details",
  terms: "Terms & Conditions",
};

export function getFieldCategory(fieldKey: FieldKey): string {
  if (["licenseNumber", "registrationNumber", "chassisNumber", "engineNumber", "vehicleClass", "fuelType", "ownerName", "driverName", "holderName", "fatherName", "panNumber"].includes(fieldKey)) {
    return "identity";
  }
  if (["totalAmount", "subtotal", "totalTaxableAmount", "taxAmount", "paidAmount", "statementAmount", "freightAmount", "advanceAmount", "toPayAmount", "currency", "openingBalance", "creditAmount", "debitAmount", "closingBalance"].includes(fieldKey)) {
    return "financial";
  }
  if (["vehicleNumber", "lorryReceiptNumber", "eWayBillNumber", "weighmentNumber", "weighbridgeName", "fastagReference", "tollPlaza", "tollTransactionSummary", "tripCount", "transporterName"].includes(fieldKey)) {
    return "transport";
  }
  if (["poNumber", "poAmendmentNumber", "invoiceNumber", "receiptNumber", "deliveryNoteNumber", "referencePoNumber", "referenceInvoiceNumber", "irnNumber", "ackNumber", "certificateNumber", "permitNumber", "fastagStatementReference", "fastagCustomerId", "statementPeriod", "statementDate"].includes(fieldKey)) {
    return "reference";
  }
  if (["grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit", "materialGrade", "batchNumber", "heatNumber", "hsnSac"].includes(fieldKey)) {
    return "quantity";
  }
  if (["vendorName", "supplierGstin", "buyerName", "buyerGstin", "fastagCustomerName", "dispatchFrom", "shipTo", "routeFrom", "routeTo", "mapLocation"].includes(fieldKey)) {
    return "party";
  }
  if (["paymentTerms", "deliveryTerms", "freightTerms", "packingForwardingTerms", "priceBasis", "taxTerms", "inspectionTerms", "warrantyTerms", "termsAndConditions"].includes(fieldKey)) {
    return "terms";
  }
  return "reference";
}

export const DOC_TYPE_INFO: Record<DocType, { label: string; icon: string }> = {
  "Purchase Order": { label: "Purchase Order", icon: "FileText" },
  "Amended Purchase Order": { label: "Amended PO", icon: "FileEdit" },
  Invoice: { label: "Invoice", icon: "Receipt" },
  "Tax Invoice": { label: "Tax Invoice", icon: "Receipt" },
  Receipt: { label: "Receipt", icon: "CreditCard" },
  "Delivery Note": { label: "Delivery Note", icon: "Package" },
  "Delivery Challan": { label: "Delivery Challan", icon: "Truck" },
  "E-Way Bill": { label: "E-Way Bill", icon: "Route" },
  "Weighment Slip": { label: "Weighment Slip", icon: "Scale" },
  "Lorry Receipt": { label: "Lorry Receipt", icon: "Truck" },
  "Vehicle Registration Certificate": { label: "RC", icon: "Car" },
  "Driving Licence": { label: "Driving Licence", icon: "IdCard" },
  "PAN Card": { label: "PAN Card", icon: "IdCard" },
  "FASTag Toll Proof": { label: "FASTag", icon: "CreditCard" },
  "Material Test Certificate": { label: "Test Certificate", icon: "Award" },
  "Photo Evidence": { label: "Photo", icon: "Camera" },
  "Transport Permit": { label: "Permit", icon: "FileCheck" },
  "Bank Statement": { label: "Bank Statement", icon: "Building" },
  "Map Printout": { label: "Map", icon: "MapPin" },
  "Payment Screenshot": { label: "Payment", icon: "Smartphone" },
  Unknown: { label: "Unknown", icon: "File" },
};

export function buildDefaultFieldConfigs(
  docType: DocType,
  extractedFields: FieldKey[]
): FieldConfig[] {
  const info = DOC_TYPE_INFO[docType] || { label: docType, icon: "File" };
  
  return extractedFields.map((fieldKey) => ({
    fieldKey,
    label: fieldKey.replace(/([A-Z])/g, " $1").replace(/^./, (str) => str.toUpperCase()),
    enabled: true,
    category: getFieldCategory(fieldKey) as FieldConfig["category"],
  }));
}

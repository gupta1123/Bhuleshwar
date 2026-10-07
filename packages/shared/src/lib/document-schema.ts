import type { DocType, FieldKey } from '@/types/pipeline';

export type FieldDefinition = {
  key: FieldKey;
  label: string;
  important?: boolean;
};

export const FIELD_DEFINITIONS: FieldDefinition[] = [
  { key: 'poNumber', label: 'PO Number', important: true },
  { key: 'poAmendmentNumber', label: 'PO Amendment Number' },
  { key: 'invoiceNumber', label: 'Invoice Number', important: true },
  { key: 'receiptNumber', label: 'Receipt Number' },
  { key: 'deliveryNoteNumber', label: 'Delivery Note Number' },
  { key: 'referencePoNumber', label: 'Reference PO Number' },
  { key: 'referenceInvoiceNumber', label: 'Reference Invoice Number' },
  { key: 'eWayBillNumber', label: 'E-Way Bill Number', important: true },
  { key: 'weighmentNumber', label: 'Weighment Number', important: true },
  { key: 'weighbridgeName', label: 'Weighbridge Name' },
  { key: 'lorryReceiptNumber', label: 'Lorry Receipt Number', important: true },
  { key: 'certificateNumber', label: 'Certificate Number' },
  { key: 'certificateDate', label: 'Certificate Date' },
  { key: 'permitNumber', label: 'Permit Number' },
  { key: 'permitType', label: 'Permit Type' },
  { key: 'licenseNumber', label: 'Driving Licence Number' },
  { key: 'registrationNumber', label: 'Registration Number' },
  { key: 'chassisNumber', label: 'Chassis Number' },
  { key: 'engineNumber', label: 'Engine Number' },
  { key: 'vehicleClass', label: 'Vehicle Class' },
  { key: 'vehicleNumber', label: 'Vehicle Number', important: true },
  { key: 'fuelType', label: 'Fuel Type' },
  { key: 'vendorName', label: 'Vendor Name', important: true },
  { key: 'supplierGstin', label: 'Supplier GSTIN' },
  { key: 'buyerName', label: 'Buyer Name' },
  { key: 'buyerGstin', label: 'Buyer GSTIN' },
  { key: 'transporterName', label: 'Transporter Name' },
  { key: 'ownerName', label: 'Owner Name' },
  { key: 'driverName', label: 'Driver Name' },
  { key: 'holderName', label: 'Document Holder Name' },
  { key: 'fatherName', label: 'Father Name' },
  { key: 'panNumber', label: 'PAN Number' },
  { key: 'documentDate', label: 'Document Date' },
  { key: 'ackDate', label: 'Acknowledgement Date' },
  { key: 'transactionDate', label: 'Transaction Date' },
  { key: 'validityDate', label: 'Validity Date' },
  { key: 'dateOfBirth', label: 'Date of Birth' },
  { key: 'currency', label: 'Currency' },
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'totalTaxableAmount', label: 'Total Taxable Amount' },
  { key: 'taxAmount', label: 'Tax Amount' },
  { key: 'taxRate', label: 'GST Rate %' },
  { key: 'cgstRate', label: 'CGST Rate %' },
  { key: 'sgstRate', label: 'SGST Rate %' },
  { key: 'igstRate', label: 'IGST Rate %' },
  { key: 'tdsAmount', label: 'TDS Amount' },
  { key: 'tcsAmount', label: 'TCS Amount' },
  { key: 'roundOffAmount', label: 'Round-off Amount' },
  { key: 'totalAmount', label: 'Total Amount', important: true },
  { key: 'paymentTerms', label: 'Payment Terms' },
  { key: 'deliveryTerms', label: 'Delivery Terms' },
  { key: 'freightTerms', label: 'Freight / Transport Terms' },
  { key: 'packingForwardingTerms', label: 'Packing / Forwarding Terms' },
  { key: 'priceBasis', label: 'Price Basis' },
  { key: 'taxTerms', label: 'Tax / GST Terms' },
  { key: 'inspectionTerms', label: 'Inspection / Quality Terms' },
  { key: 'warrantyTerms', label: 'Warranty / Guarantee Terms' },
  { key: 'termsAndConditions', label: 'Terms and Conditions' },
  { key: 'paidAmount', label: 'Paid Amount' },
  { key: 'statementAmount', label: 'Statement Amount' },
  { key: 'freightAmount', label: 'Freight Amount' },
  { key: 'advanceAmount', label: 'Advance Amount' },
  { key: 'toPayAmount', label: 'To-Pay Amount' },
  { key: 'itemDescription', label: 'Item Description' },
  { key: 'materialGrade', label: 'Material Grade' },
  { key: 'itemQuantity', label: 'Item Quantity', important: true },
  { key: 'unit', label: 'Unit' },
  { key: 'hsnSac', label: 'HSN / SAC' },
  { key: 'batchNumber', label: 'Batch Number' },
  { key: 'heatNumber', label: 'Heat Number' },
  { key: 'grossWeight', label: 'Gross Weight' },
  { key: 'tareWeight', label: 'Tare Weight' },
  { key: 'netWeight', label: 'Net Weight', important: true },
  { key: 'bankName', label: 'Bank Name' },
  { key: 'accountNumber', label: 'Account Number' },
  { key: 'irnNumber', label: 'IRN Number' },
  { key: 'ackNumber', label: 'Acknowledgement Number' },
  { key: 'transactionReference', label: 'Transaction Reference' },
  { key: 'fastagReference', label: 'FASTag Reference' },
  { key: 'fastagStatementReference', label: 'FASTag Statement Reference' },
  { key: 'fastagCustomerId', label: 'FASTag Customer ID' },
  { key: 'fastagCustomerName', label: 'FASTag Customer Name' },
  { key: 'statementPeriod', label: 'Statement Period' },
  { key: 'statementDate', label: 'Statement Date' },
  { key: 'openingBalance', label: 'Opening Balance' },
  { key: 'creditAmount', label: 'Credit Amount' },
  { key: 'debitAmount', label: 'Debit Amount' },
  { key: 'closingBalance', label: 'Closing Balance' },
  { key: 'tripCount', label: 'Trip Count' },
  { key: 'tollTransactionSummary', label: 'Toll Transaction Summary' },
  { key: 'tollPlaza', label: 'Toll Plaza' },
  { key: 'dispatchFrom', label: 'Dispatch From Address' },
  { key: 'shipTo', label: 'Ship To Address' },
  { key: 'routeFrom', label: 'Route From' },
  { key: 'routeTo', label: 'Route To' },
  { key: 'mapLocation', label: 'Address / Location' },
  { key: 'photoTimestamp', label: 'Photo Timestamp' },
  { key: 'evidenceDescription', label: 'Evidence Description' },
  { key: 'hasAuthorizedSignature', label: 'Authorized Signature Present' },
  { key: 'hasVendorStamp', label: 'Vendor Stamp Present' },
  { key: 'hasStoreStamp', label: 'Store Stamp Present' },
  { key: 'hasStoreSignature', label: 'Store Signature Present' },
  { key: 'hasGateStamp', label: 'Gate Stamp Present' },
];

export const IGNORED_PACKET_FIELD_KEYS: readonly FieldKey[] = [
  'certificateDate',
  'documentDate',
  'ackDate',
  'transactionDate',
  'validityDate',
  'dateOfBirth',
  'itemDescription',
  'photoTimestamp',
];

const IGNORED_PACKET_FIELD_KEY_SET = new Set<FieldKey>(IGNORED_PACKET_FIELD_KEYS);
const REMOVED_PACKET_FIELD_KEY_SET = new Set(["materialDescription"]);
const DOC_TYPE_IGNORED_FIELD_EXCEPTIONS: Partial<Record<DocType, readonly FieldKey[]>> = {
  Invoice: ['documentDate'],
  'Tax Invoice': ['documentDate', 'ackDate'],
  'Delivery Note': ['documentDate'],
  'Delivery Challan': ['documentDate'],
  'E-Way Bill': ['documentDate', 'validityDate'],
  'Lorry Receipt': ['documentDate'],
  'Weighment Slip': ['documentDate'],
};

export type PacketFieldConfiguration = {
  enabledFields: Set<string> | null;
  configuredFieldDocTypes: Set<string>;
  enabledDocTypes: Set<string> | null;
  configuredDocTypes: Set<string>;
};

function createDefaultPacketFieldConfiguration(): PacketFieldConfiguration {
  return {
    enabledFields: null,
    configuredFieldDocTypes: new Set(),
    enabledDocTypes: null,
    configuredDocTypes: new Set(),
  };
}

let runtimePacketFieldConfiguration = createDefaultPacketFieldConfiguration();

function resolvePacketFieldConfiguration(configuration?: PacketFieldConfiguration) {
  return configuration ?? runtimePacketFieldConfiguration;
}

export function buildPacketFieldConfiguration(params?: {
  fieldSettings?: Array<{ doc_type: string; field_key: string; enabled: boolean }>;
  docTypeSettings?: Array<{ doc_type: string; enabled: boolean }>;
}): PacketFieldConfiguration {
  const fieldSettings = params?.fieldSettings ?? [];
  const docTypeSettings = params?.docTypeSettings ?? [];

  const configuredFieldDocTypes = new Set(fieldSettings.map((setting) => setting.doc_type));
  const configuredDocTypes = new Set(docTypeSettings.map((setting) => setting.doc_type));

  return {
    enabledFields:
      fieldSettings.length > 0
        ? new Set(
            fieldSettings
              .filter((setting) => setting.enabled)
              .map((setting) => `${setting.doc_type}:${setting.field_key}`)
          )
        : null,
    configuredFieldDocTypes,
    enabledDocTypes:
      docTypeSettings.length > 0
        ? new Set(docTypeSettings.filter((setting) => setting.enabled).map((setting) => setting.doc_type))
        : null,
    configuredDocTypes,
  };
}

export function setPacketFieldConfiguration(configuration: PacketFieldConfiguration | null) {
  runtimePacketFieldConfiguration = configuration ?? createDefaultPacketFieldConfiguration();
}

export function setEnabledFields(fields: Set<string>) {
  runtimePacketFieldConfiguration = {
    ...runtimePacketFieldConfiguration,
    enabledFields: fields,
    configuredFieldDocTypes: new Set(
      Array.from(fields)
        .map((value) => value.split(":")[0])
        .filter(Boolean)
    ),
  };
}

export function getEnabledFields(): Set<string> | null {
  return runtimePacketFieldConfiguration.enabledFields;
}

export function resetEnabledFields() {
  runtimePacketFieldConfiguration = createDefaultPacketFieldConfiguration();
}

export function isDocTypeEnabled(
  docType: string,
  configuration?: PacketFieldConfiguration
) {
  const resolvedConfiguration = resolvePacketFieldConfiguration(configuration);

  if (
    resolvedConfiguration.enabledDocTypes === null ||
    !resolvedConfiguration.configuredDocTypes.has(docType)
  ) {
    return true;
  }

  return resolvedConfiguration.enabledDocTypes.has(docType);
}

export function shouldConsiderFieldKey(
  fieldKey: string,
  docType?: string,
  configuration?: PacketFieldConfiguration
): fieldKey is FieldKey {
  if (REMOVED_PACKET_FIELD_KEY_SET.has(fieldKey)) {
    return false;
  }
  const isDocTypeException =
    docType &&
    DOC_TYPE_IGNORED_FIELD_EXCEPTIONS[docType as DocType]?.includes(fieldKey as FieldKey);
  if (IGNORED_PACKET_FIELD_KEY_SET.has(fieldKey as FieldKey) && !isDocTypeException) {
    return false;
  }
  const resolvedConfiguration = resolvePacketFieldConfiguration(configuration);
  if (docType && !isDocTypeEnabled(docType, resolvedConfiguration)) {
    return false;
  }
  if (resolvedConfiguration.enabledFields === null) {
    return true;
  }
  if (!docType) {
    return true;
  }
  if (!resolvedConfiguration.configuredFieldDocTypes.has(docType)) {
    return true;
  }
  return resolvedConfiguration.enabledFields.has(`${docType}:${fieldKey}`);
}

export const ACTIVE_FIELD_DEFINITIONS = FIELD_DEFINITIONS.filter(({ key }) =>
  shouldConsiderFieldKey(key)
);

export function omitIgnoredFields<T>(fields: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => shouldConsiderFieldKey(key))
  ) as Record<string, T>;
}

const FIELD_DEFINITION_LOOKUP = FIELD_DEFINITIONS.reduce(
  (acc, field) => {
    acc[field.key] = field;
    return acc;
  },
  {} as Record<FieldKey, FieldDefinition>
);

export const FIELD_LABELS: Record<FieldKey, string> = FIELD_DEFINITIONS.reduce(
  (acc, field) => {
    acc[field.key] = field.label;
    return acc;
  },
  {} as Record<FieldKey, string>
);

export const CORE_PACKET_GROUPS: Array<{ label: string; types: DocType[] }> = [
  {
    label: 'Purchase Order',
    types: ['Purchase Order', 'Amended Purchase Order'],
  },
  {
    label: 'Invoice',
    types: ['Invoice', 'Tax Invoice'],
  },
  {
    label: 'E-Way Bill',
    types: ['E-Way Bill'],
  },
  {
    label: 'Transport Document',
    types: ['Lorry Receipt', 'Delivery Challan', 'Transport Permit'],
  },
  {
    label: 'Weight Proof',
    types: ['Weighment Slip'],
  },
];

export function getEnabledCorePacketGroups(configuration?: PacketFieldConfiguration) {
  const resolvedConfiguration = resolvePacketFieldConfiguration(configuration);

  return CORE_PACKET_GROUPS
    .map((group) => ({
      ...group,
      types: group.types.filter((type) => isDocTypeEnabled(type, resolvedConfiguration)),
    }))
    .filter((group) => group.types.length > 0);
}

export const DOC_TYPE_EXTRACTION_FIELDS: Record<DocType, FieldKey[]> = {
  'Purchase Order': [
    'vendorName',
    'supplierGstin',
    'buyerName',
    'buyerGstin',
    'poNumber',
    'documentDate',
    'currency',
    'itemDescription',
    
    'itemQuantity',
    'unit',
    'hsnSac',
    'subtotal',
    'taxAmount',
    'totalAmount',
    'paymentTerms',
    'deliveryTerms',
    'freightTerms',
    'packingForwardingTerms',
    'priceBasis',
    'taxTerms',
    'inspectionTerms',
    'warrantyTerms',
    'termsAndConditions',
    'hasAuthorizedSignature',
  ],
  'Amended Purchase Order': [
    'vendorName',
    'supplierGstin',
    'buyerName',
    'buyerGstin',
    'poNumber',
    'poAmendmentNumber',
    'documentDate',
    'currency',
    'itemDescription',
    
    'itemQuantity',
    'unit',
    'hsnSac',
    'subtotal',
    'taxAmount',
    'totalAmount',
    'paymentTerms',
    'deliveryTerms',
    'freightTerms',
    'packingForwardingTerms',
    'priceBasis',
    'taxTerms',
    'inspectionTerms',
    'warrantyTerms',
    'termsAndConditions',
    'hasAuthorizedSignature',
  ],
  Invoice: [
    'vendorName',
    'supplierGstin',
    'buyerName',
    'buyerGstin',
    'invoiceNumber',
    'referencePoNumber',
    'eWayBillNumber',
    'documentDate',
    'currency',
    'itemDescription',
    'itemQuantity',
    'unit',
    'hsnSac',
    'subtotal',
    'taxAmount',
    'tdsAmount',
    'tcsAmount',
    'roundOffAmount',
    'totalAmount',
    'vehicleNumber',
    'hasAuthorizedSignature',
    'hasVendorStamp',
    'hasStoreStamp',
    'hasStoreSignature',
    'hasGateStamp',
  ],
  'Tax Invoice': [
    'vendorName',
    'supplierGstin',
    'buyerName',
    'buyerGstin',
    'invoiceNumber',
    'referencePoNumber',
    'eWayBillNumber',
    'irnNumber',
    'ackNumber',
    'ackDate',
    'documentDate',
    'currency',
    'itemDescription',
    'itemQuantity',
    'unit',
    'hsnSac',
    'subtotal',
    'taxAmount',
    'tdsAmount',
    'tcsAmount',
    'roundOffAmount',
    'totalAmount',
    'vehicleNumber',
    'bankName',
    'accountNumber',
    'hasAuthorizedSignature',
    'hasVendorStamp',
    'hasStoreStamp',
    'hasStoreSignature',
    'hasGateStamp',
  ],
  Receipt: ['receiptNumber', 'referenceInvoiceNumber', 'documentDate', 'paidAmount', 'currency'],
  'Delivery Note': [
    'deliveryNoteNumber',
    'referencePoNumber',
    'documentDate',
    'vendorName',
    'buyerName',
    'itemDescription',
    'itemQuantity',
    'vehicleNumber',
    'hasAuthorizedSignature',
    'hasVendorStamp',
    'hasStoreStamp',
    'hasStoreSignature',
    'hasGateStamp',
  ],
  'Delivery Challan': [
    'deliveryNoteNumber',
    'referencePoNumber',
    'eWayBillNumber',
    'documentDate',
    'vendorName',
    'buyerName',
    'itemDescription',
    'itemQuantity',
    'vehicleNumber',
    'routeFrom',
    'routeTo',
    'hasAuthorizedSignature',
    'hasVendorStamp',
    'hasStoreStamp',
    'hasStoreSignature',
    'hasGateStamp',
  ],
  'E-Way Bill': [
    'eWayBillNumber',
    'referenceInvoiceNumber',
    'documentDate',
    'validityDate',
    'vehicleNumber',
    'transporterName',
    'lorryReceiptNumber',
    'supplierGstin',
    'buyerGstin',
    'dispatchFrom',
    'shipTo',
    'totalTaxableAmount',
    'subtotal',
    'taxAmount',
    'totalAmount',
  ],
  'Weighment Slip': [
    'weighmentNumber',
    'weighbridgeName',
    'documentDate',
    'vehicleNumber',
    'vendorName',
    'grossWeight',
    'tareWeight',
    'netWeight',
    'hasAuthorizedSignature',
  ],
  'Lorry Receipt': [
    'lorryReceiptNumber',
    'eWayBillNumber',
    'documentDate',
    'transporterName',
    'vendorName',
    'buyerName',
    'routeFrom',
    'routeTo',
    'vehicleNumber',
    'netWeight',
    'freightAmount',
    'advanceAmount',
    'toPayAmount',
    'hasAuthorizedSignature',
  ],
  'Vehicle Registration Certificate': [
    'registrationNumber',
    'ownerName',
    'vehicleNumber',
    'chassisNumber',
    'engineNumber',
    'vehicleClass',
    'fuelType',
    'documentDate',
    'validityDate',
    'mapLocation',
  ],
  'Driving Licence': [
    'licenseNumber',
    'driverName',
    'dateOfBirth',
    'documentDate',
    'validityDate',
    'mapLocation',
  ],
  'PAN Card': ['panNumber', 'holderName', 'fatherName', 'dateOfBirth'],
  'FASTag Toll Proof': [
    'transactionDate',
    'statementDate',
    'vehicleNumber',
    'fastagReference',
    'fastagStatementReference',
    'fastagCustomerId',
    'fastagCustomerName',
    'statementPeriod',
    'tollPlaza',
    'tripCount',
    'openingBalance',
    'creditAmount',
    'debitAmount',
    'closingBalance',
    'paidAmount',
    'statementAmount',
    'tollTransactionSummary',
  ],
  'Material Test Certificate': [
    'certificateNumber',
    'certificateDate',
    'vendorName',
    
    'batchNumber',
    'heatNumber',
    'itemQuantity',
    'grossWeight',
    'netWeight',
  ],
  'Photo Evidence': ['photoTimestamp', 'vehicleNumber', 'evidenceDescription'],
  'Transport Permit': [
    'permitNumber',
    'permitType',
    'documentDate',
    'validityDate',
    'vehicleNumber',
    'ownerName',
  ],
  'Bank Statement': ['bankName', 'accountNumber', 'transactionDate', 'transactionReference', 'statementAmount'],
  'Map Printout': ['routeFrom', 'routeTo', 'mapLocation'],
  'Payment Screenshot': ['transactionDate', 'transactionReference', 'paidAmount', 'statementAmount'],
  Unknown: [],
};

export function getFieldKeysForDocType(
  docType: DocType | string,
  configuration?: PacketFieldConfiguration
): FieldKey[] {
  if (!isDocTypeEnabled(docType as string, configuration)) {
    return [];
  }

  return (DOC_TYPE_EXTRACTION_FIELDS[docType as DocType] ?? []).filter((f) =>
    shouldConsiderFieldKey(f, docType as string, configuration)
  );
}

export function sanitizeFieldsForDocType<T>(
  docType: DocType | string,
  fields: Record<string, T>,
  configuration?: PacketFieldConfiguration
): Record<string, T> {
  const configuredFieldKeys = DOC_TYPE_EXTRACTION_FIELDS[docType as DocType] ?? [];
  const allowedFieldKeys =
    configuredFieldKeys.length > 0 ? new Set(getFieldKeysForDocType(docType, configuration)) : null;

  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => {
      if (!shouldConsiderFieldKey(key, docType as string, configuration)) {
        return false;
      }

      if (!allowedFieldKeys) {
        return true;
      }

      return allowedFieldKeys.has(key as FieldKey);
    })
  ) as Record<string, T>;
}

export function getFieldDefinitionsByKeys(fieldKeys: readonly string[]): FieldDefinition[] {
  const seen = new Set<FieldKey>();

  return fieldKeys.flatMap((fieldKey) => {
    const normalizedKey = fieldKey as FieldKey;
    const fieldDefinition = FIELD_DEFINITION_LOOKUP[normalizedKey];

    if (!fieldDefinition || seen.has(normalizedKey) || !shouldConsiderFieldKey(normalizedKey)) {
      return [];
    }

    seen.add(normalizedKey);
    return [fieldDefinition];
  });
}

export function getFieldDefinitionsForDocType(docType: DocType | string): FieldDefinition[] {
  return getFieldDefinitionsByKeys(getFieldKeysForDocType(docType));
}

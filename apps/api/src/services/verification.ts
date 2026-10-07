import type { CaseDoc, CommercialLineItem, FieldKey, Mismatch, MismatchValue } from "@/types/pipeline";
import { getFieldKeysForDocType, shouldConsiderFieldKey } from "@/lib/document-schema";
import {
  areComparableValuesEqual,
  DEFAULT_COMPARISON_OPTIONS,
  getComparableFieldValue,
  normalizeComparableValue,
  PRIMARY_COMPARISON_FIELDS,
} from "@/lib/comparison";
import type { ComparisonOptions } from "@/types/pipeline";

const PRESENCE_CHECK_FIELDS = new Set<FieldKey>();
const PURCHASE_DOC_TYPES = new Set(["Purchase Order", "Amended Purchase Order"]);
const INVOICE_DOC_TYPES = new Set(["Invoice", "Tax Invoice"]);
const COMMERCIAL_LINE_ITEM_COMPARISON_DOC_TYPES = new Set<CaseDoc["type"]>([
  "Purchase Order",
  "Amended Purchase Order",
  "Invoice",
  "Tax Invoice",
  "Delivery Challan",
  "Delivery Note",
  "E-Way Bill",
]);
const LOGISTICS_SUMMARY_LINE_DOC_TYPES = new Set(["Lorry Receipt", "Weighment Slip", "Transport Permit"]);
const FULFILLMENT_LINE_DOC_TYPES = new Set<CaseDoc["type"]>(["Delivery Challan", "Delivery Note"]);
const WEIGHT_FIELDS = new Set<FieldKey>(["grossWeight", "tareWeight", "netWeight"]);
const PARTY_NAME_FIELDS = new Set<FieldKey>(["vendorName", "buyerName", "transporterName", "ownerName", "driverName", "holderName"]);
const PURCHASE_ORDER_TOTAL_FIELDS = new Set<FieldKey>(["subtotal", "taxAmount", "totalAmount"]);
const EWAY_VALIDITY_RELATED_DOC_TYPES = new Set<CaseDoc["type"]>([
  "Invoice",
  "Tax Invoice",
  "Delivery Challan",
  "Delivery Note",
  "Lorry Receipt",
  "Weighment Slip",
  "Transport Permit",
  "Photo Evidence",
]);
const COMMERCIAL_CHARGE_LINE_PATTERN =
  /\b(?:packing|p\s*&\s*f|p\s+and\s+f|freight|cartage|loading|unloading|handling|forwarding|insurance|transport(?:ation)?|courier|postage|delivery|other\s+charges?)\b/i;
const BROAD_PURCHASE_LINE_PATTERN =
  /\b(?:annexure|attached|consisting\s+of\s+following|part\s+delivery|system|equipment|heater|heating|assembly)\b/i;
const PARTIAL_FULFILLMENT_DOC_TYPES = new Set<CaseDoc["type"]>([
  "Invoice",
  "Tax Invoice",
  "Delivery Challan",
  "Delivery Note",
  "E-Way Bill",
  "Unknown",
]);
const SAME_TYPE_ONLY_DESCRIPTIVE_FIELDS = new Set<FieldKey>([
  "driverName",
  "evidenceDescription",
  "fuelType",
  "holderName",
  "mapLocation",
  "ownerName",
  "panNumber",
  "permitType",
  "vehicleClass",
]);
const MULTI_INSTANCE_IDENTIFIER_FIELDS = new Set<FieldKey>([
  "poNumber",
  "invoiceNumber",
  "receiptNumber",
  "deliveryNoteNumber",
  "eWayBillNumber",
  "weighmentNumber",
  "lorryReceiptNumber",
  "certificateNumber",
  "permitNumber",
  "licenseNumber",
  "vehicleNumber",
  "fastagReference",
  "transactionReference",
]);
const MULTI_INVOICE_PARTIAL_FIELDS = new Set<FieldKey>([
  "invoiceNumber",
  "vehicleNumber",
  "subtotal",
  "taxAmount",
  "totalAmount",
  "itemQuantity",
]);
const MULTI_INVOICE_AGGREGATE_FIELDS = new Set<FieldKey>([
  "subtotal",
  "taxAmount",
  "totalAmount",
  "itemQuantity",
]);
const EXPECTATION_FIELD_ALIASES: Partial<Record<FieldKey, FieldKey[]>> = {
  poNumber: ["poNumber", "referencePoNumber"],
  invoiceNumber: ["invoiceNumber", "referenceInvoiceNumber"],
  totalAmount: ["totalAmount"],
  vehicleNumber: ["vehicleNumber", "registrationNumber"],
  dispatchFrom: ["dispatchFrom", "routeFrom"],
  shipTo: ["shipTo", "routeTo"],
};
const LINE_ITEM_REFERENCE_PRIORITY: Partial<Record<CaseDoc["type"], number>> = {
  "Purchase Order": 0,
  "Amended Purchase Order": 0,
  Invoice: 1,
  "Tax Invoice": 1,
  "Delivery Challan": 2,
  "Delivery Note": 2,
  "E-Way Bill": 3,
  "Lorry Receipt": 4,
  "Weighment Slip": 5,
  "Material Test Certificate": 6,
};
const GROUP_REFERENCE_FIELDS: FieldKey[] = [
  "poNumber",
  "invoiceNumber",
  "referenceInvoiceNumber",
  "deliveryNoteNumber",
  "eWayBillNumber",
  "lorryReceiptNumber",
  "weighmentNumber",
  "fastagReference",
  "transactionReference",
  "vehicleNumber",
];

export interface VerificationGroup {
  groupId: string;
  label: string;
  reason: "shared_reference" | "source_file" | "single_document";
  documentIds: string[];
  sourceFileNames: string[];
  referenceKeys: string[];
  roleSelection?: VerificationRoleSelection;
}

export interface GroupedVerificationResult {
  groups: VerificationGroup[];
  mismatches: Omit<Mismatch, "analysis" | "fixPlan">[];
}

export interface VerificationRoleSelection {
  strategy: "seller_chain";
  primaryDocumentIds: string[];
  contextDocumentIds: string[];
  note: string;
}

function shouldExpectField(doc: CaseDoc, field: FieldKey) {
  if (PURCHASE_DOC_TYPES.has(doc.type) && PURCHASE_ORDER_TOTAL_FIELDS.has(field)) {
    return false;
  }

  const configuredFields = getFieldKeysForDocType(doc.type);
  const candidateFields = EXPECTATION_FIELD_ALIASES[field] ?? [field];

  return candidateFields.some(
    (candidateField) =>
      shouldConsiderFieldKey(candidateField, doc.type) &&
      configuredFields.includes(candidateField)
  );
}

function shouldCompareItemQuantityValues(
  values: Array<{ doc: CaseDoc; value: string | number | null | undefined }>
) {
  const populated = values.filter((entry) => normalizeComparableValue(entry.value, DEFAULT_COMPARISON_OPTIONS, "itemQuantity"));
  if (populated.length < 2) return false;

  const units = populated.map((entry) => normalizeUnit(entry.doc.fields.unit));
  if (units.some((unit) => !unit)) return false;

  const [firstUnit, ...restUnits] = units;
  return restUnits.every((unit) => areUnitsCompatible(firstUnit, unit));
}

function parseWeightToKg(value?: string | number | null, unit?: string) {
  const parsed = parseNumber(value);
  if (parsed === null) return null;

  const unitFactor = unitFactorToBase(unit);
  if (unitFactor) return parsed * unitFactor;

  const raw = String(value ?? "").toLowerCase();
  if (/\b(?:m\.?t\.?s?\.?|metric\s*ton(?:ne)?s?|tonnes?|tons?)\b/i.test(raw)) {
    return parsed * 1000;
  }

  return parsed;
}

function weightsNearlyEqual(left: number | null, right: number | null) {
  if (left === null || right === null) return false;
  return Math.abs(left - right) <= Math.max(5, Math.abs(right) * 0.005);
}

function getWeightLineQuantity(line: CommercialLineItem) {
  const normalizedUnit = normalizeUnit(line.unit);
  if (normalizedUnit !== "kg" && normalizedUnit !== "mt") return null;
  return convertQuantityToBase(line.quantity, line.unit);
}

function sumWeightLineQuantities(lines: CommercialLineItem[] | undefined) {
  let total = 0;
  let count = 0;

  for (const line of lines ?? []) {
    const quantity = getWeightLineQuantity(line);
    if (quantity === null) continue;
    total += quantity;
    count += 1;
  }

  return count > 0 ? total : null;
}

function getDocumentShipmentWeightTargets(docs: CaseDoc[]) {
  const targets: Array<{ doc: CaseDoc; value: number }> = [];

  for (const doc of docs) {
    if (doc.type === "Weighment Slip") continue;

    const directNetWeight = parseWeightToKg(doc.fields.netWeight);
    if (directNetWeight !== null) targets.push({ doc, value: directNetWeight });

    const itemQuantityWeight = parseWeightToKg(doc.fields.itemQuantity, doc.fields.unit);
    if (itemQuantityWeight !== null) targets.push({ doc, value: itemQuantityWeight });

    const lineQuantityWeight = sumWeightLineQuantities(doc.lineItems);
    if (lineQuantityWeight !== null) targets.push({ doc, value: lineQuantityWeight });
  }

  return targets;
}

function getSingleKnownVehicle(docs: CaseDoc[], comparisonOptions: ComparisonOptions) {
  const vehicles = [
    ...new Set(
      docs
        .map((doc) => getVehicleReference(doc, comparisonOptions))
        .filter((value): value is string => Boolean(value))
    ),
  ];

  return vehicles.length === 1 ? vehicles[0] : null;
}

function splitWeighmentNetContext(docs: CaseDoc[], comparisonOptions: ComparisonOptions) {
  const weighmentEntries = docs
    .filter((doc) => doc.type === "Weighment Slip")
    .map((doc) => ({ doc, value: parseWeightToKg(doc.fields.netWeight) }))
    .filter((entry): entry is { doc: CaseDoc; value: number } => entry.value !== null);

  if (weighmentEntries.length < 2) {
    return { candidate: false, aggregateMatches: false };
  }

  const weighmentVehicles = [
    ...new Set(
      weighmentEntries
        .map((entry) => getVehicleReference(entry.doc, comparisonOptions))
        .filter((value): value is string => Boolean(value))
    ),
  ];
  if (weighmentVehicles.length > 1) {
    return { candidate: false, aggregateMatches: false };
  }

  const weighmentVehicle = weighmentVehicles[0] ?? null;
  const aggregateNetWeight = weighmentEntries.reduce((sum, entry) => sum + entry.value, 0);
  const shipmentTargets = getDocumentShipmentWeightTargets(docs);
  const aggregateMatches = shipmentTargets.some((target) => {
    const targetVehicle = getSingleKnownVehicle([target.doc], comparisonOptions);
    return (!weighmentVehicle || !targetVehicle || weighmentVehicle === targetVehicle) &&
      weightsNearlyEqual(aggregateNetWeight, target.value);
  });

  return {
    candidate: true,
    aggregateMatches,
  };
}

function isComparableFieldValue(
  field: FieldKey,
  value: string | number | null | undefined,
  comparisonOptions: ComparisonOptions
) {
  return Boolean(normalizeComparableValue(value, comparisonOptions, field));
}

function hasConsistentPartyGstin(
  field: FieldKey,
  entries: Array<{ doc: CaseDoc; value: string | number | null | undefined }>,
  comparisonOptions: ComparisonOptions
) {
  const gstinField: FieldKey | null =
    field === "vendorName" ? "supplierGstin" : field === "buyerName" ? "buyerGstin" : null;
  if (!gstinField) return false;

  const gstins = entries
    .map((entry) => normalizeGroupValue(entry.doc.fields[gstinField], comparisonOptions, gstinField))
    .filter((value): value is string => Boolean(value));
  if (gstins.length < 2) return false;

  const [first, ...rest] = gstins;
  return rest.every((value) => value === first);
}

function shouldCompareDescriptiveField(
  field: FieldKey,
  entries: Array<{ doc: CaseDoc; value: string | number | null | undefined }>,
  comparisonOptions: ComparisonOptions
) {
  if (!SAME_TYPE_ONLY_DESCRIPTIVE_FIELDS.has(field)) return true;

  const populatedDocTypes = new Set(
    entries
      .filter((entry) => isComparableFieldValue(field, entry.value, comparisonOptions))
      .map((entry) => entry.doc.type)
  );

  return populatedDocTypes.size > 1;
}

function shouldCompareInstanceIdentifierField(
  field: FieldKey,
  entries: Array<{ doc: CaseDoc; value: string | number | null | undefined }>,
  comparisonOptions: ComparisonOptions
) {
  if (!MULTI_INSTANCE_IDENTIFIER_FIELDS.has(field)) return true;

  const populatedDocTypes = new Set(
    entries
      .filter((entry) => isComparableFieldValue(field, entry.value, comparisonOptions))
      .map((entry) => entry.doc.type)
  );

  return populatedDocTypes.size > 1;
}

function shouldSuppressSplitWeighmentMismatch(
  field: FieldKey,
  docs: CaseDoc[],
  entries: Array<{ doc: CaseDoc; docId: string; value: string | number | null | undefined }>,
  comparisonOptions: ComparisonOptions
) {
  if (!WEIGHT_FIELDS.has(field)) return false;

  const populated = entries.filter((entry) => isComparableFieldValue(field, entry.value, comparisonOptions));
  const weighmentEntries = populated.filter((entry) => entry.doc.type === "Weighment Slip");
  if (weighmentEntries.length < 2) return false;

  const context = splitWeighmentNetContext(docs, comparisonOptions);
  if (!context.candidate) return false;

  if (field === "netWeight") {
    const hasShipmentNetValue = populated.some((entry) => entry.doc.type !== "Weighment Slip");
    return !hasShipmentNetValue || context.aggregateMatches;
  }

  const hasNonWeighmentValue = populated.some((entry) => entry.doc.type !== "Weighment Slip");
  return !hasNonWeighmentValue || context.aggregateMatches;
}

function normalizeDocReference(doc: CaseDoc, field: FieldKey, comparisonOptions: ComparisonOptions) {
  return normalizeGroupValue(getComparableFieldValue(doc, field), comparisonOptions, field);
}

function getLineItemTaxAmount(line: CommercialLineItem) {
  const direct = parseNumber(line.taxAmount);
  if (direct !== null) return direct;

  const componentAmounts = [line.cgstAmount, line.sgstAmount, line.igstAmount]
    .map((value) => parseNumber(value))
    .filter((value): value is number => value !== null);
  return componentAmounts.length ? componentAmounts.reduce((sum, value) => sum + value, 0) : null;
}

function sumLineItemNumericValues(
  lines: CommercialLineItem[] | undefined,
  getValue: (line: CommercialLineItem) => number | null
) {
  let total = 0;
  let count = 0;

  for (const line of lines ?? []) {
    const value = getValue(line);
    if (value === null) continue;
    total += value;
    count += 1;
  }

  return count > 0 ? total : null;
}

function getLineItemAggregateValue(doc: CaseDoc, field: FieldKey): number | null {
  if (field === "itemQuantity") {
    return sumLineItemNumericValues(
      doc.lineItems,
      (line) => convertQuantityToBase(line.quantity, line.unit) ?? parseNumber(line.quantity)
    );
  }

  if (field === "subtotal") {
    return sumLineItemNumericValues(doc.lineItems, (line) =>
      parseNumber(line.taxableAmount ?? line.lineTotal)
    );
  }

  if (field === "taxAmount") {
    return sumLineItemNumericValues(doc.lineItems, getLineItemTaxAmount);
  }

  if (field === "totalAmount") {
    const lineTotal = sumLineItemNumericValues(doc.lineItems, (line) => parseNumber(line.lineTotal));
    if (lineTotal !== null) return lineTotal;

    const subtotal = getLineItemAggregateValue(doc, "subtotal");
    const taxAmount = getLineItemAggregateValue(doc, "taxAmount");
    return subtotal !== null && taxAmount !== null ? subtotal + taxAmount : null;
  }

  return null;
}

function getNumericDocumentFieldValue(doc: CaseDoc, field: FieldKey) {
  if (field === "itemQuantity") {
    return (
      convertQuantityToBase(doc.fields.itemQuantity, doc.fields.unit) ??
      parseNumber(doc.fields.itemQuantity) ??
      getLineItemAggregateValue(doc, field)
    );
  }

  if (MULTI_INVOICE_AGGREGATE_FIELDS.has(field)) {
    return parseNumber(getComparableFieldValue(doc, field)) ?? getLineItemAggregateValue(doc, field);
  }

  return null;
}

type PartyIdentity = {
  gstin: string | null;
  name: string | null;
};

function getPartyIdentity(
  doc: CaseDoc,
  comparisonOptions: ComparisonOptions,
  gstinField: "supplierGstin" | "buyerGstin",
  nameField: "vendorName" | "buyerName"
): PartyIdentity {
  return {
    gstin: normalizeGroupValue(doc.fields[gstinField], comparisonOptions, gstinField),
    name: normalizeGroupValue(doc.fields[nameField], comparisonOptions, nameField),
  };
}

function hasPartyIdentity(identity: PartyIdentity) {
  return Boolean(identity.gstin || identity.name);
}

function partyIdentitiesMatch(left: PartyIdentity, right: PartyIdentity) {
  if (left.gstin && right.gstin) return left.gstin === right.gstin;
  if (left.name && right.name) return left.name === right.name || arePartyNamesEffectivelyEqual(left.name, right.name);
  return false;
}

function partyIdentityMatchesAny(identity: PartyIdentity, candidates: PartyIdentity[]) {
  return hasPartyIdentity(identity) && candidates.some((candidate) => partyIdentitiesMatch(identity, candidate));
}

function uniquePartyIdentities(identities: PartyIdentity[]) {
  const unique: PartyIdentity[] = [];
  for (const identity of identities) {
    if (!hasPartyIdentity(identity)) continue;
    if (unique.some((existing) => partyIdentitiesMatch(existing, identity))) continue;
    unique.push(identity);
  }
  return unique;
}

function getInvoiceReference(doc: CaseDoc, comparisonOptions: ComparisonOptions) {
  return normalizeDocReference(doc, "invoiceNumber", comparisonOptions);
}

function getSellerChainRoleSelection(
  docs: CaseDoc[],
  comparisonOptions: ComparisonOptions
): VerificationRoleSelection | null {
  const invoices = docs.filter((doc) => INVOICE_DOC_TYPES.has(doc.type));
  if (invoices.length < 2) return null;

  const purchaseDocs = docs.filter((doc) => PURCHASE_DOC_TYPES.has(doc.type));
  if (!purchaseDocs.length) return null;

  const purchaseBuyers = uniquePartyIdentities(
    purchaseDocs.map((doc) => getPartyIdentity(doc, comparisonOptions, "buyerGstin", "buyerName"))
  );
  const purchaseVendors = uniquePartyIdentities(
    purchaseDocs.map((doc) => getPartyIdentity(doc, comparisonOptions, "supplierGstin", "vendorName"))
  );
  if (!purchaseBuyers.length && !purchaseVendors.length) return null;

  const primaryInvoices = invoices.filter((invoice) => {
    const buyer = getPartyIdentity(invoice, comparisonOptions, "buyerGstin", "buyerName");
    const supplier = getPartyIdentity(invoice, comparisonOptions, "supplierGstin", "vendorName");
    const buyerIsFinalBuyer = partyIdentityMatchesAny(buyer, purchaseBuyers);
    const buyerIsPoVendor = partyIdentityMatchesAny(buyer, purchaseVendors);
    const supplierIsPoVendor = partyIdentityMatchesAny(supplier, purchaseVendors);
    return buyerIsFinalBuyer || (supplierIsPoVendor && !buyerIsPoVendor);
  });
  if (!primaryInvoices.length) return null;

  const primarySuppliers = uniquePartyIdentities([
    ...purchaseVendors,
    ...primaryInvoices.map((invoice) => getPartyIdentity(invoice, comparisonOptions, "supplierGstin", "vendorName")),
  ]);

  const upstreamInvoices = invoices.filter((invoice) => {
    if (primaryInvoices.some((primary) => primary.id === invoice.id)) return false;
    const buyer = getPartyIdentity(invoice, comparisonOptions, "buyerGstin", "buyerName");
    const facesFinalBuyer = partyIdentityMatchesAny(buyer, purchaseBuyers);
    return !facesFinalBuyer && partyIdentityMatchesAny(buyer, primarySuppliers);
  });
  if (!upstreamInvoices.length) return null;

  const upstreamInvoiceRefs = new Set(
    upstreamInvoices
      .map((invoice) => getInvoiceReference(invoice, comparisonOptions))
      .filter((value): value is string => Boolean(value))
  );
  const contextDocumentIds = new Set(upstreamInvoices.map((invoice) => invoice.id));

  for (const doc of docs) {
    if (contextDocumentIds.has(doc.id)) continue;
    const reference = getInvoiceBranchReference(doc, comparisonOptions);
    if (reference && upstreamInvoiceRefs.has(reference)) {
      contextDocumentIds.add(doc.id);
    }
  }

  return {
    strategy: "seller_chain",
    primaryDocumentIds: primaryInvoices.map((invoice) => invoice.id),
    contextDocumentIds: [...contextDocumentIds],
    note: "Seller-chain role selection applied: Kalika-facing invoice was reconciled; upstream seller invoices were kept as context.",
  };
}

function documentsForRoleSelectedComparison(
  docs: CaseDoc[],
  roleSelection: VerificationRoleSelection | null
) {
  if (!roleSelection?.contextDocumentIds.length) return docs;
  const contextIds = new Set(roleSelection.contextDocumentIds);
  const comparableDocs = docs.filter((doc) => !contextIds.has(doc.id));
  return comparableDocs.length >= 2 ? comparableDocs : docs;
}

function getSellerChainSourceDocumentIds(
  sourceDocs: CaseDoc[],
  comparisonOptions: ComparisonOptions
) {
  const roleSelection = getSellerChainRoleSelection(sourceDocs, comparisonOptions);
  if (!roleSelection) return null;

  const chainDocumentIds = new Set([
    ...roleSelection.primaryDocumentIds,
    ...roleSelection.contextDocumentIds,
  ]);
  const primaryInvoices = sourceDocs.filter((doc) => roleSelection.primaryDocumentIds.includes(doc.id));
  const chainInvoiceRefs = new Set(
    sourceDocs
      .filter((doc) => chainDocumentIds.has(doc.id) && INVOICE_DOC_TYPES.has(doc.type))
      .map((doc) => getInvoiceReference(doc, comparisonOptions))
      .filter((value): value is string => Boolean(value))
  );

  for (const doc of sourceDocs) {
    if (chainDocumentIds.has(doc.id)) continue;

    if (PURCHASE_DOC_TYPES.has(doc.type)) {
      const purchaseBuyer = getPartyIdentity(doc, comparisonOptions, "buyerGstin", "buyerName");
      const purchaseVendor = getPartyIdentity(doc, comparisonOptions, "supplierGstin", "vendorName");
      const anchorsPrimaryInvoice = primaryInvoices.some((invoice) => {
        const invoiceBuyer = getPartyIdentity(invoice, comparisonOptions, "buyerGstin", "buyerName");
        const invoiceSupplier = getPartyIdentity(invoice, comparisonOptions, "supplierGstin", "vendorName");
        return partyIdentitiesMatch(invoiceBuyer, purchaseBuyer) || partyIdentitiesMatch(invoiceSupplier, purchaseVendor);
      });
      if (anchorsPrimaryInvoice) {
        chainDocumentIds.add(doc.id);
      }
      continue;
    }

    const invoiceReference = getInvoiceBranchReference(doc, comparisonOptions);
    if (invoiceReference && chainInvoiceRefs.has(invoiceReference)) {
      chainDocumentIds.add(doc.id);
    }
  }

  return chainDocumentIds;
}

function normalizedInvoicePartyField(doc: CaseDoc, field: FieldKey, comparisonOptions: ComparisonOptions) {
  return normalizeGroupValue(doc.fields[field], comparisonOptions, field);
}

function invoicePartyValuesCompatible(left: CaseDoc, right: CaseDoc, comparisonOptions: ComparisonOptions) {
  const partyFields: FieldKey[] = ["supplierGstin", "buyerGstin"];
  return partyFields.every((field) => {
    const leftValue = normalizedInvoicePartyField(left, field, comparisonOptions);
    const rightValue = normalizedInvoicePartyField(right, field, comparisonOptions);
    return !leftValue || !rightValue || leftValue === rightValue;
  });
}

function invoiceNumericValuesCompatible(left: CaseDoc, right: CaseDoc) {
  return [...MULTI_INVOICE_AGGREGATE_FIELDS].every((field) => {
    const leftValue = getNumericDocumentFieldValue(left, field);
    const rightValue = getNumericDocumentFieldValue(right, field);
    return leftValue === null || rightValue === null || nearlyEqual(leftValue, rightValue);
  });
}

function areInvoiceCopiesForAggregation(left: CaseDoc, right: CaseDoc, comparisonOptions: ComparisonOptions) {
  const leftInvoiceNumber = normalizeDocReference(left, "invoiceNumber", comparisonOptions);
  const rightInvoiceNumber = normalizeDocReference(right, "invoiceNumber", comparisonOptions);
  return Boolean(
    leftInvoiceNumber &&
      rightInvoiceNumber &&
      leftInvoiceNumber === rightInvoiceNumber &&
      invoicePartyValuesCompatible(left, right, comparisonOptions) &&
      invoiceNumericValuesCompatible(left, right)
  );
}

function uniqueInvoiceDocumentsForAggregation(docs: CaseDoc[], comparisonOptions: ComparisonOptions) {
  const uniqueInvoices: CaseDoc[] = [];

  for (const doc of docs) {
    if (!INVOICE_DOC_TYPES.has(doc.type)) continue;
    if (uniqueInvoices.some((invoice) => areInvoiceCopiesForAggregation(invoice, doc, comparisonOptions))) continue;
    uniqueInvoices.push(doc);
  }

  return uniqueInvoices;
}

function purchaseOrderReferences(docs: CaseDoc[], comparisonOptions: ComparisonOptions) {
  return new Set(
    docs
      .filter((doc) => PURCHASE_DOC_TYPES.has(doc.type))
      .map((doc) => normalizeDocReference(doc, "poNumber", comparisonOptions))
      .filter((value): value is string => Boolean(value))
  );
}

function invoicesBelongToPurchaseOrder(
  invoices: CaseDoc[],
  purchaseRefs: Set<string>,
  comparisonOptions: ComparisonOptions
) {
  if (!purchaseRefs.size) return false;

  let matchedInvoiceCount = 0;
  for (const invoice of invoices) {
    const invoicePo = normalizeDocReference(invoice, "poNumber", comparisonOptions);
    if (!invoicePo) continue;
    if (!purchaseRefs.has(invoicePo)) return false;
    matchedInvoiceCount += 1;
  }

  return matchedInvoiceCount > 0;
}

function invoiceAggregateMatchesPurchaseOrder(
  field: FieldKey,
  invoices: CaseDoc[],
  purchaseDocs: CaseDoc[]
) {
  if (!MULTI_INVOICE_AGGREGATE_FIELDS.has(field)) return false;

  let invoiceTotal = 0;
  let invoiceCount = 0;
  for (const invoice of invoices) {
    const value = getNumericDocumentFieldValue(invoice, field);
    if (value === null) continue;
    invoiceTotal += value;
    invoiceCount += 1;
  }

  if (invoiceCount < 2) return false;

  return purchaseDocs.some((purchaseDoc) => {
    const purchaseValue = getNumericDocumentFieldValue(purchaseDoc, field);
    return purchaseValue !== null && nearlyEqual(invoiceTotal, purchaseValue);
  });
}

function getInvoiceBranchReference(doc: CaseDoc, comparisonOptions: ComparisonOptions) {
  return normalizeGroupValue(doc.fields.referenceInvoiceNumber, comparisonOptions, "referenceInvoiceNumber") ??
    normalizeDocReference(doc, "invoiceNumber", comparisonOptions);
}

function eWayBillsReferenceKnownInvoices(
  eWayBills: CaseDoc[],
  invoiceRefs: Set<string>,
  comparisonOptions: ComparisonOptions
) {
  if (!eWayBills.length) return true;

  let referencedCount = 0;
  for (const eWayBill of eWayBills) {
    const reference = getInvoiceBranchReference(eWayBill, comparisonOptions);
    if (!reference) continue;
    if (!invoiceRefs.has(reference)) return false;
    referencedCount += 1;
  }

  return referencedCount > 0;
}

function branchValuesConsistentWithInvoice(
  field: FieldKey,
  invoices: CaseDoc[],
  branchDocs: CaseDoc[],
  comparisonOptions: ComparisonOptions
) {
  const invoicesByReference = new Map<string, CaseDoc[]>();
  for (const invoice of invoices) {
    const reference = normalizeDocReference(invoice, "invoiceNumber", comparisonOptions);
    if (!reference) continue;
    invoicesByReference.set(reference, [...(invoicesByReference.get(reference) ?? []), invoice]);
  }

  for (const branchDoc of branchDocs) {
    const reference = getInvoiceBranchReference(branchDoc, comparisonOptions);
    if (!reference) continue;

    const matchingInvoices = invoicesByReference.get(reference) ?? [];
    if (!matchingInvoices.length) return false;

    if (MULTI_INVOICE_AGGREGATE_FIELDS.has(field)) {
      const branchValue = getNumericDocumentFieldValue(branchDoc, field);
      if (branchValue === null) continue;

      const hasMatchingInvoiceValue = matchingInvoices.some((invoice) => {
        const invoiceValue = getNumericDocumentFieldValue(invoice, field);
        return invoiceValue !== null && nearlyEqual(branchValue, invoiceValue);
      });
      if (!hasMatchingInvoiceValue) return false;
    }

    if (field === "vehicleNumber") {
      const branchVehicle = normalizeDocReference(branchDoc, "vehicleNumber", comparisonOptions);
      if (!branchVehicle) continue;

      const invoiceVehicles = matchingInvoices
        .map((invoice) => normalizeDocReference(invoice, "vehicleNumber", comparisonOptions))
        .filter((value): value is string => Boolean(value));
      if (invoiceVehicles.length && !invoiceVehicles.includes(branchVehicle)) return false;
    }
  }

  return true;
}

function shouldSuppressMultiInvoicePartialMismatch(
  field: FieldKey,
  docs: CaseDoc[],
  entries: Array<{ doc: CaseDoc; docId: string; value: string | number | null | undefined }>,
  comparisonOptions: ComparisonOptions
) {
  if (!MULTI_INVOICE_PARTIAL_FIELDS.has(field)) return false;

  const populated = entries.filter((entry) => isComparableFieldValue(field, entry.value, comparisonOptions));
  if (populated.length < 2) return false;

  const purchaseDocs = docs.filter((doc) => PURCHASE_DOC_TYPES.has(doc.type));
  if (!purchaseDocs.length) return false;

  const uniqueInvoices = uniqueInvoiceDocumentsForAggregation(docs, comparisonOptions);
  if (uniqueInvoices.length < 2) return false;

  const purchaseRefs = purchaseOrderReferences(docs, comparisonOptions);
  if (!invoicesBelongToPurchaseOrder(uniqueInvoices, purchaseRefs, comparisonOptions)) return false;

  const aggregateMatches = [...MULTI_INVOICE_AGGREGATE_FIELDS].some((aggregateField) =>
    invoiceAggregateMatchesPurchaseOrder(aggregateField, uniqueInvoices, purchaseDocs)
  );
  if (!aggregateMatches) return false;

  const invoiceRefs = new Set(
    uniqueInvoices
      .map((invoice) => normalizeDocReference(invoice, "invoiceNumber", comparisonOptions))
      .filter((value): value is string => Boolean(value))
  );
  const eWayBills = docs.filter((doc) => doc.type === "E-Way Bill");
  if (!eWayBillsReferenceKnownInvoices(eWayBills, invoiceRefs, comparisonOptions)) return false;

  return branchValuesConsistentWithInvoice(field, uniqueInvoices, eWayBills, comparisonOptions);
}

function normalizePartyName(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const tokens = String(value)
    .toLowerCase()
    .replace(/\((i)\)/g, " india ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (token === "pvt") return "private";
      if (token === "ltd") return "limited";
      if (["kaliko", "xarixa", "xarika"].includes(token)) return "kalika";
      if (token === "sted" || token === "steei") return "steel";
      if (token === "steels") return "steel";
      if (token === "alloys") return "alloy";
      return token;
    })
    .filter(
      (token) =>
        !["private", "limited", "pvt", "ltd", "company", "co", "india", "ind", "i"].includes(token)
    );

  return tokens.join("");
}

function editDistance(left: string, right: string) {
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

function arePartyNamesEffectivelyEqual(left: string | number | null | undefined, right: string | number | null | undefined) {
  const normalizedLeft = normalizePartyName(left);
  const normalizedRight = normalizePartyName(right);
  if (!normalizedLeft || !normalizedRight || normalizedLeft.length < 5 || normalizedRight.length < 5) {
    return false;
  }

  if (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) {
    return true;
  }

  const maxLength = Math.max(normalizedLeft.length, normalizedRight.length);
  if (maxLength < 8) return false;

  return editDistance(normalizedLeft, normalizedRight) <= Math.max(2, Math.floor(maxLength * 0.25));
}

function normalizeGroupValue(
  value: string | number | null | undefined,
  comparisonOptions: ComparisonOptions,
  field?: FieldKey
) {
  return normalizeComparableValue(value, comparisonOptions, field) || null;
}

function normalizeSourceName(value?: string) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") || null;
}

function normalizeAmountValue(value: string | number | null | undefined) {
  const parsed = parseNumber(value);
  return parsed === null ? null : Math.round(parsed * 100).toString();
}

const MONTH_NAME_TO_INDEX: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function normalizeYear(value: number) {
  return value < 100 ? 2000 + value : value;
}

function dayStamp(year: number, month: number, day: number) {
  const normalizedYear = normalizeYear(year);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(normalizedYear, month - 1, day));
  if (
    date.getUTCFullYear() !== normalizedYear ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(date.getTime() / 86400000);
}

function parseDocumentDay(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;

  const isoMatch = text.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/);
  if (isoMatch) {
    return dayStamp(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const numericMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (numericMatch) {
    return dayStamp(Number(numericMatch[3]), Number(numericMatch[2]), Number(numericMatch[1]));
  }

  const namedMonthMatch = text.match(/\b(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})\b/);
  const month = namedMonthMatch ? MONTH_NAME_TO_INDEX[namedMonthMatch[2].toLowerCase()] : undefined;
  if (namedMonthMatch && month) {
    return dayStamp(Number(namedMonthMatch[3]), month, Number(namedMonthMatch[1]));
  }

  return null;
}

function getDocumentDateForValidity(doc: CaseDoc) {
  const candidates: FieldKey[] = ["documentDate", "ackDate", "transactionDate"];
  for (const field of candidates) {
    const value = doc.fields[field];
    const stamp = parseDocumentDay(value);
    if (stamp !== null) return { field, value, stamp };
  }
  return null;
}

function verifyEWayBillValidity(docs: CaseDoc[]): Omit<Mismatch, "analysis" | "fixPlan">[] {
  const mismatches: Omit<Mismatch, "analysis" | "fixPlan">[] = [];
  const eWayBills = docs.filter((doc) => doc.type === "E-Way Bill");
  const relatedDocs = docs.filter((doc) => doc.type !== "E-Way Bill" && EWAY_VALIDITY_RELATED_DOC_TYPES.has(doc.type));

  for (const eWayBill of eWayBills) {
    const validUntilValue = eWayBill.fields.validityDate;
    const validUntilStamp = parseDocumentDay(validUntilValue);
    const generatedValue = eWayBill.fields.documentDate;
    const generatedStamp = parseDocumentDay(generatedValue);

    if (validUntilStamp !== null && generatedStamp !== null && validUntilStamp < generatedStamp) {
      mismatches.push({
        id: `mismatch-eway-validity-order-${eWayBill.id}`,
        field: "validityDate",
        values: [
          { docId: eWayBill.id, value: `Generated Date: ${generatedValue}` },
          { docId: eWayBill.id, value: `Valid Upto: ${validUntilValue}` },
        ],
      });
    }

    if (validUntilStamp === null) continue;

    for (const relatedDoc of relatedDocs) {
      const relatedDate = getDocumentDateForValidity(relatedDoc);
      if (!relatedDate || relatedDate.stamp <= validUntilStamp) continue;

      mismatches.push({
        id: `mismatch-eway-validity-${eWayBill.id}-${relatedDoc.id}`,
        field: "validityDate",
        values: [
          { docId: eWayBill.id, value: `E-Way Bill Valid Upto: ${validUntilValue}` },
          { docId: relatedDoc.id, value: `${relatedDoc.type} ${relatedDate.field}: ${relatedDate.value}` },
        ],
      });
    }
  }

  return mismatches;
}

function getVendorIdentity(doc: CaseDoc, comparisonOptions: ComparisonOptions) {
  return (
    normalizeGroupValue(doc.fields.supplierGstin, comparisonOptions, "supplierGstin") ||
    normalizeGroupValue(doc.fields.vendorName, comparisonOptions, "vendorName") ||
    normalizeGroupValue(doc.fields.transporterName, comparisonOptions, "transporterName") ||
    null
  );
}

function isUsefulInvoiceReference(value: string | null) {
  if (!value) return false;
  return value.length >= 4 || /[a-z]/i.test(value);
}

function isValidEWayBillReference(value: string | null) {
  return Boolean(value && /^\d{12}$/.test(value));
}

function isUsefulVehicleReference(value: string | null) {
  if (!value) return false;
  return /^[a-z]{2}\d{1,2}[a-z]{1,3}\d{3,4}$/i.test(value);
}

function getVehicleReference(doc: CaseDoc, comparisonOptions: ComparisonOptions) {
  return normalizeGroupValue(getComparableFieldValue(doc, "vehicleNumber"), comparisonOptions, "vehicleNumber");
}

function getPacketReferenceKeys(doc: CaseDoc, comparisonOptions: ComparisonOptions) {
  const keys: string[] = [];
  const vendorIdentity = getVendorIdentity(doc, comparisonOptions);

  const poNumber = normalizeGroupValue(getComparableFieldValue(doc, "poNumber"), comparisonOptions, "poNumber");
  if (poNumber) keys.push(`po:${poNumber}`);

  const invoiceNumber = normalizeGroupValue(
    getComparableFieldValue(doc, "invoiceNumber"),
    comparisonOptions,
    "invoiceNumber"
  );
  if (isUsefulInvoiceReference(invoiceNumber)) {
    if (vendorIdentity) {
      keys.push(`invoice-party:${invoiceNumber}:${vendorIdentity}`);
    } else if (poNumber) {
      keys.push(`invoice-po:${invoiceNumber}:${poNumber}`);
    } else {
      keys.push(`invoice:${invoiceNumber}`);
      keys.push(`document:${invoiceNumber}`);
    }
  }

  const eWayBillNumber = normalizeGroupValue(doc.fields.eWayBillNumber, comparisonOptions, "eWayBillNumber");
  if (isValidEWayBillReference(eWayBillNumber)) keys.push(`eway:${eWayBillNumber}`);

  const deliveryNoteNumber = normalizeGroupValue(
    doc.fields.deliveryNoteNumber,
    comparisonOptions,
    "deliveryNoteNumber"
  );
  if (isUsefulInvoiceReference(deliveryNoteNumber)) {
    keys.push(`delivery:${deliveryNoteNumber}`);
    keys.push(`document:${deliveryNoteNumber}`);
  }

  const lorryReceiptNumber = normalizeGroupValue(
    doc.fields.lorryReceiptNumber,
    comparisonOptions,
    "lorryReceiptNumber"
  );
  if (lorryReceiptNumber) {
    keys.push(`lr:${lorryReceiptNumber}`);
    keys.push(`document:${lorryReceiptNumber}`);
  }

  const weighmentNumber = normalizeGroupValue(doc.fields.weighmentNumber, comparisonOptions, "weighmentNumber");
  if (weighmentNumber && vendorIdentity) keys.push(`weighment-party:${weighmentNumber}:${vendorIdentity}`);

  const fastagReference = normalizeGroupValue(doc.fields.fastagReference, comparisonOptions, "fastagReference");
  if (fastagReference) keys.push(`fastag:${fastagReference}`);

  const transactionReference = normalizeGroupValue(
    doc.fields.transactionReference,
    comparisonOptions,
    "transactionReference"
  );
  if (transactionReference) keys.push(`transaction:${transactionReference}`);

  const vehicleNumber = getVehicleReference(doc, comparisonOptions);
  if (isUsefulVehicleReference(vehicleNumber)) keys.push(`vehicle:${vehicleNumber}`);

  return [...new Set(keys)];
}

function getSharedReferenceKeys(left: CaseDoc, right: CaseDoc, comparisonOptions: ComparisonOptions) {
  const leftKeys = new Set(getPacketReferenceKeys(left, comparisonOptions));
  return getPacketReferenceKeys(right, comparisonOptions).filter((key) => leftKeys.has(key));
}

function shareCommercialIdentity(left: CaseDoc, right: CaseDoc, comparisonOptions: ComparisonOptions) {
  const leftAmount = normalizeAmountValue(getComparableFieldValue(left, "totalAmount"));
  const rightAmount = normalizeAmountValue(getComparableFieldValue(right, "totalAmount"));
  if (!leftAmount || !rightAmount || leftAmount !== rightAmount) {
    return false;
  }

  const leftVendor = getVendorIdentity(left, comparisonOptions);
  const rightVendor = getVendorIdentity(right, comparisonOptions);
  if (leftVendor && rightVendor && leftVendor === rightVendor) {
    return true;
  }

  const leftBuyerGstin = normalizeGroupValue(left.fields.buyerGstin, comparisonOptions, "buyerGstin");
  const rightBuyerGstin = normalizeGroupValue(right.fields.buyerGstin, comparisonOptions, "buyerGstin");
  const leftSupplierGstin = normalizeGroupValue(left.fields.supplierGstin, comparisonOptions, "supplierGstin");
  const rightSupplierGstin = normalizeGroupValue(right.fields.supplierGstin, comparisonOptions, "supplierGstin");

  return Boolean(
    leftSupplierGstin &&
      rightSupplierGstin &&
      leftSupplierGstin === rightSupplierGstin &&
      leftBuyerGstin &&
      rightBuyerGstin &&
      leftBuyerGstin === rightBuyerGstin
  );
}

function isStrongDocumentReferenceKey(key: string) {
  return (
    key.startsWith("po:") ||
    key.startsWith("invoice:") ||
    key.startsWith("invoice-po:") ||
    key.startsWith("invoice-party:") ||
    key.startsWith("document:") ||
    key.startsWith("delivery:") ||
    key.startsWith("eway:") ||
    key.startsWith("lr:")
  );
}

function isFulfillmentDocumentReferenceKey(key: string) {
  return (
    key.startsWith("invoice:") ||
    key.startsWith("invoice-po:") ||
    key.startsWith("invoice-party:") ||
    key.startsWith("document:") ||
    key.startsWith("delivery:") ||
    key.startsWith("eway:") ||
    key.startsWith("lr:")
  );
}

function isWeakLogisticsReferenceKey(key: string) {
  return (
    key.startsWith("vehicle:") ||
    key.startsWith("fastag:") ||
    key.startsWith("transaction:") ||
    key.startsWith("weighment-party:")
  );
}

function getStrongDocumentReferenceKeys(doc: CaseDoc, comparisonOptions: ComparisonOptions) {
  return getPacketReferenceKeys(doc, comparisonOptions).filter(isStrongDocumentReferenceKey);
}

function getFulfillmentDocumentReferenceKeys(doc: CaseDoc, comparisonOptions: ComparisonOptions) {
  return getPacketReferenceKeys(doc, comparisonOptions).filter(isFulfillmentDocumentReferenceKey);
}

function hasCommercialComparisonSignal(doc: CaseDoc) {
  return Boolean(
    doc.fields.subtotal ||
      doc.fields.totalTaxableAmount ||
      doc.fields.taxAmount ||
      doc.fields.totalAmount ||
      (doc.lineItems?.length ?? 0) > 0 ||
      COMMERCIAL_LINE_ITEM_COMPARISON_DOC_TYPES.has(doc.type)
  );
}

function hasSharedStrongDocumentReference(
  left: CaseDoc,
  right: CaseDoc,
  comparisonOptions: ComparisonOptions
) {
  const leftKeys = new Set(getStrongDocumentReferenceKeys(left, comparisonOptions));
  return getStrongDocumentReferenceKeys(right, comparisonOptions).some((key) => leftKeys.has(key));
}

function hasSharedFulfillmentDocumentReference(
  left: CaseDoc,
  right: CaseDoc,
  comparisonOptions: ComparisonOptions
) {
  const leftKeys = new Set(getFulfillmentDocumentReferenceKeys(left, comparisonOptions));
  return getFulfillmentDocumentReferenceKeys(right, comparisonOptions).some((key) => leftKeys.has(key));
}

function sourceHasMultipleFulfillmentReferenceComponents(
  sourceDocs: CaseDoc[],
  comparisonOptions: ComparisonOptions
) {
  const anchoredCommercialDocs = sourceDocs.filter(
    (doc) => hasCommercialComparisonSignal(doc) && getFulfillmentDocumentReferenceKeys(doc, comparisonOptions).length > 0
  );
  if (anchoredCommercialDocs.length <= 1) return false;

  const parent = anchoredCommercialDocs.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  for (let left = 0; left < anchoredCommercialDocs.length; left += 1) {
    for (let right = left + 1; right < anchoredCommercialDocs.length; right += 1) {
      if (
        hasSharedFulfillmentDocumentReference(
          anchoredCommercialDocs[left],
          anchoredCommercialDocs[right],
          comparisonOptions
        ) ||
        shareCommercialIdentity(anchoredCommercialDocs[left], anchoredCommercialDocs[right], comparisonOptions)
      ) {
        union(left, right);
      }
    }
  }

  return new Set(anchoredCommercialDocs.map((_, index) => find(index))).size > 1;
}

function shouldGroupBySourceFile(
  left: CaseDoc,
  right: CaseDoc,
  sourceDocs: CaseDoc[],
  comparisonOptions: ComparisonOptions
) {
  const leftStrongRefs = getStrongDocumentReferenceKeys(left, comparisonOptions);
  const rightStrongRefs = getStrongDocumentReferenceKeys(right, comparisonOptions);
  if (leftStrongRefs.length > 0 && rightStrongRefs.length > 0) {
    return hasSharedStrongDocumentReference(left, right, comparisonOptions);
  }

  if (shareCommercialIdentity(left, right, comparisonOptions)) {
    return true;
  }

  const sharedReferenceKeys = getSharedReferenceKeys(left, right, comparisonOptions);
  if (sharedReferenceKeys.some(isStrongDocumentReferenceKey)) {
    return true;
  }

  if (sourceHasMultipleFulfillmentReferenceComponents(sourceDocs, comparisonOptions)) {
    return false;
  }

  const hasOnlyWeakLogisticsReference =
    sharedReferenceKeys.length > 0 && sharedReferenceKeys.every(isWeakLogisticsReferenceKey);
  const commercialSourceDocCount = sourceDocs.filter((doc) =>
    COMMERCIAL_LINE_ITEM_COMPARISON_DOC_TYPES.has(doc.type)
  ).length;
  if (
    hasOnlyWeakLogisticsReference &&
    commercialSourceDocCount > 1 &&
    (hasCommercialComparisonSignal(left) || hasCommercialComparisonSignal(right))
  ) {
    return false;
  }

  if (sharedReferenceKeys.length > 0) {
    return true;
  }

  if (hasCommercialComparisonSignal(left) && hasCommercialComparisonSignal(right)) {
    return false;
  }

  const invoiceCount = sourceDocs.filter((doc) => INVOICE_DOC_TYPES.has(doc.type)).length;
  if (invoiceCount <= 1) {
    return true;
  }

  const purchaseCount = sourceDocs.filter((doc) => PURCHASE_DOC_TYPES.has(doc.type)).length;
  return invoiceCount === 0 && purchaseCount <= 1;
}

function packetReferenceLabel(doc: CaseDoc, comparisonOptions: ComparisonOptions) {
  for (const field of GROUP_REFERENCE_FIELDS) {
    const value = getComparableFieldValue(doc, field);
    if (normalizeGroupValue(value, comparisonOptions, field)) {
      return `${field}:${value}`;
    }
  }

  return doc.sourceFileName || doc.sourceHint || doc.title || doc.id;
}

function makeVerificationGroup(
  docs: CaseDoc[],
  comparisonOptions: ComparisonOptions,
  groupIndex: number,
  roleSelection: VerificationRoleSelection | null = null
): VerificationGroup {
  const sourceFileNames = [...new Set(docs.map((doc) => doc.sourceFileName).filter((value): value is string => Boolean(value)))];
  const referenceKeys = [...new Set(docs.flatMap((doc) => getPacketReferenceKeys(doc, comparisonOptions)))];
  const labelReference =
    docs
      .map((doc) => packetReferenceLabel(doc, comparisonOptions))
      .find((value) => value && !value.startsWith("sourceFileName:")) ?? sourceFileNames[0] ?? `Packet ${groupIndex + 1}`;
  const singleSource = sourceFileNames.length === 1;

  return {
    groupId: `packet-group-${groupIndex + 1}`,
    label: labelReference,
    reason: docs.length <= 1 ? "single_document" : singleSource ? "source_file" : "shared_reference",
    documentIds: docs.map((doc) => doc.id),
    sourceFileNames,
    referenceKeys,
    ...(roleSelection ? { roleSelection } : {}),
  };
}

export function groupDocumentsForVerification(
  docs: CaseDoc[],
  comparisonOptions: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
) {
  const parent = docs.map((_, index) => index);

  const find = (index: number): number => {
    if (parent[index] !== index) {
      parent[index] = find(parent[index]);
    }
    return parent[index];
  };

  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  const byReference = new Map<string, number[]>();
  docs.forEach((doc, index) => {
    getPacketReferenceKeys(doc, comparisonOptions)
      .filter(isStrongDocumentReferenceKey)
      .forEach((key) => {
        byReference.set(key, [...(byReference.get(key) ?? []), index]);
      });
  });

  byReference.forEach((indices) => {
    const [first, ...rest] = indices;
    rest.forEach((index) => union(first, index));
  });

  const bySource = new Map<string, number[]>();
  docs.forEach((doc, index) => {
    const source = normalizeSourceName(doc.sourceFileName);
    if (!source) return;
    bySource.set(source, [...(bySource.get(source) ?? []), index]);
  });

  bySource.forEach((indices) => {
    const sourceDocs = indices.map((index) => docs[index]);
    const sellerChainDocumentIds = getSellerChainSourceDocumentIds(sourceDocs, comparisonOptions);
    if (sellerChainDocumentIds) {
      const chainIndices = indices.filter((index) => sellerChainDocumentIds.has(docs[index].id));
      if (chainIndices.length > 1) {
        const [firstChainIndex, ...remainingChainIndices] = chainIndices;
        remainingChainIndices.forEach((index) => union(firstChainIndex, index));
      }
    }

    for (let left = 0; left < indices.length; left += 1) {
      for (let right = left + 1; right < indices.length; right += 1) {
        const leftIndex = indices[left];
        const rightIndex = indices[right];
        if (shouldGroupBySourceFile(docs[leftIndex], docs[rightIndex], sourceDocs, comparisonOptions)) {
          union(leftIndex, rightIndex);
        }
      }
    }
  });

  for (let left = 0; left < docs.length; left += 1) {
    for (let right = left + 1; right < docs.length; right += 1) {
      if (find(left) === find(right)) continue;
      if (shareCommercialIdentity(docs[left], docs[right], comparisonOptions)) {
        union(left, right);
      }
    }
  }

  const grouped = new Map<number, CaseDoc[]>();
  docs.forEach((doc, index) => {
    const root = find(index);
    grouped.set(root, [...(grouped.get(root) ?? []), doc]);
  });

  return [...grouped.values()].map((groupDocs, index) => {
    const roleSelection = getSellerChainRoleSelection(groupDocs, comparisonOptions);
    return {
      group: makeVerificationGroup(groupDocs, comparisonOptions, index, roleSelection),
      docs: groupDocs,
    };
  });
}

function areFieldValuesEqual(
  field: FieldKey,
  left: string | number | null | undefined,
  right: string | number | null | undefined,
  comparisonOptions: ComparisonOptions
) {
  if (areComparableValuesEqual(left, right, comparisonOptions, field)) {
    return true;
  }

  if (PARTY_NAME_FIELDS.has(field)) {
    return arePartyNamesEffectivelyEqual(left, right);
  }

  return false;
}

function buildMismatch(
  field: FieldKey,
  docs: CaseDoc[],
  comparisonOptions: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
): Omit<Mismatch, "analysis" | "fixPlan"> | null {
  const comparableEntries = docs
    .filter((doc) => shouldExpectField(doc, field))
    .map((doc) => ({
      doc,
      docId: doc.id,
      value: getComparableFieldValue(doc, field),
    }));

  if (field === "itemQuantity" && !shouldCompareItemQuantityValues(comparableEntries)) {
    return null;
  }

  if (
    (field === "vendorName" || field === "buyerName") &&
    hasConsistentPartyGstin(field, comparableEntries, comparisonOptions)
  ) {
    return null;
  }

  if (!shouldCompareDescriptiveField(field, comparableEntries, comparisonOptions)) {
    return null;
  }

  if (!shouldCompareInstanceIdentifierField(field, comparableEntries, comparisonOptions)) {
    return null;
  }

  if (shouldSuppressSplitWeighmentMismatch(field, docs, comparableEntries, comparisonOptions)) {
    return null;
  }

  if (shouldSuppressMultiInvoicePartialMismatch(field, docs, comparableEntries, comparisonOptions)) {
    return null;
  }

  const values = comparableEntries.map((entry) => ({
    docId: entry.docId,
    value: entry.value,
  }));
  const populated = values.filter((entry) => isComparableFieldValue(field, entry.value, comparisonOptions));
  const missing = values.filter((entry) => !isComparableFieldValue(field, entry.value, comparisonOptions));
  const firstValue = populated[0]?.value;
  const hasConflictingValues =
    populated.length >= 2 &&
    populated.some((entry) => !areFieldValuesEqual(field, firstValue, entry.value, comparisonOptions));
  const hasRequiredFieldGap =
    PRESENCE_CHECK_FIELDS.has(field) && populated.length >= 1 && missing.length >= 1;

  if (!hasConflictingValues && !hasRequiredFieldGap) return null;

  return {
    id: `mismatch-${field}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    field,
    values: (hasRequiredFieldGap ? values : populated) as MismatchValue[],
  };
}

function compactText(value?: string) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const GENERIC_LINE_TOKENS = new Set([
  "and",
  "amt",
  "amount",
  "code",
  "description",
  "cylinder",
  "cylinders",
  "gas",
  "goods",
  "gst",
  "guide",
  "hsn",
  "igst",
  "item",
  "nos",
  "qty",
  "rate",
  "roller",
  "sac",
  "sgst",
  "spare",
  "spares",
  "tax",
  "total",
  "unit",
]);

function normalizeLineToken(token: string) {
  if (token === "daneli" || token === "danieil") return "danieli";
  if (token === "heater" || token === "heating") return "heat";
  return token;
}

function stripLeadingLineNumber(value: string) {
  return value.replace(/^\s*\d+\s+/, "");
}

function lineSearchText(item: CommercialLineItem) {
  return compactText(
    [
      item.itemCode,
      item.description,
      item.rawText ? stripLeadingLineNumber(item.rawText) : undefined,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function lineTokens(item: CommercialLineItem) {
  return [
    item.itemCode,
    item.description,
    item.rawText ? stripLeadingLineNumber(item.rawText) : undefined,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map(normalizeLineToken)
    .filter((token) => token.length > 2 && !GENERIC_LINE_TOKENS.has(token));
}

function tokenOverlapScore(left: CommercialLineItem, right: CommercialLineItem) {
  const leftTokens = new Set(lineTokens(left));
  const rightTokens = new Set(lineTokens(right));
  let overlap = 0;

  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  });

  if (overlap >= 4) return 4;
  if (overlap >= 3) return 3;
  if (overlap >= 2) return 2;
  return 0;
}

function meaningfulTokenOverlap(left: CommercialLineItem, right: CommercialLineItem) {
  const leftTokens = new Set(lineTokens(left));
  const rightTokens = new Set(lineTokens(right));
  let overlap = 0;

  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) overlap += 1;
  });

  return overlap;
}

function hasUsableItemCode(value?: string) {
  const compact = compactText(value);
  return compact.length >= 4 ? compact : "";
}

function itemCodeTokens(value: string | undefined, options: { allowNumericOnly: boolean }) {
  const rawTokens = (value ?? "")
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map(normalizeLineToken)
    .filter((token) => token.length >= 4 && /\d/.test(token) && (options.allowNumericOnly || /[a-z]/.test(token)));

  return rawTokens.flatMap((token) => {
    const leadingNumber = token.match(/^\d{4,}/)?.[0];
    const alphaNumericRoot = token.match(/^([a-z]+\d{3,})[a-z]+$/)?.[1];
    return [
      token,
      leadingNumber && leadingNumber !== token ? leadingNumber : null,
      alphaNumericRoot && alphaNumericRoot !== token ? alphaNumericRoot : null,
    ].filter((entry): entry is string => Boolean(entry));
  });
}

function uniqueItemCodeTokens(item: CommercialLineItem) {
  const hsnSac = compactText(item.hsnSac);
  return [
    ...new Set([
      ...itemCodeTokens(item.itemCode, { allowNumericOnly: true }),
      ...itemCodeTokens(item.description, { allowNumericOnly: false }),
      ...itemCodeTokens(stripLeadingLineNumber(item.rawText ?? ""), { allowNumericOnly: false }),
    ]),
  ].filter((token) => token !== hsnSac);
}

function countTokenOverlap(left: Iterable<string>, right: Iterable<string>) {
  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of left) {
    if (rightSet.has(token)) overlap += 1;
  }
  return overlap;
}

function distinctiveTextTokens(value?: string) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map(normalizeLineToken)
    .filter((token) => token.length > 2 && !GENERIC_LINE_TOKENS.has(token));
}

function hasDistinctiveDescriptionOverlap(left?: string, right?: string) {
  return countTokenOverlap(distinctiveTextTokens(left), distinctiveTextTokens(right)) >= 1;
}

function parseNumber(value?: string | number | null) {
  if (value === null || value === undefined) return null;
  const compact = String(value).replace(/[₹$€£,\s]/g, "");
  const match = compact.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUnit(value?: string) {
  const compact = compactText(value);
  if (["ea", "each", "nos", "no", "nr", "number", "numbers", "pcs", "piece", "pieces", "pc", "cyl", "cylinder", "cylinders"].includes(compact)) return "nos";
  if (["kg", "kgs", "kilogram", "kilograms"].includes(compact)) return "kg";
  if (["mt", "mts", "mton", "mtons", "metricton", "metrictons", "metrictonne", "metrictonnes", "tonne", "tonnes"].includes(compact)) return "mt";
  if (["set", "sets"].includes(compact)) return "set";
  if (["ltr", "liter", "litre", "liters", "litres"].includes(compact)) return "ltr";
  return compact;
}

function unitFactorToBase(unit?: string) {
  const normalized = normalizeUnit(unit);
  if (normalized === "kg") return 1;
  if (normalized === "mt") return 1000;
  return null;
}

function areUnitsCompatible(left?: string, right?: string) {
  const leftUnit = normalizeUnit(left);
  const rightUnit = normalizeUnit(right);
  return Boolean(leftUnit && rightUnit && (leftUnit === rightUnit || (unitFactorToBase(leftUnit) && unitFactorToBase(rightUnit))));
}

function convertQuantityToBase(quantity?: string | number | null, unit?: string) {
  const parsed = parseNumber(quantity);
  if (parsed === null) return null;
  const factor = unitFactorToBase(unit);
  return factor ? parsed * factor : parsed;
}

function convertRateToBase(rate?: string | number | null, unit?: string) {
  const parsed = parseNumber(rate);
  if (parsed === null) return null;
  const factor = unitFactorToBase(unit);
  return factor ? parsed / factor : parsed;
}

function isLikelyScaledOcrNumber(left: number | null, right: number | null) {
  if (left === null || right === null || left <= 0 || right <= 0) return false;
  const ratio = Math.max(left, right) / Math.min(left, right);
  return [10, 100, 1000].some((scale) => Math.abs(ratio - scale) <= scale * 0.01);
}

function areHsnSacValuesCompatible(left: string, right: string) {
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (/^\d+$/.test(shorter) && /^\d+$/.test(longer)) {
    return shorter.length >= 2 && longer.startsWith(shorter);
  }
  return shorter.length >= 4 && longer.startsWith(shorter);
}

function lineIdentity(item: CommercialLineItem) {
  const itemCode = compactText(item.itemCode);
  const hsnSac = compactText(item.hsnSac);
  const description = compactText(item.description || item.rawText).slice(0, 48);
  return [itemCode, hsnSac, description].filter(Boolean).join("|");
}

function lineLabel(item: CommercialLineItem, index: number) {
  return item.lineNumber || item.itemCode || item.description || item.rawText || `line ${index + 1}`;
}

function findBestReferenceLine(comparedLine: CommercialLineItem, referenceLines: CommercialLineItem[]) {
  let best: { line: CommercialLineItem; score: number; hasStrongAnchor: boolean } | null = null;
  const comparedIdentity = lineIdentity(comparedLine);
  const comparedDescription = compactText(comparedLine.description || comparedLine.rawText);
  const comparedSearch = lineSearchText(comparedLine);
  const comparedItemCode = hasUsableItemCode(comparedLine.itemCode);
  const comparedItemCodeTokens = uniqueItemCodeTokens(comparedLine);
  const comparedHsn = compactText(comparedLine.hsnSac);
  const comparedUnit = normalizeUnit(comparedLine.unit);
  const comparedRate = parseNumber(comparedLine.rate ?? comparedLine.netRate);
  const comparedBaseRate = convertRateToBase(comparedLine.rate ?? comparedLine.netRate, comparedLine.unit);
  const comparedBaseQuantity = convertQuantityToBase(comparedLine.quantity, comparedLine.unit);
  const comparedLineTotal = parseNumber(comparedLine.lineTotal ?? comparedLine.taxableAmount);

  for (const referenceLine of referenceLines) {
    let score = 0;
    const referenceIdentity = lineIdentity(referenceLine);
    const referenceDescription = compactText(referenceLine.description || referenceLine.rawText);
    const referenceSearch = lineSearchText(referenceLine);
    const referenceItemCode = hasUsableItemCode(referenceLine.itemCode);
    const referenceItemCodeTokens = uniqueItemCodeTokens(referenceLine);
    const referenceHsn = compactText(referenceLine.hsnSac);
    const referenceUnit = normalizeUnit(referenceLine.unit);
    const referenceRate = parseNumber(referenceLine.rate ?? referenceLine.netRate);
    const referenceBaseRate = convertRateToBase(referenceLine.rate ?? referenceLine.netRate, referenceLine.unit);
    const referenceBaseQuantity = convertQuantityToBase(referenceLine.quantity, referenceLine.unit);
    const referenceLineTotal = parseNumber(referenceLine.lineTotal ?? referenceLine.taxableAmount);
    const tokenOverlap = meaningfulTokenOverlap(comparedLine, referenceLine);
    const itemCodeOverlap = countTokenOverlap(comparedItemCodeTokens, referenceItemCodeTokens);
    const bothHaveSpecificItemCodes = comparedItemCodeTokens.length > 0 && referenceItemCodeTokens.length > 0;
    const hasDescriptionAnchor = hasDistinctiveDescriptionOverlap(comparedLine.description, referenceLine.description);
    const hsnCompatible = Boolean(comparedHsn && referenceHsn && areHsnSacValuesCompatible(comparedHsn, referenceHsn));
    const quantityMatches =
      comparedBaseQuantity !== null &&
      referenceBaseQuantity !== null &&
      nearlyEqual(comparedBaseQuantity, referenceBaseQuantity);
    const lineTotalMatches =
      comparedLineTotal !== null && referenceLineTotal !== null && nearlyEqual(comparedLineTotal, referenceLineTotal);
    const directRateMatches =
      comparedRate !== null && referenceRate !== null && Math.abs(comparedRate - referenceRate) <= Math.max(1, referenceRate * 0.01);
    const baseRateMatches =
      comparedBaseRate !== null && referenceBaseRate !== null && nearlyEqual(comparedBaseRate, referenceBaseRate);
    const hasCommercialValueAnchor = hsnCompatible && (lineTotalMatches || (quantityMatches && (directRateMatches || baseRateMatches)));
    let hasStrongAnchor = false;

    if (bothHaveSpecificItemCodes && itemCodeOverlap === 0 && !hasDescriptionAnchor && tokenOverlap < 2 && !hasCommercialValueAnchor) {
      continue;
    }

    if (comparedIdentity && referenceIdentity && comparedIdentity === referenceIdentity) {
      score += 6;
      hasStrongAnchor = true;
    }
    if (itemCodeOverlap > 0) {
      score += 6 + Math.min(itemCodeOverlap, 2);
      hasStrongAnchor = true;
    }
    if (comparedItemCode && referenceItemCode && comparedItemCode === referenceItemCode) {
      score += 5;
      hasStrongAnchor = true;
    }
    if (comparedItemCode && referenceSearch.includes(comparedItemCode)) {
      score += 5;
      hasStrongAnchor = true;
    }
    if (referenceItemCode && comparedSearch.includes(referenceItemCode)) {
      score += 5;
      hasStrongAnchor = true;
    }
    if (hsnCompatible) score += comparedHsn === referenceHsn ? 3 : 2;
    if (hasCommercialValueAnchor) {
      score += 5;
      hasStrongAnchor = true;
    }
    if (comparedUnit && referenceUnit && areUnitsCompatible(comparedUnit, referenceUnit)) score += 1;
    if (directRateMatches) {
      score += 2;
      if (hsnCompatible && (!bothHaveSpecificItemCodes || itemCodeOverlap > 0 || hasDescriptionAnchor)) {
        hasStrongAnchor = true;
      }
    }
    if (baseRateMatches) {
      score += 2;
      if (hsnCompatible && (!bothHaveSpecificItemCodes || itemCodeOverlap > 0 || hasDescriptionAnchor)) {
        hasStrongAnchor = true;
      }
    }
    if (quantityMatches) {
      score += 2;
    }
    if (lineTotalMatches) {
      score += 2;
      if (!bothHaveSpecificItemCodes || itemCodeOverlap > 0 || hasDescriptionAnchor) {
        hasStrongAnchor = true;
      }
    }
    score += tokenOverlapScore(comparedLine, referenceLine);
    if (tokenOverlap >= 2 && (!bothHaveSpecificItemCodes || itemCodeOverlap > 0)) hasStrongAnchor = true;
    if (comparedDescription && referenceDescription && hasDescriptionAnchor) {
      score += 3;
      hasStrongAnchor = true;
    }

    if (!best || score > best.score) {
      best = { line: referenceLine, score, hasStrongAnchor };
    }
  }

  return best && best.score >= 5 && best.hasStrongAnchor ? best.line : null;
}

function nearlyEqual(left: number | null, right: number | null, tolerance = 0.01) {
  if (left === null || right === null) return true;
  return Math.abs(left - right) <= Math.max(tolerance, Math.abs(right) * 0.01);
}

function monetaryAmountsEqual(left: number | null, right: number | null) {
  if (left === null || right === null) return false;
  return Math.abs(left - right) <= Math.max(0.5, Math.abs(right) * 0.002);
}

function buildLineMismatch(
  field: string,
  referenceDoc: CaseDoc,
  comparedDoc: CaseDoc,
  referenceLine: CommercialLineItem | null,
  comparedLine: CommercialLineItem,
  index: number,
  detail: string,
  referenceDetail = detail,
  comparedDetail = detail
): Omit<Mismatch, "analysis" | "fixPlan"> {
  return {
    id: `line-mismatch-${field}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    field,
    values: [
      {
        docId: referenceDoc.id,
        value: referenceLine ? `${lineLabel(referenceLine, index)}: ${referenceDetail}` : `No matching ${referenceDoc.type} line`,
      },
      {
        docId: comparedDoc.id,
        value: `${lineLabel(comparedLine, index)}: ${comparedDetail}`,
      },
    ],
  };
}

function getLineItemDocPriority(doc: CaseDoc) {
  return LINE_ITEM_REFERENCE_PRIORITY[doc.type] ?? 99;
}

function hasSharedLineItemReference(left: CaseDoc, right: CaseDoc) {
  return Boolean(
    areComparableValuesEqual(left.fields.eWayBillNumber, right.fields.eWayBillNumber) ||
      areComparableValuesEqual(left.fields.referencePoNumber, right.fields.poNumber) ||
      areComparableValuesEqual(left.fields.poNumber, right.fields.referencePoNumber) ||
      areComparableValuesEqual(left.fields.referenceInvoiceNumber, right.fields.invoiceNumber) ||
      areComparableValuesEqual(left.fields.invoiceNumber, right.fields.referenceInvoiceNumber)
  );
}

function getBestCandidateDoc(
  comparedDoc: CaseDoc,
  candidateDocs: CaseDoc[],
  predicate: (doc: CaseDoc) => boolean
) {
  const candidates = candidateDocs.filter(predicate);
  if (!candidates.length) return null;

  return [...candidates].sort((left, right) => {
    const leftShared = hasSharedLineItemReference(comparedDoc, left) ? 0 : 1;
    const rightShared = hasSharedLineItemReference(comparedDoc, right) ? 0 : 1;
    if (leftShared !== rightShared) return leftShared - rightShared;

    const priorityDelta = getLineItemDocPriority(left) - getLineItemDocPriority(right);
    if (priorityDelta !== 0) return priorityDelta;

    return (right.lineItems?.length ?? 0) - (left.lineItems?.length ?? 0);
  })[0];
}

function getLineItemReferenceDoc(comparedDoc: CaseDoc, docsWithLineItems: CaseDoc[]) {
  const candidateDocs = docsWithLineItems.filter((doc) => doc.id !== comparedDoc.id);
  if (!candidateDocs.length) return null;

  if (INVOICE_DOC_TYPES.has(comparedDoc.type)) {
    return (
      getBestCandidateDoc(comparedDoc, candidateDocs, (doc) => PURCHASE_DOC_TYPES.has(doc.type)) ??
      getBestCandidateDoc(comparedDoc, candidateDocs, (doc) => !INVOICE_DOC_TYPES.has(doc.type))
    );
  }

  if (!PURCHASE_DOC_TYPES.has(comparedDoc.type)) {
    const invoiceDoc = getBestCandidateDoc(comparedDoc, candidateDocs, (doc) => INVOICE_DOC_TYPES.has(doc.type));
    if (invoiceDoc) return invoiceDoc;
  }

  const purchaseDoc = getBestCandidateDoc(comparedDoc, candidateDocs, (doc) => PURCHASE_DOC_TYPES.has(doc.type));
  if (purchaseDoc && !PURCHASE_DOC_TYPES.has(comparedDoc.type)) return purchaseDoc;

  return getBestCandidateDoc(comparedDoc, candidateDocs, () => true);
}

function shouldSkipUnanchoredEWayInvoiceLineComparison(referenceDoc: CaseDoc, comparedDoc: CaseDoc) {
  return (
    comparedDoc.type === "E-Way Bill" &&
    INVOICE_DOC_TYPES.has(referenceDoc.type) &&
    !hasSharedLineItemReference(comparedDoc, referenceDoc)
  );
}

function getBroadPurchaseLineReferenceDoc(
  comparedDoc: CaseDoc,
  docsWithLineItems: CaseDoc[],
  comparedLine: CommercialLineItem
) {
  if (PURCHASE_DOC_TYPES.has(comparedDoc.type) || !PARTIAL_FULFILLMENT_DOC_TYPES.has(comparedDoc.type)) {
    return null;
  }

  return getBestCandidateDoc(
    comparedDoc,
    docsWithLineItems.filter((doc) => doc.id !== comparedDoc.id),
    (doc) => PURCHASE_DOC_TYPES.has(doc.type) && hasBroadPurchaseOrderCoverage(doc, comparedDoc, comparedLine, doc.lineItems ?? [])
  );
}

function formatLineDocRole(doc: CaseDoc) {
  if (PURCHASE_DOC_TYPES.has(doc.type)) return "PO";
  if (INVOICE_DOC_TYPES.has(doc.type)) return "invoice";
  return doc.type;
}

function compactLineField(value?: string) {
  return compactText(value);
}

function getComparableLineAmountValue(line: CommercialLineItem) {
  return line.taxableAmount ?? line.lineTotal;
}

function isLogisticsSummaryLine(doc: CaseDoc, line: CommercialLineItem) {
  return (
    LOGISTICS_SUMMARY_LINE_DOC_TYPES.has(doc.type) &&
    !line.itemCode &&
    !line.hsnSac &&
    !line.rate &&
    !line.netRate &&
    !line.taxableAmount &&
    !line.lineTotal
  );
}

function hasCommercialLineSignal(line: CommercialLineItem) {
  return Boolean(
    line.hsnSac ||
      line.rate ||
      line.netRate ||
      line.taxableAmount ||
      line.lineTotal ||
      line.taxRate ||
      line.cgstRate ||
      line.sgstRate ||
      line.igstRate ||
      line.taxAmount
  );
}

function isLogisticsOnlyFulfillmentDocument(doc: CaseDoc) {
  if (!FULFILLMENT_LINE_DOC_TYPES.has(doc.type)) return false;

  const text = [
    doc.title,
    doc.sourceFileName,
    doc.sourceHint,
    ...Object.values(doc.fields ?? {}),
    doc.md,
  ]
    .filter(Boolean)
    .join(" ");
  const hasLogisticsSignal =
    /\b(?:lorry\s*receipt|lr\s*(?:no|number)|transporter|transport|lorry|freight|to\s*pay|route|consignor|consignee|vehicle|driver)\b/i.test(
      text
    );
  const hasDocumentCommercialSignal = Boolean(
    doc.fields.subtotal ||
      doc.fields.totalTaxableAmount ||
      doc.fields.taxAmount ||
      doc.fields.totalAmount ||
      doc.fields.hsnSac
  );
  const hasLineCommercialSignal = (doc.lineItems ?? []).some(hasCommercialLineSignal);

  return hasLogisticsSignal && !hasDocumentCommercialSignal && !hasLineCommercialSignal;
}

function getCountLikeQuantity(quantity?: string | number | null, unit?: string) {
  const parsed = parseNumber(quantity);
  if (parsed === null) return null;

  const normalizedUnit = normalizeUnit(unit);
  if (!normalizedUnit || normalizedUnit === "nos") return parsed;
  return null;
}

function sumCountLikeLineQuantities(lines: CommercialLineItem[] | undefined) {
  let total = 0;
  let count = 0;

  for (const line of lines ?? []) {
    const quantity = getCountLikeQuantity(line.quantity, line.unit);
    if (quantity === null) continue;
    total += quantity;
    count += 1;
  }

  return count > 0 ? total : null;
}

function getFulfillmentDocumentQuantity(doc: CaseDoc) {
  const documentQuantity = getCountLikeQuantity(doc.fields.itemQuantity, doc.fields.unit);
  return documentQuantity ?? sumCountLikeLineQuantities(doc.lineItems);
}

function fulfillmentQuantityReconcilesWithReference(docs: CaseDoc[], referenceDoc: CaseDoc) {
  if (!INVOICE_DOC_TYPES.has(referenceDoc.type)) return false;

  const referenceQuantity = sumCountLikeLineQuantities(referenceDoc.lineItems);
  if (referenceQuantity === null) return false;

  let fulfillmentQuantity = 0;
  let fulfillmentDocCount = 0;

  for (const doc of docs) {
    if (!FULFILLMENT_LINE_DOC_TYPES.has(doc.type)) continue;
    if (isLogisticsOnlyFulfillmentDocument(doc)) continue;
    const quantity = getFulfillmentDocumentQuantity(doc);
    if (quantity === null) continue;
    fulfillmentQuantity += quantity;
    fulfillmentDocCount += 1;
  }

  return fulfillmentDocCount > 0 && nearlyEqual(fulfillmentQuantity, referenceQuantity);
}

function hasStrongLineAnchorAgainstReference(line: CommercialLineItem, referenceLines: CommercialLineItem[]) {
  if (line.hsnSac || line.rate || line.netRate || line.taxableAmount || line.lineTotal) return true;
  if (hasUsableItemCode(line.itemCode)) return true;
  return referenceLines.some((referenceLine) => meaningfulTokenOverlap(line, referenceLine) >= 1);
}

function shouldIgnoreWeakFulfillmentLineMismatch(
  docs: CaseDoc[],
  referenceDoc: CaseDoc,
  comparedDoc: CaseDoc,
  comparedLine: CommercialLineItem,
  referenceLines: CommercialLineItem[]
) {
  return (
    FULFILLMENT_LINE_DOC_TYPES.has(comparedDoc.type) &&
    INVOICE_DOC_TYPES.has(referenceDoc.type) &&
    !hasStrongLineAnchorAgainstReference(comparedLine, referenceLines) &&
    fulfillmentQuantityReconcilesWithReference(docs, referenceDoc)
  );
}

function isCommercialChargeLine(line: CommercialLineItem) {
  return COMMERCIAL_CHARGE_LINE_PATTERN.test([line.description, line.rawText].filter(Boolean).join(" "));
}

function isSupplementalInvoiceChargeLine(line: CommercialLineItem) {
  const context = [line.description, line.rawText].filter(Boolean).join(" ");
  return (
    isCommercialChargeLine(line) ||
    (!line.quantity && !line.rate && !line.netRate && /\bcharges?\b/i.test(context))
  );
}

function documentMentionsChargeAllowance(doc: CaseDoc) {
  const fieldText = Object.values(doc.fields ?? {}).filter(Boolean).join(" ");
  return COMMERCIAL_CHARGE_LINE_PATTERN.test(`${fieldText} ${doc.md ?? ""}`);
}

function lineContext(line: CommercialLineItem) {
  return [line.itemCode, line.description, line.rawText].filter(Boolean).join(" ");
}

function isBroadPurchaseOrderLine(line: CommercialLineItem) {
  const context = lineContext(line);
  return BROAD_PURCHASE_LINE_PATTERN.test(context) && !hasUsableItemCode(line.itemCode);
}

function isBroadPackageUnit(unit?: string) {
  return ["lot", "set"].includes(normalizeUnit(unit));
}

function hasBroadPurchaseOrderCoverage(
  referenceDoc: CaseDoc,
  comparedDoc: CaseDoc,
  comparedLine: CommercialLineItem,
  referenceLines: CommercialLineItem[]
) {
  if (!PURCHASE_DOC_TYPES.has(referenceDoc.type) || !PARTIAL_FULFILLMENT_DOC_TYPES.has(comparedDoc.type)) {
    return false;
  }

  const broadReferenceLines = referenceLines.filter(isBroadPurchaseOrderLine);
  if (!broadReferenceLines.length) return false;

  const comparedAmount = parseNumber(getComparableLineAmountValue(comparedLine));
  const comparedQty = convertQuantityToBase(comparedLine.quantity, comparedLine.unit) ?? parseNumber(comparedLine.quantity);

  return broadReferenceLines.some((referenceLine) => {
    const referenceAmount = parseNumber(getComparableLineAmountValue(referenceLine));
    const referenceQty = convertQuantityToBase(referenceLine.quantity, referenceLine.unit) ?? parseNumber(referenceLine.quantity);
    const productOverlap = meaningfulTokenOverlap(comparedLine, referenceLine);
    const amountWithinPo =
      comparedAmount !== null &&
      referenceAmount !== null &&
      comparedAmount > 0 &&
      comparedAmount <= referenceAmount * 1.01;
    const amountCompatible =
      comparedAmount === null ||
      referenceAmount === null ||
      comparedAmount <= referenceAmount * 1.01;
    const quantityWithinPo =
      comparedQty === null ||
      referenceQty === null ||
      (comparedAmount === null && isBroadPackageUnit(referenceLine.unit)) ||
      comparedQty <= referenceQty * 1.01;

    if (amountWithinPo && quantityWithinPo) return true;
    if (productOverlap > 0 && amountCompatible && quantityWithinPo) return true;
    return comparedAmount === null && quantityWithinPo;
  });
}

function hasGroupedEWayBaseAnchor(comparedLine: CommercialLineItem, referenceLine: CommercialLineItem) {
  const comparedHsn = compactLineField(comparedLine.hsnSac);
  const referenceHsn = compactLineField(referenceLine.hsnSac);
  const hsnMatches = Boolean(
    comparedHsn &&
      referenceHsn &&
      areHsnSacValuesCompatible(comparedHsn, referenceHsn)
  );
  const comparedQuantity = convertQuantityToBase(comparedLine.quantity, comparedLine.unit);
  const referenceQuantity = convertQuantityToBase(referenceLine.quantity, referenceLine.unit);
  const quantityMatches =
    comparedQuantity !== null &&
    referenceQuantity !== null &&
    monetaryAmountsEqual(comparedQuantity, referenceQuantity);
  const comparedRate = convertRateToBase(comparedLine.rate ?? comparedLine.netRate, comparedLine.unit);
  const referenceRate = convertRateToBase(referenceLine.rate ?? referenceLine.netRate, referenceLine.unit);
  const rateMatches = comparedRate !== null && referenceRate !== null && monetaryAmountsEqual(comparedRate, referenceRate);
  const tokenOverlap = meaningfulTokenOverlap(comparedLine, referenceLine);

  return (hsnMatches && (quantityMatches || rateMatches || tokenOverlap >= 1)) || tokenOverlap >= 2;
}

function hasSupplementalChargeAmountCombination(
  referenceLines: CommercialLineItem[],
  baseLine: CommercialLineItem,
  residualAmount: number
) {
  if (residualAmount <= 0 || monetaryAmountsEqual(residualAmount, 0)) return false;

  const candidates = referenceLines
    .filter((line) => line !== baseLine && isSupplementalInvoiceChargeLine(line))
    .map((line) => parseNumber(getComparableLineAmountValue(line)))
    .filter((amount): amount is number => amount !== null && amount > 0 && amount <= residualAmount + Math.max(0.5, residualAmount * 0.002))
    .sort((left, right) => right - left)
    .slice(0, 8);

  function search(index: number, total: number): boolean {
    if (monetaryAmountsEqual(total, residualAmount)) return true;
    if (index >= candidates.length || total > residualAmount + Math.max(0.5, residualAmount * 0.002)) return false;
    return search(index + 1, total + candidates[index]) || search(index + 1, total);
  }

  return search(0, 0);
}

function isEWayInvoiceGroupedAmountMatch(
  referenceDoc: CaseDoc,
  comparedDoc: CaseDoc,
  comparedLine: CommercialLineItem,
  referenceLine: CommercialLineItem,
  referenceLines: CommercialLineItem[]
) {
  if (comparedDoc.type !== "E-Way Bill" || !INVOICE_DOC_TYPES.has(referenceDoc.type)) return false;
  if (!hasGroupedEWayBaseAnchor(comparedLine, referenceLine)) return false;

  const comparedAmount = parseNumber(getComparableLineAmountValue(comparedLine));
  const referenceAmount = parseNumber(getComparableLineAmountValue(referenceLine));
  if (comparedAmount === null || referenceAmount === null || comparedAmount <= referenceAmount) return false;

  return hasSupplementalChargeAmountCombination(referenceLines, referenceLine, comparedAmount - referenceAmount);
}

function findGroupedEWayReferenceLine(
  referenceDoc: CaseDoc,
  comparedDoc: CaseDoc,
  comparedLine: CommercialLineItem,
  referenceLines: CommercialLineItem[]
) {
  if (comparedDoc.type !== "E-Way Bill" || !INVOICE_DOC_TYPES.has(referenceDoc.type)) return null;

  return (
    referenceLines.find((referenceLine) =>
      !isSupplementalInvoiceChargeLine(referenceLine) &&
      isEWayInvoiceGroupedAmountMatch(referenceDoc, comparedDoc, comparedLine, referenceLine, referenceLines)
    ) ?? null
  );
}

function verifyCommercialLineItems(docs: CaseDoc[]): Omit<Mismatch, "analysis" | "fixPlan">[] {
  const docsWithLineItems = docs.filter(
    (doc) =>
      doc.lineItems?.length &&
      COMMERCIAL_LINE_ITEM_COMPARISON_DOC_TYPES.has(doc.type) &&
      !isLogisticsOnlyFulfillmentDocument(doc)
  );
  const mismatches: Omit<Mismatch, "analysis" | "fixPlan">[] = [];

  if (docsWithLineItems.length < 2) {
    return mismatches;
  }

  const baselineDoc = [...docsWithLineItems].sort((left, right) => {
    const priorityDelta = getLineItemDocPriority(left) - getLineItemDocPriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    return (right.lineItems?.length ?? 0) - (left.lineItems?.length ?? 0);
  })[0];

  for (const comparedDoc of docsWithLineItems) {
    if (comparedDoc.id === baselineDoc.id) continue;

    const comparedRole = formatLineDocRole(comparedDoc);
    const defaultReferenceDoc = getLineItemReferenceDoc(comparedDoc, docsWithLineItems);

    for (const [index, comparedLine] of (comparedDoc.lineItems ?? []).entries()) {
      const referenceDoc =
        getBroadPurchaseLineReferenceDoc(comparedDoc, docsWithLineItems, comparedLine) ??
        defaultReferenceDoc;
      if (!referenceDoc) continue;
      if (shouldSkipUnanchoredEWayInvoiceLineComparison(referenceDoc, comparedDoc)) continue;

      const referenceLines = referenceDoc.lineItems ?? [];
      const referenceRole = formatLineDocRole(referenceDoc);
      const referenceLine =
        findBestReferenceLine(comparedLine, referenceLines) ??
        findGroupedEWayReferenceLine(referenceDoc, comparedDoc, comparedLine, referenceLines);
      if (!referenceLine) {
        if (
          isLogisticsSummaryLine(comparedDoc, comparedLine) ||
          shouldIgnoreWeakFulfillmentLineMismatch(docs, referenceDoc, comparedDoc, comparedLine, referenceLines) ||
          hasBroadPurchaseOrderCoverage(referenceDoc, comparedDoc, comparedLine, referenceLines) ||
          (PURCHASE_DOC_TYPES.has(referenceDoc.type) &&
            isCommercialChargeLine(comparedLine) &&
            documentMentionsChargeAllowance(referenceDoc))
        ) {
          continue;
        }

        mismatches.push(
          buildLineMismatch(
            "lineItems.unmatchedDocumentLine",
            referenceDoc,
            comparedDoc,
            null,
            comparedLine,
            index,
            `${comparedRole} line has no confident ${referenceRole} line match`
          )
        );
        continue;
      }

      if (hasBroadPurchaseOrderCoverage(referenceDoc, comparedDoc, comparedLine, [referenceLine])) {
        continue;
      }

      const comparedQty = parseNumber(comparedLine.quantity);
      const referenceQty = parseNumber(referenceLine.quantity);
      const comparedBaseQty = convertQuantityToBase(comparedLine.quantity, comparedLine.unit) ?? comparedQty;
      const referenceBaseQty = convertQuantityToBase(referenceLine.quantity, referenceLine.unit) ?? referenceQty;
      const comparedLineAmountValue = getComparableLineAmountValue(comparedLine);
      const referenceLineAmountValue = getComparableLineAmountValue(referenceLine);
      const comparedLineAmount = parseNumber(comparedLineAmountValue);
      const referenceLineAmount = parseNumber(referenceLineAmountValue);
      const groupedAmountMatch = isEWayInvoiceGroupedAmountMatch(
        referenceDoc,
        comparedDoc,
        comparedLine,
        referenceLine,
        referenceLines
      );
      const lineAmountsAgree =
        nearlyEqual(comparedLineAmount, referenceLineAmount) ||
        isLikelyScaledOcrNumber(comparedLineAmount, referenceLineAmount) ||
        groupedAmountMatch;
      const quantitiesAgree =
        comparedBaseQty === null ||
        referenceBaseQty === null ||
        nearlyEqual(comparedBaseQty, referenceBaseQty);
      if (
        comparedBaseQty !== null &&
        referenceBaseQty !== null &&
        PURCHASE_DOC_TYPES.has(referenceDoc.type) &&
        !PURCHASE_DOC_TYPES.has(comparedDoc.type) &&
        comparedBaseQty > referenceBaseQty * 1.01
      ) {
        mismatches.push(
          buildLineMismatch(
            "lineItems.quantityExceeded",
            referenceDoc,
            comparedDoc,
            referenceLine,
            comparedLine,
            index,
            `${comparedRole} quantity ${comparedLine.quantity} exceeds ${referenceRole} quantity ${referenceLine.quantity}`,
            `${referenceRole} quantity ${referenceLine.quantity}`,
            `${comparedRole} quantity ${comparedLine.quantity}`
          )
        );
      } else if (
        comparedBaseQty !== null &&
        referenceBaseQty !== null &&
        !PURCHASE_DOC_TYPES.has(referenceDoc.type) &&
        !nearlyEqual(comparedBaseQty, referenceBaseQty)
      ) {
        mismatches.push(
          buildLineMismatch(
            "lineItems.quantityMismatch",
            referenceDoc,
            comparedDoc,
            referenceLine,
            comparedLine,
            index,
            `${comparedRole} quantity ${comparedLine.quantity} differs from ${referenceRole} quantity ${referenceLine.quantity}`,
            `${referenceRole} quantity ${referenceLine.quantity}`,
            `${comparedRole} quantity ${comparedLine.quantity}`
          )
        );
      }

      const comparedRateValue = comparedLine.rate ?? comparedLine.netRate;
      const referenceRateValue = referenceLine.rate ?? referenceLine.netRate;
      const comparedRate = convertRateToBase(comparedRateValue, comparedLine.unit) ?? parseNumber(comparedRateValue);
      const referenceRate = convertRateToBase(referenceRateValue, referenceLine.unit) ?? parseNumber(referenceRateValue);
      if (
        !(lineAmountsAgree && quantitiesAgree) &&
        !nearlyEqual(comparedRate, referenceRate) &&
        !isLikelyScaledOcrNumber(comparedRate, referenceRate)
      ) {
        mismatches.push(
          buildLineMismatch(
            "lineItems.rateMismatch",
            referenceDoc,
            comparedDoc,
            referenceLine,
            comparedLine,
            index,
            `${comparedRole} rate ${comparedRateValue} differs from ${referenceRole} rate ${referenceRateValue}`,
            `${referenceRole} rate ${referenceRateValue}`,
            `${comparedRole} rate ${comparedRateValue}`
          )
        );
      }

      const comparedUnit = normalizeUnit(comparedLine.unit);
      const referenceUnit = normalizeUnit(referenceLine.unit);
      if (comparedUnit && referenceUnit && !areUnitsCompatible(comparedUnit, referenceUnit)) {
        mismatches.push(
          buildLineMismatch(
            "lineItems.unitMismatch",
            referenceDoc,
            comparedDoc,
            referenceLine,
            comparedLine,
            index,
            `${comparedRole} unit ${comparedLine.unit} differs from ${referenceRole} unit ${referenceLine.unit}`,
            `${referenceRole} unit ${referenceLine.unit}`,
            `${comparedRole} unit ${comparedLine.unit}`
          )
        );
      }

      const comparedHsnSac = compactLineField(comparedLine.hsnSac);
      const referenceHsnSac = compactLineField(referenceLine.hsnSac);
      if (comparedHsnSac && referenceHsnSac && !areHsnSacValuesCompatible(comparedHsnSac, referenceHsnSac)) {
        mismatches.push(
          buildLineMismatch(
            "lineItems.hsnSacMismatch",
            referenceDoc,
            comparedDoc,
            referenceLine,
            comparedLine,
            index,
            `${comparedRole} HSN/SAC ${comparedLine.hsnSac} differs from ${referenceRole} HSN/SAC ${referenceLine.hsnSac}`,
            `${referenceRole} HSN/SAC ${referenceLine.hsnSac}`,
            `${comparedRole} HSN/SAC ${comparedLine.hsnSac}`
          )
        );
      }

      const shouldCompareLineAmount =
        !PURCHASE_DOC_TYPES.has(referenceDoc.type) ||
        comparedBaseQty === null ||
        referenceBaseQty === null ||
        nearlyEqual(comparedBaseQty, referenceBaseQty);
      if (
        shouldCompareLineAmount &&
        !lineAmountsAgree
      ) {
        mismatches.push(
          buildLineMismatch(
            "lineItems.amountMismatch",
            referenceDoc,
            comparedDoc,
            referenceLine,
            comparedLine,
            index,
            `${comparedRole} line amount ${comparedLineAmountValue} differs from ${referenceRole} line amount ${referenceLineAmountValue}`,
            `${referenceRole} line amount ${referenceLineAmountValue}`,
            `${comparedRole} line amount ${comparedLineAmountValue}`
          )
        );
      }
    }
  }

  return mismatches;
}

export function verifyCaseDocuments(
  docs: CaseDoc[],
  comparisonOptions: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
): Omit<Mismatch, "analysis" | "fixPlan">[] {
  const mismatches: Omit<Mismatch, "analysis" | "fixPlan">[] = [];

  for (const field of PRIMARY_COMPARISON_FIELDS) {
    const docTypesWithField = [...new Set(docs.map(d => d.type))];
    const shouldCheck = docTypesWithField.some(dt => shouldConsiderFieldKey(field, dt));
    if (!shouldCheck) continue;
    
    const mismatch = buildMismatch(field, docs, comparisonOptions);
    if (mismatch) mismatches.push(mismatch);
  }

  return [...mismatches, ...verifyEWayBillValidity(docs), ...verifyCommercialLineItems(docs)];
}

export function verifyGroupedCaseDocuments(
  docs: CaseDoc[],
  comparisonOptions: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
): GroupedVerificationResult {
  const groups = groupDocumentsForVerification(docs, comparisonOptions);
  const mismatches = groups.flatMap(({ docs: groupDocs, group }) => {
    const comparisonDocs = documentsForRoleSelectedComparison(groupDocs, group.roleSelection ?? null);
    if (comparisonDocs.length < 2) return [];
    return verifyCaseDocuments(comparisonDocs, comparisonOptions).map((mismatch) => ({
      ...mismatch,
      id: `${group.groupId}-${mismatch.id}`,
    }));
  });

  return {
    groups: groups.map(({ group }) => group),
    mismatches,
  };
}

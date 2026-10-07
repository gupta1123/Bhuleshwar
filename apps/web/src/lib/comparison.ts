import type { CaseDoc, ComparisonOptions, DocType, FieldKey } from "@/types/pipeline";

export const DEFAULT_COMPARISON_OPTIONS: ComparisonOptions = {
  considerFormatting: false,
};

const PAYMENT_EVIDENCE_DOC_TYPES = new Set<DocType>([
  "Receipt",
  "FASTag Toll Proof",
  "Bank Statement",
  "Payment Screenshot",
]);

const ROUTE_SOURCE_DOC_TYPES = new Set<DocType>([
  "Delivery Challan",
  "Lorry Receipt",
  "Map Printout",
]);

const PURCHASE_ORDER_DOC_TYPES = new Set<DocType>(["Purchase Order", "Amended Purchase Order"]);
const VEHICLE_REGISTRATION_DOC_TYPES = new Set<DocType>(["Vehicle Registration Certificate"]);

const COMPARISON_FIELD_ALIASES: Partial<Record<FieldKey, FieldKey>> = {
  referencePoNumber: "poNumber",
  referenceInvoiceNumber: "invoiceNumber",
  registrationNumber: "vehicleNumber",
  routeFrom: "dispatchFrom",
  routeTo: "shipTo",
};

const COMPARISON_FIELD_LABELS: Partial<Record<FieldKey, string>> = {
  poNumber: "PO Reference",
  invoiceNumber: "Invoice Reference",
  totalAmount: "Commercial / Payment Amount",
  vehicleNumber: "Vehicle / Registration Number",
  dispatchFrom: "Origin / Dispatch From",
  shipTo: "Destination / Ship To",
  subtotal: "Taxable / Basic Amount",
};

export const PRIMARY_COMPARISON_FIELDS: FieldKey[] = [
  "vendorName",
  "supplierGstin",
  "buyerName",
  "buyerGstin",
  "poNumber",
  "invoiceNumber",
  "receiptNumber",
  "deliveryNoteNumber",
  "eWayBillNumber",
  "weighmentNumber",
  "lorryReceiptNumber",
  "certificateNumber",
  "permitNumber",
  "permitType",
  "licenseNumber",
  "chassisNumber",
  "engineNumber",
  "vehicleClass",
  "vehicleNumber",
  "fuelType",
  "currency",
  "subtotal",
  "taxAmount",
  "totalAmount",
  "freightAmount",
  "advanceAmount",
  "toPayAmount",
  "materialGrade",
  "itemQuantity",
  "unit",
  "hsnSac",
  "batchNumber",
  "heatNumber",
  "grossWeight",
  "tareWeight",
  "netWeight",
  "bankName",
  "accountNumber",
  "transactionReference",
  "fastagReference",
  "tollPlaza",
  "mapLocation",
  "ownerName",
  "transporterName",
  "driverName",
  "panNumber",
  "evidenceDescription",
];

const PRIMARY_COMPARISON_FIELD_SET = new Set<string>(PRIMARY_COMPARISON_FIELDS);

type ComparableDoc = Pick<CaseDoc, "type" | "fields">;

const GSTIN_FIELDS = new Set<FieldKey>(["supplierGstin", "buyerGstin"]);
const GSTIN_DIGIT_INDICES = new Set([0, 1, 7, 8, 9, 10, 12]);
const FORMAT_INSENSITIVE_IDENTIFIER_FIELDS = new Set<FieldKey>([
  "poNumber",
  "referencePoNumber",
  "invoiceNumber",
  "referenceInvoiceNumber",
  "eWayBillNumber",
  "weighmentNumber",
  "lorryReceiptNumber",
  "certificateNumber",
  "permitNumber",
  "licenseNumber",
  "chassisNumber",
  "engineNumber",
  "vehicleNumber",
  "registrationNumber",
  "fastagReference",
  "transactionReference",
]);
const AMOUNT_FIELDS = new Set<FieldKey>([
  "subtotal",
  "taxAmount",
  "totalAmount",
  "paidAmount",
  "statementAmount",
  "freightAmount",
  "advanceAmount",
  "toPayAmount",
  "openingBalance",
  "creditAmount",
  "debitAmount",
  "closingBalance",
]);
const WEIGHT_FIELDS = new Set<FieldKey>(["grossWeight", "tareWeight", "netWeight"]);
const COUNT_UNIT_VALUES = new Set(["nos", "no", "number", "numbers", "pcs", "piece", "pieces", "pc"]);

function parseNumericValue(value: string) {
  const compact = value.replace(/[₹$€£,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(compact)) {
    return null;
  }

  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNumericLikeValue(value: string) {
  const parsed = parseNumericValue(value);
  return parsed === null ? null : parsed.toString();
}

function normalizeCurrencyLikeValue(value: string) {
  if (/[₹$€£]/.test(value)) {
    return "inr";
  }

  const compact = value.replace(/[^a-z]/g, "");
  if (["inr", "rs", "rupee", "rupees", "indianrupee", "indianrupees"].includes(compact)) {
    return "inr";
  }
  return null;
}

function normalizeGstinValue(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!compact) return null;

  const normalized = compact
    .split("")
    .map((character, index) => {
      if (!GSTIN_DIGIT_INDICES.has(index)) return character;
      if (character === "I" || character === "L") return "1";
      if (character === "O" || character === "Q") return "0";
      if (character === "S") return "5";
      if (character === "B") return "8";
      return character;
    })
    .join("");

  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(normalized)
    ? normalized
    : null;
}

function normalizeUnitValue(value: string) {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (COUNT_UNIT_VALUES.has(compact) || ["cyl", "cylinder", "cylinders"].includes(compact)) return "nos";
  if (["kg", "kgs", "kilogram", "kilograms"].includes(compact)) return "kg";
  if (["mt", "mts", "mton", "mtons", "metricton", "metrictons", "metrictonne", "metrictonnes", "tonne", "tonnes"].includes(compact)) return "mt";
  return compact || null;
}

function normalizeIdentifierValue(value: string) {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact || null;
}

function normalizeInvoiceReferenceValue(value: string) {
  const compact = normalizeIdentifierValue(value);
  if (!compact) return null;
  const withoutDocumentLabel = compact.replace(/^(?:taxinvoice|invoice|documentno|docno|document)(?=[a-z0-9]*\d)/, "");
  return withoutDocumentLabel || compact;
}

function getInvoiceSeriesParts(value: string | number | null | undefined, options: ComparisonOptions) {
  const normalized = normalizeComparableValue(value, options, "invoiceNumber");
  if (!normalized) return null;

  const seriesMatch = normalized.match(/^([a-z]{1,12})(\d{6,})$/);
  if (seriesMatch) {
    return {
      normalized,
      series: seriesMatch[1],
      body: seriesMatch[2],
    };
  }

  if (/^\d{6,}$/.test(normalized)) {
    return {
      normalized,
      series: null,
      body: normalized,
    };
  }

  return {
    normalized,
    series: null,
    body: normalized,
  };
}

function areInvoiceReferencesStructurallyEqual(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
  options: ComparisonOptions
) {
  const leftParts = getInvoiceSeriesParts(left, options);
  const rightParts = getInvoiceSeriesParts(right, options);
  if (!leftParts || !rightParts) return false;

  if (leftParts.normalized === rightParts.normalized) return true;

  if (leftParts.series && !rightParts.series) {
    return leftParts.body === rightParts.normalized;
  }

  if (rightParts.series && !leftParts.series) {
    return rightParts.body === leftParts.normalized;
  }

  return false;
}

function normalizeWeightToKg(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;

  const raw = String(value).toLowerCase().trim();
  if (!raw) return null;

  const numericMatch = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!numericMatch) return null;

  const parsed = Number(numericMatch[0]);
  if (!Number.isFinite(parsed)) return null;

  if (/\b(?:m\.?t\.?s?\.?|metric\s*ton(?:ne)?s?|tonnes?|tons?)\b/i.test(raw)) {
    return parsed * 1000;
  }

  return parsed;
}

function isNonComparablePlaceholder(value: string) {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!compact) return true;

  return (
    compact === "na" ||
    compact === "notapplicable" ||
    compact === "notavailable" ||
    compact === "unknown" ||
    compact === "unclear" ||
    compact === "none" ||
    compact === "nil" ||
    compact === "illegible" ||
    compact === "unreadable" ||
    compact.includes("notvisible") ||
    compact.includes("notclearlyvisible") ||
    compact.includes("numbernotvisible") ||
    compact.includes("platenotvisible")
  );
}

export function normalizeComparableValue(
  value: string | number | null | undefined,
  options: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS,
  fieldKey?: FieldKey
) {
  if (value == null) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  if (isNonComparablePlaceholder(raw)) return null;

  const lowerCased = raw.toLowerCase();

  if (fieldKey && GSTIN_FIELDS.has(fieldKey)) {
    return normalizeGstinValue(raw);
  }

  if (fieldKey === "unit") {
    return normalizeUnitValue(raw);
  }

  if (fieldKey === "invoiceNumber" || fieldKey === "referenceInvoiceNumber") {
    return normalizeInvoiceReferenceValue(raw);
  }

  const numericNormalized = normalizeNumericLikeValue(lowerCased);

  if (numericNormalized !== null) {
    return numericNormalized;
  }

  if (fieldKey && FORMAT_INSENSITIVE_IDENTIFIER_FIELDS.has(fieldKey)) {
    return normalizeIdentifierValue(raw);
  }

  const currencyNormalized = normalizeCurrencyLikeValue(lowerCased);
  if (currencyNormalized !== null) {
    return currencyNormalized;
  }

  if (options.considerFormatting) {
    return lowerCased.replace(/\s+/g, " ").trim();
  }

  return lowerCased.replace(/[^a-z0-9]/g, "");
}

export function areComparableValuesEqual(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
  options: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS,
  fieldKey?: FieldKey
) {
  if (fieldKey && (AMOUNT_FIELDS.has(fieldKey) || WEIGHT_FIELDS.has(fieldKey))) {
    if (WEIGHT_FIELDS.has(fieldKey)) {
      const leftWeight = normalizeWeightToKg(left);
      const rightWeight = normalizeWeightToKg(right);
      if (leftWeight !== null && rightWeight !== null) {
        return Math.abs(leftWeight - rightWeight) <= Math.max(5, Math.abs(rightWeight) * 0.005);
      }
    }

    const leftNumber = parseNumericValue(String(left ?? "").toLowerCase());
    const rightNumber = parseNumericValue(String(right ?? "").toLowerCase());

    if (leftNumber !== null && rightNumber !== null) {
      const directTolerance = AMOUNT_FIELDS.has(fieldKey) ? 1 : 0.01;
      if (Math.abs(leftNumber - rightNumber) <= Math.max(directTolerance, Math.abs(rightNumber) * 0.001)) {
        return true;
      }

      if (fieldKey === "taxAmount") {
        return (
          Math.abs(leftNumber * 2 - rightNumber) <= Math.max(1, Math.abs(rightNumber) * 0.001) ||
          Math.abs(leftNumber - rightNumber * 2) <= Math.max(1, Math.abs(leftNumber) * 0.001)
        );
      }
    }
  }

  const normalizedLeft = normalizeComparableValue(left, options, fieldKey);
  const normalizedRight = normalizeComparableValue(right, options, fieldKey);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  if (normalizedLeft === normalizedRight) return true;

  if (
    (fieldKey === "invoiceNumber" || fieldKey === "referenceInvoiceNumber") &&
    areInvoiceReferencesStructurallyEqual(left, right, options)
  ) {
    return true;
  }

  const splitIdentifierList = (value: string | number | null | undefined) =>
    String(value ?? "")
      .split(/(?:,|;|\||\+|\band\b)/i)
      .map((part) => normalizeComparableValue(part, options, fieldKey))
      .filter((part): part is string => Boolean(part));

  if (
    fieldKey &&
    FORMAT_INSENSITIVE_IDENTIFIER_FIELDS.has(fieldKey) &&
    (/[;,|+]|\band\b/i.test(String(left ?? "")) || /[;,|+]|\band\b/i.test(String(right ?? "")))
  ) {
    const leftParts = splitIdentifierList(left);
    const rightParts = splitIdentifierList(right);
    if (leftParts.length && rightParts.length) {
      return leftParts.some((leftPart) => rightParts.includes(leftPart));
    }
  }

  return false;
}

export function pickCanonicalComparableValue(
  values: Array<string | number>,
  options: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
) {
  const counts = new Map<string, number>();

  for (const value of values) {
    const normalized = normalizeComparableValue(value, options);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;

  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }

  const match =
    values.find((value) => normalizeComparableValue(value, options) === best) ??
    values.find((value) => Boolean(normalizeComparableValue(value, options)));

  return match == null ? "" : String(match);
}

export function getComparisonFieldKey(fieldKey: FieldKey) {
  return COMPARISON_FIELD_ALIASES[fieldKey] ?? fieldKey;
}

export function isPrimaryComparisonField(fieldKey: string) {
  const canonicalField = getComparisonFieldKey(fieldKey as FieldKey);
  return PRIMARY_COMPARISON_FIELD_SET.has(canonicalField);
}

export function getComparisonDisplayLabel(fieldKey: string, fallback?: string) {
  return COMPARISON_FIELD_LABELS[fieldKey as FieldKey] ?? fallback ?? fieldKey;
}

export function getComparableFieldValue(doc: ComparableDoc, fieldKey: FieldKey) {
  const canonicalField = getComparisonFieldKey(fieldKey);

  switch (canonicalField) {
    case "poNumber":
      return PURCHASE_ORDER_DOC_TYPES.has(doc.type)
        ? doc.fields.poNumber ?? doc.fields.referencePoNumber
        : doc.fields.referencePoNumber ?? doc.fields.poNumber;
    case "invoiceNumber":
      return PAYMENT_EVIDENCE_DOC_TYPES.has(doc.type)
        ? doc.fields.referenceInvoiceNumber ?? doc.fields.invoiceNumber
        : doc.fields.invoiceNumber ?? doc.fields.referenceInvoiceNumber;
    case "totalAmount": {
      if (
        doc.type === "E-Way Bill" &&
        doc.fields.totalAmount &&
        (doc.fields.totalTaxableAmount || doc.fields.subtotal) &&
        areComparableValuesEqual(
          doc.fields.totalAmount,
          doc.fields.totalTaxableAmount ?? doc.fields.subtotal,
          DEFAULT_COMPARISON_OPTIONS,
          "totalAmount"
        )
      ) {
        return undefined;
      }
      return doc.fields.totalAmount;
    }
    case "vehicleNumber":
      return VEHICLE_REGISTRATION_DOC_TYPES.has(doc.type)
        ? doc.fields.registrationNumber ?? doc.fields.vehicleNumber
        : doc.fields.vehicleNumber ?? doc.fields.registrationNumber;
    case "dispatchFrom":
      return ROUTE_SOURCE_DOC_TYPES.has(doc.type)
        ? doc.fields.routeFrom ?? doc.fields.dispatchFrom
        : doc.fields.dispatchFrom ?? doc.fields.routeFrom;
    case "shipTo":
      return ROUTE_SOURCE_DOC_TYPES.has(doc.type)
        ? doc.fields.routeTo ?? doc.fields.shipTo
        : doc.fields.shipTo ?? doc.fields.routeTo;
    default:
      return doc.fields[canonicalField];
  }
}

export function getCommercialAmountValue(doc: ComparableDoc) {
  return PAYMENT_EVIDENCE_DOC_TYPES.has(doc.type)
    ? undefined
    : getComparableFieldValue(doc, "totalAmount");
}

export function getPaymentEvidenceAmountValue(doc: ComparableDoc) {
  return doc.fields.paidAmount ?? doc.fields.statementAmount;
}

export function readComparisonOptions(value: unknown): ComparisonOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_COMPARISON_OPTIONS };
  }

  const record = value as Record<string, unknown>;
  return {
    considerFormatting: record.considerFormatting === true,
  };
}

export function getComparisonModeLabel(options: ComparisonOptions) {
  return options.considerFormatting ? "Formatting considered" : "Formatting ignored";
}

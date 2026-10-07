import {
  getEnabledCorePacketGroups,
  isDocTypeEnabled,
  type PacketFieldConfiguration,
} from "@/lib/document-schema";
import type { CaseDoc, DocType, FieldKey, Mismatch } from "@/types/pipeline";

export type CaseSummary = {
  slug: string;
  displayName: string;
  buyerName: string;
  category: string;
  packetCategory: string;
  poNumber: string;
  invoiceNumber: string;
  primaryReference: string;
  paymentGap: number;
  riskScore: number;
  missingDocTypes: string[];
  documentTypes: string[];
};

type ProcessingMetaLike = {
  caseCategory?: unknown;
  packetCategory?: unknown;
  documentTypes?: unknown;
};

const RECEIVER_DOC_WEIGHTS: Partial<Record<DocType, number>> = {
  "Tax Invoice": 6,
  Invoice: 6,
  "Purchase Order": 6,
  "Amended Purchase Order": 6,
  "E-Way Bill": 4,
  "Delivery Note": 4,
  "Delivery Challan": 4,
  "Lorry Receipt": 3,
  "Weighment Slip": 3,
  "Material Test Certificate": 2,
};

const BUYER_COUNTERPARTY_DOC_WEIGHTS: Partial<Record<DocType, number>> = {
  "Tax Invoice": 6,
  Invoice: 6,
  "E-Way Bill": 5,
  "Delivery Note": 5,
  "Delivery Challan": 5,
  "Lorry Receipt": 4,
  Receipt: 3,
};

const VENDOR_COUNTERPARTY_DOC_WEIGHTS: Partial<Record<DocType, number>> = {
  "Purchase Order": 7,
  "Amended Purchase Order": 7,
  "Tax Invoice": 5,
  Invoice: 5,
  "Weighment Slip": 4,
  "Material Test Certificate": 4,
  "Lorry Receipt": 2,
  "Delivery Challan": 2,
};

const RECEIVER_FIELD_PRIORITY_BY_DOC_TYPE: Record<DocType, FieldKey[]> = {
  "Purchase Order": ["vendorName", "buyerName"],
  "Amended Purchase Order": ["vendorName", "buyerName"],
  Invoice: ["buyerName"],
  "Tax Invoice": ["buyerName"],
  Receipt: ["buyerName"],
  "Delivery Note": ["buyerName"],
  "Delivery Challan": ["buyerName"],
  "E-Way Bill": ["buyerName"],
  "Weighment Slip": [],
  "Lorry Receipt": ["buyerName"],
  "Vehicle Registration Certificate": [],
  "Driving Licence": [],
  "PAN Card": [],
  "FASTag Toll Proof": [],
  "Material Test Certificate": [],
  "Photo Evidence": [],
  "Transport Permit": [],
  "Bank Statement": [],
  "Map Printout": [],
  "Payment Screenshot": [],
  Unknown: ["buyerName"],
};

const CASE_SUBJECT_FIELD_PRIORITY_BY_DOC_TYPE: Partial<Record<DocType, FieldKey[]>> = {
  "Vehicle Registration Certificate": ["ownerName"],
  "Driving Licence": ["driverName", "holderName"],
  "PAN Card": ["holderName"],
  "Transport Permit": ["ownerName"],
};

const CASE_CATEGORY_BY_DOC_TYPE: Record<DocType, string> = {
  "Purchase Order": "Purchase packet",
  "Amended Purchase Order": "Purchase packet",
  Invoice: "Commercial packet",
  "Tax Invoice": "Commercial packet",
  Receipt: "Payment packet",
  "Delivery Note": "Logistics packet",
  "Delivery Challan": "Logistics packet",
  "E-Way Bill": "Logistics packet",
  "Weighment Slip": "Weight packet",
  "Lorry Receipt": "Logistics packet",
  "Vehicle Registration Certificate": "Vehicle KYC packet",
  "Driving Licence": "Vehicle KYC packet",
  "PAN Card": "Vehicle KYC packet",
  "FASTag Toll Proof": "Transport proof packet",
  "Material Test Certificate": "Quality packet",
  "Photo Evidence": "Evidence packet",
  "Transport Permit": "Transport proof packet",
  "Bank Statement": "Payment packet",
  "Map Printout": "Route packet",
  "Payment Screenshot": "Payment packet",
  Unknown: "General packet",
};

function normalizeValue(value?: string | null) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizePartyName(value?: string | null) {
  const normalized = normalizeValue(value);
  const matchKey = normalizeMatchKey(normalized);

  if (
    !normalized ||
    normalized.length < 2 ||
    ["na", "notapplicable", "notavailable", "notvisible", "unknown", "none", "nil"].includes(matchKey)
  ) {
    return "";
  }

  return normalized;
}

function normalizeMatchKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function currencyishToNumber(value?: string) {
  if (!value) return undefined;
  const number = Number(value.replace(/[₹,\s]/g, ""));
  return Number.isNaN(number) ? undefined : number;
}

function slugify(value: string, fallback: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return normalized || fallback;
}

function formatSourceDisplayName(value: string) {
  return value
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isGeneratedCaptureDisplayName(value?: string | null) {
  const normalized = normalizeMatchKey(normalizeValue(value));

  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith("cameradocument") ||
    normalized.startsWith("camerascan") ||
    normalized === "newpacketcase"
  );
}

function firstFieldValue(documents: CaseDoc[], field: FieldKey) {
  for (const document of documents) {
    const value = normalizeValue(document.fields[field]);
    if (value) return value;
  }
  return "";
}

type RankedDocumentValue = {
  value: string;
  score: number;
  count: number;
  firstSeenAt: number;
};

function rankWeightedDocumentValues(
  documents: CaseDoc[],
  getValue: (document: CaseDoc) => string,
  getWeight: (document: CaseDoc) => number
) {
  const ranked = new Map<
    string,
    RankedDocumentValue
  >();

  documents.forEach((document, index) => {
    const value = normalizeValue(getValue(document));
    const weight = getWeight(document);
    if (!value || weight <= 0) return;

    const key = normalizeMatchKey(value);
    const current = ranked.get(key);
    if (current) {
      current.score += weight;
      current.count += 1;
      return;
    }

    ranked.set(key, {
      value,
      score: weight,
      count: 1,
      firstSeenAt: index,
    });
  });

  return Array.from(ranked.values()).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.count !== left.count) return right.count - left.count;
    return left.firstSeenAt - right.firstSeenAt;
  });
}

function pickWeightedDocumentValue(
  documents: CaseDoc[],
  getValue: (document: CaseDoc) => string,
  getWeight: (document: CaseDoc) => number
) {
  return rankWeightedDocumentValues(documents, getValue, getWeight)[0]?.value ?? "";
}

function getReceiverWeight(document: CaseDoc) {
  return RECEIVER_DOC_WEIGHTS[document.type] ?? 1;
}

function firstDocumentPartyValue(document: CaseDoc, fields: readonly FieldKey[]) {
  for (const field of fields) {
    const value = normalizePartyName(document.fields[field]);
    if (value) {
      return value;
    }
  }

  return "";
}

function getReceiverCandidate(document: CaseDoc) {
  return firstDocumentPartyValue(
    document,
    RECEIVER_FIELD_PRIORITY_BY_DOC_TYPE[document.type] ?? RECEIVER_FIELD_PRIORITY_BY_DOC_TYPE.Unknown
  );
}

function getCaseSubjectCandidate(document: CaseDoc) {
  return firstDocumentPartyValue(document, CASE_SUBJECT_FIELD_PRIORITY_BY_DOC_TYPE[document.type] ?? []);
}

function getBuyerCounterpartyWeight(document: CaseDoc) {
  return BUYER_COUNTERPARTY_DOC_WEIGHTS[document.type] ?? 0;
}

function getVendorCounterpartyWeight(document: CaseDoc) {
  return VENDOR_COUNTERPARTY_DOC_WEIGHTS[document.type] ?? 0;
}

function derivePreferredCounterpartyName(documents: CaseDoc[]) {
  const buyerCandidate = rankWeightedDocumentValues(
    documents,
    (document) => firstDocumentPartyValue(document, ["buyerName"]),
    getBuyerCounterpartyWeight
  )[0];

  const vendorCandidate = rankWeightedDocumentValues(
    documents,
    (document) => firstDocumentPartyValue(document, ["vendorName"]),
    getVendorCounterpartyWeight
  )[0];

  if (
    buyerCandidate &&
    vendorCandidate &&
    normalizeMatchKey(buyerCandidate.value) !== normalizeMatchKey(vendorCandidate.value)
  ) {
    const buyerStrength = buyerCandidate.score + buyerCandidate.count;
    const vendorStrength = vendorCandidate.score + vendorCandidate.count;

    if (buyerStrength !== vendorStrength) {
      return buyerStrength > vendorStrength ? buyerCandidate.value : vendorCandidate.value;
    }
  }

  return buyerCandidate?.value || vendorCandidate?.value || "";
}

export function deriveCaseReceiverName(documents: CaseDoc[]) {
  const preferredCounterpartyName = derivePreferredCounterpartyName(documents);
  if (preferredCounterpartyName) {
    return preferredCounterpartyName;
  }

  const receiverName = pickWeightedDocumentValue(
    documents,
    getReceiverCandidate,
    getReceiverWeight
  );

  if (receiverName) {
    return receiverName;
  }

  return pickWeightedDocumentValue(
    documents,
    getCaseSubjectCandidate,
    (document) => Math.max(1, getReceiverWeight(document) - 2)
  );
}

function deriveSourceDisplayName(documents: CaseDoc[]) {
  const sourceName = documents
    .map((document) => normalizeValue(document.sourceHint))
    .find((value) => value.length > 0 && !isGeneratedCaptureDisplayName(value));

  return sourceName ? formatSourceDisplayName(sourceName) : "";
}

function derivePrimaryReference(documents: CaseDoc[]) {
  const invoiceReference = pickWeightedDocumentValue(
    documents,
    (document) => normalizeValue(document.fields.invoiceNumber ?? document.fields.referenceInvoiceNumber),
    (document) => (document.type === "Invoice" || document.type === "Tax Invoice" ? 5 : 2)
  );

  if (invoiceReference) {
    return invoiceReference;
  }

  const purchaseReference = pickWeightedDocumentValue(
    documents,
    (document) => normalizeValue(document.fields.poNumber ?? document.fields.referencePoNumber),
    (document) =>
      document.type === "Purchase Order" || document.type === "Amended Purchase Order" ? 5 : 2
  );

  if (purchaseReference) {
    return purchaseReference;
  }

  const referenceFieldPriority: FieldKey[] = [
    "eWayBillNumber",
    "lorryReceiptNumber",
    "weighmentNumber",
    "receiptNumber",
    "certificateNumber",
    "permitNumber",
    "vehicleNumber",
  ];

  for (const field of referenceFieldPriority) {
    const value = firstFieldValue(documents, field);
    if (value) {
      return value;
    }
  }

  return "";
}

function derivePacketCategory(
  documents: CaseDoc[],
  fieldConfiguration?: PacketFieldConfiguration
) {
  if (documents.length === 0) {
    return "Draft case";
  }

  const presentTypes = Array.from(
    new Set(
      documents
        .map((document) => document.type)
        .filter((type) => isDocTypeEnabled(type, fieldConfiguration))
    )
  );

  if (presentTypes.length === 0) {
    return "General packet";
  }
  const presentCategories = Array.from(
    new Set(presentTypes.map((type) => CASE_CATEGORY_BY_DOC_TYPE[type] ?? "General packet"))
  );

  if (presentTypes.length === 1) {
    return presentCategories[0];
  }

  const presentCoreGroups = getEnabledCorePacketGroups(fieldConfiguration).filter((group) =>
    group.types.some((type) => presentTypes.includes(type))
  );

  if (presentCoreGroups.length >= 2) {
    return "Procurement packet";
  }

  if (presentCategories.length === 1) {
    return presentCategories[0];
  }

  return "Mixed document packet";
}

export function resolveCaseCategoryLabel(params: {
  receiverName?: string | null;
  storedCategory?: string | null;
  status?: string | null;
}) {
  const receiverName = normalizeValue(params.receiverName);
  const storedCategory = normalizeValue(params.storedCategory);

  if (receiverName) {
    return `${receiverName} packet`;
  }

  if (params.status === "draft") {
    return "Receiver pending";
  }

  if (storedCategory) {
    return storedCategory;
  }

  return "General packet";
}

export function getCaseCategoryFromProcessingMeta(
  processingMeta: unknown,
  status?: string,
  fallbackDocumentTypes?: string[],
  fieldConfiguration?: PacketFieldConfiguration
) {
  const record =
    processingMeta && typeof processingMeta === "object" && !Array.isArray(processingMeta)
      ? (processingMeta as ProcessingMetaLike)
      : {};

  if (typeof record.caseCategory === "string" && record.caseCategory.trim().length > 0) {
    return record.caseCategory;
  }

  if (typeof record.packetCategory === "string" && record.packetCategory.trim().length > 0) {
    return record.packetCategory;
  }

  const documentTypes = Array.isArray(record.documentTypes)
    ? record.documentTypes.filter((value): value is DocType => typeof value === "string")
    : (fallbackDocumentTypes?.filter((value): value is DocType => typeof value === "string") ?? []);

  if (documentTypes.length > 0) {
    return derivePacketCategory(
      documentTypes.map((type, index) => ({
        id: `${type}-${index}`,
        type,
        title: type,
        pages: 1,
        fields: {},
        md: "",
      })),
      fieldConfiguration
    );
  }

  if (status === "draft") {
    return "Draft case";
  }

  return "General packet";
}

export function resolveStoredCaseDisplayName(params: {
  storedDisplayName?: string | null;
  receiverName?: string | null;
  invoiceNumber?: string | null;
  poNumber?: string | null;
  category?: string | null;
  status?: string | null;
}) {
  const storedDisplayName = normalizeValue(params.storedDisplayName);
  const usableStoredDisplayName = isGeneratedCaptureDisplayName(storedDisplayName)
    ? ""
    : storedDisplayName;
  const receiverName = normalizeValue(params.receiverName);
  const primaryReference =
    normalizeValue(params.invoiceNumber) || normalizeValue(params.poNumber);
  const category = resolveCaseCategoryLabel({
    receiverName,
    storedCategory: params.category,
    status: params.status,
  });

  if (receiverName) {
    return primaryReference ? `${receiverName} / ${primaryReference}` : receiverName;
  }

  if (params.status === "draft") {
    return usableStoredDisplayName ? `Receiver pending / ${usableStoredDisplayName}` : "Receiver pending";
  }

  if (usableStoredDisplayName) {
    return usableStoredDisplayName;
  }

  if (primaryReference) {
    return `${category} / ${primaryReference}`;
  }

  return category;
}

export function summarizeCase(
  documents: CaseDoc[],
  mismatches: Mismatch[],
  fieldConfiguration?: PacketFieldConfiguration
): CaseSummary {
  const buyerName = deriveCaseReceiverName(documents);
  const poNumber = firstFieldValue(documents, "poNumber") || firstFieldValue(documents, "referencePoNumber");
  const invoiceNumber =
    firstFieldValue(documents, "invoiceNumber") || firstFieldValue(documents, "referenceInvoiceNumber");
  const primaryReference = derivePrimaryReference(documents);
  const sourceDisplayName = deriveSourceDisplayName(documents);
  const packetCategory = derivePacketCategory(documents, fieldConfiguration);
  const category = resolveCaseCategoryLabel({
    receiverName: buyerName,
    storedCategory: packetCategory,
  });
  const totalAmount = currencyishToNumber(firstFieldValue(documents, "totalAmount"));
  const paidAmount = currencyishToNumber(firstFieldValue(documents, "paidAmount"));
  const paymentGap = totalAmount && paidAmount ? Math.abs(totalAmount - paidAmount) : 0;

  const presentTypes = new Set(
    documents
      .map((document) => document.type)
      .filter((type) => isDocTypeEnabled(type, fieldConfiguration))
  );
  const missingDocTypes = getEnabledCorePacketGroups(fieldConfiguration)
    .filter((group) => !group.types.some((type) => presentTypes.has(type)))
    .map((group) => group.label);

  const riskScore = Math.min(
    100,
    mismatches.length * 10 + missingDocTypes.length * 12 + (paymentGap > 0 ? 10 : 0)
  );

  const subjectSlug = slugify(buyerName || sourceDisplayName || packetCategory, "packet-case");
  const referenceSlug = slugify(
    primaryReference || buyerName || sourceDisplayName || packetCategory,
    "packet"
  );

  return {
    slug: `${subjectSlug}-${referenceSlug}`,
    displayName: resolveStoredCaseDisplayName({
      storedDisplayName: sourceDisplayName,
      receiverName: buyerName,
      invoiceNumber,
      poNumber,
      category,
    }),
    buyerName,
    category,
    packetCategory,
    poNumber,
    invoiceNumber,
    primaryReference,
    paymentGap,
    riskScore,
    missingDocTypes,
    documentTypes: Array.from(presentTypes),
  };
}

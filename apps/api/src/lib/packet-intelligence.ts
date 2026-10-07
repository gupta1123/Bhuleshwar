export type PacketIntelligenceKind =
  | "single_shipment"
  | "duplicate_document_copies"
  | "duplicate_upload"
  | "multi_shipment_same_company"
  | "multi_shipment_different_companies"
  | "seller_chain"
  | "needs_review";

export type PacketIntelligenceTone = "neutral" | "success" | "warning" | "danger";
export type PacketIntelligenceConfidence = "high" | "medium" | "low";

export type PacketIntelligenceSignal = {
  label: string;
  value: string;
  tone?: PacketIntelligenceTone;
};

export type PacketIntelligenceCheck = {
  key: string;
  label: string;
  status: "clear" | "attention" | "blocked";
  detail: string;
  documentIds?: string[];
};

export type PacketCopyGroup = {
  key: string;
  label: string;
  documentType: string;
  keptDocumentId: string;
  documentIds: string[];
  sourceLabels: string[];
};

export type PacketShipmentGroup = {
  key: string;
  label: string;
  company: string | null;
  invoiceNumber: string | null;
  buyerName: string | null;
  supplierName: string | null;
  documentIds: string[];
  role: "primary" | "context" | "split_candidate";
  reason: string;
};

export type PacketDuplicateReference = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
};

export type PacketIntelligence = {
  kind: PacketIntelligenceKind;
  label: string;
  tone: PacketIntelligenceTone;
  confidence: PacketIntelligenceConfidence;
  summary: string;
  recommendedAction: string;
  primaryDocumentIds: string[];
  contextDocumentIds: string[];
  collapsedCopyGroups: PacketCopyGroup[];
  shipmentGroups: PacketShipmentGroup[];
  duplicateCases: PacketDuplicateReference[];
  checks: PacketIntelligenceCheck[];
  signals: PacketIntelligenceSignal[];
};

type PacketDocumentLike = {
  id: string;
  clientDocumentId?: string | null;
  sourceFileName?: string | null;
  sourceHint?: string | null;
  documentType: string;
  title: string;
  pageCount?: number | null;
  extractedFields?: Record<string, unknown> | null;
  markdown?: string | null;
};

type PacketMismatchLike = {
  fieldName: string;
  values?: Array<{ docId?: string; value?: unknown }>;
};

export type ResolvePacketIntelligenceParams = {
  documents: PacketDocumentLike[];
  mismatches?: PacketMismatchLike[];
  processingMeta?: unknown;
  duplicateCases?: PacketDuplicateReference[];
};

type InvoiceGroup = {
  key: string;
  documents: PacketDocumentLike[];
  invoiceNumber: string | null;
  buyerName: string | null;
  supplierName: string | null;
  totalAmount: string | null;
  eWayBillNumber: string | null;
  poNumber: string | null;
  isKalikaFacing: boolean;
};

const KALIKA_PATTERN = /\bkalika\b|kalika\s+steel|kalika\s+alloys/i;
const INVOICE_COPY_PATTERN =
  /\b(?:original|duplicate|triplicate|quadruplicate|buyer|seller|supplier|recipient|receiver|customer|transporter|office|extra)\s+copy\b|\bcopy\s+(?:for|to)\b|\bduplicate\s+(?:for|to)?\b/i;

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

function readField(document: PacketDocumentLike, keys: string[]) {
  const fields = readRecord(document.extractedFields);
  for (const key of keys) {
    const value = readString(fields[key]);
    if (value) return value;
  }
  return null;
}

function normalizeIdentity(value: string | null) {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:private|pvt|limited|ltd|llp|inc|co|company|enterprises|traders|fabricators|industries)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDocumentNumber(value: string | null) {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeAmount(value: string | null) {
  const compact = (value ?? "").replace(/[^\d.-]/g, "");
  if (!compact) return "";
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? String(Math.round(parsed * 100) / 100) : compact;
}

function isInvoiceDocument(documentType: string) {
  return /\binvoice\b/i.test(documentType) && !/e-?way/i.test(documentType);
}

function sourceLabel(document: PacketDocumentLike) {
  return (
    readString(document.sourceHint) ||
    readString(document.sourceFileName) ||
    readString(document.title) ||
    document.documentType
  );
}

function documentCopyText(document: PacketDocumentLike) {
  return [document.title, document.sourceHint, document.sourceFileName, document.markdown]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

function isMarkedInvoiceCopy(document: PacketDocumentLike) {
  return INVOICE_COPY_PATTERN.test(documentCopyText(document));
}

function getInvoiceGroupKey(document: PacketDocumentLike) {
  const invoiceNumber = normalizeDocumentNumber(readField(document, ["invoiceNumber", "referenceInvoiceNumber"]));
  const supplierName = normalizeIdentity(readField(document, ["vendorName", "supplierName", "sellerName", "consignorName"]));
  const buyerName = normalizeIdentity(readField(document, ["buyerName", "receiverName", "consigneeName", "shipTo", "shipToName"]));
  const totalAmount = normalizeAmount(readField(document, ["totalAmount", "commercialPaymentAmount", "subtotal"]));

  if (invoiceNumber) {
    return `invoice:${invoiceNumber}:${supplierName}:${buyerName}:${totalAmount}`;
  }
  if (supplierName && buyerName && totalAmount) {
    return `amount:${supplierName}:${buyerName}:${totalAmount}`;
  }
  return `doc:${document.id}`;
}

function buildInvoiceGroups(documents: PacketDocumentLike[]) {
  const groups = new Map<string, PacketDocumentLike[]>();
  for (const document of documents.filter((entry) => isInvoiceDocument(entry.documentType))) {
    const key = getInvoiceGroupKey(document);
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }

  return Array.from(groups.entries()).map(([key, groupDocuments]): InvoiceGroup => {
    const first = groupDocuments[0];
    const buyerName = readField(first, ["buyerName", "receiverName", "consigneeName", "shipTo", "shipToName"]);
    const supplierName = readField(first, ["vendorName", "supplierName", "sellerName", "consignorName"]);
    const invoiceNumber = readField(first, ["invoiceNumber", "referenceInvoiceNumber"]);

    return {
      key,
      documents: groupDocuments,
      invoiceNumber,
      buyerName,
      supplierName,
      totalAmount: readField(first, ["totalAmount", "commercialPaymentAmount", "subtotal"]),
      eWayBillNumber: readField(first, ["eWayBillNumber"]),
      poNumber: readField(first, ["poNumber", "referencePoNumber"]),
      isKalikaFacing: KALIKA_PATTERN.test(`${buyerName ?? ""} ${readField(first, ["buyerGstin"]) ?? ""}`),
    };
  });
}

function getRelatedDocumentIdsForInvoice(
  invoiceGroup: InvoiceGroup,
  documents: PacketDocumentLike[]
) {
  const tokens = [
    normalizeDocumentNumber(invoiceGroup.invoiceNumber),
    normalizeDocumentNumber(invoiceGroup.eWayBillNumber),
    normalizeDocumentNumber(invoiceGroup.poNumber),
  ].filter(Boolean);
  const related = new Set(invoiceGroup.documents.map((document) => document.id));

  if (tokens.length === 0) {
    return Array.from(related);
  }

  for (const document of documents) {
    const fields = readRecord(document.extractedFields);
    const documentTokens = [
      fields.invoiceNumber,
      fields.referenceInvoiceNumber,
      fields.eWayBillNumber,
      fields.poNumber,
      fields.referencePoNumber,
    ]
      .map((value) => normalizeDocumentNumber(readString(value)))
      .filter(Boolean);

    if (documentTokens.some((token) => tokens.includes(token))) {
      related.add(document.id);
    }
  }

  return Array.from(related);
}

function buildCopyGroups(invoiceGroups: InvoiceGroup[]) {
  return invoiceGroups.flatMap((group): PacketCopyGroup[] => {
    if (group.documents.length < 2) return [];
    const hasStrongIdentity =
      Boolean(normalizeDocumentNumber(group.invoiceNumber)) ||
      group.documents.some((document) => isMarkedInvoiceCopy(document));
    if (!hasStrongIdentity) return [];

    const label = group.invoiceNumber
      ? `Invoice ${group.invoiceNumber}`
      : `${group.documents[0].documentType} copies`;
    return [
      {
        key: group.key,
        label,
        documentType: group.documents[0].documentType,
        keptDocumentId: group.documents[0].id,
        documentIds: group.documents.map((document) => document.id),
        sourceLabels: group.documents.map(sourceLabel),
      },
    ];
  });
}

function buildShipmentGroups(
  invoiceGroups: InvoiceGroup[],
  documents: PacketDocumentLike[],
  sellerChain: boolean
) {
  return invoiceGroups.map((group, index): PacketShipmentGroup => {
    const isContext = sellerChain && !group.isKalikaFacing;
    const role = sellerChain
      ? group.isKalikaFacing
        ? "primary"
        : "context"
      : invoiceGroups.length > 1
        ? "split_candidate"
        : "primary";
    const label =
      group.invoiceNumber ||
      group.buyerName ||
      group.supplierName ||
      `Shipment ${index + 1}`;

    return {
      key: group.key,
      label,
      company: group.buyerName || group.supplierName,
      invoiceNumber: group.invoiceNumber,
      buyerName: group.buyerName,
      supplierName: group.supplierName,
      documentIds: getRelatedDocumentIdsForInvoice(group, documents),
      role,
      reason: isContext
        ? "Upstream seller-chain document. Keep as context, not primary reconciliation evidence."
        : role === "split_candidate"
          ? "Separate invoice identity found in the same upload."
          : "Primary evidence for this packet.",
    };
  });
}

function readMetaString(processingMeta: unknown, key: string) {
  return readString(readRecord(processingMeta)[key]);
}

function getUploadFingerprintState(processingMeta: unknown) {
  const uploadFingerprint = readMetaString(processingMeta, "uploadFingerprint");
  const originalUploadFingerprint = readMetaString(processingMeta, "originalUploadFingerprint");
  const duplicateMode = readMetaString(processingMeta, "duplicateUploadMode");
  return {
    uploadFingerprint,
    originalUploadFingerprint,
    duplicateMode,
    hasFingerprint: Boolean(uploadFingerprint || originalUploadFingerprint),
    isDuplicateCopy: duplicateMode === "test-copy" || Boolean(originalUploadFingerprint),
  };
}

function hasMismatchField(mismatches: PacketMismatchLike[] | undefined, fieldName: string) {
  return (mismatches ?? []).some((mismatch) => mismatch.fieldName === fieldName);
}

function hasTaxValidationIssue(mismatches: PacketMismatchLike[] | undefined) {
  return (mismatches ?? []).some((mismatch) => {
    if (mismatch.fieldName !== "taxAmount") return false;
    const documentIds = new Set((mismatch.values ?? []).map((entry) => entry.docId).filter(Boolean));
    return documentIds.size <= 1 || (mismatch.values ?? []).length <= 1;
  });
}

export function resolvePacketIntelligence({
  documents,
  mismatches = [],
  processingMeta,
  duplicateCases = [],
}: ResolvePacketIntelligenceParams): PacketIntelligence {
  const invoiceGroups = buildInvoiceGroups(documents);
  const collapsedCopyGroups = buildCopyGroups(invoiceGroups);
  const uniqueInvoiceGroups = invoiceGroups;
  const uniqueBuyerKeys = new Set(
    uniqueInvoiceGroups.map((group) => normalizeIdentity(group.buyerName)).filter(Boolean)
  );
  const kalikaFacingGroups = uniqueInvoiceGroups.filter((group) => group.isKalikaFacing);
  const nonKalikaFacingGroups = uniqueInvoiceGroups.filter((group) => !group.isKalikaFacing);
  const sellerChain =
    uniqueInvoiceGroups.length > 1 &&
    kalikaFacingGroups.length > 0 &&
    nonKalikaFacingGroups.length > 0;
  const shipmentGroups = buildShipmentGroups(uniqueInvoiceGroups, documents, sellerChain);
  const uploadState = getUploadFingerprintState(processingMeta);
  const duplicateUpload = uploadState.isDuplicateCopy || duplicateCases.length > 0;
  const multipleInvoices = uniqueInvoiceGroups.length > 1;
  const multiCompany = multipleInvoices && uniqueBuyerKeys.size > 1;
  const taxIssue = hasTaxValidationIssue(mismatches);
  const termsIssue = hasMismatchField(mismatches, "termsAndConditions");

  let kind: PacketIntelligenceKind = "single_shipment";
  let label = "Single shipment packet";
  let tone: PacketIntelligenceTone = "success";
  let confidence: PacketIntelligenceConfidence = uploadState.hasFingerprint ? "high" : "medium";
  let summary = "One invoice identity is visible in this packet.";
  let recommendedAction = "Review mismatches normally.";

  if (duplicateUpload) {
    kind = "duplicate_upload";
    label = "Duplicate upload";
    tone = "danger";
    confidence = uploadState.hasFingerprint ? "high" : "medium";
    summary = duplicateCases.length
      ? `This upload matches ${duplicateCases.length} saved case${duplicateCases.length === 1 ? "" : "s"}.`
      : "This case was intentionally created as a duplicate copy of an existing upload.";
    recommendedAction = "Open the existing case and avoid reviewing the same packet twice.";
  } else if (sellerChain) {
    kind = "seller_chain";
    label = "Seller chain";
    tone = "warning";
    confidence = "medium";
    summary = `${kalikaFacingGroups.length} Kalika-facing invoice${kalikaFacingGroups.length === 1 ? "" : "s"} and ${nonKalikaFacingGroups.length} upstream invoice${nonKalikaFacingGroups.length === 1 ? "" : "s"} found.`;
    recommendedAction = "Reconcile only the Kalika-facing invoice; keep upstream invoices as context.";
  } else if (multiCompany) {
    kind = "multi_shipment_different_companies";
    label = "Multiple companies";
    tone = "danger";
    confidence = "high";
    summary = `${uniqueInvoiceGroups.length} invoice identities across ${uniqueBuyerKeys.size} buyer names were found in one upload.`;
    recommendedAction = "Split this upload into separate cases before approving or rejecting mismatches.";
  } else if (multipleInvoices) {
    kind = "multi_shipment_same_company";
    label = "Multiple shipments";
    tone = "warning";
    confidence = "high";
    summary = `${uniqueInvoiceGroups.length} invoice identities for the same buyer were found in one upload.`;
    recommendedAction = "Review each invoice as a separate shipment group; do not reconcile all invoices together.";
  } else if (collapsedCopyGroups.length > 0) {
    kind = "duplicate_document_copies";
    label = "Duplicate document copies";
    tone = "warning";
    confidence = "high";
    summary = `${collapsedCopyGroups.reduce((total, group) => total + group.documentIds.length, 0)} invoice copy pages collapse into ${collapsedCopyGroups.length} evidence source${collapsedCopyGroups.length === 1 ? "" : "s"}.`;
    recommendedAction = "Use one copy as evidence and treat original/duplicate/transporter copies as supporting proof only.";
  } else if (uniqueInvoiceGroups.length === 0) {
    kind = "needs_review";
    label = "No invoice anchor";
    tone = "warning";
    confidence = "low";
    summary = "No invoice document identity was found, so packet grouping cannot be confirmed.";
    recommendedAction = "Check whether the invoice was missed, misclassified, or uploaded separately.";
  }

  const primaryDocumentIds = new Set<string>();
  const contextDocumentIds = new Set<string>();
  for (const group of shipmentGroups) {
    const target = group.role === "context" ? contextDocumentIds : primaryDocumentIds;
    for (const documentId of group.documentIds) target.add(documentId);
  }
  for (const copyGroup of collapsedCopyGroups) {
    primaryDocumentIds.add(copyGroup.keptDocumentId);
    for (const documentId of copyGroup.documentIds) {
      if (documentId !== copyGroup.keptDocumentId) contextDocumentIds.add(documentId);
    }
  }

  const checks: PacketIntelligenceCheck[] = [
    {
      key: "copies",
      label: "Document copies",
      status: collapsedCopyGroups.length > 0 ? "attention" : "clear",
      detail:
        collapsedCopyGroups.length > 0
          ? `${collapsedCopyGroups.length} duplicate copy group${collapsedCopyGroups.length === 1 ? "" : "s"} should be collapsed.`
          : "No duplicate invoice-copy group detected.",
      documentIds: collapsedCopyGroups.flatMap((group) => group.documentIds),
    },
    {
      key: "duplicate_upload",
      label: "Uploaded packet",
      status: duplicateUpload ? "blocked" : uploadState.hasFingerprint ? "clear" : "attention",
      detail: duplicateUpload
        ? "Same uploaded packet appears to already exist."
        : uploadState.hasFingerprint
          ? "Upload fingerprint is available for duplicate checks."
          : "This historical case has no upload fingerprint.",
    },
    {
      key: "shipment_grouping",
      label: "Shipment grouping",
      status: multipleInvoices ? "attention" : "clear",
      detail: multipleInvoices
        ? `${uniqueInvoiceGroups.length} invoice identities need shipment-level grouping.`
        : "Only one invoice identity detected.",
      documentIds: shipmentGroups.flatMap((group) => group.documentIds),
    },
    {
      key: "seller_role",
      label: "Seller role",
      status: sellerChain ? "attention" : "clear",
      detail: sellerChain
        ? "Seller-chain documents detected; choose Kalika-facing invoice as primary."
        : "No seller-chain pattern detected.",
      documentIds: shipmentGroups
        .filter((group) => group.role === "context")
        .flatMap((group) => group.documentIds),
    },
    {
      key: "tax_terms",
      label: "Tax / terms",
      status: taxIssue || termsIssue ? "attention" : "clear",
      detail:
        taxIssue && termsIssue
          ? "Tax calculation and terms-compliance issues are present."
          : taxIssue
            ? "Tax calculation issue is present."
            : termsIssue
              ? "Terms-compliance issue is present."
              : "No tax calculation or terms-compliance issue in the visible mismatch list.",
    },
  ];

  const signals: PacketIntelligenceSignal[] = [
    { label: "Documents", value: String(documents.length) },
    { label: "Invoice groups", value: String(uniqueInvoiceGroups.length || 0), tone: multipleInvoices ? "warning" : "neutral" },
    { label: "Copy groups", value: String(collapsedCopyGroups.length), tone: collapsedCopyGroups.length ? "warning" : "success" },
    { label: "Kalika-facing invoices", value: String(kalikaFacingGroups.length), tone: sellerChain ? "warning" : "neutral" },
  ];

  if (duplicateCases.length > 0) {
    signals.push({
      label: "Duplicate cases",
      value: duplicateCases.map((entry) => entry.displayName).join(", "),
      tone: "danger",
    });
  }

  return {
    kind,
    label,
    tone,
    confidence,
    summary,
    recommendedAction,
    primaryDocumentIds: Array.from(primaryDocumentIds),
    contextDocumentIds: Array.from(contextDocumentIds).filter((id) => !primaryDocumentIds.has(id)),
    collapsedCopyGroups,
    shipmentGroups,
    duplicateCases,
    checks,
    signals,
  };
}

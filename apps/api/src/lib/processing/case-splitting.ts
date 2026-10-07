import { randomUUID } from "crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCaseDisplayNameWithAI } from "@/lib/case-naming";
import { summarizeCase, type CaseSummary } from "@/lib/case-summary";
import type { PacketFieldConfiguration } from "@/lib/document-schema";
import { serializeFieldsWithLineItems } from "@/lib/line-items";
import {
  assessCaseTermsComplianceDetailed,
  verifyProcessedDocuments,
} from "@/lib/processing/pipeline";
import { TERMS_COMPLIANCE_MISMATCH_MODE } from "@/lib/terms-compliance";
import { groupDocumentsForVerification } from "@/services/verification";
import type { CaseAnalysisMode, CaseDoc, ComparisonOptions, FieldKey, Mismatch } from "@/types/pipeline";

const STORAGE_BUCKET = "packet-files";
const SPLIT_STRATEGY = "shipment-groups-v1";
const INVOICE_DOC_TYPES = new Set<CaseDoc["type"]>(["Invoice", "Tax Invoice"]);
const KALIKA_PATTERN = /\bkalika\b|kalika\s+steel|kalika\s+alloys/i;

export type CaseFileRowForSplit = {
  id: string;
  original_name: string;
  storage_asset_id?: string | null;
  content_sha256?: string | null;
  storage_bucket: string | null;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at?: string | null;
};

type SupabaseAdminClient = SupabaseClient;

type ShipmentGroup = {
  id: string;
  documents: CaseDoc[];
  sourceFileNames: string[];
  invoiceKeys: string[];
  shipmentKey: string;
};

export type ShipmentSplitPreviewGroup = {
  id: string;
  documentIds: string[];
  sourceFileNames: string[];
  shipmentKey: string;
  invoiceKeyCount: number;
};

type PersistedShipment = {
  caseId: string;
  summary: CaseSummary;
  displayName: string;
  documents: CaseDoc[];
  mismatches: Mismatch[];
  sourceFileNames: string[];
  verificationGroups: unknown[];
};

export type CaseSplitResult = {
  strategy: string;
  shipmentCount: number;
  primary: PersistedShipment;
  children: PersistedShipment[];
};

function normalizeKey(value?: string | number | null) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(?:private|pvt|limited|ltd|corp|corporation|company|co)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeSourceName(value?: string | null) {
  return normalizeKey(value);
}

function getField(document: CaseDoc, field: FieldKey) {
  const value = document.fields?.[field];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function getInvoiceNumber(document: CaseDoc) {
  return getField(document, "invoiceNumber") || getField(document, "referenceInvoiceNumber");
}

function getPoNumber(document: CaseDoc) {
  return getField(document, "poNumber") || getField(document, "referencePoNumber");
}

function getEWayBillNumber(document: CaseDoc) {
  return getField(document, "eWayBillNumber");
}

function getSourceNames(documents: CaseDoc[]) {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const document of documents) {
    const source = document.sourceFileName ?? document.sourceHint ?? "";
    const key = normalizeSourceName(source);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(source);
  }
  return names;
}

function isKalikaFacingDocument(document: CaseDoc) {
  return KALIKA_PATTERN.test(
    [getField(document, "buyerName"), getField(document, "buyerGstin")].filter(Boolean).join(" ")
  );
}

function hasInvoiceDocument(documents: CaseDoc[]) {
  return documents.some(
    (document) => INVOICE_DOC_TYPES.has(document.type) || Boolean(getInvoiceNumber(document))
  );
}

function isKalikaFacingShipmentGroup(group: ShipmentGroup) {
  return group.documents.some(
    (document) =>
      (INVOICE_DOC_TYPES.has(document.type) || Boolean(getInvoiceNumber(document))) &&
      isKalikaFacingDocument(document)
  );
}

function sharesSourceFile(left: ShipmentGroup, right: ShipmentGroup) {
  const rightSources = new Set(right.sourceFileNames.map(normalizeSourceName).filter(Boolean));
  return left.sourceFileNames
    .map(normalizeSourceName)
    .some((source) => source.length > 0 && rightSources.has(source));
}

function getInvoiceIdentity(document: CaseDoc) {
  const invoice = normalizeKey(getInvoiceNumber(document));
  if (!invoice) return "";

  const vendor = normalizeKey(getField(document, "vendorName"));
  const buyer = normalizeKey(getField(document, "buyerName"));
  const total = normalizeKey(getField(document, "totalAmount"));
  return [invoice, vendor, buyer, total].filter(Boolean).join(":");
}

function getShipmentKey(documents: CaseDoc[]) {
  const invoiceKeys = documents
    .map(getInvoiceIdentity)
    .filter(Boolean)
    .sort();
  if (invoiceKeys.length) return invoiceKeys[0];

  const po = documents
    .map(getPoNumber)
    .map(normalizeKey)
    .find(Boolean);
  if (po) return `po:${po}`;

  const eway = documents
    .map(getEWayBillNumber)
    .map(normalizeKey)
    .find(Boolean);
  if (eway) return `eway:${eway}`;

  const source = getSourceNames(documents).map(normalizeSourceName).find(Boolean);
  return source ? `source:${source}` : `documents:${documents.map((document) => document.id).join(":")}`;
}

function getDistinctInvoiceKeys(documents: CaseDoc[]) {
  return Array.from(
    new Set(
      documents
        .filter((document) => INVOICE_DOC_TYPES.has(document.type) || getInvoiceNumber(document))
        .map(getInvoiceIdentity)
        .filter(Boolean)
    )
  );
}

function hasSellerChain(documents: CaseDoc[]) {
  const invoices = documents
    .filter((document) => INVOICE_DOC_TYPES.has(document.type) || getInvoiceNumber(document))
    .map((document) => ({
      vendor: normalizeKey(getField(document, "vendorName")),
      buyer: normalizeKey(getField(document, "buyerName")),
    }))
    .filter((entry) => entry.vendor && entry.buyer);

  for (let left = 0; left < invoices.length; left += 1) {
    for (let right = left + 1; right < invoices.length; right += 1) {
      if (
        invoices[left].buyer === invoices[right].vendor ||
        invoices[left].vendor === invoices[right].buyer
      ) {
        return true;
      }
    }
  }

  return false;
}

function buildSourceInvoiceCounts(documents: CaseDoc[]) {
  const invoiceKeysBySource = new Map<string, Set<string>>();
  for (const document of documents) {
    const source = normalizeSourceName(document.sourceFileName ?? document.sourceHint);
    if (!source) continue;
    const invoiceKey = getInvoiceIdentity(document);
    if (!invoiceKey) continue;
    const existing = invoiceKeysBySource.get(source) ?? new Set<string>();
    existing.add(invoiceKey);
    invoiceKeysBySource.set(source, existing);
  }
  return invoiceKeysBySource;
}

function findGroup(parent: number[], index: number): number {
  if (parent[index] !== index) {
    parent[index] = findGroup(parent, parent[index]);
  }
  return parent[index];
}

function unionGroups(parent: number[], left: number, right: number) {
  const leftRoot = findGroup(parent, left);
  const rightRoot = findGroup(parent, right);
  if (leftRoot !== rightRoot) {
    parent[rightRoot] = leftRoot;
  }
}

function toShipmentGroup(id: string, documents: CaseDoc[], groupIndex: number): ShipmentGroup {
  const uniqueDocuments = Array.from(
    new Map(documents.map((document) => [document.id, document])).values()
  );
  const invoiceKeys = getDistinctInvoiceKeys(uniqueDocuments);
  return {
    id: id || `shipment-${groupIndex + 1}`,
    documents: uniqueDocuments,
    sourceFileNames: getSourceNames(uniqueDocuments),
    invoiceKeys,
    shipmentKey: getShipmentKey(uniqueDocuments),
  };
}

function attachSellerChainContextToPrimaryShipments(
  groups: ShipmentGroup[],
  documents: CaseDoc[]
) {
  if (!hasSellerChain(documents)) return groups;

  const primaryIndexes = groups
    .map((group, index) => (isKalikaFacingShipmentGroup(group) ? index : -1))
    .filter((index) => index >= 0);

  if (primaryIndexes.length < 2) return groups;

  const attachedDocuments = new Map<number, CaseDoc[]>();
  for (const index of primaryIndexes) {
    attachedDocuments.set(index, [...groups[index].documents]);
  }

  for (let index = 0; index < groups.length; index += 1) {
    if (primaryIndexes.includes(index)) continue;

    const candidates = primaryIndexes.filter((primaryIndex) =>
      sharesSourceFile(groups[index], groups[primaryIndex])
    );

    // Do not split a seller chain when context cannot be attached to exactly one
    // Kalika-facing shipment. Keeping the original packet is safer than losing context.
    if (candidates.length !== 1) return groups;
    attachedDocuments.get(candidates[0])?.push(...groups[index].documents);
  }

  return primaryIndexes.map((index, groupIndex) =>
    toShipmentGroup(groups[index].id, attachedDocuments.get(index) ?? groups[index].documents, groupIndex)
  );
}

function buildShipmentGroups(documents: CaseDoc[], comparisonOptions: ComparisonOptions): ShipmentGroup[] {
  const verificationGroups = groupDocumentsForVerification(documents, comparisonOptions);
  const initialGroups = verificationGroups.map((entry, index) => ({
    id: entry.group.groupId || `split-group-${index + 1}`,
    documents: entry.docs,
  }));

  if (initialGroups.length <= 1) {
    return [];
  }

  const sourceInvoiceCounts = buildSourceInvoiceCounts(documents);
  const parent = initialGroups.map((_, index) => index);

  for (let left = 0; left < initialGroups.length; left += 1) {
    for (let right = left + 1; right < initialGroups.length; right += 1) {
      const leftSources = getSourceNames(initialGroups[left].documents).map(normalizeSourceName);
      const rightSources = getSourceNames(initialGroups[right].documents).map(normalizeSourceName);
      const sharedSources = leftSources.filter((source) => source && rightSources.includes(source));
      const shouldMergeBySource = sharedSources.some((source) => {
        const invoiceCount = sourceInvoiceCounts.get(source)?.size ?? 0;
        return invoiceCount <= 1;
      });
      if (shouldMergeBySource) {
        unionGroups(parent, left, right);
        continue;
      }

      const leftInvoices = getDistinctInvoiceKeys(initialGroups[left].documents);
      const rightInvoices = getDistinctInvoiceKeys(initialGroups[right].documents);
      if (leftInvoices.some((invoice) => rightInvoices.includes(invoice))) {
        unionGroups(parent, left, right);
      }
    }
  }

  const merged = new Map<number, CaseDoc[]>();
  initialGroups.forEach((group, index) => {
    const root = findGroup(parent, index);
    merged.set(root, [...(merged.get(root) ?? []), ...group.documents]);
  });

  const shipmentGroups = Array.from(merged.entries()).map(([index, groupDocuments], groupIndex) =>
    toShipmentGroup(initialGroups[index]?.id ?? `shipment-${groupIndex + 1}`, groupDocuments, groupIndex)
  );

  return attachSellerChainContextToPrimaryShipments(shipmentGroups, documents);
}

function getSourceOrder(caseFiles: CaseFileRowForSplit[]) {
  const order = new Map<string, number>();
  caseFiles.forEach((file, index) => {
    order.set(normalizeSourceName(file.original_name), index);
  });
  return order;
}

function sortGroupsBySourceOrder(groups: ShipmentGroup[], caseFiles: CaseFileRowForSplit[]) {
  const sourceOrder = getSourceOrder(caseFiles);
  groups.sort((left, right) => {
    const leftOrder = Math.min(
      ...left.sourceFileNames.map((name) => sourceOrder.get(normalizeSourceName(name)) ?? Number.MAX_SAFE_INTEGER)
    );
    const rightOrder = Math.min(
      ...right.sourceFileNames.map((name) => sourceOrder.get(normalizeSourceName(name)) ?? Number.MAX_SAFE_INTEGER)
    );
    return leftOrder - rightOrder;
  });
}

function shouldSplitGroups(groups: ShipmentGroup[], documents: CaseDoc[]) {
  if (groups.length <= 1) return false;

  // Seller-chain packets can split only after every upstream/context group has
  // been attached to one Kalika-facing shipment by source-file evidence.
  if (hasSellerChain(documents) && groups.some((group) => !isKalikaFacingShipmentGroup(group))) {
    return false;
  }

  const invoiceLedGroups = groups.filter((group) => group.invoiceKeys.length > 0);
  if (invoiceLedGroups.length < 2) return false;

  const distinctShipmentKeys = new Set(groups.map((group) => group.shipmentKey).filter(Boolean));
  const distinctInvoiceKeys = new Set(invoiceLedGroups.flatMap((group) => group.invoiceKeys));
  return distinctShipmentKeys.size > 1 && distinctInvoiceKeys.size > 1;
}

export function previewShipmentSplitGroups(params: {
  documents: CaseDoc[];
  comparisonOptions: ComparisonOptions;
  caseFiles?: CaseFileRowForSplit[];
}): ShipmentSplitPreviewGroup[] {
  const groups = buildShipmentGroups(params.documents, params.comparisonOptions);
  if (!shouldSplitGroups(groups, params.documents)) {
    return [];
  }

  sortGroupsBySourceOrder(groups, params.caseFiles ?? []);

  return groups.map((group) => ({
    id: group.id,
    documentIds: group.documents.map((document) => document.id),
    sourceFileNames: group.sourceFileNames,
    shipmentKey: group.shipmentKey,
    invoiceKeyCount: group.invoiceKeys.length,
  }));
}

function getFilesForGroup(group: ShipmentGroup, caseFiles: CaseFileRowForSplit[]) {
  const sourceNames = new Set(group.sourceFileNames.map(normalizeSourceName).filter(Boolean));
  return caseFiles.filter((file) => sourceNames.has(normalizeSourceName(file.original_name)));
}

async function copyCaseFileForChild(
  _supabase: SupabaseAdminClient,
  file: CaseFileRowForSplit,
  childCaseId: string
) {
  const bucket = file.storage_bucket || STORAGE_BUCKET;

  return {
    case_id: childCaseId,
    original_name: file.original_name,
    storage_bucket: bucket,
    storage_path: file.storage_path,
    storage_asset_id: file.storage_asset_id ?? null,
    content_sha256: file.content_sha256 ?? null,
    mime_type: file.mime_type,
    size_bytes: file.size_bytes,
  };
}

async function analyzeShipmentGroup(params: {
  documents: CaseDoc[];
  comparisonOptions: ComparisonOptions;
  fieldConfiguration: PacketFieldConfiguration;
}) {
  const baseVerified = verifyProcessedDocuments(params.documents, params.comparisonOptions);
  const termsCompliance = await assessCaseTermsComplianceDetailed(params.documents);
  const mismatches = [...baseVerified.mismatches, ...termsCompliance.mismatches];
  const summary = summarizeCase(params.documents, mismatches, params.fieldConfiguration);
  const displayName = await resolveCaseDisplayNameWithAI(params.documents, summary);

  return {
    baseVerified,
    termsCompliance,
    mismatches,
    summary,
    displayName,
  };
}

async function insertDocuments(
  supabase: SupabaseAdminClient,
  caseId: string,
  documents: CaseDoc[]
) {
  const documentRows = documents.map((document) => ({
    case_id: caseId,
    client_document_id: document.id,
    source_file_name: document.sourceFileName ?? document.sourceHint ?? null,
    source_hint: document.sourceHint ?? null,
    document_type: document.type,
    title: document.title,
    page_count: document.pages,
    extracted_fields: serializeFieldsWithLineItems(document),
    markdown: document.md ?? "",
  }));

  if (!documentRows.length) return;
  const { error } = await supabase.from("packet_documents").insert(documentRows);
  if (error) throw error;
}

async function insertMismatches(
  supabase: SupabaseAdminClient,
  caseId: string,
  mismatches: Mismatch[]
) {
  if (!mismatches.length) return;
  const mismatchRows = mismatches.map((mismatch) => ({
    case_id: caseId,
    client_mismatch_id: mismatch.id,
    field_name: mismatch.field,
    values_json: mismatch.values ?? [],
    analysis: mismatch.analysis ?? null,
    fix_plan: mismatch.fixPlan ?? null,
  }));

  const { error } = await supabase.from("packet_mismatches").insert(mismatchRows);
  if (error) throw error;
}

function buildProcessingMeta(params: {
  existingMeta?: Record<string, unknown>;
  summary: CaseSummary;
  comparisonOptions: ComparisonOptions;
  analysisMode: CaseAnalysisMode;
  verificationGroups: unknown[];
  termsComplianceChecklist: unknown;
  splitBatchId: string;
  splitShipmentIndex: number;
  splitShipmentCount: number;
  sourceFileNames: string[];
  childCaseIds?: string[];
  parentCaseId?: string;
  extractionReview?: unknown;
}) {
  return {
    ...(params.existingMeta ?? {}),
    draft: false,
    analyzedAt: new Date().toISOString(),
    caseCategory: params.summary.category,
    packetCategory: params.summary.packetCategory,
    documentTypes: params.summary.documentTypes,
    missingDocumentGroups: params.summary.missingDocTypes,
    paymentGap: params.summary.paymentGap,
    analysisMode: params.analysisMode,
    comparisonOptions: params.comparisonOptions,
    verificationGroups: params.verificationGroups,
    termsComplianceChecklist: params.termsComplianceChecklist,
    termsComplianceMismatchMode: TERMS_COMPLIANCE_MISMATCH_MODE,
    splitStrategy: SPLIT_STRATEGY,
    splitBatchId: params.splitBatchId,
    splitShipmentIndex: params.splitShipmentIndex,
    splitShipmentCount: params.splitShipmentCount,
    splitSourceFileNames: params.sourceFileNames,
    ...(params.childCaseIds ? { splitCreatedChildCaseIds: params.childCaseIds } : {}),
    ...(params.parentCaseId ? { splitParentCaseId: params.parentCaseId } : {}),
    ...(params.extractionReview ? { extractionReview: params.extractionReview } : {}),
    lastProcessingError: null,
  };
}

function getChildMetaBase(existingMeta: Record<string, unknown>) {
  const parentOnlyKeys = new Set([
    "uploadFingerprint",
    "uploadFingerprintVersion",
    "originalUploadFingerprint",
    "duplicateUploadMode",
    "duplicateUploadRunId",
    "splitCreatedChildCaseIds",
  ]);

  return Object.fromEntries(
    Object.entries(existingMeta).filter(([key]) => !parentOnlyKeys.has(key))
  );
}

export async function splitAnalyzedCaseIntoShipmentCases(params: {
  supabase: SupabaseAdminClient;
  caseId: string;
  ownerUserId: string;
  existingMeta: Record<string, unknown>;
  documents: CaseDoc[];
  comparisonOptions: ComparisonOptions;
  analysisMode: CaseAnalysisMode;
  fieldConfiguration: PacketFieldConfiguration;
  caseFiles: CaseFileRowForSplit[];
  extractionReview?: unknown;
}): Promise<CaseSplitResult | null> {
  const groups = buildShipmentGroups(params.documents, params.comparisonOptions);
  if (!shouldSplitGroups(groups, params.documents)) {
    return null;
  }

  sortGroupsBySourceOrder(groups, params.caseFiles);

  const primaryGroup = groups[0];
  const childGroups = groups.slice(1);
  const childCaseIds = childGroups.map(() => randomUUID());

  const primaryAnalysis = await analyzeShipmentGroup({
    documents: primaryGroup.documents,
    comparisonOptions: params.comparisonOptions,
    fieldConfiguration: params.fieldConfiguration,
  });

  await insertDocuments(params.supabase, params.caseId, primaryGroup.documents);
  await insertMismatches(params.supabase, params.caseId, primaryAnalysis.mismatches);

  const primaryFiles = getFilesForGroup(primaryGroup, params.caseFiles);
  const persistedChildren: PersistedShipment[] = [];

  for (let index = 0; index < childGroups.length; index += 1) {
    const group = childGroups[index];
    const childCaseId = childCaseIds[index];
    const childAnalysis = await analyzeShipmentGroup({
      documents: group.documents,
      comparisonOptions: params.comparisonOptions,
      fieldConfiguration: params.fieldConfiguration,
    });
    const childFiles = getFilesForGroup(group, params.caseFiles);
    const childFileRows = [];
    for (const file of childFiles) {
      childFileRows.push(await copyCaseFileForChild(params.supabase, file, childCaseId));
    }

    const childMeta = buildProcessingMeta({
      existingMeta: getChildMetaBase(params.existingMeta),
      summary: childAnalysis.summary,
      comparisonOptions: params.comparisonOptions,
      analysisMode: params.analysisMode,
      verificationGroups: childAnalysis.baseVerified.verificationGroups,
      termsComplianceChecklist: childAnalysis.termsCompliance.checklist,
      splitBatchId: params.caseId,
      splitShipmentIndex: index + 2,
      splitShipmentCount: groups.length,
      sourceFileNames: group.sourceFileNames,
      parentCaseId: params.caseId,
    });

    const { error: childCaseError } = await params.supabase.from("packet_cases").insert({
      id: childCaseId,
      owner_user_id: params.ownerUserId,
      slug: `${childAnalysis.summary.slug}-${childCaseId.slice(0, 8)}`,
      display_name: childAnalysis.displayName,
      buyer_name: childAnalysis.summary.buyerName || null,
      po_number: childAnalysis.summary.poNumber || null,
      invoice_number: childAnalysis.summary.invoiceNumber || null,
      status: "completed",
      risk_score: childAnalysis.summary.riskScore,
      upload_count: childFileRows.length,
      document_count: group.documents.length,
      mismatch_count: childAnalysis.mismatches.length,
      processing_meta: childMeta,
    });
    if (childCaseError) throw childCaseError;

    if (childFileRows.length) {
      const { error: childFileError } = await params.supabase
        .from("packet_case_files")
        .insert(childFileRows);
      if (childFileError) throw childFileError;
    }

    await insertDocuments(params.supabase, childCaseId, group.documents);
    await insertMismatches(params.supabase, childCaseId, childAnalysis.mismatches);

    persistedChildren.push({
      caseId: childCaseId,
      summary: childAnalysis.summary,
      displayName: childAnalysis.displayName,
      documents: group.documents,
      mismatches: childAnalysis.mismatches,
      sourceFileNames: group.sourceFileNames,
      verificationGroups: childAnalysis.baseVerified.verificationGroups,
    });
  }

  const primaryMeta = buildProcessingMeta({
    existingMeta: params.existingMeta,
    summary: primaryAnalysis.summary,
    comparisonOptions: params.comparisonOptions,
    analysisMode: params.analysisMode,
    verificationGroups: primaryAnalysis.baseVerified.verificationGroups,
    termsComplianceChecklist: primaryAnalysis.termsCompliance.checklist,
    splitBatchId: params.caseId,
    splitShipmentIndex: 1,
    splitShipmentCount: groups.length,
    sourceFileNames: primaryGroup.sourceFileNames,
    childCaseIds,
    extractionReview: params.extractionReview,
  });

  const { error: updatePrimaryError } = await params.supabase
    .from("packet_cases")
    .update({
      slug: primaryAnalysis.summary.slug,
      display_name: primaryAnalysis.displayName,
      buyer_name: primaryAnalysis.summary.buyerName || null,
      po_number: primaryAnalysis.summary.poNumber || null,
      invoice_number: primaryAnalysis.summary.invoiceNumber || null,
      status: "completed",
      risk_score: primaryAnalysis.summary.riskScore,
      upload_count: primaryFiles.length,
      document_count: primaryGroup.documents.length,
      mismatch_count: primaryAnalysis.mismatches.length,
      processing_meta: primaryMeta,
    })
    .eq("id", params.caseId);
  if (updatePrimaryError) throw updatePrimaryError;

  return {
    strategy: SPLIT_STRATEGY,
    shipmentCount: groups.length,
    primary: {
      caseId: params.caseId,
      summary: primaryAnalysis.summary,
      displayName: primaryAnalysis.displayName,
      documents: primaryGroup.documents,
      mismatches: primaryAnalysis.mismatches,
      sourceFileNames: primaryGroup.sourceFileNames,
      verificationGroups: primaryAnalysis.baseVerified.verificationGroups,
    },
    children: persistedChildren,
  };
}

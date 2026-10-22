import { withTeamAccess } from '@/lib/access/route-boundary';
import { newResourceScope } from '@/lib/access/new-resource';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { listAccessPredicate } from "@/lib/access/list-scope";
import { AccessError,requireAccessContext } from "@/lib/access/server";
import { CASE_LIST_COLUMNS, CASE_LIST_COLUMNS_LEGACY, restoreCaseListMetadata,
  makeCaseCursor, readCaseCursor, cursorPredicate, missingCaseColumn } from '@/lib/case-list-query';

import {
  getCaseCategoryFromProcessingMeta,
  isGeneratedCaptureDisplayName,
  resolveCaseDisplayName,
  resolveCaseCategoryLabel,
  summarizeCase,
} from "@/lib/case-summary";
import { resolveCaseDisplayNameWithAI } from "@/lib/case-naming";
import {
  DEFAULT_COMPARISON_OPTIONS,
  getComparableFieldValue,
  isPrimaryComparisonField,
  readComparisonOptions,
} from "@/lib/comparison";
import {
  sanitizeFieldsForDocType,
  shouldConsiderFieldKey,
  type PacketFieldConfiguration,
} from "@/lib/document-schema";
import { getPersistedPacketFieldConfiguration } from "@/lib/field-settings-service";
import {
  enrichDocumentsWithPacketGstTaxContext,
  enrichFieldsWithLineItemTaxRates,
  isLineItemMismatchField,
  readStoredLineItems,
  serializeFieldsWithLineItems,
  stripStoredLineItems,
} from "@/lib/line-items";
import { getRecycleBinDeletedAt, isCaseRecycled } from "@/lib/recycle-bin";
import { assessCaseTermsComplianceDetailed } from "@/lib/processing/pipeline";
import { appendPacketUploadAiLog } from "@/lib/processing/packet-upload-debug";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  ensureStorageAsset,
  processStorageCleanupQueue,
  removeStorageObjectsIfUnreferenced,
  type StorageObjectCandidate,
} from "@/lib/storage-assets";
import {
  getLegacyHiddenTermsReviewCount,
  isActionableStoredTermsComplianceMismatch,
  isActionableTermsComplianceMismatch,
  TERMS_COMPLIANCE_FIELD,
  TERMS_COMPLIANCE_MISMATCH_MODE,
} from "@/lib/terms-compliance";
import { readUploadGroupMeta } from "@/lib/upload-groups";
import type { CaseDoc, FieldKey, Mismatch } from "@/types/pipeline";

const STORAGE_BUCKET = "packet-files";
const DEFAULT_CASE_LIST_LIMIT = 25;
const MAX_CASE_LIST_LIMIT = 500;
const LIST_COLUMNS = CASE_LIST_COLUMNS;
const LIST_COLUMNS_WITHOUT_RECYCLE_BIN = CASE_LIST_COLUMNS_LEGACY;
type CaseListScope = "active" | "deleted";
type CaseListStatusFilter = "all" | "pending" | "in_review" | "ongoing" | "completed" | "failed";
type CaseListApprovalFilter = "all" | "approved" | "pending" | "rejected";
type CaseListReconciliationFilter = "all" | "clean" | "issues";
type CaseListTallyFilter = "all" | "posted" | "not_posted" | "check";
type CaseListSortMode = "recent" | "oldest" | "name";
type CaseListTiming = Partial<Record<"auth" | "caseQuery" | "serialize" | "total", number>>;
type CaseListRow = {
  id: string;
  slug: string;
  display_name: string;
  buyer_name: string | null;
  po_number: string | null;
  invoice_number: string | null;
  status: string;
  risk_score: number;
  upload_count: number;
  document_count: number;
  mismatch_count: number;
  created_at: string;
  processing_meta?: unknown;
  deleted_at?: string | null;
};

function getCaseStatusesForFilter(filter: CaseListStatusFilter) {
  if (filter === "pending") return ["draft"];
  if (filter === "in_review") return ["processing"];
  if (filter === "ongoing") return ["processing", "pending"];
  if (filter === "completed") return ["completed", "accepted"];
  if (filter === "failed") return ["failed", "rejected"];
  return null;
}

function readCaseStatusFilter(value: string | null): CaseListStatusFilter {
  if (value === 'draft') return 'pending';
  if (value === 'ongoing') return 'ongoing';
  if (value === "pending" || value === "in_review" || value === "completed" || value === "failed") {
    return value;
  }
  return "all";
}

function readCaseSortMode(value: string | null): CaseListSortMode {
  if (value === "oldest" || value === "name") return value;
  return "recent";
}

function readCaseApprovalFilter(value: string | null): CaseListApprovalFilter {
  return value === "approved" || value === "pending" || value === "rejected" ? value : "all";
}

function readCaseTallyFilter(value: string | null): CaseListTallyFilter {
  return value === "posted" || value === "not_posted" || value === "check" ? value : "all";
}
function readCaseReconciliationFilter(value: string | null): CaseListReconciliationFilter {
  return value === "clean" || value === "issues" ? value : "all";
}
type PreparedUploadFile = {
  originalName: string;
  contentType: string;
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
};
type DuplicateCaseCandidate = {
  id: string;
  display_name: string;
  status: string;
  created_at: string;
  upload_count?: number | null;
  processing_meta?: unknown;
};
type DuplicateCaseResponse = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
};
type StoredCaseFileIdentity = {
  original_name: string;
  size_bytes: number | null;
  storage_bucket: string | null;
  storage_path: string | null;
};
type WebFormData = {
  get(name: string): FormDataEntryValue | null;
  getAll(name: string): FormDataEntryValue[];
};

function nowMs() {
  return performance.now();
}

function formatTimingValue(value: number) {
  return Math.max(0, value).toFixed(1);
}

function getServerTimingHeader(timing: CaseListTiming) {
  return Object.entries(timing)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([key, value]) => `${key};dur=${formatTimingValue(value)}`)
    .join(", ");
}

function attachCaseListTiming(response: Response, timing: CaseListTiming) {
  const header = getServerTimingHeader(timing);
  if (header) {
    response.headers.set("Server-Timing", header);
  }
  return response;
}

function logSlowCaseListRequest(params: {
  scope: CaseListScope;
  limit: number;
  hasSearch: boolean;
  queryMode: string;
  timing: CaseListTiming;
}) {
  if ((params.timing.total ?? 0) < 750) {
    return;
  }

  console.warn("Slow GET /api/cases", {
    route: "/api/cases",
    scope: params.scope,
    limit: params.limit,
    hasSearch: params.hasSearch,
    queryMode: params.queryMode,
    timings: Object.fromEntries(
      Object.entries(params.timing).map(([key, value]) => [
        key,
        typeof value === "number" ? Number(formatTimingValue(value)) : value,
      ])
    ),
  });
}

function normalizeCaseSearchQuery(value: string | null) {
  return value?.replace(/\s+/g, " ").trim().slice(0, 120) ?? "";
}

function escapeIlikePattern(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function escapePostgrestOrValue(value: string) {
  return value.replace(/[\\,()]/g, (match) => `\\${match}`);
}

function isRecycleBinSchemaMissing(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const message = [
    record.message,
    record.error,
    record.details,
    record.hint,
    record.error_description,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  const mentionsRecycleColumns = /deleted_at|deleted_by_user_id/i.test(message);
  const isMissingColumnError =
    /schema cache|could not find|column .* does not exist|42703|PGRST/i.test(`${code} ${message}`);

  return mentionsRecycleColumns && isMissingColumnError;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts: string[] = [];

    const message = [record.message, record.error_description, record.error].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );

    if (message) {
      parts.push(message);
    }
    if (typeof record.details === "string" && record.details.trim().length > 0) {
      parts.push(record.details);
    }
    if (typeof record.hint === "string" && record.hint.trim().length > 0) {
      parts.push(`Hint: ${record.hint}`);
    }
    if (typeof record.code === "string" && record.code.trim().length > 0) {
      parts.push(`Code: ${record.code}`);
    }

    const combined = parts.join(" ");
    if (combined) {
      if (/owner_user_id|schema cache/i.test(combined)) {
        return `${combined} Run the auth migration in Supabase using supabase/packet_auth_backend_v2.sql, then retry.`;
      }
      if (/deleted_at|deleted_by_user_id/i.test(combined)) {
        return `${combined} Run the recycle bin migration in Supabase using supabase/packet_recycle_bin_backend_v3.sql, then retry.`;
      }
      if (/packet_cases_status_check|violates check constraint/i.test(combined)) {
        return `${combined} Run the case draft migration in Supabase using supabase/packet_case_draft_backend_v5.sql, then retry.`;
      }
      return combined;
    }

    return JSON.stringify(error);
  }

  return String(error ?? "Unknown error");
}

function parseJsonField<T>(value: FormDataEntryValue | null, fieldName: string): T {
  if (typeof value !== "string") {
    throw new Error(`Missing ${fieldName} payload.`);
  }
  return JSON.parse(value) as T;
}

function parseOptionalJsonField<T>(value: FormDataEntryValue | null): T | null {
  if (typeof value !== "string") {
    return null;
  }

  return JSON.parse(value) as T;
}

function parseComparisonOptions(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return DEFAULT_COMPARISON_OPTIONS;
  }

  return readComparisonOptions(JSON.parse(value));
}

function parseUploadGroups(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return [];
  }

  try {
    return readUploadGroupMeta(JSON.parse(value));
  } catch {
    return [];
  }
}

function sanitizeFileName(fileName: string) {
  const cleaned = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || "upload";
}

function inferContentType(file: File) {
  if (file.type) {
    return file.type;
  }

  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "heic") return "image/heic";
  if (extension === "heif") return "image/heif";
  return "application/octet-stream";
}

function formatDraftName(fileName: string) {
  const cleaned = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (isGeneratedCaptureDisplayName(cleaned)) {
    return "Receiver pending";
  }

  return cleaned || "New packet case";
}

function slugifyDraftName(value: string, fallback: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || fallback;
}

function isFileEntry(entry: FormDataEntryValue): entry is File {
  return typeof entry !== "string";
}

function normalizeUploadIdentityValue(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256Hex(value: Uint8Array | string) {
  const bytes = new Uint8Array(typeof value === "string" ? new TextEncoder().encode(value) : value);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return Buffer.from(digest).toString("hex");
}

async function prepareUploadFiles(files: File[]): Promise<PreparedUploadFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return {
        originalName: file.name || "upload",
        contentType: inferContentType(file),
        bytes,
        sizeBytes: file.size,
        sha256: await sha256Hex(bytes),
      };
    })
  );
}

function getUploadContentSignature(files: PreparedUploadFile[]) {
  return files
    .map((file) => `${file.sha256}:${file.sizeBytes}`)
    .sort()
    .join("|");
}

function getLegacyUploadSignature(files: Array<Pick<PreparedUploadFile, "originalName" | "sizeBytes">>) {
  return files
    .map((file) => `${normalizeUploadIdentityValue(file.originalName)}:${file.sizeBytes}`)
    .sort()
    .join("|");
}

function getUploadSizeSignature(files: Array<Pick<PreparedUploadFile, "sizeBytes">>) {
  return files
    .map((file) => String(file.sizeBytes))
    .sort((a, b) => Number(a) - Number(b))
    .join("|");
}

async function getUploadFingerprint(files: PreparedUploadFile[]) {
  if (files.length === 0) return null;
  return `upload-set-sha256-v1:${await sha256Hex(getUploadContentSignature(files))}`;
}

function getUploadDuplicateMeta(
  files: PreparedUploadFile[],
  uploadFingerprint: string | null,
  options?: { duplicateRunId?: string | null }
) {
  if (!uploadFingerprint) return {};

  const uploadContentSignature = getUploadContentSignature(files);
  const uploadLegacySignature = getLegacyUploadSignature(files);
  return {
    uploadFingerprint: options?.duplicateRunId
      ? `${uploadFingerprint}:test-copy:${options.duplicateRunId}`
      : uploadFingerprint,
    uploadFingerprintVersion: "upload-set-sha256-v1",
    ...(options?.duplicateRunId
      ? {
          duplicateUploadMode: "test-copy",
          duplicateUploadRunId: options.duplicateRunId,
          originalUploadFingerprint: uploadFingerprint,
          originalUploadContentSignature: uploadContentSignature,
          originalUploadLegacySignature: uploadLegacySignature,
        }
      : {
          uploadContentSignature,
          uploadLegacySignature,
        }),
    uploadFileFingerprints: files.map((file) => ({
      name: file.originalName,
      sizeBytes: file.sizeBytes,
      mimeType: file.contentType,
      sha256: file.sha256,
    })),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStringMeta(value: unknown, key: string) {
  const record = toRecord(value);
  const raw = record[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

function readBooleanFormValue(value: unknown) {
  return typeof value === "string" && /^(?:1|true|yes)$/i.test(value.trim());
}

function isDuplicateTestCopy(value: unknown) {
  const record = toRecord(value);
  return record.duplicateUploadMode === "test-copy";
}

function isDuplicateUploadConstraintError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const message = [record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  return (
    code === "23505" &&
    /packet_cases_owner_upload_fingerprint_unique_idx|uploadFingerprint|upload_fingerprint/i.test(message)
  );
}

function mapDuplicateCaseResponse(row: DuplicateCaseCandidate): DuplicateCaseResponse {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
  };
}

function duplicateCaseMessage(row: DuplicateCaseCandidate) {
  return `This packet is already saved as "${row.display_name}". Open the existing case instead of creating a duplicate.`;
}

async function fetchAllOwnerCaseCandidates(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  ownerUserId: string,
  uploadCount: number,
  scope?: {access_organization_id:string;access_company_id:string}|null
) {
  const rows: DuplicateCaseCandidate[] = [];
  const pageSize = 1000;

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from("packet_cases")
      .select("id, display_name, status, created_at, upload_count, processing_meta")
      .or(scope ? `and(access_organization_id.eq.${JSON.stringify(scope.access_organization_id)},access_company_id.eq.${JSON.stringify(scope.access_company_id)})` : `owner_user_id.eq.${JSON.stringify(ownerUserId)}`)
      .eq("upload_count", uploadCount)
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw error;
    }

    rows.push(...((data ?? []) as DuplicateCaseCandidate[]));
    if (!data || data.length < pageSize) break;
  }

  return rows.filter((row) => !isCaseRecycled(row.processing_meta) && !isDuplicateTestCopy(row.processing_meta));
}

function chunk<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function findDuplicateCaseByStoredFiles(params: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  candidates: DuplicateCaseCandidate[];
  contentSignature: string;
  legacyUploadSignature: string;
  sizeSignature: string;
  fileCount: number;
}) {
  const candidateIds = params.candidates.map((candidate) => candidate.id);
  if (candidateIds.length === 0) return null;

  const filesByCaseId = new Map<string, StoredCaseFileIdentity[]>();
  for (const ids of chunk(candidateIds, 100)) {
    const { data, error } = await params.supabase
      .from("packet_case_files")
      .select("case_id, original_name, size_bytes, storage_bucket, storage_path")
      .in("case_id", ids);

    if (error) {
      throw error;
    }

    for (const row of data ?? []) {
      const current = filesByCaseId.get(row.case_id) ?? [];
      current.push({
        original_name: row.original_name,
        size_bytes: row.size_bytes,
        storage_bucket: row.storage_bucket,
        storage_path: row.storage_path,
      });
      filesByCaseId.set(row.case_id, current);
    }
  }

  const sameSizeCandidates: Array<{ candidate: DuplicateCaseCandidate; files: StoredCaseFileIdentity[] }> = [];
  for (const candidate of params.candidates) {
    const files = filesByCaseId.get(candidate.id) ?? [];
    if (files.length !== params.fileCount) continue;

    const sizeSignature = getUploadSizeSignature(
      files.map((file) => ({
        sizeBytes: file.size_bytes ?? 0,
      }))
    );
    if (sizeSignature === params.sizeSignature) {
      sameSizeCandidates.push({ candidate, files });
    }

    const signature = getLegacyUploadSignature(
      files.map((file) => ({
        originalName: file.original_name,
        sizeBytes: file.size_bytes ?? 0,
      }))
    );
    if (signature === params.legacyUploadSignature) {
      return candidate;
    }
  }

  for (const { candidate, files } of sameSizeCandidates) {
    const contentSignature = await getStoredContentSignature(params.supabase, files);
    if (contentSignature && contentSignature === params.contentSignature) {
      return candidate;
    }
  }

  return null;
}

async function getStoredContentSignature(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  files: StoredCaseFileIdentity[]
) {
  const signatures: string[] = [];

  for (const file of files) {
    if (!file.storage_path) {
      return null;
    }

    const { data, error } = await supabase.storage
      .from(file.storage_bucket || STORAGE_BUCKET)
      .download(file.storage_path);
    if (error || !data) {
      return null;
    }

    const bytes = new Uint8Array(await data.arrayBuffer());
    signatures.push(`${await sha256Hex(bytes)}:${file.size_bytes ?? bytes.byteLength}`);
  }

  return signatures.sort().join("|");
}

async function findDuplicateCaseForUpload(params: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  ownerUserId: string;
  files: PreparedUploadFile[];
  uploadFingerprint: string | null;
  scope?: {access_organization_id:string;access_company_id:string}|null;
}) {
  if (params.files.length === 0 || !params.uploadFingerprint) return null;

  const candidates = await fetchAllOwnerCaseCandidates(
    params.supabase,
    params.ownerUserId,
    params.files.length,
    params.scope
  );
  const contentSignature = getUploadContentSignature(params.files);
  const legacySignature = getLegacyUploadSignature(params.files);
  const metadataMatch = candidates.find((candidate) => {
    const fingerprint = readStringMeta(candidate.processing_meta, "uploadFingerprint");
    if (fingerprint && fingerprint === params.uploadFingerprint) return true;

    const storedContentSignature = readStringMeta(candidate.processing_meta, "uploadContentSignature");
    return Boolean(storedContentSignature && storedContentSignature === contentSignature);
  });

  if (metadataMatch) {
    return metadataMatch;
  }

  return findDuplicateCaseByStoredFiles({
    supabase: params.supabase,
    candidates,
    contentSignature,
    legacyUploadSignature: legacySignature,
    sizeSignature: getUploadSizeSignature(params.files),
    fileCount: params.files.length,
  });
}

function duplicateCaseResponse(request: Request, duplicateCase: DuplicateCaseCandidate) {
  return jsonWithCors(
    request,
    {
      error: duplicateCaseMessage(duplicateCase),
      duplicateCase: mapDuplicateCaseResponse(duplicateCase),
    },
    { status: 409 }
  );
}

async function cleanupUploadedFiles(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  uploadedPaths: StorageObjectCandidate[]
) {
  if (uploadedPaths.length === 0) return;
  await removeStorageObjectsIfUnreferenced(supabase, uploadedPaths);
  uploadedPaths.splice(0, uploadedPaths.length);
}

function sanitizeDocumentsForStorage(
  documents: CaseDoc[],
  fieldConfiguration: PacketFieldConfiguration
): CaseDoc[] {
  return documents.map((document) => ({
    ...document,
    fields: sanitizeFieldsForDocType(
      document.type,
      document.fields ?? {},
      fieldConfiguration
    ) as CaseDoc["fields"],
    lineItems: document.lineItems ?? [],
  }));
}

function hasMeaningfulDocumentFieldValue(value: unknown) {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return true;
}

function sanitizeMismatchesForStorage(
  mismatches: Mismatch[],
  documents: CaseDoc[],
  fieldConfiguration: PacketFieldConfiguration
): Mismatch[] {
  return mismatches.filter((mismatch) => {
    if (mismatch.field === TERMS_COMPLIANCE_FIELD) {
      return isActionableTermsComplianceMismatch(mismatch);
    }

    if (
      (!isLineItemMismatchField(mismatch.field) &&
        (!shouldConsiderFieldKey(mismatch.field, undefined, fieldConfiguration) ||
          !isPrimaryComparisonField(mismatch.field)))
    ) {
      return false;
    }

    if (isLineItemMismatchField(mismatch.field)) {
      return true;
    }

    const supportingDocuments = documents.filter((document) =>
      hasMeaningfulDocumentFieldValue(getComparableFieldValue(document, mismatch.field as FieldKey))
    );

    return supportingDocuments.length >= 2;
  });
}

function mapDocumentRowForCaseSummary(row: {
  id: string;
  client_document_id: string | null;
  source_file_name: string | null;
  source_hint: string | null;
  document_type: string;
  title: string | null;
  page_count: number | null;
  extracted_fields: unknown;
}, fieldConfiguration: PacketFieldConfiguration): CaseDoc {
  const storedLineItems = readStoredLineItems(row.extracted_fields);
  const extractedFields =
    row.extracted_fields && typeof row.extracted_fields === "object" && !Array.isArray(row.extracted_fields)
      ? sanitizeFieldsForDocType(
          row.document_type,
          stripStoredLineItems(Object.fromEntries(
            Object.entries(row.extracted_fields).flatMap(([key, value]) => {
              if (typeof value === "string" || typeof value === "number") {
                return [[key, String(value)]];
              }
              return [];
            })
          )),
          fieldConfiguration
        )
      : {};
  const enrichedFields = sanitizeFieldsForDocType(
    row.document_type,
    enrichFieldsWithLineItemTaxRates(
      extractedFields as Partial<Record<FieldKey, string>>,
      storedLineItems
    ),
    fieldConfiguration
  );

  return {
    id: row.client_document_id || row.id,
    type: row.document_type as CaseDoc["type"],
    title: row.title || row.document_type,
    pages: row.page_count || 1,
    fields: enrichedFields as CaseDoc["fields"],
    lineItems: storedLineItems,
    md: "",
    sourceHint: row.source_hint || row.source_file_name || undefined,
    sourceFileName: row.source_file_name || undefined,
  };
}

async function fetchCaseDocumentsForSummary(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  caseIds: string[],
  fieldConfiguration: PacketFieldConfiguration
) {
  const documentsByCaseId = new Map<string, CaseDoc[]>();

  if (caseIds.length === 0) {
    return documentsByCaseId;
  }

  const { data, error } = await supabase
    .from("packet_documents")
    .select("case_id, id, client_document_id, source_file_name, source_hint, document_type, title, page_count, extracted_fields")
    .in("case_id", caseIds)
    .order("created_at", { ascending: true });

  if (error) {
    throw error;
  }

  for (const row of data ?? []) {
    const current = documentsByCaseId.get(row.case_id) ?? [];
    current.push(mapDocumentRowForCaseSummary(row, fieldConfiguration));
    documentsByCaseId.set(row.case_id, current);
  }

  for (const [caseId, documents] of documentsByCaseId) {
    documentsByCaseId.set(caseId, enrichDocumentsWithPacketGstTaxContext(documents));
  }

  return documentsByCaseId;
}

async function fetchCaseMismatchCountsForSummary(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  caseIds: string[],
  documentsByCaseId: Map<string, CaseDoc[]>,
  fieldConfiguration: PacketFieldConfiguration
) {
  const mismatchCountsByCaseId = new Map<string, number>();

  if (caseIds.length === 0) {
    return mismatchCountsByCaseId;
  }

  const { data, error } = await supabase
    .from("packet_mismatches")
    .select("case_id, field_name, values_json, analysis, fix_plan")
    .in("case_id", caseIds);

  if (error) {
    throw error;
  }

  for (const row of data ?? []) {
    if (row.field_name === TERMS_COMPLIANCE_FIELD) {
      if (isActionableStoredTermsComplianceMismatch(row)) {
        mismatchCountsByCaseId.set(row.case_id, (mismatchCountsByCaseId.get(row.case_id) ?? 0) + 1);
      }
      continue;
    }

    if (
      !shouldConsiderFieldKey(row.field_name, undefined, fieldConfiguration) ||
      !isPrimaryComparisonField(row.field_name)
    ) {
      continue;
    }

    const supportingDocuments = (documentsByCaseId.get(row.case_id) ?? []).filter((document) =>
      hasMeaningfulDocumentFieldValue(getComparableFieldValue(document, row.field_name as FieldKey))
    );

    if (supportingDocuments.length < 2) {
      continue;
    }

    mismatchCountsByCaseId.set(
      row.case_id,
      (mismatchCountsByCaseId.get(row.case_id) ?? 0) + 1
    );
  }

  return mismatchCountsByCaseId;
}

function mapCaseRow(
  row: {
    id: string;
    slug: string;
    display_name: string;
    buyer_name: string | null;
    po_number: string | null;
    invoice_number: string | null;
    status: string;
    risk_score: number;
    upload_count: number;
    document_count: number;
    mismatch_count: number;
    created_at: string;
    processing_meta?: unknown;
    deleted_at?: string | null;
  },
  documents: CaseDoc[] = [],
  mismatchCountOverride?: number,
  fieldConfiguration?: PacketFieldConfiguration
) {
  const derivedSummary =
    documents.length > 0 ? summarizeCase(documents, [], fieldConfiguration) : null;
  const receiverName = derivedSummary ? derivedSummary.buyerName : row.buyer_name;
  const category =
    derivedSummary?.category ||
    resolveCaseCategoryLabel({
      receiverName,
      storedCategory: getCaseCategoryFromProcessingMeta(
        row.processing_meta,
        row.status,
        documents.map((document) => document.type),
        fieldConfiguration
      ),
      status: row.status,
    });
  const displayName = resolveCaseDisplayName({
    storedDisplayName: row.display_name,
    receiverName,
    invoiceNumber: row.invoice_number,
    poNumber: row.po_number,
    category,
    status: row.status,
  });
  const legacyHiddenTermsReviewCount =
    mismatchCountOverride === undefined ? getLegacyHiddenTermsReviewCount(row.processing_meta) : 0;
  const mismatchCount = Math.max(
    0,
    (mismatchCountOverride ?? row.mismatch_count) - legacyHiddenTermsReviewCount
  );
  const riskScore = derivedSummary
    ? Math.min(100, derivedSummary.riskScore + mismatchCount * 10)
    : Math.max(0, row.risk_score - legacyHiddenTermsReviewCount * 10);

  return {
    id: row.id,
    slug: row.slug,
    displayName,
    buyerName: receiverName,
    receiverName,
    category,
    poNumber: row.po_number,
    invoiceNumber: row.invoice_number,
    status: row.status,
    riskScore,
    uploadCount: row.upload_count,
    documentCount: row.document_count,
    mismatchCount,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? getRecycleBinDeletedAt(row.processing_meta),
  };
}

async function fetchLegacyCaseListRows(params: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  userId: string;
  scope: CaseListScope;
  statusValues: string[] | null;
  searchQuery: string;
  sortMode: CaseListSortMode;
  signal?: AbortSignal;
}) {
  const pageSize = 1000;
  const rows: CaseListRow[] = [];
  const searchTokens = params.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

  for (let offset = 0; ; offset += pageSize) {
    let query = params.supabase
      .from("packet_cases")
      .select(LIST_COLUMNS_WITHOUT_RECYCLE_BIN)
      .eq("owner_user_id", params.userId);

    if (params.statusValues) {
      query = query.in("status", params.statusValues);
    }

    if (params.sortMode === "name") {
      query = query.order("display_name", { ascending: true }).order("id", { ascending: true });
    } else {
      query = query.order("created_at", { ascending: params.sortMode === "oldest" }).order("id", { ascending: false });
    }

    const result = await query.range(offset, offset + pageSize - 1).abortSignal(params.signal ?? new AbortController().signal);
    if (result.error) {
      throw result.error;
    }

    rows.push(
      ...((result.data ?? []) as unknown as Omit<CaseListRow, "deleted_at">[]).map((raw) => {
        const row = restoreCaseListMetadata(raw);
        return { ...row, deleted_at: getRecycleBinDeletedAt(row.processing_meta) };
      })
    );

    if (!result.data || result.data.length < pageSize) break;
  }

  const searchedRows = searchTokens.length
    ? rows.filter((row) => {
        const searchable = [
          row.display_name,
          row.buyer_name,
          row.po_number,
          row.invoice_number,
          row.slug,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" ")
          .toLowerCase();
        return searchTokens.every((token) => searchable.includes(token));
      })
    : rows;

  const scopedRows =
    params.scope === "deleted"
      ? searchedRows
          .filter((row) => isCaseRecycled(row.processing_meta))
          .sort((a, b) => {
            const aTime = new Date(a.deleted_at ?? 0).getTime();
            const bTime = new Date(b.deleted_at ?? 0).getTime();
            return bTime - aTime || b.id.localeCompare(a.id);
          })
      : searchedRows.filter((row) => !isCaseRecycled(row.processing_meta));

  if (params.scope === "active" && params.sortMode === "name") {
    return [...scopedRows].sort((a, b) => a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id));
  }
  if (params.scope === "active" && params.sortMode === "oldest") {
    return [...scopedRows].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || b.id.localeCompare(a.id)
    );
  }
  if (params.scope === "active") {
    return [...scopedRows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || b.id.localeCompare(a.id)
    );
  }

  return scopedRows;
}

async function GETHandler(request: Request) {
  const startedAt = nowMs();
  const timing: CaseListTiming = {};

  try {
    const authStartedAt = nowMs();
    const user = await requireRequestUser(request);
    timing.auth = nowMs() - authStartedAt;
    if (!user) {
      timing.total = nowMs() - startedAt;
      return attachCaseListTiming(
        jsonWithCors(request, { error: "Unauthorized" }, { status: 401 }),
        timing
      );
    }

    const accessPredicate = await listAccessPredicate(request,user.id,new URL(request.url).searchParams.get('scope')==='deleted'?'purchases.recycle':'purchases.view');
    const supabase = createSupabaseAdminClient();
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? String(DEFAULT_CASE_LIST_LIMIT));
    const requestedPage = Number(url.searchParams.get("page"));
    const requestedScope = url.searchParams.get("scope");
    const shouldDeriveSummaryFromDocuments = url.searchParams.get("derive") === "documents";
    const scope = requestedScope === "deleted" ? "deleted" : "active";

    // Recycle-bin visits opportunistically retry durable Storage cleanup left
    // by a transient failure during permanent deletion.
    if (scope === "deleted") {
      try {
        await processStorageCleanupQueue(supabase, user.id, { limit: 25 });
      } catch (cleanupError) {
        console.error("Failed to retry pending Storage cleanup", cleanupError);
      }
    }
    const searchQuery = normalizeCaseSearchQuery(url.searchParams.get("q"));
    const statusFilter = readCaseStatusFilter(url.searchParams.get("status"));
    const approvalFilter = readCaseApprovalFilter(url.searchParams.get("approval"));
    const reconciliationFilter = readCaseReconciliationFilter(url.searchParams.get("reconciliation"));
    const tallyFilter = readCaseTallyFilter(url.searchParams.get("tally"));
    const sortMode = readCaseSortMode(url.searchParams.get("sort"));
    // Tally filter: posted = verified voucher, check = voucher exists but not verified, not_posted = neither.
    let tallyPostedIds: string[] = [];
    let tallyCheckIds: string[] = [];
    if (tallyFilter !== "all") {
      const { data: postingRows, error: postingError } = await supabase
        .from("purchase_invoice_tally_postings")
        .select("case_id, tally_voucher_number, verification_status")
        .not("tally_voucher_number", "is", null);
      if (postingError) {
        console.error("Failed to load Tally postings for case filter", postingError);
      }
      const posted = new Set<string>();
      const check = new Set<string>();
      for (const row of postingRows ?? []) {
        if (row.verification_status === "verified") posted.add(row.case_id);
        else check.add(row.case_id);
      }
      for (const id of posted) check.delete(id);
      tallyPostedIds = [...posted];
      tallyCheckIds = [...check];
    }
    const applyTallyFilter = <T extends { in: (c: string, v: string[]) => T; not: (c: string, o: string, v: string) => T }>(q: T): T => {
      if (tallyFilter === "posted") return q.in("id", tallyPostedIds.length ? tallyPostedIds : ["00000000-0000-0000-0000-000000000000"]);
      if (tallyFilter === "check") return q.in("id", tallyCheckIds.length ? tallyCheckIds : ["00000000-0000-0000-0000-000000000000"]);
      if (tallyFilter === "not_posted") {
        const ids = [...tallyPostedIds, ...tallyCheckIds];
        return ids.length ? q.not("id", "in", `(${ids.join(",")})`) : q;
      }
      return q;
    };
    let cursor;
    try { cursor = readCaseCursor(url.searchParams.get('cursor'), scope, sortMode); }
    catch { return jsonWithCors(request, {error:'Invalid pagination cursor. Restart from the first page.'}, {status:400}); }
    const statusValues = getCaseStatusesForFilter(statusFilter);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), MAX_CASE_LIST_LIMIT)
        : DEFAULT_CASE_LIST_LIMIT;
    const page =
      Number.isFinite(requestedPage) && requestedPage > 0
        ? Math.floor(requestedPage)
        : null;
    const usePageNumbers = page !== null && !cursor;
    const rangeStart = usePageNumbers ? (page - 1) * limit : null;
    const rangeEnd = rangeStart !== null ? rangeStart + limit - 1 : null;

    let data: CaseListRow[] | null = null;
    let totalCount: number | null = null;
    let queryMode = "database-pagination";

    try {
      const queryStartedAt = nowMs();
      let query = supabase
        .from("packet_cases")
        .select(LIST_COLUMNS, usePageNumbers ? { count: "exact" } : undefined)
        .or(accessPredicate);

      if (scope === "deleted") {
        query = query.not("deleted_at", "is", null);
        if (statusValues) {
          query = query.in("status", statusValues);
        }
        if (cursor) {
          query = query.or(cursorPredicate(cursor, scope, sortMode));
        }
        query = query.order("deleted_at", { ascending: false }).order("id", { ascending: false });
      } else {
        query = query.is("deleted_at", null);
        if (statusValues) {
          query = query.in("status", statusValues);
        }
        if (cursor) {
          query = query.or(cursorPredicate(cursor, scope, sortMode));
        }
        if (sortMode === "name") {
          query = query.order("display_name", { ascending: true }).order("id", { ascending: true });
        } else {
          query = query.order("created_at", { ascending: sortMode === "oldest" }).order("id", { ascending: false });
        }
      }

      if (approvalFilter === "approved") query = query.eq("status", "accepted");
      if (approvalFilter === "rejected") query = query.eq("status", "rejected");
      if (approvalFilter === "pending") query = query.not("status", "in", "(accepted,rejected)");
      if (reconciliationFilter === "clean") query = query.eq("mismatch_count", 0);
      if (reconciliationFilter === "issues") query = query.gt("mismatch_count", 0);
      query = applyTallyFilter(query);

      if (searchQuery) {
        query = query.ilike("search_text", `%${escapeIlikePattern(searchQuery.toLowerCase())}%`);
      }

      const result =
        usePageNumbers && rangeStart !== null && rangeEnd !== null
          ? await query.range(rangeStart, rangeEnd).abortSignal(request.signal)
          : await query.limit(limit + 1).abortSignal(request.signal);
      timing.caseQuery = nowMs() - queryStartedAt;
      if (result.error) {
        throw result.error;
      }
      totalCount = usePageNumbers ? (result.count ?? 0) : null;
      data = (result.data as unknown as CaseListRow[]).map(restoreCaseListMetadata);
    } catch (error) {
      if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
      if (searchQuery && missingCaseColumn(error, 'search_text')) {
        queryMode = "database-pagination-search-fallback";
        const queryStartedAt = nowMs();
        const searchPattern = `%${escapePostgrestOrValue(escapeIlikePattern(searchQuery))}%`;
        let fallbackSearchQuery = supabase
          .from("packet_cases")
          .select(LIST_COLUMNS, usePageNumbers ? { count: "exact" } : undefined)
          .or(accessPredicate);

        if (scope === "deleted") {
          fallbackSearchQuery = fallbackSearchQuery.not("deleted_at", "is", null);
          if (statusValues) {
            fallbackSearchQuery = fallbackSearchQuery.in("status", statusValues);
          }
          if (cursor) {
            fallbackSearchQuery = fallbackSearchQuery.or(
              cursorPredicate(cursor, scope, sortMode)
            );
          }
          fallbackSearchQuery = fallbackSearchQuery
            .order("deleted_at", { ascending: false })
            .order("id", { ascending: false });
        } else {
          fallbackSearchQuery = fallbackSearchQuery.is("deleted_at", null);
          if (statusValues) {
            fallbackSearchQuery = fallbackSearchQuery.in("status", statusValues);
          }
          if (cursor) {
            fallbackSearchQuery = fallbackSearchQuery.or(
              cursorPredicate(cursor, scope, sortMode)
            );
          }
          if (sortMode === "name") {
            fallbackSearchQuery = fallbackSearchQuery
              .order("display_name", { ascending: true })
              .order("id", { ascending: true });
          } else {
            fallbackSearchQuery = fallbackSearchQuery
              .order("created_at", { ascending: sortMode === "oldest" })
              .order("id", { ascending: false });
          }
        }

        if (approvalFilter === "approved") fallbackSearchQuery = fallbackSearchQuery.eq("status", "accepted");
        if (approvalFilter === "rejected") fallbackSearchQuery = fallbackSearchQuery.eq("status", "rejected");
        if (approvalFilter === "pending") fallbackSearchQuery = fallbackSearchQuery.not("status", "in", "(accepted,rejected)");
        if (reconciliationFilter === "clean") fallbackSearchQuery = fallbackSearchQuery.eq("mismatch_count", 0);
        if (reconciliationFilter === "issues") fallbackSearchQuery = fallbackSearchQuery.gt("mismatch_count", 0);
        fallbackSearchQuery = applyTallyFilter(fallbackSearchQuery);

        fallbackSearchQuery = fallbackSearchQuery.or(
          [
            `display_name.ilike.${searchPattern}`,
            `buyer_name.ilike.${searchPattern}`,
            `po_number.ilike.${searchPattern}`,
            `invoice_number.ilike.${searchPattern}`,
            `slug.ilike.${searchPattern}`,
          ].join(",")
        );

        const fallbackSearchResult =
          usePageNumbers && rangeStart !== null && rangeEnd !== null
            ? await fallbackSearchQuery.range(rangeStart, rangeEnd).abortSignal(request.signal)
            : await fallbackSearchQuery.limit(limit + 1).abortSignal(request.signal);
        timing.caseQuery = (timing.caseQuery ?? 0) + nowMs() - queryStartedAt;
        if (fallbackSearchResult.error) {
          throw fallbackSearchResult.error;
        }
        totalCount = usePageNumbers ? (fallbackSearchResult.count ?? 0) : null;
        data = (fallbackSearchResult.data as unknown as CaseListRow[]).map(restoreCaseListMetadata);
      } else {
        if (!isRecycleBinSchemaMissing(error)) {
          throw error;
        }

        const queryStartedAt = nowMs();
        if(process.env.TEAM_ACCESS_ENFORCEMENT==='true')throw new AccessError('Scoped listing requires the reviewed database migration.',503);
        const legacyRows = await fetchLegacyCaseListRows({
          supabase,
          userId: user.id,
          scope,
          statusValues,
          searchQuery,
          sortMode,
          signal: request.signal,
        });
        queryMode = "legacy-all-rows";
        timing.caseQuery = (timing.caseQuery ?? 0) + nowMs() - queryStartedAt;

        if (usePageNumbers && rangeStart !== null && rangeEnd !== null) {
          data = legacyRows.slice(rangeStart, rangeEnd + 1);
          totalCount = legacyRows.length;
        } else {
          const cursorIndex = cursor ? legacyRows.findIndex((row) => row.id === cursor.id) : -1;
          const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
          data = legacyRows.slice(startIndex, startIndex + limit + 1);
          totalCount = null;
        }
      }
    }

    const rawRows = data ?? [];
    const pageRows = usePageNumbers ? rawRows : rawRows.slice(0, limit);
    const hasMore =
      usePageNumbers && page !== null && totalCount !== null
        ? page * limit < totalCount
        : rawRows.length > limit;
    const nextCursor = hasMore && pageRows.length ? makeCaseCursor(pageRows[pageRows.length - 1], scope, sortMode) : null;
    const totalPages =
      usePageNumbers && totalCount !== null ? Math.max(1, Math.ceil(totalCount / limit)) : null;

    let fieldConfiguration: PacketFieldConfiguration | undefined;
    let documentsByCaseId = new Map<string, CaseDoc[]>();
    let mismatchCountsByCaseId = new Map<string, number>();

    if (shouldDeriveSummaryFromDocuments && pageRows.length > 0) {
      fieldConfiguration = await getPersistedPacketFieldConfiguration(process.env.TEAM_ACCESS_ENFORCEMENT==='true'?(await requireAccessContext(request)).organizationId:'default');
      documentsByCaseId = await fetchCaseDocumentsForSummary(
        supabase,
        pageRows.map((row) => row.id),
        fieldConfiguration
      );
      mismatchCountsByCaseId = await fetchCaseMismatchCountsForSummary(
        supabase,
        pageRows.map((row) => row.id),
        documentsByCaseId,
        fieldConfiguration
      );
    }

    const tallyPostingsByCaseId = new Map<string, { status: string; voucherNumber: string | null; verificationStatus: string | null }>();
    if (pageRows.length > 0) {
      const { data: postingRows } = await supabase
        .from("purchase_invoice_tally_postings")
        .select("case_id, status, tally_voucher_number, verification_status, updated_at")
        .in("case_id", pageRows.map((row) => row.id))
        .order("updated_at", { ascending: false });
      for (const posting of postingRows ?? []) {
        if (tallyPostingsByCaseId.has(posting.case_id)) continue;
        tallyPostingsByCaseId.set(posting.case_id, {
          status: posting.status,
          voucherNumber: posting.tally_voucher_number ?? null,
          verificationStatus: posting.verification_status ?? null,
        });
      }
    }

    const serializeStartedAt = nowMs();
    const body = {
      cases: pageRows.map((row) => ({
        ...mapCaseRow(
          row,
          documentsByCaseId.get(row.id) ?? [],
          shouldDeriveSummaryFromDocuments
            ? (mismatchCountsByCaseId.get(row.id) ?? 0)
            : undefined,
          fieldConfiguration
        ),
        tallyPosting: tallyPostingsByCaseId.get(row.id) ?? null,
      })),
      nextCursor,
      hasMore,
      page: page ?? undefined,
      pageSize: usePageNumbers ? limit : undefined,
      totalCount: totalCount ?? undefined,
      totalPages: totalPages ?? undefined,
    };
    timing.serialize = nowMs() - serializeStartedAt;
    timing.total = nowMs() - startedAt;
    logSlowCaseListRequest({ scope, limit, hasSearch: Boolean(searchQuery), queryMode, timing });

    return attachCaseListTiming(jsonWithCors(request, body), timing);
  } catch (error) {
      if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
    timing.total = nowMs() - startedAt;
    return attachCaseListTiming(
      jsonWithCors(request,
        {
          error: serializeError(error),
        },
        { status: 500 }
      ),
      timing
    );
  }
}

async function POSTHandler(request: Request) {
  let supabase: ReturnType<typeof createSupabaseAdminClient> | null = null;
  const uploadedPaths: StorageObjectCandidate[] = [];
  let caseId = "";

  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    supabase = createSupabaseAdminClient();
    const formData = (await request.formData()) as unknown as WebFormData;
    const resourceScope = await newResourceScope(request, formData.get('accessCompanyId'), 'purchases.prepare');
    const mode = typeof formData.get("mode") === "string" ? formData.get("mode") : null;
    const allowDuplicateUpload = readBooleanFormValue(formData.getAll("allowDuplicate")[0]);
    const files = formData.getAll("files").filter(isFileEntry);
    const preparedFiles = await prepareUploadFiles(files);
    appendPacketUploadAiLog(
      `[packet-upload-ai-flow] case-create mode=${mode ?? "processed"}; files=${preparedFiles.length}; allow_duplicate=${allowDuplicateUpload}`
    );
    const uploadFingerprint = await getUploadFingerprint(preparedFiles);
    if (!allowDuplicateUpload) {
      const duplicateCase = await findDuplicateCaseForUpload({
        scope: resourceScope,
        supabase,
        ownerUserId: user.id,
        files: preparedFiles,
        uploadFingerprint,
      });
      if (duplicateCase) {
        return duplicateCaseResponse(request, duplicateCase);
      }
    }
    const duplicateRunId = allowDuplicateUpload ? crypto.randomUUID() : null;
    const uploadDuplicateMeta = getUploadDuplicateMeta(preparedFiles, uploadFingerprint, { duplicateRunId });
    const uploadGroups = parseUploadGroups(formData.get("uploadGroups"));

    if (mode === "draft") {
      if (!preparedFiles.length) {
        return jsonWithCors(request, 
          { error: "Upload at least one file to create a case." },
          { status: 400 }
        );
      }

      caseId = crypto.randomUUID();
      const firstFileName = uploadGroups[0]?.name ?? preparedFiles[0]?.originalName ?? "New packet case";
      const displayName = formatDraftName(firstFileName);
      const slug = `${slugifyDraftName(displayName, "draft-case")}-${caseId.slice(0, 8)}`;

      const fileRows = [];
      for (const file of preparedFiles) {
        const asset = await ensureStorageAsset({
          supabase,
          ownerUserId: user.id,
          storageBucket: STORAGE_BUCKET,
          bytes: file.bytes,
          contentType: file.contentType,
        });
        if (asset.createdObject) {
          uploadedPaths.push({
            storageAssetId: asset.id,
            storageBucket: asset.storageBucket,
            storagePath: asset.storagePath,
          });
        }
        fileRows.push({
          case_id: caseId,
          original_name: file.originalName,
          storage_bucket: asset.storageBucket,
          storage_path: asset.storagePath,
          storage_asset_id: asset.id,
          content_sha256: asset.contentSha256,
          mime_type: file.contentType,
          size_bytes: file.sizeBytes,
        });
      }

      const caseRow = {
        id: caseId,
        owner_user_id: user.id,
        slug,
        display_name: displayName,
        buyer_name: null,
        po_number: null,
        invoice_number: null,
        status: "draft",
        risk_score: 0,
        upload_count: preparedFiles.length,
        document_count: 0,
        mismatch_count: 0,
        processing_meta: {
          draft: true,
          draftCreatedAt: new Date().toISOString(),
          caseCategory: "Draft case",
          packetCategory: "Draft case",
          documentTypes: [],
          missingDocumentGroups: [],
          paymentGap: 0,
          uploadGroups,
          ...uploadDuplicateMeta,
        },
      };

      const { data: insertedCase, error: caseError } = await supabase
        .from("packet_cases")
        .insert({...caseRow,...resourceScope})
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .single();

      if (caseError) {
        if (isDuplicateUploadConstraintError(caseError)) {
          await cleanupUploadedFiles(supabase, uploadedPaths);
          const duplicate = await findDuplicateCaseForUpload({
            scope: resourceScope,
            supabase,
            ownerUserId: user.id,
            files: preparedFiles,
            uploadFingerprint,
          });
          if (duplicate) {
            return duplicateCaseResponse(request, duplicate);
          }
        }
        throw caseError;
      }

      const { error: fileInsertError } = await supabase.from("packet_case_files").insert(fileRows);
      if (fileInsertError) {
        throw fileInsertError;
      }

      return jsonWithCors(request, 
        {
          case: mapCaseRow(insertedCase),
        },
        { status: 201 }
      );
    }

    const fieldConfiguration = await getPersistedPacketFieldConfiguration(resourceScope?.access_organization_id ?? 'default');
    const documents = enrichDocumentsWithPacketGstTaxContext(
      sanitizeDocumentsForStorage(
        parseJsonField<CaseDoc[]>(formData.get("documents"), "documents"),
        fieldConfiguration
      )
    );
    const baseMismatches = sanitizeMismatchesForStorage(
      parseJsonField<Mismatch[]>(formData.get("mismatches"), "mismatches"),
      documents,
      fieldConfiguration
    );
    const comparisonOptions = parseComparisonOptions(formData.get("comparisonOptions"));
    const packetAiUsage = parseOptionalJsonField<Record<string, unknown>>(formData.get("packetAiUsage"));
    if (!documents.length) {
      return jsonWithCors(request, 
        { error: "No processed documents were provided to save." },
        { status: 400 }
      );
    }

    const termsCompliance = await assessCaseTermsComplianceDetailed(documents);
    const mismatches = [...baseMismatches, ...termsCompliance.mismatches];
    const summary = summarizeCase(documents, mismatches, fieldConfiguration);
    const displayName = await resolveCaseDisplayNameWithAI(documents, summary);
    caseId = crypto.randomUUID();

    const fileRows = [];
    for (const file of preparedFiles) {
      const asset = await ensureStorageAsset({
        supabase,
        ownerUserId: user.id,
        storageBucket: STORAGE_BUCKET,
        bytes: file.bytes,
        contentType: file.contentType,
      });
      if (asset.createdObject) {
        uploadedPaths.push({
          storageAssetId: asset.id,
          storageBucket: asset.storageBucket,
          storagePath: asset.storagePath,
        });
      }
      fileRows.push({
        case_id: caseId,
        original_name: file.originalName,
        storage_bucket: asset.storageBucket,
        storage_path: asset.storagePath,
        storage_asset_id: asset.id,
        content_sha256: asset.contentSha256,
        mime_type: file.contentType,
        size_bytes: file.sizeBytes,
      });
    }

    const caseRow = {
      id: caseId,
      owner_user_id: user.id,
      slug: summary.slug,
      display_name: displayName,
      buyer_name: summary.buyerName || null,
      po_number: summary.poNumber || null,
      invoice_number: summary.invoiceNumber || null,
      status: "completed",
      risk_score: summary.riskScore,
      upload_count: preparedFiles.length,
      document_count: documents.length,
      mismatch_count: mismatches.length,
      processing_meta: {
        documentTypes: summary.documentTypes,
        caseCategory: summary.category,
        packetCategory: summary.packetCategory,
        missingDocumentGroups: summary.missingDocTypes,
        paymentGap: summary.paymentGap,
        comparisonOptions,
        termsComplianceChecklist: termsCompliance.checklist,
        termsComplianceMismatchMode: TERMS_COMPLIANCE_MISMATCH_MODE,
        uploadGroups,
        ...(packetAiUsage ? { packetAiUsage } : {}),
        ...uploadDuplicateMeta,
      },
    };

    const { data: insertedCase, error: caseError } = await supabase
      .from("packet_cases")
      .insert({...caseRow,...resourceScope})
      .select(
        "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
      )
      .single();

    if (caseError) {
      if (isDuplicateUploadConstraintError(caseError)) {
        await cleanupUploadedFiles(supabase, uploadedPaths);
        const duplicate = await findDuplicateCaseForUpload({
          scope: resourceScope,
          supabase,
          ownerUserId: user.id,
          files: preparedFiles,
          uploadFingerprint,
        });
        if (duplicate) {
          return duplicateCaseResponse(request, duplicate);
        }
      }
      throw caseError;
    }

    if (fileRows.length) {
      const { error: fileInsertError } = await supabase.from("packet_case_files").insert(fileRows);
      if (fileInsertError) {
        throw fileInsertError;
      }
    }

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

    const { error: documentInsertError } = await supabase.from("packet_documents").insert(documentRows);
    if (documentInsertError) {
      throw documentInsertError;
    }

    if (mismatches.length) {
      const mismatchRows = mismatches.map((mismatch) => ({
        case_id: caseId,
        client_mismatch_id: mismatch.id,
        field_name: mismatch.field,
        values_json: mismatch.values ?? [],
        analysis: mismatch.analysis ?? null,
        fix_plan: mismatch.fixPlan ?? null,
      }));

      const { error: mismatchInsertError } = await supabase.from("packet_mismatches").insert(mismatchRows);
      if (mismatchInsertError) {
        throw mismatchInsertError;
      }
    }

    return jsonWithCors(request, 
      {
        case: mapCaseRow(insertedCase),
      },
      { status: 201 }
    );
  } catch (error) {
    if (supabase && uploadedPaths.length > 0) {
      await cleanupUploadedFiles(supabase, uploadedPaths);
    }

    if (supabase && caseId) {
      await supabase.from("packet_cases").delete().eq("id", caseId);
    }

    return jsonWithCors(request, 
      {
        error: serializeError(error),
      },
      { status: error instanceof AccessError?error.status:500 }
    );
  }
}

export async function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export const GET = withTeamAccess(GETHandler);
export const POST = withTeamAccess(POSTHandler);

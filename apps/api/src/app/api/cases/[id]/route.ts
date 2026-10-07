import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { listAccessPredicate } from "@/lib/access/list-scope";
import { AccessError, requireAccessContext } from "@/lib/access/server";
import {
  getMismatchResolutionStatusForCaseDecision,
  isMismatchResolutionSchemaMissing,
  type MismatchResolutionStatus,
} from "@/lib/mismatch-resolution";

import {
  getCaseCategoryFromProcessingMeta,
  resolveCaseDisplayName,
  resolveCaseCategoryLabel,
  summarizeCase,
} from "@/lib/case-summary";
import { getComparableFieldValue, isPrimaryComparisonField } from "@/lib/comparison";
import {
  getRecycleBinDeletedAt,
  isCaseRecycled,
  withRecycleBinMetadata,
  withoutRecycleBinMetadata,
} from "@/lib/recycle-bin";
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
  stripStoredLineItems,
} from "@/lib/line-items";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  enqueueStorageCleanup,
  processStorageCleanupQueue,
} from "@/lib/storage-assets";
import {
  getLegacyHiddenTermsReviewCount,
  isActionableStoredTermsComplianceMismatch,
  TERMS_COMPLIANCE_FIELD,
} from "@/lib/terms-compliance";
import type { CaseDoc, FieldKey } from "@/types/pipeline";

const STORAGE_BUCKET = "packet-files";
const DOCUMENT_DISPLAY_ORDER = [
  "Weighment Slip",
  "FASTag Toll Proof",
  "Tax Invoice",
  "Invoice",
  "E-Way Bill",
  "Lorry Receipt",
  "Vehicle Registration Certificate",
  "Driving Licence",
  "PAN Card",
  "Photo Evidence",
];
const DOCUMENT_DISPLAY_ORDER_LOOKUP = new Map(
  DOCUMENT_DISPLAY_ORDER.map((documentType, index) => [documentType, index])
);

type CaseFileRow = {
  id: string;
  original_name: string;
  storage_bucket: string | null;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

type CaseDocumentRow = {
  id: string;
  client_document_id: string | null;
  source_file_name: string | null;
  source_hint: string | null;
  document_type: string;
  title: string;
  page_count: number;
  extracted_fields: unknown;
  markdown: string;
  created_at: string;
};

type CaseMismatchRow = {
  id: string;
  client_mismatch_id: string | null;
  field_name: string;
  values_json: unknown;
  analysis: string | null;
  fix_plan: string | null;
  created_at: string;
};

type CaseMismatchWithResolutionRow = CaseMismatchRow & {
  resolution_status: string | null;
  resolved_at: string | null;
};

function sanitizeExtractedFields(
  documentType: string,
  fields: unknown,
  fieldConfiguration: PacketFieldConfiguration
) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return {};
  }

  const sanitized = sanitizeFieldsForDocType(
    documentType,
    stripStoredLineItems(fields as Record<string, unknown>),
    fieldConfiguration
  );
  return enrichReadableEWayBillTaxableAmount(documentType, sanitized);
}

function parseCommercialAmount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const compact = value.replace(/[₹$€£,\s]/g, "");
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCommercialAmount(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function enrichReadableEWayBillTaxableAmount(
  documentType: string,
  fields: Record<string, unknown>
) {
  if (documentType !== "E-Way Bill") {
    return fields;
  }

  if (fields.subtotal || fields.totalTaxableAmount) {
    return {
      ...fields,
      ...(fields.subtotal ? {} : { subtotal: fields.totalTaxableAmount }),
      ...(fields.totalTaxableAmount ? {} : { totalTaxableAmount: fields.subtotal }),
    };
  }

  const totalAmount = parseCommercialAmount(fields.totalAmount);
  const taxAmount = parseCommercialAmount(fields.taxAmount);
  if (totalAmount === null || taxAmount === null || taxAmount < 0 || totalAmount <= taxAmount) {
    return fields;
  }

  return {
    ...fields,
    subtotal: formatCommercialAmount(totalAmount - taxAmount),
    totalTaxableAmount: formatCommercialAmount(totalAmount - taxAmount),
  };
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
  const extractedFields = Object.fromEntries(
    Object.entries(sanitizeExtractedFields(row.document_type, row.extracted_fields, fieldConfiguration)).flatMap(([key, value]) => {
      if (typeof value === "string" || typeof value === "number") {
        return [[key, String(value)]];
      }
      return [];
    })
  );
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
    sourceFileName: row.source_file_name || undefined,
    sourceHint: row.source_hint || row.source_file_name || undefined,
  };
}

function getDocumentStartPage(row: Pick<CaseDocumentRow, "source_hint" | "title">) {
  const source = `${row.source_hint ?? ""} ${row.title ?? ""}`;
  const match = source.match(/\(pages?\s+(\d+)/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sortCaseDocuments(rows: CaseDocumentRow[]) {
  return [...rows].sort((left, right) => {
    const pageDelta = getDocumentStartPage(left) - getDocumentStartPage(right);
    if (pageDelta !== 0) return pageDelta;

    const typeDelta =
      (DOCUMENT_DISPLAY_ORDER_LOOKUP.get(left.document_type) ?? Number.MAX_SAFE_INTEGER) -
      (DOCUMENT_DISPLAY_ORDER_LOOKUP.get(right.document_type) ?? Number.MAX_SAFE_INTEGER);
    if (typeDelta !== 0) return typeDelta;

    return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
  });
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

    if (parts.length > 0) {
      const combined = parts.join(" ");
      if (/deleted_at|deleted_by_user_id/i.test(combined)) {
        return `${combined} Run the recycle bin migration in Supabase using supabase/packet_recycle_bin_backend_v3.sql, then retry.`;
      }
      if (/packet_cases_status_check|violates check constraint/i.test(combined)) {
        return `${combined} Run the case draft migration in Supabase using supabase/packet_case_draft_backend_v5.sql, then retry.`;
      }
      if (/resolution_status|resolved_at/i.test(combined)) {
        return `${combined} Run the mismatch resolution migration in Supabase using supabase/packet_mismatch_resolution_backend_v8.sql, then retry.`;
      }
      return combined;
    }

    return JSON.stringify(error);
  }

  return String(error ?? "Unknown error");
}

async function fetchCaseMismatches(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  caseId: string
) {
  const result = await supabase
    .from("packet_mismatches")
    .select(
    "id, client_mismatch_id, field_name, values_json, analysis, fix_plan, created_at, resolution_status, resolved_at"
    )
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });

  if (!result.error) {
    return ((result.data ?? []) as CaseMismatchWithResolutionRow[]).map((mismatch) => ({
      id: mismatch.id,
      clientMismatchId: mismatch.client_mismatch_id,
      fieldName: mismatch.field_name,
      values: Array.isArray(mismatch.values_json) ? mismatch.values_json : [],
      analysis: mismatch.analysis,
      fixPlan: mismatch.fix_plan,
      createdAt: mismatch.created_at,
      resolutionStatus:
        mismatch.resolution_status === "accepted" || mismatch.resolution_status === "rejected"
          ? mismatch.resolution_status
          : ("pending" as MismatchResolutionStatus),
      resolvedAt: mismatch.resolved_at ?? null,
    }));
  }

  if (!isMismatchResolutionSchemaMissing(result.error)) {
    throw result.error;
  }

  const fallback = await supabase
    .from("packet_mismatches")
    .select("id, client_mismatch_id, field_name, values_json, analysis, fix_plan, created_at")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });

  if (fallback.error) {
    throw fallback.error;
  }

  return ((fallback.data ?? []) as CaseMismatchRow[]).map((mismatch) => ({
    id: mismatch.id,
    clientMismatchId: mismatch.client_mismatch_id,
    fieldName: mismatch.field_name,
    values: Array.isArray(mismatch.values_json) ? mismatch.values_json : [],
    analysis: mismatch.analysis,
    fixPlan: mismatch.fix_plan,
    createdAt: mismatch.created_at,
    resolutionStatus: "pending" as const,
    resolvedAt: null,
  }));
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
    processingMeta: row.processing_meta ?? {},
  };
}

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const accessPredicate=await listAccessPredicate(request,user.id,"purchases.view");
    const supabase = createSupabaseAdminClient();
    const fieldConfiguration = await getPersistedPacketFieldConfiguration(process.env.TEAM_ACCESS_ENFORCEMENT==='true'?(await requireAccessContext(request)).organizationId:undefined);

    let caseRow:
      | {
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
        }
      | null = null;

    try {
      const result = await supabase
        .from("packet_cases")
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, owner_user_id, deleted_at"
        )
        .eq("id", id)
        .or(accessPredicate)
        .single();

      if (result.error) {
        if (result.error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        throw result.error;
      }

      caseRow = result.data;
    } catch (error) {
    if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
      if (!isRecycleBinSchemaMissing(error)) {
        throw error;
      }

      const fallback = await supabase
        .from("packet_cases")
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, owner_user_id"
        )
        .eq("id", id)
        .or(accessPredicate)
        .single();

      if (fallback.error) {
        if (fallback.error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        throw fallback.error;
      }

      caseRow = {
        ...fallback.data,
        deleted_at: getRecycleBinDeletedAt(fallback.data.processing_meta),
      };
    }

    const [{ data: files, error: filesError }, { data: documents, error: docsError }, mismatches] =
      await Promise.all([
        supabase
          .from("packet_case_files")
          .select("id, original_name, storage_bucket, storage_path, mime_type, size_bytes, created_at")
          .eq("case_id", id)
          .order("created_at", { ascending: true }),
        supabase
          .from("packet_documents")
          .select(
            "id, client_document_id, source_file_name, source_hint, document_type, title, page_count, extracted_fields, markdown, created_at"
          )
          .eq("case_id", id)
          .order("created_at", { ascending: true }),
        fetchCaseMismatches(supabase, id),
      ]);

    if (filesError) throw filesError;
    if (docsError) throw docsError;

    const filesWithUrls = ((files ?? []) as CaseFileRow[]).map((file) => ({
      id: file.id,
      originalName: file.original_name,
      storageBucket: file.storage_bucket || STORAGE_BUCKET,
      storagePath: file.storage_path,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      createdAt: file.created_at,
      signedUrl: null,
    }));

    const orderedDocuments = sortCaseDocuments((documents ?? []) as CaseDocumentRow[]);
    const caseSummaryDocuments = enrichDocumentsWithPacketGstTaxContext(
      orderedDocuments.map((document) =>
        mapDocumentRowForCaseSummary(document, fieldConfiguration)
      )
    );
    const sanitizedCaseDocuments = enrichDocumentsWithPacketGstTaxContext(orderedDocuments.map((document) => {
      const lineItems = readStoredLineItems(document.extracted_fields);
      const extractedFields = sanitizeExtractedFields(
        document.document_type,
        document.extracted_fields,
        fieldConfiguration
      );
      return {
        id: document.id,
        type: document.document_type as CaseDoc["type"],
        title: document.title,
        pages: document.page_count,
        fields: sanitizeFieldsForDocType(
          document.document_type,
          enrichFieldsWithLineItemTaxRates(extractedFields, lineItems),
          fieldConfiguration
        ),
        lineItems,
        md: document.markdown,
        sourceFileName: document.source_file_name || undefined,
        sourceHint: document.source_hint || document.source_file_name || undefined,
      };
    }));
    const sanitizedDocuments = sanitizedCaseDocuments.map((document, index) => {
      const row = orderedDocuments[index];
      return {
        id: row.id,
        clientDocumentId: row.client_document_id,
        sourceFileName: row.source_file_name,
        sourceHint: row.source_hint,
        documentType: row.document_type,
        title: row.title,
        pageCount: row.page_count,
        extractedFields: sanitizeFieldsForDocType(row.document_type, document.fields, fieldConfiguration),
        lineItems: document.lineItems,
        markdown: row.markdown,
        createdAt: row.created_at,
      };
    });
    const filteredMismatches = mismatches.filter((mismatch) => {
      if (mismatch.fieldName === TERMS_COMPLIANCE_FIELD) {
        return isActionableStoredTermsComplianceMismatch(mismatch);
      }

      if (
        !isLineItemMismatchField(mismatch.fieldName) &&
        (!shouldConsiderFieldKey(mismatch.fieldName, undefined, fieldConfiguration) ||
          !isPrimaryComparisonField(mismatch.fieldName))
      ) {
        return false;
      }

      if (isLineItemMismatchField(mismatch.fieldName)) {
        return true;
      }

      const supportingDocuments = caseSummaryDocuments.filter((document) => {
        const value = getComparableFieldValue(document, mismatch.fieldName as FieldKey);
        return value !== null && value !== undefined && String(value).trim().length > 0;
      });

      return supportingDocuments.length >= 2;
    });

    return jsonWithCors(request, {
      case: mapCaseRow(
        caseRow,
        caseSummaryDocuments,
        filteredMismatches.length,
        fieldConfiguration
      ),
      files: filesWithUrls,
      documents: sanitizedDocuments,
      mismatches: filteredMismatches,
    });
  } catch (error) {
    if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
    return jsonWithCors(request, 
      {
        error: serializeError(error),
      },
      { status: 500 }
    );
  }
}

async function DELETEHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") === "hard" ? "hard" : "soft";

    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();

    if (mode === "hard") {
      let canHardDeleteWithColumn = true;
      let existing: Parameters<typeof mapCaseRow>[0] | null = null;
      try {
        const result = await supabase
          .from("packet_cases")
          .select(
            "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
          )
          .eq("id", id)
          .or(await listAccessPredicate(request, user.id, 'purchases.view'))
          .not("deleted_at", "is", null)
          .single();
        if (result.error) throw result.error;
        existing = result.data;
      } catch (error) {
        if (!isRecycleBinSchemaMissing(error)) {
          const record = error as { code?: string };
          if (record.code === "PGRST116") {
            return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
          }
          throw error;
        }
        canHardDeleteWithColumn = false;
        const fallback = await supabase
          .from("packet_cases")
          .select(
            "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
          )
          .eq("id", id)
          .or(await listAccessPredicate(request, user.id, 'purchases.view'))
          .single();
        if (fallback.error) {
          if (fallback.error.code === "PGRST116") {
            return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
          }
          throw fallback.error;
        }
        if (!isCaseRecycled(fallback.data.processing_meta)) {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        existing = fallback.data;
      }

      if (!existing) {
        return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
      }

      const { data: storedFiles, error: filesError } = await supabase
        .from("packet_case_files")
        .select("storage_asset_id, storage_bucket, storage_path")
        .eq("case_id", id);

      if (filesError) {
        throw filesError;
      }

      const storageCandidates = (storedFiles ?? []).map((file) => ({
        storageAssetId: file.storage_asset_id,
        storageBucket: file.storage_bucket || STORAGE_BUCKET,
        storagePath: file.storage_path,
      }));

      // Persist cleanup intent before the cascading database delete. If the
      // Storage API is temporarily unavailable, a later recycle-bin request
      // can safely retry without losing the object path.
      await enqueueStorageCleanup(supabase, user.id, storageCandidates);

      let deletion = supabase
        .from("packet_cases")
        .delete()
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'));
      if (canHardDeleteWithColumn) {
        deletion = deletion.not("deleted_at", "is", null);
      }
      const { error } = await deletion
        .select(
          canHardDeleteWithColumn
            ? "id, deleted_at"
            : "id"
        )
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        throw error;
      }

      const cleanup = await processStorageCleanupQueue(supabase, user.id, { limit: 100 });

      return jsonWithCors(request, {
        case: mapCaseRow(existing),
        storageCleanupPending: cleanup.failed.length > 0,
      });
    }

    let data:
      | {
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
        }
      | null = null;

    try {
      const result = await supabase
        .from("packet_cases")
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by_user_id: user.id,
        })
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .is("deleted_at", null)
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
        )
        .single();

      if (result.error) {
        if (result.error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        throw result.error;
      }

      data = result.data;
    } catch (error) {
      if (!isRecycleBinSchemaMissing(error)) {
        throw error;
      }

      const existing = await supabase
        .from("packet_cases")
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .single();

      if (existing.error) {
        if (existing.error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        throw existing.error;
      }

      if (isCaseRecycled(existing.data.processing_meta)) {
        return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
      }

      const deletedAt = new Date().toISOString();
      const updated = await supabase
        .from("packet_cases")
        .update({
          processing_meta: withRecycleBinMetadata(existing.data.processing_meta, deletedAt, user.id),
        })
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .single();

      if (updated.error) {
        throw updated.error;
      }

      data = {
        ...updated.data,
        deleted_at: deletedAt,
      };
    }

    return jsonWithCors(request, { case: mapCaseRow(data) });
  } catch (error) {
    return jsonWithCors(request, 
      {
        error: serializeError(error),
      },
      { status: 500 }
    );
  }
}

async function PATCHHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const payload = (await request.json().catch(() => ({}))) as { action?: string };

    if (!["restore", "accept", "reject"].includes(payload.action ?? "")) {
      return jsonWithCors(request, { error: "Unsupported case action." }, { status: 400 });
    }

    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createSupabaseAdminClient();

    if (payload.action === "accept" || payload.action === "reject") {
      const nextStatus = payload.action === "accept" ? "accepted" : "rejected";
      const nextMismatchResolutionStatus = getMismatchResolutionStatusForCaseDecision(payload.action);
      const resolvedAt = new Date().toISOString();

      try {
        const result = await supabase
          .from("packet_cases")
          .update({ status: nextStatus })
          .eq("id", id)
          .or(await listAccessPredicate(request, user.id, 'purchases.view'))
          .is("deleted_at", null)
          .select(
            "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
          )
          .single();

        if (result.error) {
          if (result.error.code === "PGRST116") {
            return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
          }
          throw result.error;
        }

        try {
          const mismatchUpdate = await supabase
            .from("packet_mismatches")
            .update({
              resolution_status: nextMismatchResolutionStatus,
              resolved_at: resolvedAt,
            })
            .eq("case_id", id);

          if (mismatchUpdate.error && !isMismatchResolutionSchemaMissing(mismatchUpdate.error)) {
            throw mismatchUpdate.error;
          }
        } catch (error) {
          if (!isMismatchResolutionSchemaMissing(error)) {
            throw error;
          }
        }

        return jsonWithCors(request, { case: mapCaseRow(result.data) });
      } catch (error) {
        if (!isRecycleBinSchemaMissing(error)) {
          throw error;
        }

        const existing = await supabase
          .from("packet_cases")
          .select(
            "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
          )
          .eq("id", id)
          .or(await listAccessPredicate(request, user.id, 'purchases.view'))
          .single();

        if (existing.error) {
          if (existing.error.code === "PGRST116") {
            return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
          }
          throw existing.error;
        }

        if (isCaseRecycled(existing.data.processing_meta)) {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }

        try {
          const mismatchUpdate = await supabase
            .from("packet_mismatches")
            .update({
              resolution_status: nextMismatchResolutionStatus,
              resolved_at: resolvedAt,
            })
            .eq("case_id", id);

          if (mismatchUpdate.error && !isMismatchResolutionSchemaMissing(mismatchUpdate.error)) {
            throw mismatchUpdate.error;
          }
        } catch (error) {
          if (!isMismatchResolutionSchemaMissing(error)) {
            throw error;
          }
        }

        const updated = await supabase
          .from("packet_cases")
          .update({ status: nextStatus })
          .eq("id", id)
          .or(await listAccessPredicate(request, user.id, 'purchases.view'))
          .select(
            "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
          )
          .single();

        if (updated.error) {
          throw updated.error;
        }

        return jsonWithCors(request, { case: mapCaseRow(updated.data) });
      }
    }

    let data:
      | {
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
        }
      | null = null;

    try {
      const result = await supabase
        .from("packet_cases")
        .update({
          deleted_at: null,
          deleted_by_user_id: null,
        })
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .not("deleted_at", "is", null)
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
        )
        .single();

      if (result.error) {
        if (result.error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        throw result.error;
      }

      data = result.data;
    } catch (error) {
      if (!isRecycleBinSchemaMissing(error)) {
        throw error;
      }

      const existing = await supabase
        .from("packet_cases")
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .single();

      if (existing.error) {
        if (existing.error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        throw existing.error;
      }

      if (!isCaseRecycled(existing.data.processing_meta)) {
        return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
      }

      const updated = await supabase
        .from("packet_cases")
        .update({
          processing_meta: withoutRecycleBinMetadata(existing.data.processing_meta),
        })
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .single();

      if (updated.error) {
        throw updated.error;
      }

      data = {
        ...updated.data,
        deleted_at: null,
      };
    }

    return jsonWithCors(request, { case: mapCaseRow(data) });
  } catch (error) {
    return jsonWithCors(request, 
      {
        error: serializeError(error),
      },
      { status: 500 }
    );
  }
}

export async function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export const GET = withTeamAccess(GETHandler);
export const DELETE = withTeamAccess(DELETEHandler);
export const PATCH = withTeamAccess(PATCHHandler);

import { listAccessPredicate } from '@/lib/access/list-scope';
import {requireAccessContext} from '@/lib/access/server';
import { withTeamAccess } from '@/lib/access/route-boundary';
import { NextResponse } from "next/server";

import {
  applyCorsHeaders,
  optionsWithCors,
} from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  getCaseCategoryFromProcessingMeta,
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
  isLineItemMismatchField,
  serializeFieldsWithLineItems,
} from "@/lib/line-items";
import { mergePersistedStructuredData } from "@/lib/persisted-structured-data";
import { getLatestProcessingJob, mapProcessingJob } from "@/lib/processing/jobs";
import { assessCaseTermsComplianceDetailed } from "@/lib/processing/pipeline";
import { getRecycleBinDeletedAt, isCaseRecycled } from "@/lib/recycle-bin";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  isActionableTermsComplianceMismatch,
  TERMS_COMPLIANCE_FIELD,
  TERMS_COMPLIANCE_MISMATCH_MODE,
} from "@/lib/terms-compliance";
import type { CaseAnalysisMode, CaseDoc, FieldKey, Mismatch } from "@/types/pipeline";

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
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error ?? "Unknown error");

  const record = error as Record<string, unknown>;
  const combined =
    [record.message, record.details, record.hint, record.error]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ") || JSON.stringify(error);

  if (/packet_cases_status_check|violates check constraint/i.test(combined)) {
    return `${combined} Run the case draft migration in Supabase using supabase/packet_case_draft_backend_v5.sql, then retry.`;
  }

  return combined;
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

function parseAnalysisMode(value: FormDataEntryValue | null): CaseAnalysisMode {
  return value === "smart_split" ? "smart_split" : "standard";
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

function mapCaseRow(row: {
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
}) {
  const category = resolveCaseCategoryLabel({
    receiverName: row.buyer_name,
    storedCategory: getCaseCategoryFromProcessingMeta(row.processing_meta, row.status),
    status: row.status,
  });

  return {
    id: row.id,
    slug: row.slug,
    displayName: resolveCaseDisplayName({
      storedDisplayName: row.display_name,
      receiverName: row.buyer_name,
      invoiceNumber: row.invoice_number,
      poNumber: row.po_number,
      category,
      status: row.status,
    }),
    buyerName: row.buyer_name,
    receiverName: row.buyer_name,
    category,
    poNumber: row.po_number,
    invoiceNumber: row.invoice_number,
    status: row.status,
    riskScore: row.risk_score,
    uploadCount: row.upload_count,
    documentCount: row.document_count,
    mismatchCount: row.mismatch_count,
    createdAt: row.created_at,
    deletedAt: row.deleted_at ?? getRecycleBinDeletedAt(row.processing_meta),
  };
}

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const user = await requireRequestUser(request);
    if (!user) {
      return applyCorsHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), request);
    }

    const supabase = createSupabaseAdminClient();
    const fieldConfiguration = await getPersistedPacketFieldConfiguration(
      process.env.TEAM_ACCESS_ENFORCEMENT==='true'?(await requireAccessContext(request)).organizationId:undefined
    );
    const formData = await request.formData();
    const analysisMode = parseAnalysisMode(formData.get("analysisMode"));
    const comparisonOptions = parseComparisonOptions(formData.get("comparisonOptions"));
    const rawDocuments = parseOptionalJsonField<CaseDoc[]>(formData.get("documents"));
    const rawMismatches = parseOptionalJsonField<Mismatch[]>(formData.get("mismatches"));

    let existing:
      | {
          id: string;
          slug?: string;
          display_name?: string;
          buyer_name?: string | null;
          po_number?: string | null;
          invoice_number?: string | null;
          status?: string;
          risk_score?: number;
          upload_count?: number;
          document_count?: number;
          mismatch_count?: number;
          created_at?: string;
          processing_meta?: unknown;
          deleted_at?: string | null;
        }
      | null = null;

    try {
      const result = await supabase
        .from("packet_cases")
        .select("id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at")
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .single();

      if (result.error) {
        if (result.error.code === "PGRST116") {
          return NextResponse.json({ error: "Case not found." }, { status: 404 });
        }
        throw result.error;
      }

      existing = result.data;
    } catch (error) {
      if (!isRecycleBinSchemaMissing(error)) {
        throw error;
      }

      const fallback = await supabase
        .from("packet_cases")
        .select("id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta")
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .single();

      if (fallback.error) {
        if (fallback.error.code === "PGRST116") {
          return NextResponse.json({ error: "Case not found." }, { status: 404 });
        }
        throw fallback.error;
      }

      existing = fallback.data;
    }

    if ((existing.deleted_at ?? null) || isCaseRecycled(existing.processing_meta)) {
      return NextResponse.json({ error: "Case not found." }, { status: 404 });
    }

    if (!rawDocuments) {
      const latestJob = await getLatestProcessingJob(id);
      if (latestJob && (latestJob.status === "queued" || latestJob.status === "running")) {
        const nextCase = {
          ...existing,
          status: "processing",
        };

        return applyCorsHeaders(
          NextResponse.json({
            case: mapCaseRow(nextCase as Parameters<typeof mapCaseRow>[0]),
            job: mapProcessingJob(latestJob),
          }),
          request
        );
      }

      const existingMeta =
        existing.processing_meta && typeof existing.processing_meta === "object"
          ? (existing.processing_meta as Record<string, unknown>)
          : {};

      const updatePayload = {
        status: "processing",
        processing_meta: {
          ...existingMeta,
          analysisMode,
          comparisonOptions,
        },
      };

      let queuedCase:
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
          .update(updatePayload)
          .eq("id", id)
          .or(await listAccessPredicate(request, user.id, 'purchases.view'))
          .select(
            "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
          )
          .single();

        if (result.error) throw result.error;
        queuedCase = result.data;
      } catch (error) {
        if (!isRecycleBinSchemaMissing(error)) {
          throw error;
        }

        const fallback = await supabase
          .from("packet_cases")
          .update(updatePayload)
          .eq("id", id)
          .or(await listAccessPredicate(request, user.id, 'purchases.view'))
          .select(
            "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
          )
          .single();

        if (fallback.error) throw fallback.error;
        queuedCase = fallback.data;
      }

      const { data: insertedJob, error: insertJobError } = await supabase
        .from("packet_processing_jobs")
        .insert({
          case_id: id,
          owner_user_id: user.id,
          job_type: "case_analysis",
          status: "queued",
          attempt_count: 0,
          max_attempts: 3,
          progress: 0,
          stage: "Queued for analysis",
          error: null,
          result: {
            analysisMode,
            comparisonOptions,
          },
        })
        .select("*")
        .single();

      if (insertJobError) {
        throw insertJobError;
      }

      return applyCorsHeaders(
        NextResponse.json({
          case: mapCaseRow(queuedCase),
          job: mapProcessingJob(insertedJob),
        }),
        request
      );
    }

    const documents = sanitizeDocumentsForStorage(rawDocuments, fieldConfiguration);
    const baseMismatches = sanitizeMismatchesForStorage(
      rawMismatches ?? [],
      documents,
      fieldConfiguration
    );

    if (!documents.length) {
      return NextResponse.json(
        { error: "No processed documents were provided to save." },
        { status: 400 }
      );
    }

    const [
      { data: existingDocuments, error: existingDocumentsError },
      { count: uploadCount, error: fileCountError },
      { error: documentDeleteError },
      { error: mismatchDeleteError },
    ] = await Promise.all([
      supabase
        .from("packet_documents")
        .select("client_document_id, source_file_name, source_hint, document_type, title, extracted_fields")
        .eq("case_id", id),
      supabase
        .from("packet_case_files")
        .select("id", { count: "exact", head: true })
        .eq("case_id", id),
      supabase.from("packet_documents").delete().eq("case_id", id),
      supabase.from("packet_mismatches").delete().eq("case_id", id),
    ]);

    if (existingDocumentsError) throw existingDocumentsError;
    if (fileCountError) throw fileCountError;
    if (documentDeleteError) throw documentDeleteError;
    if (mismatchDeleteError) throw mismatchDeleteError;

    const documentsWithPersistedStructuredData = enrichDocumentsWithPacketGstTaxContext(
      mergePersistedStructuredData(
        documents,
        existingDocuments ?? [],
        fieldConfiguration
      )
    );
    const termsCompliance = await assessCaseTermsComplianceDetailed(documentsWithPersistedStructuredData);
    const mismatches = [...baseMismatches, ...termsCompliance.mismatches];

    const documentRows = documentsWithPersistedStructuredData.map((document) => ({
      case_id: id,
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
    if (documentInsertError) throw documentInsertError;

    if (mismatches.length) {
      const mismatchRows = mismatches.map((mismatch) => ({
        case_id: id,
        client_mismatch_id: mismatch.id,
        field_name: mismatch.field,
        values_json: mismatch.values ?? [],
        analysis: mismatch.analysis ?? null,
        fix_plan: mismatch.fixPlan ?? null,
      }));

      const { error: mismatchInsertError } = await supabase.from("packet_mismatches").insert(mismatchRows);
      if (mismatchInsertError) throw mismatchInsertError;
    }

    const summary = summarizeCase(
      documentsWithPersistedStructuredData,
      mismatches,
      fieldConfiguration
    );
    const displayName = await resolveCaseDisplayNameWithAI(
      documentsWithPersistedStructuredData,
      summary
    );
    const existingMeta =
      existing.processing_meta && typeof existing.processing_meta === "object"
        ? (existing.processing_meta as Record<string, unknown>)
        : {};
    const nextCasePayload = {
      slug: summary.slug,
      display_name: displayName,
      buyer_name: summary.buyerName || null,
      po_number: summary.poNumber || null,
      invoice_number: summary.invoiceNumber || null,
      status: "completed",
      risk_score: summary.riskScore,
      upload_count: uploadCount ?? documentsWithPersistedStructuredData.length,
      document_count: documentsWithPersistedStructuredData.length,
      mismatch_count: mismatches.length,
      processing_meta: {
        ...existingMeta,
        draft: false,
        analyzedAt: new Date().toISOString(),
        caseCategory: summary.category,
        packetCategory: summary.packetCategory,
        documentTypes: summary.documentTypes,
        missingDocumentGroups: summary.missingDocTypes,
        paymentGap: summary.paymentGap,
        comparisonOptions,
        termsComplianceChecklist: termsCompliance.checklist,
        termsComplianceMismatchMode: TERMS_COMPLIANCE_MISMATCH_MODE,
      },
    };

    let updatedCase:
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
        .update(nextCasePayload)
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
        )
        .single();

      if (result.error) throw result.error;
      updatedCase = result.data;
    } catch (error) {
      if (!isRecycleBinSchemaMissing(error)) {
        throw error;
      }

      const fallback = await supabase
        .from("packet_cases")
        .update(nextCasePayload)
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .single();

      if (fallback.error) throw fallback.error;
      updatedCase = fallback.data;
    }

    return applyCorsHeaders(NextResponse.json({ case: mapCaseRow(updatedCase) }), request);
  } catch (error) {
    return applyCorsHeaders(NextResponse.json({ error: serializeError(error) }, { status: 500 }), request);
  }
}

export async function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export const POST = withTeamAccess(POSTHandler);

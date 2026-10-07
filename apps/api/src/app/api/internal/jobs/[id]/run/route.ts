import { jsonWithCors } from "@/lib/api/cors";
import {assertQueuedResource,QueuedAccessDenied} from '@/lib/access/queued-authority.mjs';
import { resolveCaseDisplayNameWithAI } from "@/lib/case-naming";
import { summarizeCase } from "@/lib/case-summary";
import { getPersistedPacketFieldConfiguration } from "@/lib/field-settings-service";
import { serializeFieldsWithLineItems } from "@/lib/line-items";
import { mergePersistedStructuredData } from "@/lib/persisted-structured-data";
import {
  assessCaseTermsComplianceDetailed,
  enrichProcessedDocuments,
  processStoredCaseFiles,
  reviewAndCorrectExtractedDocuments,
  verifyProcessedDocuments,
} from "@/lib/processing/pipeline";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { TERMS_COMPLIANCE_MISMATCH_MODE } from "@/lib/terms-compliance";
import { groupDocumentsForVerification } from "@/services/verification";
import type { CaseAnalysisMode, CaseDoc, Mismatch } from "@/types/pipeline";
import { randomUUID } from "crypto";

const WORKER_SECRET = process.env.WORKER_SECRET || "";
const STALE_JOB_RUN_MESSAGE = "This processing run was superseded by another worker run.";
const STORAGE_BUCKET = "packet-files";

class StaleJobRunError extends Error {
  constructor(message = STALE_JOB_RUN_MESSAGE) {
    super(message);
    this.name = "StaleJobRunError";
  }
}

function unauthorized(request: Request) {
  return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function readAnalysisMode(value: unknown): CaseAnalysisMode {
  return value === "smart_split" ? "smart_split" : "standard";
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

type StoredCaseFileRow = {
  id: string;
  original_name: string;
  storage_asset_id: string | null;
  content_sha256: string | null;
  storage_bucket: string | null;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
};

type PreparedCaseGroup = {
  caseId: string;
  groupIndex: number;
  groupId: string;
  sourceFileNames: string[];
  documents: CaseDoc[];
  mismatches: Mismatch[];
  termsChecklist: unknown[];
  verificationGroups: unknown[];
  summary: ReturnType<typeof summarizeCase>;
  displayName: string;
};

function normalizeSourceFileName(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") || "";
}

function stripUploadIdentityMeta(meta: Record<string, unknown>) {
  const rest = { ...meta };
  const uploadFingerprint = rest.uploadFingerprint;
  [
    "uploadFingerprint",
    "uploadFingerprintVersion",
    "uploadContentSignature",
    "uploadLegacySignature",
    "uploadFileFingerprints",
    "duplicateUploadMode",
    "duplicateUploadRunId",
    "originalUploadFingerprint",
    "originalUploadContentSignature",
    "originalUploadLegacySignature",
  ].forEach((key) => {
    delete rest[key];
  });
  const originalFingerprint = typeof uploadFingerprint === "string" ? uploadFingerprint : null;
  return {
    meta: rest,
    originalFingerprint,
  };
}

function hasCaseAnchorDocument(documents: CaseDoc[]) {
  return documents.some((document) => {
    const fields = document.fields ?? {};
    const hasReference = Boolean(
      fields.invoiceNumber ||
        fields.referenceInvoiceNumber ||
        fields.poNumber ||
        fields.referencePoNumber ||
        fields.eWayBillNumber ||
        fields.deliveryNoteNumber ||
        fields.lorryReceiptNumber
    );
    const hasCommercialData = Boolean(
      fields.totalAmount ||
        fields.totalTaxableAmount ||
        fields.subtotal ||
        fields.itemQuantity ||
        (document.lineItems?.length ?? 0) > 0
    );
    return (
      ["Invoice", "Tax Invoice", "Purchase Order", "Amended Purchase Order", "E-Way Bill", "Delivery Note", "Delivery Challan"].includes(document.type) &&
      (hasReference || hasCommercialData)
    );
  });
}

function groupsShareSourceFile(groups: Array<{ group: { sourceFileNames: string[] } }>) {
  const counts = new Map<string, number>();
  for (const { group } of groups) {
    const names = new Set(group.sourceFileNames.map(normalizeSourceFileName).filter(Boolean));
    names.forEach((name) => counts.set(name, (counts.get(name) ?? 0) + 1));
  }
  return Array.from(counts.values()).some((count) => count >= 2);
}

function shouldPersistAsSplitCases(groups: ReturnType<typeof groupDocumentsForVerification>) {
  if (groups.length < 2 || !groupsShareSourceFile(groups)) return false;
  const credibleGroups = groups.filter(({ docs }) => hasCaseAnchorDocument(docs));
  return credibleGroups.length >= 2 && credibleGroups.length === groups.length;
}

function sourceRowsForGroup(files: StoredCaseFileRow[], sourceFileNames: string[]) {
  const names = new Set(sourceFileNames.map(normalizeSourceFileName).filter(Boolean));
  const matched = names.size
    ? files.filter((file) => names.has(normalizeSourceFileName(file.original_name)))
    : [];
  return matched.length ? matched : files;
}

function filterMismatchesForDocuments(mismatches: Mismatch[], documents: CaseDoc[]) {
  const documentIds = new Set(documents.map((document) => document.id));
  return mismatches.filter((mismatch) => {
    const values = mismatch.values ?? [];
    return values.length === 0 || values.some((entry) => entry.docId && documentIds.has(entry.docId));
  });
}

function buildSplitAnalysisMeta(params: {
  current: PreparedCaseGroup;
  groups: PreparedCaseGroup[];
  sourceCaseId: string;
}) {
  return {
    groupCount: params.groups.length,
    groupIndex: params.current.groupIndex,
    sourceCaseId: params.sourceCaseId,
    sourceFileNames: params.current.sourceFileNames,
    groupId: params.current.groupId,
    siblingCases: params.groups
      .filter((group) => group.caseId !== params.current.caseId)
      .map((group) => ({
        id: group.caseId,
        displayName: group.displayName,
        groupIndex: group.groupIndex,
      })),
    note: `This uploaded file was split into ${params.groups.length} separate cases during multi-doc analysis.`,
  };
}

async function insertCaseDocumentsAndMismatches(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  caseId: string,
  documents: CaseDoc[],
  mismatches: Mismatch[]
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

  if (documentRows.length) {
    const { error } = await supabase.from("packet_documents").insert(documentRows);
    if (error) throw error;
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

    const { error } = await supabase.from("packet_mismatches").insert(mismatchRows);
    if (error) throw error;
  }
}

async function copyCaseFilesForGroup(params: {
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  files: StoredCaseFileRow[];
  sourceFileNames: string[];
  caseId: string;
  uploadedFiles: Array<{ bucket: string; path: string }>;
}) {
  const sourceFiles = sourceRowsForGroup(params.files, params.sourceFileNames);
  const fileRows = [];

  for (const file of sourceFiles) {
    const sourceBucket = file.storage_bucket || STORAGE_BUCKET;
    fileRows.push({
      case_id: params.caseId,
      original_name: file.original_name,
      storage_bucket: sourceBucket,
      storage_path: file.storage_path,
      storage_asset_id: file.storage_asset_id,
      content_sha256: file.content_sha256,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
    });
  }

  if (fileRows.length) {
    const { error } = await params.supabase.from("packet_case_files").insert(fileRows);
    if (error) throw error;
  }

  return fileRows.length;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!WORKER_SECRET || request.headers.get("x-worker-secret") !== WORKER_SECRET) {
    return unauthorized(request);
  }

  const { id } = await context.params;
  const supabase = createSupabaseAdminClient();
  const now = new Date().toISOString();
  const createdSiblingCaseIds: string[] = [];
  const uploadedSiblingFiles: Array<{ bucket: string; path: string }> = [];

  const { data: job, error: jobError } = await supabase
    .from("packet_processing_jobs")
    .select("*")
    .eq("id", id)
    .single();

  if (jobError) {
    return jsonWithCors(request, { error: toMessage(jobError) }, { status: 500 });
  }

  if (job.status !== "running") {
    return jsonWithCors(request, { error: "Job is not in a runnable state." }, { status: 409 });
  }

  const runId = randomUUID();
  let jobScope: {organization_id:string;company_id:string}|null = null;
  try {
    jobScope=await assertQueuedResource(supabase,{actorId:job.owner_user_id,resourceType:'case',resourceId:job.case_id,permission:'purchases.prepare'});
  } catch(error) {
    if(error instanceof QueuedAccessDenied){
      const stopped=await supabase.from('packet_processing_jobs').update({status:'failed',error:error.message,finished_at:now,locked_at:null,locked_by:null}).eq('id',id).eq('status','running');
      if(stopped.error)return jsonWithCors(request,{error:'Could not close revoked work.'},{status:503});
      return jsonWithCors(request,{error:error.message},{status:409});
    }
    return jsonWithCors(request,{error:'Queued authorization is unavailable.'},{status:503});
  }
  const jobResult = readRecord(job.result);
  const lockedBy = typeof job.locked_by === "string" && job.locked_by.trim() ? job.locked_by : null;
  const attemptCount = asNumber(job.attempt_count);
  if (!lockedBy) {
    return jsonWithCors(request, { error: "Job has no worker lock." }, { status: 409 });
  }

  const { data: caseRow, error: caseError } = await supabase
    .from("packet_cases")
    .select("id, owner_user_id, upload_count, processing_meta")
    .eq("id", job.case_id)
    .single();

  if (caseError) {
    return jsonWithCors(request, { error: toMessage(caseError) }, { status: 500 });
  }

  const assertCurrentRun = async () => {
    const { data: currentJob, error } = await supabase
      .from("packet_processing_jobs")
      .select("status, locked_by, attempt_count, result")
      .eq("id", id)
      .single();

    if (error) {
      throw error;
    }

    const currentResult = readRecord(currentJob.result);
    if (
      currentJob.status !== "running" ||
      currentJob.locked_by !== lockedBy ||
      asNumber(currentJob.attempt_count) !== attemptCount ||
      currentResult.activeRunId !== runId
    ) {
      throw new StaleJobRunError();
    }
  };

  const updateCurrentJob = async (fields: Record<string, unknown>) => {
    const { data, error } = await supabase
      .from("packet_processing_jobs")
      .update(fields)
      .eq("id", id)
      .eq("status", "running")
      .eq("locked_by", lockedBy)
      .eq("attempt_count", attemptCount)
      .select("id")
      .maybeSingle();

    if (error) {
      throw error;
    }
    if (!data) {
      throw new StaleJobRunError();
    }
  };

  const deleteDuplicateAnalysisRows = async (caseId: string) => {
    const [{ data: documentRows, error: documentError }, { data: mismatchRows, error: mismatchError }] =
      await Promise.all([
        supabase
          .from("packet_documents")
          .select("id, client_document_id, source_file_name, source_hint, document_type, title, created_at")
          .eq("case_id", caseId)
          .order("created_at", { ascending: false }),
        supabase
          .from("packet_mismatches")
          .select("id, client_mismatch_id, field_name, values_json, created_at")
          .eq("case_id", caseId)
          .order("created_at", { ascending: false }),
      ]);

    if (documentError) throw documentError;
    if (mismatchError) throw mismatchError;

    const documentSeen = new Set<string>();
    const duplicateDocumentIds: string[] = [];
    for (const row of documentRows ?? []) {
      const key = [
        row.client_document_id || "",
        row.source_file_name || "",
        row.source_hint || "",
        row.document_type || "",
        row.title || "",
      ].join("::");
      if (documentSeen.has(key)) {
        duplicateDocumentIds.push(row.id);
      } else {
        documentSeen.add(key);
      }
    }

    const mismatchSeen = new Set<string>();
    const duplicateMismatchIds: string[] = [];
    for (const row of mismatchRows ?? []) {
      const key = [
        row.client_mismatch_id || "",
        row.field_name || "",
        JSON.stringify(row.values_json ?? []),
      ].join("::");
      if (mismatchSeen.has(key)) {
        duplicateMismatchIds.push(row.id);
      } else {
        mismatchSeen.add(key);
      }
    }

    await Promise.all([
      duplicateDocumentIds.length
        ? supabase.from("packet_documents").delete().in("id", duplicateDocumentIds)
        : Promise.resolve({ error: null }),
      duplicateMismatchIds.length
        ? supabase.from("packet_mismatches").delete().in("id", duplicateMismatchIds)
        : Promise.resolve({ error: null }),
    ]).then((results) => {
      for (const result of results) {
        if (result.error) throw result.error;
      }
    });
  };

  try {
    const runStartedAt = Date.now();
    const performance = {
      extractionMs: 0,
      reviewMs: 0,
      finalizeMs: 0,
      totalMs: 0,
    };
    await updateCurrentJob({
      stage: "Preparing files",
      progress: 2,
      error: null,
      locked_at: now,
      result: {
        ...jobResult,
        activeRunId: runId,
        activeRunStartedAt: now,
      },
    });

    const analysisMode = readAnalysisMode(jobResult.analysisMode);
    const comparisonOptions = jobResult.comparisonOptions;
    const fieldConfiguration = await getPersistedPacketFieldConfiguration(jobScope?.organization_id ?? 'default');

    const extractionStartedAt = Date.now();
    const processed = await processStoredCaseFiles({
      caseId: job.case_id,
      fieldConfiguration,
      analysisMode,
      comparisonOptions,
      onProgress: async ({ progress, stage }) => {
        await updateCurrentJob({
          progress,
          stage,
          error: null,
        });
      },
    });
    performance.extractionMs = Date.now() - extractionStartedAt;

    await assertCurrentRun();

    await updateCurrentJob({
      stage: "Preparing extracted results",
      progress: 93,
    });

    await assertCurrentRun();

    const [
      { data: existingDocuments, error: existingDocumentsError },
      { data: caseFiles, error: caseFilesError },
      { error: documentDeleteError },
      { error: mismatchDeleteError },
    ] = await Promise.all([
      supabase
        .from("packet_documents")
        .select("client_document_id, source_file_name, source_hint, document_type, title, extracted_fields")
        .eq("case_id", job.case_id),
      supabase
        .from("packet_case_files")
        .select(
          "id, original_name, storage_asset_id, content_sha256, storage_bucket, storage_path, mime_type, size_bytes"
        )
        .eq("case_id", job.case_id),
      supabase.from("packet_documents").delete().eq("case_id", job.case_id),
      supabase.from("packet_mismatches").delete().eq("case_id", job.case_id),
    ]);

    if (existingDocumentsError) throw existingDocumentsError;
    if (caseFilesError) throw caseFilesError;
    if (documentDeleteError) throw documentDeleteError;
    if (mismatchDeleteError) throw mismatchDeleteError;
    const storedCaseFiles = (caseFiles ?? []) as StoredCaseFileRow[];
    const uploadCount = storedCaseFiles.length || caseRow.upload_count;

    let documents = enrichProcessedDocuments(
      mergePersistedStructuredData(
        processed.documents,
        existingDocuments ?? [],
        fieldConfiguration
      )
    );
    await updateCurrentJob({
      stage: "Reviewing extraction accuracy",
      progress: 94,
    });
    await assertCurrentRun();

    const reviewStartedAt = Date.now();
    const preliminaryVerification = verifyProcessedDocuments(documents, processed.comparisonOptions);
    const reviewCandidateDocumentIds = new Set(
      preliminaryVerification.mismatches.flatMap((mismatch) =>
        mismatch.values.map((value) => value.docId)
      )
    );
    const extractionReview = await reviewAndCorrectExtractedDocuments(documents, {
      candidateDocumentIds: reviewCandidateDocumentIds,
    });
    documents = enrichProcessedDocuments(extractionReview.documents);
    performance.reviewMs = Date.now() - reviewStartedAt;
    const finalizeStartedAt = Date.now();

    await updateCurrentJob({
      stage: "Saving reviewed results",
      progress: 96,
    });
    await assertCurrentRun();

    const existingMeta =
      caseRow.processing_meta && typeof caseRow.processing_meta === "object"
        ? (caseRow.processing_meta as Record<string, unknown>)
        : {};

    const verificationSplitGroups =
      analysisMode === "smart_split"
        ? groupDocumentsForVerification(documents, processed.comparisonOptions)
        : [];

    if (analysisMode === "smart_split" && shouldPersistAsSplitCases(verificationSplitGroups)) {
      const preparedGroups: PreparedCaseGroup[] = [];

      for (let index = 0; index < verificationSplitGroups.length; index += 1) {
        const splitGroup = verificationSplitGroups[index];
        const groupDocuments = splitGroup.docs;
        const groupBaseVerified = verifyProcessedDocuments(groupDocuments, processed.comparisonOptions);
        const groupTermsCompliance = await assessCaseTermsComplianceDetailed(groupDocuments);
        const groupMismatches = [
          ...filterMismatchesForDocuments(groupBaseVerified.mismatches, groupDocuments),
          ...filterMismatchesForDocuments(groupTermsCompliance.mismatches, groupDocuments),
        ];
        const groupSummary = summarizeCase(groupDocuments, groupMismatches, fieldConfiguration);
        const groupDisplayName = await resolveCaseDisplayNameWithAI(groupDocuments, groupSummary);

        preparedGroups.push({
          caseId: index === 0 ? job.case_id : randomUUID(),
          groupIndex: index + 1,
          groupId: splitGroup.group.groupId,
          sourceFileNames: splitGroup.group.sourceFileNames,
          documents: groupDocuments,
          mismatches: groupMismatches,
          termsChecklist: groupTermsCompliance.checklist,
          verificationGroups: groupBaseVerified.verificationGroups,
          summary: groupSummary,
          displayName: groupDisplayName,
        });
      }

      const updateCaseFromGroup = async (group: PreparedCaseGroup, uploadCountForGroup: number) => {
        const splitAnalysis = buildSplitAnalysisMeta({
          current: group,
          groups: preparedGroups,
          sourceCaseId: job.case_id,
        });

        return supabase
          .from("packet_cases")
          .update({
            slug: group.summary.slug,
            display_name: group.displayName,
            buyer_name: group.summary.buyerName || null,
            po_number: group.summary.poNumber || null,
            invoice_number: group.summary.invoiceNumber || null,
            status: "completed",
            risk_score: group.summary.riskScore,
            upload_count: uploadCountForGroup,
            document_count: group.documents.length,
            mismatch_count: group.mismatches.length,
            processing_meta: {
              ...existingMeta,
              draft: false,
              analyzedAt: new Date().toISOString(),
              caseCategory: group.summary.category,
              packetCategory: group.summary.packetCategory,
              documentTypes: group.summary.documentTypes,
              missingDocumentGroups: group.summary.missingDocTypes,
              paymentGap: group.summary.paymentGap,
              analysisMode,
              comparisonOptions: processed.comparisonOptions,
              verificationGroups: group.verificationGroups,
              termsComplianceChecklist: group.termsChecklist,
              termsComplianceMismatchMode: TERMS_COMPLIANCE_MISMATCH_MODE,
              extractionReview: extractionReview.review,
              splitAnalysis,
              lastProcessingError: null,
            },
          })
          .eq("id", group.caseId);
      };

      const insertSiblingCase = async (group: PreparedCaseGroup) => {
        const { meta: siblingBaseMeta, originalFingerprint } = stripUploadIdentityMeta(existingMeta);
        const splitAnalysis = buildSplitAnalysisMeta({
          current: group,
          groups: preparedGroups,
          sourceCaseId: job.case_id,
        });
        const sourceFileCount = sourceRowsForGroup(storedCaseFiles, group.sourceFileNames).length;

        createdSiblingCaseIds.push(group.caseId);
        const { error: caseInsertError } = await supabase.from("packet_cases").insert({
          id: group.caseId,
          owner_user_id: jobScope ? job.owner_user_id : caseRow.owner_user_id,
          ...(jobScope ? {access_organization_id:jobScope.organization_id,access_company_id:jobScope.company_id} : {}),
          slug: group.summary.slug,
          display_name: group.displayName,
          buyer_name: group.summary.buyerName || null,
          po_number: group.summary.poNumber || null,
          invoice_number: group.summary.invoiceNumber || null,
          status: "completed",
          risk_score: group.summary.riskScore,
          upload_count: sourceFileCount,
          document_count: group.documents.length,
          mismatch_count: group.mismatches.length,
          processing_meta: {
            ...siblingBaseMeta,
            ...(originalFingerprint ? { splitSourceUploadFingerprint: originalFingerprint } : {}),
            draft: false,
            analyzedAt: new Date().toISOString(),
            caseCategory: group.summary.category,
            packetCategory: group.summary.packetCategory,
            documentTypes: group.summary.documentTypes,
            missingDocumentGroups: group.summary.missingDocTypes,
            paymentGap: group.summary.paymentGap,
            analysisMode,
            comparisonOptions: processed.comparisonOptions,
            verificationGroups: group.verificationGroups,
            termsComplianceChecklist: group.termsChecklist,
            termsComplianceMismatchMode: TERMS_COMPLIANCE_MISMATCH_MODE,
            extractionReview: extractionReview.review,
            splitAnalysis,
            lastProcessingError: null,
          },
        });

        if (caseInsertError) throw caseInsertError;

        await copyCaseFilesForGroup({
          supabase,
          files: storedCaseFiles,
          sourceFileNames: group.sourceFileNames,
          caseId: group.caseId,
          uploadedFiles: uploadedSiblingFiles,
        });
        await insertCaseDocumentsAndMismatches(supabase, group.caseId, group.documents, group.mismatches);
      };

      const [primaryGroup, ...siblingGroups] = preparedGroups;
      await insertCaseDocumentsAndMismatches(supabase, primaryGroup.caseId, primaryGroup.documents, primaryGroup.mismatches);
      const { error: primaryUpdateError } = await updateCaseFromGroup(primaryGroup, uploadCount);
      if (primaryUpdateError) throw primaryUpdateError;

      for (const group of siblingGroups) {
        await insertSiblingCase(group);
      }

      await Promise.all(preparedGroups.map((group) => deleteDuplicateAnalysisRows(group.caseId)));
      await assertCurrentRun();

      performance.finalizeMs = Date.now() - finalizeStartedAt;
      performance.totalMs = Date.now() - runStartedAt;
      console.info("[packet-performance]", JSON.stringify({ jobId: id, caseId: job.case_id, analysisMode, ...performance }));

      await updateCurrentJob({
        status: "succeeded",
        progress: 100,
        stage: "Completed",
        error: null,
        result: {
          analysisMode,
          documentCount: documents.length,
          mismatchCount: preparedGroups.reduce((sum, group) => sum + group.mismatches.length, 0),
          createdCaseIds: preparedGroups.map((group) => group.caseId),
          splitAnalysis: {
            groupCount: preparedGroups.length,
            sourceCaseId: job.case_id,
          },
          extractionReview: extractionReview.review,
          performance,
        },
        finished_at: new Date().toISOString(),
      });

      return jsonWithCors(request, { ok: true, caseIds: preparedGroups.map((group) => group.caseId) });
    }

    const baseVerified = verifyProcessedDocuments(documents, processed.comparisonOptions);
    const termsCompliance = await assessCaseTermsComplianceDetailed(documents);
    const verified = {
      ...baseVerified,
      mismatches: [...baseVerified.mismatches, ...termsCompliance.mismatches],
    };
    const summary = summarizeCase(documents, verified.mismatches, fieldConfiguration);
    const displayName = await resolveCaseDisplayNameWithAI(documents, summary);

    await insertCaseDocumentsAndMismatches(supabase, job.case_id, documents, verified.mismatches);

    await deleteDuplicateAnalysisRows(job.case_id);
    await assertCurrentRun();

    const { error: updateCaseError } = await supabase
      .from("packet_cases")
      .update({
        slug: summary.slug,
        display_name: displayName,
        buyer_name: summary.buyerName || null,
        po_number: summary.poNumber || null,
        invoice_number: summary.invoiceNumber || null,
        status: "completed",
        risk_score: summary.riskScore,
        upload_count: uploadCount ?? caseRow.upload_count,
        document_count: documents.length,
        mismatch_count: verified.mismatches.length,
        processing_meta: {
          ...existingMeta,
          draft: false,
          analyzedAt: new Date().toISOString(),
          caseCategory: summary.category,
          packetCategory: summary.packetCategory,
          documentTypes: summary.documentTypes,
          missingDocumentGroups: summary.missingDocTypes,
          paymentGap: summary.paymentGap,
          analysisMode,
          comparisonOptions: processed.comparisonOptions,
          verificationGroups: verified.verificationGroups,
          termsComplianceChecklist: termsCompliance.checklist,
          termsComplianceMismatchMode: TERMS_COMPLIANCE_MISMATCH_MODE,
          extractionReview: extractionReview.review,
          lastProcessingError: null,
        },
      })
      .eq("id", job.case_id);

    if (updateCaseError) {
      throw updateCaseError;
    }

    performance.finalizeMs = Date.now() - finalizeStartedAt;
    performance.totalMs = Date.now() - runStartedAt;
    console.info("[packet-performance]", JSON.stringify({ jobId: id, caseId: job.case_id, analysisMode, ...performance }));

    await updateCurrentJob({
      status: "succeeded",
      progress: 100,
      stage: "Completed",
      error: null,
      result: {
        summary,
        analysisMode,
        documentCount: documents.length,
        mismatchCount: verified.mismatches.length,
        verificationGroupCount: verified.verificationGroups.length,
        extractionReview: extractionReview.review,
        performance,
      },
      finished_at: new Date().toISOString(),
    });

    return jsonWithCors(request, { ok: true });
  } catch (error) {
    const message = toMessage(error);
    if (error instanceof StaleJobRunError) {
      return jsonWithCors(request, { ok: false, stale: true, error: message }, { status: 409 });
    }

    if (uploadedSiblingFiles.length > 0 || createdSiblingCaseIds.length > 0) {
      try {
        const filesByBucket = new Map<string, string[]>();
        for (const file of uploadedSiblingFiles) {
          filesByBucket.set(file.bucket, [...(filesByBucket.get(file.bucket) ?? []), file.path]);
        }
        for (const [bucket, paths] of filesByBucket.entries()) {
          if (paths.length) {
            await supabase.storage.from(bucket).remove(paths);
          }
        }
        if (createdSiblingCaseIds.length) {
          await supabase.from("packet_cases").delete().in("id", createdSiblingCaseIds);
        }
      } catch (cleanupError) {
        console.warn("Failed to clean up partial split-analysis cases", cleanupError);
      }
    }

    const shouldRetry = job.attempt_count < job.max_attempts;
    const nextRunAt = new Date(
      Date.now() + Math.min(60_000 * Math.pow(2, Math.max(0, job.attempt_count - 1)), 15 * 60_000)
    ).toISOString();

    await supabase
      .from("packet_processing_jobs")
      .update(
        shouldRetry
          ? {
              status: "queued",
              progress: 0,
              stage: "Queued for retry",
              error: message,
              locked_at: null,
              locked_by: null,
              next_run_at: nextRunAt,
            }
          : {
              status: "failed",
              progress: 100,
              stage: "Failed",
              error: message,
              finished_at: new Date().toISOString(),
            }
      )
      .eq("id", id);

    await supabase
      .from("packet_cases")
      .update({
        status: shouldRetry ? "processing" : "failed",
        processing_meta: {
          ...(caseRow.processing_meta && typeof caseRow.processing_meta === "object"
            ? (caseRow.processing_meta as Record<string, unknown>)
            : {}),
          lastProcessingError: message,
        },
      })
      .eq("id", job.case_id);

    return jsonWithCors(request, { error: message }, { status: 500 });
  }
}

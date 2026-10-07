import { withTeamAccess } from '@/lib/access/route-boundary';
import { applyCorsHeaders, jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { NextResponse } from 'next/server';
import { requireRequestUser } from "@/lib/api/request-auth";
import { listAccessPredicate } from "@/lib/access/list-scope";
import { AccessError, requireAccessContext } from "@/lib/access/server";

import {
  getCaseCategoryFromProcessingMeta,
  resolveCaseDisplayName,
  resolveCaseCategoryLabel,
} from "@/lib/case-summary";
import { getRecycleBinDeletedAt, isCaseRecycled } from "@/lib/recycle-bin";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  ensureStorageAsset,
  removeStorageObjectsIfUnreferenced,
  type StorageObjectCandidate,
} from "@/lib/storage-assets";
import { mergeUploadGroupMeta, readUploadGroupMeta } from "@/lib/upload-groups";

const STORAGE_BUCKET = "packet-files";

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

function isFileEntry(entry: FormDataEntryValue): entry is File {
  return typeof entry !== "string";
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

function serializeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error ?? "Unknown error");

  const record = error as Record<string, unknown>;
  return [record.message, record.details, record.hint, record.error]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ") || JSON.stringify(error);
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

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const fileId = new URL(request.url).searchParams.get("fileId");

    if (!fileId) {
      return jsonWithCors(request, { error: "Missing fileId." }, { status: 400 });
    }

    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const accessPredicate=await listAccessPredicate(request,user.id,"purchases.view");
    const supabase = createSupabaseAdminClient();
    let existing: { processing_meta?: unknown; deleted_at?: string | null } | null = null;

    try {
      const result = await supabase
        .from("packet_cases")
        .select("id, owner_user_id, processing_meta, deleted_at")
        .eq("id", id)
        .or(accessPredicate)
        .single();

      if (result.error) {
        if (result.error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        throw result.error;
      }

      existing = result.data;
    } catch (error) {
    if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
      if (!isRecycleBinSchemaMissing(error)) {
        throw error;
      }

      const fallback = await supabase
        .from("packet_cases")
        .select("id, owner_user_id, processing_meta")
        .eq("id", id)
        .or(accessPredicate)
        .single();

      if (fallback.error) {
        if (fallback.error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
        }
        throw fallback.error;
      }

      existing = {
        ...fallback.data,
        deleted_at: getRecycleBinDeletedAt(fallback.data.processing_meta),
      };
    }

    if ((existing.deleted_at ?? null) || isCaseRecycled(existing.processing_meta)) {
      return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
    }

    const { data: file, error: fileError } = await supabase
      .from("packet_case_files")
      .select("id, storage_bucket, storage_path, mime_type, size_bytes")
      .eq("id", fileId)
      .eq("case_id", id)
      .single();

    if (fileError) {
      if (fileError.code === "PGRST116") {
        return jsonWithCors(request, { error: "File not found." }, { status: 404 });
      }
      throw fileError;
    }

    const bucketName = file.storage_bucket || STORAGE_BUCKET;
    if (process.env.TEAM_ACCESS_ENFORCEMENT === 'true') {
      // A reusable Storage URL bypasses membership revocation. Team previews
      // remain authenticated API reads; no signed capability leaves the server.
      if (new URL(request.url).searchParams.get('content') !== '1') {
        return jsonWithCors(request, {
          fileId: file.id,
          contentPath: `/api/cases/${id}/files?${new URLSearchParams({fileId: file.id, content: '1'})}`,
        }, {headers: {'Cache-Control': 'private, no-store'}});
      }
      const mime = String(file.mime_type || '').toLowerCase();
      if (!['application/pdf','image/png','image/jpeg','image/webp','image/gif'].includes(mime)) {
        throw new AccessError('This file type cannot be previewed safely.',415);
      }
      const size = Number(file.size_bytes);
      if (!Number.isSafeInteger(size) || size <= 0 || size > 25 * 1024 * 1024) {
        throw new AccessError('Source preview exceeds the supported size limit.',413);
      }
      const {data, error} = await supabase.storage.from(bucketName).download(file.storage_path);
      if (error || !data) throw new AccessError('Source preview is unavailable.',503);
      if (data.size > 25 * 1024 * 1024) throw new AccessError('Source preview exceeds the supported size limit.',413);
      return applyCorsHeaders(new NextResponse(data, {headers: {
        'Content-Type': mime, 'Content-Length': String(data.size),
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'", 'Content-Disposition': 'inline',
      }}), request);
    }
    const { data: signedData, error: signedError } = await supabase.storage
      .from(bucketName)
      .createSignedUrl(file.storage_path, 60 * 60);

    if (signedError || !signedData?.signedUrl) {
      throw signedError ?? new Error("Unable to create preview URL.");
    }

    return jsonWithCors(request, {
      fileId: file.id,
      signedUrl: signedData.signedUrl,
    });
  } catch (error) {
    if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
    return jsonWithCors(request, { error: serializeError(error) }, { status: 500 });
  }
}

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const uploadedPaths: StorageObjectCandidate[] = [];
  const supabase = createSupabaseAdminClient();

  try {
    const { id } = await context.params;
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const mode = formData.get("mode") === "overwrite" ? "overwrite" : "append";
    const files = formData.getAll("files").filter(isFileEntry);
    const uploadGroups = parseUploadGroups(formData.get("uploadGroups"));

    if (!files.length) {
      return jsonWithCors(request, { error: "Upload at least one file." }, { status: 400 });
    }

    let existing:
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
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta, deleted_at"
        )
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .single();

      if (result.error) {
        if (result.error.code === "PGRST116") {
          return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
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

      existing = fallback.data;
    }

    if ((existing.deleted_at ?? null) || isCaseRecycled(existing.processing_meta)) {
      return jsonWithCors(request, { error: "Case not found." }, { status: 404 });
    }

    let oldFiles: Array<{
      id: string;
      storage_asset_id: string | null;
      storage_bucket: string | null;
      storage_path: string;
    }> = [];
    if (mode === "overwrite") {
      const names = files.map((file) => file.name);
      const { data, error: oldFilesError } = await supabase
        .from("packet_case_files")
        .select("id, storage_asset_id, storage_bucket, storage_path")
        .eq("case_id", id)
        .in("original_name", names);

      if (oldFilesError) throw oldFilesError;
      oldFiles = data ?? [];
    }

    const fileRows = [];
    for (const file of files) {
      const binary = new Uint8Array(await file.arrayBuffer());
      const contentType = inferContentType(file);
      const asset = await ensureStorageAsset({
        supabase,
        ownerUserId: user.id,
        storageBucket: STORAGE_BUCKET,
        bytes: binary,
        contentType,
      });
      if (asset.createdObject) {
        uploadedPaths.push({
          storageAssetId: asset.id,
          storageBucket: asset.storageBucket,
          storagePath: asset.storagePath,
        });
      }
      fileRows.push({
        case_id: id,
        original_name: file.name,
        storage_bucket: asset.storageBucket,
        storage_path: asset.storagePath,
        storage_asset_id: asset.id,
        content_sha256: asset.contentSha256,
        mime_type: contentType,
        size_bytes: file.size,
      });
    }

    const { error: fileInsertError } = await supabase.from("packet_case_files").insert(fileRows);
    if (fileInsertError) throw fileInsertError;

    if (oldFiles.length) {
      const { error: deleteRowsError } = await supabase
        .from("packet_case_files")
        .delete()
        .in(
          "id",
          oldFiles.map((file) => file.id)
        );
      if (deleteRowsError) throw deleteRowsError;

      await removeStorageObjectsIfUnreferenced(
        supabase,
        oldFiles.map((file) => ({
          storageAssetId: file.storage_asset_id,
          storageBucket: file.storage_bucket || STORAGE_BUCKET,
          storagePath: file.storage_path,
        }))
      );
    }

    const { count, error: countError } = await supabase
      .from("packet_case_files")
      .select("id", { count: "exact", head: true })
      .eq("case_id", id);

    if (countError) throw countError;

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
      const existingMeta =
        existing.processing_meta && typeof existing.processing_meta === "object"
          ? (existing.processing_meta as Record<string, unknown>)
          : {};
      const existingUploadGroups = readUploadGroupMeta(existingMeta.uploadGroups);
      const nextPayload: Record<string, unknown> = {
        upload_count: count ?? existing.upload_count + files.length,
      };

      if (uploadGroups.length) {
        nextPayload.processing_meta = {
          ...existingMeta,
          uploadGroups: mergeUploadGroupMeta(existingUploadGroups, uploadGroups),
        };
      }

      const result = await supabase
        .from("packet_cases")
        .update(nextPayload)
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

      const existingMeta =
        existing.processing_meta && typeof existing.processing_meta === "object"
          ? (existing.processing_meta as Record<string, unknown>)
          : {};
      const existingUploadGroups = readUploadGroupMeta(existingMeta.uploadGroups);
      const nextPayload: Record<string, unknown> = {
        upload_count: count ?? existing.upload_count + files.length,
      };

      if (uploadGroups.length) {
        nextPayload.processing_meta = {
          ...existingMeta,
          uploadGroups: mergeUploadGroupMeta(existingUploadGroups, uploadGroups),
        };
      }

      const fallback = await supabase
        .from("packet_cases")
        .update(nextPayload)
        .eq("id", id)
        .or(await listAccessPredicate(request, user.id, 'purchases.view'))
        .select(
          "id, slug, display_name, buyer_name, po_number, invoice_number, status, risk_score, upload_count, document_count, mismatch_count, created_at, processing_meta"
        )
        .single();

      if (fallback.error) throw fallback.error;
      updatedCase = fallback.data;
    }

    return jsonWithCors(request, { case: mapCaseRow(updatedCase) });
  } catch (error) {
    if (uploadedPaths.length > 0) {
      await removeStorageObjectsIfUnreferenced(supabase, uploadedPaths);
    }

    return jsonWithCors(request, { error: serializeError(error) }, { status: 500 });
  }
}

export async function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export const GET = withTeamAccess(GETHandler);
export const POST = withTeamAccess(POSTHandler);

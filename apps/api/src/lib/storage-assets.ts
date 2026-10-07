import { createHash } from "crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

type StorageAssetClient = SupabaseClient;

export type StorageAssetReference = {
  id: string;
  storageBucket: string;
  storagePath: string;
  contentSha256: string;
  sizeBytes: number;
  createdObject: boolean;
};

export type StorageObjectCandidate = {
  storageAssetId?: string | null;
  storageBucket: string;
  storagePath: string;
};

type StorageCleanupQueueRow = {
  id: string;
  storage_asset_id: string | null;
  storage_bucket: string;
  storage_path: string;
  attempt_count: number;
};

function isAlreadyExistsError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const text = [record.message, record.error, record.statusCode, record.status]
    .filter((value) => value !== null && value !== undefined)
    .join(" ");
  return /already exists|duplicate|409/i.test(text);
}

export function getContentSha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function getContentAddressedPath(ownerUserId: string, sha256: string) {
  return `${ownerUserId}/sha256/${sha256}`;
}

async function ensureStorageObject(params: {
  supabase: StorageAssetClient;
  storageBucket: string;
  storagePath: string;
  bytes: Uint8Array;
  contentType?: string | null;
}) {
  const bucket = params.supabase.storage.from(params.storageBucket);
  // Upload first and use the duplicate response as the existence check. The
  // Storage HEAD endpoint can return a generic 400 "Bad Request" for a
  // missing object, which makes `exists()` unable to distinguish absence from
  // a real failure. An upload with upsert disabled is atomic: it recreates a
  // missing content-addressed object and never overwrites a healthy one.
  const upload = await bucket.upload(params.storagePath, params.bytes, {
    contentType: params.contentType || "application/octet-stream",
    upsert: false,
  });
  if (!upload.error) return true;
  // The canonical object already exists, possibly because another request
  // recreated it concurrently.
  if (isAlreadyExistsError(upload.error)) return false;
  throw upload.error;
}

export async function ensureStorageAsset(params: {
  supabase: StorageAssetClient;
  ownerUserId: string;
  storageBucket: string;
  bytes: Uint8Array;
  contentType?: string | null;
}) {
  const contentSha256 = getContentSha256(params.bytes);
  const sizeBytes = params.bytes.byteLength;
  const existing = await params.supabase
    .from("storage_assets")
    .select("id, storage_bucket, storage_path")
    .eq("owner_user_id", params.ownerUserId)
    .eq("storage_bucket", params.storageBucket)
    .eq("content_sha256", contentSha256)
    .eq("size_bytes", sizeBytes)
    .maybeSingle();

  if (existing.error) throw existing.error;
  if (existing.data) {
    const createdObject = await ensureStorageObject({
      supabase: params.supabase,
      storageBucket: existing.data.storage_bucket,
      storagePath: existing.data.storage_path,
      bytes: params.bytes,
      contentType: params.contentType,
    });
    return {
      id: existing.data.id,
      storageBucket: existing.data.storage_bucket,
      storagePath: existing.data.storage_path,
      contentSha256,
      sizeBytes,
      createdObject,
    } satisfies StorageAssetReference;
  }

  const storagePath = getContentAddressedPath(params.ownerUserId, contentSha256);
  const createdObject = await ensureStorageObject({
    supabase: params.supabase,
    storageBucket: params.storageBucket,
    storagePath,
    bytes: params.bytes,
    contentType: params.contentType,
  });

  const inserted = await params.supabase
    .from("storage_assets")
    .insert({
      owner_user_id: params.ownerUserId,
      storage_bucket: params.storageBucket,
      storage_path: storagePath,
      content_sha256: contentSha256,
      size_bytes: sizeBytes,
      mime_type: params.contentType || null,
    })
    .select("id, storage_bucket, storage_path")
    .maybeSingle();

  if (!inserted.error && inserted.data) {
    return {
      id: inserted.data.id,
      storageBucket: inserted.data.storage_bucket,
      storagePath: inserted.data.storage_path,
      contentSha256,
      sizeBytes,
      createdObject,
    } satisfies StorageAssetReference;
  }

  if (!isAlreadyExistsError(inserted.error)) throw inserted.error;
  const raced = await params.supabase
    .from("storage_assets")
    .select("id, storage_bucket, storage_path")
    .eq("owner_user_id", params.ownerUserId)
    .eq("storage_bucket", params.storageBucket)
    .eq("content_sha256", contentSha256)
    .eq("size_bytes", sizeBytes)
    .single();
  if (raced.error) throw raced.error;

  return {
    id: raced.data.id,
    storageBucket: raced.data.storage_bucket,
    storagePath: raced.data.storage_path,
    contentSha256,
    sizeBytes,
    createdObject,
  } satisfies StorageAssetReference;
}

async function countReferences(
  supabase: StorageAssetClient,
  table: "packet_case_files" | "bank_statement_imports",
  candidate: StorageObjectCandidate
) {
  let query = supabase.from(table).select("id", { count: "exact", head: true });
  if (candidate.storageAssetId) {
    query = query.eq("storage_asset_id", candidate.storageAssetId);
  } else {
    query = query
      .eq("storage_bucket", candidate.storageBucket)
      .eq("storage_path", candidate.storagePath);
  }
  const result = await query;
  if (result.error) throw result.error;
  return result.count ?? 0;
}

export async function removeStorageObjectsIfUnreferenced(
  supabase: StorageAssetClient,
  candidates: StorageObjectCandidate[]
) {
  const unique = new Map<string, StorageObjectCandidate>();
  for (const candidate of candidates) {
    unique.set(
      candidate.storageAssetId || `${candidate.storageBucket}:${candidate.storagePath}`,
      candidate
    );
  }

  const removed: StorageObjectCandidate[] = [];
  const retained: StorageObjectCandidate[] = [];
  for (const candidate of unique.values()) {
    const packetReferences = await countReferences(supabase, "packet_case_files", candidate);
    const bankReferences = await countReferences(supabase, "bank_statement_imports", candidate);
    if (packetReferences + bankReferences > 0) {
      retained.push(candidate);
      continue;
    }

    const removal = await supabase.storage
      .from(candidate.storageBucket)
      .remove([candidate.storagePath]);
    if (removal.error) throw removal.error;

    if (candidate.storageAssetId) {
      const assetRemoval = await supabase
        .from("storage_assets")
        .delete()
        .eq("id", candidate.storageAssetId);
      if (assetRemoval.error) throw assetRemoval.error;
    }
    removed.push(candidate);
  }

  return { removed, retained };
}

export async function enqueueStorageCleanup(
  supabase: StorageAssetClient,
  ownerUserId: string,
  candidates: StorageObjectCandidate[]
) {
  const unique = new Map<string, StorageObjectCandidate>();
  for (const candidate of candidates) {
    unique.set(`${candidate.storageBucket}:${candidate.storagePath}`, candidate);
  }
  if (unique.size === 0) return;

  const queued = await supabase.from("storage_cleanup_queue").upsert(
    [...unique.values()].map((candidate) => ({
      owner_user_id: ownerUserId,
      storage_asset_id: candidate.storageAssetId || null,
      storage_bucket: candidate.storageBucket,
      storage_path: candidate.storagePath,
      requested_at: new Date().toISOString(),
      last_error: null,
    })),
    { onConflict: "storage_bucket,storage_path" }
  );
  if (queued.error) throw queued.error;
}

export async function processStorageCleanupQueue(
  supabase: StorageAssetClient,
  ownerUserId: string,
  options?: { limit?: number }
) {
  const limit = Math.max(1, Math.min(options?.limit ?? 25, 100));
  const queued = await supabase
    .from("storage_cleanup_queue")
    .select("id, storage_asset_id, storage_bucket, storage_path, attempt_count")
    .eq("owner_user_id", ownerUserId)
    .order("requested_at", { ascending: true })
    .limit(limit);
  if (queued.error) throw queued.error;

  const removed: StorageObjectCandidate[] = [];
  const retained: StorageObjectCandidate[] = [];
  const failed: StorageObjectCandidate[] = [];

  for (const row of (queued.data ?? []) as StorageCleanupQueueRow[]) {
    const candidate: StorageObjectCandidate = {
      storageAssetId: row.storage_asset_id,
      storageBucket: row.storage_bucket,
      storagePath: row.storage_path,
    };
    try {
      const result = await removeStorageObjectsIfUnreferenced(supabase, [candidate]);
      removed.push(...result.removed);
      retained.push(...result.retained);
      const completed = await supabase.from("storage_cleanup_queue").delete().eq("id", row.id);
      if (completed.error) throw completed.error;
    } catch (error) {
      failed.push(candidate);
      const message = error instanceof Error ? error.message : String(error);
      const recorded = await supabase
        .from("storage_cleanup_queue")
        .update({
          attempt_count: row.attempt_count + 1,
          last_attempt_at: new Date().toISOString(),
          last_error: message.slice(0, 2000),
        })
        .eq("id", row.id);
      if (recorded.error) {
        console.error("Failed to record Storage cleanup failure", recorded.error);
      }
    }
  }

  return { removed, retained, failed };
}

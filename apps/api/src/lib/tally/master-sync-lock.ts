import type { SupabaseClient } from "@supabase/supabase-js";

const LOCK_TTL_MS = 10 * 60 * 1000;

type LockResult = { acquired: true; token: string } | { acquired: false };

const localLocks = new Map<string, { token: string; expiresAt: number }>();

function lockKey(connectionId: string, companyName: string) {
  return `${connectionId}::${companyName.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function lockTableMissing(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  return /tally_master_sync_locks|relation .* does not exist|schema cache/i.test(
    message
  );
}

function acquireLocalLock(connectionId: string, companyName: string, token: string, expiresAt: Date): LockResult {
  const key = lockKey(connectionId, companyName);
  const existing = localLocks.get(key);
  if (existing && existing.expiresAt > Date.now()) return { acquired: false };
  localLocks.set(key, { token, expiresAt: expiresAt.getTime() });
  return { acquired: true, token };
}

export async function acquireTallyMasterSyncLock(args: {
  supabase: SupabaseClient | null;
  connectionId: string;
  ownerUserId: string;
  companyName: string;
  local?: boolean;
}): Promise<LockResult> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS);

  if (args.local || !args.supabase) {
    return acquireLocalLock(args.connectionId, args.companyName, token, expiresAt);
  }

  const cleanup = await args.supabase
    .from("tally_master_sync_locks")
    .delete()
    .eq("connection_id", args.connectionId)
    .lt("expires_at", new Date().toISOString());
  if (cleanup.error && !lockTableMissing(cleanup.error)) throw cleanup.error;
  if (cleanup.error && lockTableMissing(cleanup.error)) {
    return acquireLocalLock(args.connectionId, args.companyName, token, expiresAt);
  }

  const { error } = await args.supabase.from("tally_master_sync_locks").insert({
    connection_id: args.connectionId,
    owner_user_id: args.ownerUserId,
    company_name: args.companyName,
    lock_token: token,
    expires_at: expiresAt.toISOString(),
  });
  if (!error) return { acquired: true, token };
  if (error.code === "23505") return { acquired: false };
  if (lockTableMissing(error)) {
    return acquireLocalLock(args.connectionId, args.companyName, token, expiresAt);
  }
  throw error;
}

export async function releaseTallyMasterSyncLock(args: {
  supabase: SupabaseClient | null;
  connectionId: string;
  token: string | null;
  local?: boolean;
}) {
  if (!args.token) return;
  if (args.local || !args.supabase) {
    for (const [key, value] of localLocks.entries()) {
      if (key.startsWith(`${args.connectionId}::`) && value.token === args.token) localLocks.delete(key);
    }
    return;
  }
  const { error } = await args.supabase
    .from("tally_master_sync_locks")
    .delete()
    .eq("connection_id", args.connectionId)
    .eq("lock_token", args.token);
  if (error && !lockTableMissing(error)) throw error;
}

// Cache-first access to portal returns. The portal is called only when nothing
// is saved, or on an explicit refresh that passes the daily cap and the gap rule.

export type GstReturnType = "gstr2a" | "gstr2b" | "gstr3b";

export type ReturnKey = { organizationId: string; gstin: string; returnType: GstReturnType; period: string };

export type StoredReturn = {
  payload: unknown;
  transactionId: string;
  isFinal: boolean;
  fetchedAt: string;
  fetchCount: number;
};

export type CallLogEntry = {
  organizationId: string;
  gstin: string;
  endpoint: string;
  returnType: GstReturnType;
  period: string;
  requestedBy: string | null;
  ok: boolean;
  transactionId: string;
  error: string | null;
};

export interface GstStore {
  readSnapshot(key: ReturnKey): Promise<StoredReturn | null>;
  saveSnapshot(key: ReturnKey, row: StoredReturn, fetchedBy: string | null): Promise<void>;
  countCallsSince(organizationId: string, sinceIso: string): Promise<number>;
  logCalls(entries: CallLogEntry[]): Promise<void>;
}

export type PullPolicy = { dailyCap: number; minRefreshMinutes: number };
export const DEFAULT_PULL_POLICY: PullPolicy = { dailyCap: 100, minRefreshMinutes: 60 };

export type PullFailureKind = "refresh_too_soon" | "daily_cap";

export class PullBlockedError extends Error {
  constructor(message: string, readonly kind: PullFailureKind, readonly retryAt?: string) {
    super(message);
    this.name = "PullBlockedError";
  }
}

export type PortalFetch = (returnType: GstReturnType, period: string) => Promise<{ payload: unknown; transactionId: string; calls: number }>;

// Expected cost of one pull, checked against the cap before the portal is touched.
const EXPECTED_CALLS: Record<GstReturnType, number> = { gstr2a: 2, gstr2b: 1, gstr3b: 1 };
const ENDPOINT: Record<GstReturnType, string> = {
  gstr2a: "gstr-2a (b2b, cdn)",
  gstr2b: "gstr-2b",
  gstr3b: "gstr-3b",
};
const DAY_MS = 24 * 3_600_000;

// 2B is generated around the 14th of the next month; 3B is final once the month is over.
export function isFinalReturn(returnType: GstReturnType, period: string, nowMs: number) {
  if (returnType === "gstr2a") return false;
  const [year, month] = period.split("-").map(Number);
  const nextMonth = Date.UTC(year, month, returnType === "gstr2b" ? 15 : 1);
  return nowMs >= nextMonth;
}

export async function getReturn(
  deps: { store: GstStore; fetchFromPortal: PortalFetch; now?: () => number },
  key: ReturnKey,
  options: { refresh?: boolean; userId?: string | null; policy?: PullPolicy } = {},
) {
  const now = deps.now ?? Date.now;
  const policy = options.policy ?? DEFAULT_PULL_POLICY;
  const saved = await deps.store.readSnapshot(key);
  if (saved && !options.refresh) return { snapshot: saved, source: "cache" as const, calls: 0 };

  if (saved) {
    const nextAllowed = Date.parse(saved.fetchedAt) + policy.minRefreshMinutes * 60_000;
    if (nextAllowed > now()) {
      throw new PullBlockedError(
        `This return was refreshed recently. Try again after ${new Date(nextAllowed).toISOString()}.`,
        "refresh_too_soon",
        new Date(nextAllowed).toISOString(),
      );
    }
  }

  const used = await deps.store.countCallsSince(key.organizationId, new Date(now() - DAY_MS).toISOString());
  if (used + EXPECTED_CALLS[key.returnType] > policy.dailyCap) {
    throw new PullBlockedError(`The daily limit of ${policy.dailyCap} GST calls is reached.`, "daily_cap");
  }

  const entry = (ok: boolean, transactionId: string, error: string | null): CallLogEntry => ({
    organizationId: key.organizationId, gstin: key.gstin, endpoint: ENDPOINT[key.returnType], returnType: key.returnType,
    period: key.period, requestedBy: options.userId ?? null, ok, transactionId, error,
  });

  let result: Awaited<ReturnType<PortalFetch>>;
  try {
    result = await deps.fetchFromPortal(key.returnType, key.period);
  } catch (error) {
    await deps.store.logCalls([entry(false, String((error as { transactionId?: string })?.transactionId ?? ""), error instanceof Error ? error.message : "Portal call failed")]);
    throw error;
  }

  const row: StoredReturn = {
    payload: result.payload,
    transactionId: result.transactionId,
    isFinal: isFinalReturn(key.returnType, key.period, now()),
    fetchedAt: new Date(now()).toISOString(),
    fetchCount: (saved?.fetchCount ?? 0) + 1,
  };
  await deps.store.saveSnapshot(key, row, options.userId ?? null);
  await deps.store.logCalls(Array.from({ length: Math.max(1, result.calls) }, () => entry(true, result.transactionId, null)));
  return { snapshot: row, source: "portal" as const, calls: result.calls };
}

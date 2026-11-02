// Sandbox (sandbox.co.in) GST client. No Next/Supabase imports: the store layer
// decides when to call; this file only knows how.

export type SandboxConfig = {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type TaxpayerSession = { token: string; sessionExpiry: number; tokenExpiry: number };
export type SandboxErrorKind = "auth" | "session" | "otp" | "portal" | "rate_limit" | "network";
export type Gstr2aSection = "b2b" | "b2ba" | "cdn" | "cdna" | "isd" | "tds" | "tcs" | "impg" | "impgsez";
export type SandboxResult = { payload: unknown; transactionId: string; calls: number };

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly kind: SandboxErrorKind,
    readonly status?: number,
    readonly errorCode?: string,
    readonly transactionId?: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

// Refresh the 6-hour taxpayer token this long before it lapses.
const REFRESH_MARGIN_MS = 15 * 60 * 1000;

export function periodParts(period: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new Error("Period must be YYYY-MM.");
  return { year: match[1], month: match[2] };
}

type CallInit = {
  method?: string;
  token?: string;
  query?: Record<string, string | number>;
  body?: unknown;
  source?: boolean;
  extra?: Record<string, string>;
};

export function createSandboxClient(config: SandboxConfig) {
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? Date.now;
  const version = config.apiVersion || "1.0.0";

  async function call(path: string, init: CallInit) {
    const url = new URL(path, config.baseUrl);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { "x-api-key": config.apiKey, "x-api-version": version, ...init.extra };
    if (init.token) headers.authorization = init.token;
    if (init.source) headers["x-source"] = "primary";
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await doFetch(url, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    } catch (error) {
      throw new SandboxError(`Could not reach Sandbox: ${error instanceof Error ? error.message : "network error"}`, "network");
    }
    const json = asObj(await response.json().catch(() => ({})));
    const failure = asObj(asObj(json.data).error);
    const transactionId = String(json.transaction_id ?? "");
    const errorCode = String(failure.error_cd ?? "");
    const message = String(failure.message ?? json.message ?? "");
    if (response.status === 429) throw new SandboxError("Sandbox rate limit reached. Try again shortly.", "rate_limit", 429, errorCode, transactionId);
    if (response.status === 401 || response.status === 403 || /^AUTH/i.test(errorCode) || /invalid session|session expired/i.test(message)) {
      throw new SandboxError(message || "GST session is not valid.", "session", response.status, errorCode, transactionId);
    }
    if (!response.ok) throw new SandboxError(message || `Sandbox returned HTTP ${response.status}.`, "portal", response.status, errorCode, transactionId);
    return { json, transactionId, errorCode, message };
  }

  // Platform token: one per Sandbox account, shared by every client.
  async function authenticate() {
    const response = await call("/authenticate", { method: "POST", extra: { "x-api-secret": config.apiSecret } });
    const token = String(response.json.access_token ?? asObj(response.json.data).access_token ?? "");
    if (!token) throw new SandboxError("Sandbox did not return an access token.", "auth");
    return { accessToken: token, expiresAt: jwtExpiry(token) ?? now() + 23 * 3_600_000 };
  }

  function sessionFrom(json: Obj): TaxpayerSession {
    const data = asObj(json.data);
    const token = String(data.access_token ?? "");
    if (!token) throw new SandboxError("Sandbox did not return a GST session token.", "otp");
    return { token, sessionExpiry: Number(data.session_expiry), tokenExpiry: Number(data.token_expiry) };
  }

  async function generateOtp(platformToken: string, input: { gstin: string; username: string }) {
    const response = await call("/gst/compliance/tax-payer/otp", { method: "POST", token: platformToken, source: true, body: input });
    if (response.errorCode) throw new SandboxError(response.message || "Could not send the OTP.", "otp", undefined, response.errorCode, response.transactionId);
  }

  async function verifyOtp(platformToken: string, input: { gstin: string; username: string; otp: string }) {
    const { otp, ...body } = input;
    const response = await call("/gst/compliance/tax-payer/otp/verify", { method: "POST", token: platformToken, source: true, query: { otp }, body });
    if (response.errorCode) throw new SandboxError(response.message || "The OTP was not accepted.", "otp", undefined, response.errorCode, response.transactionId);
    return sessionFrom(response.json);
  }

  async function refreshSession(session: TaxpayerSession) {
    const response = await call("/gst/compliance/tax-payer/session/refresh", { method: "POST", token: session.token, source: true });
    return sessionFrom(response.json);
  }

  // The session to use: the same one while the token has time left, a refreshed
  // one (no OTP) while the 30-day session is alive, else a session error.
  async function ensureSession(session: TaxpayerSession): Promise<{ session: TaxpayerSession; refreshed: boolean }> {
    if (session.sessionExpiry <= now()) throw new SandboxError("The GST session has expired. A new OTP is needed.", "session");
    if (session.tokenExpiry - now() > REFRESH_MARGIN_MS) return { session, refreshed: false };
    return { session: await refreshSession(session), refreshed: true };
  }

  async function taxpayerGet(session: TaxpayerSession, path: string, query?: Record<string, string | number>) {
    const response = await call(path, { token: session.token, source: true, query });
    if (response.errorCode) throw new SandboxError(response.message || "The GST portal returned an error.", "portal", undefined, response.errorCode, response.transactionId);
    return response;
  }

  const base = "/gst/compliance/tax-payer/gstrs";

  async function getGstr2b(session: TaxpayerSession, period: string): Promise<SandboxResult> {
    const { year, month } = periodParts(period);
    const path = `${base}/gstr-2b/${year}/${month}`;
    const first = await taxpayerGet(session, path);
    const inner = asObj(first.json.data);
    // Large 2B returns come in numbered files (status_cd 3); merge them back.
    const fileCount = Number(inner.status_cd) === 3 ? Number(asObj(inner.data).fc ?? inner.fc ?? 0) : 0;
    if (!fileCount) return { payload: first.json, transactionId: first.transactionId, calls: 1 };
    let merged: Obj | null = null;
    for (let file = 1; file <= fileCount; file += 1) {
      const part = await taxpayerGet(session, path, { file_number: file });
      merged = merged ? mergeGstr2b(merged, part.json) : part.json;
    }
    return { payload: merged, transactionId: first.transactionId, calls: 1 + fileCount };
  }

  async function getGstr2a(session: TaxpayerSession, period: string, sections: Gstr2aSection[]): Promise<SandboxResult> {
    const { year, month } = periodParts(period);
    const out: Record<string, unknown> = {};
    let transactionId = "";
    for (const section of sections) {
      const part = await taxpayerGet(session, `${base}/gstr-2a/${section}/${year}/${month}`);
      Object.assign(out, asObj(asObj(part.json.data).data));
      transactionId = part.transactionId || transactionId;
    }
    return { payload: { code: 200, data: { status_cd: "1", data: out } }, transactionId, calls: sections.length };
  }

  async function getGstr3b(session: TaxpayerSession, period: string): Promise<SandboxResult> {
    const { year, month } = periodParts(period);
    const response = await taxpayerGet(session, `${base}/gstr-3b/${year}/${month}`);
    return { payload: response.json, transactionId: response.transactionId, calls: 1 };
  }

  async function searchGstin(platformToken: string, gstin: string, acceptCache = true): Promise<SandboxResult> {
    const response = await call("/gst/compliance/public/gstin/search", {
      method: "POST", token: platformToken, body: { gstin }, extra: acceptCache ? { "x-accept-cache": "true" } : undefined,
    });
    return { payload: response.json, transactionId: response.transactionId, calls: 1 };
  }

  async function trackReturns(platformToken: string, gstin: string, financialYear: string): Promise<SandboxResult> {
    const response = await call("/gst/compliance/public/gstrs/track", {
      method: "POST", token: platformToken, body: { gstin }, query: { financial_year: financialYear }, extra: { "x-accept-cache": "true" },
    });
    return { payload: response.json, transactionId: response.transactionId, calls: 1 };
  }

  return { authenticate, generateOtp, verifyOtp, refreshSession, ensureSession, getGstr2b, getGstr2a, getGstr3b, searchGstin, trackReturns };
}

type Obj = { [key: string]: unknown };

function asObj(value: unknown): Obj {
  return value && typeof value === "object" ? (value as Obj) : {};
}

function mergeGstr2b(a: Obj, b: Obj) {
  const target = asObj(asObj(a.data).data);
  const docA = asObj(target.docdata);
  const docB = asObj(asObj(asObj(b.data).data).docdata);
  for (const key of Object.keys(docB)) {
    const left = docA[key];
    const right = docB[key];
    docA[key] = Array.isArray(left) && Array.isArray(right) ? [...left, ...right] : (left ?? right);
  }
  target.docdata = docA;
  return a;
}

function jwtExpiry(token: string) {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

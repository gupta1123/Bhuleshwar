"use client";

import { getApiAccessToken } from "@/lib/api-client";
import {accessCacheEpoch,registerAccessCache} from '@/lib/access-cache';

type LiveRequest = {
  connectionId: string;
  companyName: string;
  companyGuid?: string | null;
  financialYear?: string | null;
  operation: "test_purchase_document_folder" | "company_check" | "bank_ledgers" | "ledger_masters" | "ledger_suggestions" | "verify_bank_transaction" | "fetch_customer_open_bills" | "scan" | "followups_scan" | "create_debit_note" | "collections_query" | "collections_rows";
  payload?: Record<string, unknown>;
  companyNames?: string[];
  proposal?: Record<string, unknown>;
  customerScope?: Record<string, unknown>;
  onProgress?: (message: string) => void;
  onPreview?: (data: unknown) => void;
  signal?: AbortSignal;
};

type LiveResult<T> = {
  type?: string;
  requestId?: string;
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
};

type PendingRequest = {
  operation: LiveRequest["operation"];
  cleanup: () => void;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (message: string) => void;
  onPreview?: (data: unknown) => void;
  timeout: number;
};

type BrowserLiveSession = {
  key: string;
  token: string;
  socket: WebSocket;
  createdAt: number;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  ended: boolean;
  pending: Map<string, PendingRequest>;
  authTimeout?: number;
  bankOnline: boolean;
  scopedBankJobs?: boolean;
  bankWatchers: Set<{ jobId: string; event: (event: BankJobEvent) => void; online: (online: boolean) => void }>;
};

export type BankJobEvent = { type: string; jobId: string; importId?: string; revision: number; state: string };

const SESSION_MAX_AGE_MS = 2 * 60_000;
let cachedGatewayUrl: Promise<string> | null = null;
let cachedSession: BrowserLiveSession | null = null;
registerAccessCache('tally-live-session',()=>{if(cachedSession)closeSession(cachedSession);});

async function gatewayUrl() {
  const configured = String(process.env.NEXT_PUBLIC_CASH_DISCOUNT_GATEWAY_URL || "").trim();
  if (configured) return configured;
  const apiBaseUrl = String(
    process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_BRIDGE_API_BASE_URL || ""
  ).trim();
  const gatewayBaseUrl = apiBaseUrl;
  if (!gatewayBaseUrl && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    const response = await fetch("/api/cash-discount-live-url", { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { url?: string; error?: string };
    if (!response.ok || !payload.url) {
      throw new Error(payload.error || "The Cash Discount gateway URL is not configured.");
    }
    return payload.url;
  }

  const url = new URL(gatewayBaseUrl || window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (["localhost", "127.0.0.1"].includes(url.hostname)) {
    url.port = "3002";
    url.pathname = "/";
  } else {
    url.pathname = "/agent-live";
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

function liveGatewayUrl() {
  cachedGatewayUrl ??= gatewayUrl().catch((error) => {
    cachedGatewayUrl = null;
    throw error;
  });
  return cachedGatewayUrl;
}

function endSession(session: BrowserLiveSession, error: Error) {
  if (session.ended) return;
  session.ended = true;
  window.clearTimeout(session.authTimeout);
  if (!session.readySettled) {
    session.readySettled = true;
    session.rejectReady(error);
  }
  for (const pending of session.pending.values()) {
    window.clearTimeout(pending.timeout);
    pending.cleanup();
    pending.reject(error);
  }
  session.pending.clear();
  session.bankOnline = false;
  for (const watcher of session.bankWatchers) watcher.online(false);
  session.bankWatchers.clear();
  if (cachedSession === session) cachedSession = null;
}

function closeSession(session: BrowserLiveSession) {
  for (const [requestId, pending] of session.pending) {
    if (["scan", "followups_scan", "verify_bank_transaction", "fetch_customer_open_bills"].includes(pending.operation) && session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: "cancel", requestId }));
    }
  }
  endSession(session, new Error("The previous live Tally session was replaced."));
  if (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING) {
    session.socket.close(1000, "Session refreshed");
  }
}

function createSession(params: {
  key: string;
  token: string;
  gateway: string;
  connectionId: string;
  companyName: string;
  organizationId: string;
}) {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const socket = new WebSocket(params.gateway);
  const session: BrowserLiveSession = {
    key: params.key,
    token: params.token,
    socket,
    createdAt: Date.now(),
    ready,
    resolveReady,
    rejectReady,
    readySettled: false,
    ended: false,
    pending: new Map(),
    bankOnline: false,
    bankWatchers: new Set(),
  };

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "authenticate",
      role: "browser",
      connectionId: params.connectionId,
      companyName: params.companyName,
      organizationId:params.organizationId,
      token: params.token,
    }));
  });
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data ?? "{}")) as LiveResult<unknown> & BankJobEvent & { online?: boolean; scopedBankJobs?: boolean };
      if (message.type === 'bank_job_channel') {
        if (!message.jobId) session.bankOnline = message.online === true;
        for (const watcher of session.bankWatchers) if(!message.jobId || watcher.jobId===message.jobId) watcher.online(message.online===true);
        return;
      }
      if (['bank_job_progress','bank_job_completed','bank_job_failed','bank_job_cancelled'].includes(message.type || '')) {
        for (const watcher of session.bankWatchers) if (watcher.jobId === message.jobId) watcher.event(message);
        return;
      }
      if (message.type === "authenticated") {
        session.scopedBankJobs=message.scopedBankJobs===true;
        window.clearTimeout(session.authTimeout);
        if (!session.readySettled) {
          session.readySettled = true;
          session.resolveReady();
        }
        return;
      }

      const requestId = String(message.requestId ?? "");
      const pending = requestId ? session.pending.get(requestId) : null;
      if (message.type === "progress" && pending) {
        pending.onProgress?.(message.message || "Reading live Tally data...");
      } else if (message.type === "preview" && pending) {
        pending.onPreview?.(message.data);
      } else if (message.type === "result" && pending) {
        window.clearTimeout(pending.timeout);
        pending.cleanup();
        session.pending.delete(requestId);
        if (message.success === true) pending.resolve(message.data);
        else pending.reject(new Error(message.error || "The live Tally request failed."));
      } else if (message.type === "error") {
        endSession(session, new Error(message.error || "The live Cash Discount channel failed."));
      }
    } catch {
      endSession(session, new Error("The live Cash Discount channel returned an invalid response."));
    }
  });
  socket.addEventListener("error", () => {
    endSession(session, new Error("Could not connect to the live Cash Discount channel. Start the gateway and connector, then try again."));
  });
  socket.addEventListener("close", () => {
    endSession(session, new Error("The live Cash Discount channel closed before the request completed."));
  });
  session.authTimeout = window.setTimeout(() => {
    endSession(session, new Error("Live Tally connection timed out. Check the connector and retry."));
    socket.close();
  }, 15_000);
  return session;
}

async function getLiveSession(request: LiveRequest) {
  const epoch=accessCacheEpoch();
  const organizationId=sessionStorage.getItem('kalika-access-organization')||'';
  const accessToken = await getApiAccessToken();
  const localMode = process.env.NEXT_PUBLIC_LOCAL_DB_MODE === "true";
  if (!accessToken && !localMode) throw new Error("Your session has expired. Sign in and try again.");
  const token = accessToken || "local-development";
  const gateway = await liveGatewayUrl();
  if(epoch!==accessCacheEpoch())throw new DOMException('Access changed before the live request started.','AbortError');
  const key = `${gateway}|${organizationId}|${request.connectionId}`;
  const reusable =
    cachedSession &&
    !cachedSession.ended &&
    cachedSession.key === key &&
    cachedSession.token === token &&
    (Date.now() - cachedSession.createdAt < SESSION_MAX_AGE_MS || cachedSession.pending.size > 0 || cachedSession.bankWatchers.size > 0) &&
    (cachedSession.socket.readyState === WebSocket.CONNECTING || cachedSession.socket.readyState === WebSocket.OPEN);
  if (reusable) return cachedSession as BrowserLiveSession;
  if (cachedSession) closeSession(cachedSession);
  cachedSession = createSession({
    key,
    token,
    gateway,
    connectionId: request.connectionId,
    organizationId,
    // Authenticate the connection once and let the API return the small scope
    // map for every company on it. Company switches then reuse this socket.
    companyName: "",
  });
  return cachedSession;
}

// Shares the existing authenticated gateway connection. No rows or document
// content are accepted over this channel; events only trigger durable reads.
export function watchBankJob(params: { connectionId: string; companyName: string; jobId: string;
  onEvent: (event: BankJobEvent) => void; onOnline: (online: boolean) => void }) {
  let stopped = false, retry: ReturnType<typeof setTimeout> | undefined;
  let detach = () => {};
  let revision = 0;
  const connect = async () => {
    if (stopped) return;
    try {
      const session = await getLiveSession({ ...params, operation: 'company_check' });
      await session.ready;
      if (stopped) return;
      const watcher = { jobId: params.jobId,
        event: (event: BankJobEvent) => {
          if (stopped || !Number.isSafeInteger(event.revision) || event.revision <= revision) return;
          revision = event.revision; params.onEvent(event);
        },
        online: (online: boolean) => {
          if (stopped) return;
          params.onOnline(online);
          if (!online && session.ended && !retry) retry = setTimeout(() => { retry = undefined; detach(); void connect(); }, 2000);
        },
      };
      session.bankWatchers.add(watcher);
      if(session.scopedBankJobs)session.socket.send(JSON.stringify({type:'bank_job_watch',jobId:params.jobId}));
      detach = () => {
        session.bankWatchers.delete(watcher);
        if(session.scopedBankJobs&&session.socket.readyState===WebSocket.OPEN&&
          ![...session.bankWatchers].some(w=>w.jobId===params.jobId)) {
          session.socket.send(JSON.stringify({type:'bank_job_unwatch',jobId:params.jobId}));
        }
      };
      watcher.online(session.scopedBankJobs?false:session.bankOnline);
    } catch {
      if (!stopped) { params.onOnline(false); retry = setTimeout(() => { retry = undefined; void connect(); }, 2000); }
    }
  };
  void connect();
  return () => { stopped = true; clearTimeout(retry); detach(); };
}

export async function runCashDiscountLiveRequest<T>(request: LiveRequest) {
  const epoch=accessCacheEpoch();
  request.signal?.throwIfAborted();
  const session = await getLiveSession(request);
  await session.ready;
  if(epoch!==accessCacheEpoch())throw new DOMException('Access changed before the live request started.','AbortError');
  request.signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const cancel = () => {
      const pending = session.pending.get(requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pending.cleanup();
      session.pending.delete(requestId);
      if (["scan", "followups_scan", "verify_bank_transaction", "fetch_customer_open_bills"].includes(request.operation) && session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(JSON.stringify({ type: "cancel", requestId }));
      }
      reject(request.signal?.reason || new Error("Cash Discount scan cancelled."));
    };
    const timeout = window.setTimeout(
      () => {
        if (["scan", "followups_scan", "verify_bank_transaction", "fetch_customer_open_bills"].includes(request.operation) && session.socket.readyState === WebSocket.OPEN) {
          session.socket.send(JSON.stringify({ type: "cancel", requestId }));
        }
        request.signal?.removeEventListener("abort", cancel);
        session.pending.delete(requestId);
        reject(new Error("The live Tally request timed out. Check the connector and try again."));
      },
      // Pages of a held dashboard are answered from memory; scans read Tally.
      request.operation === "collections_query" || request.operation === "collections_rows" ? 30_000 : 4 * 60_000
    );
    session.pending.set(requestId, {
      operation: request.operation,
      cleanup: () => request.signal?.removeEventListener("abort", cancel),
      resolve: (data) => resolve(data as T),
      reject,
      onProgress: request.onProgress,
      onPreview: request.onPreview,
      timeout,
    });
    request.signal?.addEventListener("abort", cancel, { once: true });
    session.socket.send(JSON.stringify({
      type: "request",
      requestId,
      operation: request.operation,
      companyName: request.companyName,
      companyGuid: request.companyGuid,
      companyNames: request.companyNames,
      financialYear: request.financialYear,
      proposal: request.proposal,
      payload: request.payload,
      customerScope: request.customerScope,
    }));
  });
}

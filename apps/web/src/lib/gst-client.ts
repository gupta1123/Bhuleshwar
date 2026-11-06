"use client";

import { apiFetch } from "@/lib/api-client";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";
import { DEMO_SCOPE, demoGstCall, isGstDemo } from "@/lib/gst-demo";

export { isGstDemo };

export type GstScopeInput = { connectionId: string; companyName: string; companyGuid?: string };

export function readGstScope(): GstScopeInput | null {
  const connectionId = readPreferredTallyConnectionId();
  if (!connectionId || typeof window === "undefined") return null;
  try {
    const company = JSON.parse(window.localStorage.getItem("kalika.bankStatements.selectedCompany.v1") || "null");
    if (company?.connectionId !== connectionId || !company?.companyName) return null;
    return {
      connectionId,
      companyName: String(company.companyName),
      companyGuid: typeof company.companyGuid === "string" ? company.companyGuid : undefined,
    };
  } catch {
    return null;
  }
}

type ConnectionSummary = { id?: string; lastCompanyName?: string | null; bridgeConnected?: boolean; companyLoaded?: boolean };

// The saved company choice can point at a connector that was since replaced.
// Fall back to the company the live connector has loaded in Tally.
export async function resolveGstScope(): Promise<GstScopeInput | null> {
  if (isGstDemo()) return DEMO_SCOPE;
  const saved = readGstScope();
  if (saved) return saved;
  try {
    const response = await apiFetch("/api/tally/connections", { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json() as { connections?: ConnectionSummary[] };
    const live = (payload.connections ?? []).filter((c) => c.id && c.lastCompanyName && c.bridgeConnected && c.companyLoaded);
    const preferred = readPreferredTallyConnectionId();
    const pick = live.find((c) => c.id === preferred) ?? live[0];
    if (!pick?.id || !pick.lastCompanyName) return null;
    return { connectionId: pick.id, companyName: pick.lastCompanyName };
  } catch {
    return null;
  }
}

export class GstApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

// Every GST route takes the same workstation + company scope; GET sends it as a query string.
export async function gstCall<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  scope: GstScopeInput,
  params: Record<string, unknown> = {},
): Promise<T> {
  const merged = { ...scope, ...params };
  if (isGstDemo()) return (await demoGstCall(method, path, merged)) as T;
  let response: Response;
  if (method === "GET") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) if (value !== undefined && value !== null) query.set(key, String(value));
    response = await apiFetch(`${path}?${query}`, { cache: "no-store" });
  } else {
    response = await apiFetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(merged) });
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new GstApiError(String(json.error || "GST request failed."), response.status, json.code);
  return json as T;
}

export const inr = (value: unknown) => {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}₹${abs.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(abs) ? 0 : 2, maximumFractionDigits: 2 })}`;
};

// Lakh / crore shorthand for headline figures; full rupees stay in tables.
export const inrShort = (value: unknown) => {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e7) return sign + "₹" + (abs / 1e7).toFixed(2) + " Cr";
  if (abs >= 1e5) return sign + "₹" + (abs / 1e5).toFixed(2) + " L";
  return inr(n);
};

export function ago(iso?: string | null) {
  if (!iso) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

export function recentPeriods(count = 8) {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export const periodLabel = (period: string) => {
  const [y, m] = period.split("-");
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
};

export type GstMonth = {
  period: string;
  books: { fetchedAt: string; voucherCount: number; skippedNoGstin?: number } | null;
  gstr2b: { fetchedAt: string; isFinal: boolean } | null;
  gstr2a: { fetchedAt: string; isFinal: boolean } | null;
  gstr3b: { fetchedAt: string; isFinal: boolean } | null;
};

export type GstTax = { taxable: number; cgst: number; sgst: number; igst: number; cess: number; total: number };
// "2026-09-06" or "06-09-2026" -> "06 Sep 2026". Anything else is shown as it came.
export function fmtDate(value: string | null | undefined) {
  const s = String(value ?? "");
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  const [y, mo, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : [];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(mo) - 1];
  return y && month ? `${d} ${month} ${y}` : s;
}

export type GstSide = { invoiceNo: string; invoiceDate: string; voucherNumber?: string; supplierName?: string; tax: GstTax } | null;
export type GstDecision = { decision: string; note: string | null; decided_by_name: string | null; decided_at: string } | null;

export type GstItem = {
  key: string; period: string; gstin: string; invoiceNo: string; invoiceDate: string; docType: string;
  bucket: string; flags: string[]; reason: string; matchType: string | null; atRisk: number;
  books: GstSide; g2b: GstSide; g2a: GstSide; decision: GstDecision;
};

export type GstSupplierRow = { gstin: string; name: string; invoices: number; exceptions: number; claimed: number; available: number; atRisk: number; filer: string };

export type GstRun = {
  run: { id: string; createdAt: string; gstin: string; periods: string[]; booksAsOf: string | null; dataVersions: Record<string, string>;
    totals: {
      summary: Record<string, number | string>;
      movement: { resolved: number; opened: number; stillOpen: number; reopened: number; hasPrior: boolean };
      buckets: { id: string; label: string; count: number }[];
      filed: { period: string; declaredIn3B: number; perBooks: number; delta: number; reversedIn3B: number }[];
      suppliers: GstSupplierRow[];
    } };
  items: GstItem[];
};

export const BUCKET_STYLE: Record<string, string> = {
  matched: "border-emerald-200 bg-emerald-50 text-emerald-800",
  valueDiff: "border-amber-200 bg-amber-50 text-amber-800",
  booksOnly: "border-rose-200 bg-rose-50 text-rose-800",
  portalOnly: "border-blue-200 bg-blue-50 text-blue-800",
  ineligible: "border-rose-200 bg-rose-50 text-rose-800",
  rule37A: "border-rose-200 bg-rose-50 text-rose-800",
  reopened: "border-rose-200 bg-rose-50 text-rose-800",
  periodShift: "border-slate-200 bg-slate-50 text-slate-700",
  duplicate: "border-rose-200 bg-rose-50 text-rose-800",
};

export const DECISION_LABEL: Record<string, string> = {
  hold: "On hold", chase_supplier: "Chasing supplier", accept: "Accepted", reject: "Rejected", book_it: "Will book it", reopen: "Reopened",
};

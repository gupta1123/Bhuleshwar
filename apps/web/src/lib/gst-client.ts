"use client";

import { apiFetch } from "@/lib/api-client";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";

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
  return `${n < 0 ? "-" : ""}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
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
  books: { fetchedAt: string; voucherCount: number } | null;
  gstr2b: { fetchedAt: string; isFinal: boolean } | null;
  gstr2a: { fetchedAt: string; isFinal: boolean } | null;
  gstr3b: { fetchedAt: string; isFinal: boolean } | null;
};

export type GstTax = { taxable: number; cgst: number; sgst: number; igst: number; cess: number; total: number };
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

"use client";

// Demo mode for the GST page (open /gst?demo=1). Every GST call is answered here, so the
// page can be tried end to end with no GST portal, Tally or login. Nothing leaves the browser.
import type { GstItem, GstMonth, GstRun, GstScopeInput, GstSide, GstTax } from "./gst-client";

export const DEMO_SCOPE: GstScopeInput = { connectionId: "demo", companyName: "Solution Nyx (demo data)" };
const DEMO_GSTIN = "27AAACS0000A1Z5";

export function isGstDemo() {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("demo") === "1") window.sessionStorage.setItem("gst-demo", "1");
    if (new URLSearchParams(window.location.search).get("demo") === "0") window.sessionStorage.removeItem("gst-demo");
    return window.sessionStorage.getItem("gst-demo") === "1";
  } catch {
    return false;
  }
}

const SUPPLIERS = [
  ["27AABCT1234F1ZP", "Tata Steel Distributors", "Monthly"], ["27AAGCS5566K1Z2", "Shree Sai Logistics", "Monthly"],
  ["27AAHFV9012L1ZQ", "Vidarbha Iron Resources", "Quarterly"], ["24AAJCP7788M1Z9", "Patel Packaging Co", "Monthly"],
  ["27AAECB3344N1ZT", "Bharat Fasteners", "Monthly"], ["29AAKCD1122P1Z6", "Deccan Alloys Pvt Ltd", "Monthly"],
  ["27AALFR8899Q1ZX", "Renuka Hardware", "Quarterly"], ["07AAMCG4455R1Z1", "Gupta Electricals", "Monthly"],
] as const;

const tax = (taxable: number, rate: number, inter: boolean): GstTax => {
  const gst = Math.round(taxable * rate) / 100;
  return inter
    ? { taxable, cgst: 0, sgst: 0, igst: gst, cess: 0, total: taxable + gst }
    : { taxable, cgst: gst / 2, sgst: gst / 2, igst: 0, cess: 0, total: taxable + gst };
};
const itc = (t: GstTax) => t.cgst + t.sgst + t.igst + t.cess;

// A small deterministic generator so a refresh shows the same numbers.
function rng(seed: number) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

const BUCKETS: [string, string][] = [
  ["matched", "Matched"], ["valueDiff", "Value differs"], ["booksOnly", "In books, not on portal"], ["portalOnly", "On portal, not in books"],
  ["ineligible", "Blocked credit"], ["rule37A", "Rule 37A risk"], ["periodShift", "Different month"], ["duplicate", "Possible duplicate"],
];
const REASON: Record<string, string> = {
  matched: "Invoice number, date and tax all agree.",
  valueDiff: "The invoice is on both sides but the tax amounts differ.",
  booksOnly: "Booked in Tally but the supplier has not reported it in GSTR-2B.",
  portalOnly: "The supplier reported it, but there is no purchase voucher in Tally.",
  ineligible: "Goods or services on which input credit is blocked.",
  rule37A: "Supplier has not filed; credit may need reversing after the deadline.",
  periodShift: "Matched, but the supplier reported it in a different month.",
  duplicate: "The same invoice number appears twice in the books.",
};

function buildItems(periods: string[]): GstItem[] {
  const out: GstItem[] = [];
  periods.forEach((period, pi) => {
    const rand = rng(1000 + pi * 77 + Number(period.replace("-", "")));
    const count = 34;
    for (let i = 0; i < count; i += 1) {
      const sup = SUPPLIERS[Math.floor(rand() * SUPPLIERS.length)];
      const roll = rand();
      const bucket = roll < 0.55 ? "matched" : roll < 0.67 ? "valueDiff" : roll < 0.78 ? "booksOnly" : roll < 0.86 ? "portalOnly"
        : roll < 0.9 ? "ineligible" : roll < 0.94 ? "rule37A" : roll < 0.97 ? "periodShift" : "duplicate";
      const taxable = Math.round((20000 + rand() * 480000) / 10) * 10;
      const rate = [5, 12, 18, 18, 18, 28][Math.floor(rand() * 6)];
      const inter = sup[0].slice(0, 2) !== "27";
      const day = String(1 + Math.floor(rand() * 27)).padStart(2, "0");
      const invoiceNo = `${sup[1].split(" ").map((w) => w[0]).join("")}/${period.slice(2, 4)}${period.slice(5)}/${String(100 + i * 7 + pi * 3)}`;
      const invoiceDate = `${period}-${day}`;
      const real = tax(taxable, rate, inter);
      const off = bucket === "valueDiff" ? tax(taxable - Math.round(taxable * 0.02), rate, inter) : real;
      const books: GstSide = bucket === "portalOnly" ? null : { invoiceNo, invoiceDate, voucherNumber: `PV-${2000 + i + pi * 40}`, supplierName: sup[1], tax: real };
      const g2b: GstSide = bucket === "booksOnly" || bucket === "rule37A" ? null : { invoiceNo, invoiceDate, supplierName: sup[1], tax: off };
      const atRisk = bucket === "matched" || bucket === "periodShift" ? 0
        : bucket === "valueDiff" ? Math.abs(itc(real) - itc(off)) : bucket === "portalOnly" ? 0 : itc(real);
      out.push({
        key: `${period}:${sup[0]}:${invoiceNo}`, period, gstin: sup[0], invoiceNo, invoiceDate, docType: "Invoice", bucket,
        flags: sup[2] === "Quarterly" && (bucket === "booksOnly") ? ["awaited"] : [], reason: REASON[bucket],
        matchType: bucket === "matched" ? "exact" : bucket === "valueDiff" || bucket === "periodShift" ? "fuzzy" : null,
        atRisk: Math.round(atRisk * 100) / 100, books, g2b, g2a: g2b, decision: null,
      });
    }
  });
  return out;
}

type Demo = { saved: Set<string>; run: GstRun | null; decisions: Record<string, GstItem["decision"]>; settings: Record<string, unknown> };
const state: Demo = {
  saved: new Set(["2026-09"]),
  run: null,
  decisions: {},
  settings: { tolerance: { amount: 1, percent: 0.5, dateWindowDays: 10 }, includeA2: true, fuzzy: true, dailyCallCap: 100, minRefreshMinutes: 60 },
};

function buildRun(periods: string[]): GstRun {
  const items = buildItems(periods).map((it) => ({ ...it, decision: state.decisions[it.key] ?? null }));
  const sum = (f: (i: GstItem) => number) => items.reduce((s, i) => s + f(i), 0);
  const claimed = sum((i) => (i.books ? itc(i.books.tax) : 0));
  const available = sum((i) => (i.g2b ? itc(i.g2b.tax) : 0));
  const suppliers = SUPPLIERS.map(([gstin, name, filer]) => {
    const mine = items.filter((i) => i.gstin === gstin);
    return {
      gstin, name, filer, invoices: mine.length, exceptions: mine.filter((i) => i.bucket !== "matched").length,
      claimed: Math.round(mine.reduce((s, i) => s + (i.books ? itc(i.books.tax) : 0), 0)),
      available: Math.round(mine.reduce((s, i) => s + (i.g2b ? itc(i.g2b.tax) : 0), 0)),
      atRisk: Math.round(mine.reduce((s, i) => s + i.atRisk, 0)),
    };
  }).filter((s) => s.invoices > 0);
  return {
    run: {
      id: "demo-run", createdAt: new Date().toISOString(), gstin: DEMO_GSTIN, periods, booksAsOf: new Date().toISOString(),
      dataVersions: {},
      totals: {
        summary: {
          claimed: Math.round(claimed), available: Math.round(available), gap: Math.max(0, Math.round(claimed - available)),
          atRisk: Math.round(sum((i) => i.atRisk)), awaitedTax: Math.round(sum((i) => (i.flags.includes("awaited") ? i.atRisk : 0))),
          expiringSoon: Math.round(sum((i) => (i.bucket === "portalOnly" ? itc(i.g2b?.tax ?? tax(0, 0, false)) : 0)) * 0.35),
        },
        movement: { resolved: 6, opened: 11, stillOpen: 9, reopened: 1, hasPrior: true },
        buckets: BUCKETS.map(([id, label]) => ({ id, label, count: items.filter((i) => i.bucket === id).length })).filter((b) => b.count > 0),
        filed: periods.map((period) => {
          const perBooks = Math.round(items.filter((i) => i.period === period).reduce((s, i) => s + (i.books ? itc(i.books.tax) : 0), 0));
          return { period, declaredIn3B: perBooks - 4200, perBooks, delta: -4200, reversedIn3B: 0 };
        }),
        suppliers,
      },
    },
    items,
  };
}

const months = (periods: string[]): GstMonth[] => periods.map((period) => {
  const on = state.saved.has(period);
  const at = { fetchedAt: new Date(Date.now() - 3_600_000).toISOString(), isFinal: true };
  return { period, books: on ? { fetchedAt: at.fetchedAt, voucherCount: 640 } : null, gstr2b: on ? at : null, gstr2a: on ? at : null, gstr3b: on ? at : null };
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function demoGstCall(method: "GET" | "POST", path: string, params: Record<string, unknown>): Promise<unknown> {
  await wait(250);
  const route = `${method} ${path}`;
  if (route === "GET /api/gst/readiness") return { months: months(String(params.periods || "").split(",").filter(Boolean)) };
  if (route === "GET /api/gst/reconcile") return { result: state.run };
  if (route === "POST /api/gst/books") { return { commandId: "demo-cmd", period: params.period }; }
  if (route === "GET /api/gst/books") { await wait(900); return { state: "saved" }; }
  if (route === "GET /api/gst/returns") { await wait(600); return { ok: true }; }
  if (route === "POST /api/gst/reconcile") {
    const periods = (params.periods as string[]) ?? [];
    periods.forEach((p) => state.saved.add(p));
    await wait(700);
    state.run = buildRun(periods);
    return { state: "done" };
  }
  if (route === "POST /api/gst/decisions") {
    state.decisions[String(params.itemKey)] = { decision: String(params.decision), note: (params.note as string) || null, decided_by_name: "Demo user", decided_at: new Date().toISOString() };
    if (state.run) state.run = buildRun(state.run.run.periods);
    return { ok: true };
  }
  if (route === "GET /api/gst/suppliers") {
    const profiles = String(params.gstins || "").split(",").filter(Boolean).map((gstin) => {
      const s = SUPPLIERS.find((x) => x[0] === gstin);
      return { gstin, legalName: s ? `${s[1]} Private Limited` : null, tradeName: s?.[1] ?? null, status: "Active", taxpayerType: "Regular", verifiedAt: new Date().toISOString(), warning: null };
    });
    return { suppliers: profiles };
  }
  if (route === "POST /api/gst/suppliers") {
    const s = SUPPLIERS.find((x) => x[0] === params.gstin);
    return { profile: { gstin: String(params.gstin), legalName: s ? `${s[1]} Private Limited` : null, tradeName: s?.[1] ?? null, status: "Active", taxpayerType: "Regular", verifiedAt: new Date().toISOString(), warning: null } };
  }
  if (route === "GET /api/gst/settings") return state.settings;
  if (route === "POST /api/gst/settings") { const { connectionId: _c, companyName: _n, companyGuid: _g, ...rest } = params; void _c; void _n; void _g; state.settings = rest; return state.settings; }
  if (route === "GET /api/gst/status") {
    return {
      connected: true, gstin: DEMO_GSTIN, username: "demo_user", status: "active",
      sessionExpiry: new Date(Date.now() + 29 * 86_400_000).toISOString(), verifiedAt: new Date().toISOString(), callsLast24h: 4, dailyCap: 100,
      snapshots: [...state.saved].flatMap((period) => (["gstr2b", "gstr3b", "gstr2a"] as const).map((returnType) => ({ returnType, period, fetchedAt: new Date(Date.now() - 3_600_000).toISOString(), isFinal: true }))),
    };
  }
  if (route === "POST /api/gst/otp") return { sent: true };
  if (route === "POST /api/gst/otp/verify") return { ok: true };
  throw new Error(`Demo mode has no data for ${route}.`);
}

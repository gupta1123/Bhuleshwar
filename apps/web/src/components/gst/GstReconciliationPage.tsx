"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/dashboard/AppShell";
import { SelectDropdown } from "@/components/ui/select-dropdown";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Check, Loader2, Play, Plug, RefreshCw, Settings } from "lucide-react";
import {
  ago, gstCall, isGstDemo, periodLabel, recentPeriods, resolveGstScope,
  type GstMonth, type GstRun, type GstScopeInput,
} from "@/lib/gst-client";
import { OverviewView, ReviewView, scopeRun } from "./GstViews";
import { ConnectView, SettingsView, SuppliersView } from "./GstAdminViews";
import { Alert, btn, btnPrimary, Drawer, Empty, Panel, th, td } from "./gst-ui";

const TABS = ["Overview", "Review", "Suppliers", "Connect", "Settings"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Partial<Record<Tab, string>> = { Review: "Invoices", Connect: "GST account" };

// GSTR-2B for a month is generated on the 14th of the next month, so a month cannot be reconciled before then.
const availableFrom = (period: string) => { const [y, m] = period.split("-").map(Number); return new Date(y, m, 14); };
const isAvailable = (period: string) => Date.now() >= availableFrom(period).getTime();
const availText = (period: string) => `GSTR-2B for ${periodLabel(period).split(" ")[0]} is available from ${availableFrom(period).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// GSTR-2A costs two portal calls, 2B and 3B one each; saved copies cost none.
const CALLS = { gstr2b: 1, gstr2a: 2, gstr3b: 1 } as const;
const SOURCES = ["books", "gstr2b", "gstr2a", "gstr3b"] as const;
const SOURCE_LABEL = { books: "Tally books", gstr2b: "GSTR-2B", gstr2a: "GSTR-2A", gstr3b: "GSTR-3B" } as const;

export default function GstReconciliationPage() {
  const [scope, setScope] = useState<GstScopeInput | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [bucket, setBucket] = useState("needs");
  const [setupOpen, setSetupOpen] = useState(false);
  const [viewMonths, setViewMonths] = useState<string[]>([]);
  const [reviewQuery, setReviewQuery] = useState("");
  const [viewYear, setViewYear] = useState<number | null>(null);
  const [periods, setPeriods] = useState<string[]>(() => recentPeriods(3).slice(1, 3));
  const [months, setMonths] = useState<GstMonth[]>([]);
  const [run, setRun] = useState<GstRun | null>(null);
  const [busy, setBusy] = useState("");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState("");
  // Until the saved result has loaded, nothing on the page may say "not saved" or offer a run.
  const [loaded, setLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  // The sticky header blurs its backdrop, which traps fixed overlays inside it, so listen on the document.
  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [menuOpen]);
  const shown = useMemo(() => recentPeriods(6), []);
  const picked = useRef(false);
  const thisYearNow = new Date().getFullYear();
  const [setupYear, setSetupYear] = useState(thisYearNow);
  const [gstStatus, setGstStatus] = useState<{ connected?: boolean; status?: string; sessionExpiry?: string | null; dailyCap?: number } | null>(null);

  // The connector may still be reconnecting when the page opens, so keep looking until a company shows up.
  useEffect(() => {
    if (scope) return;
    let cancelled = false;
    const find = () => void resolveGstScope().then((next) => { if (!cancelled && next) setScope(next); });
    find();
    const timer = window.setInterval(find, 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [scope]);

  const loadSaved = useCallback(async (current: GstScopeInput) => {
    const latest = await gstCall<{ result: GstRun | null }>("GET", "/api/gst/reconcile", current);
    const yrs = Array.from(new Set([thisYearNow - 1, thisYearNow, ...(latest.result?.run.periods ?? []).map((q) => Number(q.slice(0, 4)))]));
    const wanted = Array.from(new Set([...shown, ...(latest.result?.run.periods ?? []), ...yrs.flatMap((y) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`))])).sort();
    gstCall<{ connected?: boolean; status?: string; sessionExpiry?: string | null; dailyCap?: number }>("GET", "/api/gst/status", current).then(setGstStatus).catch(() => undefined);
    const ready = await gstCall<{ months: GstMonth[] }>("GET", "/api/gst/readiness", current, { periods: wanted.join(",") });
    setMonths(ready.months);
    setRun(latest.result);
    // First load: start from the months the last run used, else the months that already have saved data.
    if (!picked.current) {
      picked.current = true;
      const fromRun = latest.result?.run.periods ?? [];
      const withData = ready.months.filter((m) => m.books || m.gstr2b).map((m) => m.period);
      const start = fromRun.length ? fromRun : withData;
      if (start.length) setPeriods([...start].sort());
    }
  }, [shown, thisYearNow]);

  useEffect(() => {
    if (!scope) return;
    loadSaved(scope).catch((e: Error) => setError(e.message)).finally(() => setLoaded(true));
  }, [scope, loadSaved]);


  const viewPicked = useRef(false);
  useEffect(() => {
    const last = [...(run?.run.periods ?? [])].sort().pop();
    if (viewPicked.current || !last) return;
    viewPicked.current = true;
    setViewYear(Number(last.slice(0, 4)));
    setViewMonths([last]);
  }, [run]);

  const byPeriod = useMemo(() => new Map(months.map((m) => [m.period, m])), [months]);
  const chosen = useMemo(() => periods.filter(isAvailable).sort(), [periods]);
  const setupYears = Array.from(new Set([thisYearNow - 1, thisYearNow, ...(run?.run.periods ?? []).map((q) => Number(q.slice(0, 4)))])).sort();
  const anySaved = months.some((m) => m.books || m.gstr2b || m.gstr2a || m.gstr3b);
  const gstOk = !!gstStatus?.connected && gstStatus.status !== "expired" && (!gstStatus.sessionExpiry || new Date(gstStatus.sessionExpiry).getTime() > Date.now());
  const missingCalls = useMemo(() => chosen.reduce((sum, p) => {
    const m = byPeriod.get(p);
    return sum + (m?.gstr2b ? 0 : CALLS.gstr2b) + (m?.gstr2a ? 0 : CALLS.gstr2a) + (m?.gstr3b ? 0 : CALLS.gstr3b);
  }, 0), [chosen, byPeriod]);

  async function readBooks(current: GstScopeInput, period: string) {
    const queued = await gstCall<{ commandId: string }>("POST", "/api/gst/books", current, { period });
    // A large Tally company can take a few minutes to filter by date; the connector allows 5.
    for (let attempt = 0; attempt < 140; attempt += 1) {
      await sleep(2500);
      const step = await gstCall<{ state: string; error?: string }>("GET", "/api/gst/books", current, { period, commandId: queued.commandId });
      if (step.state === "saved") return;
      if (step.state === "failed") throw new Error(step.error || "Tally could not read the purchase books.");
    }
    throw new Error("Tally is taking too long. Check the connector is running and try again.");
  }

  // refreshBooks = "Re-read from Tally": Tally only. It never asks for a GST return, even a missing one;
  // the normal Run is the only path that can spend GST calls, and it shows the count first.
  async function sync(refreshBooks: boolean) {
    if (!scope || !chosen.length) return;
    setError("");
    const total = chosen.length * (refreshBooks ? 1 : 4) + 1;
    let done = 0;
    const step = (message: string) => { setBusy(message); setPct(Math.round((done / total) * 100)); };
    try {
      for (const period of chosen) {
        const month = byPeriod.get(period);
        if (refreshBooks || !month?.books) {
          step(`Reading ${periodLabel(period)} purchases from Tally…`);
          await readBooks(scope, period);
        }
        done += 1;
        if (refreshBooks) continue;
        for (const returnType of ["gstr2b", "gstr3b", "gstr2a"] as const) {
          if (!month?.[returnType]) {
            step(`Getting ${returnType.toUpperCase().replace("GSTR", "GSTR-")} for ${periodLabel(period)}…`);
            try {
              await gstCall("GET", "/api/gst/returns", scope, { returnType, period });
            } catch (e) {
              // 2A and 3B only add detail; 2B is required for the match.
              if (returnType === "gstr2b") throw e;
            }
          }
          done += 1;
        }
      }
      step("Matching invoices…");
      const result = await gstCall<{ state: string; missing?: { kind: string; period: string }[] }>("POST", "/api/gst/reconcile", scope, { periods: chosen });
      if (result.state === "incomplete") {
        const gaps = (result.missing ?? []).map((m) => `${m.kind === "gstr2b" ? "GSTR-2B" : m.kind} for ${periodLabel(m.period)}`).join(", ");
        throw new Error(refreshBooks
          ? `Tally was re-read, but ${gaps} is not saved yet, so nothing was matched. Use Run to fetch it (this uses GST calls).`
          : `Still missing: ${gaps}.`);
      }
      await loadSaved(scope);
      setBucket("needs");
      setTab("Overview");
      setSetupOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      await loadSaved(scope).catch(() => undefined);
    } finally {
      setBusy("");
      setPct(0);
    }
  }

  const refreshRun = useCallback(async () => {
    if (!scope) return;
    const latest = await gstCall<{ result: GstRun | null }>("GET", "/api/gst/reconcile", scope);
    setRun(latest.result);
  }, [scope]);

  // Solution Nyx takes roughly 30 seconds to 2.5 minutes per month to filter in Tally.
  const rereadLabel = `Re-read ${chosen.length === 1 ? periodLabel(chosen[0]) : `${chosen.length} months`} from Tally (about ${Math.max(1, Math.round(chosen.length * 0.5))}–${Math.max(2, Math.ceil(chosen.length * 2.5))} min)`;
  const toggle = (p: string) => setPeriods((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p].sort()).slice(-12));
  const thisYear = new Date().getFullYear();
  const dataYears = run ? Array.from(new Set(run.run.periods.map((p) => Number(p.slice(0, 4))))).sort() : [];
  const year = viewYear ?? (dataYears.includes(thisYear) || !dataYears.length ? thisYear : dataYears[dataYears.length - 1]);
  const yearPeriods = run ? run.run.periods.filter((p) => p.startsWith(String(year))) : [];
  const yearRun = useMemo(() => (run && yearPeriods.length ? scopeRun(run, yearPeriods) : null), [run, yearPeriods.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = useMemo(() => (yearRun ? scopeRun(yearRun, viewMonths.filter((p) => yearPeriods.includes(p))) : null), [yearRun, viewMonths]); // eslint-disable-line react-hooks/exhaustive-deps
  const openCount = view ? view.items.filter((i) => i.bucket !== "matched" && !["accept", "reject"].includes(i.decision?.decision ?? "")).length : 0;
  const badges: Partial<Record<Tab, { n: number; tone: "bad" | "stone" }>> = view
    ? { Review: { n: openCount, tone: openCount ? "bad" : "stone" }, Suppliers: { n: view.run.totals.suppliers.length, tone: "stone" } }
    : {};
  const monthSel = viewMonths.filter((p) => yearPeriods.includes(p));
  const pickYear = (y: number) => { setViewYear(y); setViewMonths([]); };
  const runPeriods = run?.run.periods ?? [];
  const periodOptions = Array.from(new Set(runPeriods.map((q) => Number(q.slice(0, 4))))).sort((a, b) => b - a).flatMap((y) => {
    const inYear = runPeriods.filter((q) => q.startsWith(String(y))).sort().reverse();
    return [...(inYear.length > 1 ? [{ value: `y:${y}`, label: `All of ${y}` }] : []), ...inYear.map((q) => ({ value: `p:${q}`, label: periodLabel(q) }))];
  });
  const periodValue = monthSel.length === 1 ? `p:${monthSel[0]}` : yearPeriods.length === 1 ? `p:${yearPeriods[0]}` : `y:${year}`;
  const pickPeriod = (v: string) => {
    if (v.startsWith("y:")) { pickYear(Number(v.slice(2))); return; }
    const q = v.slice(2);
    setViewYear(Number(q.slice(0, 4)));
    setViewMonths([q]);
  };
  const dataTab = ["Overview", "Review", "Suppliers"].includes(tab);

  return (
    <AppShell>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-5 text-[#111827] sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-4">
          <PageHeader
            title="GST Reconciliation"
            badge={scope ? (
              <>
                {isGstDemo() && (
                  <span className="flex items-center gap-1.5 rounded-lg border border-[#e9d5a0] bg-[#fdf6e3] px-2.5 py-1 text-xs font-medium text-[#7a5b12] shadow-sm" title="Sample data. Nothing comes from your GST account or Tally.">
                    Demo <a href="?demo=0" className="underline">Exit</a>
                  </span>
                )}
                <span className="flex items-center gap-1.5 text-xs font-medium text-[#3d3530]">
                  <i className="h-1.5 w-1.5 rounded-full bg-[#16a34a]" />{scope.companyName}
                </span>
              </>
            ) : undefined}
            actions={scope && loaded ? (
              <span className="flex items-center gap-3 text-[12.5px] text-[#6b6157]">
                {busy ? (
                  <button onClick={() => setSetupOpen(true)} className="flex items-center gap-2 text-[#3d3530]" aria-live="polite" title="Show progress">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /><span className="max-w-[34ch] truncate">{busy}</span>
                    <span className="h-1 w-16 overflow-hidden rounded-full bg-[#e8e0d4]"><i className="block h-full bg-[#16a34a] transition-[width] duration-300" style={{ width: `${Math.max(6, pct)}%` }} /></span>
                  </button>
                ) : run && <span className="hidden sm:inline">Matched {ago(run.run.createdAt)}</span>}
                {run && !setupOpen && !busy && <button onClick={() => setSetupOpen(true)} className="font-medium text-[#3d3530] underline decoration-dotted underline-offset-2 hover:text-[#1a1a1a]">Update months</button>}
                <span className="relative" ref={menuRef}>
                  <button onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="GST account and settings"
                    className="grid h-8 w-8 place-items-center rounded-lg text-[#3d3530] hover:bg-[#ede6d9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c9a86a]"><Settings className="h-4 w-4" /></button>
                  {menuOpen && (
                    <>
                      <span role="menu" className="absolute right-0 top-9 z-40 flex w-44 flex-col rounded-lg border border-[#ded8d0] bg-white py-1 text-[13px] shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
                        {([["Connect", "GST account"], ["Settings", "Settings"]] as const).map(([t, label]) => (
                          <button key={t} role="menuitem" onClick={() => { setTab(t); setMenuOpen(false); }} className="px-3 py-2 text-left text-[#1a1a1a] hover:bg-[#f7f4ef]">{label}</button>
                        ))}
                      </span>
                    </>
                  )}
                </span>
              </span>
            ) : undefined}
          />

          {!scope ? (
            <Empty icon={<Plug className="h-7 w-7" />} title="Waiting for Tally" text="Keep the Bhuleshwar Local Agent and Tally open with your company loaded. This page connects on its own." />
          ) : !loaded ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-[#ded8d0] bg-white px-4 py-6 text-[13px] text-[#3d3530]" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" />Loading your saved reconciliation…
            </div>
          ) : (
            <>
              {!run && !["Connect", "Settings"].includes(tab) && (
              <Panel title="Months to reconcile"
                action={anySaved ? <button onClick={() => sync(true)} disabled={!!busy || !chosen.length} className={btn} title="Reads the selected months from Tally again and re-matches them with the saved GST data. No GST calls. Tally is busy while it runs."><RefreshCw className="h-3 w-3" />{rereadLabel}</button> : undefined}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <SelectDropdown size="sm" value={String(setupYear)} onChange={(v) => setSetupYear(Number(v))} options={setupYears.map((y) => ({ value: String(y), label: String(y) }))} className="w-24" />
                  {gstStatus && (gstOk
                    ? <span className="flex items-center gap-2 text-[12px] text-[#065f46]"><i className="h-1.5 w-1.5 rounded-full bg-[#16a34a]" />GST account connected until {new Date(gstStatus.sessionExpiry as string).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}<button onClick={() => { setTab("Connect"); setSetupOpen(false); }} className="text-[#6b6157] underline">Manage</button></span>
                    : <span className="flex items-center gap-2 text-[12px] text-[#78350f]"><i className="h-1.5 w-1.5 rounded-full bg-[#d97706]" />GST account is not connected. Returns cannot be fetched yet.<button onClick={() => { setTab("Connect"); setSetupOpen(false); }} className={btn}>Connect</button></span>)}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {Array.from({ length: 12 }, (_, i) => `${setupYear}-${String(i + 1).padStart(2, "0")}`).map((p) => {
                    const ok = isAvailable(p);
                    const m = byPeriod.get(p);
                    const saved = m ? SOURCES.filter((k) => m[k]).length : 0;
                    const on = chosen.includes(p);
                    return (
                      <button key={p} onClick={() => toggle(p)} disabled={!!busy || !ok} title={ok ? undefined : availText(p)} aria-pressed={on}
                        className={`flex flex-col items-start gap-0.5 rounded-[10px] border px-3 py-2 text-left disabled:opacity-100 ${!ok ? "cursor-not-allowed border-[#ece6dc] bg-[#f1ede6]" : on ? "border-[#2d2d2d] bg-white shadow-[inset_0_0_0_1px_#2d2d2d]" : "border-[#ded8d0] bg-white hover:bg-[#fbfaf8]"}`}>
                        <strong className={`flex items-center gap-1 text-xs font-semibold ${ok ? "" : "text-[#6b6157]"}`}>{periodLabel(p).split(" ")[0]}{on && <Check className="h-3 w-3" />}</strong>
                        <small className={`text-[11.5px] ${!ok ? "text-[#6b6157]" : saved === 4 ? "text-[#065f46]" : "text-[#6b6157]"}`}>
                          {!ok ? `From ${availableFrom(p).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : saved === 4 ? "All saved" : saved ? `${saved} of 4 saved` : "Not saved yet"}
                        </small>
                      </button>
                    );
                  })}
                </div>

                {anySaved && chosen.length > 0 && (
                  <details className="mt-4"><summary className="cursor-pointer text-[13px] font-medium text-[#3d3530]">What is saved for each month</summary>
                  <div className="mt-2 overflow-x-auto rounded-[10px] border border-[#ece6dc]">
                    <table className="w-full min-w-[560px] border-collapse text-left">
                      <thead><tr><th className={th}>Month</th>{SOURCES.map((k) => <th key={k} className={th}>{SOURCE_LABEL[k]}</th>)}</tr></thead>
                      <tbody>
                        {chosen.map((p) => {
                          const m = byPeriod.get(p);
                          return (
                            <tr key={p} className="border-b border-[#ece6dc] last:border-0">
                              <td className={`${td} font-medium text-[#1a1a1a]`}>{periodLabel(p)}</td>
                              {SOURCES.map((k) => {
                                const have = m?.[k];
                                return (
                                  <td key={k} className={td}>
                                    {have
                                      ? <span className="inline-flex items-center gap-1.5 text-[#065f46]"><Check className="h-3 w-3" />{k === "books" && m?.books ? `${m.books.voucherCount} vouchers${m.books.skippedNoGstin ? ` · ${m.books.skippedNoGstin} skipped (no GSTIN)` : ""}` : "Saved"}<span className="text-[11.5px] text-[#6b6157]">{ago(have.fetchedAt)}</span></span>
                                      : <span className="text-[#b5a99a]">Not fetched</span>}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div></details>
                )}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#ece6dc] pt-3">
                  <span className="text-[12.5px] text-[#3d3530]">
                    {!chosen.length ? "Select at least one month."
                      : <>{chosen.length === 1 ? periodLabel(chosen[0]) : `${chosen.length} months (${periodLabel(chosen[0])} to ${periodLabel(chosen[chosen.length - 1])})`} selected. {missingCalls
                        ? <>This will use <b>{missingCalls} GST call{missingCalls === 1 ? "" : "s"}</b>{gstStatus?.dailyCap ? ` (limit ${gstStatus.dailyCap} a day)` : ""}. Anything already saved is reused.</>
                        : "Everything is saved. No GST calls needed."}</>}
                  </span>
                  <button onClick={() => sync(false)} disabled={!!busy || !chosen.length} className={`${btnPrimary} min-h-9 px-3.5 text-xs`}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    {busy ? "Reconciling…" : missingCalls ? `Run (${missingCalls} GST call${missingCalls === 1 ? "" : "s"})` : "Run (no GST calls)"}
                  </button>
                </div>

                {busy && (
                  <div className="mt-3" aria-live="polite">
                    <div className="h-[5px] overflow-hidden rounded-full bg-[#e8e0d4]"><i className="block h-full rounded-full bg-[#16a34a] transition-[width] duration-300" style={{ width: `${Math.max(6, pct)}%` }} /></div>
                    <p className="mt-2 text-[12px] text-[#6b6157]">{busy}</p>
                  </div>
                )}
                {error && <div className="mt-3"><Alert tone="bad">{error}</Alert></div>}
              </Panel>
              )}

              {run && (
                <Drawer open={setupOpen} onClose={() => setSetupOpen(false)} title="Update months"
                  subtitle="Pick months to add or refresh. Anything already saved is reused."
                  footer={<div className="space-y-2.5">
                {busy && (
                  <div className="mt-3" aria-live="polite">
                    <div className="h-[5px] overflow-hidden rounded-full bg-[#e8e0d4]"><i className="block h-full rounded-full bg-[#16a34a] transition-[width] duration-300" style={{ width: `${Math.max(6, pct)}%` }} /></div>
                    <p className="mt-2 text-[12px] text-[#6b6157]">{busy}</p>
                  </div>
                )}
                {error && <div className="mt-3"><Alert tone="bad">{error}</Alert></div>}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[12.5px] text-[#3d3530]">
                    {!chosen.length ? "Select at least one month."
                      : <>{chosen.length === 1 ? periodLabel(chosen[0]) : `${chosen.length} months (${periodLabel(chosen[0])} to ${periodLabel(chosen[chosen.length - 1])})`} selected. {missingCalls
                        ? <>This will use <b>{missingCalls} GST call{missingCalls === 1 ? "" : "s"}</b>{gstStatus?.dailyCap ? ` (limit ${gstStatus.dailyCap} a day)` : ""}. Anything already saved is reused.</>
                        : "Everything is saved. No GST calls needed."}</>}
                  </span>
                  <button onClick={() => sync(false)} disabled={!!busy || !chosen.length} className={`${btnPrimary} min-h-9 px-3.5 text-xs`}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    {busy ? "Reconciling…" : missingCalls ? `Run (${missingCalls} GST call${missingCalls === 1 ? "" : "s"})` : "Run (no GST calls)"}
                  </button>
                </div>

                  </div>}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <SelectDropdown size="sm" value={String(setupYear)} onChange={(v) => setSetupYear(Number(v))} options={setupYears.map((y) => ({ value: String(y), label: String(y) }))} className="w-24" />
                  {gstStatus && (gstOk
                    ? <span className="flex items-center gap-2 text-[12px] text-[#065f46]"><i className="h-1.5 w-1.5 rounded-full bg-[#16a34a]" />GST account connected until {new Date(gstStatus.sessionExpiry as string).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}<button onClick={() => { setTab("Connect"); setSetupOpen(false); }} className="text-[#6b6157] underline">Manage</button></span>
                    : <span className="flex items-center gap-2 text-[12px] text-[#78350f]"><i className="h-1.5 w-1.5 rounded-full bg-[#d97706]" />GST account is not connected. Returns cannot be fetched yet.<button onClick={() => { setTab("Connect"); setSetupOpen(false); }} className={btn}>Connect</button></span>)}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                  {Array.from({ length: 12 }, (_, i) => `${setupYear}-${String(i + 1).padStart(2, "0")}`).map((p) => {
                    const ok = isAvailable(p);
                    const m = byPeriod.get(p);
                    const saved = m ? SOURCES.filter((k) => m[k]).length : 0;
                    const on = chosen.includes(p);
                    return (
                      <button key={p} onClick={() => toggle(p)} disabled={!!busy || !ok} title={ok ? undefined : availText(p)} aria-pressed={on}
                        className={`flex flex-col items-start gap-0.5 rounded-[10px] border px-3 py-2 text-left disabled:opacity-100 ${!ok ? "cursor-not-allowed border-[#ece6dc] bg-[#f1ede6]" : on ? "border-[#2d2d2d] bg-white shadow-[inset_0_0_0_1px_#2d2d2d]" : "border-[#ded8d0] bg-white hover:bg-[#fbfaf8]"}`}>
                        <strong className={`flex items-center gap-1 text-xs font-semibold ${ok ? "" : "text-[#6b6157]"}`}>{periodLabel(p).split(" ")[0]}{on && <Check className="h-3 w-3" />}</strong>
                        <small className={`text-[11.5px] ${!ok ? "text-[#6b6157]" : saved === 4 ? "text-[#065f46]" : "text-[#6b6157]"}`}>
                          {!ok ? `From ${availableFrom(p).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : saved === 4 ? "All saved" : saved ? `${saved} of 4 saved` : "Not saved yet"}
                        </small>
                      </button>
                    );
                  })}
                </div>

                {anySaved && chosen.length > 0 && (
                  <details className="mt-4"><summary className="cursor-pointer text-[13px] font-medium text-[#3d3530]">What is saved for each month</summary>
                  <div className="mt-2 overflow-x-auto rounded-[10px] border border-[#ece6dc]">
                    <table className="w-full min-w-[560px] border-collapse text-left">
                      <thead><tr><th className={th}>Month</th>{SOURCES.map((k) => <th key={k} className={th}>{SOURCE_LABEL[k]}</th>)}</tr></thead>
                      <tbody>
                        {chosen.map((p) => {
                          const m = byPeriod.get(p);
                          return (
                            <tr key={p} className="border-b border-[#ece6dc] last:border-0">
                              <td className={`${td} font-medium text-[#1a1a1a]`}>{periodLabel(p)}</td>
                              {SOURCES.map((k) => {
                                const have = m?.[k];
                                return (
                                  <td key={k} className={td}>
                                    {have
                                      ? <span className="inline-flex items-center gap-1.5 text-[#065f46]"><Check className="h-3 w-3" />{k === "books" && m?.books ? `${m.books.voucherCount} vouchers${m.books.skippedNoGstin ? ` · ${m.books.skippedNoGstin} skipped (no GSTIN)` : ""}` : "Saved"}<span className="text-[11.5px] text-[#6b6157]">{ago(have.fetchedAt)}</span></span>
                                      : <span className="text-[#b5a99a]">Not fetched</span>}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div></details>
                )}

                  {anySaved && (
                    <p className="mt-5 border-t border-[#ece6dc] pt-4 text-[12.5px] text-[#6b6157]">
                      Changed something in Tally? <button onClick={() => sync(true)} disabled={!!busy || !chosen.length} className="inline-flex items-center gap-1 font-medium text-[#1a1a1a] underline decoration-dotted underline-offset-2 disabled:opacity-50"><RefreshCw className="h-3 w-3" />{rereadLabel}</button>. It re-matches with the GST data already saved and makes no GST calls. Tally is busy while it runs.
                    </p>
                  )}
                </Drawer>
              )}
              {run && error && !setupOpen && <Alert tone="bad">{error}</Alert>}

              {(run || tab !== "Overview") && <nav className="flex gap-0.5 overflow-x-auto border-b border-[#ded8d0]" role="tablist">
                {TABS.filter((name) => (["Connect", "Settings"].includes(name) ? tab === name : run || name === "Overview")).map((name) => {
                  const badge = badges[name];
                  const active = tab === name;
                  return (
                    <button key={name} role="tab" aria-selected={active} onClick={() => { setTab(name); if (name === "Review") { setBucket("needs"); setReviewQuery(""); } }}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-3 text-[13.5px] ${active ? "border-[#2d2d2d] font-semibold text-[#1a1a1a]" : "border-transparent text-[#6b6157] hover:text-[#3d3530]"}`}>
                      {TAB_LABEL[name] ?? name}
                      {badge && badge.n > 0 && (
                        <span className={`rounded-full border px-[7px] py-px text-[11.5px] font-bold ${active ? "border-[#2d2d2d] bg-[#2d2d2d] text-white" : badge.tone === "bad" ? "border-[#fecaca] bg-[#fef2f2] text-[#991b1b]" : "border-[#e7e5e4] bg-[#f5f5f4] text-[#57534e]"}`}>{badge.n}</span>
                      )}
                    </button>
                  );
                })}
                {run && dataTab && periodOptions.length > 0 && (
                  <span className="ml-auto flex items-center pl-3">
                    {periodOptions.length === 1
                      ? <span className="text-[13px] font-semibold text-[#1a1a1a]">{periodOptions[0].label}</span>
                      : <SelectDropdown size="sm" value={periodValue} onChange={pickPeriod} options={periodOptions} className="w-36" />}
                  </span>
                )}
              </nav>}

              {run && !view && ["Overview", "Review", "Suppliers"].includes(tab) && <Empty icon={<Plug className="h-7 w-7" />} title={`Nothing reconciled for ${year}`} text="Use Reconcile other months to add months for this year." />}
              {run && view && tab === "Overview" && <OverviewView run={view} wholeRun={view === run} onRun={() => sync(false)}
                skipped={view.run.periods.reduce((n, p) => n + (byPeriod.get(p)?.books?.skippedNoGstin ?? 0), 0)}
                onOpen={(id, gstin) => { setBucket(id ?? "needs"); setReviewQuery(gstin ?? ""); setTab("Review"); }} />}
              {!(run && !view) && tab === "Review" && <ReviewView run={view} scope={scope} bucket={bucket} onBucket={setBucket} onChanged={refreshRun} onRun={() => sync(false)} initialQuery={reviewQuery} />}
              {!(run && !view) && tab === "Suppliers" && <SuppliersView run={view} scope={scope} />}
              {tab === "Connect" && <ConnectView scope={scope} />}
              {tab === "Settings" && <SettingsView scope={scope} />}
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}

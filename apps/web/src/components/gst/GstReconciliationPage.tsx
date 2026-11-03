"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/dashboard/AppShell";
import { Check, Loader2, Play, Plug, RefreshCw } from "lucide-react";
import {
  ago, gstCall, periodLabel, recentPeriods, resolveGstScope,
  type GstMonth, type GstRun, type GstScopeInput,
} from "@/lib/gst-client";
import { OverviewView, ReviewView, WorklistView } from "./GstViews";
import { ConnectView, SettingsView, SuppliersView } from "./GstAdminViews";
import { Alert, btn, btnPrimary, Empty, Panel, Pill, th, td } from "./gst-ui";

const TABS = ["Overview", "Review", "Worklist", "Suppliers", "Connect", "Settings"] as const;
type Tab = (typeof TABS)[number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// GSTR-2A costs two portal calls, 2B and 3B one each; saved copies cost none.
const CALLS = { gstr2b: 1, gstr2a: 2, gstr3b: 1 } as const;
const SOURCES = ["books", "gstr2b", "gstr2a", "gstr3b"] as const;
const SOURCE_LABEL = { books: "Tally books", gstr2b: "GSTR-2B", gstr2a: "GSTR-2A", gstr3b: "GSTR-3B" } as const;

export default function GstReconciliationPage() {
  const [scope, setScope] = useState<GstScopeInput | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [bucket, setBucket] = useState("all");
  const [periods, setPeriods] = useState<string[]>(() => recentPeriods(3).slice(1, 3));
  const [months, setMonths] = useState<GstMonth[]>([]);
  const [run, setRun] = useState<GstRun | null>(null);
  const [busy, setBusy] = useState("");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState("");
  const shown = useMemo(() => recentPeriods(6), []);
  const picked = useRef(false);

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
    const [ready, latest] = await Promise.all([
      gstCall<{ months: GstMonth[] }>("GET", "/api/gst/readiness", current, { periods: shown.join(",") }),
      gstCall<{ result: GstRun | null }>("GET", "/api/gst/reconcile", current),
    ]);
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
  }, [shown]);

  useEffect(() => {
    if (!scope) return;
    loadSaved(scope).catch((e: Error) => setError(e.message));
  }, [scope, loadSaved]);

  const byPeriod = useMemo(() => new Map(months.map((m) => [m.period, m])), [months]);
  const chosen = useMemo(() => [...periods].sort(), [periods]);
  const missingCalls = useMemo(() => chosen.reduce((sum, p) => {
    const m = byPeriod.get(p);
    return sum + (m?.gstr2b ? 0 : CALLS.gstr2b) + (m?.gstr2a ? 0 : CALLS.gstr2a) + (m?.gstr3b ? 0 : CALLS.gstr3b);
  }, 0), [chosen, byPeriod]);

  async function readBooks(current: GstScopeInput, period: string) {
    const queued = await gstCall<{ commandId: string }>("POST", "/api/gst/books", current, { period });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(2500);
      const step = await gstCall<{ state: string; error?: string }>("GET", "/api/gst/books", current, { period, commandId: queued.commandId });
      if (step.state === "saved") return;
      if (step.state === "failed") throw new Error(step.error || "Tally could not read the purchase books.");
    }
    throw new Error("Tally is taking too long. Check the connector is running and try again.");
  }

  async function sync(refreshBooks: boolean) {
    if (!scope || !chosen.length) return;
    setError("");
    const total = chosen.length * 4 + 1;
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
        throw new Error(`Still missing: ${(result.missing ?? []).map((m) => `${m.kind} ${m.period}`).join(", ")}`);
      }
      await loadSaved(scope);
      setBucket("all");
      setTab("Overview");
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

  const toggle = (p: string) => setPeriods((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p].sort()).slice(-12));
  const openCount = run ? run.items.filter((i) => i.bucket !== "matched" && !["accept", "reject"].includes(i.decision?.decision ?? "")).length : 0;
  const badges: Partial<Record<Tab, { n: number; tone: "bad" | "stone" }>> = run
    ? { Review: { n: run.items.length, tone: "stone" }, Worklist: { n: openCount, tone: openCount ? "bad" : "stone" }, Suppliers: { n: run.run.totals.suppliers.length, tone: "stone" } }
    : {};

  return (
    <AppShell>
      <main className="min-h-screen bg-[#f7f7f5] px-4 py-6 text-[#1a1a1a] sm:px-8 sm:py-8">
        <div className="mx-auto max-w-6xl space-y-4">
          <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h1 className="text-[22px] font-semibold tracking-tight">GST reconciliation</h1>
              <p className="mt-1 text-xs text-[#8a7f72]">Check every purchase invoice in Tally against what your suppliers filed, and see the ITC you could lose.</p>
              {scope && (
                <p className="mt-2.5 inline-flex items-center gap-2 rounded-full border border-[#ded8d0] bg-white px-2.5 py-1 text-[11px] font-medium text-[#3d3530]">
                  <i className="h-1.5 w-1.5 rounded-full bg-[#16a34a]" />Tally · {scope.companyName}
                </p>
              )}
            </div>
            {scope && (
              <button onClick={() => sync(false)} disabled={!!busy || !chosen.length} className={`${btnPrimary} min-h-10 px-[18px] text-[13px]`}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                {busy ? "Reconciling…" : run ? "Run again" : "Run reconciliation"}
              </button>
            )}
          </header>

          {!scope ? (
            <Empty icon={<Plug className="h-7 w-7" />} title="Waiting for Tally" text="Keep the Bhuleshwar Local Agent and Tally open with your company loaded. This page connects on its own." />
          ) : (
            <>
              <Panel title="Months to reconcile" sub={chosen.length ? `${chosen.map(periodLabel).join(", ")} selected` : "Select at least one month"}
                action={<button onClick={() => sync(true)} disabled={!!busy || !chosen.length} className={btn}><RefreshCw className="h-3 w-3" />Re-read books from Tally</button>}>
                <div className="flex flex-wrap gap-2">
                  {shown.map((p) => {
                    const m = byPeriod.get(p);
                    const saved = m ? SOURCES.filter((k) => m[k]).length : 0;
                    const on = periods.includes(p);
                    return (
                      <button key={p} onClick={() => toggle(p)} disabled={!!busy} aria-pressed={on}
                        className={`flex min-w-[112px] flex-col items-start gap-0.5 rounded-[10px] border bg-white px-3 py-2 text-left disabled:opacity-60 ${on ? "border-[#2d2d2d] shadow-[inset_0_0_0_1px_#2d2d2d]" : "border-[#ded8d0] hover:bg-[#fbfaf8]"}`}>
                        <strong className="flex items-center gap-1 text-xs font-semibold">{periodLabel(p)}{on && <Check className="h-3 w-3" />}</strong>
                        <small className={`text-[10px] ${saved === 4 ? "text-[#065f46]" : "text-[#8a7f72]"}`}>{saved === 4 ? "All data saved" : saved ? `${saved} of 4 saved` : "Nothing saved yet"}</small>
                      </button>
                    );
                  })}
                </div>

                {chosen.length > 0 && (
                  <div className="mt-4 overflow-x-auto rounded-[10px] border border-[#ece6dc]">
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
                                      ? <span className="inline-flex items-center gap-1.5 text-[#065f46]"><Check className="h-3 w-3" />{k === "books" && m?.books ? `${m.books.voucherCount} vouchers` : "Saved"}<span className="text-[10.5px] text-[#8a7f72]">{ago(have.fetchedAt)}</span></span>
                                      : <span className="text-[#b5a99a]">Not fetched</span>}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-[#8a7f72]">
                  {missingCalls
                    ? <><Pill tone="warn">{missingCalls} GST call{missingCalls === 1 ? "" : "s"}</Pill><span>needed for the missing returns. Saved data is reused and Tally reads are free.</span></>
                    : <><Pill tone="ok">No GST calls needed</Pill><span>Everything for these months is already saved.</span></>}
                </div>

                {busy && (
                  <div className="mt-3" aria-live="polite">
                    <div className="h-[5px] overflow-hidden rounded-full bg-[#e8e0d4]"><i className="block h-full rounded-full bg-[#16a34a] transition-[width] duration-300" style={{ width: `${Math.max(6, pct)}%` }} /></div>
                    <p className="mt-2 text-[11px] text-[#8a7f72]">{busy}</p>
                  </div>
                )}
                {error && <div className="mt-3"><Alert tone="bad">{error}</Alert></div>}
              </Panel>

              <nav className="flex gap-0.5 overflow-x-auto border-b border-[#ded8d0]" role="tablist">
                {TABS.map((name) => {
                  const badge = badges[name];
                  const active = tab === name;
                  return (
                    <button key={name} role="tab" aria-selected={active} onClick={() => { setTab(name); if (name === "Review") setBucket("all"); }}
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-3 text-[12.5px] ${active ? "border-[#2d2d2d] font-semibold text-[#1a1a1a]" : "border-transparent text-[#82776a] hover:text-[#3d3530]"}`}>
                      {name}
                      {badge && badge.n > 0 && (
                        <span className={`rounded-full border px-[7px] py-px text-[10.5px] font-bold ${active ? "border-[#2d2d2d] bg-[#2d2d2d] text-white" : badge.tone === "bad" ? "border-[#fecaca] bg-[#fef2f2] text-[#991b1b]" : "border-[#e7e5e4] bg-[#f5f5f4] text-[#57534e]"}`}>{badge.n}</span>
                      )}
                    </button>
                  );
                })}
              </nav>

              {tab === "Overview" && <OverviewView run={run} onRun={() => sync(false)} onOpen={(id) => { setBucket(id ?? "all"); setTab("Review"); }} />}
              {tab === "Review" && <ReviewView run={run} scope={scope} bucket={bucket} onBucket={setBucket} onChanged={refreshRun} onRun={() => sync(false)} />}
              {tab === "Worklist" && <WorklistView run={run} scope={scope} onChanged={refreshRun} onRun={() => sync(false)} />}
              {tab === "Suppliers" && <SuppliersView run={run} scope={scope} />}
              {tab === "Connect" && <ConnectView scope={scope} />}
              {tab === "Settings" && <SettingsView scope={scope} />}
            </>
          )}
        </div>
      </main>
    </AppShell>
  );
}

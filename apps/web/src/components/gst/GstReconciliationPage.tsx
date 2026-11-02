"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/dashboard/AppShell";
import { Loader2, RefreshCw } from "lucide-react";
import {
  ago, gstCall, periodLabel, readGstScope, recentPeriods,
  type GstMonth, type GstRun, type GstScopeInput,
} from "@/lib/gst-client";
import { OverviewView, ReviewView, WorklistView } from "./GstViews";
import { ConnectView, SettingsView, SuppliersView } from "./GstAdminViews";

const TABS = ["Overview", "Review", "Worklist", "Suppliers", "Connect", "Settings"] as const;
type Tab = (typeof TABS)[number];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// GSTR-2A costs two portal calls, 2B and 3B one each; saved copies cost none.
const CALLS = { gstr2b: 1, gstr2a: 2, gstr3b: 1 } as const;

export default function GstReconciliationPage() {
  const [scope, setScope] = useState<GstScopeInput | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [periods, setPeriods] = useState<string[]>(() => recentPeriods(3).slice(1, 3));
  const [months, setMonths] = useState<GstMonth[]>([]);
  const [run, setRun] = useState<GstRun | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => setScope(readGstScope()), []);

  const loadSaved = useCallback(async (current: GstScopeInput, selected: string[]) => {
    const [ready, latest] = await Promise.all([
      gstCall<{ months: GstMonth[] }>("GET", "/api/gst/readiness", current, { periods: selected.join(",") }),
      gstCall<{ result: GstRun | null }>("GET", "/api/gst/reconcile", current),
    ]);
    setMonths(ready.months);
    setRun(latest.result);
  }, []);

  useEffect(() => {
    if (!scope) return;
    loadSaved(scope, periods).catch((e: Error) => setError(e.message));
  }, [scope, periods, loadSaved]);

  const missingCalls = useMemo(() => months.reduce((sum, m) => sum + (m.gstr2b ? 0 : CALLS.gstr2b) + (m.gstr2a ? 0 : CALLS.gstr2a) + (m.gstr3b ? 0 : CALLS.gstr3b), 0), [months]);

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
    if (!scope) return;
    setError("");
    try {
      for (const period of periods) {
        const month = months.find((m) => m.period === period);
        if (refreshBooks || !month?.books) {
          setBusy(`Reading ${periodLabel(period)} purchases from Tally…`);
          await readBooks(scope, period);
        }
        for (const returnType of ["gstr2b", "gstr3b", "gstr2a"] as const) {
          if (month?.[returnType]) continue;
          setBusy(`Getting ${returnType.toUpperCase().replace("GSTR", "GSTR-")} for ${periodLabel(period)}…`);
          try {
            await gstCall("GET", "/api/gst/returns", scope, { returnType, period });
          } catch (e) {
            // 2A and 3B only add detail; 2B is required for the match.
            if (returnType === "gstr2b") throw e;
          }
        }
      }
      setBusy("Matching invoices…");
      const result = await gstCall<{ state: string; missing?: { kind: string; period: string }[] }>("POST", "/api/gst/reconcile", scope, { periods });
      if (result.state === "incomplete") {
        throw new Error(`Still missing: ${(result.missing ?? []).map((m) => `${m.kind} ${m.period}`).join(", ")}`);
      }
      await loadSaved(scope, periods);
      setTab("Overview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      await loadSaved(scope, periods).catch(() => undefined);
    } finally {
      setBusy("");
    }
  }

  const refreshRun = useCallback(async () => {
    if (!scope) return;
    const latest = await gstCall<{ result: GstRun | null }>("GET", "/api/gst/reconcile", scope);
    setRun(latest.result);
  }, [scope]);

  return (
    <AppShell>
      <main className="min-h-screen bg-[#f7f7f5] px-4 py-6 text-[#1a1a1a] sm:px-8 sm:py-8">
        <div className="mx-auto max-w-7xl space-y-5">
          <header className="flex flex-col gap-3 border-b border-[#e5ddd0] pb-5 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-3xl font-black tracking-tight">GST Reconciliation</h1>
              <p className="mt-1 text-xs font-semibold text-slate-500">
                {scope ? `${scope.companyName} · purchase books against GSTR-2B and GSTR-2A` : "Select a Tally company in Tally Connector first."}
              </p>
            </div>
            {scope && (
              <div className="flex flex-wrap items-center gap-2">
                {recentPeriods(6).map((p) => (
                  <label key={p} className={`cursor-pointer rounded-full border px-3 py-1 text-xs font-bold ${periods.includes(p) ? "border-[#2d2d2d] bg-[#2d2d2d] text-white" : "border-[#e5ddd0] bg-white text-slate-600"}`}>
                    <input type="checkbox" className="sr-only" checked={periods.includes(p)} disabled={!!busy}
                      onChange={() => setPeriods((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p].sort()).slice(-12))} />
                    {periodLabel(p)}
                  </label>
                ))}
              </div>
            )}
          </header>

          {scope && (
            <section className="rounded-2xl border border-[#e5ddd0] bg-white p-4 shadow-sm">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {months.map((m) => (
                  <div key={m.period} className="rounded-xl border border-[#efe8dc] p-3 text-xs">
                    <div className="font-extrabold">{periodLabel(m.period)}</div>
                    <div className="mt-1 space-y-0.5 text-slate-500">
                      <div>Books: {m.books ? `${m.books.voucherCount} vouchers · ${ago(m.books.fetchedAt)}` : "not read yet"}</div>
                      <div>GSTR-2B: {m.gstr2b ? ago(m.gstr2b.fetchedAt) : "not fetched"}</div>
                      <div>GSTR-2A: {m.gstr2a ? ago(m.gstr2a.fetchedAt) : "not fetched"}</div>
                      <div>GSTR-3B: {m.gstr3b ? ago(m.gstr3b.fetchedAt) : "not fetched"}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button onClick={() => sync(false)} disabled={!!busy || !periods.length}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#2d2d2d] px-4 text-xs font-bold text-white disabled:opacity-50">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {busy || "Reconcile"}
                </button>
                <button onClick={() => sync(true)} disabled={!!busy || !periods.length}
                  className="h-10 rounded-xl border border-[#e5ddd0] bg-white px-4 text-xs font-bold text-slate-600 disabled:opacity-50">
                  Re-read books from Tally
                </button>
                <span className="text-xs font-semibold text-slate-500">
                  {missingCalls ? `Uses about ${missingCalls} GST call${missingCalls === 1 ? "" : "s"} (saved data is reused). Tally reads are free.` : "Everything needed is saved. No GST calls needed."}
                </span>
              </div>
              {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-800">{error}</p>}
            </section>
          )}

          {scope && (
            <>
              <nav className="flex gap-1 overflow-x-auto border-b border-[#e5ddd0]">
                {TABS.map((name) => (
                  <button key={name} onClick={() => setTab(name)}
                    className={`px-4 py-2 text-xs font-bold ${tab === name ? "border-b-2 border-[#2d2d2d] text-[#1a1a1a]" : "text-slate-500"}`}>{name}</button>
                ))}
              </nav>
              {tab === "Overview" && <OverviewView run={run} onOpen={() => setTab("Review")} />}
              {tab === "Review" && <ReviewView run={run} scope={scope} onChanged={refreshRun} />}
              {tab === "Worklist" && <WorklistView run={run} scope={scope} onChanged={refreshRun} />}
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ClipboardCheck, Clock, FileSearch, Scale, Search } from "lucide-react";
import {
  ago, DECISION_LABEL, gstCall, inr, inrShort, periodLabel,
  type GstItem, type GstRun, type GstScopeInput, type GstSide,
} from "@/lib/gst-client";
import { Alert, btn, btnPrimary, Drawer, Empty, inputCls, Kpi, Panel, Pill, td, th, TONE, TONE_BAR, TONE_EDGE, TONE_TEXT, toneOf } from "./gst-ui";

const labelOf = (run: GstRun, id: string) => run.run.totals.buckets.find((b) => b.id === id)?.label ?? id;
const nameOf = (item: GstItem) => (item.books ?? item.g2b ?? item.g2a)?.supplierName ?? "";
const num = (value: unknown) => Number(value) || 0;

function Freshness({ run }: { run: GstRun }) {
  const versions = Object.entries(run.run.dataVersions);
  const oldest = (prefix: string) => versions.filter(([k]) => k.startsWith(prefix)).map(([, v]) => v).sort()[0];
  return (
    <p className="text-[11px] text-[#8a7f72]">
      Matched {ago(run.run.createdAt)} · Tally books as of {ago(run.run.booksAsOf)} · GSTR-2B as of {ago(oldest("gstr2b"))}
      {oldest("gstr2a") ? ` · GSTR-2A as of ${ago(oldest("gstr2a"))}` : ""}
    </p>
  );
}

function NoRun({ onRun }: { onRun?: () => void }) {
  return (
    <Empty
      icon={<Scale className="h-7 w-7" />}
      title="No reconciliation yet"
      text="Pick the months above and run it. Bhuleshwar reads your purchase books from Tally and checks every invoice against what your suppliers filed."
      action={onRun ? <button onClick={onRun} className={btnPrimary}>Run reconciliation</button> : undefined}
    />
  );
}

// ------------------------------------------------------------------ overview
export function OverviewView({ run, onOpen, onRun }: { run: GstRun | null; onOpen: (bucket?: string) => void; onRun: () => void }) {
  if (!run) return <NoRun onRun={onRun} />;
  const { summary, buckets, movement, filed, suppliers } = run.run.totals;
  const exceptions = buckets.filter((b) => b.id !== "matched").reduce((sum, b) => sum + b.count, 0);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const reasons = buckets.filter((b) => b.id !== "matched" && b.count > 0).sort((a, b) => b.count - a.count);
  const matched = buckets.find((b) => b.id === "matched")?.count ?? 0;
  const widest = Math.max(1, ...reasons.map((b) => b.count), matched);
  const off3B = filed.filter((f) => Math.abs(f.delta) > 1);
  const worst = suppliers.filter((s) => s.atRisk > 0).sort((a, b) => b.atRisk - a.atRisk).slice(0, 5);

  return (
    <div className="space-y-3">
      <Freshness run={run} />

      <section className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi tone={exceptions ? "bad" : "ok"} icon={<FileSearch className="h-[15px] w-[15px]" />} label="Needs a decision"
          value={`${exceptions} of ${total}`} note={`${inrShort(summary.atRisk)} of ITC at risk`} />
        <Kpi icon={<ClipboardCheck className="h-[15px] w-[15px]" />} label="ITC claimed in books" value={inrShort(summary.claimed)} note="What your purchase vouchers say" />
        <Kpi icon={<Scale className="h-[15px] w-[15px]" />} label="ITC available in GSTR-2B" value={inrShort(summary.available)}
          note={num(summary.gap) ? `Gap of ${inrShort(summary.gap)}` : "Fully supported"} />
        <Kpi tone={num(summary.expiringSoon) ? "warn" : undefined} icon={<Clock className="h-[15px] w-[15px]" />} label="Lapses within 6 months"
          value={inrShort(summary.expiringSoon)} note={`${inrShort(summary.awaitedTax)} waiting on suppliers`} />
      </section>

      {off3B.length > 0 && (
        <Alert tone="warn">
          <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>{off3B.map((f) => `${periodLabel(f.period)} differs by ${inr(f.delta)}`).join(" · ")} between what GSTR-3B declared and what your books say.</span></span>
        </Alert>
      )}

      {movement.hasPrior ? (
        <p className="text-[11.5px] text-[#8a7f72]">
          Since last run: <b className="text-[#065f46]">{movement.resolved} resolved</b> · <b className="text-[#3d3530]">{movement.opened} new</b> · {movement.stillOpen} still open
          {movement.reopened ? ` · ${movement.reopened} reopened` : ""}
        </p>
      ) : (
        <p className="text-[11.5px] text-[#8a7f72]">This run is the baseline. Changes since the previous run will show here next time.</p>
      )}

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <div className="space-y-3">
        <Panel title="By reason" sub="Select a reason to review those invoices" action={<button onClick={() => onOpen()} className="text-[11.5px] font-semibold text-[#2b1a10] hover:underline">All invoices</button>}>
          <div className="space-y-1.5">
            {reasons.length === 0 && <p className="py-6 text-center text-xs text-[#8a7f72]">Everything matched. Nothing to review.</p>}
            {reasons.map((b) => {
              const tone = toneOf(b.id);
              return (
                <button key={b.id} onClick={() => onOpen(b.id)} className="grid w-full grid-cols-[148px_minmax(0,1fr)_40px] items-center gap-3 rounded-lg px-1.5 py-1.5 text-left hover:bg-[#f7f4ef]">
                  <Pill tone={tone}>{b.label}</Pill>
                  <span className="h-[7px] overflow-hidden rounded-full bg-[#efe9df]"><i className={`block h-full rounded-full ${TONE_BAR[tone]}`} style={{ width: `${Math.max(4, (b.count / widest) * 100)}%` }} /></span>
                  <span className="text-right text-[11px] font-bold tabular-nums text-[#3d3530]">{b.count}</span>
                </button>
              );
            })}
            {matched > 0 && (
              <button onClick={() => onOpen("matched")} className="grid w-full grid-cols-[148px_minmax(0,1fr)_40px] items-center gap-3 rounded-lg border-t border-[#ece6dc] px-1.5 pb-1.5 pt-2.5 text-left hover:bg-[#f7f4ef]">
                <Pill tone="ok">Matched</Pill>
                <span className="h-[7px] overflow-hidden rounded-full bg-[#efe9df]"><i className={`block h-full rounded-full ${TONE_BAR.ok}`} style={{ width: `${(matched / widest) * 100}%` }} /></span>
                <span className="text-right text-[11px] font-bold tabular-nums text-[#3d3530]">{matched}</span>
              </button>
            )}
          </div>
        </Panel>
        {filed.length > 0 && (
          <Panel title="GSTR-3B check" sub="What was declared against what your books say">
            <table className="w-full text-left text-xs">
              <thead><tr className="text-[10.5px] font-bold uppercase tracking-[0.04em] text-[#8a7f72]"><th className="pb-2 font-bold">Month</th><th className="pb-2 text-right font-bold">Declared</th><th className="pb-2 text-right font-bold">Books</th><th className="pb-2 text-right font-bold">Difference</th></tr></thead>
              <tbody className="tabular-nums">
                {filed.map((f) => (
                  <tr key={f.period} className="border-t border-[#ece6dc]">
                    <td className="py-2 font-medium text-[#1a1a1a]">{periodLabel(f.period)}</td>
                    <td className="py-2 text-right">{inr(f.declaredIn3B)}</td>
                    <td className="py-2 text-right">{inr(f.perBooks)}</td>
                    <td className={`py-2 text-right font-semibold ${Math.abs(f.delta) > 1 ? "text-[#991b1b]" : "text-[#065f46]"}`}>{Math.abs(f.delta) > 1 ? inr(f.delta) : "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        </div>

        <div className="space-y-3">
          <Panel title="Suppliers to chase" sub="Most ITC at risk first">
            {worst.length === 0 ? <p className="py-6 text-center text-xs text-[#8a7f72]">No supplier has ITC at risk.</p> : (
              <table className="w-full text-left">
                <tbody>
                  {worst.map((s) => (
                    <tr key={s.gstin} className="border-b border-[#ece6dc] last:border-0">
                      <td className="py-2 pr-2"><span className="block max-w-[28ch] truncate text-[12.5px] font-medium text-[#1a1a1a]">{s.name || s.gstin}</span><span className="font-mono text-[10.5px] text-[#8a7f72]">{s.gstin}</span></td>
                      <td className="py-2 text-right text-[11px] text-[#8a7f72]">{s.exceptions} open</td>
                      <td className="py-2 pl-3 text-right text-xs font-semibold tabular-nums text-[#991b1b]">{inr(s.atRisk)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- compare
const FIELDS: [string, keyof NonNullable<GstSide>["tax"]][] = [
  ["Taxable value", "taxable"], ["CGST", "cgst"], ["SGST", "sgst"], ["IGST", "igst"], ["Total tax", "total"],
];
const money = (n: number | undefined) => (n === undefined ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function CompareGrid({ item }: { item: GstItem }) {
  const cols: [string, GstSide][] = [["Books", item.books], ["GSTR-2B", item.g2b], ["GSTR-2A", item.g2a]];
  const differs = (a?: number, b?: number) => a !== undefined && b !== undefined && Math.abs(a - b) > 1;
  return (
    <div className="overflow-hidden rounded-[10px] border border-[#ece6dc]">
      <div className="grid grid-cols-[120px_repeat(3,minmax(0,1fr))] bg-[#f7f4ef] text-[10px] font-bold uppercase tracking-[0.06em] text-[#3d3530]">
        <div className="border-b border-[#e0d8cc] px-3 py-2" />
        {cols.map(([name, side]) => (
          <div key={name} className={`border-b border-l border-[#e0d8cc] px-3 py-2 ${side ? "" : "text-[#b5a99a]"}`}>{side ? name : `${name} — missing`}</div>
        ))}
      </div>
      <div className="grid grid-cols-[120px_repeat(3,minmax(0,1fr))] border-b border-[#ece6dc] text-[11.5px]">
        <div className="px-3 py-2 text-[#756b60]">Invoice</div>
        {cols.map(([name, side]) => (
          <div key={name} className="px-3 py-2 font-mono text-[11px] text-[#3d3530]">{side ? <>{side.invoiceNo}<div className="text-[10px] text-[#8a7f72]">{side.invoiceDate}</div></> : <span className="text-[#b5a99a]">—</span>}</div>
        ))}
      </div>
      {FIELDS.map(([label, key], row) => {
        const base = item.books?.tax[key];
        return (
          <div key={key} className={`grid grid-cols-[120px_repeat(3,minmax(0,1fr))] text-[11.5px] ${row % 2 ? "bg-[#fdfcfa]" : ""}`}>
            <div className="px-3 py-2 text-[#756b60]">{label}</div>
            {cols.map(([name, side], i) => {
              const value = side?.tax[key];
              const diff = i > 0 && differs(base, value);
              return (
                <div key={name} className={`px-3 py-2 text-right font-mono text-[11px] tabular-nums ${diff ? "bg-[#fef2f2] font-semibold text-[#991b1b]" : key === "total" ? "font-bold text-[#1a1a1a]" : side ? "text-[#3d3530]" : "text-[#b5a99a]"}`}>
                  {money(value)}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

const DECISIONS: [string, string][] = [["accept", "Accept"], ["book_it", "Book it"], ["chase_supplier", "Chase supplier"], ["hold", "Hold"], ["reject", "Reject"]];

function ItemDrawer({ item, run, scope, onClose, onSaved }: { item: GstItem | null; run: GstRun; scope: GstScopeInput; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setNote(""); setError(""); }, [item?.key]);

  async function decide(decision: string) {
    if (!item) return;
    setSaving(decision); setError("");
    try {
      await gstCall("POST", "/api/gst/decisions", scope, { itemKey: item.key, runId: run.run.id, decision, note });
      setNote(""); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the decision."); } finally { setSaving(""); }
  }

  if (!item) return null;
  const tone = toneOf(item.bucket);
  const claimed = item.books?.tax.total ?? 0;
  const available = item.g2b?.tax.total ?? 0;
  return (
    <Drawer open onClose={onClose} title={item.invoiceNo}
      subtitle={`${nameOf(item) || item.gstin} · ${item.invoiceDate}`}
      badges={<><Pill tone={tone}>{labelOf(run, item.bucket)}</Pill>{item.decision && <Pill>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</Pill>}</>}
      footer={(
        <div className="space-y-2.5">
          {error && <Alert tone="bad">{error}</Alert>}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Add a note for your team (optional)" className={`${inputCls} w-full`} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button className={btn} onClick={onClose}>Close</button>
            {DECISIONS.map(([id, label]) => (
              <button key={id} disabled={!!saving} onClick={() => decide(id)} className={id === "accept" ? btnPrimary : btn}>{saving === id ? "Saving…" : label}</button>
            ))}
          </div>
        </div>
      )}>
      <p className="text-[12.5px] leading-relaxed text-[#1a1a1a]">{item.reason}</p>
      {item.flags.includes("awaited") && <p className="mt-1.5 text-[11px] text-[#0369a1]">The supplier files quarterly, so this may still appear in a later GSTR-2B.</p>}
      <div className="my-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#5a5046]">
        <span>Claimed <b className="tabular-nums text-[#1a1a1a]">{inr(claimed)}</b></span>
        <span>In GSTR-2B <b className="tabular-nums text-[#1a1a1a]">{inr(available)}</b></span>
        {item.atRisk > 0 && <span>At risk <b className={`tabular-nums ${TONE_TEXT.bad}`}>{inr(item.atRisk)}</b></span>}
      </div>
      <CompareGrid item={item} />
      {item.decision && (
        <p className="mt-4 rounded-lg border border-[#ece6dc] bg-[#fbfaf8] px-3 py-2 text-[11.5px] text-[#5a5046]">
          <b>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</b> by {item.decision.decided_by_name ?? "someone"} · {ago(item.decision.decided_at)}
          {item.decision.note ? <span className="block pt-0.5 text-[#3d3530]">“{item.decision.note}”</span> : null}
        </p>
      )}
      <p className="mt-4 text-[10.5px] text-[#8a7f72]">{item.gstin} · {item.docType === "crn" ? "Credit note" : "Invoice"} · {periodLabel(item.period)}</p>
    </Drawer>
  );
}

// --------------------------------------------------------------------- table
const PAGE = 25;

function ItemTable({ run, items, scope, onChanged }: { run: GstRun; items: GstItem[]; scope: GstScopeInput; onChanged: () => void }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  useEffect(() => { setPage(1); }, [items.length]);
  const current = Math.min(page, pages);
  const visible = items.slice((current - 1) * PAGE, current * PAGE);
  const open = items.find((i) => i.key === openKey) ?? null;

  if (!items.length) return <Empty icon={<ClipboardCheck className="h-7 w-7" />} title="Nothing here" text="No invoices match this filter." />;
  return (
    <>
      <section className={`overflow-hidden rounded-xl border border-[#ded8d0] bg-white`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead><tr>
              <th className={th}>Supplier</th><th className={th}>Invoice</th><th className={th}>Month</th><th className={th}>Reason</th>
              <th className={`${th} text-right`}>ITC at risk</th><th className={th}>Decision</th>
            </tr></thead>
            <tbody>
              {visible.map((item) => {
                const tone = toneOf(item.bucket);
                return (
                  <tr key={item.key} onClick={() => setOpenKey(item.key)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setOpenKey(item.key); }}
                    className={`h-[52px] cursor-pointer border-b border-[#ece6dc] hover:bg-[rgba(237,230,217,0.42)] focus:bg-[rgba(237,230,217,0.42)] focus:outline-none ${TONE_EDGE[tone]}`}>
                    <td className={td}><span className="block max-w-[30ch] truncate text-[12.5px] font-medium text-[#1a1a1a]">{nameOf(item) || item.gstin}</span><span className="font-mono text-[10.5px] text-[#8a7f72]">{item.gstin}</span></td>
                    <td className={td}><span className="font-mono text-[11.5px] text-[#1a1a1a]">{item.invoiceNo}</span><span className="block text-[10.5px] text-[#8a7f72]">{item.invoiceDate}</span></td>
                    <td className={`${td} whitespace-nowrap`}>{item.period ? periodLabel(item.period) : "—"}</td>
                    <td className={td}><Pill tone={tone}>{labelOf(run, item.bucket)}</Pill>{item.flags.includes("awaited") && <span className="ml-1.5 text-[10.5px] text-[#8a7f72]">awaiting supplier</span>}</td>
                    <td className={`${td} text-right font-semibold tabular-nums ${item.atRisk ? TONE_TEXT.bad : "text-[#b5a99a]"}`}>{item.atRisk ? inr(item.atRisk) : "—"}</td>
                    <td className={td}>{item.decision ? <Pill>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</Pill> : <span className="text-[#b5a99a]">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[#ece6dc] bg-[#fbfaf8] px-3 py-2 text-[11px] font-semibold text-[#64748b]">
          <span>{(current - 1) * PAGE + 1}–{Math.min(current * PAGE, items.length)} of {items.length}</span>
          <span className="flex items-center gap-1.5">
            <button aria-label="Previous page" disabled={current <= 1} onClick={() => setPage(current - 1)} className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#ddd3c5] bg-white text-[#5a5046] hover:bg-[#f7f4ef] disabled:opacity-35"><ChevronLeft className="h-3.5 w-3.5" /></button>
            <span>Page {current} of {pages}</span>
            <button aria-label="Next page" disabled={current >= pages} onClick={() => setPage(current + 1)} className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#ddd3c5] bg-white text-[#5a5046] hover:bg-[#f7f4ef] disabled:opacity-35"><ChevronRight className="h-3.5 w-3.5" /></button>
          </span>
        </div>
      </section>
      <ItemDrawer item={open} run={run} scope={scope} onClose={() => setOpenKey(null)} onSaved={onChanged} />
    </>
  );
}

export function ReviewView({ run, scope, bucket, onBucket, onChanged, onRun }: {
  run: GstRun | null; scope: GstScopeInput; bucket: string; onBucket: (id: string) => void; onChanged: () => void; onRun: () => void;
}) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    if (!run) return [];
    const q = query.trim().toLowerCase();
    return run.items
      .filter((i) => (bucket === "all" || i.bucket === bucket) && (!q || i.gstin.toLowerCase().includes(q) || i.invoiceNo.toLowerCase().includes(q) || nameOf(i).toLowerCase().includes(q)))
      .sort((a, b) => b.atRisk - a.atRisk);
  }, [run, bucket, query]);
  if (!run) return <NoRun onRun={onRun} />;
  const chips = run.run.totals.buckets.filter((b) => b.count > 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => onBucket("all")} className={`rounded-full border px-3 py-1 text-[11.5px] font-semibold ${bucket === "all" ? "border-[#2d2d2d] bg-[#2d2d2d] text-white" : "border-[#ded8d0] bg-white text-[#5a5046] hover:bg-[#f7f4ef]"}`}>All {run.items.length}</button>
        {chips.map((b) => (
          <button key={b.id} onClick={() => onBucket(b.id)}
            className={`rounded-full border px-3 py-1 text-[11.5px] font-semibold ${bucket === b.id ? "border-[#2d2d2d] bg-[#2d2d2d] text-white" : `${TONE[toneOf(b.id)]} hover:brightness-95`}`}>{b.label} {b.count}</button>
        ))}
        <label className="relative ml-auto inline-flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[#8a7f72]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Supplier, GSTIN or invoice" className={`${inputCls} w-[260px] max-w-[46vw] pl-8`} />
        </label>
      </div>
      <ItemTable run={run} items={items} scope={scope} onChanged={onChanged} />
    </div>
  );
}

export function WorklistView({ run, scope, onChanged, onRun }: { run: GstRun | null; scope: GstScopeInput; onChanged: () => void; onRun: () => void }) {
  if (!run) return <NoRun onRun={onRun} />;
  const open = run.items.filter((i) => i.bucket !== "matched" && !["accept", "reject"].includes(i.decision?.decision ?? "")).sort((a, b) => b.atRisk - a.atRisk);
  const totalRisk = open.reduce((sum, i) => sum + i.atRisk, 0);
  return (
    <div className="space-y-3">
      <p className="text-xs text-[#5a5046]">
        <b className="text-[#1a1a1a]">{open.length} invoices</b> still need a decision, with <b className={TONE_TEXT.bad}>{inr(totalRisk)}</b> of ITC at risk. Accepted and rejected invoices drop off this list.
      </p>
      <ItemTable run={run} items={open} scope={scope} onChanged={onChanged} />
    </div>
  );
}

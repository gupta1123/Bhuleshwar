"use client";

import { useMemo, useState } from "react";
import {
  ago, BUCKET_STYLE, DECISION_LABEL, gstCall, inr, periodLabel,
  type GstItem, type GstRun, type GstScopeInput, type GstSide,
} from "@/lib/gst-client";

const card = "rounded-2xl border border-[#e5ddd0] bg-white p-5 shadow-sm";

function Empty({ text }: { text: string }) {
  return <div className={`${card} text-sm font-semibold text-slate-500`}>{text}</div>;
}

const labelOf = (run: GstRun, id: string) => run.run.totals.buckets.find((b) => b.id === id)?.label ?? id;

export function Freshness({ run }: { run: GstRun }) {
  const versions = Object.entries(run.run.dataVersions);
  const oldest = (prefix: string) => versions.filter(([k]) => k.startsWith(prefix)).map(([, v]) => v).sort()[0];
  return (
    <p className="text-[11px] font-semibold text-slate-500">
      Matched {ago(run.run.createdAt)} · Tally books as of {ago(run.run.booksAsOf)} · GSTR-2B as of {ago(oldest("gstr2b"))}
      {oldest("gstr2a") ? ` · GSTR-2A as of ${ago(oldest("gstr2a"))}` : ""}
    </p>
  );
}

export function OverviewView({ run, onOpen }: { run: GstRun | null; onOpen: () => void }) {
  if (!run) return <Empty text="No reconciliation yet. Choose the months above and press Reconcile." />;
  const { summary, buckets, movement, filed } = run.run.totals;
  const tiles: [string, unknown, string][] = [
    ["ITC claimed (books)", summary.claimed, "What your books say you can claim"],
    ["ITC available (GSTR-2B)", summary.available, "What suppliers' filings support"],
    ["Gap", summary.gap, "Claimed minus available"],
    ["At risk", summary.atRisk, "Claimed but not supported, or withdrawn"],
    ["Expiring within 6 months", summary.expiringSoon, "Claim deadline is close"],
    ["Waiting on suppliers", summary.awaitedTax, "Supplier's filing not due yet"],
  ];
  return (
    <div className="space-y-4">
      <Freshness run={run} />
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map(([label, value, hint]) => (
          <div key={label} className={card}>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
            <div className="mt-2 text-2xl font-black">{inr(value)}</div>
            <div className="mt-1 text-[11px] font-semibold text-slate-400">{hint}</div>
          </div>
        ))}
      </section>
      {movement.hasPrior && (
        <p className="text-xs font-semibold text-slate-600">
          Since last run: {movement.resolved} resolved · {movement.opened} new · {movement.stillOpen} still open · {movement.reopened} reopened
        </p>
      )}
      <section className={card}>
        <h3 className="text-sm font-extrabold">Where invoices stand</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {buckets.filter((b) => b.count > 0).map((b) => (
            <button key={b.id} onClick={onOpen} className={`rounded-full border px-3 py-1 text-xs font-bold ${BUCKET_STYLE[b.id] ?? ""}`}>{b.label}: {b.count}</button>
          ))}
        </div>
      </section>
      {filed.length > 0 && (
        <section className={`${card} overflow-x-auto`}>
          <h3 className="text-sm font-extrabold">GSTR-3B check</h3>
          <table className="mt-3 w-full min-w-[520px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-slate-400"><tr><th className="py-2">Month</th><th>Claimed in 3B</th><th>Per books</th><th>Difference</th></tr></thead>
            <tbody className="font-semibold">
              {filed.map((f) => (
                <tr key={f.period} className="border-t border-[#efe8dc]"><td className="py-2">{periodLabel(f.period)}</td><td>{inr(f.declaredIn3B)}</td><td>{inr(f.perBooks)}</td>
                  <td className={Math.abs(f.delta) > 1 ? "text-rose-700" : "text-emerald-700"}>{inr(f.delta)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function SideCard({ title, side }: { title: string; side: GstSide }) {
  return (
    <div className="rounded-xl border border-[#efe8dc] p-3 text-xs">
      <div className="font-extrabold">{title}</div>
      {side ? (
        <div className="mt-1 space-y-0.5 font-semibold text-slate-600">
          <div>Invoice {side.invoiceNo} · {side.invoiceDate}</div>
          <div>Taxable {inr(side.tax.taxable)}</div>
          <div>CGST {inr(side.tax.cgst)} · SGST {inr(side.tax.sgst)} · IGST {inr(side.tax.igst)}</div>
          <div className="font-extrabold text-[#1a1a1a]">Tax total {inr(side.tax.total)}</div>
        </div>
      ) : <div className="mt-1 font-semibold text-slate-400">Not present</div>}
    </div>
  );
}

const DECISIONS: [string, string][] = [["hold", "Hold"], ["chase_supplier", "Chase supplier"], ["accept", "Accept"], ["reject", "Reject"], ["book_it", "Book it"]];

function ItemDetail({ item, runId, scope, labels, onSaved }: { item: GstItem; runId: string; scope: GstScopeInput; labels: string; onSaved: () => void }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  async function decide(decision: string) {
    setSaving(decision); setError("");
    try {
      await gstCall("POST", "/api/gst/decisions", scope, { itemKey: item.key, runId, decision, note });
      setNote(""); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); } finally { setSaving(""); }
  }
  return (
    <div className="space-y-3 bg-[#fcfbfa] p-4">
      <p className="text-xs font-semibold"><span className="font-extrabold">Why “{labels}”: </span>{item.reason}</p>
      <div className="grid gap-3 md:grid-cols-3">
        <SideCard title="Your books (Tally)" side={item.books} />
        <SideCard title="GSTR-2B" side={item.g2b} />
        <SideCard title="GSTR-2A" side={item.g2a} />
      </div>
      {item.decision && (
        <p className="text-xs font-semibold text-slate-600">
          Last decision: <b>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</b> by {item.decision.decided_by_name ?? "someone"} · {ago(item.decision.decided_at)}
          {item.decision.note ? ` — ${item.decision.note}` : ""}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Add a note (optional)"
          className="h-9 min-w-[220px] flex-1 rounded-lg border border-[#e5ddd0] bg-white px-3 text-xs" />
        {DECISIONS.map(([id, label]) => (
          <button key={id} disabled={!!saving} onClick={() => decide(id)}
            className="h-9 rounded-lg border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-slate-700 hover:bg-[#faf8f4] disabled:opacity-50">{saving === id ? "Saving…" : label}</button>
        ))}
      </div>
      {error && <p className="text-xs font-semibold text-rose-700">{error}</p>}
    </div>
  );
}

function ItemTable({ run, items, scope, onChanged }: { run: GstRun; items: GstItem[]; scope: GstScopeInput; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <Empty text="Nothing to show here." />;
  return (
    <section className="overflow-x-auto rounded-2xl border border-[#e5ddd0] bg-white shadow-sm">
      <table className="w-full min-w-[820px] text-left text-xs">
        <thead className="bg-[#fcfbfa] text-[10px] font-bold uppercase tracking-wider text-slate-400">
          <tr><th className="px-4 py-3">Supplier</th><th>Invoice</th><th>Month</th><th>Status</th><th className="text-right">ITC at risk</th><th className="pr-4">Decision</th></tr>
        </thead>
        <tbody className="font-semibold">
          {items.slice(0, 500).map((item) => {
            const label = labelOf(run, item.bucket);
            const name = (item.books ?? item.g2b ?? item.g2a)?.supplierName ?? "";
            return (
              <FragmentRow key={item.key} open={open === item.key} onToggle={() => setOpen(open === item.key ? null : item.key)}
                cells={(
                  <>
                    <td className="px-4 py-3"><div className="font-extrabold">{item.gstin}</div><div className="text-slate-400">{name}</div></td>
                    <td>{item.invoiceNo}<div className="text-slate-400">{item.invoiceDate}</div></td>
                    <td>{item.period ? periodLabel(item.period) : "-"}</td>
                    <td><span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${BUCKET_STYLE[item.bucket] ?? ""}`}>{label}</span>
                      {item.flags.includes("awaited") && <span className="ml-1 text-[10px] text-slate-400">awaiting supplier</span>}</td>
                    <td className="text-right">{item.atRisk ? inr(item.atRisk) : "-"}</td>
                    <td className="pr-4 text-slate-500">{item.decision ? DECISION_LABEL[item.decision.decision] : "-"}</td>
                  </>
                )}
                detail={<ItemDetail item={item} runId={run.run.id} scope={scope} labels={label} onSaved={onChanged} />} />
            );
          })}
        </tbody>
      </table>
      {items.length > 500 && <p className="px-4 py-3 text-xs font-semibold text-slate-400">Showing the first 500 of {items.length}. Use the filters to narrow down.</p>}
    </section>
  );
}

function FragmentRow({ cells, detail, open, onToggle }: { cells: React.ReactNode; detail: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-t border-[#efe8dc] hover:bg-[#fcfbfa]">{cells}</tr>
      {open && <tr><td colSpan={6} className="border-t border-[#efe8dc] p-0">{detail}</td></tr>}
    </>
  );
}

export function ReviewView({ run, scope, onChanged }: { run: GstRun | null; scope: GstScopeInput; onChanged: () => void }) {
  const [bucket, setBucket] = useState("all");
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    if (!run) return [];
    const q = query.trim().toLowerCase();
    return run.items.filter((i) => (bucket === "all" || i.bucket === bucket) && (!q || i.gstin.toLowerCase().includes(q) || i.invoiceNo.toLowerCase().includes(q)))
      .sort((a, b) => b.atRisk - a.atRisk);
  }, [run, bucket, query]);
  if (!run) return <Empty text="No reconciliation yet. Press Reconcile above." />;
  return (
    <div className="space-y-3">
      <Freshness run={run} />
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setBucket("all")} className={`rounded-full border px-3 py-1 text-xs font-bold ${bucket === "all" ? "bg-[#2d2d2d] text-white" : "bg-white"}`}>All {run.items.length}</button>
        {run.run.totals.buckets.filter((b) => b.count > 0).map((b) => (
          <button key={b.id} onClick={() => setBucket(b.id)} className={`rounded-full border px-3 py-1 text-xs font-bold ${bucket === b.id ? "bg-[#2d2d2d] text-white" : BUCKET_STYLE[b.id]}`}>{b.label} {b.count}</button>
        ))}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search GSTIN or invoice"
          className="ml-auto h-9 w-56 rounded-lg border border-[#e5ddd0] bg-white px-3 text-xs" />
      </div>
      <ItemTable run={run} items={items} scope={scope} onChanged={onChanged} />
    </div>
  );
}

export function WorklistView({ run, scope, onChanged }: { run: GstRun | null; scope: GstScopeInput; onChanged: () => void }) {
  if (!run) return <Empty text="No reconciliation yet. Press Reconcile above." />;
  const open = run.items.filter((i) => i.bucket !== "matched" && !["accept", "reject"].includes(i.decision?.decision ?? "")).sort((a, b) => b.atRisk - a.atRisk);
  const totalRisk = open.reduce((sum, i) => sum + i.atRisk, 0);
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-600">{open.length} invoices still need a decision · {inr(totalRisk)} of ITC at risk. Accepted and rejected items drop off this list.</p>
      <ItemTable run={run} items={open} scope={scope} onChanged={onChanged} />
    </div>
  );
}

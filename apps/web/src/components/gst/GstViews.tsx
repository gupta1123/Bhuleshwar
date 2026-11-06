"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Check, ChevronLeft, ChevronRight, ClipboardCheck, Copy, Scale, Search } from "lucide-react";
import {
  ago, DECISION_LABEL, gstCall, inr, periodLabel,
  type GstItem, type GstRun, type GstScopeInput, type GstSide,
} from "@/lib/gst-client";
import { Alert, btn, btnPrimary, card, Drawer, Empty, inputCls, Panel, Pill, td, th, TONE_BAR, TONE_TEXT, toneOf, type Tone } from "./gst-ui";

// Show-and-highlight only for now. Set to true to bring back everything that records a decision
// or drafts a message: Mark chased / Accept, Accept all, the drawer's decision buttons and note,
// and Copy reminder. Viewing (rows, drawer, previous/next, saved decisions) is unaffected.
const ACTIONS_ENABLED = false;

const labelOf = (run: GstRun, id: string) => run.run.totals.buckets.find((b) => b.id === id)?.label ?? id;
const nameOf = (item: GstItem) => (item.books ?? item.g2b ?? item.g2a)?.supplierName ?? "";
const num = (value: unknown) => Number(value) || 0;
// One money format everywhere on the page: whole rupees, Indian grouping.
const rs = (value: unknown) => inr(Math.round(num(value)));

// What the person has to do, not what the matcher called it.
type Group = { id: string; label: string; hint: string; buckets: string[]; tone: Tone; dot: string };
const GROUPS: Group[] = [
  { id: "g:chase", label: "Chase supplier", hint: "In your books, but the supplier has not reported it", buckets: ["booksOnly", "rule37A"], tone: "bad", dot: "#dd9a95" },
  { id: "g:books", label: "Fix our books", hint: "Blocked credit, duplicates, or no voucher in Tally", buckets: ["ineligible", "duplicate", "portalOnly", "reopened"], tone: "info", dot: "#8fc0e0" },
  { id: "g:amounts", label: "Amounts differ", hint: "On both sides, but the tax values disagree", buckets: ["valueDiff"], tone: "warn", dot: "#e3b667" },
  { id: "g:timing", label: "Different month", hint: "The supplier reported it in another month", buckets: ["periodShift"], tone: "stone", dot: "#b8ac9a" },
];
const groupOf = (bucket: string) => GROUPS.find((g) => g.buckets.includes(bucket));
const isDecided = (item: GstItem) => ["accept", "reject"].includes(item.decision?.decision ?? "");
const MINOR = 500; // below this, a difference is rounding noise, not a task
const HIGH = 10000;

function explain(item: GstItem) {
  const taxOf = (side: GstSide) => (side ? side.tax.cgst + side.tax.sgst + side.tax.igst + side.tax.cess : undefined);
  const books = taxOf(item.books);
  const portal = taxOf(item.g2b);
  const note = item.docType === "crn" ? "credit note" : item.docType === "dbn" ? "debit note" : "invoice";
  if (item.docType === "imp") return item.bucket === "matched" ? "Import bill of entry. The IGST you paid at customs agrees with GSTR-2B." : "Import bill of entry on the portal with no matching entry in Tally. Book it to claim the IGST paid at customs.";
  if (item.docType === "isd") return "Credit passed on by your head office (Input Service Distributor). It is claimed through the ISD return, not as a purchase, so there is nothing to match in Tally.";
  if (item.flags.includes("ims_rejected")) return "You rejected this invoice in the portal's Invoice Management System, so it is left out of GSTR-2B. The credit is not available unless the supplier re-issues it.";
  if (item.bucket === "reopened") return "This credit was supported by an earlier GSTR-2B, but the supplier has since changed or withdrawn the invoice. Check it and reverse the credit if it no longer stands.";
  if (item.flags.includes("awaited")) return "The supplier files quarterly, so this may still appear in a later GSTR-2B. Nothing to do yet.";
  if (item.flags.includes("rcm")) return "Reverse charge: you pay this tax yourself and then claim it back. It does not depend on what the supplier files.";
  if (item.flags.includes("fuzzy")) return "Linked automatically because the invoice numbers are almost the same (for example a typo). Check the two numbers and confirm.";
  if (item.bucket === "valueDiff" && books !== undefined && portal !== undefined) {
    const gap = Math.abs(books - portal);
    return `Supplier filed ${rs(portal)} of tax on this ${note}, your books say ${rs(books)}. ${rs(gap)} ${books > portal ? "more in your books." : "less in your books."}`;
  }
  if (item.docType === "crn" || item.docType === "dbn") {
    if (item.bucket === "booksOnly") return `A ${note} is in your Tally books but the supplier has not reported it in GSTR-2B.`;
    if (item.bucket === "matched") return `The ${note} agrees with GSTR-2B.`;
  }
  if (item.bucket === "ineligible" && /place of supply/i.test(item.reason)) return "The supplier charged tax for a different state than yours, so the credit is blocked. Ask them to correct the invoice.";
  if (item.bucket === "ineligible" && /non-filer|inactive/i.test(item.reason)) return "The supplier is a non-filer or their registration is inactive, so the credit is blocked.";
  if (item.bucket === "booksOnly") return "In your Tally books, but the supplier has not reported it in GSTR-2B.";
  if (item.bucket === "portalOnly") return "The supplier reported it, but there is no purchase voucher in Tally.";
  if (item.bucket === "rule37A") return "Supplier has not filed. Credit may need reversing if it stays unpaid or unreported.";
  if (item.bucket === "periodShift") return item.g2b?.invoiceDate ? `Matches, but the supplier reported it in ${periodLabel(item.g2b.invoiceDate.slice(0, 7))}. Claim it in that month's return.` : "Matches, but the supplier reported it in a different month.";
  if (item.bucket === "duplicate") return `The same supplier invoice is booked more than once${item.books?.voucherNumber?.includes(",") ? ` (${item.books.voucherNumber})` : ""}. Cancel the extra voucher so the credit is not claimed twice.`;
  if (item.bucket === "ineligible") return "Credit on this purchase is blocked.";
  return item.reason;
}

function Freshness({ run }: { run: GstRun }) {
  const versions = Object.entries(run.run.dataVersions);
  const oldest = (prefix: string) => versions.filter(([k]) => k.startsWith(prefix)).map(([, v]) => v).sort()[0];
  const parts = [`Matched ${ago(run.run.createdAt)}`, `Tally books as of ${ago(run.run.booksAsOf)}`];
  if (oldest("gstr2b")) parts.push(`GSTR-2B as of ${ago(oldest("gstr2b"))}`);
  if (oldest("gstr2a")) parts.push(`GSTR-2A as of ${ago(oldest("gstr2a"))}`);
  return <p className="text-[12px] text-[#6b6157]">{parts.join(" · ")}</p>;
}

function NoRun({ onRun }: { onRun?: () => void }) {
  return (
    <Empty
      icon={<Scale className="h-7 w-7" />}
      title="Nothing reconciled yet"
      text="Choose the months above, then run. Bhuleshwar reads your purchase books from Tally and checks every invoice against what your suppliers filed."
      action={onRun ? <button onClick={onRun} className={btnPrimary}>Run reconciliation</button> : undefined}
    />
  );
}

function reminderText(all: GstItem[], gstin: string, name: string) {
  const rows = all.filter((i) => i.gstin === gstin && groupOf(i.bucket)?.id === "g:chase" && !isDecided(i));
  const lines = rows.map((i) => `- ${i.invoiceNo} dated ${i.invoiceDate}, GST ${rs(i.books ? i.books.tax.cgst + i.books.tax.sgst + i.books.tax.igst + i.books.tax.cess : i.atRisk)}`);
  return [
    `Hello ${name || gstin},`, "",
    "These invoices are in our purchase books, but they are not showing in our GSTR-2B. Please check that they are filed in your GSTR-1:", "",
    ...lines, "", "Thank you.",
  ].join("\n");
}

// ------------------------------------------------------------------ overview
export function scopeRun(run: GstRun, months: string[]): GstRun {
  const on = months.filter((p) => run.run.periods.includes(p));
  if (!on.length || on.length === run.run.periods.length) return run;
  const items = run.items.filter((i) => on.includes(i.period));
  const taxOf = (i: GstItem) => (i.books ? i.books.tax.cgst + i.books.tax.sgst + i.books.tax.igst + i.books.tax.cess : 0);
  const availOf = (i: GstItem) => (i.g2b ? i.g2b.tax.cgst + i.g2b.tax.sgst + i.g2b.tax.igst + i.g2b.tax.cess : 0);
  const sum = (f: (i: GstItem) => number) => Math.round(items.reduce((s, i) => s + f(i), 0));
  const claimed = sum(taxOf);
  const available = sum(availOf);
  const t = run.run.totals;
  const suppliers = t.suppliers.map((s) => {
    const mine = items.filter((i) => i.gstin === s.gstin);
    return { ...s, invoices: mine.length, exceptions: mine.filter((i) => i.bucket !== "matched").length,
      claimed: Math.round(mine.reduce((a, i) => a + taxOf(i), 0)), available: Math.round(mine.reduce((a, i) => a + availOf(i), 0)),
      atRisk: Math.round(mine.reduce((a, i) => a + i.atRisk, 0)) };
  }).filter((s) => s.invoices > 0);
  return {
    ...run, items,
    run: { ...run.run, periods: [...on].sort(), totals: { ...t,
      summary: { ...t.summary, claimed, available, gap: Math.max(0, claimed - available), atRisk: sum((i) => i.atRisk), awaitedTax: sum((i) => (i.flags.includes("awaited") ? i.atRisk : 0)), expiringSoon: 0 },
      buckets: t.buckets.map((b) => ({ ...b, count: items.filter((i) => i.bucket === b.id).length })).filter((b) => b.count > 0),
      filed: t.filed.filter((f) => on.includes(f.period)), suppliers } },
  };
}

export function OverviewView({ run, full, all, months, onMonths, onOpen, onRun }: { run: GstRun | null; full: GstRun | null; all: GstRun | null; months: string[]; onMonths: (m: string[]) => void; onOpen: (bucket?: string) => void; onRun: () => void }) {
  const [copied, setCopied] = useState("");
  if (!run || !full || !all) return <NoRun onRun={onRun} />;
  const { summary, movement, filed } = run.run.totals;
  const items = run.items;
  const filtered = run.run.periods.length < full.run.periods.length;
  const active = filtered ? run.run.periods : [];
  const claimed = num(summary.claimed);
  const atRisk = num(summary.atRisk);
  const safe = Math.max(0, claimed - atRisk);
  const open = items.filter((i) => i.bucket !== "matched" && !isDecided(i)).length;
  const at = "";
  const toggleMonth = (p: string) => onMonths(months.includes(p) ? months.filter((x) => x !== p) : [...months, p]);

  const steps = GROUPS.map((g) => {
    const rows = items.filter((i) => g.buckets.includes(i.bucket));
    return { ...g, count: rows.length, amount: rows.reduce((s, i) => s + i.atRisk, 0) };
  }).filter((g) => g.count > 0);
  const other = Math.max(0, atRisk - steps.reduce((s, g) => s + g.amount, 0));
  const denom = Math.max(1, claimed, safe + atRisk);
  const off3B = filed.filter((f) => Math.abs(f.delta) > 1);
  const worst = Array.from(items.filter((i) => groupOf(i.bucket)?.id === "g:chase" && !isDecided(i)).reduce((m, i) => {
    const cur = m.get(i.gstin) ?? { gstin: i.gstin, name: nameOf(i), atRisk: 0, exceptions: 0 };
    cur.atRisk += i.atRisk; cur.exceptions += 1;
    return m.set(i.gstin, cur);
  }, new Map<string, { gstin: string; name: string; atRisk: number; exceptions: number }>()).values()).sort((a, b) => b.atRisk - a.atRisk).slice(0, 6);
  const shownPeriods = filtered ? [...active].sort() : run.run.periods;
  const periods = shownPeriods.length > 3 ? `${periodLabel(shownPeriods[0])} to ${periodLabel(shownPeriods[shownPeriods.length - 1])}` : shownPeriods.map(periodLabel).join(", ");
  const deadlineOf = (period: string) => {
    const [y, m] = period.split("-").map(Number);
    const endYear = m >= 4 ? y + 1 : y;
    return { fy: `FY ${endYear - 1}-${String(endYear).slice(2)}`, at: new Date(endYear, 10, 30, 23, 59) };
  };
  const rowsOf = (src: GstRun) => src.run.periods.map((period) => {
    const rows = src.items.filter((i) => i.period === period && i.bucket !== "matched" && !isDecided(i));
    const d = deadlineOf(period);
    const days = Math.ceil((d.at.getTime() - Date.now()) / 86_400_000);
    return { period, count: rows.length, amount: rows.reduce((s, i) => s + i.atRisk, 0), days, fy: d.fy, urgent: rows.length && days >= 0 && days <= 60 ? d.at.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "" };
  }).sort((a, b) => (a.period < b.period ? -1 : 1));
  const monthRows = rowsOf(full);
  const urgentRows = rowsOf(all).filter((m) => m.urgent && m.amount > 0);
  const deadline = urgentRows.length
    ? { amount: urgentRows.reduce((s, m) => s + m.amount, 0), fy: urgentRows[0].fy, days: urgentRows[0].days, date: deadlineOf(urgentRows[0].period).at.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) }
    : null;

  async function copy(gstin: string, name: string) {
    try {
      await navigator.clipboard.writeText(reminderText(items, gstin, name));
      setCopied(gstin);
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(""), 2200);
  }

  return (
    <div className="space-y-4">
      <section className={`${card} p-5 sm:p-6`}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium text-[#6b6157]">Safe to claim · {periods}</p>
            <p className="mt-1.5 text-[42px] font-bold leading-none tracking-tight tabular-nums text-[#1a1a1a]">{rs(safe)}</p>
            <p className="mt-2.5 max-w-[60ch] text-[13.5px] leading-relaxed text-[#5a5046]">
              of {rs(claimed)} claimed{atRisk > 0 ? <> · <b className="text-[#991b1b]">{rs(atRisk)}</b> held up</> : " · all supported by supplier filings"}
            </p>
          </div>
          {open > 0 && (
            <button onClick={() => onOpen("needs" + at)} className={`${btnPrimary} min-h-10 px-4 text-[13px]`}>
              Work through {open} invoice{open === 1 ? "" : "s"}<ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="mt-5 flex h-3 overflow-hidden rounded-full bg-[#efe9df]" role="img" aria-label="Where the claimed credit stands">
          <i className={`block h-full ${TONE_BAR.ok}`} style={{ width: `${(safe / denom) * 100}%` }} />
          {steps.map((g) => <i key={g.id} className="block h-full" style={{ width: `${(g.amount / denom) * 100}%`, background: g.dot }} />)}
          {other > 0 && <i className="block h-full bg-[#cfc6b8]" style={{ width: `${(other / denom) * 100}%` }} />}
        </div>

        <ul className="mt-4 divide-y divide-[#ece6dc]">
          {steps.map((g) => (
            <li key={g.id}>
              <button onClick={() => onOpen(g.id + at)} className="grid w-full grid-cols-[14px_1fr_auto_16px] items-center gap-3 rounded-md py-2.5 text-left hover:bg-[#f7f4ef]">
                <i className="h-2.5 w-2.5 rounded-full" style={{ background: g.dot }} />
                <span className="text-[13px] text-[#1a1a1a]"><b>{g.label}</b></span>
                <span className="text-right text-[13px] tabular-nums"><span className="mr-3 text-[12px] text-[#6b6157]">{g.count} invoice{g.count === 1 ? "" : "s"}</span><b className={g.amount >= HIGH ? "text-[#991b1b]" : "text-[#3d3530]"}>{g.amount > 0 ? rs(g.amount) : "No credit impact"}</b></span>
                <ArrowRight className="h-3.5 w-3.5 text-[#b5a99a]" />
              </button>
            </li>
          ))}
          {Math.round(other) > 0 && (
            <li className="grid grid-cols-[14px_1fr_auto] items-center gap-3 py-2.5">
              <i className="h-2.5 w-2.5 rounded-full bg-[#cfc6b8]" />
              <span className="text-[13px] text-[#1a1a1a]"><b>Other</b></span>
              <span className="text-[13px] font-semibold tabular-nums text-[#3d3530]">{rs(other)}</span>
            </li>
          )}
        </ul>

        {!filtered && num(summary.expiringSoon) > 0 && (
          <p className="mt-3 border-t border-[#ece6dc] pt-3 text-[12.5px] text-[#78350f]"><b>{rs(summary.expiringSoon)}</b> of this credit lapses within 6 months if not claimed.</p>
        )}
      </section>

      {deadline && (
        <Alert tone="warn">
          <span className="flex items-start gap-2.5 text-[12.5px]"><AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
            <span><b>{rs(deadline.amount)} of {deadline.fy} credit is still held up. The last day to claim it is {deadline.date}, {deadline.days} day{deadline.days === 1 ? "" : "s"} from now.</b></span></span>
        </Alert>
      )}

      {monthRows.length > 1 && (
        <Panel title="Open by month">
          <ul className="divide-y divide-[#ece6dc]">
            {monthRows.map((m) => (
              <li key={m.period}>
                <button onClick={() => toggleMonth(m.period)} className={`grid w-full grid-cols-[1fr_auto_auto_16px] items-center gap-4 rounded-md py-2.5 text-left hover:bg-[#f7f4ef] ${active.includes(m.period) ? "bg-[#f1ece3]" : ""}`}>
                  <span className="text-[13px] font-medium text-[#1a1a1a]">{periodLabel(m.period)}{m.urgent && <span className="ml-2 rounded-full bg-[#fef3c7] px-2 py-px text-[11.5px] font-semibold text-[#78350f]">closes {m.urgent}</span>}</span>
                  <span className="text-[12px] text-[#6b6157]">{m.count ? `${m.count} open` : "All done"}</span>
                  <b className={`w-24 text-right text-[13px] tabular-nums ${m.amount >= HIGH ? "text-[#991b1b]" : "text-[#3d3530]"}`}>{m.amount ? rs(m.amount) : "—"}</b>
                  <ArrowRight className="h-3.5 w-3.5 text-[#b5a99a]" />
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {off3B.length > 0 && (
        <Alert tone="warn">
          <span className="flex items-start gap-2.5 text-[12.5px]"><AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
            <span><b>{off3B.length === 1 ? `GSTR-3B for ${periodLabel(off3B[0].period)} differs from your books by ${rs(Math.abs(off3B[0].delta))}.` : `GSTR-3B differs from your books in ${off3B.length} months, by ${rs(off3B.reduce((s, f) => s + Math.abs(f.delta), 0))} in total.`}</b></span></span>
        </Alert>
      )}

      <Panel title="Suppliers to chase" >
        {worst.length === 0 ? <p className="py-6 text-center text-[13px] text-[#6b6157]">No supplier needs chasing.</p> : (
          <ul className="divide-y divide-[#ece6dc]">
            {worst.map((s) => {
              const chaseable = items.some((i) => i.gstin === s.gstin && groupOf(i.bucket)?.id === "g:chase" && !isDecided(i));
              return (
                <li key={s.gstin} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 py-2.5">
                  <div className="min-w-0">
                    <span className="block truncate text-[13.5px] font-medium text-[#1a1a1a]">{s.name || s.gstin}</span>
                    <span className="text-[11.5px] text-[#6b6157]" title={s.gstin}>{s.exceptions} invoice{s.exceptions === 1 ? "" : "s"} not reported</span>
                  </div>
                  <span className={`text-[13.5px] font-semibold tabular-nums ${s.atRisk >= HIGH ? "text-[#991b1b]" : "text-[#3d3530]"}`}>{rs(s.atRisk)}</span>
                  {chaseable && ACTIONS_ENABLED
                    ? <button onClick={() => copy(s.gstin, s.name)} className={btn}>{copied === s.gstin ? <><Check className="h-3 w-3" />Copied</> : copied === "failed" ? "Copy failed" : <><Copy className="h-3 w-3" />Copy reminder</>}</button>
                    : <span className="w-[112px]" />}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <div className="space-y-1">
        {movement.hasPrior && (
          <p className="text-[12px] text-[#6b6157]"><b className="text-[#065f46]">{movement.resolved} resolved</b> · {movement.opened} new since last run</p>
        )}
        <Freshness run={run} />
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
      <div className="grid grid-cols-[120px_repeat(3,minmax(0,1fr))] bg-[#f7f4ef] text-[11px] font-bold uppercase tracking-[0.06em] text-[#3d3530]">
        <div className="border-b border-[#e0d8cc] px-3 py-2" />
        {cols.map(([name, side]) => (
          <div key={name} className={`border-b border-l border-[#e0d8cc] px-3 py-2 ${side ? "" : "text-[#b5a99a]"}`}>{side ? name : `${name} — missing`}</div>
        ))}
      </div>
      <div className="grid grid-cols-[120px_repeat(3,minmax(0,1fr))] border-b border-[#ece6dc] text-[11.5px]">
        <div className="px-3 py-2 text-[#756b60]">Invoice</div>
        {cols.map(([name, side]) => (
          <div key={name} className="px-3 py-2 font-mono text-[12px] text-[#3d3530]">{side ? <>{side.invoiceNo}<div className="text-[11px] text-[#6b6157]">{side.invoiceDate}</div>{name === "Books" && side.voucherNumber && <div className="text-[11px] text-[#6b6157]">{side.voucherNumber}</div>}</> : <span className="text-[#b5a99a]">—</span>}</div>
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
                <div key={name} className={`px-3 py-2 text-right font-mono text-[12px] tabular-nums ${diff ? "bg-[#fef2f2] font-semibold text-[#991b1b]" : key === "total" ? "font-bold text-[#1a1a1a]" : side ? "text-[#3d3530]" : "text-[#b5a99a]"}`}>
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

// The saved decision ids are fixed by the API. Only the wording changes with the situation.
function actionsFor(item: GstItem): { lead: string; ordered: [string, string][]; result: string } {
  const D = (id: string, label: string): [string, string] => [id, label];
  if (item.docType === "isd") return { lead: "accept", ordered: [D("accept", "Got it"), D("hold", "Hold")], result: "Records that you have seen this. Claim it in your ISD return." };
  if (item.docType === "imp" || (item.bucket === "portalOnly" && !item.flags.includes("rcm"))) return { lead: "book_it", ordered: [D("book_it", "Book it"), D("hold", "Hold"), D("accept", "Accept")], result: "Marks this to be booked in Tally so the credit can be claimed." };
  if (item.bucket === "duplicate") return { lead: "reject", ordered: [D("reject", "Cancel extra voucher"), D("hold", "Hold"), D("accept", "Not a duplicate")], result: "Marks the extra voucher for cancelling in Tally, so the credit is claimed once." };
  if (item.bucket === "ineligible" || item.bucket === "reopened") return { lead: "reject", ordered: [D("reject", "Reverse credit"), D("hold", "Hold"), D("accept", "Credit is valid")], result: "Marks this credit to be reversed in your GSTR-3B." };
  if (item.flags.includes("awaited")) return { lead: "hold", ordered: [D("hold", "Wait"), D("chase_supplier", "Chase anyway"), D("accept", "Accept")], result: "Keeps it on hold until the supplier's quarterly filing is due." };
  if (item.bucket === "booksOnly" || item.bucket === "rule37A") return { lead: "chase_supplier", ordered: [D("chase_supplier", "Chase supplier"), D("hold", "Hold"), D("accept", "Accept")], result: "Marks the supplier as chased. Reverse the credit if they do not file in time." };
  if (item.bucket === "valueDiff") return { lead: "accept", ordered: [D("accept", "Accept difference"), D("chase_supplier", "Ask supplier to correct"), D("hold", "Hold")], result: "Accepting means you claim the amount in your books as it is." };
  if (item.bucket === "periodShift") return { lead: "accept", ordered: [D("accept", "Accept"), D("hold", "Hold")], result: "Records that you have checked the month." };
  return { lead: "accept", ordered: [D("accept", "Accept"), D("hold", "Hold"), D("reject", "Reject")], result: "Saves your decision for the team." };
}

function ItemDrawer({ item, run, scope, onClose, onSaved, onStep }: { item: GstItem | null; run: GstRun; scope: GstScopeInput; onClose: () => void; onSaved: () => void; onStep?: { go: (d: -1 | 1) => void; hasPrev: boolean; hasNext: boolean } }) {
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
  const gst = (t?: { cgst: number; sgst: number; igst: number; cess: number }) => (t ? t.cgst + t.sgst + t.igst + t.cess : 0);
  const claimed = gst(item.books?.tax);
  const available = gst(item.g2b?.tax);
  const { lead, ordered, result } = actionsFor(item);
  const fyEnd = Number(item.period.slice(0, 4)) + (Number(item.period.slice(5)) >= 4 ? 1 : 0);
  const lastDay = `30 Nov ${fyEnd}`;
  const showDeadline = item.atRisk > 0 && ["booksOnly", "rule37A", "valueDiff", "portalOnly"].includes(item.bucket);
  const notUsable = item.bucket === "ineligible" || item.bucket === "reopened";
  return (
    <Drawer open onClose={onClose} title={item.invoiceNo}
      subtitle={`${nameOf(item) || item.gstin} · ${item.invoiceDate}`}
      badges={<><Pill tone={tone}>{labelOf(run, item.bucket)}</Pill>{item.decision && <Pill>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</Pill>}</>}
      footer={(
        <div className="space-y-2.5">
          {error && <Alert tone="bad">{error}</Alert>}
          {ACTIONS_ENABLED && <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Add a note for your team (optional)" className={`${inputCls} w-full`} />}
          {ACTIONS_ENABLED && <p className="text-[11.5px] text-[#6b6157]">{result}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex gap-1">
              {onStep && <><button aria-label="Previous invoice" disabled={!onStep.hasPrev} onClick={() => onStep.go(-1)} className={`${btn} px-2`}><ChevronLeft className="h-3.5 w-3.5" /></button>
              <button aria-label="Next invoice" disabled={!onStep.hasNext} onClick={() => onStep.go(1)} className={`${btn} px-2`}><ChevronRight className="h-3.5 w-3.5" /></button></>}
            </span>
            <span className="flex flex-wrap items-center justify-end gap-2">
              {ACTIONS_ENABLED && ordered.map(([id, label]) => (
                <button key={id} disabled={!!saving} onClick={() => decide(id)} className={id === lead ? btnPrimary : btn}>{saving === id ? "Saving…" : label}</button>
              ))}
            </span>
          </div>
        </div>
      )}>
      <p className="text-[12.5px] leading-relaxed text-[#1a1a1a]">{explain(item)}</p>
      <div className="my-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#5a5046]">
        <span>Claimed <b className="tabular-nums text-[#1a1a1a]">{inr(claimed)}</b>{item.bucket === "duplicate" && <b className={`ml-1 ${TONE_TEXT.bad}`}>(booked twice)</b>}</span>
        {notUsable
          ? <span>Credit you can use <b className={`tabular-nums ${TONE_TEXT.bad}`}>{inr(0)}</b></span>
          : <span>In GSTR-2B <b className="tabular-nums text-[#1a1a1a]">{inr(available)}</b></span>}
        {item.atRisk > 0 && <span>At risk <b className={`tabular-nums ${TONE_TEXT.bad}`}>{inr(item.atRisk)}</b></span>}
        {showDeadline && <span>Claim by <b className="text-[#1a1a1a]">{lastDay}</b> at the latest</span>}
      </div>
      <CompareGrid item={item} />
      {item.decision && (
        <p className="mt-4 rounded-lg border border-[#ece6dc] bg-[#fbfaf8] px-3 py-2 text-[11.5px] text-[#5a5046]">
          <b>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</b> by {item.decision.decided_by_name ?? "someone"} · {ago(item.decision.decided_at)}
          {item.decision.note ? <span className="block pt-0.5 text-[#3d3530]">“{item.decision.note}”</span> : null}
        </p>
      )}
      <p className="mt-4 text-[12px] text-[#5a5046]">{item.gstin && <button type="button" title="Copy GSTIN" onClick={() => { try { void navigator.clipboard.writeText(item.gstin); } catch { /* ignore */ } }} className="mr-1 font-mono text-[#3d3530] underline decoration-dotted">{item.gstin}</button>}{item.gstin ? " · " : "No GSTIN · "}{({ crn: "Credit note", dbn: "Debit note", imp: "Import (bill of entry)", isd: "ISD credit" } as Record<string, string>)[item.docType] ?? "Invoice"}{item.flags.includes("rcm") ? " · Reverse charge" : ""}{item.flags.includes("amended") ? " · Amended by supplier" : ""} · {periodLabel(item.period)}</p>
    </Drawer>
  );
}

// --------------------------------------------------------------------- table
const PAGE = 25;

const decide = (scope: GstScopeInput, run: GstRun, item: GstItem, decision: string) =>
  gstCall("POST", "/api/gst/decisions", scope, { itemKey: item.key, runId: run.run.id, decision, note: "" });

function ItemTable({ run, items, scope, onChanged }: { run: GstRun; items: GstItem[]; scope: GstScopeInput; onChanged: () => void }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [busyKey, setBusyKey] = useState("");
  const [bulk, setBulk] = useState(false);
  const [error, setError] = useState("");
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  useEffect(() => { setPage(1); }, [items.length]);
  const current = Math.min(page, pages);
  const visible = items.slice((current - 1) * PAGE, current * PAGE);
  const open = items.find((i) => i.key === openKey) ?? null;
  const widest = Math.max(1, ...items.map((i) => i.atRisk));
  const groupTotals = useMemo(() => {
    const out = new Map<string, { count: number; amount: number }>();
    for (const item of items) {
      const id = groupOf(item.bucket)?.id ?? "matched";
      const cur = out.get(id) ?? { count: 0, amount: 0 };
      out.set(id, { count: cur.count + 1, amount: cur.amount + item.atRisk });
    }
    return out;
  }, [items]);
  const minor = items.filter((i) => i.bucket === "valueDiff" && i.atRisk < MINOR && !i.decision);

  async function quick(item: GstItem, decision: string) {
    setBusyKey(item.key); setError("");
    try { await decide(scope, run, item, decision); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); } finally { setBusyKey(""); }
  }
  async function acceptMinor() {
    setBulk(true); setError("");
    try {
      for (let i = 0; i < minor.length; i += 5) await Promise.all(minor.slice(i, i + 5).map((item) => decide(scope, run, item, "accept")));
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); } finally { setBulk(false); }
  }

  if (!items.length) return <Empty icon={<ClipboardCheck className="h-7 w-7" />} title="Nothing here" text="No invoices match this filter." />;
  let lastGroup = "";
  return (
    <>
      {minor.length >= 2 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#fde68a] bg-[#fffbeb] px-4 py-3 text-[13px] text-[#78350f]">
          <span><b>{minor.length} small differences</b> under {rs(MINOR)} each ({rs(minor.reduce((s, i) => s + i.atRisk, 0))} in total). These are usually rounding.</span>
          {ACTIONS_ENABLED && <button className={btnPrimary} disabled={bulk} onClick={acceptMinor}>{bulk ? "Accepting…" : `Accept all ${minor.length}`}</button>}
        </div>
      )}
      {error && <Alert tone="bad">{error}</Alert>}
      <section className="overflow-hidden rounded-xl border border-[#ded8d0] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead><tr>
              <th className={th}>Supplier</th><th className={th}>Invoice</th><th className={th}>What is wrong</th>
              <th className={`${th} text-right`}>Credit held up</th><th className={`${th} text-right`}>Next step</th>
            </tr></thead>
            <tbody>
              {visible.map((item) => {
                const group = groupOf(item.bucket);
                const gid = group?.id ?? "matched";
                const header = gid !== lastGroup;
                lastGroup = gid;
                const tier = item.atRisk >= HIGH ? "high" : item.atRisk >= MINOR ? "mid" : "minor";
                const totals = groupTotals.get(gid);
                const isMinorDiff = item.bucket === "valueDiff" && item.atRisk < MINOR;
                return [
                  header && items.some((i) => (groupOf(i.bucket)?.id ?? "matched") !== gid) ? (
                    <tr key={`h-${gid}-${item.key}`} className="bg-[#f7f4ef]">
                      <td colSpan={5} className="border-b border-[#e0d8cc] px-3 py-2 text-[12.5px]">
                        <b className="text-[#1a1a1a]">{group?.label ?? "Matched"}</b>
                        {totals && <span className="ml-3 tabular-nums text-[#6b6157]">{totals.count} invoice{totals.count === 1 ? "" : "s"}{totals.amount > 0 ? ` · ${rs(totals.amount)}` : ""}</span>}
                      </td>
                    </tr>
                  ) : null,
                  <tr key={item.key} onClick={() => setOpenKey(item.key)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setOpenKey(item.key); }}
                    className="min-h-[56px] cursor-pointer border-b border-[#ece6dc] hover:bg-[rgba(237,230,217,0.42)] focus:bg-[rgba(237,230,217,0.42)] focus:outline-none">
                    <td className={td}><span className="block max-w-[26ch] truncate text-[13px] font-medium text-[#1a1a1a]" title={item.gstin}>{nameOf(item) || item.gstin}</span></td>
                    <td className={td}><span className="font-mono text-[12px] text-[#1a1a1a]">{item.invoiceNo}</span><span className="block text-[11.5px] text-[#6b6157]">{item.invoiceDate}</span></td>
                    <td className={`${td} max-w-[44ch] text-[12.5px] leading-snug text-[#3d3530]`}>
                      {explain(item)}
                    </td>
                    <td className={`${td} w-[150px] text-right tabular-nums`}>
                      {item.atRisk > 0 ? (
                        <>
                          <span className={`block text-[13px] ${tier === "high" ? "font-bold text-[#991b1b]" : tier === "mid" ? "font-semibold text-[#3d3530]" : "text-[#6b6157]"}`}>{rs(item.atRisk)}</span>
                          <i className="ml-auto mt-1 block h-[3px] rounded-full bg-[#dd9a95]" style={{ width: `${Math.max(6, (item.atRisk / widest) * 100)}%`, opacity: tier === "minor" ? 0.45 : 1 }} />
                        </>
                      ) : <span className="text-[#b5a99a]">—</span>}
                    </td>
                    <td className={`${td} w-[150px] text-right`} onClick={(e) => e.stopPropagation()}>
                      {item.decision ? <Pill>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</Pill>
                        : item.bucket === "matched" ? <span className="text-[#065f46]">Matched</span>
                        : item.flags.includes("awaited") ? <span className="text-[12px] text-[#0369a1]">Wait for filing</span>
                        : item.docType === "isd" ? <span className="text-[12px] text-[#6b6157]">Via ISD return</span>
                        : group?.id === "g:chase" ? (ACTIONS_ENABLED
                          ? <button className={btn} disabled={busyKey === item.key} onClick={() => quick(item, "chase_supplier")}>{busyKey === item.key ? "Saving…" : "Mark chased"}</button>
                          : <span className="text-[12px] font-medium text-[#991b1b]">Supplier has not filed</span>)
                        : isMinorDiff ? (ACTIONS_ENABLED
                          ? <button className={btn} disabled={busyKey === item.key} onClick={() => quick(item, "accept")}>{busyKey === item.key ? "Saving…" : "Accept"}</button>
                          : <span className="text-[12px] text-[#6b6157]">Small difference</span>)
                        : <button className={btn} onClick={() => setOpenKey(item.key)}>Review</button>}
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
        {pages > 1 && <div className="flex items-center justify-between gap-3 border-t border-[#ece6dc] bg-[#fbfaf8] px-3 py-2 text-[12px] font-semibold text-[#6b6157]">
          <span>{(current - 1) * PAGE + 1}–{Math.min(current * PAGE, items.length)} of {items.length}</span>
          <span className="flex items-center gap-1.5">
            <button aria-label="Previous page" disabled={current <= 1} onClick={() => setPage(current - 1)} className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#ddd3c5] bg-white text-[#5a5046] hover:bg-[#f7f4ef] disabled:opacity-35"><ChevronLeft className="h-3.5 w-3.5" /></button>
            <span>Page {current} of {pages}</span>
            <button aria-label="Next page" disabled={current >= pages} onClick={() => setPage(current + 1)} className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#ddd3c5] bg-white text-[#5a5046] hover:bg-[#f7f4ef] disabled:opacity-35"><ChevronRight className="h-3.5 w-3.5" /></button>
          </span>
        </div>}
      </section>
      <ItemDrawer item={open} run={run} scope={scope} onClose={() => setOpenKey(null)} onSaved={onChanged}
        onStep={(() => { const at = items.findIndex((i) => i.key === openKey); return at < 0 ? undefined : { go: (d: -1 | 1) => setOpenKey(items[at + d]?.key ?? openKey), hasPrev: at > 0, hasNext: at < items.length - 1 }; })()} />
    </>
  );
}

const groupRank = (i: GstItem) => { const idx = GROUPS.findIndex((g) => g.buckets.includes(i.bucket)); return idx < 0 ? 99 : idx; };

function inFilter(item: GstItem, full: string) {
  const [id, months] = full.split("@");
  if (months && !months.split(",").includes(item.period)) return false;
  if (id === "all") return true;
  if (id === "needs") return item.bucket !== "matched" && !isDecided(item);
  if (id === "matched") return item.bucket === "matched";

  const group = GROUPS.find((g) => g.id === id);
  if (group) return group.buckets.includes(item.bucket);
  return item.bucket === id;
}

export function ReviewView({ run, scope, bucket, onBucket, onChanged, onRun }: {
  run: GstRun | null; scope: GstScopeInput; bucket: string; onBucket: (id: string) => void; onChanged: () => void; onRun: () => void;
}) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    if (!run) return [];
    const q = query.trim().toLowerCase();
    const order = (i: GstItem) => { const idx = GROUPS.findIndex((g) => g.buckets.includes(i.bucket)); return idx < 0 ? 99 : idx; };
    return run.items
      .filter((i) => inFilter(i, bucket) && (!q || i.gstin.toLowerCase().includes(q) || i.invoiceNo.toLowerCase().includes(q) || nameOf(i).toLowerCase().includes(q)))
      .sort((a, b) => order(a) - order(b) || b.atRisk - a.atRisk);
  }, [run, bucket, query]);
  if (!run) return <NoRun onRun={onRun} />;
  const filters = [
    { id: "needs", label: "Needs action" },
    ...GROUPS.filter((g) => g.id === bucket.split("@")[0] && !bucket.includes("@")).map((g) => ({ id: g.id, label: g.label })),
    ...(bucket.includes("@") ? [{ id: bucket, label: `${GROUPS.find((g) => g.id === bucket.split("@")[0])?.label ?? "Needs action"} · ${bucket.split("@")[1].split(",").length === 1 ? periodLabel(bucket.split("@")[1]) : bucket.split("@")[1].split(",").length + " months"}` }] : []),
    { id: "matched", label: "Matched" },
    { id: "all", label: "All" },
  ].map((f) => ({ ...f, count: run.items.filter((i) => inFilter(i, f.id)).length })).filter((f) => f.count > 0 || f.id === bucket);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {filters.map((f) => (
          <button key={f.id} onClick={() => onBucket(f.id)} aria-pressed={bucket === f.id}
            className={`rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold ${bucket === f.id ? "border-[#2d2d2d] bg-[#2d2d2d] text-white" : "border-[#ded8d0] bg-white text-[#3d3530] hover:bg-[#f7f4ef]"}`}>
            {f.label} <span className={bucket === f.id ? "text-white/70" : "text-[#6b6157]"}>{f.count}</span>
          </button>
        ))}
        <label className="relative ml-auto inline-flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[#6b6157]" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Supplier, GSTIN or invoice" className={`${inputCls} w-[260px] max-w-[46vw] pl-8`} />
        </label>
      </div>
      <ItemTable run={run} items={items} scope={scope} onChanged={onChanged} />
    </div>
  );
}

export function WorklistView({ run, scope, onChanged, onRun }: { run: GstRun | null; scope: GstScopeInput; onChanged: () => void; onRun: () => void }) {
  if (!run) return <NoRun onRun={onRun} />;
  const open = run.items.filter((i) => inFilter(i, "needs")).sort((a, b) => groupRank(a) - groupRank(b) || b.atRisk - a.atRisk);
  const totalRisk = open.reduce((sum, i) => sum + i.atRisk, 0);
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-[#5a5046]">
        <b className="text-[#1a1a1a]">{open.length} invoices</b> still need a decision, holding up <b className={TONE_TEXT.bad}>{rs(totalRisk)}</b>.
      </p>
      <ItemTable run={run} items={open} scope={scope} onChanged={onChanged} />
    </div>
  );
}

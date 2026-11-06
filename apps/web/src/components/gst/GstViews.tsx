"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, ClipboardCheck, Copy, Info, Scale, Search } from "lucide-react";
import {
  ago, DECISION_LABEL, fmtDate, gstCall, inr, inrShort, periodLabel,
  type GstItem, type GstRun, type GstScopeInput, type GstSide,
} from "@/lib/gst-client";
import { ACTIONS_ENABLED, Alert, btn, btnPrimary, card, Drawer, Empty, inputCls, Panel, Pill, td, th, TONE_TEXT, toneOf, type Tone } from "./gst-ui";

// Some Tally ledgers use the GSTIN as the party name; that is not a name, so fall back to the portal's trade name.
const nameOf = (item: GstItem) => [item.books, item.g2b, item.g2a].map((s) => s?.supplierName?.trim() ?? "").find((n) => n && n.toUpperCase() !== item.gstin.toUpperCase()) ?? "";
const num = (value: unknown) => Number(value) || 0;
// One money format everywhere on the page: whole rupees, Indian grouping.
const rs = (value: unknown) => inr(Math.round(num(value)));

// What the person has to do, not what the matcher called it.
type Group = { id: string; label: string; hint: string; buckets: string[]; tone: Tone; dot: string };
const GROUPS: Group[] = [
  { id: "g:chase", label: "Chase supplier", hint: "In your Tally books, but the supplier has not filed it", buckets: ["booksOnly", "rule37A"], tone: "bad", dot: "#dd9a95" },
  { id: "g:books", label: "Fix our books", hint: "Not booked in Tally, booked twice, or credit blocked", buckets: ["ineligible", "duplicate", "portalOnly", "reopened"], tone: "info", dot: "#8fc0e0" },
  { id: "g:amounts", label: "Check amount or date", hint: "Filed by the supplier, but the tax or invoice date differs from Tally", buckets: ["valueDiff"], tone: "warn", dot: "#e3b667" },
  { id: "g:timing", label: "Different month", hint: "The supplier filed it in another month", buckets: ["periodShift"], tone: "stone", dot: "#b8ac9a" },
];
const groupOf = (bucket: string) => GROUPS.find((g) => g.buckets.includes(bucket));
const isDecided = (item: GstItem) => ["accept", "reject"].includes(item.decision?.decision ?? "");
const MINOR = 500; // below this, an amount is too small to rank as "high" or "mid"
// Rounding means a few rupees (or under half a percent of the GST), not any gap under ₹500.
const isRounding = (item: GstItem) => item.bucket === "valueDiff" && !isDateOnly(item) && (gapOf(item) <= 10 || gapOf(item) <= 0.005 * (taxOf(item.books) ?? 0));
const HIGH = 10000;

const taxOf = (side: GstSide) => (side ? side.tax.cgst + side.tax.sgst + side.tax.igst + side.tax.cess : undefined);
// Same tax on both sides; only the invoice date is far apart. Needs a date fix in Tally, not a tax query.
function isDateOnly(item: GstItem) {
  const books = taxOf(item.books);
  const portal = taxOf(item.g2b);
  return item.bucket === "valueDiff" && books !== undefined && portal !== undefined && Math.abs(books - portal) <= 1;
}

// The engine keeps amount differences out of "at risk" (it reports them as a separate total), so the
// screens work it out per invoice: the part of the GST in Tally that the supplier did not file.
const gapOf = (item: GstItem) => (item.bucket === "valueDiff" ? Math.abs((taxOf(item.books) ?? 0) - (taxOf(item.g2b) ?? 0)) : 0);
export const riskOf = (item: GstItem) => (item.bucket === "valueDiff" ? Math.max(0, (taxOf(item.books) ?? 0) - (taxOf(item.g2b) ?? 0)) : item.atRisk);

const dupVouchers = (item: GstItem) => (item.bucket === "duplicate" ? (/\(([^)]+)\)\s*$/.exec(item.reason)?.[1] ?? item.books?.voucherNumber ?? "").split(/,\s*/).filter(Boolean) : []);
const timesBooked = (item: GstItem) => (item.bucket === "duplicate" ? Math.max(2, dupVouchers(item).length) : 1);
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// Test vouchers left in Tally (e.g. NYXTEST/26-27/001) should not look like real work.
const isTestEntry = (item: GstItem) => /NYXTEST|DUMMY|(^|[^A-Z])TEST([^A-Z]|$)/i.test(item.invoiceNo);
// Credit the supplier filed that is not in the Tally purchases for this month.
const unclaimedOf = (item: GstItem) => (item.bucket === "portalOnly" ? taxOf(item.g2b ?? item.g2a) ?? 0 : 0);

// One name per status, used by the filter rows, the badge and the side panel alike.
function statusOf(item: GstItem) {
  if (item.bucket === "valueDiff") return isDateOnly(item) ? "Date differs" : "Amount differs";
  if (item.bucket === "booksOnly" && (taxOf(item.books) ?? 0) < 1) return "No GST on voucher";
  return ({
    matched: "Matched", booksOnly: "Not filed by supplier", rule37A: "Supplier's GSTR-3B not filed", portalOnly: "Not in Tally",
    duplicate: "Booked twice", ineligible: "Credit blocked", reopened: "Withdrawn by supplier", periodShift: "Different month",
  } as Record<string, string>)[item.bucket] ?? item.bucket;
}

// The panel's one-line reason. No numbers: the grid below shows them.
function whyShort(item: GstItem) {
  const books = taxOf(item.books);
  const portal = taxOf(item.g2b);
  if (item.flags.includes("ims_rejected")) return "You rejected it in IMS, so it is not in GSTR-2B.";
  if (item.flags.includes("awaited")) return "Quarterly filer. It may still appear in a later GSTR-2B.";
  if (item.flags.includes("fuzzy")) return "Linked because the invoice numbers are nearly the same. Check them.";
  if (item.docType === "isd") return "Head-office credit. Claimed through the ISD return, not as a purchase.";
  if (item.docType === "imp" && item.bucket !== "matched") return "Import on the portal with no entry in Tally.";
  switch (item.bucket) {
    case "matched": return "Tally and the supplier's filing agree.";
    case "valueDiff": return isDateOnly(item) ? "Same amounts, but the invoice date in Tally is different." : books !== undefined && portal !== undefined && books > portal ? "Supplier filed less GST than Tally shows." : "Supplier filed more GST than Tally shows.";
    case "booksOnly": return (taxOf(item.books) ?? 0) < 1 ? "This voucher has no GST, so there is no credit to match." : isTestEntry(item) ? "Looks like a test entry in Tally." : "Supplier has not filed this invoice yet.";
    case "rule37A": return "Supplier filed GSTR-1 but not GSTR-3B, so the credit is not available yet.";
    case "portalOnly": return `Supplier filed it, but it is not in ${periodLabel(item.period)} purchases in Tally.`;
    case "duplicate": return `Booked ${timesBooked(item)} times in Tally${dupVouchers(item).length ? ` (vouchers ${andList(dupVouchers(item))})` : ""}, but the supplier filed it once. Keep one voucher and cancel the other${timesBooked(item) > 2 ? "s" : ""}.`;
    case "reopened": return "Supplier withdrew or changed it after an earlier GSTR-2B.";
    case "periodShift": return "Supplier filed it in a different month.";
    case "ineligible": return /place of supply/i.test(item.reason) ? "Tax charged for another state, so the credit is blocked." : /non-filer|inactive/i.test(item.reason) ? "Supplier is a non-filer or inactive, so the credit is blocked." : "Credit on this purchase is blocked.";
    default: return item.reason;
  }
}

// What a status means, written for a list of invoices (said once above them).
function statusLead(item: GstItem) {
  const month = periodLabel(item.period);
  if (item.bucket === "valueDiff") return isDateOnly(item) ? "Same amounts, but the invoice date in Tally differs from the supplier's." : "The supplier filed a different GST amount than Tally shows.";
  return ({
    booksOnly: "In Tally, but the supplier has not filed these yet. The credit is not available until they do.",
    rule37A: "The supplier filed GSTR-1 for these but not GSTR-3B, so the credit is not available yet.",
    portalOnly: `The supplier filed these, but they are not in ${month} purchases in Tally. If one is booked in another month, ignore it. If not, book it to claim the credit.`,
    duplicate: "One supplier invoice is booked more than once in Tally, so its credit is claimed twice.",
    ineligible: "Credit on these is blocked.",
    reopened: "The supplier withdrew or changed these after an earlier GSTR-2B.",
    periodShift: "The supplier filed these in a different month.",
  } as Record<string, string>)[item.bucket] ?? "";
}

// One short instruction per row. The explanation says why; this says what to do.
function nextStep(item: GstItem): { label: string; tone: Tone } {
  if (item.bucket === "matched") return { label: "Nothing to do", tone: "ok" };
  if (item.flags.includes("awaited")) return { label: "Wait for filing", tone: "info" };
  if (item.docType === "isd") return { label: "Claim in ISD return", tone: "stone" };
  if (item.bucket === "rule37A") return { label: "Ask supplier to file GSTR-3B", tone: "bad" };
  if (item.bucket === "booksOnly" && (taxOf(item.books) ?? 0) < 1) return { label: "Nothing to do (no GST)", tone: "stone" };
  if (item.bucket === "booksOnly") return { label: isTestEntry(item) ? "Delete test entry" : "Ask supplier to file", tone: "bad" };
  if (item.bucket === "portalOnly") return { label: "Book in Tally", tone: "info" };
  if (item.bucket === "duplicate") return { label: timesBooked(item) > 2 ? "Cancel the extra vouchers" : "Cancel the extra voucher", tone: "bad" };
  if (item.bucket === "ineligible" || item.bucket === "reopened") return { label: "Reverse the credit", tone: "bad" };
  if (item.bucket === "periodShift") return { label: item.g2b?.invoiceDate ? `Claim in ${periodLabel(item.g2b.invoiceDate.slice(0, 7))} return` : "Claim in the month the supplier filed", tone: "stone" };
  if (isDateOnly(item)) return { label: "Fix date in Tally", tone: "warn" };
  if (isRounding(item)) return { label: "Ignore (rounding)", tone: "stone" };
  if (item.bucket === "valueDiff") return { label: "Ask supplier to correct", tone: "warn" };
  return { label: "Review", tone: "stone" };
}

function explain(item: GstItem) {
  const books = taxOf(item.books);
  const portal = taxOf(item.g2b);
  const note = item.docType === "crn" ? "credit note" : item.docType === "dbn" ? "debit note" : "invoice";
  if (isDateOnly(item)) return `Amounts agree, but the invoice date in Tally (${fmtDate(item.books?.invoiceDate)}) is not the date the supplier filed (${fmtDate(item.g2b?.invoiceDate)}).`;
  if (item.docType === "imp") return item.bucket === "matched" ? "Import bill of entry. The IGST you paid at customs agrees with GSTR-2B." : "Import bill of entry on the portal with no matching entry in Tally. Book it to claim the IGST paid at customs.";
  if (item.docType === "isd") return "Credit passed on by your head office (Input Service Distributor). It is claimed through the ISD return, not as a purchase, so there is nothing to match in Tally.";
  if (item.flags.includes("ims_rejected")) return "You rejected this invoice in the portal's Invoice Management System, so it is left out of GSTR-2B. The credit is not available unless the supplier re-issues it.";
  if (item.bucket === "reopened") return "Supplier withdrew or changed this invoice after it was in an earlier GSTR-2B. Reverse the credit if it no longer stands.";
  if (item.flags.includes("awaited")) return "The supplier files quarterly, so this may still appear in a later GSTR-2B. Nothing to do yet.";
  if (item.flags.includes("rcm")) return "Reverse charge: you pay this tax yourself and then claim it back. It does not depend on what the supplier files.";
  if (item.flags.includes("fuzzy")) return "Linked automatically because the invoice numbers are almost the same (for example a typo). Check the two numbers and confirm.";
  if (item.bucket === "valueDiff" && books !== undefined && portal !== undefined) {
    const gap = Math.abs(books - portal);
    return `Supplier filed ${rs(portal)} tax, Tally has ${rs(books)}. ${rs(gap)} ${books > portal ? "more in Tally, so that part is not covered." : "less in Tally."}`;
  }
  if (item.docType === "crn" || item.docType === "dbn") {
    if (item.bucket === "booksOnly") return `A ${note} is in your Tally books but the supplier has not reported it in GSTR-2B.`;
    if (item.bucket === "matched") return `The ${note} agrees with GSTR-2B.`;
  }
  if (item.bucket === "ineligible" && /place of supply/i.test(item.reason)) return "The supplier charged tax for a different state than yours, so the credit is blocked. Ask them to correct the invoice.";
  if (item.bucket === "ineligible" && /non-filer|inactive/i.test(item.reason)) return "The supplier is a non-filer or their registration is inactive, so the credit is blocked.";
  if (item.bucket === "booksOnly") return isTestEntry(item) ? "Looks like a test entry in Tally. Delete it so it is not claimed." : "In your Tally books, but the supplier has not filed it. The credit is not available until they do.";
  if (item.bucket === "portalOnly") return `Supplier filed this ${note}, but it is not in ${periodLabel(item.period)} purchases in Tally. If it is booked in another month, nothing to do. If not, book it to claim the credit.`;
  if (item.bucket === "rule37A") return "Supplier reported this invoice but has not filed their GSTR-3B, so the credit is not available yet.";
  if (item.bucket === "periodShift") return item.g2b?.invoiceDate ? `Matches, but the supplier filed it in ${periodLabel(item.g2b.invoiceDate.slice(0, 7))}. Claim it in that month's return.` : "Matches, but the supplier filed it in a different month.";
  if (item.bucket === "duplicate") return `The same supplier invoice is booked more than once${item.books?.voucherNumber?.includes(",") ? ` (${item.books.voucherNumber})` : ""}. Cancel the extra voucher so the credit is not claimed twice.`;
  if (item.bucket === "ineligible") return "Credit on this purchase is blocked.";
  return item.reason;
}

function NoRun({ onRun }: { onRun?: () => void }) {
  return (
    <Empty
      icon={<Scale className="h-7 w-7" />}
      title="Nothing reconciled yet"
      text="Choose the months above, then run. Bhuleshwar reads your purchases from Tally and checks each invoice against what your suppliers filed."
      action={onRun ? <button onClick={onRun} className={btnPrimary}>Run reconciliation</button> : undefined}
    />
  );
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

// Lakh / crore for big amounts, whole rupees below a lakh.
const short = (n: number) => (Math.abs(n) >= 1e5 ? inrShort(n) : rs(n));

// One figure in the month summary: short amount (lakh / crore), exact rupees on hover.
function Figure({ label, value, note, noteTone = "stone", title }: { label: string; value?: number; note?: string; noteTone?: Tone; title?: string }) {
  return (
    <div title={title}>
      <dt className="text-[12.5px] text-[#6b6157]">{label}</dt>
      <dd className="mt-1 text-[26px] font-semibold leading-none tracking-tight tabular-nums text-[#1a1a1a]" title={value !== undefined ? inr(Math.round(value)) : undefined}>
        {value !== undefined ? short(value) : <span className="text-[16px] font-normal text-[#b5a99a]">Not fetched</span>}
      </dd>
      {note && <dd className={`mt-1.5 text-[12.5px] ${TONE_TEXT[noteTone]}`}>{note}</dd>}
    </div>
  );
}

export function OverviewView({ run, skipped, wholeRun, onOpen, onRun }: { run: GstRun | null; skipped: number; wholeRun: boolean; onOpen: (bucket?: string, gstin?: string) => void; onRun: () => void }) {
  if (!run) return <NoRun onRun={onRun} />;
  const { summary, movement, filed } = run.run.totals;
  const items = run.items;
  const periods = [...run.run.periods].sort();
  const title = periods.length === 1 ? periodLabel(periods[0]) : `${periodLabel(periods[0])} to ${periodLabel(periods[periods.length - 1])}`;

  // The three numbers an accountant checks every month.
  const inTally = num(summary.claimed);
  const in2B = num(summary.available);
  const has3B = filed.length > 0;
  const in3B = filed.reduce((s, f) => s + num(f.declaredIn3B), 0);
  const over3B = in3B - inTally;
  const short2B = inTally - in2B;
  const versions = Object.entries(run.run.dataVersions);
  const newest = (prefix: string) => versions.filter(([k]) => k.startsWith(prefix)).map(([, v]) => v).sort().pop();

  const matched = items.filter((i) => i.bucket === "matched").length;
  const matchPct = items.length ? Math.round((matched / items.length) * 100) : 0;
  const open = items.filter((i) => i.bucket !== "matched" && !isDecided(i)).length;
  const tests = items.filter(isTestEntry).length;
  const otherMonth = items.filter((i) => i.bucket === "periodShift").length;

  const steps = GROUPS.filter((g) => g.id !== "g:timing").map((g) => {
    const rows = items.filter((i) => g.buckets.includes(i.bucket) && !isDecided(i));
    return { ...g, count: rows.length, risk: rows.reduce((s, i) => s + riskOf(i), 0), gain: rows.reduce((s, i) => s + unclaimedOf(i), 0) };
  }).filter((g) => g.count > 0);

  // The claim deadline for the oldest month that still has money at risk.
  const riskPeriods = items.filter((i) => riskOf(i) >= 1 && i.bucket !== "matched" && !isDecided(i)).map((i) => i.period).sort();
  const deadline = riskPeriods.length ? (() => {
    const [y, m] = riskPeriods[0].split("-").map(Number);
    const at = new Date(m >= 4 ? y + 1 : y, 10, 30, 23, 59);
    return { label: at.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }), days: Math.ceil((at.getTime() - Date.now()) / 86_400_000) };
  })() : null;

  const chase = Array.from(items.filter((i) => groupOf(i.bucket)?.id === "g:chase" && !isDecided(i)).reduce((m, i) => {
    const cur = m.get(i.gstin) ?? { gstin: i.gstin, name: nameOf(i), risk: 0, count: 0 };
    cur.risk += riskOf(i); cur.count += 1;
    return m.set(i.gstin, cur);
  }, new Map<string, { gstin: string; name: string; risk: number; count: number }>()).values()).sort((a, b) => b.risk - a.risk);
  const SHOWN = 8;

  return (
    <div className="max-w-[1080px] space-y-4">
      <section className={`${card} p-5 sm:p-6`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[20px] font-semibold tracking-tight text-[#1a1a1a]">{title}</h2>
          {deadline && (
            <span className={`text-[13px] ${deadline.days <= 30 ? "font-semibold text-[#991b1b]" : "text-[#6b6157]"}`}>
              Claim by {deadline.label}{deadline.days >= 0 ? `, ${deadline.days} day${deadline.days === 1 ? "" : "s"} left` : " (date has passed)"}
            </span>
          )}
        </div>
        <dl className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-3">
          <Figure label="In Tally" value={inTally} title={run.run.booksAsOf ? `Read from Tally ${ago(run.run.booksAsOf)}` : undefined} />
          <Figure label="Supplier filed (GSTR-2B)" value={in2B} title={newest("gstr2b") ? `GSTR-2B fetched ${ago(newest("gstr2b"))}` : undefined}
            note={short2B >= 1 ? `${short(short2B)} less than Tally` : "Covers everything in Tally"} noteTone={short2B >= 1 ? "stone" : "ok"} />
          <Figure label="You claimed in GSTR-3B" value={has3B ? in3B : undefined}
            note={!has3B ? undefined : over3B >= 1 ? `${short(over3B)} more than Tally. Imports, reverse charge or credit from earlier months can explain part of this; check what is left.` : over3B <= -1 ? `${short(-over3B)} less than Tally` : "Same as Tally"}
            noteTone={!has3B ? "stone" : over3B >= 1 ? "warn" : over3B <= -1 ? "stone" : "ok"} />
        </dl>
        <p className="mt-5 border-t border-[#ece6dc] pt-3 text-[13px] text-[#3d3530]">
          <b className="text-[#1a1a1a]">{matched} of {items.length}</b> invoices match ({matchPct}%)
          {movement.hasPrior && wholeRun && <span className="text-[#6b6157]"> · {movement.resolved} fixed and {movement.opened} new since the last run</span>}
        </p>
      </section>

      {steps.length > 0 && (
        <Panel title="What to do" action={open > 0 ? <button onClick={() => onOpen("needs")} className={btnPrimary}>Review {open} invoice{open === 1 ? "" : "s"}</button> : undefined}>
          <ul className="divide-y divide-[#ece6dc]">
            {steps.map((g) => (
              <li key={g.id}>
                <button onClick={() => onOpen(g.id)} title={g.hint}
                  className="grid w-full grid-cols-[10px_minmax(0,1fr)_auto_16px] items-center gap-3 rounded-md px-1 py-2.5 text-left hover:bg-[#f7f4ef] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c9a86a] sm:grid-cols-[10px_200px_110px_minmax(0,1fr)_16px]">
                  <i className="h-2.5 w-2.5 rounded-full" style={{ background: g.dot }} />
                  <b className="text-[13.5px] text-[#1a1a1a]">{g.label}</b>
                  <span className="hidden text-[13px] tabular-nums text-[#6b6157] sm:block">{g.count} invoice{g.count === 1 ? "" : "s"}</span>
                  <span className="text-right text-[13.5px] tabular-nums sm:text-left">
                    {g.risk >= MINOR && <b className="text-[#991b1b]">{short(g.risk)} at risk</b>}
                    {g.risk >= MINOR && g.gain > 0 && <span className="text-[#6b6157]"> · </span>}
                    {g.gain > 0 && <b className="text-[#0369a1]">{short(g.gain)} filed, not in Tally</b>}
                    {g.risk < MINOR && g.gain <= 0 && <span className="text-[#6b6157]">No money at risk</span>}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-[#b5a99a]" />
                </button>
              </li>
            ))}
          </ul>
          {otherMonth > 0 && (
            <p className="mt-2 text-[12.5px] text-[#6b6157]">
              {otherMonth} invoice{otherMonth === 1 ? " was" : "s were"} filed by the supplier in a different month. <button onClick={() => onOpen("g:timing")} className="font-medium text-[#3d3530] underline decoration-dotted underline-offset-2">See {otherMonth === 1 ? "it" : "them"}</button>
            </p>
          )}
        </Panel>
      )}

      {chase.length > 0 && (
        <Panel title="Suppliers to chase" action={chase.length > SHOWN ? <button onClick={() => onOpen("g:chase")} className="text-[12.5px] font-medium text-[#3d3530] underline decoration-dotted underline-offset-2">See all {chase.length}</button> : undefined}>
          <ul className="grid gap-x-8 sm:grid-cols-2">
            {chase.slice(0, SHOWN).map((s) => (
              <li key={s.gstin} className="border-b border-[#ece6dc]">
                <button onClick={() => onOpen("g:chase", s.gstin)} className="flex w-full items-baseline justify-between gap-4 rounded-md px-1 py-2.5 text-left hover:bg-[#f7f4ef] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c9a86a]">
                  <span className="min-w-0">
                    <span className="block break-words text-[13.5px] font-medium text-[#1a1a1a]">{s.name || <span className="italic text-[#6b6157]">Name not in Tally</span>}</span>
                    <span className="text-[12px] text-[#6b6157]">{s.count} invoice{s.count === 1 ? "" : "s"} not filed</span>
                  </span>
                  {s.risk >= 1 ? <b className={`flex-none text-[13.5px] tabular-nums ${s.risk >= HIGH ? "text-[#991b1b]" : "text-[#3d3530]"}`}>{short(s.risk)}</b> : <span className="flex-none text-[12.5px] text-[#6b6157]">Nothing at risk yet</span>}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {(skipped > 0 || tests > 0) && (
        <p className="flex items-start gap-2 px-1 text-[12.5px] text-[#6b6157]"><Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
          <span>{skipped > 0 && <>{skipped} Tally voucher{skipped === 1 ? " was" : "s were"} left out because the supplier has no GSTIN in Tally. </>}
            {tests > 0 && <>{tests} test entr{tests === 1 ? "y" : "ies"} found in Tally. <button onClick={() => onOpen("all", "TEST")} className="font-medium text-[#3d3530] underline decoration-dotted underline-offset-2">See {tests === 1 ? "it" : "them"}</button></>}</span>
        </p>
      )}
    </div>
  );
}

const TONE_EDGE_COLOR: Record<Tone, string> = { ok: "border-l-[#34a172]", warn: "border-l-[#d9a23b]", bad: "border-l-[#c4504a]", info: "border-l-[#3b8fc4]", stone: "border-l-[#b8ac9a]" };

// ------------------------------------------------------------------- compare
const money = (n: number | undefined) => (n === undefined ? "—" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const sameDate = (a?: string, b?: string) => !a || !b || fmtDate(a) === fmtDate(b);
type Side = NonNullable<GstSide>;
const ROWS: { label: string; get: (s: Side) => number; total?: boolean; optional?: boolean }[] = [
  { label: "Taxable value", get: (s) => s.tax.taxable },
  { label: "CGST", get: (s) => s.tax.cgst },
  { label: "SGST", get: (s) => s.tax.sgst },
  { label: "IGST", get: (s) => s.tax.igst },
  { label: "Cess", get: (s) => s.tax.cess, optional: true },
  { label: "Total GST", get: (s) => s.tax.cgst + s.tax.sgst + s.tax.igst + s.tax.cess, total: true },
];

// Tally against the supplier's filing. Whatever differs is coloured and listed above the grid,
// so the reader never has to compare numbers by eye.
function CompareGrid({ item }: { item: GstItem }) {
  const portal = item.g2b ?? item.g2a;
  const portalName = item.g2b ? "GSTR-2B" : "GSTR-2A";
  const differs = (a?: number, b?: number) => a !== undefined && b !== undefined && Math.abs(a - b) > 1;
  // 2A is only worth a column when it tells a different story from 2B.
  const a2Differs = !!item.g2b && !!item.g2a && (!sameDate(item.g2b.invoiceDate, item.g2a.invoiceDate) || ROWS.some((r) => differs(r.get(item.g2b!), r.get(item.g2a!))));
  // When only 2A has it, show the empty 2B column too: that gap is the whole problem.
  const cols: [string, GstSide][] = item.g2b
    ? [["Tally", item.books], ["GSTR-2B", item.g2b], ...(a2Differs ? [["GSTR-2A", item.g2a] as [string, GstSide]] : [])]
    : [["Tally", item.books], ["GSTR-2B", null], ...(item.g2a ? [["GSTR-2A", item.g2a] as [string, GstSide]] : [])];
  const both = !!item.books && !!portal;
  const times = timesBooked(item);
  const valueOf = (name: string, side: Side, r: (typeof ROWS)[number]) => r.get(side) * (name === "Tally" ? times : 1);
  const rows = ROWS.filter((r) => !r.optional || cols.some(([, s]) => s && r.get(s) > 0));
  const dateDiff = both && !sameDate(item.books!.invoiceDate, portal!.invoiceDate);
  const grid = { gridTemplateColumns: `112px repeat(${cols.length}, minmax(0,1fr))${both ? " minmax(0,0.9fr)" : ""}` };
  const cell = "px-3 py-2";
  return (
    <div>
      <div className="overflow-hidden rounded-[10px] border border-[#ece6dc] text-[12.5px] tabular-nums">
        <div className="grid bg-[#f7f4ef] text-[12px] font-semibold text-[#3d3530]" style={grid}>
          <div className={`${cell} border-b border-[#e0d8cc]`} />
          {cols.map(([name, side]) => <div key={name} className={`${cell} border-b border-l border-[#e0d8cc] text-right ${side ? "" : "text-[#b5a99a]"}`}>{side ? (name === "Tally" && times > 1 ? `Tally (booked ${times}×)` : name) : `${name}: not there`}</div>)}
          {both && <div className={`${cell} border-b border-l border-[#e0d8cc] text-right`} title={`Tally minus ${portalName}. Plus means Tally claims more than the supplier filed.`}>Difference<span className="block text-[11.5px] font-normal text-[#6b6157]">(Tally − {portalName.replace("GSTR-", "")})</span></div>}
        </div>
        <div className="grid border-b border-[#ece6dc]" style={grid}>
          <div className={`${cell} text-[#6b6157]`}>Invoice</div>
          {cols.map(([name, side]) => (
            <div key={name} className={`${cell} text-right`}>{side ? <>
              <div className="break-all text-[#1a1a1a]">{side.invoiceNo}</div>
              <div className={name !== "Tally" && dateDiff ? "font-semibold text-[#991b1b]" : "text-[#6b6157]"}>{fmtDate(side.invoiceDate)}</div>
              {name === "Tally" && (times > 1 && dupVouchers(item).length > 1
                ? <div className="font-semibold text-[#991b1b]">Vouchers {andList(dupVouchers(item))}</div>
                : side.voucherNumber && <div className="text-[#6b6157]">Voucher {side.voucherNumber}</div>)}
            </> : <span className="text-[#b5a99a]">—</span>}</div>
          ))}
          {both && <div className={`${cell} text-right ${dateDiff ? "font-semibold text-[#991b1b]" : "text-[#b5a99a]"}`}>{dateDiff ? "Date" : "—"}</div>}
        </div>
        {rows.map((r, row) => {
          const base = item.books ? valueOf("Tally", item.books, r) : undefined;
          const other = portal ? r.get(portal) : undefined;
          const gap = both && differs(base, other) ? (base as number) - (other as number) : 0;
          return (
            <div key={r.label} className={`grid ${r.total ? "border-t border-[#e0d8cc] bg-[#fbfaf8] font-semibold" : row % 2 ? "bg-[#fdfcfa]" : ""}`} style={grid}>
              <div className={`${cell} ${r.total ? "text-[#1a1a1a]" : "text-[#6b6157]"}`}>{r.label}</div>
              {cols.map(([name, side], i) => {
                const value = side ? valueOf(name, side, r) : undefined;
                const diff = i > 0 && differs(base, value);
                return <div key={name} className={`${cell} text-right ${diff ? "font-semibold text-[#1a1a1a]" : side ? "text-[#1a1a1a]" : "text-[#b5a99a]"}`}>{money(value)}</div>;
              })}
              {both && <div className={`${cell} text-right ${gap ? "bg-[#fef2f2] font-semibold text-[#991b1b]" : "text-[#b5a99a]"}`}>{gap ? `${gap > 0 ? "+" : "−"}${money(Math.abs(gap))}` : "—"}</div>}
            </div>
          );
        })}
      </div>
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

function ItemDrawer({ item, run, scope, onClose, onSaved, onStep }: { item: GstItem | null; run: GstRun; scope: GstScopeInput; onClose: () => void; onSaved: () => void; onStep?: { go: (d: -1 | 1) => void; pos: number; total: number } }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { setNote(""); setError(""); setCopied(false); }, [item?.key]);
  // Up and down arrows walk through the list, like an inbox.
  useEffect(() => {
    if (!item || !onStep) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowDown" && onStep.pos < onStep.total) { e.preventDefault(); onStep.go(1); }
      if (e.key === "ArrowUp" && onStep.pos > 1) { e.preventDefault(); onStep.go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onStep]);

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
  const { lead, ordered, result } = actionsFor(item);
  const fyEnd = Number(item.period.slice(0, 4)) + (Number(item.period.slice(5)) >= 4 ? 1 : 0);
  const lastDay = `30 Nov ${fyEnd}`;
  const showDeadline = riskOf(item) > 0 && ["booksOnly", "rule37A", "valueDiff", "portalOnly"].includes(item.bucket);
  return (
    <Drawer open onClose={onClose} title={nameOf(item) || "Supplier name not in Tally"}
      subtitle={item.gstin
        ? <button type="button" title="Copy GSTIN" onClick={() => { navigator.clipboard?.writeText(item.gstin).then(() => setCopied(true), () => undefined); }} className="inline-flex items-center gap-1.5 rounded text-[#6b6157] hover:text-[#1a1a1a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c9a86a]">{item.gstin}{copied ? <Check className="h-3 w-3 text-[#065f46]" /> : <Copy className="h-3 w-3" />}</button>
        : "No GSTIN"}
      badges={<><Pill tone={tone}>{statusOf(item)}</Pill>{item.decision && <Pill>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</Pill>}</>}
      footer={(
        <div className="space-y-2.5">
          {error && <Alert tone="bad">{error}</Alert>}
          {ACTIONS_ENABLED && <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Add a note for your team (optional)" className={`${inputCls} w-full`} />}
          {ACTIONS_ENABLED && <p className="text-[11.5px] text-[#6b6157]">{result}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {onStep && <span className="flex items-center gap-2 text-[12px] text-[#6b6157]">
              <button title="Previous (↑)" disabled={onStep.pos <= 1} onClick={() => onStep.go(-1)} className={btn}><ChevronLeft className="h-3.5 w-3.5" />Previous</button>
              <span className="tabular-nums">{onStep.pos} of {onStep.total}</span>
              <button title="Next (↓)" disabled={onStep.pos >= onStep.total} onClick={() => onStep.go(1)} className={btn}>Next<ChevronRight className="h-3.5 w-3.5" /></button>
            </span>}
            <span className="flex flex-wrap items-center justify-end gap-2">
              {ACTIONS_ENABLED && ordered.map(([id, label]) => (
                <button key={id} disabled={!!saving} onClick={() => decide(id)} className={id === lead ? btnPrimary : btn}>{saving === id ? "Saving…" : label}</button>
              ))}
            </span>
          </div>
        </div>
      )}>
      {(() => {
        const step = nextStep(item);
        const toClaim = unclaimedOf(item);
        const flags = [
          ({ crn: "Credit note", dbn: "Debit note", imp: "Import", isd: "ISD credit" } as Record<string, string>)[item.docType],
          item.flags.includes("rcm") ? "Reverse charge" : "",
          item.flags.includes("amended") ? "Amended by supplier" : "",
        ].filter(Boolean);
        return (
          <section className={`rounded-lg border-l-[3px] bg-[#fbfaf8] px-4 py-3 ${TONE_EDGE_COLOR[step.tone]}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <h3 className={`text-[15px] font-semibold ${TONE_TEXT[step.tone]}`}>{step.label}</h3>
              {riskOf(item) >= 1 ? <span className="text-[15px] font-semibold tabular-nums text-[#991b1b]">{rs(riskOf(item))} at risk</span>
                : toClaim > 0 ? <span className="text-[15px] font-semibold tabular-nums text-[#0369a1]">{rs(toClaim)} filed, not in Tally</span> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-[12.5px] text-[#3d3530]">
              <p>{whyShort(item)}{flags.length ? <span className="text-[#6b6157]"> ({flags.join(", ")})</span> : null}</p>
              {showDeadline && <span className="text-[#6b6157]">Claim by {lastDay}</span>}
            </div>
          </section>
        );
      })()}
      <div className="mt-4" />
      <CompareGrid item={item} />
      {item.decision && (
        <p className="mt-4 rounded-lg border border-[#ece6dc] bg-[#fbfaf8] px-3 py-2 text-[11.5px] text-[#3d3530]">
          <b>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</b> by {item.decision.decided_by_name ?? "someone"} · {ago(item.decision.decided_at)}
          {item.decision.note ? <span className="block pt-0.5 text-[#3d3530]">“{item.decision.note}”</span> : null}
        </p>
      )}
    </Drawer>
  );
}

// --------------------------------------------------------------------- table
const PAGE = 50;

const decide = (scope: GstScopeInput, run: GstRun, item: GstItem, decision: string) =>
  gstCall("POST", "/api/gst/decisions", scope, { itemKey: item.key, runId: run.run.id, decision, note: "" });

function ItemTable({ run, items, scope, onChanged, showRounding = false }: { run: GstRun; items: GstItem[]; scope: GstScopeInput; onChanged: () => void; showRounding?: boolean }) {
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
  const groupTotals = useMemo(() => {
    const out = new Map<string, { count: number; amount: number }>();
    for (const item of items) {
      const id = groupOf(item.bucket)?.id ?? "matched";
      const cur = out.get(id) ?? { count: 0, amount: 0 };
      out.set(id, { count: cur.count + 1, amount: cur.amount + riskOf(item) });
    }
    return out;
  }, [items]);
  const minor = items.filter((i) => isRounding(i) && !i.decision);

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
  // Rows arrive sorted by group, then supplier. Each supplier gets one header line, and when all of its
  // invoices have the same problem the explanation is said once there instead of on every row.
  const statusKey = (item: GstItem) => `${groupOf(item.bucket)?.id ?? "matched"}|${statusOf(item)}`;
  const supplierKey = (item: GstItem) => `${statusKey(item)}|${item.gstin}`;
  const statusRows = new Map<string, GstItem[]>();
  const supplierRows = new Map<string, GstItem[]>();
  for (const item of items) {
    statusRows.set(statusKey(item), [...(statusRows.get(statusKey(item)) ?? []), item]);
    supplierRows.set(supplierKey(item), [...(supplierRows.get(supplierKey(item)) ?? []), item]);
  }
  // A step said in the status header is not repeated on each row.
  const sharedStep = (rows: GstItem[]) => { const first = nextStep(rows[0]).label; return !ACTIONS_ENABLED && rows.every((r) => !r.decision && nextStep(r).label === first) ? nextStep(rows[0]) : null; };
  // Columns that are empty on every row are dropped.
  const showTally = items.some((i) => i.books);
  const showFiled = items.some((i) => i.g2b || i.g2a);
  const showRisk = items.some((i) => riskOf(i) >= 1);
  // An amount difference is already visible in the two GST columns, so it needs no sentence.
  const noteOf = (item: GstItem) => (item.bucket === "valueDiff" && !isDateOnly(item) ? "" : explain(item));
  const sharedReason = (rows: GstItem[]) => { const first = noteOf(rows[0]); return rows.every((r) => noteOf(r) === first) ? first : ""; };
  const multiGroup = items.some((i) => (groupOf(i.bucket)?.id ?? "matched") !== (groupOf(items[0].bucket)?.id ?? "matched"));
  const COLS = 3 + (showTally ? 1 : 0) + (showFiled ? 1 : 0) + (showRisk ? 1 : 0);
  const fixed = 12 + (showTally ? 13 : 0) + (showFiled ? 14 : 0) + (showRisk ? 11 : 0) + 18;
  let lastGroup = "";
  let lastStatus = "";
  let lastSupplier = "";
  return (
    <>
      {showRounding && minor.length >= 2 && (
        <div className="rounded-xl border border-[#ece6dc] bg-[#fbfaf8] px-4 py-3 text-[13px] text-[#3d3530]">
          <b className="text-[#1a1a1a]">{minor.length} invoices</b> differ only by rounding ({rs(minor.reduce((s, i) => s + gapOf(i), 0))} in total). This is rounding and can be ignored.
          {ACTIONS_ENABLED && <button className={`${btnPrimary} ml-3`} disabled={bulk} onClick={acceptMinor}>{bulk ? "Accepting…" : `Accept all ${minor.length}`}</button>}
        </div>
      )}
      {error && <Alert tone="bad">{error}</Alert>}
      <section className="overflow-hidden rounded-xl border border-[#ded8d0] bg-white">
        <div className="max-h-[calc(100vh-240px)] min-h-[320px] overflow-auto">
          <table className="w-full min-w-[860px] table-fixed border-collapse text-left">
            <colgroup>
              <col style={{ width: `${100 - fixed}%` }} /><col style={{ width: "12%" }} />
              {showTally && <col style={{ width: "13%" }} />}{showFiled && <col style={{ width: "14%" }} />}{showRisk && <col style={{ width: "11%" }} />}<col style={{ width: "18%" }} />
            </colgroup>
            <thead><tr>
              <th className={th}>Invoice</th><th className={th}>Invoice date</th>
              {showTally && <th className={`${th} text-right`}>GST in Tally</th>}{showFiled && <th className={`${th} text-right`}>GST filed by supplier</th>}
              {showRisk && <th className={`${th} text-right`}>ITC at risk</th>}<th className={`${th} text-right`}>Next step</th>
            </tr></thead>
            <tbody>
              {visible.map((item) => {
                const group = groupOf(item.bucket);
                const gid = group?.id ?? "matched";
                const showGroup = gid !== lastGroup;
                const stKey = statusKey(item);
                const showStatus = showGroup || stKey !== lastStatus;
                const sKey = supplierKey(item);
                const showSupplier = showStatus || sKey !== lastSupplier;
                lastGroup = gid; lastStatus = stKey; lastSupplier = sKey;
                const statusList = statusRows.get(stKey) ?? [item];
                // Most invoices in a status share one reason; only a supplier that differs (e.g. reverse charge) repeats its own.
                const statusReason = statusLead(item) || sharedReason(statusList);
                const typical = (() => { const n = new Map<string, number>(); for (const r of statusList) n.set(noteOf(r), (n.get(noteOf(r)) ?? 0) + 1); return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""; })();
                const statusStep = sharedStep(statusList);
                const statusRisk = statusList.reduce((sum, r) => sum + riskOf(r), 0);
                const statusGain = statusList.reduce((sum, r) => sum + unclaimedOf(r), 0);
                const rows = supplierRows.get(sKey) ?? [item];
                const supplierShared = sharedReason(rows);
                const supplierReason = supplierShared && supplierShared !== typical ? supplierShared : "";
                const tier = riskOf(item) >= HIGH ? "high" : riskOf(item) >= MINOR ? "mid" : "minor";
                const totals = groupTotals.get(gid);
                const isMinorDiff = isRounding(item);
                const step = nextStep(item);
                const supplierRisk = rows.reduce((sum, r) => sum + riskOf(r), 0);
                const supplierUnclaimed = rows.reduce((sum, r) => sum + unclaimedOf(r), 0);
                const inTally = taxOf(item.books);
                const filed = taxOf(item.g2b) ?? taxOf(item.g2a);
                return [
                  showGroup && multiGroup ? (
                    <tr key={`g-${gid}-${item.key}`} className="bg-[#efe9df]">
                      <td colSpan={COLS} className="border-b border-t border-[#d8cfc1] px-3 py-2.5 text-[12.5px]">
                        <i className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: group?.dot ?? "#7fc4a0" }} />
                        <b className="text-[13.5px] text-[#1a1a1a]">{group?.label ?? "Matched"}</b>
                        {totals && <span className="ml-3 tabular-nums text-[#6b6157]">{totals.count} invoice{totals.count === 1 ? "" : "s"}{totals.amount >= MINOR ? ` · ${rs(totals.amount)} at risk` : ""}</span>}
                      </td>
                    </tr>
                  ) : null,
                  showStatus && item.bucket !== "matched" ? (
                    <tr key={`t-${stKey}-${item.key}`} className="bg-[#fbfaf8]">
                      <td colSpan={COLS} className="border-b border-[#ece6dc] px-3 pb-2.5 pt-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                          <span className="text-[13px]"><b className={TONE_TEXT[nextStep(item).tone]}>{statusOf(item)}</b>
                            <span className="ml-2 tabular-nums text-[#6b6157]">{statusList.length} invoice{statusList.length === 1 ? "" : "s"}</span></span>
                          <span className="text-[12.5px] tabular-nums">
                            {statusRisk >= 1 && <b className="text-[#991b1b]">{rs(statusRisk)} at risk</b>}
                            {statusRisk >= 1 && statusGain > 0 && <span className="text-[#6b6157]"> · </span>}
                            {statusGain > 0 && <b className="text-[#0369a1]">{rs(statusGain)} filed, not in Tally</b>}
                          </span>
                        </div>
                        {(statusReason || statusStep) && (
                          <p className="mt-0.5 max-w-[100ch] text-[12.5px] leading-snug text-[#3d3530]">
                            {statusReason}{statusStep && <> <span className={`font-medium ${TONE_TEXT[statusStep.tone]}`}>Next step: {statusStep.label}.</span></>}
                          </p>
                        )}
                      </td>
                    </tr>
                  ) : null,
                  showSupplier ? (
                    <tr key={`s-${sKey}-${item.key}`} className="bg-white">
                      <td colSpan={COLS} className="border-b border-[#f1ece3] px-3 pb-1.5 pt-3.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <span className="text-[13.5px] font-semibold text-[#1a1a1a]">{nameOf(item) || <span className="italic text-[#6b6157]">Name not in Tally</span>}
                            <span className="ml-2 font-mono text-[11.5px] font-normal text-[#6b6157]">{item.gstin || "No GSTIN"}</span></span>
                          <span className="text-[12.5px] tabular-nums text-[#3d3530]">{rows.length} invoice{rows.length === 1 ? "" : "s"}
                            {supplierRisk >= MINOR ? <> · <b className="text-[#991b1b]">{rs(supplierRisk)} at risk</b></> : supplierUnclaimed > 0 ? <> · <b className="text-[#0369a1]">{rs(supplierUnclaimed)} filed, not in Tally</b></> : null}</span>
                        </div>
                        {supplierReason && <p className="mt-0.5 text-[12.5px] leading-snug text-[#3d3530]">{supplierReason}</p>}
                      </td>
                    </tr>
                  ) : null,
                  <tr key={item.key} onClick={() => setOpenKey(item.key)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setOpenKey(item.key); }}
                    className="cursor-pointer border-b border-[#ece6dc] hover:bg-[rgba(237,230,217,0.42)] focus:bg-[rgba(237,230,217,0.42)] focus:outline-none">
                    <td className={`${td} pl-6`}>
                      <span className="font-mono text-[12px] text-[#1a1a1a]">{item.invoiceNo}</span>
                      {isTestEntry(item) && <span className="ml-2"><Pill tone="warn">Test entry</Pill></span>}
                      {item.bucket === "duplicate" && dupVouchers(item).length > 1
                        ? <span className="block text-[11.5px] font-medium text-[#991b1b]">Tally vouchers {andList(dupVouchers(item))}</span>
                        : item.books?.voucherNumber && <span className="block text-[11.5px] text-[#6b6157]">Tally voucher {item.books.voucherNumber}</span>}
                      {!supplierShared && noteOf(item) !== typical && noteOf(item) && <span className="mt-0.5 block max-w-[60ch] text-[12px] leading-snug text-[#6b6157]">{noteOf(item)}</span>}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{fmtDate(item.invoiceDate)}</td>
                    {showTally && <td className={`${td} text-right tabular-nums`}>{inTally !== undefined
                      ? timesBooked(item) > 1 ? <span title={`${timesBooked(item)} × ${rs(inTally)}`}><b className="text-[#991b1b]">{rs(inTally * timesBooked(item))}</b><span className="block text-[11px] text-[#6b6157]">{timesBooked(item)} × {rs(inTally)}</span></span> : rs(inTally)
                      : <span className="text-[#b5a99a]" title="Not in Tally">—</span>}</td>}
                    {showFiled && <td className={`${td} text-right tabular-nums`}>{filed !== undefined ? <>{rs(filed)}{!item.g2b && <span className="ml-1 text-[11px] text-[#6b6157]">(2A)</span>}</> : <span className="text-[#b5a99a]" title="Not filed by the supplier">—</span>}</td>}
                    {showRisk && <td className={`${td} text-right tabular-nums`}>
                      {riskOf(item) >= 1 ? (
                        <span className={`text-[13px] ${tier === "high" ? "font-bold text-[#991b1b]" : tier === "mid" ? "font-semibold text-[#3d3530]" : "text-[#6b6157]"}`}>{rs(riskOf(item))}</span>
                      ) : <span className="text-[#b5a99a]">—</span>}
                    </td>}
                    <td className={`${td} text-right`} onClick={(e) => e.stopPropagation()}>
                      {item.decision ? <Pill>{DECISION_LABEL[item.decision.decision] ?? item.decision.decision}</Pill>
                        : ACTIONS_ENABLED && group?.id === "g:chase" ? <button className={btn} disabled={busyKey === item.key} onClick={() => quick(item, "chase_supplier")}>{busyKey === item.key ? "Saving…" : "Mark chased"}</button>
                        : ACTIONS_ENABLED && isMinorDiff ? <button className={btn} disabled={busyKey === item.key} onClick={() => quick(item, "accept")}>{busyKey === item.key ? "Saving…" : "Accept"}</button>
                        : statusStep ? <ChevronRight className="ml-auto h-3.5 w-3.5 text-[#cfc6b8]" aria-hidden />
                        : <span className={`text-[12px] font-medium ${TONE_TEXT[step.tone]}`}>{step.label}</span>}
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
            <button aria-label="Previous page" disabled={current <= 1} onClick={() => setPage(current - 1)} className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#ddd3c5] bg-white text-[#3d3530] hover:bg-[#f7f4ef] disabled:opacity-35"><ChevronLeft className="h-3.5 w-3.5" /></button>
            <span>Page {current} of {pages}</span>
            <button aria-label="Next page" disabled={current >= pages} onClick={() => setPage(current + 1)} className="grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#ddd3c5] bg-white text-[#3d3530] hover:bg-[#f7f4ef] disabled:opacity-35"><ChevronRight className="h-3.5 w-3.5" /></button>
          </span>
        </div>}
      </section>
      <ItemDrawer item={open} run={run} scope={scope} onClose={() => setOpenKey(null)} onSaved={onChanged}
        onStep={(() => { const at = items.findIndex((i) => i.key === openKey); return at < 0 ? undefined : { go: (d: -1 | 1) => setOpenKey(items[at + d]?.key ?? openKey), pos: at + 1, total: items.length }; })()} />
    </>
  );
}

// ------------------------------------------------------------ supplier panel
// The message to send a supplier, built only from their open invoices. It is copied, never sent.
function supplierMessage(name: string, period: string, rows: GstItem[]) {
  const line = (i: GstItem) => {
    const tally = taxOf(i.books) ?? 0;
    const filed = taxOf(i.g2b) ?? 0;
    const base = `- ${i.invoiceNo} dated ${fmtDate(i.invoiceDate)}, GST ${rs(tally)}`;
    if (i.bucket === "valueDiff" && !isDateOnly(i)) return `${base} (you filed ${rs(filed)})`;
    if (isDateOnly(i)) return `${base} (you filed it with date ${fmtDate(i.g2b?.invoiceDate)})`;
    return base;
  };
  const notFiled = rows.filter((i) => i.bucket === "booksOnly" && (taxOf(i.books) ?? 0) >= 1);
  const no3B = rows.filter((i) => i.bucket === "rule37A");
  const differs = rows.filter((i) => i.bucket === "valueDiff" && !isDateOnly(i) && !isRounding(i));
  const parts = [
    notFiled.length ? ["These invoices are in our books but not in your GSTR-1. Please file them:", ...notFiled.map(line)] : [],
    no3B.length ? ["These are in your GSTR-1 but your GSTR-3B is not filed yet, so we cannot claim the credit. Please file your GSTR-3B:", ...no3B.map(line)] : [],
    differs.length ? ["The GST on these does not match our books. Please check and amend:", ...differs.map(line)] : [],
  ].filter((p) => p.length);
  if (!parts.length) return "";
  return [`Hello ${name || "team"},`, "", `This is about our purchases for ${periodLabel(period)}.`, "", ...parts.flatMap((p) => [...p, ""]), "Thank you."].join("\n");
}

export function SupplierPanel({ run, gstin, badge, onClose, onStep }: {
  run: GstRun; gstin: string; badge?: { label: string; tone: Tone }; onClose: () => void;
  onStep: { go: (d: -1 | 1) => void; pos: number; total: number };
}) {
  const items = run.items.filter((i) => i.gstin === gstin);
  // Problems grouped by what to do; money at risk comes before credit not yet booked.
  const stepGroups = Array.from(items.filter((i) => i.bucket !== "matched").reduce((m, i) => {
    const st = nextStep(i);
    const cur = m.get(st.label) ?? { step: st, rows: [] as GstItem[], risk: 0, gain: 0 };
    cur.rows.push(i); cur.risk += riskOf(i); cur.gain += unclaimedOf(i);
    return m.set(st.label, cur);
  }, new Map<string, { step: { label: string; tone: Tone }; rows: GstItem[]; risk: number; gain: number }>()).values())
    .sort((a, b) => b.risk - a.risk || b.gain - a.gain || b.rows.length - a.rows.length);
  const problems = stepGroups.flatMap((g) => [...g.rows].sort((a, b) => (riskOf(b) + unclaimedOf(b)) - (riskOf(a) + unclaimedOf(a))));
  const matched = items.filter((i) => i.bucket === "matched");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [showMatched, setShowMatched] = useState(false);
  const [copied, setCopied] = useState("");
  useEffect(() => { setOpenKey(null); setShowMatched(false); setCopied(""); }, [gstin]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowDown" && onStep.pos < onStep.total) { e.preventDefault(); onStep.go(1); }
      if (e.key === "ArrowUp" && onStep.pos > 1) { e.preventDefault(); onStep.go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStep]);
  if (!items.length) return null;

  const name = nameOf(items[0]);
  const risk = problems.reduce((s, i) => s + riskOf(i), 0);
  const gain = problems.reduce((s, i) => s + unclaimedOf(i), 0);
  const lead = stepGroups[0];
  const count = (n: number) => `${n} invoice${n === 1 ? "" : "s"}`;
  const verdict = !lead
    ? { label: "Nothing to do", tone: "ok" as Tone, why: `All ${count(items.length)} match the supplier's filing.` }
    : stepGroups.length === 1
      ? { label: `${lead.step.label} (${count(lead.rows.length)})`, tone: lead.step.tone, why: statusLead(lead.rows[0]) || whyShort(lead.rows[0]) }
      : { label: `${lead.step.label} (${count(lead.rows.length)})`, tone: lead.step.tone,
          why: `Also: ${stepGroups.slice(1).map((g) => `${g.step.label.charAt(0).toLowerCase()}${g.step.label.slice(1)} (${g.rows.length})`).join(", ")}.` };
  const riskPeriods = problems.filter((i) => riskOf(i) >= 1).map((i) => i.period).sort();
  const lastDay = riskPeriods.length ? (() => { const [y, m] = riskPeriods[0].split("-").map(Number); return `30 Nov ${m >= 4 ? y + 1 : y}`; })() : "";

  // How this supplier stands, one line per status.
  const byStatus = Array.from(items.reduce((m, i) => {
    const k = statusOf(i);
    const cur = m.get(k) ?? { label: k, tone: i.bucket === "matched" ? "ok" as Tone : nextStep(i).tone, count: 0, tally: 0, filed: 0, money: 0 };
    cur.count += 1; cur.tally += taxOf(i.books) ?? 0; cur.filed += taxOf(i.g2b) ?? taxOf(i.g2a) ?? 0; cur.money += riskOf(i) + unclaimedOf(i);
    return m.set(k, cur);
  }, new Map<string, { label: string; tone: Tone; count: number; tally: number; filed: number; money: number }>()).values())
    .sort((a, b) => (a.label === "Matched" ? -1 : b.label === "Matched" ? 1 : b.money - a.money));

  const message = supplierMessage(name, run.run.periods[run.run.periods.length - 1] ?? items[0].period, problems);
  const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => { setCopied(what); window.setTimeout(() => setCopied(""), 2000); }, () => setCopied("failed"));

  const row = (item: GstItem) => {
    const open = openKey === item.key;
    const amount = riskOf(item) >= 1 ? riskOf(item) : unclaimedOf(item);
    const step = nextStep(item);
    return (
      <li key={item.key}>
        <button onClick={() => setOpenKey(open ? null : item.key)} aria-expanded={open}
          className="grid w-full grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 px-3 py-2.5 text-left hover:bg-[#fbfaf8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c9a86a]">
          <span className="min-w-0">
            <span className="text-[13px] text-[#1a1a1a]">{item.invoiceNo}</span>
            {isTestEntry(item) && <span className="ml-2"><Pill tone="warn">Test entry</Pill></span>}
            <span className="block text-[12px] text-[#6b6157]">{fmtDate(item.invoiceDate)} · <span className={TONE_TEXT[step.tone]}>{item.bucket === "matched" ? "Matched" : step.label}</span></span>
          </span>
          <span className={`text-[13px] font-semibold tabular-nums ${riskOf(item) >= 1 ? "text-[#991b1b]" : "text-[#0369a1]"}`}>{amount >= 1 ? rs(amount) : ""}</span>
          <ChevronRight className={`h-3.5 w-3.5 text-[#b5a99a] transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        {open && (
          <div className="border-t border-[#ece6dc] bg-[#fdfcfa] px-3 py-3">
            {item.bucket !== "matched" && <p className="mb-2 text-[12.5px] text-[#3d3530]">{whyShort(item)}</p>}
            <CompareGrid item={item} />
          </div>
        )}
      </li>
    );
  };

  return (
    <Drawer open onClose={onClose} title={name || "Supplier name not in Tally"}
      subtitle={gstin
        ? <button type="button" title="Copy GSTIN" onClick={() => copy(gstin, "gstin")} className="inline-flex items-center gap-1.5 rounded text-[#6b6157] hover:text-[#1a1a1a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c9a86a]">{gstin}{copied === "gstin" ? <Check className="h-3 w-3 text-[#065f46]" /> : <Copy className="h-3 w-3" />}</button>
        : "No GSTIN"}
      badges={badge ? <Pill tone={badge.tone}>{badge.label}</Pill> : undefined}
      footer={<span className="flex items-center gap-2 text-[12px] text-[#6b6157]">
        <button title="Previous supplier (↑)" disabled={onStep.pos <= 1} onClick={() => onStep.go(-1)} className={btn}><ChevronLeft className="h-3.5 w-3.5" />Previous</button>
        <span className="tabular-nums">Supplier {onStep.pos} of {onStep.total}</span>
        <button title="Next supplier (↓)" disabled={onStep.pos >= onStep.total} onClick={() => onStep.go(1)} className={btn}>Next<ChevronRight className="h-3.5 w-3.5" /></button>
      </span>}>
      <section className={`rounded-lg border-l-[3px] bg-[#fbfaf8] px-4 py-3 ${TONE_EDGE_COLOR[verdict.tone]}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <h3 className={`text-[15px] font-semibold ${TONE_TEXT[verdict.tone]}`}>{verdict.label}</h3>
          <span className="text-right text-[15px] font-semibold tabular-nums">
            {risk >= 1 && <span className="block text-[#991b1b]">{short(risk)} at risk</span>}
            {gain > 0 && <span className={`block text-[#0369a1] ${risk >= 1 ? "text-[12.5px] font-medium" : ""}`}>{short(gain)} filed, not in Tally</span>}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-[12.5px]">
          <p className="text-[#3d3530]">{verdict.why}</p>
          {lastDay && <span className="text-[#6b6157]">Claim by {lastDay}</span>}
        </div>
      </section>

      <h4 className="mb-2 mt-5 text-[13px] font-semibold text-[#1a1a1a]">{periodLabel(items[0].period)}{run.run.periods.length > 1 ? " and other months shown" : ""}</h4>
      <div className="overflow-hidden rounded-[10px] border border-[#ece6dc] text-[12.5px] tabular-nums">
        <div className="grid grid-cols-[minmax(0,1fr)_70px_110px_120px] bg-[#f7f4ef] px-3 py-2 text-[12px] font-semibold text-[#3d3530]">
          <span>Status</span><span className="text-right">Invoices</span><span className="text-right">GST in Tally</span><span className="text-right">Filed by supplier</span>
        </div>
        {byStatus.map((s) => (
          <div key={s.label} className="grid grid-cols-[minmax(0,1fr)_70px_110px_120px] border-t border-[#ece6dc] px-3 py-2">
            <span className={`font-medium ${TONE_TEXT[s.tone]}`}>{s.label}</span>
            <span className="text-right text-[#1a1a1a]">{s.count}</span>
            <span className="text-right text-[#1a1a1a]">{s.tally ? short(s.tally) : "—"}</span>
            <span className="text-right text-[#1a1a1a]">{s.filed ? short(s.filed) : "—"}</span>
          </div>
        ))}
      </div>

      {problems.length > 0 && (
        <>
          <h4 className="mb-2 mt-5 text-[13px] font-semibold text-[#1a1a1a]">Invoices that need action <span className="font-normal text-[#6b6157]">({problems.length})</span></h4>
          <ul className="divide-y divide-[#ece6dc] rounded-[10px] border border-[#ece6dc]">{problems.map(row)}</ul>
        </>
      )}
      {matched.length > 0 && (
        showMatched
          ? <>
              <h4 className="mb-2 mt-5 text-[13px] font-semibold text-[#1a1a1a]">Matched <span className="font-normal text-[#6b6157]">({matched.length})</span></h4>
              <ul className="divide-y divide-[#ece6dc] rounded-[10px] border border-[#ece6dc]">{matched.map(row)}</ul>
            </>
          : <button onClick={() => setShowMatched(true)} className="mt-3 text-[12.5px] font-medium text-[#3d3530] underline decoration-dotted underline-offset-2">Show {matched.length} matched invoice{matched.length === 1 ? "" : "s"}</button>
      )}

      {message && (
        <>
          <div className="mb-2 mt-5 flex items-baseline justify-between gap-3">
            <h4 className="text-[13px] font-semibold text-[#1a1a1a]">Message to send</h4>
            <button onClick={() => copy(message, "message")} className={btn}>{copied === "message" ? <><Check className="h-3.5 w-3.5" />Copied</> : copied === "failed" ? "Copy failed" : <><Copy className="h-3.5 w-3.5" />Copy</>}</button>
          </div>
          <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap rounded-[10px] border border-[#ece6dc] bg-[#fbfaf8] px-3 py-2.5 font-sans text-[12.5px] leading-relaxed text-[#3d3530]">{message}</pre>
          <p className="mt-1.5 text-[11.5px] text-[#6b6157]">Copy it into WhatsApp or email. Nothing is sent from here.</p>
        </>
      )}
    </Drawer>
  );
}

const groupRank = (i: GstItem) => { const idx = GROUPS.findIndex((g) => g.buckets.includes(i.bucket)); return idx < 0 ? 99 : idx; };
// Inside a group, invoices with the same status sit together so the reason and next step can be said once.
const statusRank = (i: GstItem) => { const g = groupOf(i.bucket); return (g ? g.buckets.indexOf(i.bucket) : 0) * 2 + (isDateOnly(i) ? 1 : 0); };

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

export function ReviewView({ run, scope, bucket, onBucket, onChanged, onRun, initialQuery = "" }: {
  run: GstRun | null; scope: GstScopeInput; bucket: string; onBucket: (id: string) => void; onChanged: () => void; onRun: () => void; initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => { setQuery(initialQuery); }, [initialQuery]);
  const items = useMemo(() => {
    if (!run) return [];
    const q = query.trim().toLowerCase();
    const rows = run.items
      .filter((i) => inFilter(i, bucket) && (!q || i.gstin.toLowerCase().includes(q) || i.invoiceNo.toLowerCase().includes(q) || nameOf(i).toLowerCase().includes(q)));
    // Within each group, the supplier with the most money involved comes first, and its invoices stay together.
    const weight = new Map<string, number>();
    const statusWeight = new Map<string, number>();
    for (const i of rows) {
      const k = `${groupRank(i)}|${statusRank(i)}|${i.gstin}`; weight.set(k, (weight.get(k) ?? 0) + riskOf(i) + unclaimedOf(i));
      const t = `${groupRank(i)}|${statusRank(i)}`; statusWeight.set(t, (statusWeight.get(t) ?? 0) + riskOf(i) + unclaimedOf(i));
    }
    const w = (i: GstItem) => weight.get(`${groupRank(i)}|${statusRank(i)}|${i.gstin}`) ?? 0;
    const sw = (i: GstItem) => statusWeight.get(`${groupRank(i)}|${statusRank(i)}`) ?? 0;
    return rows.sort((a, b) => groupRank(a) - groupRank(b) || sw(b) - sw(a) || statusRank(a) - statusRank(b) || w(b) - w(a) || a.gstin.localeCompare(b.gstin) || riskOf(b) - riskOf(a) || a.invoiceNo.localeCompare(b.invoiceNo));
  }, [run, bucket, query]);
  if (!run) return <NoRun onRun={onRun} />;
  const filters = [
    { id: "needs", label: "Needs action" },
    ...GROUPS.map((g) => ({ id: g.id, label: g.label })),
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
      <ItemTable run={run} items={items} scope={scope} onChanged={onChanged} showRounding={bucket.startsWith("g:amounts")} />
    </div>
  );
}

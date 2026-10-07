// Customer receivables for Payment Follow-ups and Cash Discounts, prepared
// once from Tally and then kept current using Tally's change counters.
//
// Tally exposes two company-level counters without any installed TDL:
//   $AltVchID - highest voucher AlterID (moves on every voucher create/edit/delete)
//   $AltMstID - highest master AlterID (moves on every ledger/group/type change)
// A minute-by-minute check therefore costs one ~15 ms read when nothing
// changed, and a ~1 s "vouchers after AlterID N" read when something did.
//
// Each <BILL> and <VOUCHER> is read into fields once, as it is stored
// (receivable-fields.mjs), so scans, reminders and bank matching never parse
// XML; the fields hold exactly what the XML calculation used to read.

import { RESOURCE_LIMITS, resourceSnapshot, shouldPauseBackgroundWork } from "./resource-policy.mjs";
import { billFields, voucherFields } from "./receivable-fields.mjs";

const XML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
function escapeXml(value) { return String(value ?? "").replace(/[&<>"']/g, (character) => XML_ESCAPE[character]); }

export const RECEIVABLE_VOUCHER_FIELDS =
  "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,IsCancelled,IsOptional," +
  "AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive," +
  "AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount";
// Same fields and pending-bill rule as the live Cash Discount open-bills read.
const BILL_FIELDS = "Name,Parent,LedgerName,PartyLedgerName,IsAdvance,BillType,TypeOfRef,Date,BillDate,DueDate,VoucherNumber,VoucherTypeName,OpeningBalance,ClosingBalance,Balance,PendingAmount,Amount";
const PENDING_BILL_FORMULA = [
  "(NOT $$IsEmpty:$ClosingBalance AND NOT $$IsEqual:$ClosingBalance:0)",
  "($$IsEmpty:$ClosingBalance AND NOT $$IsEmpty:$PendingAmount AND NOT $$IsEqual:$PendingAmount:0)",
  "($$IsEmpty:$ClosingBalance AND $$IsEmpty:$PendingAmount AND NOT $$IsEmpty:$Balance AND NOT $$IsEqual:$Balance:0)",
].join(" OR ");

const BILL_BATCH_SIZE = 50;
// The first full bill read sizes its batches like the invoice reads: about a
// second of Tally work each.
const MIN_BILL_BATCH_SIZE = 10;
const MAX_BILL_BATCH_SIZE = 200;
// Earlier-year evidence is read per customer, like the deletion re-check.
const OLDER_LEDGER_BATCH_SIZE = 10;
// With little free memory, reads are kept small (a large Tally reply is held
// in memory while it is parsed). Below the agent's minimum the preparation
// waits briefly for memory, then continues with the smallest reads, so a
// 4 GB computer finishes slowly instead of never. Only when memory stays
// critically low does it stop; the saved progress lets it continue later.
const LOW_MEMORY_VOUCHER_WINDOW_DAYS = 7;
const CRITICAL_FREE_BYTES = 300 * 1024 * 1024;
const MEMORY_WAIT_MS = 5_000;
const STORAGE_TIMEOUT_MS = 2 * 60_000;
const MEMORY_MAX_WAIT_MS = 2 * 60_000;
const READ_SIZE = {
  normal: null,
  low: { bills: RESOURCE_LIMITS.lowMemoryBatchSize, days: LOW_MEMORY_VOUCHER_WINDOW_DAYS, older: 1 },
  minimal: { bills: MIN_BILL_BATCH_SIZE, days: 1, older: 1 },
};
// Share of the overall progress bar for each step of the first preparation.
const PROGRESS_SHARE = { start: [0, 2], bills: [2, 40], vouchers: [40, 95], older: [95, 100] };
const CHECK_INTERVAL_MS = 60_000;
// A full open-bill re-check after a suspected deletion is ~30 s of light Tally
// reads on a 6,000-customer company; never run it more often than this.
const FULL_BILL_RECHECK_MIN_INTERVAL_MS = 10 * 60_000;
// Gap between Tally requests so Tally stays responsive for its user.
const PAUSE_BETWEEN_REQUESTS_MS = 300;
// Invoice/receipt reads start at a few days and adapt so each keeps Tally
// busy for roughly one second.
const INITIAL_VOUCHER_WINDOW_DAYS = 3;
const TARGET_TALLY_BUSY_MS = 1_000;
const MAX_VOUCHER_WINDOW_DAYS = 31;
// Change checks read only this many recent days; older edits and deletions
// are caught by the paced deep sweep below.
const RECENT_CHANGE_DAYS = 31;
const DEEP_CHECK_MIN_INTERVAL_MS = 3 * 60 * 60_000;
// Background checks wait 20x the last check's duration (1-15 minutes), and
// pause 30 minutes after Tally failed to answer, so a large company is never
// asked again while it is still struggling.
const CHECK_INTERVAL_FACTOR = 20;
const MAX_CHECK_INTERVAL_MS = 15 * 60_000;
const FAILURE_BACKOFF_MS = 30 * 60_000;

export function nextVoucherWindowDays(days, busyMs) {
  if (busyMs > TARGET_TALLY_BUSY_MS * 2) return Math.max(1, Math.floor(days / 2));
  if (busyMs < TARGET_TALLY_BUSY_MS / 2) return Math.min(MAX_VOUCHER_WINDOW_DAYS, days * 2);
  return days;
}
export function nextBillBatchSize(size, busyMs) {
  if (busyMs > TARGET_TALLY_BUSY_MS * 2) return Math.max(MIN_BILL_BATCH_SIZE, Math.floor(size / 2));
  if (busyMs < TARGET_TALLY_BUSY_MS / 2) return Math.min(MAX_BILL_BATCH_SIZE, size * 2);
  return size;
}
// Position on one bar across all steps; a step's own fraction fills its share.
function overallPercent(stage, fraction, hasOlder) {
  const [from, to] = stage === "vouchers" && !hasOlder ? [40, 100] : PROGRESS_SHARE[stage];
  return Math.round(from + (to - from) * Math.min(1, Math.max(0, fraction)));
}
// Per-step totals of a preparation, kept with the saved progress so a
// continued preparation still reports the whole run.
function tally(resume, step, busyMs, counts = {}) {
  resume.stats ||= {};
  const entry = resume.stats[step] ||= { reads: 0, tallyMs: 0 };
  entry.reads += 1;
  entry.tallyMs += busyMs;
  for (const [key, value] of Object.entries(counts)) entry[key] = (entry[key] || 0) + value;
}
function stepSummary(stats = {}) {
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
  return [
    stats.bills && `bills ${stats.bills.reads} read(s), ${seconds(stats.bills.tallyMs)} in Tally, ${stats.bills.bills || 0} open bill(s)`,
    stats.vouchers && `invoices/receipts ${stats.vouchers.reads} read(s), ${seconds(stats.vouchers.tallyMs)} in Tally, ${stats.vouchers.exported || 0} voucher(s) sent, ${stats.vouchers.kept || 0} kept`,
    stats.older && `earlier-year ${stats.older.reads} read(s), ${seconds(stats.older.tallyMs)} in Tally, ${stats.older.kept || 0} kept`,
  ].filter(Boolean).join("; ");
}
// The customer list of an unfinished preparation (1.2.17-1.2.19 kept it
// inside the saved progress, which is still accepted when continuing).
const debtorsKey = (datasetKey) => `receivable-debtors:${datasetKey}`;
function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}
function minDate(a, b) { return a < b ? a : b; }
function maxDate(a, b) { return a > b ? a : b; }

export function receivableLedgerKey(value) {
  // Same normalisation as the live Cash Discount reader (normalizeLooseName).
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function decode(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function blocks(xml, tagName) {
  return String(xml || "").match(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, "g")) || [];
}
function tag(block, tagName) {
  const match = String(block || "").match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? decode(match[1]).trim() : "";
}
function attribute(block, name) {
  const match = String(block || "").match(new RegExp(`${name}="([^"]*)"`));
  return match ? decode(match[1]) : "";
}
// Same quoting as the live reader (tallyFormulaString in bridge.mjs).
function formulaString(value) { return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
function tallyDate(isoDate) { return String(isoDate || "").replaceAll("-", ""); }
function isoDate(tallyValue) {
  const value = String(tallyValue || "").trim();
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null;
}
const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
// Bill dates come back as 20250415 or 15-Apr-25 depending on the Tally release.
function billDate(block) {
  const value = String(tag(block, "BILLDATE") || tag(block, "DATE")).trim();
  const compact = isoDate(value);
  if (compact) return compact;
  const match = value.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  const month = match && MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${match[1].padStart(2, "0")}`;
}
const isYes = (value) => /^yes$/i.test(String(value || "").trim());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function financialYearRange(financialYear, today = new Date().toISOString().slice(0, 10)) {
  const match = String(financialYear || "").match(/(\d{4})\D+(\d{2,4})/);
  const month = Number(today.slice(5, 7));
  const startYear = match ? Number(match[1]) : month >= 4 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
  return { dateFrom: `${startYear}-04-01`, dateTo: `${startYear + 1}-03-31`, label: `${startYear}-${String(startYear + 1).slice(-2)}` };
}



function envelope(id, companyName, { dateFrom, dateTo } = {}, tdl) {
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${escapeXml(id)}</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    (companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : "") +
    (dateFrom ? `<SVFROMDATE TYPE="Date">${tallyDate(dateFrom)}</SVFROMDATE>` : "") +
    (dateTo ? `<SVTODATE TYPE="Date">${tallyDate(dateTo)}</SVTODATE>` : "") +
    `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>${tdl}</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

export class ReceivablesPreparer {
  constructor({ storage, invoke, onProgress, onLog, onChanged, now = Date.now, resources = resourceSnapshot, wait = sleep, storageTimeoutMs = STORAGE_TIMEOUT_MS }) {
    // Local storage answers in milliseconds; one that has not answered in two
    // minutes is stuck, and waiting on it would leave the check hanging with
    // no message. The operation is reported as failed instead.
    this.storage = {
      call: (operation, payload) => {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Local storage did not respond to ${operation} within ${Math.round(storageTimeoutMs / 1000)} s. Restart Kalika Local Agent and check customer dues again.`)), storageTimeoutMs);
        });
        return Promise.race([storage.call(operation, payload), timeout]).finally(() => clearTimeout(timer));
      },
    };
    this.resources = resources;
    this.wait = wait;
    this.baseInvoke = invoke;
    // A change check requested by a scan already holds the Tally queue, so it
    // passes a direct Tally invoker for the duration of that check.
    // Each read records how long it waited in the Tally queue and how long
    // Tally itself took (this.lastRead), for the per-read log line.
    this.invoke = async (xml, options = {}) => {
      const called = this.now();
      let startedAt = null;
      try {
        return await (this.invokeOverride || this.baseInvoke)(xml, { ...options, onStart: () => { startedAt = this.now(); } });
      } finally {
        const begun = startedAt ?? called;
        this.lastRead = { queueMs: begun - called, tallyMs: this.now() - begun };
      }
    };
    this.onChanged = onChanged;
    this.onProgress = onProgress;
    this.onLog = onLog;
    this.now = now;
    this.running = null;
    this.lastCheckAt = new Map();
    this.lastCheckMs = new Map();
    this.backoffUntil = new Map();
    this.latestProgress = new Map();
  }

  // ---- Tally reads -------------------------------------------------------

  async readCounters(companyName) {
    const xml = await this.invoke(envelope("KalikaReceivableCounters", null, {},
      `<COLLECTION NAME="KalikaReceivableCounters" ISMODIFY="No"><TYPE>Company</TYPE><FETCH>Name,GUID,AltVchID,AltMstID</FETCH></COLLECTION>`), { timeoutMs: 10_000 });
    const company = blocks(xml, "COMPANY").find((block) =>
      receivableLedgerKey(attribute(block, "NAME") || tag(block, "NAME")) === receivableLedgerKey(companyName));
    if (!company) throw new Error(`Tally did not report change counters for ${companyName}.`);
    const altVchId = Number(tag(company, "ALTVCHID") || 0);
    const altMstId = Number(tag(company, "ALTMSTID") || 0);
    if (!Number.isFinite(altVchId) || !Number.isFinite(altMstId)) throw new Error("Tally returned unreadable change counters.");
    return { altVchId, altMstId };
  }

  // Every ledger that keeps bill-wise details. The Cash Discount customer
  // scope can select any group (and optionally "sales-linked" ledgers outside
  // the selected groups), so this is wider than Sundry Debtors; it matches
  // the set of ledgers the live scan can find open bills on.
  async readDebtors(companyName) {
    const xml = await this.invoke(envelope("KalikaReceivableParties", companyName, {},
      `<COLLECTION NAME="KalikaReceivableParties" ISMODIFY="No"><TYPE>Ledger</TYPE><FETCH>Name</FETCH><FILTERS>KalikaReceivableBillWise</FILTERS></COLLECTION>` +
      `<SYSTEM TYPE="Formulae" NAME="KalikaReceivableBillWise">$IsBillWiseOn</SYSTEM>`), { timeoutMs: 60_000 });
    const names = blocks(xml, "LEDGER").map((block) => attribute(block, "NAME") || tag(block, "NAME")).filter(Boolean);
    return [...new Map(names.map((name) => [receivableLedgerKey(name), name])).values()];
  }

  async readBills(companyName, ledgerNames, asOfDate) {
    const members = ledgerNames.map((name, index) =>
      `<COLLECTION NAME="KalikaReceivableBills${index}" ISMODIFY="No"><TYPE>Bills</TYPE><CHILDOF>${escapeXml(formulaString(name))}</CHILDOF>` +
      `<COMPUTE>LedgerName : ${escapeXml(formulaString(name))}</COMPUTE><FILTER>KalikaReceivablePendingBill</FILTER><FETCH>${BILL_FIELDS}</FETCH></COLLECTION>`).join("");
    const union = `<COLLECTION NAME="KalikaReceivableBills" ISMODIFY="No"><COLLECTIONS>${ledgerNames.map((_, index) => `KalikaReceivableBills${index}`).join(",")}</COLLECTIONS><FETCH>${BILL_FIELDS}</FETCH></COLLECTION>`;
    const formula = `<SYSTEM TYPE="Formulae" NAME="KalikaReceivablePendingBill" ISMODIFY="No">${escapeXml(PENDING_BILL_FORMULA)}</SYSTEM>`;
    // No SVFROMDATE, like the live read: carry-forward bills stay visible.
    const xml = await this.invoke(envelope("KalikaReceivableBills", companyName, { dateTo: asOfDate }, members + formula + union), { timeoutMs: 60_000 });
    const byLedger = Object.fromEntries(ledgerNames.map((name) => [receivableLedgerKey(name), []]));
    for (const block of blocks(xml, "BILL")) {
      const ledgerName = tag(block, "LEDGERNAME") || tag(block, "PARTYLEDGERNAME") || tag(block, "PARENT");
      const key = receivableLedgerKey(ledgerName);
      if (!byLedger[key]) continue;
      const billName = attribute(block, "NAME") || tag(block, "NAME");
      byLedger[key].push({ key: `${billName}|${tag(block, "BILLDATE") || tag(block, "DATE")}|${byLedger[key].length}`, fields: billFields(block), date: billDate(block) });
    }
    return byLedger;
  }

  async readVouchers(companyName, { dateFrom, dateTo, afterAlterId = null }) {
    const filter = afterAlterId === null ? "" :
      `<FILTERS>KalikaReceivableAfterAlter</FILTERS>`;
    const formula = afterAlterId === null ? "" :
      `<SYSTEM TYPE="Formulae" NAME="KalikaReceivableAfterAlter">$AlterID &gt; ${Math.max(0, Number(afterAlterId) || 0)}</SYSTEM>`;
    const xml = await this.invoke(envelope("KalikaReceivableVouchers", companyName, { dateFrom, dateTo },
      `<COLLECTION NAME="KalikaReceivableVouchers" ISMODIFY="No"><TYPE>Voucher</TYPE><FETCH>${RECEIVABLE_VOUCHER_FIELDS}</FETCH>${filter}</COLLECTION>${formula}`), { timeoutMs: 180_000 });
    return blocks(xml, "VOUCHER");
  }

  // All vouchers of the given customers (same per-customer request the live
  // Cash Discount read uses). Tally ignores the date range on this request,
  // so the date window is applied here and repeats are removed.
  async readVouchersForLedgers(companyName, ledgerNames, { dateFrom, dateTo }, debtorKeys) {
    const members = ledgerNames.map((name, index) =>
      `<COLLECTION NAME="KalikaReceivableLedger${index}" ISMODIFY="No"><TYPE>Vouchers : Ledger</TYPE><CHILDOF>${escapeXml(formulaString(name))}</CHILDOF><FETCH>${RECEIVABLE_VOUCHER_FIELDS}</FETCH></COLLECTION>`).join("");
    const union = `<COLLECTION NAME="KalikaReceivableLedgers" ISMODIFY="No"><COLLECTIONS>${ledgerNames.map((_, index) => `KalikaReceivableLedger${index}`).join(",")}</COLLECTIONS><FETCH>${RECEIVABLE_VOUCHER_FIELDS}</FETCH></COLLECTION>`;
    const xml = await this.invoke(envelope("KalikaReceivableLedgers", companyName, { dateFrom, dateTo }, members + union), { timeoutMs: 120_000 });
    const byMasterId = new Map();
    for (const block of blocks(xml, "VOUCHER")) {
      const voucher = this.customerVoucher(block, debtorKeys);
      if (!voucher.ledgerKeys.length) continue;
      if (voucher.date && ((dateFrom && voucher.date < dateFrom) || (dateTo && voucher.date > dateTo))) continue;
      byMasterId.set(voucher.masterId, voucher);
    }
    return [...byMasterId.values()];
  }

  // Tally returns ~60 fields per voucher; only these are used by the Cash
  // Discount / Follow-up calculation. Fields are read from this trimmed copy,
  // exactly as the XML calculation read it, so nested lists we do not use
  // can never change a value.
  compactVoucher(block) {
    const raw = (source, name) => String(source).match(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>|<${name}\\b[^>]*\\/>`))?.[0] || "";
    const opening = String(block).match(/^<VOUCHER\b[^>]*>/)?.[0] || "<VOUCHER>";
    const fields = ["DATE", "EFFECTIVEDATE", "VOUCHERTYPENAME", "VOUCHERNUMBER", "REFERENCE", "NARRATION", "PARTYLEDGERNAME", "MASTERID", "ALTERID", "GUID", "ISCANCELLED", "ISOPTIONAL"]
      .map((name) => raw(block, name)).join("");
    const entries = blocks(block, "ALLLEDGERENTRIES.LIST").map((entry) =>
      "<ALLLEDGERENTRIES.LIST>" + ["LEDGERNAME", "ISDEEMEDPOSITIVE", "AMOUNT"].map((name) => raw(entry, name)).join("") +
      blocks(entry, "BILLALLOCATIONS.LIST").map((allocation) =>
        "<BILLALLOCATIONS.LIST>" + ["NAME", "BILLTYPE", "AMOUNT"].map((name) => raw(allocation, name)).join("") + "</BILLALLOCATIONS.LIST>").join("") +
      "</ALLLEDGERENTRIES.LIST>").join("");
    return `${opening}${fields}${entries}</VOUCHER>`;
  }

  // Vouchers are kept only if they touch a customer ledger. Cancelled and
  // optional vouchers do not affect dues; returning no ledgers also removes
  // one that was stored before it was cancelled.
  customerVoucher(block, debtorKeys) {
    const ledgerKeys = new Set();
    const counts = !isYes(tag(block, "ISCANCELLED")) && !isYes(tag(block, "ISOPTIONAL"));
    for (const name of counts ? [tag(block, "PARTYLEDGERNAME"), ...blocks(block, "ALLLEDGERENTRIES.LIST").map((entry) => tag(entry, "LEDGERNAME"))] : []) {
      const key = receivableLedgerKey(name);
      if (key && debtorKeys.has(key)) ledgerKeys.add(key);
    }
    return {
      masterId: tag(block, "MASTERID") || tag(block, "GUID") || `${tag(block, "DATE")}|${tag(block, "VOUCHERNUMBER")}|${tag(block, "VOUCHERTYPENAME")}`,
      alterId: Number(tag(block, "ALTERID") || 0),
      date: isoDate(tag(block, "DATE")),
      fields: ledgerKeys.size ? voucherFields(this.compactVoucher(block)) : null,
      ledgerKeys: [...ledgerKeys],
    };
  }

  // ---- Preparation -------------------------------------------------------

  progress(datasetKey, value) {
    // Kept for the heartbeat, so a long first check can be followed remotely.
    this.latestProgress.set(datasetKey, { ...value, at: new Date(this.now()).toISOString() });
    this.onProgress?.({ operation: "receivables", localUi: true, datasetKey, ...value });
  }

  // Where one read's time went: memory check, Tally queue, Tally, parsing,
  // storing, saving progress, and the pause before the next read.
  #stopwatch() {
    let mark = this.now();
    const parts = {};
    const seconds = (ms) => `${((ms || 0) / 1000).toFixed(1)}`;
    return {
      lap: (name) => { const at = this.now(); parts[name] = (parts[name] || 0) + at - mark; mark = at; },
      read: ({ queueMs = 0, tallyMs = 0 } = {}) => {
        const at = this.now();
        Object.assign(parts, { queue: queueMs, tally: tallyMs, parse: Math.max(0, at - mark - queueMs - tallyMs) });
        mark = at;
      },
      summary: (pauseMs) => `Tally ${seconds(parts.tally)} s, queue ${seconds(parts.queue)} s, parse ${seconds(parts.parse)} s, store ${seconds(parts.store)} s, save ${seconds(parts.save)} s, check ${seconds(parts.check)} s, pause ${seconds(pauseMs)} s`,
    };
  }

  // Before each Tally read: returns the read size to use ("normal", "low" or
  // "minimal"). Below the agent's minimum it first waits up to two minutes
  // for memory to come back; if memory stays critically low it stops.
  async #memoryCheck(datasetKey, progress) {
    let waitedMs = 0;
    // Waits once per preparation; after that a small computer carries on at
    // the smallest read size instead of waiting before every read.
    while (!this.memoryWaitDone && shouldPauseBackgroundWork(this.resources()) && waitedMs < MEMORY_MAX_WAIT_MS) {
      if (!waitedMs) this.onLog?.("warn", "Customer dues waiting: this computer is low on free memory.");
      this.progress(datasetKey, { ...progress, waitingForMemory: true });
      await this.wait(MEMORY_WAIT_MS);
      waitedMs += MEMORY_WAIT_MS;
    }
    if (waitedMs >= MEMORY_MAX_WAIT_MS) this.memoryWaitDone = true;
    const free = this.resources().freeSystemBytes;
    if (free < CRITICAL_FREE_BYTES) {
      throw new Error("Paused: this computer does not have enough free memory. Close other programs, then check customer dues again to continue.");
    }
    const mode = free < RESOURCE_LIMITS.minimumFreeBytes ? "minimal" : free < RESOURCE_LIMITS.lowMemoryBytes ? "low" : "normal";
    if (mode === "minimal" && !this.slowNoticeLogged) {
      this.slowNoticeLogged = true;
      this.onLog?.("warn", "Customer dues continuing slowly: this computer has little free memory, so Tally is read in the smallest steps.");
    } else if (waitedMs && mode !== "minimal") {
      this.onLog?.("info", "Customer dues continuing: free memory is available again.");
    }
    return mode;
  }

  // Full preparation for the active company and current financial year.
  // An interrupted preparation continues where it stopped unless fresh=true.
  prepare(identity, datasetKey, { fresh = false } = {}) {
    if (this.running) return this.running;
    this.running = this.#prepare(identity, datasetKey, { fresh }).finally(() => { this.running = null; });
    return this.running;
  }

  async #prepare(identity, datasetKey, { fresh = false } = {}) {
    const companyName = identity.companyName;
    const range = financialYearRange(identity.financialYear);
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const previous = await this.storage.call("getReceivableState", { datasetKey });
    this.memoryWaitDone = false;
    this.slowNoticeLogged = false;
    // Progress is saved after every Tally read, so a timeout or a closed
    // connector does not make Tally export everything again.
    const saved = previous?.resume;
    const matches = !fresh && previous?.status !== "ready" && saved?.companyName === companyName && saved?.financialYear === range.label;
    // Past the customer list, continuing needs that list; without it, start over.
    const savedDebtors = matches && saved.stage !== "start" && !saved.debtors
      ? await this.storage.call("getSetting", { key: debtorsKey(datasetKey), fallback: null })
      : null;
    // Stopped before the customer list was read: nothing to keep, start over.
    const resuming = matches && saved.stage !== "start" && (Array.isArray(saved.debtors) || savedDebtors?.length === saved.debtorCount);
    const resume = resuming ? { ...saved } : {
      companyName, financialYear: range.label, startedAt: new Date(this.now()).toISOString(),
      stage: "start", billOffset: 0, billBatchSize: BILL_BATCH_SIZE, voucherCursor: range.dateFrom, windowDays: INITIAL_VOUCHER_WINDOW_DAYS,
      earliestBillDate: null, olderLedgers: [], olderOffset: 0,
    };
    resume.billBatchSize ||= BILL_BATCH_SIZE;
    const save = (status = "preparing") => this.storage.call("putReceivableState", { datasetKey, state: { status, resume, lastError: null } });
    // One bar for the whole preparation. Each step reports before and after
    // every read, so the bar never goes back and never jumps at the end.
    const report = (stage, phase, processed, total, extra = {}) => {
      const value = { phase, processed, total, overall: overallPercent(stage, total ? processed / total : 0, resume.olderLedgers.length > 0), ...extra };
      this.progress(datasetKey, value);
      return value;
    };
    try {
      await save();
      if (resuming) this.onLog?.("info", `Customer dues check continuing for ${companyName} from the ${resume.stage} step.`);
      if (resume.stage === "start") {
        await this.#memoryCheck(datasetKey, report("start", "checking_company", 0, null));
        // Record the counters first: anything changed while we read is picked
        // up by the next change check.
        this.onLog?.("info", `Customer dues check started for ${companyName} (FY ${range.label}).`);
        resume.counters = await this.readCounters(companyName);
        const listStarted = this.now();
        const found = await this.readDebtors(companyName);
        this.onLog?.("info", `Customer dues: ${found.length} bill-wise ledger(s) found in ${((this.now() - listStarted) / 1000).toFixed(1)} s.`);
        // Saved once, apart from the progress that is saved after every read.
        await this.storage.call("setSetting", { key: debtorsKey(datasetKey), value: found });
        resume.debtorCount = found.length;
        const clearStarted = this.now();
        await this.storage.call("clearReceivables", { datasetKey });
        this.onLog?.("info", `Customer dues: previous dues cleared in ${((this.now() - clearStarted) / 1000).toFixed(1)} s.`);
        resume.stage = "bills";
        await save();
      }
      const debtors = resume.debtors || savedDebtors || await this.storage.call("getSetting", { key: debtorsKey(datasetKey), fallback: [] });
      const debtorKeys = new Set(debtors.map(receivableLedgerKey));

      if (resume.stage === "bills") {
        const olderLedgers = new Set(resume.olderLedgers);
        while (resume.billOffset < debtors.length) {
          const time = this.#stopwatch();
          const limit = READ_SIZE[await this.#memoryCheck(datasetKey, report("bills", "checking_customer_bills", resume.billOffset, debtors.length))];
          time.lap("check");
          const size = limit ? Math.min(resume.billBatchSize, limit.bills) : resume.billBatchSize;
          const batch = debtors.slice(resume.billOffset, resume.billOffset + size);
          const byLedger = await this.readBills(companyName, batch, today);
          time.read(this.lastRead);
          const busyMs = this.lastRead.tallyMs;
          await this.storage.call("replaceReceivableBills", { datasetKey, byLedger });
          time.lap("store");
          // Bills still open from earlier years need their invoice and
          // receipts too, which lie before this financial year.
          for (const name of batch) {
            for (const bill of byLedger[receivableLedgerKey(name)] || []) {
              const date = bill.date;
              if (!date || date >= range.dateFrom) continue;
              olderLedgers.add(name);
              if (!resume.earliestBillDate || date < resume.earliestBillDate) resume.earliestBillDate = date;
            }
          }
          resume.olderLedgers = [...olderLedgers];
          const billCount = Object.values(byLedger).reduce((sum, bills) => sum + bills.length, 0);
          tally(resume, "bills", busyMs, { bills: billCount });
          resume.billOffset += batch.length;
          resume.billBatchSize = nextBillBatchSize(resume.billBatchSize, busyMs);
          time.lap("store");
          await save();
          time.lap("save");
          report("bills", "checking_customer_bills", resume.billOffset, debtors.length);
          const pauseMs = Math.max(PAUSE_BETWEEN_REQUESTS_MS, Math.min(3_000, busyMs));
          this.onLog?.("info", `Customer dues bills ${resume.billOffset - batch.length + 1}-${resume.billOffset} of ${debtors.length} (${batch.length} ledgers): ${billCount} open bill(s); ${time.summary(pauseMs)}; next batch ${resume.billBatchSize}.`);
          await sleep(pauseMs);
        }
        resume.stage = "vouchers";
        await save();
        this.onLog?.("info", `Customer dues: open bills done, ${stepSummary({ bills: resume.stats?.bills })}; ${resume.olderLedgers.length} customer(s) have bills from before ${range.dateFrom}.`);
      }

      // Tally cannot answer its user while it exports, and voucher volume per
      // day varies widely (one month took 12 s, a busy week 26 s, two days
      // under 1 s). Size each read so Tally is busy for about a second, then
      // give it an idle gap before the next read.
      const lastDate = range.dateTo < today ? range.dateTo : today;
      if (resume.stage === "vouchers") {
        const totalDays = daysBetween(range.dateFrom, lastDate) + 1;
        while (resume.voucherCursor <= lastDate) {
          const time = this.#stopwatch();
          const limit = READ_SIZE[await this.#memoryCheck(datasetKey,
            report("vouchers", "checking_invoices_and_receipts", daysBetween(range.dateFrom, resume.voucherCursor), totalDays, { month: resume.voucherCursor }))];
          const days = limit ? Math.min(resume.windowDays, limit.days) : resume.windowDays;
          const windowEnd = minDate(addDays(resume.voucherCursor, days - 1), lastDate);
          time.lap("check");
          const exported = await this.readVouchers(companyName, { dateFrom: resume.voucherCursor, dateTo: windowEnd });
          const vouchers = exported
            .map((block) => this.customerVoucher(block, debtorKeys))
            .filter((voucher) => voucher.ledgerKeys.length);
          time.read(this.lastRead);
          const busyMs = this.lastRead.tallyMs;
          await this.storage.call("upsertReceivableVouchers", { datasetKey, vouchers });
          time.lap("store");
          const nextDays = nextVoucherWindowDays(days, busyMs);
          tally(resume, "vouchers", busyMs, { exported: exported.length, kept: vouchers.length });
          const windowStart = resume.voucherCursor;
          resume.voucherCursor = addDays(windowEnd, 1);
          resume.windowDays = nextDays;
          await save();
          time.lap("save");
          report("vouchers", "checking_invoices_and_receipts", daysBetween(range.dateFrom, minDate(resume.voucherCursor, addDays(lastDate, 1))), totalDays, { month: windowEnd });
          const pauseMs = Math.max(PAUSE_BETWEEN_REQUESTS_MS, Math.min(3_000, busyMs));
          // One line per read, so the window sizing can be followed on a
          // client's data: dates, what Tally sent, what was kept, where the time went.
          this.onLog?.("info", `Customer dues invoices ${windowStart} to ${windowEnd} (${daysBetween(windowStart, windowEnd) + 1} day(s)): Tally sent ${exported.length} voucher(s), kept ${vouchers.length} for customers; ${time.summary(pauseMs)}; next read ${nextDays} day(s)${limit ? " (low memory)" : ""}.`);
          await sleep(pauseMs);
        }
        resume.stage = "older";
        await save();
        this.onLog?.("info", `Customer dues: invoices and receipts done, ${stepSummary({ vouchers: resume.stats?.vouchers })}.`);
      }

      // Earlier-year invoices and receipts, only for customers who still have
      // a bill open from then (the same per-customer read the live scan uses).
      const evidenceFrom = resume.earliestBillDate && resume.earliestBillDate < range.dateFrom ? resume.earliestBillDate : range.dateFrom;
      if (resume.stage === "older") {
        const olderRange = { dateFrom: evidenceFrom, dateTo: addDays(range.dateFrom, -1) };
        while (evidenceFrom < range.dateFrom && resume.olderOffset < resume.olderLedgers.length) {
          const limit = READ_SIZE[await this.#memoryCheck(datasetKey, report("older", "checking_older_invoices", resume.olderOffset, resume.olderLedgers.length))];
          const batch = resume.olderLedgers.slice(resume.olderOffset, resume.olderOffset + (limit ? limit.older : OLDER_LEDGER_BATCH_SIZE));
          const started = this.now();
          const vouchers = await this.readVouchersForLedgers(companyName, batch, olderRange, debtorKeys);
          const busyMs = this.now() - started;
          await this.storage.call("upsertReceivableVouchers", { datasetKey, vouchers });
          tally(resume, "older", busyMs, { kept: vouchers.length });
          resume.olderOffset += batch.length;
          await save();
          report("older", "checking_older_invoices", resume.olderOffset, resume.olderLedgers.length);
          await sleep(PAUSE_BETWEEN_REQUESTS_MS);
        }
      }

      const counts = await this.storage.call("receivableCounts", { datasetKey });
      const now = new Date(this.now()).toISOString();
      const state = {
        status: "ready", companyName, financialYear: range.label, dateFrom: range.dateFrom, dateTo: range.dateTo, evidenceFrom,
        watermark: resume.counters.altVchId, masterWatermark: resume.counters.altMstId,
        debtors, preparedAt: now, checkedAt: now, lastFullBillCheckAt: now, counts,
        // Bills read before an interruption may be out of date; the next
        // background check re-reads every customer's bills.
        ...(resuming ? { pendingFullBillCheck: true, deepCheckFromAlterId: resume.counters.altVchId, lastFullBillCheckAt: resume.startedAt } : {}),
      };
      await this.storage.call("putReceivableState", { datasetKey, state });
      await this.storage.call("setSetting", { key: debtorsKey(datasetKey), value: null });
      this.onChanged?.(datasetKey, state);
      this.progress(datasetKey, { phase: "complete", processed: 1, total: 1, overall: 100 });
      this.onLog?.("info", `Customer dues ready for ${companyName}: ${counts.customersWithBills} customers with open bills, ${counts.vouchers} invoices and receipts${resuming ? " (continued after an interruption)" : ""}.`);
      this.onLog?.("info", `Customer dues took ${((this.now() - Date.parse(resume.startedAt)) / 1000).toFixed(0)} s from the start: ${stepSummary(resume.stats)}.`);
      return this.publicState(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Log and tell the window first: if local storage is what failed,
      // saving the failure below can fail too, and the window must not be
      // left showing "Checking…".
      this.onLog?.("error", `Customer dues check stopped at the ${resume.stage} step: ${message}`);
      this.progress(datasetKey, { phase: "failed", processed: 0, total: null, error: message });
      // Stored data is partial now, so it is never reported as ready; scans
      // read Tally live until the preparation is continued.
      await this.storage.call("putReceivableState", { datasetKey, state: { status: "failed", resume, lastError: message } })
        .catch((saveError) => this.onLog?.("error", `Customer dues could not save the stopped state: ${saveError.message}`));
      throw error;
    }
  }

  // ---- Keeping current ---------------------------------------------------

  // Called frequently (every heartbeat); checks Tally at most once a minute.
  // allowFullCheck=false (used before a scan) applies only the quick delta and
  // leaves any full customer re-check to the next background run, so a scan
  // never waits minutes for it.
  async checkForChanges(identity, datasetKey, { force = false, invoke = null, allowFullCheck = true } = {}) {
    if (this.running) return null;
    // After Tally failed to answer, even a scan uses the data it has.
    if (this.now() < (this.backoffUntil.get(datasetKey) || 0)) return null;
    const last = this.lastCheckAt.get(datasetKey) || 0;
    const interval = Math.min(MAX_CHECK_INTERVAL_MS, Math.max(CHECK_INTERVAL_MS, (this.lastCheckMs.get(datasetKey) || 0) * CHECK_INTERVAL_FACTOR));
    if (!force && this.now() - last < interval) return null;
    this.lastCheckAt.set(datasetKey, this.now());
    const state = await this.storage.call("getReceivableState", { datasetKey });
    if (state?.status !== "ready") return null;
    this.invokeOverride = invoke;
    const started = this.now();
    this.running = this.#applyChanges(identity, datasetKey, state, { allowFullCheck })
      .then((result) => {
        this.lastCheckMs.set(datasetKey, this.now() - started);
        this.backoffUntil.delete(datasetKey);
        return result;
      }, (error) => {
        this.lastCheckMs.set(datasetKey, this.now() - started);
        this.backoffUntil.set(datasetKey, this.now() + FAILURE_BACKOFF_MS);
        this.onLog?.("warn", `Customer dues check paused for 30 minutes after Tally did not answer (${error instanceof Error ? error.message : error}).`);
        throw error;
      })
      .finally(() => { this.running = null; this.invokeOverride = null; });
    return this.running;
  }

  // Changed vouchers (AlterID above the given value) dated within the range,
  // read in slices sized to about a second of Tally work with idle gaps, so a
  // large company is never asked to scan its whole year in one request.
  async #readChangedVouchers(companyName, dateFrom, dateTo, afterAlterId) {
    const found = [];
    let cursor = dateFrom, windowDays = INITIAL_VOUCHER_WINDOW_DAYS, requests = 0;
    while (cursor <= dateTo) {
      const windowEnd = minDate(addDays(cursor, windowDays - 1), dateTo);
      const started = this.now();
      found.push(...await this.readVouchers(companyName, { dateFrom: cursor, dateTo: windowEnd, afterAlterId }));
      const busyMs = this.now() - started;
      requests += 1;
      cursor = addDays(windowEnd, 1);
      windowDays = nextVoucherWindowDays(windowDays, busyMs);
      if (cursor <= dateTo) await sleep(Math.max(PAUSE_BETWEEN_REQUESTS_MS, Math.min(3_000, busyMs)));
    }
    return { blocks: found, requests };
  }

  async #applyChanges(identity, datasetKey, state, { allowFullCheck = true } = {}) {
    const companyName = identity.companyName;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const counters = await this.readCounters(companyName);
    let debtors = state.debtors || [];
    if (counters.altVchId < Number(state.watermark || 0)) {
      // Counters went backwards: the company was restored from a backup.
      this.onLog?.("info", "Tally company data was restored; checking customer dues again.");
      return this.#prepare(identity, datasetKey);
    }
    if (counters.altMstId !== Number(state.masterWatermark || 0)) {
      debtors = await this.readDebtors(companyName);
    }
    const debtorKeys = new Set(debtors.map(receivableLedgerKey));
    const nameByKey = new Map(debtors.map((name) => [receivableLedgerKey(name), name]));
    const moved = counters.altVchId - Number(state.watermark || 0);
    const checkStarted = this.now();
    const next = { ...state, debtors, masterWatermark: counters.altMstId, checkedAt: new Date(this.now()).toISOString() };
    const fullCheckIntervalElapsed = this.now() - Date.parse(state.lastFullBillCheckAt || 0) >= Math.max(FULL_BILL_RECHECK_MIN_INTERVAL_MS, DEEP_CHECK_MIN_INTERVAL_MS);
    const deepFrom = state.deepCheckFromAlterId ?? null;
    // The deep sweep and full bill re-check run together, in the background
    // only, when something could not be found in the recent days.
    const deepPending = allowFullCheck && fullCheckIntervalElapsed && (deepFrom !== null || state.pendingFullBillCheck === true);
    if (moved <= 0 && !deepPending) {
      await this.storage.call("putReceivableState", { datasetKey, state: next });
      return { changed: 0 };
    }

    const range = { dateFrom: state.dateFrom, dateTo: state.dateTo };
    const recentFrom = maxDate(range.dateFrom, addDays(minDate(range.dateTo, today), -(RECENT_CHANGE_DAYS - 1)));
    const recent = moved > 0 ? await this.#readChangedVouchers(companyName, recentFrom, range.dateTo, state.watermark) : { blocks: [], requests: 0 };
    // Fewer found in the recent days than the counter moved: an older voucher
    // was edited, or one was deleted. Both are settled by the deep sweep,
    // which reads older edits from the oldest position not yet accounted for.
    const suspectedDeletion = recent.blocks.length < moved;
    const deepCheckDue = deepPending || (allowFullCheck && fullCheckIntervalElapsed && suspectedDeletion);
    const deep = deepCheckDue && recentFrom > range.dateFrom
      ? await this.#readChangedVouchers(companyName, range.dateFrom, addDays(recentFrom, -1), Math.min(deepFrom ?? state.watermark, state.watermark))
      : { blocks: [], requests: 0 };
    const blocksChanged = [...recent.blocks, ...deep.blocks];
    const vouchers = blocksChanged.map((block) => this.customerVoucher(block, debtorKeys));
    const affected = new Set(vouchers.flatMap((voucher) => voucher.ledgerKeys));
    // An edit can move a voucher away from a customer; re-check that one too.
    for (const voucher of vouchers) {
      for (const key of await this.storage.call("listReceivableVoucherLedgerKeys", { datasetKey, masterId: voucher.masterId })) affected.add(key);
    }
    await this.storage.call("upsertReceivableVouchers", { datasetKey, vouchers });

    // Fewer changed vouchers than the counter moved means something was
    // deleted (Tally cannot report deleted vouchers). Re-check every
    // customer's open bills, at most every 10 minutes.
    const fullCheckDue = deepCheckDue;
    const ledgersToCheck = fullCheckDue ? debtors : [...affected].map((key) => nameByKey.get(key)).filter(Boolean);
    const billsChanged = [];
    for (let offset = 0; offset < ledgersToCheck.length; offset += BILL_BATCH_SIZE) {
      const batch = ledgersToCheck.slice(offset, offset + BILL_BATCH_SIZE);
      const byLedger = await this.readBills(companyName, batch, today);
      if (fullCheckDue) {
        // Remember which customers' bills actually changed: after a deletion
        // those are the customers whose vouchers must be read again.
        const before = new Map();
        for (const row of await this.storage.call("listReceivableBills", { datasetKey, ledgerKeys: Object.keys(byLedger) })) {
          before.set(row.ledgerKey, [...(before.get(row.ledgerKey) || []), row.fields]);
        }
        for (const [key, bills] of Object.entries(byLedger)) {
          const was = (before.get(key) || []).sort().join("\n");
          const now = bills.map((bill) => JSON.stringify(bill.fields)).sort().join("\n");
          if (was !== now) billsChanged.push(key);
        }
      }
      await this.storage.call("replaceReceivableBills", { datasetKey, byLedger });
      if (fullCheckDue) await sleep(PAUSE_BETWEEN_REQUESTS_MS);
    }
    // Deleted vouchers cannot be listed by Tally, so re-read the vouchers of
    // every customer whose bills changed and replace their set; the deleted
    // ones drop out. (A deleted receipt that was never allocated to a bill
    // does not change bills; the weekly full check covers that case.)
    const voucherRecheck = [...new Set(billsChanged)].map((key) => nameByKey.get(key)).filter(Boolean);
    for (let offset = 0; offset < voucherRecheck.length; offset += 10) {
      const batch = voucherRecheck.slice(offset, offset + 10);
      // From the earliest open bill, so earlier-year evidence is kept.
      const fresh = await this.readVouchersForLedgers(companyName, batch, { dateFrom: state.evidenceFrom || range.dateFrom, dateTo: range.dateTo }, debtorKeys);
      await this.storage.call("replaceReceivableVouchersForLedgers", { datasetKey, ledgerKeys: batch.map(receivableLedgerKey), vouchers: fresh });
      await sleep(PAUSE_BETWEEN_REQUESTS_MS);
    }

    next.watermark = counters.altVchId;
    if (fullCheckDue) {
      next.lastFullBillCheckAt = new Date(this.now()).toISOString();
      next.pendingFullBillCheck = false;
      next.deepCheckFromAlterId = null;
    }
    if (suspectedDeletion && !fullCheckDue) {
      next.pendingFullBillCheck = true;
      next.deepCheckFromAlterId = Math.min(deepFrom ?? state.watermark, state.watermark);
    } else if (!fullCheckDue && (state.pendingFullBillCheck === true || deepFrom !== null)) {
      next.pendingFullBillCheck = true;
      next.deepCheckFromAlterId = deepFrom ?? state.watermark;
    }
    next.lastCheckMs = this.now() - checkStarted;
    next.lastCheckRequests = recent.requests + deep.requests;
    next.counts = await this.storage.call("receivableCounts", { datasetKey });
    next.lastChangeAt = new Date(this.now()).toISOString();
    await this.storage.call("putReceivableState", { datasetKey, state: next });
    this.onChanged?.(datasetKey, next);
    this.onLog?.("info", `Customer dues updated: ${vouchers.length} changed voucher(s), ${ledgersToCheck.length} customer(s) re-checked${fullCheckDue ? `, deep check done, ${voucherRecheck.length} with changed bills after a deletion` : ""} in ${(next.lastCheckMs / 1000).toFixed(1)} s (${next.lastCheckRequests} Tally voucher reads).`);
    return { changed: vouchers.length, customersChecked: ledgersToCheck.length, fullCheck: fullCheckDue, customersWithChangedBills: voucherRecheck.length };
  }

  // ---- Reading -----------------------------------------------------------

  publicState(state) {
    if (!state) return { status: "not_prepared" };
    const { debtors, resume, ...rest } = state;
    // The heartbeat carries this, so only a small summary of saved progress.
    const resumable = resume && state.status !== "ready"
      ? { resumable: { stage: resume.stage, startedAt: resume.startedAt, billsChecked: resume.billOffset, customers: resume.debtorCount ?? resume.debtors?.length ?? null, invoicesUpTo: resume.voucherCursor } }
      : {};
    return { ...rest, ...resumable, customerCount: Array.isArray(debtors) ? debtors.length : resume?.debtorCount ?? resume?.debtors?.length ?? 0 };
  }

  async status(datasetKey) {
    const state = this.publicState(await this.storage.call("getReceivableState", { datasetKey }));
    // "preparing" saved by a check that is no longer running (the connector
    // was closed or restarted during it) is shown as stopped, so the window
    // offers to continue instead of showing "Checking…" forever.
    if (state.status === "preparing" && !this.running) {
      return { ...state, status: "failed", lastError: state.lastError || "The check stopped when the connector was closed. Click Check customer dues to continue." };
    }
    const progress = this.latestProgress.get(datasetKey);
    return state.status === "preparing" && progress ? { ...state, progress } : state;
  }

  // The whole dataset as fields, for a scan. recordsFor() on it answers
  // exactly like the per-customer recordsFor() below, from memory. It is kept
  // until the dues change (a new preparation or an applied Tally change), so
  // repeat scans do not load anything.
  async loadSnapshot(datasetKey) {
    const state = await this.storage.call("getReceivableState", { datasetKey });
    const revision = `${state?.preparedAt || ""}|${state?.lastChangeAt || ""}|${state?.watermark ?? ""}`;
    const cached = this.snapshotCache?.get(datasetKey);
    if (cached?.revision === revision) return cached.snapshot;
    const snapshot = await this.#readSnapshot(datasetKey);
    this.snapshotCache ||= new Map();
    // One company at a time: the previous one's memory is released.
    this.snapshotCache.clear();
    this.snapshotCache.set(datasetKey, { revision, snapshot });
    return snapshot;
  }

  async #readSnapshot(datasetKey) {
    const { bills, vouchers, links } = await this.storage.call("listAllReceivableRecords", { datasetKey });
    const billsByLedger = new Map();
    for (const bill of bills) {
      if (!billsByLedger.has(bill.ledgerKey)) billsByLedger.set(bill.ledgerKey, []);
      billsByLedger.get(bill.ledgerKey).push({ billKey: bill.billKey, fields: JSON.parse(bill.fields) });
    }
    // Same order as the primary-key lookup: bill key, compared as bytes.
    for (const list of billsByLedger.values()) {
      list.sort((a, b) => Buffer.compare(Buffer.from(String(a.billKey)), Buffer.from(String(b.billKey))));
    }
    const voucherById = new Map(vouchers.map((voucher) => [voucher.masterId, { date: voucher.date, fields: JSON.parse(voucher.fields) }]));
    const masterIdsByLedger = new Map();
    for (const link of links) {
      if (!masterIdsByLedger.has(link.ledgerKey)) masterIdsByLedger.set(link.ledgerKey, []);
      masterIdsByLedger.get(link.ledgerKey).push(link.masterId);
    }
    const allBills = [...billsByLedger.values()].flat().map((bill) => bill.fields);
    return {
      recordsFor(ledgerNames, { dateFrom = null, dateTo = null } = {}) {
        const ledgerKeys = [...new Set(ledgerNames.map(receivableLedgerKey).filter(Boolean))];
        const bills = ledgerKeys.flatMap((key) => (billsByLedger.get(key) || []).map((bill) => bill.fields));
        const seen = new Set();
        const vouchers = [];
        for (const key of ledgerKeys) {
          for (const masterId of masterIdsByLedger.get(key) || []) {
            const voucher = voucherById.get(masterId);
            if (!voucher || seen.has(masterId)) continue;
            if (dateFrom && voucher.date && voucher.date < dateFrom) continue;
            if (dateTo && voucher.date && voucher.date > dateTo) continue;
            seen.add(masterId);
            vouchers.push(voucher.fields);
          }
        }
        return { bills, vouchers };
      },
      // Every stored bill, in the same order a scan has always read them.
      allBills() {
        return allBills;
      },
    };
  }

  async recordsFor(datasetKey, ledgerNames, { dateFrom = null, dateTo = null } = {}) {
    const ledgerKeys = [...new Set(ledgerNames.map(receivableLedgerKey).filter(Boolean))];
    const [bills, vouchers] = await Promise.all([
      this.storage.call("listReceivableBills", { datasetKey, ledgerKeys }),
      this.storage.call("listReceivableVouchers", { datasetKey, ledgerKeys, dateFrom, dateTo }),
    ]);
    return { bills: bills.map((bill) => JSON.parse(bill.fields)), vouchers: vouchers.map((fields) => JSON.parse(fields)) };
  }
}

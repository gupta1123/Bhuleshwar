import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalAgentStorage } from "./storage.mjs";
import { ReceivablesPreparer, financialYearRange, receivableLedgerKey } from "./receivables.mjs";

// A tiny in-memory Tally: parties with bills, vouchers with AlterIDs, and the
// company change counter. Responds to the request shapes ReceivablesPreparer sends.
function fakeTally() {
  const tally = {
    altVchId: 0, altMstId: 10,
    parties: ["Apex Traders", "Balaji Stores"],
    bills: { "Apex Traders": [{ name: "INV-1", closing: "-1000.00" }], "Balaji Stores": [{ name: "INV-2", closing: "-2000.00" }] },
    vouchers: [],
    requests: [],
    voucherRanges: [],
    failNext: false,
    addVoucher(voucher) { tally.altVchId += 1; tally.vouchers.push({ ...voucher, alterId: tally.altVchId }); },
    editVoucher(masterId, changes) { tally.altVchId += 1; Object.assign(tally.vouchers.find((v) => v.masterId === masterId), changes, { alterId: tally.altVchId }); },
    deleteVoucher(masterId) { tally.altVchId += 3; tally.vouchers = tally.vouchers.filter((v) => v.masterId !== masterId); },
  };
  const voucherXml = (v) => `<VOUCHER REMOTEID="r-${v.masterId}" VCHTYPE="${v.type}"><DATE>${v.date}</DATE><VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME><PARTYLEDGERNAME>${v.party}</PARTYLEDGERNAME><MASTERID>${v.masterId}</MASTERID><ALTERID>${v.alterId}</ALTERID>` +
    (v.cancelled ? "<ISCANCELLED>Yes</ISCANCELLED>" : "<ISCANCELLED>No</ISCANCELLED>") + (v.optional ? "<ISOPTIONAL>Yes</ISOPTIONAL>" : "") +
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${v.party}</LEDGERNAME><AMOUNT>${v.amount}</AMOUNT><BILLALLOCATIONS.LIST><NAME>${v.bill}</NAME><AMOUNT>${v.amount}</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST><UNUSEDFIELD>x</UNUSEDFIELD></VOUCHER>`;
  tally.invoke = async (xml) => {
    const id = xml.match(/<ID>([^<]+)<\/ID>/)[1];
    tally.requests.push(id);
    if (tally.failNext) { tally.failNext = false; throw new Error("The operation was aborted due to timeout"); }
    if (tally.failOn?.id === id && --tally.failOn.after < 0) { tally.failOn = null; throw new Error("The operation was aborted due to timeout"); }
    if (id === "KalikaReceivableCounters") return `<COMPANY NAME="Demo Co"><ALTVCHID>${tally.altVchId}</ALTVCHID><ALTMSTID>${tally.altMstId}</ALTMSTID></COMPANY>`;
    if (id === "KalikaReceivableParties") return tally.parties.map((p) => `<LEDGER NAME="${p}"></LEDGER>`).join("");
    if (id === "KalikaReceivableBills") {
      const names = [...xml.matchAll(/<CHILDOF>&quot;([^&]+)&quot;<\/CHILDOF>/g)].map((m) => m[1]);
      return names.flatMap((n) => (tally.bills[n] || []).map((b) => `<BILL NAME="${b.name}"><LEDGERNAME>${n}</LEDGERNAME>${b.date ? `<BILLDATE>${b.date}</BILLDATE>` : ""}<CLOSINGBALANCE>${b.closing}</CLOSINGBALANCE></BILL>`)).join("");
    }
    if (id === "KalikaReceivableVouchers") {
      const after = Number(xml.match(/\$AlterID &gt; (\d+)/)?.[1] ?? -1);
      const from = xml.match(/<SVFROMDATE TYPE="Date">(\d+)/)?.[1], to = xml.match(/<SVTODATE TYPE="Date">(\d+)/)?.[1];
      tally.voucherRanges.push({ from, to, changesOnly: after >= 0 });
      // Like Tally, the Voucher collection honours the date range.
      return tally.vouchers.filter((v) => v.alterId > after && (!from || (v.date >= from && v.date <= to))).map(voucherXml).join("");
    }
    if (id === "KalikaReceivableLedgers") {
      const names = [...xml.matchAll(/<CHILDOF>&quot;([^&]+)&quot;<\/CHILDOF>/g)].map((m) => m[1]);
      return tally.vouchers.filter((v) => names.includes(v.party)).map(voucherXml).join("");
    }
    throw new Error(`Unexpected Tally request ${id}`);
  };
  return tally;
}

async function setup(t, { freeMemory = () => 8 * GB } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-receivables-"));
  const storage = new LocalAgentStorage({ baseDirectory: directory, keyHex: "0b".repeat(32) });
  t.after(async () => { await storage.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const tally = fakeTally();
  let clock = Date.parse("2026-09-23T10:00:00Z");
  const changes = [];
  const progress = [];
  const waits = [];
  const logs = [];
  const preparer = new ReceivablesPreparer({
    storage, invoke: tally.invoke, now: () => clock, onChanged: (key, state) => changes.push(state.watermark),
    onProgress: (value) => progress.push(value), onLog: (level, message) => logs.push(message),
    resources: () => ({ freeSystemBytes: freeMemory() }), wait: async (ms) => { waits.push(ms); },
  });
  return { storage, tally, preparer, changes, progress, waits, logs, advance: (ms) => { clock += ms; } };
}
const GB = 1024 * 1024 * 1024;

const identity = { companyName: "Demo Co", financialYear: "2026-27" };
// Stored dues are fields; these render them as text for simple matching:
// "<MASTERID>7</MASTERID> 500.00" per voucher, "INV-1 -1000.00" per bill.
const voucherText = (vouchers) => vouchers.map((v) => `<MASTERID>${v.masterId}</MASTERID> ${v.entries.map((e) => e.amount.toFixed(2)).join(" ")}`).join("\n");
const billText = (bills) => bills.map((b) => `${b.ref} ${Number(b.closing).toFixed(2)}`).join("\n");
const vouchersOf = async (preparer, name) => voucherText((await preparer.recordsFor("demo", [name])).vouchers);
const billsOf = async (preparer, name) => billText((await preparer.recordsFor("demo", [name])).bills);

test("financial year range follows the Indian April-March year", () => {
  assert.deepEqual(financialYearRange("2026-27"), { dateFrom: "2026-04-01", dateTo: "2027-03-31", label: "2026-27" });
  assert.equal(financialYearRange(null, "2027-02-10").label, "2026-27");
  assert.equal(financialYearRange(null, "2027-04-01").label, "2027-28");
});

test("prepare reads bills and customer vouchers once and keeps only needed fields", async (t) => {
  const { tally, preparer, changes } = await setup(t);
  tally.addVoucher({ masterId: "1", type: "Sales", party: "Apex Traders", bill: "INV-1", amount: "-1000.00", date: "20260510" });
  const state = await preparer.prepare(identity, "demo");
  assert.equal(state.status, "ready");
  assert.equal(state.watermark, 1);
  assert.deepEqual(state.counts, { customersWithBills: 2, bills: 2, vouchers: 1 });
  assert.deepEqual(changes, [1]);
  const records = await preparer.recordsFor("demo", ["Apex Traders"]);
  assert.match(billText(records.bills), /INV-1/);
  assert.match(voucherText(records.vouchers), /<MASTERID>1<\/MASTERID>/);
  assert.doesNotMatch(JSON.stringify(records.vouchers), /UNUSEDFIELD|<VOUCHER/, "fields only, no XML");
});

test("nothing changed in Tally costs one counter read", async (t) => {
  const { tally, preparer } = await setup(t);
  await preparer.prepare(identity, "demo");
  tally.requests.length = 0;
  const outcome = await preparer.checkForChanges(identity, "demo", { force: true });
  assert.deepEqual(outcome, { changed: 0 });
  assert.deepEqual(tally.requests, ["KalikaReceivableCounters"]);
});

test("created and edited vouchers update only the affected customer", async (t) => {
  const { tally, preparer } = await setup(t);
  await preparer.prepare(identity, "demo");
  tally.addVoucher({ masterId: "7", type: "Receipt", party: "Balaji Stores", bill: "INV-2", amount: "500.00", date: "20260901" });
  tally.bills["Balaji Stores"][0].closing = "-1500.00";
  let outcome = await preparer.checkForChanges(identity, "demo", { force: true });
  assert.equal(outcome.changed, 1);
  assert.equal(outcome.customersChecked, 1);
  assert.match(await vouchersOf(preparer, "Balaji Stores"), /500\.00/);
  assert.match(await billsOf(preparer, "Balaji Stores"), /-1500\.00/);

  tally.editVoucher("7", { amount: "800.00" });
  outcome = await preparer.checkForChanges(identity, "demo", { force: true });
  assert.equal(outcome.changed, 1);
  assert.match(await vouchersOf(preparer, "Balaji Stores"), /800\.00/);
  assert.doesNotMatch(await vouchersOf(preparer, "Balaji Stores"), /500\.00/);
});

test("a deleted receipt is removed after the bill re-check finds the changed customer", async (t) => {
  const { tally, preparer, advance } = await setup(t);
  tally.addVoucher({ masterId: "9", type: "Receipt", party: "Apex Traders", bill: "INV-1", amount: "400.00", date: "20260901" });
  tally.bills["Apex Traders"][0].closing = "-600.00";
  await preparer.prepare(identity, "demo");
  assert.match(await vouchersOf(preparer, "Apex Traders"), /400\.00/);

  tally.deleteVoucher("9");
  tally.bills["Apex Traders"][0].closing = "-1000.00";
  advance(3 * 60 * 60_000 + 60_000);
  const outcome = await preparer.checkForChanges(identity, "demo", { force: true });
  assert.equal(outcome.fullCheck, true);
  assert.equal(outcome.customersWithChangedBills, 1);
  assert.doesNotMatch(await vouchersOf(preparer, "Apex Traders"), /400\.00/);
  assert.match(await billsOf(preparer, "Apex Traders"), /-1000\.00/);
});

test("a scan never waits for the full re-check; the next background check runs it", async (t) => {
  const { tally, preparer, advance } = await setup(t);
  tally.addVoucher({ masterId: "9", type: "Receipt", party: "Apex Traders", bill: "INV-1", amount: "400.00", date: "20260901" });
  tally.bills["Apex Traders"][0].closing = "-600.00";
  await preparer.prepare(identity, "demo");

  tally.deleteVoucher("9");
  tally.bills["Apex Traders"][0].closing = "-1000.00";
  advance(3 * 60 * 60_000 + 60_000);
  tally.requests.length = 0;
  const beforeScan = await preparer.checkForChanges(identity, "demo", { force: true, allowFullCheck: false });
  assert.equal(beforeScan.fullCheck, false);
  assert.equal(tally.requests.includes("KalikaReceivableBills"), false, "no customer bills are read in the scan path");
  assert.equal((await preparer.status("demo")).pendingFullBillCheck, true);

  // The counters no longer move, but the pending full check still runs.
  const background = await preparer.checkForChanges(identity, "demo", { force: true });
  assert.equal(background.fullCheck, true);
  assert.equal(background.customersWithChangedBills, 1);
  assert.doesNotMatch(await vouchersOf(preparer, "Apex Traders"), /400\.00/);
  assert.equal((await preparer.status("demo")).pendingFullBillCheck, false);
  assert.deepEqual(await preparer.checkForChanges(identity, "demo", { force: true }), { changed: 0 });
});

test("a scan snapshot answers exactly like the per-customer reads", async (t) => {
  const { tally, preparer } = await setup(t);
  tally.parties.push("Chitra Metals");
  tally.bills["Apex Traders"].push({ name: "INV-0", closing: "-50.00" });
  tally.bills["Chitra Metals"] = [{ name: "INV-9", closing: "-70.00" }];
  tally.addVoucher({ masterId: "1", type: "Sales", party: "Apex Traders", bill: "INV-1", amount: "-1000.00", date: "20260510" });
  tally.addVoucher({ masterId: "2", type: "Receipt", party: "Balaji Stores", bill: "INV-2", amount: "200.00", date: "20260901" });
  tally.addVoucher({ masterId: "3", type: "Sales", party: "Chitra Metals", bill: "INV-9", amount: "-70.00", date: "20270110" });
  await preparer.prepare(identity, "demo");

  const snapshot = await preparer.loadSnapshot("demo");
  for (const [names, options] of [
    [["Apex Traders"], {}],
    [["Balaji Stores", "Apex Traders", "Chitra Metals"], {}],
    [["Chitra Metals", "Balaji Stores"], { dateTo: "2026-12-31" }],
    [["Nobody"], {}],
  ]) {
    assert.deepEqual(snapshot.recordsFor(names, options), await preparer.recordsFor("demo", names, options));
  }
  for (const bill of ["INV-0", "INV-1", "INV-2", "INV-9"]) assert.match(billText(snapshot.allBills()), new RegExp(bill));
});

const spanDays = ({ from, to }) => (Date.parse(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}`) - Date.parse(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}`)) / 86_400_000 + 1;

test("change checks never ask Tally for the whole year in one request", async (t) => {
  const { tally, preparer, advance } = await setup(t);
  await preparer.prepare(identity, "demo");
  tally.addVoucher({ masterId: "20", type: "Receipt", party: "Balaji Stores", bill: "INV-2", amount: "100.00", date: "20260915" });
  tally.voucherRanges.length = 0;
  await preparer.checkForChanges(identity, "demo", { force: true });
  const changeReads = tally.voucherRanges.filter((range) => range.changesOnly);
  assert.ok(changeReads.length > 0);
  for (const range of changeReads) assert.ok(spanDays(range) <= 31, `request spans ${spanDays(range)} days`);
  assert.match(await vouchersOf(preparer, "Balaji Stores"), /100.00/);
  advance(1);
});

test("an edit to an old voucher is picked up by the background deep sweep, not by a scan", async (t) => {
  const { tally, preparer, advance } = await setup(t);
  tally.addVoucher({ masterId: "30", type: "Sales", party: "Apex Traders", bill: "INV-1", amount: "-1000.00", date: "20260410" });
  await preparer.prepare(identity, "demo");
  tally.editVoucher("30", { amount: "-1200.00" });
  advance(3 * 60 * 60_000 + 60_000);
  const scan = await preparer.checkForChanges(identity, "demo", { force: true, allowFullCheck: false });
  assert.equal(scan.fullCheck, false);
  assert.doesNotMatch(await vouchersOf(preparer, "Apex Traders"), /1200.00/);
  assert.equal((await preparer.status("demo")).pendingFullBillCheck, true);
  const background = await preparer.checkForChanges(identity, "demo", { force: true });
  assert.equal(background.fullCheck, true);
  assert.match(await vouchersOf(preparer, "Apex Traders"), /1200.00/);
  assert.equal((await preparer.status("demo")).pendingFullBillCheck, false);
});

test("after Tally fails to answer, checks pause instead of retrying straight away", async (t) => {
  const { tally, preparer, advance } = await setup(t);
  await preparer.prepare(identity, "demo");
  tally.addVoucher({ masterId: "40", type: "Receipt", party: "Apex Traders", bill: "INV-1", amount: "50.00", date: "20260920" });
  tally.failNext = true;
  await assert.rejects(preparer.checkForChanges(identity, "demo", { force: true }), /timeout/);
  tally.requests.length = 0;
  advance(10 * 60_000);
  assert.equal(await preparer.checkForChanges(identity, "demo", { force: true }), null);
  assert.deepEqual(tally.requests, [], "no Tally request during the pause");
  advance(21 * 60_000);
  const resumed = await preparer.checkForChanges(identity, "demo", { force: true });
  assert.equal(resumed.changed, 1);
});

test("cancelled and optional vouchers are not kept, and a later cancellation removes one", async (t) => {
  const { tally, preparer } = await setup(t);
  tally.addVoucher({ masterId: "50", type: "Receipt", party: "Apex Traders", bill: "INV-1", amount: "300.00", date: "20260901", cancelled: true });
  tally.addVoucher({ masterId: "51", type: "Receipt", party: "Apex Traders", bill: "INV-1", amount: "310.00", date: "20260902", optional: true });
  tally.addVoucher({ masterId: "52", type: "Receipt", party: "Apex Traders", bill: "INV-1", amount: "320.00", date: "20260903" });
  await preparer.prepare(identity, "demo");
  const kept = await vouchersOf(preparer, "Apex Traders");
  assert.doesNotMatch(kept, /300\.00|310\.00/);
  assert.match(kept, /320\.00/);

  tally.editVoucher("52", { cancelled: true });
  await preparer.checkForChanges(identity, "demo", { force: true });
  assert.doesNotMatch(await vouchersOf(preparer, "Apex Traders"), /320\.00/);
});

test("a bill still open from an earlier year brings its invoice and receipts from that year", async (t) => {
  const { tally, preparer } = await setup(t);
  tally.bills["Apex Traders"] = [{ name: "OLD-7", closing: "-900.00", date: "20250210" }];
  tally.addVoucher({ masterId: "60", type: "Sales", party: "Apex Traders", bill: "OLD-7", amount: "-1000.00", date: "20250210" });
  tally.addVoucher({ masterId: "61", type: "Receipt", party: "Apex Traders", bill: "OLD-7", amount: "100.00", date: "20250301" });
  tally.addVoucher({ masterId: "62", type: "Sales", party: "Apex Traders", bill: "OLD-6", amount: "-50.00", date: "20250101" });
  tally.addVoucher({ masterId: "63", type: "Sales", party: "Balaji Stores", bill: "OLD-9", amount: "-70.00", date: "20250301" });
  const state = await preparer.prepare(identity, "demo");
  assert.equal(state.evidenceFrom, "2025-02-10");
  const apex = await vouchersOf(preparer, "Apex Traders");
  assert.match(apex, /<MASTERID>60<\/MASTERID>/);
  assert.match(apex, /<MASTERID>61<\/MASTERID>/);
  assert.doesNotMatch(apex, /<MASTERID>62<\/MASTERID>/, "nothing before the earliest open bill");
  assert.doesNotMatch(await vouchersOf(preparer, "Balaji Stores"), /<MASTERID>63<\/MASTERID>/, "only customers with an earlier-year open bill");
  assert.equal(tally.requests.filter((id) => id === "KalikaReceivableLedgers").length, 1);
});

test("an interrupted preparation continues where it stopped instead of reading everything again", async (t) => {
  const { tally, preparer, storage } = await setup(t);
  tally.addVoucher({ masterId: "70", type: "Sales", party: "Apex Traders", bill: "INV-1", amount: "-1000.00", date: "20260405" });
  tally.addVoucher({ masterId: "71", type: "Receipt", party: "Balaji Stores", bill: "INV-2", amount: "200.00", date: "20260901" });
  tally.failOn = { id: "KalikaReceivableVouchers", after: 2 };
  await assert.rejects(preparer.prepare(identity, "demo"), /timeout/);
  const failed = await preparer.status("demo");
  assert.equal(failed.status, "failed");
  assert.equal(failed.resumable.stage, "vouchers");
  assert.equal("resume" in failed, false, "the heartbeat never carries the saved customer list");
  assert.equal(failed.resumable.customers, 2);
  const savedProgress = await storage.call("getReceivableState", { datasetKey: "demo" });
  assert.equal("debtors" in savedProgress.resume, false, "the customer list is saved once, not with every progress save");

  tally.requests.length = 0;
  tally.voucherRanges.length = 0;
  const state = await preparer.prepare(identity, "demo");
  assert.equal(state.status, "ready");
  assert.equal(state.pendingFullBillCheck, true);
  assert.equal(tally.requests.includes("KalikaReceivableParties"), false);
  assert.equal(tally.requests.includes("KalikaReceivableBills"), false);
  assert.ok(tally.voucherRanges[0].from > "20260401", "vouchers continue after the last completed window");
  assert.match(await vouchersOf(preparer, "Apex Traders"), /<MASTERID>70<\/MASTERID>/);
  assert.match(await vouchersOf(preparer, "Balaji Stores"), /<MASTERID>71<\/MASTERID>/);

  tally.requests.length = 0;
  await preparer.prepare(identity, "demo", { fresh: true });
  assert.ok(tally.requests.includes("KalikaReceivableParties"), "a fresh check starts over");
});

test("one progress bar runs from start to 100% without going back", async (t) => {
  const { tally, preparer, progress } = await setup(t);
  tally.addVoucher({ masterId: "80", type: "Sales", party: "Apex Traders", bill: "INV-1", amount: "-1000.00", date: "20260405" });
  await preparer.prepare(identity, "demo");
  const bar = progress.map((value) => value.overall);
  assert.ok(bar.every((value) => Number.isFinite(value)), "every update carries the overall position");
  for (let index = 1; index < bar.length; index += 1) assert.ok(bar[index] >= bar[index - 1], `bar went back: ${bar.slice(index - 1, index + 1)}`);
  assert.equal(bar.at(-1), 100);
  const lastVoucherUpdate = progress.filter((value) => value.phase === "checking_invoices_and_receipts").at(-1);
  assert.equal(lastVoucherUpdate.overall, 100, "the last invoice read is reported before completion");
});

test("bill batches grow while Tally answers quickly and shrink when it is slow", async (t) => {
  const { tally, preparer, advance } = await setup(t);
  tally.parties = Array.from({ length: 700 }, (_, index) => `Party ${index}`);
  const sizes = [];
  const invoke = tally.invoke;
  preparer.baseInvoke = async (xml, options) => {
    if (xml.includes("<ID>KalikaReceivableBills</ID>")) {
      const size = (xml.match(/<CHILDOF>/g) || []).length;
      sizes.push(size);
      if (size >= 200) advance(3_000); // Tally slows down on the largest batch
    }
    return invoke(xml, options);
  };
  await preparer.prepare(identity, "demo");
  assert.deepEqual(sizes.slice(0, 4), [50, 100, 200, 100]);
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), 700, "every customer is read once");
});

test("low free memory keeps reads small, and too little memory pauses them", async (t) => {
  const { tally, preparer, waits, progress } = await setup(t, { freeMemory: () => 900 * 1024 * 1024 });
  tally.parties = Array.from({ length: 60 }, (_, index) => `Party ${index}`);
  const billSizes = [];
  const invoke = tally.invoke;
  preparer.baseInvoke = async (xml, options) => {
    if (xml.includes("<ID>KalikaReceivableBills</ID>")) billSizes.push((xml.match(/<CHILDOF>/g) || []).length);
    return invoke(xml, options);
  };
  let pausedChecks = 2;
  const resources = preparer.resources;
  preparer.resources = () => (pausedChecks-- > 0 ? { freeSystemBytes: 500 * 1024 * 1024 } : resources());
  await preparer.prepare(identity, "demo");
  assert.equal(waits.length, 2, "waited while memory was below the minimum");
  assert.ok(progress.some((value) => value.waitingForMemory));
  assert.ok(billSizes.every((size) => size <= 25), `bill batches ${billSizes}`);
  const days = tally.voucherRanges.map(spanDays);
  assert.ok(days.every((span) => span <= 7), `invoice windows ${days}`);
});

test("a 4 GB computer that stays low on memory waits once, then finishes with the smallest reads", async (t) => {
  const { tally, preparer, waits } = await setup(t, { freeMemory: () => 600 * 1024 * 1024 });
  tally.parties = Array.from({ length: 30 }, (_, index) => `Party ${index}`);
  const billSizes = [];
  const invoke = tally.invoke;
  preparer.baseInvoke = async (xml, options) => {
    if (xml.includes("<ID>KalikaReceivableBills</ID>")) billSizes.push((xml.match(/<CHILDOF>/g) || []).length);
    return invoke(xml, options);
  };
  tally.addVoucher({ masterId: "90", type: "Sales", party: "Party 1", bill: "INV-1", amount: "-10.00", date: "20260402" });
  const state = await preparer.prepare(identity, "demo");
  assert.equal(state.status, "ready");
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 2 * 60_000, "waited two minutes in total, not before every read");
  assert.ok(billSizes.every((size) => size <= 10), `bill batches ${billSizes}`);
  assert.ok(tally.voucherRanges.every((range) => spanDays(range) === 1), "one day per invoice read");
});

test("critically low memory stops with saved progress instead of risking Tally", async (t) => {
  const { preparer } = await setup(t, { freeMemory: () => 200 * 1024 * 1024 });
  await assert.rejects(preparer.prepare(identity, "demo"), /not have enough free memory/);
  const status = await preparer.status("demo");
  assert.equal(status.status, "failed");
  assert.match(status.lastError, /Close other programs/);
  assert.ok(status.resumable, "can continue later");
});

test("each invoice read is logged with its dates, counts and timing, and the run ends with a summary", async (t) => {
  const { tally, preparer, logs } = await setup(t);
  tally.addVoucher({ masterId: "95", type: "Sales", party: "Apex Traders", bill: "INV-1", amount: "-1000.00", date: "20260402" });
  tally.addVoucher({ masterId: "96", type: "Journal", party: "Somebody Else", bill: "J-1", amount: "5.00", date: "20260402" });
  await preparer.prepare(identity, "demo");
  const reads = logs.filter((line) => line.startsWith("Customer dues invoices"));
  assert.equal(reads.length, tally.voucherRanges.length, "one line per Tally read");
  assert.match(reads[0], /^Customer dues invoices 2026-04-01 to 2026-04-03 \(3 day\(s\)\): Tally sent 2 voucher\(s\), kept 1 for customers; Tally 0\.0 s, queue 0\.0 s, parse 0\.0 s, store 0\.0 s, save 0\.0 s, check 0\.0 s, pause 0\.3 s; next read 6 day\(s\)\.$/);
  assert.ok(logs.some((line) => /^Customer dues bills 1-2 of 2 \(2 ledgers\): 2 open bill\(s\); Tally 0\.0 s, queue/.test(line)));
  assert.ok(logs.some((line) => /^Customer dues: 2 bill-wise ledger\(s\) found/.test(line)));
  assert.ok(logs.some((line) => /^Customer dues: open bills done, bills 1 read\(s\), 0\.0 s in Tally, 2 open bill\(s\); 0 customer\(s\) have bills from before 2026-04-01\.$/.test(line)));
  const summary = logs.find((line) => line.startsWith("Customer dues took"));
  assert.match(summary, new RegExp(`invoices/receipts ${reads.length} read\\(s\\), 0\\.0 s in Tally, 2 voucher\\(s\\) sent, 1 kept`));
});

test("a stuck local storage call stops the check with a message instead of hanging", async (t) => {
  const { storage, tally } = await setup(t);
  const progress = [];
  const logs = [];
  const stuck = { call: (operation, payload) => operation === "clearReceivables" ? new Promise(() => {}) : storage.call(operation, payload) };
  const preparer = new ReceivablesPreparer({ storage: stuck, invoke: tally.invoke, storageTimeoutMs: 3_000,
    onProgress: (value) => progress.push(value), onLog: (level, message) => logs.push(`${level}: ${message}`) });
  await assert.rejects(preparer.prepare(identity, "demo"), /did not respond to clearReceivables/);
  assert.equal(progress.at(-1).phase, "failed", "the window is told the check stopped");
  assert.ok(logs.some((line) => /^error: Customer dues check stopped at the start step: Local storage did not respond/.test(line)));
  assert.equal((await preparer.status("demo")).status, "failed");
});

test("a check left 'preparing' by a closed connector shows as stopped, not Checking", async (t) => {
  const { storage, preparer } = await setup(t);
  await storage.call("putReceivableState", { datasetKey: "demo", state: { status: "preparing", resume: { stage: "start", companyName: "Demo Co", financialYear: "2026-27" } } });
  const status = await preparer.status("demo");
  assert.equal(status.status, "failed");
  assert.match(status.lastError, /Click Check customer dues to continue/);
  assert.equal((await preparer.prepare(identity, "demo")).status, "ready", "the next click runs the check");
});

test("the ledger key matches the live Cash Discount normalisation", () => {
  assert.equal(receivableLedgerKey("Aakar Traders, Pune (Retail)"), "aakartraderspuneretail");
});

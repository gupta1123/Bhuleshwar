import assert from "node:assert/strict";
import test from "node:test";
import { fetchPurchaseRegister, monthRange, parsePurchaseRegister, parseGroups, parseLedgerMasters, parseVoucherTypes } from "./purchase-register.mjs";

const named = (tag, rows) => `<ENVELOPE>${rows.map(([name, parent, extra = ""]) => `<${tag} NAME="${name}"><PARENT>${parent}</PARENT>${extra}</${tag}>`).join("")}</ENVELOPE>`;

const ledgers = parseLedgerMasters(named("LEDGER", [
  ["Vertex Industrial", "Sundry Creditors", "<PARTYGSTIN>27aaaaa0000a1z5</PARTYGSTIN>"],
  ["No GST Vendor", "Sundry Creditors"],
  ["Steel Purchase", "Raw Material Purchases"],
  ["Input ITC CGST 9%", "Duties & Taxes"],
  ["Input ITC SGST 9%", "Duties & Taxes"],
  ["Input ITC IGST 18%", "Duties & Taxes"],
  ["IGST TDS", "Duties & Taxes"],
  ["TDS 194Q", "Duties & Taxes"],
  ["Freight", "Indirect Expenses"],
]));
const groups = parseGroups(named("GROUP", [["Raw Material Purchases", "Purchase Accounts"], ["Purchase Accounts", ""], ["Duties & Taxes", ""]]));
const voucherTypes = parseVoucherTypes(named("VOUCHERTYPE", [
  ["Purchase", ""], ["Debit Note", ""], ["Import Purchase", "Purchase"], ["Sales", ""],
]));

const entry = (tag, name, amount) => `<${tag}><LEDGERNAME>${name}</LEDGERNAME><AMOUNT>${amount}</AMOUNT></${tag}>`;
function voucher({ type = "Purchase", date = "20260915", no = "1", ref = "INV/1", party = "Vertex Industrial", cancelled = "No", lines = [], inventory = [] }) {
  return `<VOUCHER VCHTYPE="${type}"><DATE>${date}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${no}</VOUCHERNUMBER>` +
    `<REFERENCE>${ref}</REFERENCE><REFERENCEDATE>20260910</REFERENCEDATE><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>` +
    `<ISCANCELLED>${cancelled}</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><NARRATION>n &amp; m</NARRATION>` +
    lines.map(([n, a]) => entry("LEDGERENTRIES.LIST", n, a)).join("") +
    inventory.map(([n, a]) => `<ALLINVENTORYENTRIES.LIST>${entry("ACCOUNTINGALLOCATIONS.LIST", n, a)}</ALLINVENTORYENTRIES.LIST>`).join("") +
    `</VOUCHER>`;
}
const run = (...vouchers) => parsePurchaseRegister(`<ENVELOPE>${vouchers.join("")}</ENVELOPE>`, { ledgers, groups, voucherTypes, period: "2026-09" });

test("taxable comes from purchase accounts, including sub-groups and inventory allocations", () => {
  const { vouchers } = run(voucher({
    lines: [["Vertex Industrial", "1180"], ["Input ITC CGST 9%", "-90"], ["Input ITC SGST 9%", "-90"]],
    inventory: [["Steel Purchase", "-1000"]],
  }));
  assert.equal(vouchers.length, 1);
  assert.deepEqual(
    [vouchers[0].taxableValue, vouchers[0].cgst, vouchers[0].sgst, vouchers[0].igst, vouchers[0].grandTotal],
    [1000, 90, 90, 0, 1180],
  );
  assert.equal(vouchers[0].partyGSTIN, "27AAAAA0000A1Z5", "GSTIN comes from the ledger master, upper-cased");
  assert.equal(vouchers[0].supplierInvoiceDate, "2026-09-10");
  assert.equal(vouchers[0].narration, "n & m");
});

test("TDS ledgers and non-purchase ledgers never count as tax or taxable", () => {
  const { vouchers } = run(voucher({
    lines: [["Vertex Industrial", "900"], ["Input ITC IGST 18%", "-180"], ["IGST TDS", "20"], ["TDS 194Q", "1"], ["Freight", "-50"]],
    inventory: [["Steel Purchase", "-1000"]],
  }));
  assert.deepEqual([vouchers[0].taxableValue, vouchers[0].igst, vouchers[0].cgst], [1000, 180, 0]);
});

test("custom voucher types map to their parent; debit notes become credit-type rows; sales are ignored", () => {
  const { vouchers } = run(
    voucher({ type: "Import Purchase", no: "2", inventory: [["Steel Purchase", "-500"]] }),
    voucher({ type: "Debit Note", no: "3", ref: "DN/1", inventory: [["Steel Purchase", "500"]] }),
    voucher({ type: "Sales", no: "4", inventory: [["Steel Purchase", "-500"]] }),
  );
  assert.deepEqual(vouchers.map((v) => [v.voucherNumber, v.voucherType, v.docType]), [["2", "Purchase", "inv"], ["3", "Debit Note", "crn"]]);
});

test("other months, cancelled vouchers and suppliers without a GSTIN are left out and reported", () => {
  const { vouchers, skipped } = run(
    voucher({ no: "5", date: "20260831", inventory: [["Steel Purchase", "-1"]] }),
    voucher({ no: "6", cancelled: "Yes", inventory: [["Steel Purchase", "-1"]] }),
    voucher({ no: "7", party: "No GST Vendor", inventory: [["Steel Purchase", "-1"]] }),
    voucher({ no: "8", inventory: [["Steel Purchase", "-1"]] }),
  );
  assert.deepEqual(vouchers.map((v) => v.voucherNumber), ["8"]);
  assert.equal(skipped.cancelled, 1);
  assert.deepEqual(skipped.noGstin, [{ voucherNumber: "7", partyName: "No GST Vendor" }]);
});

test("month ranges cover the whole month, leap years included", () => {
  assert.deepEqual(monthRange("2026-09"), { from: "20260901", to: "20260930" });
  assert.deepEqual(monthRange("2028-02"), { from: "20280201", to: "20280229" });
  assert.throws(() => monthRange("2026-13"));
});

test("the fetcher asks Tally for masters first and the voucher list, one request at a time", async () => {
  const seen = [];
  const exportXml = async (xml, label) => {
    seen.push([label, /SVFROMDATE>(\d+)/.exec(xml)?.[1] ?? "", /SVTODATE>(\d+)/.exec(xml)?.[1] ?? "", /SVCURRENTCOMPANY>([^<]*)/.exec(xml)?.[1]]);
    if (/ledgers/.test(label)) return named("LEDGER", [["Vertex Industrial", "Sundry Creditors", "<PARTYGSTIN>27AAAAA0000A1Z5</PARTYGSTIN>"], ["Steel Purchase", "Purchase Accounts"]]);
    if (/groups/.test(label)) return named("GROUP", [["Purchase Accounts", ""]]);
    if (/types/.test(label)) return named("VOUCHERTYPE", [["Purchase", ""]]);
    return `<ENVELOPE>${voucher({ inventory: [["Steel Purchase", "-100"]] })}</ENVELOPE>`;
  };
  const result = await fetchPurchaseRegister({ exportXml, company: "Nyx & Co", period: "2026-09" });
  assert.equal(result.vouchers.length, 1);
  assert.deepEqual(seen.map((s) => s[0]), ["GST register ledgers", "GST register groups", "GST register voucher types", "GST register vouchers"]);
  assert.equal(seen[3][3], "Nyx &amp; Co");
  await assert.rejects(fetchPurchaseRegister({ exportXml, company: "", period: "2026-09" }), /requires a Tally company/);
});

function countingExport(log, extraLedgers = []) {
  return async (xml, label) => {
    log.push(label);
    if (/ledgers/.test(label)) return named("LEDGER", [["Vertex Industrial", "Sundry Creditors", "<PARTYGSTIN>27AAAAA0000A1Z5</PARTYGSTIN>"], ["Steel Purchase", "Purchase Accounts"], ["Input ITC CGST 9%", "Duties & Taxes"], ...extraLedgers]);
    if (/groups/.test(label)) return named("GROUP", [["Purchase Accounts", ""], ["Duties & Taxes", ""]]);
    if (/types/.test(label)) return named("VOUCHERTYPE", [["Purchase", ""]]);
    return `<ENVELOPE>${voucher({ lines: [["Input ITC CGST 9%", "-90"]], inventory: [["Steel Purchase", "-1000"]] })}</ENVELOPE>`;
  };
}
const localMasters = {
  ledgers: [{ name: "Vertex Industrial", parent: "Sundry Creditors", gstin: "27aaaaa0000a1z5" }, { name: "Steel Purchase", parent: "Purchase Accounts" }, { name: "Input ITC CGST 9%", parent: "Duties & Taxes" }],
  groups: [{ name: "Purchase Accounts", parent: "" }, { name: "Duties & Taxes", parent: "" }],
};

test("a local catalogue skips the slow ledger and group reads", async () => {
  const log = [];
  const result = await fetchPurchaseRegister({ exportXml: countingExport(log), company: "Local Co", period: "2026-09", localMasters });
  assert.deepEqual(log, ["GST register voucher types", "GST register vouchers"]);
  assert.equal(result.mastersSource, "local_catalogue");
  assert.equal(result.vouchers[0].partyGSTIN, "27AAAAA0000A1Z5");
  assert.equal(result.vouchers[0].cgst, 90);
});

test("masters read from Tally are reused for the next month instead of re-read", async () => {
  const log = [];
  let clock = 1_000;
  const exportXml = countingExport(log);
  await fetchPurchaseRegister({ exportXml, company: "Cache Co", period: "2026-08", now: () => clock });
  clock += 60_000;
  const second = await fetchPurchaseRegister({ exportXml, company: "Cache Co", period: "2026-09", now: () => clock });
  assert.equal(log.filter((l) => /ledgers|groups/.test(l)).length, 2, "ledgers and groups were read once, not twice");
  assert.equal(second.mastersSource, "memory_cache");
  clock += 16 * 60_000;
  const third = await fetchPurchaseRegister({ exportXml, company: "Cache Co", period: "2026-10", now: () => clock });
  assert.equal(third.mastersSource, "tally", "an old copy is re-read");
});

test("a saved copy missing a ledger the vouchers use is refreshed from Tally", async () => {
  const log = [];
  const stale = { ...localMasters, ledgers: localMasters.ledgers.filter((l) => l.name !== "Input ITC CGST 9%") };
  const result = await fetchPurchaseRegister({ exportXml: countingExport(log), company: "Stale Co", period: "2026-09", localMasters: stale });
  assert.equal(result.mastersSource, "tally");
  assert.equal(result.vouchers[0].cgst, 90, "tax is not lost to the stale copy");
  assert.equal(log.filter((l) => /vouchers$/.test(l)).length, 1, "vouchers are read only once");
});

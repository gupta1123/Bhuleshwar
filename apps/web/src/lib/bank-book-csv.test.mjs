import test from "node:test";
import assert from "node:assert/strict";
import { buildBankBookCsv } from "./bank-book-csv.ts";

test("bank book orders receipts first and balances totals", () => {
  const csv = buildBankBookCsv("Bank", "2026-09-08", [
    { date: "2026-09-08", party: "Supplier", voucherNumber: "P1", receipt: 0, payment: 20 },
    { date: "2026-09-08", party: "Buyer", voucherNumber: "R1", receipt: 50, payment: 0 },
  ], { opening: 100, closing: 130 });
  assert.ok(csv.indexOf('"Receipt"') < csv.indexOf('"Payment"'));
  assert.ok(csv.includes('"Grand Total","","","","","150.00","150.00"'));
});

test("partial exports escape spreadsheet formulas", () => {
  const csv = buildBankBookCsv("Bank", "partial", [
    { date: "2026-09-08", party: '=SUM(1,2)"', voucherNumber: "001", receipt: 1, payment: 0 },
  ]);
  assert.ok(!csv.includes("Opening Balance"));
  assert.ok(csv.includes("'=SUM(1,2)\"\""));
});

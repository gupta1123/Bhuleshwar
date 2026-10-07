import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./purchase-voucher.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const calculator = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

function input(overrides = {}) {
  return {
    taxMode: "igst",
    defaultGstRate: "18",
    lines: [{ lineId: "line-1", taxableAmount: "1000.00", taxRate: "18" }],
    freightAmount: "0",
    freightGstRate: "0",
    invoiceGstAmount: "180.00",
    invoiceTotal: "1180.00",
    invoiceWithholdingAmount: "0",
    sourceRoundOffAmount: "0",
    confirmedRoundOffAmount: "0",
    tcsAmount: "0",
    tds194qEnabled: false,
    tds194qBasisAmount: "1000.00",
    tds194qRate: "0.1",
    tds194qRounding: "paise",
    transportTdsEnabled: false,
    sourceTransportTdsAmount: "0",
    transportTdsRate: "0",
    cgstTdsAmount: "0",
    sgstTdsAmount: "0",
    igstTdsAmount: "0",
    ...overrides,
  };
}

test("groups mixed item and freight GST by kind and rate", () => {
  const result = calculator.calculatePurchaseVoucher(input({
    lines: [
      { lineId: "a", taxableAmount: "1000.00", taxRate: "18" },
      { lineId: "b", taxableAmount: "500.00", taxRate: "5" },
      { lineId: "c", taxableAmount: "250.00", taxRate: "0" },
    ],
    freightAmount: "100.00",
    freightGstRate: "12",
    invoiceGstAmount: "217.00",
    invoiceTotal: "2067.00",
  }));
  assert.equal(result.gstAmount, "217.00");
  assert.equal(result.calculatedInvoiceTotal, "2067.00");
  assert.deepEqual(result.taxBuckets.map((bucket) => [bucket.kind, bucket.rate, bucket.amount]), [
    ["igst", "18", "180.00"],
    ["igst", "5", "25.00"],
    ["igst", "12", "12.00"],
  ]);
});

test("splits an odd paise of intrastate GST without losing it", () => {
  const result = calculator.calculatePurchaseVoucher(input({
    taxMode: "cgst_sgst",
    lines: [{ lineId: "a", taxableAmount: "0.03", taxRate: "18" }],
    invoiceGstAmount: "0.01",
    invoiceTotal: "0.04",
  }));
  assert.equal(result.cgstAmount, "0.01");
  assert.equal(result.sgstAmount, "0.00");
  assert.equal(result.gstAmount, "0.01");
});

test("keeps source-backed positive and negative round-off exact", () => {
  const positive = calculator.calculatePurchaseVoucher(input({ sourceRoundOffAmount: "0.40", confirmedRoundOffAmount: "0.40", invoiceTotal: "1180.40" }));
  const negative = calculator.calculatePurchaseVoucher(input({ sourceRoundOffAmount: "-0.40", confirmedRoundOffAmount: "-0.40", invoiceTotal: "1179.60" }));
  assert.equal(positive.totalDifference, "0.00");
  assert.equal(negative.totalDifference, "0.00");
});

test("rounds the final payable after TDS to a whole rupee", () => {
  // Client voucher SSTC-26/27-091: 7,53,257.20 before round-off -> 7,53,257.00.
  const client = calculator.calculatePurchaseVoucher(input({
    taxMode: "cgst_sgst",
    lines: [{ lineId: "a", taxableAmount: "649920.00", taxRate: "18" }],
    invoiceGstAmount: "116985.60",
    invoiceTotal: "766906.00",
    sourceRoundOffAmount: "0.40",
    confirmedRoundOffAmount: "0.40",
    tds194qEnabled: true,
    tds194qBasisAmount: "649920.00",
    tds194qRounding: "nearest_rupee",
    cgstTdsAmount: "6499.20",
    sgstTdsAmount: "6499.20",
  }));
  assert.equal(client.roundOffAmount, "-0.20");
  assert.equal(client.calculatedPayable, "753257.00");
  assert.equal(client.totalDifference, "0.00");
  // SSTC-26/27-182: 4,84,206.80 before round-off -> 4,84,207.00.
  const up = calculator.calculatePurchaseVoucher(input({
    taxMode: "cgst_sgst",
    lines: [{ lineId: "a", taxableAmount: "417780.00", taxRate: "18" }],
    invoiceGstAmount: "75200.40",
    invoiceTotal: "492980.00",
    sourceRoundOffAmount: "-0.40",
    confirmedRoundOffAmount: "-0.40",
    tds194qEnabled: true,
    tds194qBasisAmount: "417780.00",
    tds194qRounding: "nearest_rupee",
    cgstTdsAmount: "4177.80",
    sgstTdsAmount: "4177.80",
  }));
  assert.equal(up.roundOffAmount, "0.20");
  assert.equal(up.calculatedPayable, "484207.00");
  assert.equal(up.totalDifference, "0.00");
});

test("uses one shared 194Q nearest-rupee rule", () => {
  const below = calculator.calculatePurchaseVoucher(input({ tds194qEnabled: true, tds194qBasisAmount: "1490.00", tds194qRounding: "nearest_rupee" }));
  const above = calculator.calculatePurchaseVoucher(input({ tds194qEnabled: true, tds194qBasisAmount: "1500.00", tds194qRounding: "nearest_rupee" }));
  assert.equal(below.tds194qAmount, "1.00");
  assert.equal(above.tds194qAmount, "2.00");
});

test("reports a conflicting source transport deduction", () => {
  const result = calculator.calculatePurchaseVoucher(input({
    freightAmount: "700.00",
    freightGstRate: "0",
    transportTdsEnabled: true,
    sourceTransportTdsAmount: "6.50",
    transportTdsRate: "1",
  }));
  assert.equal(result.transportTdsCalculatedAmount, "7.00");
  assert.equal(result.transportTdsDifference, "-0.50");
});

test("transport TDS not printed on the invoice is the rate on freight, rounded down to the rupee", () => {
  const result = calculator.calculatePurchaseVoucher(input({
    freightAmount: "36792.00",
    freightGstRate: "18",
    transportTdsEnabled: true,
    sourceTransportTdsAmount: "",
    transportTdsRate: "1",
  }));
  assert.equal(result.transportTdsAmount, "367.00");
  assert.equal(result.transportTdsDifference, "0.00");
});

test("a printed transport TDS amount is used as printed", () => {
  const result = calculator.calculatePurchaseVoucher(input({
    freightAmount: "36792.00",
    transportTdsEnabled: true,
    sourceTransportTdsAmount: "367.00",
    transportTdsRate: "1",
  }));
  assert.equal(result.transportTdsAmount, "367.00");
  assert.equal(result.transportTdsDifference, "-0.92");
});

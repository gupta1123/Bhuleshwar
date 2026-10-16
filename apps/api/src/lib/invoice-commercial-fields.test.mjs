import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./invoice-commercial-fields.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { applyInvoiceCommercialFieldFallback } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const invoiceText = `NYX MOBILITY COMPONENTS PRIVATE LIMITED
TAX INVOICE
Supplier ledger  KTC-260707 Test Supplier     Buyer  Nyx Mobility Components Private Limited
Supplier GSTIN 27ABCDE1234F1Z0 Buyer GSTIN 27NYXCO1234A1Z7`;

test("corrects a buyer masthead misidentified as the invoice supplier", () => {
  const fields = applyInvoiceCommercialFieldFallback({
    vendorName: "NYX MOBILITY COMPONENTS PRIVATE LIMITED",
    buyerName: "Nyx Mobility Components Private Limited",
  }, "Tax Invoice", invoiceText);
  assert.equal(fields.vendorName, "KTC-260707 Test Supplier");
});

test("does not replace a distinct extracted supplier", () => {
  const fields = applyInvoiceCommercialFieldFallback({
    vendorName: "Another Supplier",
    buyerName: "Nyx Mobility Components Private Limited",
  }, "Tax Invoice", invoiceText);
  assert.equal(fields.vendorName, "Another Supplier");
});

test("corrects a unit rate mistaken for freight and goods-only GST when printed totals prove the amounts", () => {
  const visibleText = `Supplier invoice for goods and freight
1 M.S. Scrap & Sponge Iron 7204 20,300 kg INR 42.00/kg INR 852,600.00
2 Freight and handling 9965 1 lot INR 8,500.00 INR 8,500.00
Taxable value INR 861,100.00
CGST @ 9% INR 77,499.00
SGST @ 9% INR 77,499.00
Grand total INR 1,016,098.00`;
  const fields = applyInvoiceCommercialFieldFallback({
    totalTaxableAmount: "861100.00",
    totalAmount: "1016098.00",
    freightAmount: "42.00",
    taxAmount: "153468.00",
  }, "Tax Invoice", visibleText);
  assert.equal(fields.freightAmount, "8500.00");
  assert.equal(fields.taxAmount, "154998");
});

test("does not replace extracted amounts if printed tax cannot reconcile to the invoice total", () => {
  const fields = applyInvoiceCommercialFieldFallback({
    totalTaxableAmount: "861100.00",
    totalAmount: "1016000.00",
    freightAmount: "42.00",
    taxAmount: "153468.00",
  }, "Tax Invoice", "Freight and handling INR 8,500.00\nCGST @ 9% INR 77,499.00\nSGST @ 9% INR 77,499.00");
  assert.equal(fields.freightAmount, "42.00");
  assert.equal(fields.taxAmount, "153468.00");
});

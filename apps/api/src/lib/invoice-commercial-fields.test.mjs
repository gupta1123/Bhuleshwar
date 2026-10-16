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

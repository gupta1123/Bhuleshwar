import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../../../../../packages/shared/src/lib/e-way-taxable-rows.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { eWayTaxableRows } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("sums the test E-Way Bill's monetary rows, not its 20,300 kg quantity", () => {
  const visibleText = `E-WAY BILL
Goods and services
No. Description HSN/SAC Qty Rate Taxable amount
1 M.S. Scrap & Sponge Iron 7204 20,300 kg INR 42.00/kg INR 852,600.00
2 Freight and handling 9965 1 lot INR 8,500.00 INR 8,500.00
References and transport
Approx. distance 58 km`;
  assert.deepEqual(eWayTaxableRows(visibleText), { total: 861100, rowCount: 2 });
});

test("does not invent taxable amounts without a labelled goods table", () => {
  assert.equal(eWayTaxableRows("E-WAY BILL\nQuantity 20,300 kg\nRate INR 42.00"), null);
});

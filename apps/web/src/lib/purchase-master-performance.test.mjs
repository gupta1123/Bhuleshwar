import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./purchase-master-performance.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const performanceModule = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

function option(index, type = "ledger") {
  const tax = index % 20 === 0;
  return {
    id: `${type}-${index}`,
    type,
    key: `${type}-${index}`,
    name: tax ? `Input CGST 9 Purchase ${index}` : `${type === "stock_item" ? "Sponge Iron" : "Trade Ledger"} ${index}`,
    parent: tax ? "Duties & Taxes" : type === "stock_item" ? "Raw Materials" : "Sundry Creditors",
    gstin: null,
    hsnCode: type === "stock_item" ? String(72031000 + (index % 10)) : null,
    unitName: type === "stock_item" ? "MT" : null,
    taxRate: tax ? 9 : null,
    groupPath: tax ? "Duties & Taxes / GST Input" : null,
    taxType: tax ? "GST" : null,
    gstDutyHead: tax ? "Central Tax" : null,
    closingBalance: null,
    closingBalanceType: null,
    decimalPlaces: type === "stock_item" ? 3 : null,
  };
}

function measure(operation, repetitions = 25) {
  const samples = [];
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    operation(index);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    maxMs: samples.at(-1),
  };
}

for (const catalogueSize of [10_000, 50_000]) {
  test(`${catalogueSize.toLocaleString()} purchase masters keep warm interactions below 100 ms`, (context) => {
    const ledgers = Array.from({ length: catalogueSize }, (_, index) => option(index));
    const stockItems = Array.from({ length: catalogueSize }, (_, index) => option(index, "stock_item"));
    const line = {
      hsn: "72031009",
      description: "Sponge Iron raw material",
      unit: "MT",
    };

    // Build each immutable search index once; every combobox sharing that array reuses it.
    const ledgerIndexStarted = performance.now();
    performanceModule.searchPurchaseMasterOptions(ledgers, [], "unlikely-first-index-build");
    const ledgerIndexBuildMs = performance.now() - ledgerIndexStarted;
    const stockIndexStarted = performance.now();
    performanceModule.searchPurchaseMasterOptions(stockItems, [], "unlikely-first-index-build");
    const stockIndexBuildMs = performance.now() - stockIndexStarted;

    const open = measure(() => performanceModule.searchPurchaseMasterOptions(ledgers, ["Input CGST 9 Purchase 20"], ""));
    const keyboardSearch = measure((index) => performanceModule.searchPurchaseMasterOptions(ledgers, [], `trade ledger ${catalogueSize - 1 - (index % 10)}`));
    const ledgerRanking = measure(() => performanceModule.rankPurchaseLedgerRole(ledgers, "cgst", 9), 8);
    const stockRanking = measure(() => performanceModule.rankPurchaseStockItems(stockItems, line, []), 8);

    const result = performanceModule.searchPurchaseMasterOptions(ledgers, ["Input CGST 9 Purchase 20"], "");
    assert.equal(result.visibleOptions[0].name, "Input CGST 9 Purchase 20");
    assert.ok(result.visibleOptions.length <= 120);
    assert.ok(ledgerIndexBuildMs < 100, `ledger index build was ${ledgerIndexBuildMs.toFixed(2)} ms`);
    assert.ok(stockIndexBuildMs < 100, `stock index build was ${stockIndexBuildMs.toFixed(2)} ms`);
    for (const [name, measurement] of Object.entries({ open, keyboardSearch, ledgerRanking, stockRanking })) {
      assert.ok(measurement.p95Ms < 100, `${name} p95 was ${measurement.p95Ms.toFixed(2)} ms`);
    }
    context.diagnostic(JSON.stringify({ catalogueSize, ledgerIndexBuildMs, stockIndexBuildMs, open, keyboardSearch, ledgerRanking, stockRanking }));
  });
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const source = readFileSync(new URL("./purchase-master-matching.ts", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpile(source)).toString("base64")}`;
const { suggestPurchaseLineMasters, suggestSupplierLedger } = await import(moduleUrl);

function master(overrides) {
  return {
    id: overrides.tally_name,
    master_type: "ledger",
    master_key: overrides.tally_name.toLowerCase(),
    tally_name: overrides.tally_name,
    parent_name: overrides.parent_name ?? null,
    gstin: overrides.gstin ?? null,
    hsn_code: overrides.hsn_code ?? null,
    unit_name: overrides.unit_name ?? null,
    tax_rate: null,
    group_path: overrides.group_path ?? null,
    is_active: true,
    ...overrides,
  };
}

test("supplier GSTIN overrides a similar conflicting name", () => {
  const result = suggestSupplierLedger({
    supplierName: "Surya Steel Trading Company",
    supplierGstin: "27ASJPB7381E1ZQ",
    ledgers: [
      master({ tally_name: "Surya Steel Trading Co", gstin: "27ASJPB7381E1ZQ", parent_name: "Sundry Creditors" }),
      master({ tally_name: "Surya Steel Trading Company - Old", gstin: "27AAAAA0000A1Z5", parent_name: "Sundry Creditors" }),
    ],
  });
  assert.equal(result.matchType, "direct_match");
  assert.equal(result.ledgerName, "Surya Steel Trading Co");
});

test("supplier matcher does not auto-select colliding normalized names", () => {
  const result = suggestSupplierLedger({
    supplierName: "Surya Steel Trading Company",
    supplierGstin: "",
    ledgers: [
      master({ tally_name: "Surya Steel Trading Pvt Ltd", parent_name: "Sundry Creditors" }),
      master({ tally_name: "Surya Steel Trading LLP", parent_name: "Sundry Creditors" }),
    ],
  });
  assert.notEqual(result.matchType, "direct_match");
  assert.equal(result.candidateLedgerNames.length, 2);
});

test("line matcher uses unique live HSN and unit without AI", async () => {
  const [result] = await suggestPurchaseLineMasters({
    lines: [{
      lineId: "1",
      description: "Sponge Iron Lumps",
      hsn: "72031000",
      unit: "MT",
      supplierStateCode: "27",
      buyerStateCode: "27",
      needsStockItem: true,
      needsPurchaseLedger: true,
    }],
    stockItems: [
      master({ tally_name: "M S Scrap & Sponge Iron", master_type: "stock_item", hsn_code: "72031000", unit_name: "MTS" }),
      master({ tally_name: "M S Scrap", master_type: "stock_item", hsn_code: "72044900", unit_name: "MTS" }),
    ],
    ledgers: [
      master({ tally_name: "M.S. Scrap Purchase", parent_name: "Indigenous Scrap & Sponge Purchase" }),
      master({ tally_name: "O.M.S. Scrap Purchase", parent_name: "Outside Maharashtra Purchase" }),
      master({ tally_name: "Input ITC CGST 9%", parent_name: "Duties & Taxes" }),
    ],
  });
  assert.equal(result.stockItem.matchType, "direct_match");
  assert.equal(result.stockItem.masterName, "M S Scrap & Sponge Iron");
  assert.notEqual(result.purchaseLedger.masterName, "Input ITC CGST 9%");
});

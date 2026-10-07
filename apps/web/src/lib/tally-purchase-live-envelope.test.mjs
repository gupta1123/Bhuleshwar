import assert from "node:assert/strict";
import test from "node:test";

import {
  liveValidationMasterRow,
  liveValidationMetadata,
} from "./tally-purchase-live-envelope.ts";

test("live validation metadata excludes legacy catalogue arrays", () => {
  const metadata = liveValidationMetadata({
    source: "live_tally",
    companyName: "Solution Nyx",
    fetchedAt: "2026-08-29T00:00:00.000Z",
    validatedAt: "2026-09-09T08:00:00.000Z",
    validation: { catalogueDigest: "a".repeat(64), completeTypes: ["ledger", "group", "stock_item", "unit"] },
    ledgers: [{ raw: "x".repeat(300_000) }],
    stockItems: [{ raw: "x".repeat(300_000) }],
    units: [{ raw: "x".repeat(300_000) }],
  });

  assert.equal(metadata.source, "live_tally");
  assert.equal(metadata.companyName, "Solution Nyx");
  assert.equal(metadata.validatedAt, "2026-09-09T08:00:00.000Z");
  assert.equal(metadata.catalogueIdentity.catalogueDigest, "a".repeat(64));
  assert.equal("ledgers" in metadata, false);
  assert.equal("stockItems" in metadata, false);
  assert.ok(JSON.stringify(metadata).length < 1024);
});

test("selected validation masters contain only normalized fields", () => {
  const row = liveValidationMasterRow({
    id: "live:ledger:1:supplier",
    name: "Supplier",
    parent: "Sundry Creditors",
    gstin: null,
    hsnCode: null,
    unitName: null,
    taxRate: null,
    groupPath: "Primary > Current Liabilities > Sundry Creditors",
    taxType: null,
    gstDutyHead: null,
    closingBalance: 100,
    closingBalanceType: "Cr",
  });

  assert.equal(row.guid, null);
  assert.equal(row.name, "Supplier");
  assert.equal("raw" in row, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("./bank-statement-posting-readiness.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { isReadyForTallyPosting } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

const ready = (overrides = {}) => ({
  ledgerName: "Customer A",
  ledgerNeedsReview: false,
  presence: { status: "missing" },
  billRequired: false,
  amount: 20_000,
  ...overrides,
});

const allocation = (overrides = {}) => ({
  status: "ready_to_post",
  requiresUserReview: false,
  isEligibleForPosting: true,
  unallocatedAmount: 0,
  allocations: [{ referenceName: "INV-1", allocatedAmount: 20_000 }],
  ...overrides,
});

test("mixed batches retain blocked rows and post only ready rows", () => {
  const rows = Array.from({ length: 30 }, (_, id) => ({ id, ...ready() }));
  for (const id of [0, 1]) Object.assign(rows[id], {
    billRequired: true,
    allocation: allocation({ status: "needs_review", requiresUserReview: true }),
  });
  for (const id of [27, 28, 29]) rows[id].ledgerName = "";
  assert.deepEqual(rows.filter(isReadyForTallyPosting).map((row) => row.id),
    Array.from({ length: 25 }, (_, index) => index + 2));
  assert.equal(rows.length, 30);
});

test("direct posting permits unchecked rows but never known duplicates or bill allocations", () => {
  assert.equal(isReadyForTallyPosting(ready({ directPosting: true, presence: undefined, billRequired: true })), true);
  for (const status of ["checking", "failed", "found", "ambiguous"]) {
    assert.equal(isReadyForTallyPosting(ready({ directPosting: true, presence: { status } })), false);
  }
  assert.equal(isReadyForTallyPosting(ready({
    directPosting: true,
    presence: { status: "missing", duplicateInTally: true },
  })), false);
  assert.equal(isReadyForTallyPosting(ready({ directPosting: true, allocation: allocation() })), false);
});

test("bill-wise rows require a complete balanced allocation", () => {
  assert.equal(isReadyForTallyPosting(ready({ billRequired: true })), false);
  assert.equal(isReadyForTallyPosting(ready({ billRequired: true, allocation: allocation() })), true);
  assert.equal(isReadyForTallyPosting(ready({
    billRequired: true,
    allocation: allocation({ unallocatedAmount: 1 }),
  })), false);
});

test("the page sends the same readiness policy and no synthetic direct Advance", async () => {
  const page = await readFile(new URL("../components/bank-statements/BankStatementsPage.tsx", import.meta.url), "utf8");
  assert.match(page, /candidateTallyWorkTransactions\.filter\(\(transaction\) =>\s*isReadyForTallyPosting/);
  assert.match(page, /directPosting: skipBillMatching/);
  assert.doesNotMatch(page, /buildDirectPostingAdvanceAllocation/);
  assert.match(page, /liveLedgerContext: buildQueueLedgerContext/);
});

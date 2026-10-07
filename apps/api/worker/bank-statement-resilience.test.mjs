import assert from "node:assert/strict";
import test from "node:test";

import {
  addBankStatementPageProvenance,
  classifyBankStatementBatchOutcome,
  shouldAttemptBankStatementSingleShot,
  sortBankStatementTransactionsByProvenance,
  unresolvedBankStatementRecoveryPages,
  validateBankStatementPageCoverage,
} from "./bank-statement-resilience.mjs";

test("dense short statements skip single-shot extraction", () => {
  const densePage = Array.from({ length: 40 }, (_, index) =>
    `01/08/2026 NEFT PARTY ${index} 1,000.00 50,000.00`
  ).join("\n");
  assert.equal(shouldAttemptBankStatementSingleShot({
    isPdf: true,
    pageCount: 5,
    pages: [{ text: densePage }, { text: densePage }],
    maxPages: 8,
  }), false);
});

test("sparse multi-page PDFs never use unverified single-shot extraction", () => {
  assert.equal(shouldAttemptBankStatementSingleShot({
    isPdf: true,
    pageCount: 8,
    pages: Array.from({ length: 8 }, (_, index) => ({ text: `Page ${index + 1}` })),
    maxPages: 8,
  }), false);
  assert.equal(shouldAttemptBankStatementSingleShot({
    isPdf: true,
    pageCount: 1,
    pages: [{ text: "01/08/2026 NEFT PARTY 1,000.00 50,000.00" }],
    maxPages: 8,
  }), true);
});

test("a partial two-page AI response leaves the omitted page unresolved", () => {
  const result = validateBankStatementPageCoverage({
    transactions: [{
      description: "page one row",
      raw_payload: { row: { sourcePage: 1 } },
    }],
    pageResults: [
      { pageNumber: 1, status: "transactions", transactionCount: 1 },
    ],
    pages: [
      { pageNumber: 1, likelyHasRows: true },
      { pageNumber: 2, likelyHasRows: true },
    ],
    method: "text_batch",
  });
  assert.deepEqual(result.unresolvedPages, [2]);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].raw_payload.extractionProvenance.startPage, 1);
});

test("every page must either contain usable rows or explicitly confirm no transactions", () => {
  const result = validateBankStatementPageCoverage({
    transactions: [],
    pageResults: [
      { pageNumber: 1, status: "no_transactions", transactionCount: 0 },
      { pageNumber: 2, status: "no_transactions", transactionCount: 0 },
    ],
    pages: [
      { pageNumber: 1, likelyHasRows: false },
      { pageNumber: 2, likelyHasRows: true },
    ],
  });
  assert.deepEqual(result.pageOutcomes.map((outcome) => outcome.status), [
    "confirmed_non_transaction",
    "unverified",
  ]);
  assert.deepEqual(result.unresolvedPages, [2]);
});

test("a page remains incomplete when visible row evidence exceeds usable AI rows", () => {
  const result = validateBankStatementPageCoverage({
    transactions: [{
      description: "only extracted row",
      raw_payload: { row: { sourcePage: 3 } },
    }],
    pageResults: [{ pageNumber: 3, status: "transactions", transactionCount: 1 }],
    pages: [{
      pageNumber: 3,
      likelyHasRows: true,
      expectedMinimumRowCount: 2,
    }],
  });
  assert.equal(result.transactions.length, 0);
  assert.deepEqual(result.unresolvedPages, [3]);
  assert.equal(result.pageOutcomes[0].status, "incomplete");
});

test("an unreadable text page cannot be certified empty without rendered-image recovery", () => {
  const result = validateBankStatementPageCoverage({
    transactions: [],
    pageResults: [{ pageNumber: 2, status: "no_transactions", transactionCount: 0 }],
    pages: [{
      pageNumber: 2,
      likelyHasRows: false,
      canConfirmNoTransactions: false,
    }],
  });
  assert.deepEqual(result.unresolvedPages, [2]);
});

test("multi-page rows without source pages are retried instead of being assigned to page one", () => {
  const result = validateBankStatementPageCoverage({
    transactions: [{ description: "unassigned", raw_payload: { row: {} } }],
    pageResults: [],
    pages: [
      { pageNumber: 5, likelyHasRows: true },
      { pageNumber: 6, likelyHasRows: true },
    ],
  });
  assert.equal(result.transactions.length, 0);
  assert.equal(result.droppedUnassignedRowCount, 1);
  assert.deepEqual(result.unresolvedPages, [5, 6]);
});

test("single-page recovery safely assigns a row even when the model omits sourcePage", () => {
  const result = validateBankStatementPageCoverage({
    transactions: [{ description: "isolated row", raw_payload: { row: {} } }],
    pageResults: [],
    pages: [{ pageNumber: 7, likelyHasRows: true }],
    method: "rendered_image_recovery",
  });
  assert.deepEqual(result.unresolvedPages, []);
  assert.equal(result.transactions[0].raw_payload.extractionProvenance.startPage, 7);
});

test("empty summary batches do not trigger recovery", () => {
  assert.deepEqual(classifyBankStatementBatchOutcome({ rowCount: 0, likelyHasRows: false }), {
    status: "empty_non_transaction",
    requiresRecovery: false,
  });
  assert.equal(classifyBankStatementBatchOutcome({ rowCount: 0, likelyHasRows: true }).requiresRecovery, true);
});

test("recovered rows return to page order before balance validation", () => {
  const pageFour = addBankStatementPageProvenance([{ description: "later" }], {
    startPage: 4,
    endPage: 4,
    method: "text_batch",
  });
  const recoveredPageTwo = addBankStatementPageProvenance([{ description: "earlier" }], {
    startPage: 2,
    endPage: 2,
    method: "rendered_image_recovery",
  });
  assert.deepEqual(
    sortBankStatementTransactionsByProvenance([...pageFour, ...recoveredPageTwo]).map((row) => row.description),
    ["earlier", "later"]
  );
});

test("failed and empty recovery pages remain unresolved", () => {
  assert.deepEqual(unresolvedBankStatementRecoveryPages([
    { page: 1, status: "succeeded" },
    { page: 2, status: "empty" },
    { page: 3, status: "failed" },
    { page: 4, status: "confirmed_non_transaction" },
  ], [1, 2, 3, 4, 5]), [2, 3, 5]);
});

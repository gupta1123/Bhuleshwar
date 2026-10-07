import test from "node:test";
import assert from "node:assert/strict";
import { validateRunningBalanceContinuity } from "./bank-statement-balance-validation.mjs";

function row(balance, { debit = null, credit = null } = {}) {
  return { balance_amount: balance, debit_amount: debit, credit_amount: credit };
}

test("accepts a statement printed newest-first", () => {
  const rows = [
    row(140, { credit: 10 }),
    row(130, { debit: 20 }),
    row(150, { credit: 50 }),
  ];
  const result = validateRunningBalanceContinuity(rows, 100);
  assert.equal(result.valid, true);
  assert.equal(result.orientation, "reverse");
  assert.equal(result.reverseBreakCount, 0);
});

test("accepts a statement printed oldest-first", () => {
  const rows = [
    row(100, { credit: 100 }),
    row(75, { debit: 25 }),
    row(125, { credit: 50 }),
  ];
  const result = validateRunningBalanceContinuity(rows, 0);
  assert.equal(result.valid, true);
  assert.equal(result.orientation, "forward");
});

test("keeps failures when neither direction reconciles", () => {
  const result = validateRunningBalanceContinuity([
    row(100, { credit: 100 }),
    row(999, { debit: 25 }),
  ], 0);
  assert.equal(result.valid, false);
  assert.ok(result.breaks.length > 0);
});

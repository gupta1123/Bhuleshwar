import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRunningBalanceOrder, correctRowsFromRunningBalance, validateRunningBalanceContinuity } from "./bank-statement-running-balance.mjs";

test("preserves an explicit first-row credit even when an opening balance disagrees", () => {
  const original = { description: "FIRST ROW", debit_amount: null, credit_amount: 10000, balance_amount: 90000, category: "receipt" };
  assert.equal(correctRowsFromRunningBalance([original], { openingBalance: 100000 })[0], original);
});

test("preserves explicit columns when no opening balance was extracted", () => {
  const original = { description: "FIRST ROW", debit_amount: null, credit_amount: 10000, balance_amount: 90000, category: "receipt" };
  assert.equal(correctRowsFromRunningBalance([original])[0], original);
});

test("reports unavailable instead of verified when no balance transition can be checked", () => {
  const validation = validateRunningBalanceContinuity([
    { debit_amount: 100, credit_amount: null, balance_amount: null },
  ]);
  assert.equal(validation.status, "unavailable");
  assert.equal(validation.valid, false);
  assert.equal(validation.checkedTransitions, 0);
});

test("detects a forward chronological SBI-style statement", () => {
  const rows = [
    { debit_amount: 100, credit_amount: null, balance_amount: 900 },
    { debit_amount: null, credit_amount: 250, balance_amount: 1150 },
    { debit_amount: 50, credit_amount: null, balance_amount: 1100 },
  ];
  assert.equal(analyzeRunningBalanceOrder(rows, 1000).orientation, "forward");
  assert.equal(validateRunningBalanceContinuity(rows, 1000).valid, true);
});

test("detects a reverse chronological PNB/HDFC-style statement", () => {
  const rows = [
    { debit_amount: null, credit_amount: 250, balance_amount: -750 },
    { debit_amount: 100, credit_amount: null, balance_amount: -1000 },
    { debit_amount: null, credit_amount: 200, balance_amount: -900 },
  ];
  assert.equal(analyzeRunningBalanceOrder(rows, -1100).orientation, "reverse");
  const validation = validateRunningBalanceContinuity(rows, -1100);
  assert.equal(validation.valid, true);
  assert.equal(validation.checkedTransitions, 3);
});

test("preserves Central Bank DR statement columns", () => {
  const rows = [
    { description: "FIRST CREDIT", debit_amount: null, credit_amount: 855079, balance_amount: -390562086.57 },
    { description: "SECOND CREDIT", debit_amount: null, credit_amount: 853667, balance_amount: -389708419.57 },
    { description: "FOLLOWING DEBIT", debit_amount: 27500000, credit_amount: null, balance_amount: -417208419.57 },
  ];
  assert.deepEqual(correctRowsFromRunningBalance(rows), rows);
  assert.equal(validateRunningBalanceContinuity(rows).valid, true);
});

test("uses balance evidence only when both amount columns are populated", () => {
  const rows = [
    { debit_amount: 100, credit_amount: null, balance_amount: 900 },
    { description: "AMBIGUOUS", debit_amount: 50, credit_amount: 50, balance_amount: 950, category: "unknown" },
  ];
  const corrected = correctRowsFromRunningBalance(rows, { openingBalance: 1000 });
  assert.equal(corrected[1].debit_amount, null);
  assert.equal(corrected[1].credit_amount, 50);
  assert.equal(corrected[1].category, "receipt");
  assert.equal(corrected[1].raw_payload.balanceCorrection.orientation, "forward");
});

test("reports manual review when neither order reconciles", () => {
  const rows = [
    { debit_amount: 100, credit_amount: null, balance_amount: 950 },
    { debit_amount: 100, credit_amount: null, balance_amount: 920 },
  ];
  const validation = validateRunningBalanceContinuity(rows, 1000);
  assert.equal(validation.valid, false);
  assert.ok(validation.breaks.length > 0);
});

import assert from "node:assert/strict";
import test from "node:test";

import { validatePostingBalanceProof } from "./bank-statement-posting-safety.ts";

test("blocks an invalid statement running-balance sequence", () => {
  const result = validatePostingBalanceProof(
    { available: true, statementSequenceValid: false },
    []
  );
  assert.equal(result.safe, false);
});

test("allows a closing difference fully explained by missing rows", () => {
  const result = validatePostingBalanceProof(
    {
      available: true,
      statementSequenceValid: true,
      statementOpeningBalance: 1000,
      tallyOpeningBalance: 1000,
      statementClosingBalance: 1350,
      tallyClosingBalance: 1000,
      balancesMatch: false,
    },
    [
      { creditAmount: 500, debitAmount: 0, presenceStatus: "missing" },
      { creditAmount: 0, debitAmount: 150, presenceStatus: "missing" },
      { creditAmount: 900, debitAmount: 0, presenceStatus: "found" },
    ]
  );
  assert.equal(result.safe, true);
  assert.equal(result.explainedDifference, 350);
});

test("blocks an unexplained opening or closing difference", () => {
  assert.equal(
    validatePostingBalanceProof(
      {
        available: true,
        statementSequenceValid: true,
        statementOpeningBalance: 1000,
        tallyOpeningBalance: 900,
      },
      []
    ).safe,
    false
  );
  assert.equal(
    validatePostingBalanceProof(
      {
        available: true,
        statementSequenceValid: true,
        statementOpeningBalance: 1000,
        tallyOpeningBalance: 1000,
        statementClosingBalance: 1300,
        tallyClosingBalance: 1000,
        balancesMatch: false,
      },
      [{ creditAmount: 200, debitAmount: 0, presenceStatus: "missing" }]
    ).safe,
    false
  );
});

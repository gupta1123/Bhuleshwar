import assert from "node:assert/strict";
import test from "node:test";

import {
  bankStatementAccountDiagnostics,
  combinedLedgerCatalogueDecision,
  extractAccountFromBankStatementMarkdown,
  mergeBankStatementAccount,
} from "./bank-statement-account.mjs";

test("recovers the latest Axis statement identity from AnyDoc Markdown", () => {
  const markdown = `# AXIS BANK ONE DAY STATEMENT

|Account statement-generated for bank statement workflow testing||
|---|---|
|Account holder|Statement account|
|Solution Nyx|Axis Bank - 7440012233|

|DATE|TRANSACTION DETAILS|REFERENCE|WITHDRAWAL|DEPOSIT|BALANCE|`;

  assert.deepEqual(extractAccountFromBankStatementMarkdown(markdown), {
    bankName: "Axis Bank",
    accountNumber: "7440012233",
    accountHolderName: "Solution Nyx",
    ifscCode: "",
  });
});

test("recovers explicit account and IFSC fields from a key-value table", () => {
  const markdown = `|Bank Name|Account No.|Account Holder Name|IFSC Code|
|---|---|---|---|
|State Bank of India|4286 1007 319|GAJKESARI STEELS|SBIN0001234|`;
  assert.deepEqual(extractAccountFromBankStatementMarkdown(markdown), {
    bankName: "State Bank of India",
    accountNumber: "42861007319",
    accountHolderName: "GAJKESARI STEELS",
    ifscCode: "SBIN0001234",
  });
});

test("keeps AI values and fills only missing account fields from Markdown", () => {
  assert.deepEqual(
    mergeBankStatementAccount(
      { bankName: "AXIS BANK", accountNumber: null, accountHolderName: null, ifscCode: null },
      { bankName: "Axis Bank", accountNumber: "7440012233", accountHolderName: "Solution Nyx", ifscCode: "" }
    ),
    { bankName: "AXIS BANK", accountNumber: "7440012233", accountHolderName: "Solution Nyx", ifscCode: null }
  );
});

test("routes oversized ledger catalogues away from combined extraction", () => {
  assert.equal(combinedLedgerCatalogueDecision(["Cash", "Sales"]).useCombined, true);
  const largeCatalogue = Array.from({ length: 1_001 }, (_, index) => `Ledger ${index}`);
  const decision = combinedLedgerCatalogueDecision(largeCatalogue);
  assert.equal(decision.useCombined, false);
  assert.equal(decision.reason, "ledger_catalogue_too_large");
});

test("reports missing identity separately from optional holder and IFSC fields", () => {
  assert.deepEqual(bankStatementAccountDiagnostics({ bankName: null, accountNumber: null }), {
    fields: { bankName: false, accountNumber: false, accountHolderName: false, ifscCode: false },
    hasIdentity: false,
    hasAccountNumber: false,
    recoveredFromMarkdown: false,
  });
});



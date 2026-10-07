import assert from "node:assert/strict";
import test from "node:test";

import {
  extractBankStatementMarkdownAmounts,
  parseBankStatementMoney,
  reconcileBankStatementMarkdownAmounts,
} from "./bank-statement-markdown-amounts.mjs";

test("parses Indian-grouped statement amounts without changing magnitude", () => {
  assert.equal(parseBankStatementMoney("5,00,20,000.00"), 50020000);
  assert.equal(parseBankStatementMoney("5,01,40,000.00"), 50140000);
  assert.equal(parseBankStatementMoney("(1,250.50)"), -1250.5);
  assert.equal(parseBankStatementMoney("9,750.00 DR"), -9750);
});

test('recognizes separate Dr/Cr and Txn No headings, but rejects merged debit headings',()=>{
  const table='| Txn No. | Dr Amount | Cr Amount | Balance |\n|---|---|---|---|\n| T123456 | 100.00 | | 900.00 |';
  assert.equal(extractBankStatementMarkdownAmounts(table).rows[0].debitAmount,100);
  const merged=table.replace('Dr Amount','Cheque No. Dr Amount');
  assert.equal(extractBankStatementMarkdownAmounts(merged).rows[0].debitAmount,null);
});

test("extracts opening balance and transaction amounts from Markdown tables", () => {
  const markdown = `
| Opening balance (INR) | 5,00,00,000.00 | Page | 1 of 3 |
|---|---|---|---|

| TXN DATE | DESCRIPTION | REFERENCE | DEBIT (INR) | CREDIT (INR) | BALANCE (INR) |
|---|---|---|---|---|---|
| 2026-08-24 | First receipt | GKOB1-S01 | - | 20,000.00 | 5,00,20,000.00 |
| 2026-08-24 | Second receipt | GKOB1-S02 | - | 1,20,000.00 | 5,01,40,000.00 |
`;
  assert.deepEqual(extractBankStatementMarkdownAmounts(markdown), {
    openingBalance: 50000000,
    rows: [
      { reference: "GKOB1S01", sourceDate: "2026-08-24", narration: "First receipt", debitAmount: null, creditAmount: 20000, balanceAmount: 50020000 },
      { reference: "GKOB1S02", sourceDate: "2026-08-24", narration: "Second receipt", debitAmount: null, creditAmount: 120000, balanceAmount: 50140000 },
    ],
  });
});

test("extracts verifiable rows when a statement has no reference or balance column", () => {
  const markdown = `| Date | Particulars | Debit | Credit |\n|---|---|---|---|\n| 05-Sep-2026 | Customer receipt | | 1,250.00 |`;
  assert.deepEqual(extractBankStatementMarkdownAmounts(markdown).rows, [{
    reference: "",
    sourceDate: "05-Sep-2026",
    narration: "Customer receipt",
    debitAmount: null,
    creditAmount: 1250,
    balanceAmount: null,
  }]);
});

test("reconciles AI magnitude errors using exact source references", () => {
  const markdown = `
| Opening balance | 5,00,00,000.00 |
|---|---|
| DATE | REFERENCE | DEBIT | CREDIT | BALANCE |
|---|---|---|---|---|
| 2026-08-24 | GKOB1-S01 | - | 20,000.00 | 5,00,20,000.00 |
| 2026-08-24 | GKOB1-S02 | - | 1,20,000.00 | 5,01,40,000.00 |
`;
  const parsed = {
    openingBalance: 500000000,
    transactions: [
      { reference_number: "GKOB1-S01", debit_amount: null, credit_amount: 20000, balance_amount: 500020000, raw_payload: {} },
      { reference_number: "GKOB1-S02", debit_amount: null, credit_amount: 120000, balance_amount: 501400000, raw_payload: {} },
    ],
  };
  const result = reconcileBankStatementMarkdownAmounts(parsed, markdown);
  assert.equal(result.openingBalance, 50000000);
  assert.equal(result.transactions[0].balance_amount, 50020000);
  assert.equal(result.transactions[1].balance_amount, 50140000);
  assert.equal(result.markdownAmountDiagnostics.correctedRowCount, 2);
});


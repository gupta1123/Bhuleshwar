import assert from "node:assert/strict";
import test from "node:test";

import { deterministicTransactionsFromAnydoc } from "./bank-statement-deterministic.mjs";

test("recognizes an AnyDoc table with fused withdrawal and deposit headings", () => {
  const markdown = `
Account statement-controlled open-bill workflow test 01 Sep 2026
|DATE|PARTICULARS|REFERENCE / UTR|WITHDRAWAL DEPOSIT|
|---|---|---|---|
|01 Sep|NEFT CR FROM Example Customer|GKSSEP0101|10,000.00|`;
  const result = deterministicTransactionsFromAnydoc(markdown);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].transaction_date, "2026-09-01");
  assert.equal(result.transactions[0].credit_amount, 10_000);
  assert.equal(result.transactions[0].debit_amount, null);
});

test("recovers a transaction embedded in an Axis header and infers its year", () => {
  const markdown = `Statement period: 28 Aug 2026 to 28 Aug 2026
|Date 28 Aug|Description / Particulars IMPS CR Acme Metals|Reference / UTR AXIS001|Debit|Credit 10,000.00|Balance 1,10,000.00|
|---|---|---|---|---|---|
|28 Aug|NEFT DR Vendor Payment|AXIS002|2,500.00||1,07,500.00|`;
  const result = deterministicTransactionsFromAnydoc(markdown);
  assert.equal(result.transactions.length, 2);
  assert.deepEqual(result.transactions.map((row) => ({
    date: row.transaction_date,
    debit: row.debit_amount,
    credit: row.credit_amount,
    balance: row.balance_amount,
  })), [
    { date: "2026-08-28", debit: null, credit: 10000, balance: 110000 },
    { date: "2026-08-28", debit: 2500, credit: null, balance: 107500 },
  ]);
});

test("normalizes spacer columns in an HDFC-style table", () => {
  const markdown = `
|Date|Narration / Description|Reference / UTR|Withdrawal|||Deposit|Balance|
|---|---|---|---|---|---|---|---|
|05-Sep-2026|NEFT DR Supplier|HDFC01|1,250.00||||98,750.00|
|05-Sep-2026|RTGS CR Customer|HDFC02||||5,000.00|1,03,750.00|`;
  const rows = deterministicTransactionsFromAnydoc(markdown).transactions;
  assert.deepEqual(rows.map((row) => [row.debit_amount, row.credit_amount]), [[1250, null], [null, 5000]]);
});

test("finds a real transaction header below a metadata table header", () => {
  const markdown = `
|Account number|123456|Statement period|01-Sep-2026 to 02-Sep-2026|
|---|---|---|---|
|Date|Transaction Details|Reference|Withdrawal|Deposit|Balance|
|01-Sep-2026|UPI CR Customer|BOB01||2,000.00|52,000.00|
|02-Sep-2026|UPI DR Vendor|BOB02|500.00||51,500.00|`;
  const rows = deterministicTransactionsFromAnydoc(markdown).transactions;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reference_number, "BOB01");
  assert.equal(rows[1].debit_amount, 500);
});

test("normalizes a fused PNB debit heading and split decimal balance", () => {
  const markdown = `Statement Period : 03-09-2026 to 03-09-2026
|Txn No.|Txn Date|||Description|Branch Name|Cheque No. Dr Amount|Cr Amount||Balance|KIMS Remarks|
|---|---|---|---|---|---|---|---|---|---|---|
|T1|03-09-2026|||NRTGS/PUNBR transfer|-|12,52,276.00|||10,43,89,320. 49 Dr.||
|T2|03-09-2026|||NRTGS/ICICR receipt|-||5,20,863.00||10,38,46,068. 49 Dr.||`;
  const rows = deterministicTransactionsFromAnydoc(markdown).transactions;
  assert.deepEqual(rows.map((row) => [row.debit_amount, row.credit_amount, row.balance_amount]), [
    [1252276, null, -104389320.49],
    [null, 520863, -103846068.49],
  ]);
});

test("declines a partial deterministic result when later-page columns are lost", () => {
  const markdown = `
|Txn No.|Txn Date|Description|Dr Amount|Cr Amount|Balance|
|---|---|---|---|---|---|
|T1|03-09-2026|NRTGS DR Supplier|100.00||900.00 Dr.|
Page No 1 -
NRTGS/PUNBR wrapped continuation U123456 03-09-2026 50.00 950.00 Dr.`;
  assert.equal(deterministicTransactionsFromAnydoc(markdown), null);
});

test("accepts a valid HDFC timestamp contaminated by a repeated bank footer", () => {
  const markdown = `Statement of Account For Period: 02-Sep-2026 to 02-Sep-2026
|Transaction Date|Transaction Description|Reference No.|Value Date|Debit Amount|Credit Amount|Closing Balance|
|---|---|---|---|---|---|---|
|02-Sep-2026 19:47:45 HDFC BANK LIMITED|RTGS Cr- Customer receipt|REF001|02-Sep-2026||1,131,857.00|-278,256,565.09|`;
  const rows = deterministicTransactionsFromAnydoc(markdown).transactions;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].transaction_date, "2026-09-02");
  assert.equal(rows[0].credit_amount, 1131857);
});


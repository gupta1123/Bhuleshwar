import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocumentLocal, processBankStatementMarkdownLocal } from "./parser.mjs";

test("parses CSV to Markdown locally by default", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-anydoc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, "sales.csv");
  fs.writeFileSync(input, "Invoice,Amount\nINV-1,1250\n", "utf8");
  const result = await parseDocumentLocal({ filePath: input });
  assert.equal(result.outputFormat, "markdown");
  assert.match(result.content, /Invoice/);
  assert.match(result.content, /1250/);
  assert.equal(result.metadata.processing, "local");
  assert.equal(result.metadata.ocrUsed, false);
});

test("returns structured JSON for an RTF document", async () => {
  const bytes = Buffer.from(String.raw`{\rtf1\ansi{\b Quarterly Report}\par Revenue increased.}`);
  const result = await parseDocumentLocal({ bytes, fileName: "report.rtf", output: "json" });
  assert.equal(result.outputFormat, "json");
  assert.equal(result.metadata.structured, true);
  assert.ok(Array.isArray(result.content.blocks));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("rejects unknown output formats", async () => {
  await assert.rejects(
    parseDocumentLocal({ bytes: Buffer.from("a,b\n1,2"), fileName: "test.csv", output: "xml" }),
    /markdown.*json/i
  );
});

test("uses Kalika worker logic for normalized bank-statement JSON", async () => {
  const markdown = `| Account Holder | Account Number | Bank Name |
|---|---|---|
| Kalika Steel | 8822014500 | ICICI Bank |

| Opening Balance | 1000.00 |
|---|---|
| Statement | 1000.00 |

| Transaction Date | Description | Reference | Debit | Credit | Balance |
|---|---|---|---|---|---|
| 01 Aug 2026 | NEFT CREDIT-NOVA ALLOY | REF001 | - | 200.00 | 1200.00 |
| 02 Aug 2026 | UPI DEBIT-METRO MART | REF002 | 50.00 | - | 1150.00 |`;
  const result = await processBankStatementMarkdownLocal(markdown, { pageCount: 2 });
  assert.equal(result.parsed.account.accountNumber, "8822014500");
  assert.equal(result.parsed.openingBalance, 1000);
  assert.equal(result.parsed.transactions.length, 2);
  assert.equal(result.parsed.transactions[0].credit_amount, 200);
  assert.equal(result.parsed.transactions[1].debit_amount, 50);
  assert.equal(result.parsed.transactions[0].raw_payload.extractionProvenance.method, "deterministic_anydoc");
  assert.equal(result.parsed.transactions[0].raw_payload.extractionProvenance.endPage, 2);
  assert.equal(result.diagnostics.markdownAmounts.sourceRowCount, 2);
  assert.equal(result.diagnostics.balanceValidation.status, "verified");
});

test("returns inconsistent rows for safe manual review instead of failing the whole import", async () => {
  const markdown = `| Opening Balance | 1000.00 |
|---|---|
| Statement | 1000.00 |

| Transaction Date | Description | Reference | Debit | Credit | Balance |
|---|---|---|---|---|---|
| 01 Aug 2026 | SBI TRANSFER | REF001 | 100.00 | - | 500.00 |
| 02 Aug 2026 | SBI TRANSFER | REF002 | 100.00 | - | 400.00 |`;
  const result = await processBankStatementMarkdownLocal(markdown);
  assert.equal(result.parsed.transactions.length, 2);
  assert.equal(result.diagnostics.balanceValidation.status, "failed");
  assert.ok(result.diagnostics.balanceValidation.breaks.length > 0);
});

test("does not guess when statement tables cannot be normalized", async () => {
  const markdown = `|Txn No.|Txn Date|Description|Dr Amount|Cr Amount|Balance|
|---|---|---|---|---|---|
|T1|03-09-2026|NRTGS DR Supplier|100.00||900.00 Dr.|
Page No 1 -
NRTGS/PUNBR wrapped continuation U123456 03-09-2026 50.00 950.00 Dr.`;
  await assert.rejects(
    () => processBankStatementMarkdownLocal(markdown),
    /could not be normalized deterministically/
  );
});

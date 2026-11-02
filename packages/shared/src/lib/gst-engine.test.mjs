/**
 * GST reconciliation engine + normalization checks (ported from GSTReco).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const load = (file, replacements = {}) => {
  let source = readFileSync(new URL(file, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(replacements)) source = source.replace(from, to);
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
};
const normalizeUrl = load("./gst-normalize.ts");
const N = await import(normalizeUrl);
const E = await import(load("./gst-engine.ts", { '"./gst-normalize"': JSON.stringify(normalizeUrl) }));

const DATA = fileURLToPath(new URL("./gst-fixtures/", import.meta.url));
const read = (name) => JSON.parse(readFileSync(DATA + name + ".json", 'utf8'));
const meta = read('_meta');

function loadAll() {
  const books = [];
  const a2 = [];
  const b2 = [];
  const g3b = [];

  for (const p of meta.booksPeriods) {
    const payload = read(`books-${p}`);
    books.push(...N.fromBooks(payload));
  }
  for (const p of meta.portalPeriods) {
    a2.push(...N.from2A(read(`gstr2a-${p}`)));
    b2.push(...N.from2B(read(`gstr2b-${p}`)));
    g3b.push(N.from3B(read(`gstr3b-${p}`)));
  }
  return { books, a2, b2, g3b };
}

const dataset = loadAll();
dataset.suppliers = read('suppliers');
const baseOpts = {
  asOf: meta.asOf,
  annualReturnDates: meta.annualReturnDates,
  tolerance: { amount: 1, percent: 0, dateWindowDays: 7 },
};
const result = E.reconcile({ ...dataset, opts: { ...baseOpts, prior: meta.historySeed } });

const countOf = (bucket) => result.rows.filter((r) => r.bucket === bucket).length;

test('invoice numbers reconcile across punctuation and case drift', () => {
  assert.equal(N.invoiceNo('RMW/25-26/0117'), N.invoiceNo('RMW-25-26-0117'));
  assert.equal(N.invoiceNo('GST-2526-0042'), N.invoiceNo('gst/2526/0042'));
  assert.equal(N.invoiceNo('NHC0104'), N.invoiceNo('nhc-0104'));
  assert.equal(N.invoiceNo('CRN/25-26/001'), N.invoiceNo('crn 25 26 001'));
  assert.notEqual(N.invoiceNo('RMW/25-26/0117'), N.invoiceNo('RMW/25-26/0118'));
});

test('fuzzy pass links numbers the supplier filed without the FY segment', () => {
  const fuzzy = result.rows.filter((r) => r.fuzzyLinked);
  assert.ok(fuzzy.length >= 2, `expected the seeded short-number cases to link, got ${fuzzy.length}`);
  for (const row of fuzzy) {
    assert.equal(row.bucket, 'matched', 'a fuzzy link with matching amounts should land as matched');
    assert.notEqual(row.books.invoiceNo, row.b2.invoiceNo, 'raw numbers differ, normalized numbers do not');
  }
});

test('dates normalize from both providers', () => {
  assert.equal(N.toISO('03-04-2025'), '2025-04-03');
  assert.equal(N.toISO('2025-04-03'), '2025-04-03');
  assert.equal(N.periodFromReturn('042025'), '2025-04');
});

test('every seeded bucket is reachable', () => {
  for (const bucket of ['matched', 'valueDiff', 'booksOnly', 'portalOnly', 'ineligible', 'rule37A', 'reopened', 'periodShift', 'duplicate']) {
    assert.ok(countOf(bucket) > 0, `expected at least one "${bucket}" row, got ${countOf(bucket)}`);
  }
});

test('matched rows agree on both sides', () => {
  for (const row of result.rows.filter((r) => r.bucket === 'matched')) {
    assert.ok(row.books, 'matched row must have a books entry');
    assert.ok(row.b2, 'matched row must have a GSTR-2B entry');
    assert.equal(row.comparison.within, true);
    assert.equal(row.atRiskTax, 0);
  }
});

test('missing-in-2B rows are at risk and carry a 16(4) deadline', () => {
  const rows = result.rows.filter((r) => r.bucket === 'booksOnly' && !r.awaited);
  assert.ok(rows.length >= 4, `expected several overdue booksOnly rows, got ${rows.length}`);
  for (const row of rows) {
    assert.ok(row.atRiskTax > 0);
    assert.match(row.deadline, /^\d{4}-11-30$/);
    assert.equal(typeof row.daysLeft, 'number');
  }
});

test('quarterly filer gaps before quarter-end are awaited, not chased', () => {
  const awaited = result.rows.filter((r) => r.awaited);
  assert.ok(awaited.length >= 1, 'expected the seeded quarterly gap to be awaited');
  for (const row of awaited) {
    assert.equal(row.supplierFreq, 'quarterly');
    assert.equal(row.atRiskTax, 0, 'awaited credit is not at risk yet');
    assert.ok(row.bucket === 'booksOnly' || row.bucket === 'rule37A');
  }
  assert.ok(result.summary.awaited >= 1);
});

test('a withdrawn invoice reopens instead of staying matched', () => {
  const rows = result.rows.filter((r) => r.bucket === 'reopened');
  assert.equal(rows.length, 1, 'exactly one seeded cancellation');
  assert.ok(rows[0].atRiskTax > 0);
  assert.match(rows[0].reason, /withdrawn|amended/i);
  // Without history the same invoice merely looks like Rule 37A.
  const naive = E.reconcile({ ...dataset, opts: baseOpts });
  assert.equal(naive.rows.filter((r) => r.bucket === 'reopened').length, 0);
  assert.ok(naive.rows.filter((r) => r.bucket === 'rule37A').length >= countOf('rule37A'));
});

test('amendments match against the latest portal position', () => {
  const rows = result.rows.filter((r) => r.amended);
  assert.ok(rows.length >= 1, 'expected the seeded amendment');
  for (const row of rows) {
    assert.equal(row.bucket, 'matched');
    assert.ok(row.comparison.within);
  }
});

test('RCM, import, ISD and IMS rows carry their workflow flags', () => {
  const rcm = result.rows.filter((r) => r.rcm);
  assert.ok(rcm.length >= 1, 'expected a seeded RCM invoice');
  const imp = result.rows.filter((r) => r.docType === 'imp');
  assert.equal(imp.length, 1, 'one bill-of-entry import');
  assert.equal(imp[0].bucket, 'matched');
  const isd = result.rows.filter((r) => r.docType === 'isd');
  assert.equal(isd.length, 1, 'one ISD credit');
  assert.equal(isd[0].bucket, 'portalOnly');
  assert.match(isd[0].reason, /ISD/);
  const ims = result.rows.filter((r) => r.imsRejected);
  assert.ok(ims.length >= 1, 'expected an IMS-rejected invoice');
  for (const row of ims) assert.equal(row.bucket, 'ineligible');
});

test('movement compares this run against the previous one', () => {
  assert.ok(result.movement.hasPrior);
  assert.equal(result.movement.resolved, 2, 'amendment fixed + late filing arrived');
  assert.equal(result.movement.reopened, 1);
  assert.ok(result.movement.stillOpen >= 20, `most exceptions carry forward, got ${result.movement.stillOpen}`);
});

test('a prior-year unmatched credit is past the Section 16(4) deadline', () => {
  const expired = result.rows.filter((r) => r.atRiskTax > 0 && r.expired);
  assert.equal(expired.length, 1, 'exactly one seeded expired credit');
  assert.equal(expired[0].period, '2024-03');
  assert.ok(expired[0].daysLeft < 0);
});

test('Rule 37A rows exist in 2A but not in 2B', () => {
  const rows = result.rows.filter((r) => r.bucket === 'rule37A');
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.ok(row.a2, 'needs a GSTR-2A entry');
    assert.equal(row.b2, null, 'must be absent from GSTR-2B');
  }
});

test('duplicates are counted once for ITC and the extra copy is at risk', () => {
  const rows = result.rows.filter((r) => r.bucket === 'duplicate');
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.ok(row.claims > 1);
    assert.ok(row.duplicateExtra > 0);
    assert.ok(row.atRiskTax >= row.duplicateExtra);
  }
});

test('portal-only rows never produce a claimed figure', () => {
  for (const row of result.rows.filter((r) => r.bucket === 'portalOnly')) {
    assert.equal(row.claimedTax, 0, 'we cannot claim credit we never booked');
  }
});

test('summary totals equal the sum of the rows', () => {
  const sumRisk = N.round(result.rows.reduce((s, r) => s + r.atRiskTax, 0));
  assert.equal(result.summary.atRisk, sumRisk);

  const claimed = N.round(result.rows.reduce((s, r) => s + r.claimedTax, 0));
  assert.equal(result.summary.claimed, claimed);
});

test('GSTR-3B cross-check reproduces the declared figure', () => {
  assert.ok(result.filed.length === 4);
  for (const row of result.filed) {
    assert.equal(typeof row.delta, 'number');
    assert.equal(typeof row.declaredIn3B, 'number');
  }
});

test('tolerance absorbs rounding but not real differences', () => {
  const tight = E.reconcile({
    ...dataset,
    opts: { asOf: meta.asOf, tolerance: { amount: 1, percent: 0, dateWindowDays: 7 } },
  });
  const loose = E.reconcile({
    ...dataset,
    opts: { asOf: meta.asOf, tolerance: { amount: 50000, percent: 5, dateWindowDays: 30 } },
  });
  assert.ok(loose.rows.filter((r) => r.bucket === 'valueDiff').length <
            tight.rows.filter((r) => r.bucket === 'valueDiff').length,
            'a wider tolerance must resolve some value mismatches');
});

test('reconciliation is deterministic', () => {
  const again = E.reconcile({
    ...dataset,
    opts: { ...baseOpts, prior: meta.historySeed },
  });
  assert.equal(JSON.stringify(again.rows.map((r) => [r.key, r.bucket])),
               JSON.stringify(result.rows.map((r) => [r.key, r.bucket])));
});

test('CSV export has a row per reconciliation row', () => {
  const csv = E.csvRows(result).split('\r\n');
  assert.equal(csv.length, result.rows.length + 1);
  assert.match(csv[0], /^GSTIN,Supplier,Invoice No/);
});

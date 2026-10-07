import test from 'node:test';
import assert from 'node:assert/strict';
import { readScopedOpenBills } from './open-bill-discovery.mjs';
import { exportCashDiscountOpenBillsFirst, extractNamedCollectionNames } from './bridge.mjs';
const options = { names: ['A', 'B', 'C'], check() {}, freeMemory: () => 2e9, batchLimit: () => 2 };

test('native bill discovery preserves date scope, escapes names and never requests global bills', async () => {
  const requests = [];
  const result = await exportCashDiscountOpenBillsFirst({ tallyUrl: 'unused' }, 'Company & Co', { dateFrom:'2026-04-01', dateTo:'2026-09-07' }, null, {
    freeMemory: () => 2e9, batchLimit: () => 2,
    exportCollection: async (_, request) => {
      assert.equal(request.tallyType, 'Ledger');
      assert.equal(request.fetchFields, 'Name');
      assert.equal(request.filterNames, undefined);
      return '<LEDGER NAME="A &amp; B"></LEDGER><LEDGER NAME="C"></LEDGER><LEDGER NAME="D"></LEDGER>';
    },
    exportXml: async (_, xml, label, timeout) => {
      requests.push(xml);
      assert.equal(timeout, 20000);
      assert.ok(xml.includes('<TYPE>Bills</TYPE><CHILDOF>'));
      assert.ok(xml.includes('<SVTODATE TYPE="Date">20260907</SVTODATE>'));
      assert.ok(!xml.includes('SVFROMDATE'));
      assert.ok(!xml.includes('<TYPE>Bill</TYPE>'));
      assert.ok(xml.includes('<SVCURRENTCOMPANY>Company &amp; Co</SVCURRENTCOMPANY>'));
      return `<BILL NAME="carry-forward-${requests.length}"><DATE>20250301</DATE></BILL>`;
    },
  });
  assert.equal(result.batchCount, 2);
  assert.ok(requests[0].includes('A &amp; B'));
  assert.equal((result.xml.match(/<BILL /g) || []).length, 2);
});

test('ledger discovery ignores Tally metadata counters but rejects unnamed collection rows', () => {
  assert.deepEqual(
    extractNamedCollectionNames('<CMPINFO><LEDGER>0</LEDGER></CMPINFO><LEDGER NAME="Customer A"></LEDGER><LEDGER><NAME>Customer B</NAME></LEDGER>','LEDGER'),
    ['Customer A', 'Customer B']
  );
  assert.throws(
    () => extractNamedCollectionNames('<LEDGER><PARENT>Customers</PARENT></LEDGER>', 'LEDGER'),
    /unidentified ledger record/
  );
});

test('discovery is sequential, deduplicated and reduces slow batches', async () => {
  const batches = []; let clock = 0; let active = false;
  const result = await readScopedOpenBills({ ...options, names: ['A','A','B','C','D'], now: () => clock,
    read: async batch => { assert.equal(active, false); active = true; batches.push(batch); clock += 6000; await Promise.resolve(); active = false; return '<BILL/>'; },
  });
  assert.deepEqual(batches, [['A','B'],['C'],['D']]);
  assert.equal(result.batchCount, 3);
});

test('failure stops discovery without retrying or returning partial success', async () => {
  let calls = 0;
  await assert.rejects(readScopedOpenBills({ ...options, read: async () => { calls++; throw new Error('timeout'); } }), /timeout/);
  assert.equal(calls, 1);
});

test('memory, cancellation and response limits stop further reads', async () => {
  let calls = 0;
  const read = async () => { calls++; return '12345'; };
  await assert.rejects(readScopedOpenBills({ ...options, read, freeMemory: () => 100 }), /256 MB/);
  await assert.rejects(readScopedOpenBills({ ...options, read, check: () => { throw new Error('cancelled'); } }), /cancelled/);
  assert.equal(calls, 0);
  await assert.rejects(readScopedOpenBills({ ...options, read, maxBytes: 4 }), /size limit/);
  assert.equal(calls, 1);
});

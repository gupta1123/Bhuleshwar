import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('./batch-cases.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { fileNameNumbers, planBatchCases } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const uploads = names => names.map((name, index) => ({ id: `u${index}`, name }));
const groups = plans => plans.map(plan => plan.uploadIds.join('+'));

test('file name numbers skip dates, years and phone or scanner names', () => {
  assert.deepEqual(fileNameNumbers('INV-004471.pdf'), ['4471']);
  assert.deepEqual(fileNameNumbers('Triveni PO 2026 8812.pdf'), ['8812']);
  assert.deepEqual(fileNameNumbers('bill 29102026.pdf'), []);
  assert.deepEqual(fileNameNumbers('IMG_20261029_123456.jpg'), []);
  assert.deepEqual(fileNameNumbers('scan_0012.jpg'), []);
  assert.deepEqual(fileNameNumbers('WhatsApp Image 2026-10-29 at 10.31.jpeg'), []);
});

test('files sharing a document number become one case; others stay single', () => {
  const plans = planBatchCases(uploads(['INV-4471.pdf', 'DC 4471.pdf', 'Gupta 918.pdf', 'Mehta.pdf']), { undone: [], moves: {} });
  assert.deepEqual(groups(plans), ['u0+u1', 'u2', 'u3']);
  assert.equal(plans[0].token, '4471');
  assert.equal(plans[1].token, null);
});

test('undo splits a group and moves put a file into another case or its own', () => {
  const files = uploads(['INV-4471.pdf', 'DC 4471.pdf', 'scan_0012.jpg']);
  assert.deepEqual(groups(planBatchCases(files, { undone: ['4471'], moves: {} })), ['u0', 'u1', 'u2']);
  const moved = planBatchCases(files, { undone: [], moves: { u2: 'u1' } });
  assert.deepEqual(groups(moved), ['u0+u1+u2']);
  assert.equal(moved[0].manual, true);
  assert.deepEqual(groups(planBatchCases(files, { undone: [], moves: { u1: 'u1' } })), ['u0', 'u1', 'u2']);
});

test('a number shared by too many files does not group them', () => {
  const files = uploads(Array.from({ length: 8 }, (_, i) => `Ledger 5500 part ${i}.pdf`));
  assert.equal(planBatchCases(files, { undone: [], moves: {} }).length, 8);
});

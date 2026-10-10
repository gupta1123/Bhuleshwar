import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = await readFile(new URL('./CollectionsDashboardPage.tsx', import.meta.url), 'utf8');
test('summary cards render as information, not navigation buttons', () => {
  const start = source.indexOf('function SummaryCard(');
  const end = source.indexOf('function PaginationControls(', start);
  assert.ok(start >= 0 && end > start);
  const snippet = source.slice(start, end) + '\nexports.Card = SummaryCard;';
  const code = ts.transpileModule(snippet, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { React, exports });
  const html = renderToStaticMarkup(React.createElement(exports.Card, { count: 424, label: 'Pending invoices' }));
  assert.match(html, /424/); assert.match(html, /Pending invoices/);
  assert.doesNotMatch(html, /<button|aria-pressed|tabindex/i);
});
test('presentation keeps separate navigation and a guarded review confirmation', () => {
  assert.match(source, /aria-label="Debit note views"/);
  assert.match(source, /label:'Pending'/); assert.match(source, /label:'Created'/);
  assert.match(source, />Review<\/button>/);
  assert.match(source, /disabled=\{!allowed\('discounts.post'\) \|\| !canCreateInTally\(reviewingProposal\)/);
  assert.match(source, /!reviewAcknowledged \|\| approvingId === reviewingProposal.id/);
  assert.match(source, /onClick=\{\(\) => void approveProposal\(reviewingProposal\)\}/);
});

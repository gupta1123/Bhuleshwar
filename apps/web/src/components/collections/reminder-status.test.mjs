import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('./useReminderStatuses.ts',import.meta.url),'utf8');
const exports={};
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:()=>({})});
const {reminderLabel,invoiceKey}=exports;
test('unscheduled versus due and future schedules have distinct actions',()=>{
 assert.equal(reminderLabel().action,'Set up reminders');
 assert.equal(reminderLabel({status:'active',next_due_at:'2026-01-01'},Date.parse('2026-02-01')).action,'Check & send');
 assert.equal(reminderLabel({status:'active',next_due_at:'2026-03-01'},Date.parse('2026-02-01')).action,'View schedule');
});
test('existing and ended schedules never offer duplicate enrollment',()=>{
 for(const status of ['paused','finished','stopped','settled','review','uncertain','sending'])assert.notEqual(reminderLabel({status}).action,'Set up reminders');
 assert.equal(reminderLabel({status:'finished'}).label,'Limit reached');
 assert.equal(reminderLabel({status:'paused'}).label,'Reminders paused');
});
test('invoice identity includes customer and date',()=>{
 assert.notEqual(invoiceKey('A','1','2026-01-01'),invoiceKey('B','1','2026-01-01'));
 assert.notEqual(invoiceKey('A','1','2026-01-01'),invoiceKey('A','1','2025-01-01'));
});

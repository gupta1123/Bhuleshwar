import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReminderPlan,advanceReminder,verificationOutcome,stageMs} from './followup-pipeline.ts';
const stage={name:'First',template:'approved',delay:0,every:2,unit:'days',limit:2};
test('missing bill requires scoped balanced proof; partial balance remains active',()=>{
 const proof={verified:true,ledgerName:'Customer',invoice:'INV-1',invoiceDate:'2026-09-07',originalAmount:100,allocatedAmount:100};
 assert.equal(verificationOutcome([],'INV-1','2026-09-07',proof,'Customer').status,'settled');
 for(const patch of [{ledgerName:'Other'},{invoice:'Other'},{invoiceDate:'2025-09-07'},{verified:false},{allocatedAmount:99}])assert.equal(verificationOutcome([],'INV-1','2026-09-07',{...proof,...patch},'Customer').status,'review');
 const partial=verificationOutcome([{referenceName:'INV-1',invoiceDate:'2026-09-07',pendingAmount:40,originalAmount:100}],'INV-1','2026-09-07',proof,'Customer');
 assert.equal(partial.status,'active');assert.match(partial.note,/Part payment/);
});
test('bounded validated stages and test time units',()=>{
 assert.equal(validateReminderPlan({name:' Plan ',stages:[stage]}).name,'Plan');
 for(const patch of [{limit:0},{limit:101},{every:0},{unit:'seconds'},{delay:-1}])assert.throws(()=>validateReminderPlan({name:'Plan',stages:[{...stage,...patch}]}));
 assert.equal(stageMs({...stage,unit:'minutes'},'every'),120000);
});
test('successful submissions advance and final stage stops',()=>{
 const stages=[stage,{...stage,name:'Final',delay:1,limit:1}];
 assert.deepEqual(advanceReminder(stages,0,0,0),{stage_index:0,stage_sent:1,status:'active',next_due_at:new Date(172800000).toISOString()});
 assert.equal(advanceReminder(stages,0,1,0).stage_index,1);
 assert.deepEqual(advanceReminder(stages,1,0,0),{stage_index:1,stage_sent:1,status:'finished',next_due_at:null});
});
test('partial payment uses current balance; ambiguous or absent evidence cannot send',()=>{
 const bill={referenceName:'INV-1',invoiceDate:'2026-09-07',pendingAmount:123.45};
 assert.equal(verificationOutcome([bill],'INV-1','2026-09-07').outstanding,123.45);
 assert.equal(verificationOutcome([{...bill,pendingAmount:0}],'INV-1','2026-09-07').status,'settled');
 for(const bills of [[],[bill,bill],[{...bill,invoiceDate:'2025-09-07'}]])assert.equal(verificationOutcome(bills,'INV-1','2026-09-07').status,'review');
 assert.throws(()=>verificationOutcome([{...bill,pendingAmount:NaN}],'INV-1','2026-09-07'));
});

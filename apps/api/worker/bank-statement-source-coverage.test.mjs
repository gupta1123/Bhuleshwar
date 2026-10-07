import test from 'node:test';
import assert from 'node:assert/strict';
import {extractBankStatementMarkdownAmounts} from './bank-statement-markdown-amounts.mjs';
import {auditSourceCoverage,recoverSourceCoverage,sourceDate} from './bank-statement-source-coverage.mjs';
import {validateRunningBalanceContinuity} from './bank-statement-running-balance.mjs';

// Minimal regression from the reported reverse-ordered statement. No account,
// credentials or complete customer document is included.
const markdown=`|Transaction Date|Description|Reference No.|Debit Amount|Credit Amount|Closing Balance|
|---|---|---|---|---|---|
|03-Sep-2026 17:26:19|Receipt A|8847||2,052,683.00|-275,292,520.09|
|03-Sep-2026 17:21:03|Payment B|1895371413|1,149,676.00||-277,345,203.09|
|03-Sep-2026 17:21:01|Payment C|TOP|1,092,091.00||-276,195,527.09|`;
const source=extractBankStatementMarkdownAmounts(markdown,{includeSourceDetails:true}).rows;
const tx=row=>({reference_number:row.reference,transaction_date:sourceDate(row.sourceDate),
  debit_amount:row.debitAmount,credit_amount:row.creditAmount,balance_amount:row.balanceAmount,
  description:row.narration,category:row.debitAmount?'payment':'receipt'});
const all=source.map(tx);
const recover=async text=>({transactions:extractBankStatementMarkdownAmounts(text,{includeSourceDetails:true}).rows.map(tx)});

test('reported missing payment is recovered alone, in source order, and balances reconcile',async()=>{
  const transactions=[all[0],all[2]];
  assert.equal(validateRunningBalanceContinuity(transactions).valid,false);
  let calls=0;
  const result=await recoverSourceCoverage({parsed:{transactions},sourceRows:source,recover:async text=>{
    calls++;assert.match(text,/1895371413/);assert.doesNotMatch(text,/Receipt A|Payment C/);return recover(text);
  }});
  assert.equal(calls,1);assert.equal(result.diagnostics.complete,true);
  assert.equal(result.diagnostics.recoveredRowCount,1);
  assert.deepEqual(result.parsed.transactions.map(r=>r.reference_number),['8847','1895371413','TOP']);
  assert.equal(validateRunningBalanceContinuity(result.parsed.transactions).valid,true);
});
test('complete extraction makes no recovery call',async()=>{
  const result=await recoverSourceCoverage({parsed:{transactions:all},sourceRows:source,recover:()=>{throw Error('Unexpected call');}});
  assert.equal(result.diagnostics.complete,true);assert.equal(result.diagnostics.recoveryCalls,0);
});
test('equal counts with a duplicate replacing a missing row do not pass',async()=>{
  const result=await recoverSourceCoverage({parsed:{transactions:[all[0],all[0],all[2]]},sourceRows:source,recover});
  assert.equal(result.diagnostics.complete,false);assert.equal(result.diagnostics.recoveryCalls,0);
});
test('same reference on different dates is checked separately',()=>{
  const rows=[source[0],{...source[0],sourceDate:'04-Sep-2026'}];
  assert.equal(auditSourceCoverage([tx(rows[0]),tx(rows[0])],rows).complete,false);
  assert.equal(auditSourceCoverage(rows.map(tx),rows).complete,true);
});
test('identical legitimate occurrences require equal multiplicity',()=>{
  assert.equal(auditSourceCoverage([all[0]],[source[0],source[0]]).complete,false);
  assert.equal(auditSourceCoverage([all[0],all[0]],[source[0],source[0]]).complete,true);
});
test('a wrong direction or amount is recovered, not accepted by reference alone',async()=>{
  const result=await recoverSourceCoverage({parsed:{transactions:[all[0],{...all[1],credit_amount:1149676,debit_amount:null},all[2]]},sourceRows:source,recover});
  assert.equal(result.diagnostics.complete,true);assert.equal(result.parsed.transactions[1].debit_amount,1149676);
});
test('wrong date, fabricated extra or missing balance cannot pass',()=>{
  for(const bad of [{...all[1],transaction_date:'2026-09-04'},{...all[1],reference_number:'fake'},{...all[1],balance_amount:null}])
    assert.equal(auditSourceCoverage([all[0],bad,all[2]],source).complete,false);
});
test('wrong narration cannot pass even when every financial cell matches',()=>{
  assert.equal(auditSourceCoverage([all[0],{...all[1],description:'Completely different party'},all[2]],source).complete,false);
});
test('failed, incomplete and excessive recovery stay blocked and retain original preview',async()=>{
  for(const callback of [async()=>{throw Error('Provider failure');},async()=>({transactions:[]}),async()=>({transactions:all})]) {
    const parsed={transactions:[all[0],all[2]]};
    const result=await recoverSourceCoverage({parsed,sourceRows:source,recover:callback});
    assert.equal(result.diagnostics.complete,false);assert.equal(result.parsed,parsed);
  }
  const result=await recoverSourceCoverage({parsed:{transactions:[]},sourceRows:source,maxRecoveryRows:2,recover});
  assert.equal(result.diagnostics.recoveryCalls,0);
});
test('invalid dates require fallback while blank references can use date and narration identity',()=>{
  assert.equal(sourceDate('31-Feb-2026'),null);
  assert.equal(auditSourceCoverage(all,[{...source[0],sourceDate:null}]).supported,false);
  assert.equal(auditSourceCoverage([{...all[0],reference_number:null}],[{...source[0],reference:''}]).supported,true);
});
test('null balance cannot stand in for zero and excess invalid duplicates are not dropped',async()=>{
  const zero={...source[0],balanceAmount:0};
  assert.equal(auditSourceCoverage([{...tx(zero),balance_amount:null}],[zero]).complete,false);
  const wrong={...all[1],debit_amount:1};
  const r=await recoverSourceCoverage({parsed:{transactions:[all[0],wrong,wrong,all[2]]},sourceRows:source,recover});
  assert.equal(r.diagnostics.complete,false);assert.equal(r.diagnostics.recoveryCalls,0);
});
test('recovery preserves unmatched ledger state; coverage never invents a ledger',async()=>{
  const result=await recoverSourceCoverage({parsed:{transactions:[all[0],all[2]]},sourceRows:source,recover});
  assert.equal(result.parsed.transactions[1].suggested_ledger_name,undefined);
  assert.equal(result.diagnostics.complete,true);
});


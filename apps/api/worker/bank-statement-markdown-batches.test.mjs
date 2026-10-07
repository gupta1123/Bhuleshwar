import test from 'node:test';
import assert from 'node:assert/strict';
import {extractMarkdownBatches} from './bank-statement-markdown-batches.mjs';
const rows=Array.from({length:194},(_,i)=>({reference:`REF${i}`,sourceDate:'2026-09-01',narration:`ROW ${i}`,debitAmount:null,creditAmount:10,balanceAmount:(i+1)*10,sourceHeader:'HEADER',sourceLine:`ROW ${i}`}));
const tx=r=>({reference_number:r.reference,transaction_date:r.sourceDate,description:r.narration,debit_amount:null,credit_amount:10,balance_amount:r.balanceAmount});
test('194 rows are bounded and merged exactly in source order',async()=>{
 let calls=0;
 const result=await extractMarkdownBatches({sourceRows:rows,extract:async markdown=>{
   calls++;const ids=[...markdown.matchAll(/ROW (\d+)/g)].map(m=>Number(m[1]));
   assert.ok(ids.length<=25);
   return {transactions:ids.map(i=>tx(rows[i]))};
 }});
 assert.equal(calls,8);assert.deepEqual(result.parsed.transactions,rows.map(tx));
});
test('incomplete batches cannot return a successful partial statement',async()=>{
 await assert.rejects(extractMarkdownBatches({sourceRows:rows,extract:async()=>({transactions:[]})}),/PDF page recovery/);
});
test('provider failure propagates to page fallback',async()=>{
 await assert.rejects(extractMarkdownBatches({sourceRows:rows,extract:async()=>{throw Error('timeout');}}),/timeout/);
});


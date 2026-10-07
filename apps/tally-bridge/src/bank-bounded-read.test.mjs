import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileBankTransactionsInTally} from './bridge.mjs';
import {cashDiscountReadContext} from './cash-discount-runtime.mjs';
const rows = ['2026-09-01','2026-09-20'].map((voucherDate,i)=>({transactionId:String(i),voucherDate,amount:100,expectedDirection:'incoming'}));
test('bank reconciliation reads the selected bank directly in one bounded request',async()=>{
 const calls=[];
 const result=await reconcileBankTransactionsInTally({tallyUrl:'http://localhost:9000'},{bankLedgerName:'Bank A',transactions:rows},{exportCollection:async(_,options)=>{calls.push(options);return '<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>';},fetchClosingBalance:async()=>0});
 assert.equal(calls.length,1);
 assert.deepEqual([calls[0].dateFrom,calls[0].dateTo],['2026-09-01','2026-09-20']);
 assert.equal(calls[0].tallyType,'Vouchers : Ledger');
 assert.match(calls[0].childOf,/Bank A/);
 assert.equal(result.result.transactions.length,2);
 assert.ok(result.result.transactions.every(r=>r.verificationStatus==='missing'));
});
test('cancelled bank check issues no further Tally requests',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(()=>cashDiscountReadContext.run({signal:controller.signal,deadlineAt:Date.now()+10000},()=>reconcileBankTransactionsInTally({tallyUrl:'http://localhost:9000'},{bankLedgerName:'Bank A',transactions:rows},{exportCollection:async()=>{calls++;controller.abort(new Error('cancelled'));return '<ENVELOPE></ENVELOPE>';},fetchClosingBalance:async()=>0})),/cancelled/);
 assert.equal(calls,1);
});

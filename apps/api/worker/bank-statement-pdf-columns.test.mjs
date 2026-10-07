import test from 'node:test';import assert from 'node:assert/strict';
import {extractBankStatementPhysicalColumns,extractPnbPhysicalColumns} from './bank-statement-pdf-columns.mjs';
import {reconcileBankStatementMarkdownAmounts} from './bank-statement-markdown-amounts.mjs';
import {buildBankVoucherXml} from '../../tally-bridge/src/bridge.mjs';
const item=(str,x,y,width=40)=>({str,width,transform:[1,0,0,1,x,y]});
const headers=[item('Txn No.',80,700),item('Txn Date',180,700),item('Description',380,700),item('Dr Amount',680,700),item('Cr Amount',780,700),item('Balance',880,700)];
const row=(ref,y,debit,credit,balance)=>[item(ref,65,y,70),item('03-09-2026',165,y,70),item(`Narration ${ref}`,350,y,180),...(debit?[item(debit,660,y,85)]:[]),...(credit?[item(credit,760,y,85)]:[]),item(balance,860,y,85)];
test('headerless continuation preserves physical columns and wrapped decimals through XML',()=>{
 const pages=[{pageNumber:1,width:1000,items:[...headers,...row('T123456',600,'20,98,696.00',null,'9,65,64,682.49Dr.')]},
 {pageNumber:2,width:1000,items:[...row('T29161971',1100,null,null,'9,44,65,986.49Dr.'),item('1,00,00,000.0',660,1108,85),item('0',737,1092,8),...row('T24969455',1020,null,'2,50,000.00','8,44,65,986.49Dr.')]}];
 const physical=extractPnbPhysicalColumns(pages);assert.equal(physical.rows.length,3);
 assert.equal(physical.rows[1].narration,'Narration T29161971');
 const parsed={transactions:[{reference_number:'T29161971',credit_amount:10000000,debit_amount:null,category:'receipt'}, {reference_number:'T24969455',credit_amount:null,debit_amount:250000,category:'payment'}]};
 const fixed=reconcileBankStatementMarkdownAmounts(parsed,'',physical);
 assert.deepEqual(fixed.transactions.map(r=>[r.debit_amount,r.credit_amount,r.category]),[[10000000,null,'payment'],[null,250000,'receipt']]);
 for(const tx of fixed.transactions){const type=tx.debit_amount?'Payment':'Receipt';const xml=buildBankVoucherXml({voucherType:type,voucherDate:'2026-09-03',bankLedgerName:'PNB',counterpartyLedgerName:'Party',amount:tx.debit_amount||tx.credit_amount},'Test');
 assert.ok(xml.includes(`<VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>`));
 const bank=xml.match(/<ALLLEDGERENTRIES.LIST><LEDGERNAME>PNB<\/LEDGERNAME>[\s\S]*?<\/ALLLEDGERENTRIES.LIST>/)?.[0];
 assert.ok(bank.includes(`<AMOUNT>${tx.debit_amount?'10000000.00':'-250000.00'}</AMOUNT>`));}
});
test('changed layout, duplicate references and ambiguous amounts fail verification',()=>{
 const first={pageNumber:1,width:1000,items:[...headers,...row('T123456',600,'100.00',null,'1000.00')]};
 assert.throws(()=>extractPnbPhysicalColumns([first,{pageNumber:2,width:900,items:[]}]),/width changed/);
 assert.throws(()=>extractPnbPhysicalColumns([first,{pageNumber:2,width:1000,items:row('T123456',600,'100.00',null,'1000.00')}]),/duplicated/);
 assert.throws(()=>extractPnbPhysicalColumns([{...first,items:[...headers,...row('T123456',600,'100.00','100.00','1000.00')]}]),/incomplete/);
 assert.equal(extractPnbPhysicalColumns([{pageNumber:1,width:1000,items:[]}]).detected,false);
});
test('PNB accepts the real S and U reference families',()=>{
 const page={pageNumber:1,width:1000,items:[...headers,...row('S3692997',600,'400.00',null,'1000.00'),...row('U89691391',520,null,'500.00','1500.00')]};
 assert.deepEqual(extractPnbPhysicalColumns([page]).rows.map(entry=>entry.reference),['S3692997','U89691391']);
});
test('Central Bank uses physical debit and credit columns even with blank cheque references',()=>{
 const centralHeaders=[item('Post Date',50,700,60),item('Value',120,700,30),item('Transaction Description',300,700,120),item('Debit',530,700,35),item('Credit',620,700,35),item('Balance',710,700,45)];
 const centralRow=(y,narration,debit,credit,balance)=>[
  item('05/09/2026',50,y,55),item('05/09/2026',120,y,55),item(narration,300,y,100),
  ...(debit?[item(debit,525,y,55)]:[]),...(credit?[item(credit,615,y,55)]:[]),item(balance,700,y,85),
 ];
 const physical=extractBankStatementPhysicalColumns([{pageNumber:1,width:842,items:[...centralHeaders,...centralRow(620,'First narration',null,'783200.00','343974486.98 DR'),...centralRow(590,'Second narration','100.00',null,'343974586.98 DR')]}]);
 assert.equal(physical.layout,'central_bank');assert.equal(physical.matchByOrder,false);
 assert.deepEqual(physical.rows.map(entry=>[entry.sourceDate,entry.narration]),[['05/09/2026','First narration'],['05/09/2026','Second narration']]);
 assert.deepEqual(physical.rows.map(entry=>[entry.debitAmount,entry.creditAmount,entry.balanceAmount]),[[null,783200,-343974486.98],[100,null,-343974586.98]]);
 const fixed=reconcileBankStatementMarkdownAmounts({transactions:[
  {reference_number:null,transaction_date:'2026-09-05',description:'First narration',debit_amount:783200,credit_amount:null,category:'payment'},
  {reference_number:null,transaction_date:'2026-09-05',description:'Second narration',debit_amount:null,credit_amount:100,category:'receipt'},
 ]},'',physical);
 assert.deepEqual(fixed.transactions.map(entry=>[entry.debit_amount,entry.credit_amount,entry.category]),[[null,783200,'receipt'],[100,null,'payment']]);
});
test('generic statement headings get deterministic physical row evidence',()=>{
 const genericHeaders=[item('Date',50,700,60),item('Particulars',260,700,100),item('Withdrawal',520,700,60),item('Deposit',620,700,50),item('Balance',710,700,45)];
 const physical=extractBankStatementPhysicalColumns([{pageNumber:1,width:842,items:[
  ...genericHeaders,item('05/09/2026',50,620,55),item('Customer receipt',260,620,120),item('1250.00',615,620,55),item('5000.00',700,620,70),
 ]}]);
 assert.equal(physical.layout,'generic_statement');
 assert.deepEqual(physical.rows.map(row=>[row.sourceDate,row.narration,row.debitAmount,row.creditAmount,row.balanceAmount]),[
  ['05/09/2026','Customer receipt',null,1250,5000],
 ]);
});


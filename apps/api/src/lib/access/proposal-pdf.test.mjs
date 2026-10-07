import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedProposalPdf} from './proposal-pdf.mjs';
const proposal={tally_voucher_id:'12',tally_open_reference_name:'DN-1',party_ledger_name:'Party A',recoverable_amount:100};
const result={voucherId:'12',voucherNumber:'1',voucherType:'Debit Note',voucherReference:'DN-1',partyLedgerName:'Party A',amount:100};
const source=Buffer.from('%PDF-1.7\nfixture').toString('base64');
test('verified native PDF retains stable evidence for identical callbacks',()=>{
 const a=verifiedProposalPdf(proposal,result,source,'2026-09-05');
 assert.deepEqual(a,verifiedProposalPdf(proposal,result,source,'2026-09-05'));
 assert.equal(a.evidence.status,'verified');assert.equal(a.evidence.sha256.length,64);
});
test('wrong voucher, customer, reference, amount and transfer hash are rejected',()=>{
 for(const patch of [{voucherId:'13'},{partyLedgerName:'Party B'},{voucherReference:'DN-2'},{amount:99},{amount:'bad'},{nativePdfSha256:'0'.repeat(64)},{voucherType:'Payment'}])
  assert.throws(()=>verifiedProposalPdf(proposal,{...result,...patch},source,'date'));
 assert.throws(()=>verifiedProposalPdf(proposal,result,'not-a-pdf','date'));
 assert.throws(()=>verifiedProposalPdf(proposal,result,'x'.repeat(7*1024*1024+1),'date'));
});

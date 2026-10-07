import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDebitNoteLedgerSides,resolveDebitNoteVoucher} from './bridge.mjs';

const payload = {partyLedgerName:'Customer',salesLedgerName:'Sales',amount:100};
const entries = () => [{ledgerName:'Customer',amount:-100,isDebit:true},{ledgerName:'Sales',amount:100,isDebit:false}];
test('verifies customer debit and sales credit',()=> {
  assert.doesNotThrow(()=>validateDebitNoteLedgerSides({ledgerEntries:entries()},payload));
});
test('identity lookup is filtered and an amount conflict is not treated as missing',async()=> {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,options)=> {
    assert.match(options.body,/KalikaDebitNoteIdentity/);
    assert.match(options.body,/\$Reference/);
    return new Response('<ENVELOPE><STATUS>1</STATUS><VOUCHER><MASTERID>123</MASTERID><VOUCHERNUMBER>7</VOUCHERNUMBER><VOUCHERTYPENAME>Debit Note</VOUCHERTYPENAME><REFERENCE>DN-123</REFERENCE><PARTYLEDGERNAME>Customer</PARTYLEDGERNAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer</LEDGERNAME><AMOUNT>-90</AMOUNT><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE></ALLLEDGERENTRIES.LIST></VOUCHER></ENVELOPE>');
  };
  try {
    await assert.rejects(resolveDebitNoteVoucher('http://localhost:9000',{...payload,referenceNumber:'DN-123',companyName:'Test'}),/amount does not match/);
  } finally {globalThis.fetch=originalFetch;}
});
test('rejects reversed sides, wrong ledger and wrong amount',()=> {
  for(const change of [e=>e[0].isDebit=false,e=>e[1].ledgerName='Other',e=>e[0].amount=-99]) {
    const ledgerEntries=entries();change(ledgerEntries);
    assert.throws(()=>validateDebitNoteLedgerSides({ledgerEntries},payload),/does not match/);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyReminderAllocationXml} from './bridge.mjs';
const voucher=(type,kind,amount,date='20260907',extra='')=>`<VOUCHER><DATE>${date}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>${extra}<ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer</LEDGERNAME><BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>${kind}</BILLTYPE><AMOUNT>${amount}</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>`;
const source=voucher('Sales','New Ref',-100);
const check=xml=>verifyReminderAllocationXml(xml,'Customer','INV-1','2026-09-07').verified;
test('exact signed allocations verify full settlement, not partial or missing bills',()=>{
 assert.equal(check(source+voucher('Receipt','Agst Ref',100)),true);
 assert.equal(check(source+voucher('Receipt','Agst Ref',40)),false);
 assert.equal(check(''),false);
 assert.equal(check(voucher('Receipt','Agst Ref',100)),false);
});
test('duplicates, cancelled receipts, wrong invoice date, refunds and adjustments fail closed',()=>{
 const paid=voucher('Receipt','Agst Ref',100);
 for(const xml of [source+source+paid,source+paid+paid,source+voucher('Receipt','Agst Ref',100,'20260907','<ISCANCELLED>Yes</ISCANCELLED>'),voucher('Sales','New Ref',-100,'20260906')+paid,source+paid+voucher('Payment','Agst Ref',-10),source+voucher('Journal','Agst Ref',100)])assert.equal(check(xml),false);
 assert.equal(verifyReminderAllocationXml(source+paid,'Other','INV-1','2026-09-07').verified,false);
});

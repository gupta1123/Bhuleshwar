import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPurchaseVoucherXml,parseVoucherCollection,purchaseVoucherReadbackComparison,readCompanyAddress,verifyPurchaseVoucherInTally} from './bridge.mjs';
const payload={companyName:'Final Steel',voucherDate:'2026-11-10',supplierInvoiceDate:'2026-11-10',supplierInvoiceNumber:'INV/1001',supplierLedgerName:'Trader Metals',finalPayableAmount:'1180',items:[{stockItemName:'Steel',purchaseLedgerName:'Steel Purchase',hsn:'72044900',quantity:'1',unit:'MT',rate:'1000',taxableAmount:'1000'}],charges:[{kind:'igst',name:'Input IGST',amount:'180'}],withholdings:[],
 ewayBill:{record:true,number:'123456789012',date:'2026-11-10',consolidatedNumber:'987654321098',consolidatedDate:'2026-11-10',fromAddress:'Factory Road, Nagpur',toAddress:'Branch Road, Chakan',fromPlace:'Nagpur',toPlace:'Chakan',fromPincode:'440001',toPincode:'410501',fromState:'Maharashtra',toState:'Maharashtra',consignorName:'Trader Metals',consignorGstin:'27AAAAA0000A1Z5',consigneeName:'Final Steel Branch',consigneeGstin:'27CCCCC0000C1Z5',transporterName:'Road Carrier',transporterId:'27DDDDD0000D1Z5',documentNumber:'LR/1',documentDate:'2026-11-09',vehicleNumber:'MH12AB1234',vehicleType:'Regular',transportMode:'1 - Road',distanceKm:'500'},
 partyDetails:{receiptNote:'RN/1',receiptNoteDate:'2026-11-10',receiptDocNo:'RD/1',carrierName:'Road Carrier',destination:'Chakan',lrNumber:'LR/1',lrDate:'2026-11-09',otherReferences:'PO/1',dispatchedThrough:'Road Carrier',motorVehicleNo:'MH12AB1234',paymentTerms:'30 days',termsOfDelivery:'To pay'},
 partyHeader:{partyCountry:'India',companyCountry:'India',placeOfSupply:'Maharashtra',partyMailingName:'Trader Metals',partyGstin:'27AAAAA0000A1Z5',partyState:'Maharashtra',companyGstin:'27CCCCC0000C1Z5',companyState:'Maharashtra',companyName:'Final Steel',partyAddress:['Factory Road','Nagpur'],companyAddress:['Office Road','Pune']},
};
const evidenceDiffs=(voucher)=>purchaseVoucherReadbackComparison(voucher,payload).filter(message=>/E-way bill|Receipt details|Party details/.test(message));

for (const country of ['India', 'Nepal', null]) {
 test(`live purchase read-back verifies the requested consignee country: ${country ?? 'missing'}`, async (t) => {
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
   reads++;
   assert.match(options.body, /<TALLYREQUEST>Export(?: Data)?<\/TALLYREQUEST>/);
   assert.doesNotMatch(options.body, /<TALLYREQUEST>Import Data<\/TALLYREQUEST>/);
   const fields = options.body.match(/<FETCH>([\s\S]*?)<\/FETCH>/i)?.[1] || '';
   let xml = buildPurchaseVoucherXml(payload, payload.companyName);
   const voucher = xml.match(/<VOUCHER(?:\s[^>]*)?>[\s\S]*?<\/VOUCHER>/i)?.[0];
   assert.ok(voucher);
   xml = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${voucher}</COLLECTION></DATA></BODY></ENVELOPE>`;
   // Tally exports ledger rows under ALLLEDGERENTRIES rather than the import tag.
   xml = xml.replace(/(<\/?)LEDGERENTRIES\.LIST\b/g, '$1ALLLEDGERENTRIES.LIST');
   // Tally also exports the purchase ledger derived from the inventory allocation.
   xml = xml.replace('</VOUCHER>', '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Steel Purchase</LEDGERNAME><AMOUNT>-1000</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>');
   xml = xml.replace(/<CONSIGNEECOUNTRYNAME>[\s\S]*?<\/CONSIGNEECOUNTRYNAME>/,
    country && /\bConsigneeCountryName\b/i.test(fields) ? `<CONSIGNEECOUNTRYNAME>${country}</CONSIGNEECOUNTRYNAME>` : '');
   return new Response(xml);
  });
  const {result} = await verifyPurchaseVoucherInTally({tallyUrl:'http://purchase-country-test:9000'}, payload);
  assert.equal(reads, 1);
  assert.equal(result.verificationStatus, country === 'India' ? 'verified' : 'mismatch');
  assert.deepEqual(result.differences, country === 'India' ? [] : ['Party details companyCountry was not preserved on the Tally voucher.']);
 });
}
test('XML parser round-trips approved e-way, receipt and party evidence',()=>{
 const xml=buildPurchaseVoucherXml(payload,payload.companyName);const [voucher]=parseVoucherCollection(xml);
 assert.deepEqual(evidenceDiffs(voucher),[]);assert.deepEqual(voucher.partyHeader.companyAddress,['Office Road','Pune']);assert.equal(voucher.ewayBill.toPlace,'Chakan');assert.equal(voucher.ewayBill.consolidatedNumber,'987654321098');assert.match(xml,/BHULESHWARCONSOLIDATEDEWAYNUMBER/);
});
for(const section of ['ewayBill','partyDetails','partyHeader']){
 for(const key of Object.keys(payload[section]).filter(key=>key!=='record')){
  test(`missing ${section}.${key} cannot pass verification`,()=>{
   const [voucher]=parseVoucherCollection(buildPurchaseVoucherXml(payload,payload.companyName));delete voucher[section][key];assert.ok(evidenceDiffs(voucher).some(message=>message.includes(key)),key);
  });
 }
}
test('company address lookup preserves lines and isolates companies and endpoints',async(t)=>{
 let reads=0;let now=Date.now();t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async()=>{reads++;return new Response('<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><COMPANY NAME="Final Steel"><NAME>Final Steel</NAME><ADDRESS.LIST><ADDRESS>Office Road</ADDRESS><ADDRESS>Pune</ADDRESS></ADDRESS.LIST><GSTREGISTRATIONNUMBER>27CCCCC0000C1Z5</GSTREGISTRATIONNUMBER><STATENAME>Maharashtra</STATENAME></COMPANY><COMPANY NAME="Other Company"><NAME>Other Company</NAME><ADDRESS.LIST><ADDRESS>Mumbai</ADDRESS></ADDRESS.LIST></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>');});
 const a=await readCompanyAddress('http://company-reader-test:9000','Final Steel');assert.deepEqual(a.address,['Office Road','Pune']);assert.equal(a.gstin,'27CCCCC0000C1Z5');
 await readCompanyAddress('http://company-reader-test:9000','Final Steel');assert.equal(reads,1);
 const b=await readCompanyAddress('http://company-reader-test:9000','Other Company');assert.deepEqual(b.address,['Mumbai']);assert.equal(reads,2);
 await readCompanyAddress('http://company-reader-test:9001','Final Steel');assert.equal(reads,3);
 now+=61000;await readCompanyAddress('http://company-reader-test:9000','Final Steel');assert.equal(reads,4);
});

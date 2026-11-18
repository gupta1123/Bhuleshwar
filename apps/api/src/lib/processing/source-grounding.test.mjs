import '../../../../../scripts/test-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {normalisePacketEvidence,groundPrintedEvidence}=await import('@autodealer/shared/lib/packet-evidence');
const {verifyProcessedDocuments}=await import('./pipeline.ts');
const schema=await import('@autodealer/shared/lib/document-schema');
const doc=(id,type,fields,visible,lineItems=[])=>({id,type,title:type,pages:1,fields,lineItems,md:'## Visible Text\n'+visible});

test('printed split GST replaces a bank-account number without changing payable',()=>{
 const d=groundPrintedEvidence(doc('i','Tax Invoice',{taxAmount:'60318229104',totalAmount:'1535444'},'CGST @ 9% 1,17,110.16 SGST @ 9% 1,17,110.16 Bank A/C No. 60318229104',[{taxableAmount:'1301224'}]));
 assert.equal(d.fields.taxAmount,'234220.32');assert.equal(d.fields.totalAmount,'1535444');assert.equal(d.fields.subtotal,'1301224');
});

test('printed EWB tax survives arithmetic disagreement and creates a real taxable finding',()=>{
 const i=doc('i','Tax Invoice',{invoiceNumber:'I1',subtotal:'1233936',taxAmount:'222108.48',totalAmount:'1456044',roundOffAmount:'-0.48'},'');
 const e=doc('e','E-Way Bill',{referenceInvoiceNumber:'I1',subtotal:'1238000',taxAmount:'222839.52',totalAmount:'1460839.52'},'Tot.Taxable Amt : 12,38,000.00 CGST Amt : 1,11,054.24 SGST Amt : 1,11,054.24 Other Amt : 0.48 Total Inv Amt : 14,60,839.52');
 assert.equal(groundPrintedEvidence(e).fields.taxAmount,'222108.48');
 const r=verifyProcessedDocuments([i,e],{considerFormatting:false});
 assert.ok(r.mismatches.some(m=>m.field==='subtotal'));assert.ok(r.mismatches.some(m=>m.values.some(v=>String(v.value).includes('Printed total'))));
 assert.ok(!r.mismatches.some(m=>m.field==='taxAmount'));
});

test('interleaved tax-table labels never capture taxable value as IGST',()=>{
 const d=groundPrintedEvidence(doc('e','E-Way Bill',{subtotal:'886500',taxAmount:'159570'},'Tot. Taxable Amt\nIGST Amt\n8,86,500.00\nOther Amt\n: 0.00\nTotal Inv Amt: 10,46,070.00\n: 1,59,570.00'));
 assert.equal(d.fields.taxAmount,'159570');
 const partial=groundPrintedEvidence(doc('i','Tax Invoice',{taxAmount:'180'},'CGST @ 9% 90 SGST Rate unreadable'));
 assert.equal(partial.fields.taxAmount,'180');
});

test('LR units and labelled receipt reference are restored without numeric guesses',()=>{
 const [d]=normalisePacketEvidence([doc('l','Lorry Receipt',{netWeight:'31.220',lorryReceiptNumber:'MH36AA5509',vehicleNumber:'MH36AA5509'},'Letter No.\n1307\nLORRY NO.\nMH36AA5509\nWeight Rate Amount\n31.220\nFreight\nTO PAY\nM.T')]);
 assert.equal(d.fields.netWeight,'31.220 MT');assert.equal(d.fields.lorryReceiptNumber,'1307');
 assert.equal(groundPrintedEvidence(doc('u','Lorry Receipt',{netWeight:'31.220'},'Weight unclear')).fields.netWeight,'31.220');
});

test('source PDF identifier takes precedence over an image retry transcription',()=>{
 const d=groundPrintedEvidence(doc('l','Lorry Receipt',{vehicleNumber:'MH20GCG612'},'LORRY NO.\nMH20GC6612\n## Image transcription\nLORRY NO. MH20GCG612'));
 assert.equal(d.fields.vehicleNumber,'MH20GC6612');
});

test('explicit receiving supplier and receiver repair reversed AI roles',()=>{
 const [d]=normalisePacketEvidence([doc('r','Receiving Record',{vendorName:'Bhuleshwar Steel & Alloys Pvt Ltd (Trishul)',buyerName:'Jagdamba'},'Bhuleshwar Steel & Alloys\nPvt Ltd (Trishul)\nTransaction ID: 20311\nCompany Name:\nJAGDAMBA ALLOYS & STEEL\nInvoice No: 7709\nNet Weight: 35.75')]);
 assert.equal(d.fields.vendorName,'JAGDAMBA ALLOYS & STEEL');assert.match(d.fields.buyerName,/Bhuleshwar.*Trishul/);
});

test('known upstream logistics party does not conflict with the invoicing trader',()=>{
 const seller=doc('s','Tax Invoice',{invoiceNumber:'TR/1',vendorName:'Trader',supplierGstin:'27AAAAA0000A1Z5',buyerName:'Final',buyerGstin:'27CCCCC0000C1Z5'},'');
 const maker=doc('m','Tax Invoice',{invoiceNumber:'MK/1',vendorName:'Maker',supplierGstin:'23BBBBB0000B1Z5',buyerName:'Trader',buyerGstin:'27AAAAA0000A1Z5'},'');
 const lr=doc('l','Lorry Receipt',{vendorName:'Maker',supplierGstin:'23BBBBB0000B1Z5',buyerName:'Final',buyerGstin:'27CCCCC0000C1Z5'},'');
 const r=verifyProcessedDocuments([seller,maker,lr],{considerFormatting:false});
 assert.ok(!r.mismatches.some(m=>['vendorName','supplierGstin'].includes(m.field)));
});

test('document date and EWB expiry remain visible in their document context',()=>{
 assert.ok(schema.getFieldDefinitionsForDocType('Tax Invoice').some(f=>f.key==='documentDate'));
 assert.ok(schema.getFieldDefinitionsForDocType('E-Way Bill').some(f=>f.key==='validityDate'));
});

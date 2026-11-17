import '../../../../../scripts/test-typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {normalisePacketEvidence,shipmentMassChecks,evidenceTimestamp,arithmeticChecks,hasRelevantPacketTerms}=await import('@autodealer/shared/lib/packet-evidence');
const {verifyCaseDocuments,verifyGroupedCaseDocuments,getSellerChainRoleSelection}=await import('../../services/verification.ts');
const {enrichProcessedDocuments,applyExtractionReviewCorrections,mapFields,verifyProcessedDocuments}=await import('./pipeline.ts');
const {mergeOverlappingPageGroups}=await import('./image-request-budget.ts');
const options={considerFormatting:false};
const doc=(id,type,fields={},extra={})=>({id,type,title:type,fields,lineItems:[],md:'',sourceFileName:'packet.pdf',sourceHint:`page ${id}`,pages:1,...extra});
const invoice=()=>doc('i','Tax Invoice',{invoiceNumber:'INV/1001',vendorName:'Trader Metals',buyerName:'Final Steel',vehicleNumber:'MH12AB1234',itemQuantity:'30',unit:'MT'});

test('receiving evidence restores roles, reference, weight and timed arrival',()=>{
 const [d]=normalisePacketEvidence([doc('r','Invoice',{invoiceNumber:'1001'},{md:'## Visible Text\nBHULESHWAR STEEL\nTRISHUL\nTransaction ID: G-1\nCompany Name: Trader Metals\nInvoice No: 1001\nRegistration Number: MH12AB1234\nVehicle Entry Date: 2026-11-10 14:00:00\nNet Weight: 30.14'})]);
 assert.equal(d.type,'Receiving Record');assert.equal(d.fields.invoiceNumber,undefined);assert.equal(d.fields.referenceInvoiceNumber,'1001');assert.equal(d.fields.netWeight,'30.14 MT');assert.equal(d.fields.arrivalDate,'2026-11-10 14:00:00');
});
test('mass compares invoice quantities to receipt weights across units',()=>{
 const r=shipmentMassChecks([invoice(),doc('r','Weighment Slip',{netWeight:'31000 kg'})]);assert.equal(r.checks[0].status,'failed');assert.equal(r.mismatches[0].field,'netWeight');assert.match(r.checks[0].detail,/1000.00 kg/);
});

test('flattened Trishul evidence keeps reviewed values and restores their tonne convention',()=>{
 const receipt=doc('r','Receiving Record',{grossWeight:'43.24',tareWeight:'13.68',netWeight:'29.56'},{md:'## Visible Text\nBhuleshwar Steel & Alloys Pvt Ltd (Trishul) Transaction ID: 20241 Vehicle Entry Date: 2026-11-04 08:42:17 Gross Weight: 43.24 Tare Weight: 13.68 Net Weight: 29.56'});
 const [r]=normalisePacketEvidence([receipt]);
 assert.equal(r.fields.netWeight,'29.56 MT');assert.equal(r.fields.grossWeight,'43.24 MT');assert.equal(r.fields.tareWeight,'13.68 MT');
 assert.equal(shipmentMassChecks([invoice(),{...r,fields:{...r.fields,netWeight:'30.14 MT'}}]).checks[0].status,'passed');
 assert.equal(normalisePacketEvidence([{...receipt,fields:{netWeight:'30.14'}}])[0].fields.netWeight,'30.14 MT');
 assert.equal(normalisePacketEvidence([{...receipt,fields:{netWeight:'29560 kg'}}])[0].fields.netWeight,'29560 kg');
 assert.equal(normalisePacketEvidence([{...receipt,md:'## Visible Text\nReceiving Record Transaction ID: G1 Net Weight: 29.56'}])[0].fields.netWeight,'29.56');
});
test('small 140 kg variance stays within the established tolerance',()=>{
 const r=shipmentMassChecks([invoice(),doc('r','Receiving Record',{netWeight:'30.14 MT'})]);assert.equal(r.mismatches.length,0);assert.match(r.checks[0].detail,/tolerance 150.00 kg/);
});

test('weight mismatch copy includes the divergent third observation',()=>{
 const r=verifyProcessedDocuments([doc('l','Lorry Receipt',{netWeight:'29.54 MT'}),doc('w','Weighment Slip',{netWeight:'29540 kg'}),doc('r','Receiving Record',{netWeight:'31 MT'})],options);
 assert.match(r.mismatches.find(m=>m.field==='netWeight').analysis,/Difference: 1460 kg/);
});
test('missing units never produce a passed mass check',()=>assert.equal(shipmentMassChecks([invoice(),doc('r','Weighment Slip',{netWeight:'31000'})]).checks[0].status,'not_checked'));
test('only explicitly identified partial receipts are summed once',()=>{
 const receipts=[doc('a','Receiving Record',{netWeight:'10 MT',receiptStatus:'Partial receipt',receiptNumber:'R1'}),doc('b','Receiving Record',{netWeight:'20 MT',receiptStatus:'Partial receipt',receiptNumber:'R2'})];
 const r=shipmentMassChecks([invoice(),...receipts]);assert.equal(r.checks.length,1);assert.equal(r.checks[0].status,'passed');assert.deepEqual(r.checks[0].documentIds,['i','a','b']);
});
test('receiving review corrections take precedence over legacy recovery',()=>{
 const d=doc('r','Receiving Record',{netWeight:'30.14 MT'},{md:'## Visible Text\nTRISHUL\nTransaction ID: G1\nNet Weight: 30.00'});assert.equal(enrichProcessedDocuments([d])[0].fields.netWeight,'30.14 MT');
});
test('same-day expiry retains time and IST semantics',()=>{
 const docs=[invoice(),doc('e','E-Way Bill',{invoiceNumber:'INV/1001',validityDate:'10-Nov-26 11:00 AM'}),doc('r','Receiving Record',{referenceInvoiceNumber:'INV/1001',vehicleNumber:'MH12AB1234',arrivalDate:'2026-11-10 14:00:00'})];
 const result=verifyGroupedCaseDocuments(docs,options);assert.ok(result.mismatches.some(m=>m.field==='validityDate'));assert.equal(result.checks.find(c=>c.label==='E-way validity at arrival').status,'failed');
 assert.equal(evidenceTimestamp('2026-11-10 14:00:00'),Date.parse('2026-11-10T08:30:00Z'));
});
test('unclear expiry is explicitly not checked',()=>{
 const result=verifyGroupedCaseDocuments([invoice(),doc('e','E-Way Bill',{invoiceNumber:'INV/1001',validityDate:'unclear'})],options);assert.equal(result.checks.find(c=>c.label==='E-way validity at arrival').status,'not_checked');
 assert.equal(evidenceTimestamp('31/02/2026'),null);
});
test('date fields survive mapping and review quarantine cannot delete a replacement',()=>{
 assert.deepEqual(mapFields({documentDate:'2026-11-09',validityDate:'2026-11-14'},'E-Way Bill'),{documentDate:'2026-11-09',validityDate:'2026-11-14'});
 const d=doc('i','Tax Invoice',{invoiceNumber:'NFA/26-27/1893',referencePoNumber:'PO/1893',buyerGstin:'27AAACB2203M1ZZ'},{md:'## Visible Text\nInvoice No: NFA/26-27/1893\nOrder No: PO/1893'});
 const reviewed=applyExtractionReviewCorrections([d],{corrections:[{docId:'i',fields:{taxAmount:'123'},quarantineFields:[{field:'taxAmount',reason:'Old value wrong'}]}]}).documents;
 const enriched=enrichProcessedDocuments(reviewed);assert.equal(enriched[0].fields.taxAmount,'123');assert.equal(enriched[0].fields.referencePoNumber,'PO/1893');assert.equal(enriched[0].fields.buyerGstin,'27AAACB2203M1ZZ');assert.deepEqual(enrichProcessedDocuments(enriched).map(d=>d.fields),enriched.map(d=>d.fields));
});
test('majority GSTIN cannot replace a dissenting printed identity',()=>{
 const docs=[doc('i','Tax Invoice',{invoiceNumber:'INV/1001',supplierGstin:'23AAECN4025J1ZP'}),doc('e','E-Way Bill',{invoiceNumber:'INV/1001',supplierGstin:'23AAECN4025J1Z7'}),doc('l','Lorry Receipt',{referenceInvoiceNumber:'INV/1001',supplierGstin:'23AAECN4025J1Z7'})];
 const enriched=enrichProcessedDocuments(docs);assert.equal(enriched[0].fields.supplierGstin,'23AAECN4025J1ZP');assert.ok(verifyCaseDocuments(enriched,options).some(m=>m.field==='supplierGstin'));
});
test('overlapping physical page merges despite party OCR variation; different numbers survive',()=>{
 const g={documentType:'Weighment Slip',pageStart:4,pageEnd:4,documentNumber:'W1',primaryPartyName:'ABC LTD'};
 assert.equal(mergeOverlappingPageGroups([g,{...g,primaryPartyName:'ABC'}]).length,1);assert.equal(mergeOverlappingPageGroups([g,{...g,documentNumber:'W2'}]).length,2);
 const a=doc('a','Weighment Slip',{weighmentNumber:'W1'},{sourceHint:'page 4'});assert.equal(normalisePacketEvidence([a,{...a,id:'b',fields:{...a.fields,vendorName:'ABC'}}]).length,1);
});
test('a receipt cannot choose between unrelated shipments on the same truck',()=>{
 const docs=[invoice(),doc('j','Tax Invoice',{invoiceNumber:'INV/2002',vendorName:'Different supplier',vehicleNumber:'MH12AB1234'}),doc('r','Weighment Slip',{vehicleNumber:'MH12AB1234',netWeight:'30 MT'})];
 const r=verifyGroupedCaseDocuments(docs,options);assert.equal(getSellerChainRoleSelection(docs,options),null);assert.ok(r.groups.length>=2);assert.ok(r.checks.some(c=>c.label==='Shipment weight'&&c.status==='not_checked'));
});
test('correct legal trader chain works with and without a PO',()=>{
 const seller=doc('s','Tax Invoice',{invoiceNumber:'TR/1',vendorName:'Trader Metals',buyerName:'Final Steel',supplierGstin:'27AAAAA0000A1Z5',buyerGstin:'27CCCCC0000C1Z5',totalAmount:'1180'});
 const maker=doc('m','Tax Invoice',{invoiceNumber:'MK/1',vendorName:'Maker Foundry',buyerName:'Trader Metals',supplierGstin:'23BBBBB0000B1Z5',buyerGstin:'27AAAAA0000A1Z5',shipToName:'Final Steel',totalAmount:'1000'});
 for(const docs of [[seller,maker],[doc('p','Purchase Order',{poNumber:'PO/1',vendorName:'Trader Metals',buyerName:'Final Steel',supplierGstin:'27AAAAA0000A1Z5',buyerGstin:'27CCCCC0000C1Z5'}),seller,maker]]){
  const r=getSellerChainRoleSelection(docs,options);assert.deepEqual(r.primaryDocumentIds,['s']);assert.ok(r.contextDocumentIds.includes('m'));
 }
});
test('one invoice still receives intra-document arithmetic validation',()=>{
 const i=doc('i','Tax Invoice',{subtotal:'1000',taxAmount:'180',totalAmount:'1200'});assert.equal(verifyGroupedCaseDocuments([i],options).mismatches[0].field,'totalAmount');assert.equal(arithmeticChecks([doc('i','Tax Invoice',{subtotal:'1000',taxAmount:'180',tcsAmount:'20',totalAmount:'1200'})]).length,0);
});
test('generic legal terms skip remote assessment eligibility',()=>{assert.equal(hasRelevantPacketTerms('Subject to local jurisdiction. Interest on overdue payments.'),false);assert.equal(hasRelevantPacketTerms('Inspection certificate must provide at delivery'),true);});
test('coverage never claims a single scalar observation was cross-checked',()=>{
 const r=verifyGroupedCaseDocuments([invoice()],options);assert.equal(r.checks.find(c=>c.key.endsWith(':field:supplierGstin'))?.status,undefined);assert.equal(r.checks.find(c=>c.key.endsWith(':field:invoiceNumber')).status,'not_checked');
});
test('multi-column EWB generated and valid-until dates retain their own meaning',()=>{
 const [d]=enrichProcessedDocuments([doc('e','E-Way Bill',{validityDate:'9-Nov-26 05:37 PM'},{md:'## Visible Text\nGenerated Date:\nApprox Distance: 880 KM Valid Upto\nTransaction Type: Regular\nTo\n9-Nov-26 05:37 PM\n: 14-Nov-26 11:59 PM\n2. Address Details'})]);
 assert.match(d.fields.validityDate,/14-Nov-26/);
});

import type { CaseDoc, FieldKey, Mismatch } from '../types/pipeline';

/** Only the source transcription is evidence; generated markdown field summaries are not. */
export function visibleEvidence(doc: Pick<CaseDoc, 'md'>) {
  const raw = doc.md || '';
  const marker = raw.indexOf('## Visible Text');
  return marker < 0 ? raw : raw.slice(marker + '## Visible Text'.length);
}

export function isReceivingEvidence(text: string) {
  return /\b(?:trishul|gate\s+(?:entry|record)|receiving\s+record)\b/i.test(text) &&
    /\bnet\s*weight\b/i.test(text) && /\b(?:transaction\s*id|vehicle\s*entry|gate\s*entry)\b/i.test(text);
}

function labelled(text: string, label: string) {
  return text.match(new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*:?\\s*([^\\n]+)`, 'i'))?.[1]?.trim();
}

export function restoreReceivingEvidence(doc: CaseDoc): CaseDoc {
  const text = visibleEvidence(doc);
  if (!isReceivingEvidence(text)) return doc;
  const fields: CaseDoc['fields'] = { ...doc.fields };
  // Old records were classified as invoices. Their suffix is a reference, never a second invoice.
  delete fields.invoiceNumber;
  delete fields.referencePoNumber;
  delete fields.deliveryNoteNumber;
  const repairingLegacy = doc.type !== 'Receiving Record';
  const put = (key: FieldKey, value?: string) => { if (value && (repairingLegacy || !fields[key])) fields[key] = value; };
  put('referenceInvoiceNumber', labelled(text, 'Invoice\\s*No(?:\\.)?'));
  put('transactionReference', labelled(text, 'Transaction\\s*ID'));
  put('vendorName', labelled(text, 'Company\\s*Name|Supplier\\s*Name'));
  const receiver = text.match(/(Bhuleshwar[\s\S]{0,100}?\(Trishul\))/i)?.[1] || text.match(/^\s*([^\n]*Bhuleshwar[^\n]{0,100})/im)?.[1];
  if (receiver) put('buyerName', receiver.replace(/\s+/g, ' ').trim());
  const company = labelled(text, 'Company\\s*Name|Supplier\\s*Name') || text.match(/Company\s*Name\s*:\s*(.+?)\s+Invoice\s*No/i)?.[1];
  if (receiver && company && /bhuleshwar/i.test(fields.vendorName || '') && !/bhuleshwar/i.test(company)) {
    fields.vendorName = company;
    fields.buyerName = receiver.replace(/\s+/g, ' ').trim();
  }
  put('vehicleNumber', labelled(text, 'Registration\\s*Number|Vehicle\\s*(?:No|Number)'));
  put('arrivalDate', labelled(text, 'Vehicle\\s*Entry\\s*Date|Gate\\s*Entry(?:\\s*Date)?'));
  put('departureDate', labelled(text, 'Vehicle\\s*Out\\s*Image|Vehicle\\s*Exit\\s*Date'));
  put('driverName', labelled(text, 'Drivers?\\s*Name'));
  put('driverPhone', labelled(text, 'Driver\\s*Phone'));
  // Trishul's exported gross/tare/net columns are metric tonnes. Other layouts must state a unit.
  const trishul = /\btrishul\b/i.test(text);
  for (const [key, label] of [['grossWeight','Gross'],['tareWeight','Tare'],['netWeight','Net']] as const) {
    // Review may retain a corrected number while removing the separate unit.
    // Preserve that number and apply the recognized export's unit convention,
    // including when OCR flattened the source labels onto one line.
    const current = fields[key];
    if (trishul && current && /^\d[\d,.]*$/.test(String(current).trim())) {
      fields[key] = `${String(current).trim()} MT`;
    }
    const value = labelled(text, `${label}\\s*Weight`);
    if (value && /^\d[\d,.]*(?:\s*(?:kg|mt|t|tonnes?))?$/i.test(value)) {
      put(key, trishul && !/[a-z]/i.test(value) ? `${value} MT` : value);
    }
  }
  return { ...doc, type: 'Receiving Record', title: doc.title.replace(/^(?:Tax Invoice|Invoice|Delivery Note)/, 'Receiving Record'), fields };
}

export function deduplicatePhysicalDocuments(documents: CaseDoc[]) {
  const seen = new Set<string>();
  return documents.filter(doc => {
    const page = doc.sourceHint?.match(/\bpages?\s+(\d+)(?:\s*[-–]\s*(\d+))?/i)?.[0];
    if (!page || !doc.sourceFileName) return true;
    const number = doc.fields.weighmentNumber || doc.fields.transactionReference ||
      doc.fields.invoiceNumber || doc.fields.eWayBillNumber || doc.fields.lorryReceiptNumber || '';
    // A same-page pair with different document numbers/regions remains separate evidence.
    const key = [doc.sourceFileName, page, doc.type, number].join('|').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalisePacketEvidence(documents: CaseDoc[]) {
  return deduplicatePhysicalDocuments(documents.map(restoreReceivingEvidence).map(groundPrintedEvidence));
}

/** Restore explicit source labels, never a majority vote or a recomputed GST value. */
export function groundPrintedEvidence(doc: CaseDoc): CaseDoc {
  const text = visibleEvidence(doc);
  const fields = {...doc.fields};
  const amount = '(\\d[\\d,]*(?:\\.\\d{1,2})?)';
  if (['Invoice','Tax Invoice','E-Way Bill'].includes(doc.type)) {
    const taxes = new Map<string,number>();
    for (const component of ['CGST','SGST','IGST']) {
      const pattern = new RegExp(`\\b${component}\\s*(?:(?:Amt|Amount)[ \\t]*:[ \\t]*(?:\\r?\\n[ \\t]*)?|@\\s*\\d+(?:\\.\\d+)?\\s*%\\s*)${amount}`, 'ig');
      const values = [...text.matchAll(pattern)].map(match=>Number(match[1].replace(/,/g,'')));
      const distinct = [...new Set(values)];
      if (distinct.length === 1) taxes.set(component,distinct[0]);
    }
    const splitTax = /\bCGST\b/i.test(text) && /\bSGST\b/i.test(text);
    if (taxes.size && (!splitTax || (taxes.has('CGST') && taxes.has('SGST'))) && !/\bcess\b/i.test(text)) fields.taxAmount = String(Math.round([...taxes.values()].reduce((n,v)=>n+v,0)*100)/100);
    const taxable = text.match(new RegExp(`Tot\\.?\\s*Tax(?:able|'ble)\\s*Amt[ \\t]*:[ \\t]*${amount}`, 'i'));
    if (taxable) fields.subtotal = fields.totalTaxableAmount = taxable[1].replace(/,/g,'');
    if (!fields.subtotal && ['Invoice','Tax Invoice'].includes(doc.type) && doc.lineItems?.length && doc.lineItems.every(line=>line.taxableAmount && /^-?[\d,.]+$/.test(line.taxableAmount))) {
      fields.subtotal = String(Math.round(doc.lineItems.reduce((n,line)=>n+Number(line.taxableAmount!.replace(/,/g,'')),0)*100)/100);
    }
    if (doc.type === 'E-Way Bill') {
      const other = text.match(new RegExp(`Other\\s*Amt\\s*:?\\s*${amount}`, 'i'));
      if (other) fields.roundOffAmount = other[1].replace(/,/g,'');
    }
    const po = text.match(/\b(PO[\/-][A-Z0-9\/-]+)\s+Dt\.?\s*\d{1,2}[-/]/i)?.[1];
    if (po && fields.referencePoNumber?.replace(/[^A-Z0-9]/gi,'').toUpperCase().startsWith(po.replace(/[^A-Z0-9]/gi,'').toUpperCase()+'DT')) fields.referencePoNumber = po;
  }
  if (['Lorry Receipt','Weighment Slip','Receiving Record'].includes(doc.type)) {
    const units = new Set<string>();
    if (/\b(?:M\.?T\.?S?\.?|metric\s*tonnes?|tonnes?|tons?)\b/i.test(text)) units.add('MT');
    if (/\b(?:kg|kgs|kilograms?)\b/i.test(text)) units.add('kg');
    const explicitUnit = fields.unit || fields.receivedUnit || (units.size === 1 ? [...units][0] : undefined);
    for (const key of ['grossWeight','tareWeight','netWeight'] as const) {
      if (fields[key] && /^\d[\d,.]*$/.test(fields[key]!.trim()) && massInKg('1',explicitUnit) !== null) fields[key] += ` ${explicitUnit}`;
    }
  }
  if (doc.type === 'Lorry Receipt') {
    const receipt = text.match(/\bLetter\s*No\.?\s*:?\s*([A-Z0-9\/-]+)/i)?.[1];
    if (receipt && (!fields.lorryReceiptNumber || fields.lorryReceiptNumber === fields.vehicleNumber)) fields.lorryReceiptNumber = receipt;
    const vehicle = text.match(/\bLORRY\s*NO\.?\s*:?\s*([A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4})\b/i)?.[1];
    if (vehicle) fields.vehicleNumber = vehicle.toUpperCase();
  }
  const reason = 'Restored from explicit source labels, printed weight units, or taxable line amounts.';
  const qualityIssues = [...(doc.qualityIssues || [])];
  for (const [key,value] of Object.entries(fields)) {
    const field = key as FieldKey;
    if (value !== doc.fields[field] && !qualityIssues.some(issue=>issue.field===field && issue.reason===reason && issue.originalValue===String(doc.fields[field] || '<missing>'))) qualityIssues.push({field,action:'corrected',originalValue:String(doc.fields[field] || '<missing>'),reason});
  }
  const lineItems = doc.lineItems?.map(line=>/^\s*\d*[.)]?\s*goods\s+details\s*$/i.test(line.itemCode || '') ? {...line,itemCode:undefined} : line);
  return {...doc,fields,lineItems,qualityIssues};
}

export function massInKg(value?: string | number | null, unit?: string) {
  if (value == null || String(value).trim() === '') return null;
  const raw = String(value).replace(/,/g, '');
  const number = Number(raw.match(/-?\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(number)) return null;
  const measure = `${unit || ''} ${raw}`.toLowerCase();
  if (/\b(?:mt|mts|m\.t\.?|tonnes?|tons?|t)\b/.test(measure)) return number * 1000;
  if (/\b(?:kg|kgs|kilograms?)\b/.test(measure)) return number;
  return null;
}

export function isInternalBuyer(value?: string) {
  return /\bbhuleshwar\b/i.test(value || '');
}

export function hasRelevantPacketTerms(text: string) {
  // Generic jurisdiction/interest/return boilerplate is not a packet-verifiable obligation.
  return /\b(?:payment\s+terms?|delivery\s+terms?|freight\s+(?:terms?|paid|to\s*pay)|inspection|test\s+certificate|weighment|shortage|packing|warranty\s+certificate|must\s+(?:provide|attach)|required\s+documents?)\b/i.test(text);
}

export type EvidenceCheck = {
  key: string;
  label: string;
  status: 'passed' | 'failed' | 'not_checked' | 'not_applicable';
  detail: string;
  documentIds: string[];
};

export function shipmentMassChecks(documents: CaseDoc[]) {
  const invoices = documents.filter(d => ['Invoice','Tax Invoice'].includes(d.type));
  const references = new Set(invoices.map(d => d.fields.invoiceNumber).filter(Boolean));
  const invoice = references.size <= 1 ? invoices.find(d => d.lineItems?.length || d.fields.itemQuantity) : undefined;
  let expected = invoice ? massInKg(invoice.fields.itemQuantity, invoice.fields.unit) : null;
  if (expected == null && invoice?.lineItems?.length) {
    const lines = invoice.lineItems.filter(l => !/freight|packing|handling|insurance/i.test(l.description || ''));
    const quantities = lines.map(l => massInKg(l.quantity,l.unit));
    if (quantities.length && quantities.every(q => q != null)) expected = quantities.reduce<number>((n,q)=>n+(q || 0),0);
  }
  const receipts = documents.filter(d => ['Receiving Record','Weighment Slip','Lorry Receipt'].includes(d.type));
  const checks: EvidenceCheck[] = [];
  const mismatches: Omit<Mismatch,'analysis'|'fixPlan'>[] = [];
  const visited = new Set<string>();
  for (const receipt of receipts) {
    if (visited.has(receipt.id)) continue;
    const partial = (doc: CaseDoc) => /\b(?:partial|split|part receipt)\b/i.test(doc.fields.receiptStatus || '');
    const sameRole = receipts.filter(doc=>doc.type===receipt.type);
    const references = sameRole.map(doc=>doc.fields.receiptNumber || doc.fields.transactionReference || doc.fields.weighmentNumber);
    const split = sameRole.length>1 && sameRole.every(partial) && references.every(Boolean) && new Set(references).size===sameRole.length;
    const participants = split ? sameRole : [receipt];
    participants.forEach(doc=>visited.add(doc.id));
    const weights = participants.map(doc=>massInKg(doc.fields.netWeight,doc.fields.unit));
    const actual = weights.every(weight=>weight!==null) ? weights.reduce<number>((sum,weight)=>sum+(weight || 0),0) : null;
    const ids = [invoice?.id,...participants.map(doc=>doc.id)].filter((id):id is string=>Boolean(id));
    if (expected == null || actual == null) {
      checks.push({key:`mass:${receipt.id}`,label:'Shipment weight',status:'not_checked',detail:'Invoice quantity or receipt weight/unit is missing or ambiguous.',documentIds:ids});
      continue;
    }
    const difference = actual-expected;
    const tolerance = Math.max(5,expected*0.005);
    const failed = Math.abs(difference)>tolerance;
    const detail=`Received ${actual.toFixed(2)} kg; invoiced ${expected.toFixed(2)} kg; difference ${difference.toFixed(2)} kg; tolerance ${tolerance.toFixed(2)} kg.`;
    checks.push({key:`mass:${receipt.id}`,label:'Shipment weight',status:failed?'failed':'passed',detail,documentIds:ids});
    if (failed) mismatches.push({id:`mass-${invoice!.id}-${receipt.id}`,field:'netWeight',values:[{docId:invoice!.id,value:`Invoice: ${expected} kg`},{docId:receipt.id,value:`Received: ${actual} kg; difference ${difference} kg; tolerance ${tolerance} kg`}]});
  }
  if (!receipts.length) checks.push({key:'mass',label:'Shipment weight',status:'not_checked',detail:'No receiving/weighment evidence is available.',documentIds:invoice?[invoice.id]:[]});
  return {checks,mismatches};
}

export function arithmeticChecks(documents: CaseDoc[]) {
  return documents.flatMap(doc=>{
    if (!['Invoice','Tax Invoice','E-Way Bill'].includes(doc.type)) return [];
    const parse=(v?:string)=>v?.trim() && /^-?[\d,.]+$/.test(v.trim()) ? Number(v.replace(/,/g,'')) : null;
    const base=parse(doc.fields.subtotal || doc.fields.totalTaxableAmount), tax=parse(doc.fields.taxAmount), total=parse(doc.fields.totalAmount);
    if (base==null || tax==null || total==null) return [];
    const round=parse(doc.fields.roundOffAmount)||0;
    const tcs=parse(doc.fields.tcsAmount)||0;
    // A separately printed discount/freight can already be included in taxable value.
    // Without an explicit reconciliation basis we cannot assert an arithmetic error.
    if (parse(doc.fields.discountAmount) || parse(doc.fields.freightAmount) || /\b(?:TDS|cess|retention|deduction)\b/i.test(visibleEvidence(doc))) return [];
    const delta=base+tax+round+tcs-total;
    if (Math.abs(delta)<=1) return [];
    return [{id:`arithmetic-${doc.id}`,field:'totalAmount' as FieldKey,values:[{docId:doc.id,value:`Printed total ${total}; taxable ${base} + tax ${tax} + round-off ${round} + TCS ${tcs} = ${(base+tax+round+tcs).toFixed(2)} (difference ${delta.toFixed(2)}).`}]}];
  });
}

/** Dates from Indian procurement documents are local IST unless explicitly offset. */
export function evidenceTimestamp(value: unknown, endOfDay=false): number | null {
  const raw=String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const n=Date.parse(raw); return Number.isFinite(n)?n:null;
  }
  const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const iso=raw.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/);
  const named=raw.match(/\b(\d{1,2})[- /]([A-Za-z]{3,9})[- /](\d{2,4})\b/);
  const numeric=raw.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  let year=iso?Number(iso[1]):Number(named?.[3] || numeric?.[3]);
  if(year<100)year+=2000;
  const month=iso?Number(iso[2]):named?months.indexOf(named[2].slice(0,3).toLowerCase())+1:Number(numeric?.[2]);
  const day=Number(iso?.[3] || named?.[1] || numeric?.[1]);
  const clock=raw.match(/(?:T|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  let hour=clock?Number(clock[1]):endOfDay?23:0;
  if(clock?.[4])hour=hour%12+(/pm/i.test(clock[4])?12:0);
  const minute=clock?Number(clock[2]):endOfDay?59:0,second=clock?Number(clock[3]||0):endOfDay?59:0;
  const date=new Date(Date.UTC(year,month-1,day,hour,minute,second));
  if(!Number.isFinite(date.getTime()) || month<1 || month>12 || day<1 || hour>23 || minute>59 || second>59 || date.getUTCDate()!==day || date.getUTCMonth()!==month-1)return null;
  return date.getTime()-330*60000;
}

// Source coverage is independent of AI ledger suggestions. Never infer a missing
// transaction from a balance delta: recovery receives only actual source rows.
const ref = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const narration = value => String(value ?? '')
  .toUpperCase()
  .replace(/&(?:AMP;)?/g, ' AND ')
  .replace(/[^A-Z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const money = value => value == null || Number(value) === 0 ? 0
  : Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : null;
export function sourceDate(value) {
  const text = String(value ?? '').trim();
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s|$)/);
  let year, month, day;
  if (m) [,year,month,day] = m;
  else {
    m = text.match(/^(\d{1,2})[-/ ]([A-Za-z]{3}|\d{1,2})[-/ ](\d{4})(?:\s|$)/);
    if (!m) return null;
    day=m[1]; year=m[3]; month=/^\d+$/.test(m[2]) ? Number(m[2])
      : ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase())+1;
  }
  const date = new Date(Date.UTC(Number(year),Number(month)-1,Number(day)));
  if (date.getUTCFullYear()!==Number(year)||date.getUTCMonth()+1!==Number(month)||date.getUTCDate()!==Number(day)) return null;
  return date.toISOString().slice(0,10);
}
const identity = (reference,date,description) => JSON.stringify([
  ref(reference),sourceDate(date),narration(description)
]);
const sourceIdentity = row => identity(row.reference,row.sourceDate,row.narration);
const transactionIdentity = row => identity(row.reference_number,row.transaction_date,row.description);
const signature = (id,description,debit,credit,balance) => JSON.stringify([
  id,narration(description),money(debit),money(credit),balance == null ? null : money(balance)
]);
const sourceSignature = row => signature(sourceIdentity(row),row.narration,row.debitAmount,row.creditAmount,row.balanceAmount);
const transactionSignature = row => signature(transactionIdentity(row),row.description,row.debit_amount,row.credit_amount,row.balance_amount);

export function auditSourceCoverage(transactions, sourceRows) {
  const supported = sourceRows.length > 0 && sourceRows.every(row =>
    sourceDate(row.sourceDate) && narration(row.narration) &&
    (row.balanceAmount == null || money(row.balanceAmount) !== null) &&
    money(row.debitAmount) !== null && money(row.creditAmount) !== null &&
    Number(Number(row.debitAmount)>0)+Number(Number(row.creditAmount)>0)===1);
  if (!supported) return {supported:false,complete:false,missing:[],unexpected:[],matched:[]};
  const buckets = new Map();
  transactions.forEach((row,index) => {
    const key=transactionSignature(row); const indexes=buckets.get(key)||[];
    indexes.push(index); buckets.set(key,indexes);
  });
  const matched=[],missing=[],used=new Set();
  sourceRows.forEach((row,index)=>{
    const transactionIndex=buckets.get(sourceSignature(row))?.shift();
    if (transactionIndex===undefined) missing.push(index);
    else {used.add(transactionIndex); matched.push({sourceIndex:index,transactionIndex});}
  });
  const unexpected=transactions.flatMap((_,index)=>used.has(index)?[]:[index]);
  return {supported:true,complete:!missing.length&&!unexpected.length,missing,unexpected,matched};
}

export async function recoverSourceCoverage({parsed,sourceRows,recover,maxRecoveryRows=40,batchSize=10}) {
  const initial=auditSourceCoverage(parsed.transactions,sourceRows);
  const diagnostics={sourceRowCount:sourceRows.length,extractedRowCount:parsed.transactions.length,
    missingRowCount:initial.missing.length,unexpectedRowCount:initial.unexpected.length,
    recoveredRowCount:0,recoveryCalls:0,complete:initial.complete,supported:initial.supported};
  if(!initial.supported) return {parsed,diagnostics};
  if(initial.complete) return {parsed:{...parsed,transactions:initial.matched.map(m=>parsed.transactions[m.transactionIndex])},diagnostics};
  const missingIdentities=new Map();
  for(const i of initial.missing) {
    const key=sourceIdentity(sourceRows[i]);missingIdentities.set(key,(missingIdentities.get(key)||0)+1);
  }
  // An invalid version of a source row can be replaced. An unrelated extra or
  // excess duplicate is not silently deleted to make the counts look correct.
  const invalidCanReplace=initial.unexpected.every(i=>{
    const key=transactionIdentity(parsed.transactions[i]);const remaining=missingIdentities.get(key)||0;
    if(!remaining)return false;missingIdentities.set(key,remaining-1);return true;
  });
  if(!invalidCanReplace||!initial.missing.length||initial.missing.length>maxRecoveryRows) return {parsed,diagnostics};
  const retained=initial.matched.map(m=>parsed.transactions[m.transactionIndex]);
  const recovered=[];
  try {
    for(let offset=0;offset<initial.missing.length;offset+=batchSize) {
      const selected=initial.missing.slice(offset,offset+batchSize).map(i=>sourceRows[i]);
      const markdown=selected.map(row=>`${row.sourceHeader}\n${row.sourceLine}`).join('\n\n');
      diagnostics.recoveryCalls++;
      const result=await recover(markdown);
      const check=auditSourceCoverage(result?.transactions||[],selected);
      if(!check.complete) return {parsed,diagnostics:{...diagnostics,recoveryFailed:true}};
      recovered.push(...check.matched.map(m=>result.transactions[m.transactionIndex]));
    }
  } catch {
    // Do not log provider payloads or trigger a whole-document paid retry.
    return {parsed,diagnostics:{...diagnostics,recoveryFailed:true}};
  }
  const combined=[...retained,...recovered];
  const final=auditSourceCoverage(combined,sourceRows);
  if(!final.complete) return {parsed,diagnostics:{...diagnostics,recoveryFailed:true}};
  return {parsed:{...parsed,transactions:final.matched.map(m=>combined[m.transactionIndex])},
    diagnostics:{...diagnostics,complete:true,recoveredRowCount:recovered.length}};
}


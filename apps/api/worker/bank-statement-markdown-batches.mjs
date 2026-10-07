import {auditSourceCoverage,recoverSourceCoverage} from './bank-statement-source-coverage.mjs';

// Keep complete source rows together; never split narrations by character count.
export async function extractMarkdownBatches({sourceRows,context='',extract,batchSize=25,onBatch}) {
  if (!auditSourceCoverage([],sourceRows).supported) throw new Error('Unsupported source rows; use PDF page recovery.');
  if (!Number.isInteger(batchSize)||batchSize<1||batchSize>40) throw new Error('Invalid statement batch size.');
  let parsed=null;
  const transactions=[],batches=[];
  for(let offset=0;offset<sourceRows.length;offset+=batchSize) {
    const rows=sourceRows.slice(offset,offset+batchSize);
    await onBatch?.({index:Math.floor(offset/batchSize)+1,total:Math.ceil(sourceRows.length/batchSize)});
    const markdown=`${context}\n\nExtract all ${rows.length} transaction rows below.\n${rows[0].sourceHeader}\n${rows.map(r=>r.sourceLine).join('\n')}`;
    const result=await extract(markdown);
    const checked=await recoverSourceCoverage({parsed:result,sourceRows:rows,recover:extract});
    batches.push({startRow:offset+1,...checked.diagnostics});
    if(!checked.diagnostics.complete) throw new Error(`Statement rows ${offset+1}-${offset+rows.length} are incomplete; use PDF page recovery.`);
    parsed ??= checked.parsed;
    transactions.push(...checked.parsed.transactions);
  }
  if(!auditSourceCoverage(transactions,sourceRows).complete) throw new Error('Combined statement coverage failed; use PDF page recovery.');
  return {parsed:{...parsed,transactions},batches};
}


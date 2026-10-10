import {createHash} from 'node:crypto';
const text=v=>typeof v==='string'?v.trim():'';
export function verifiedProposalPdf(proposal,result,base64,exportedAt) {
 if(typeof base64!=='string'||base64.length>7*1024*1024)throw Error('Native Tally PDF is missing or exceeds the document limit.');
 const pdf=Buffer.from(base64,'base64');
 if(pdf.length<5||pdf.length>5*1024*1024||pdf.subarray(0,5).toString()!=='%PDF-')throw Error('The connector returned an invalid native Tally PDF.');
 const id=text(result.voucherId),number=text(result.voucherNumber),reference=text(result.voucherReference)||text(result.openReferenceName);
 const expected=text(proposal.tally_open_reference_name)||text(proposal.tally_voucher_number);
 if(!id||!number||text(result.voucherType).toLowerCase()!=='debit note')throw Error('An identifiable Debit Note is required.');
 if(/^\d+$/.test(text(proposal.tally_voucher_id))&&text(proposal.tally_voucher_id)!==id)throw Error('The PDF belongs to a different voucher.');
 if(!expected||reference.toLowerCase()!==expected.toLowerCase())throw Error('The PDF reference does not match the proposal.');
 if(!text(result.partyLedgerName)||text(result.partyLedgerName).toLowerCase()!==text(proposal.party_ledger_name).toLowerCase())throw Error('The PDF customer does not match the proposal.');
 const actual=Number(result.amount),amount=Number(proposal.recoverable_amount);
 if(!Number.isFinite(actual)||!Number.isFinite(amount)||amount<=0||Math.abs(actual-amount)>0.01)throw Error('The PDF amount does not match the proposal.');
 const sha256=createHash('sha256').update(pdf).digest('hex');
 if(text(result.nativePdfSha256)&&text(result.nativePdfSha256).toLowerCase()!==sha256)throw Error('The PDF hash changed during transfer.');
 return {pdf,evidence:{source:'tally_voucher_render',status:'verified',voucherId:id,voucherNumber:number,reference,
   alterId:text(result.voucherAlterId)||null,sha256,byteSize:pdf.length,exportedAt}};
}

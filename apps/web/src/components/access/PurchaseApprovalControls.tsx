'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {canAccess} from '@autodealer/shared/lib/access';
import {useAccess} from './AccessProvider';
import {apiFetch} from '@/lib/api-client';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@/components/ui/dialog';

type Workflow={state:'draft'|'awaiting_approval'|'approved'|'posting'|'posted';revision:number;financial_revision:number;submitted_by:string|null;prepared_by:string;last_return_reason:string|null};
export function usePurchaseApproval(caseId:string){
 const {snapshot,enforcementRequired}=useAccess();
 const enabled=enforcementRequired;
 const [workflow,setWorkflow]=useState<Workflow|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null);
 const generation=useRef(0);
 const refresh=useCallback(async()=>{
  if(!enabled)return;
  const version=++generation.current;
  setLoading(true);
  try{const response=await apiFetch(`/api/cases/${caseId}/approval`,{cache:'no-store',signal:AbortSignal.timeout(10000)});const data=await response.json();if(version!==generation.current)return;if(!response.ok)throw Error(data.error||'Could not read purchase approval.');setWorkflow(data.workflow);setError(null);}
  catch(e){if(version===generation.current)setError(e instanceof Error?e.message:'Approval unavailable.');throw e;}
  finally{if(version===generation.current)setLoading(false);}
 },[caseId,enabled]);
 useEffect(()=>{setWorkflow(null);if(!enabled)return;const read=()=>{void refresh().catch(()=>{});};read();window.addEventListener('focus',read);return()=>{generation.current++;window.removeEventListener('focus',read);};},[refresh,enabled,snapshot?.revision]);
 const transition=useCallback(async(action:'submit'|'approve'|'return',reason?:string)=>{
  let revision=workflow?.revision??0;
  generation.current++;
  const send=async(nextAction:string)=>{const response=await apiFetch(`/api/cases/${caseId}/approval`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:nextAction,revision,reason})});const data=await response.json();if(!response.ok)throw Error(data.error||'Purchase changed. Refresh and try again.');setWorkflow(data.workflow);revision=data.workflow.revision;};
  setLoading(true);setError(null);
  try{if(action==='submit')await send('prepare');await send(action);}
  catch(e){setError(e instanceof Error?e.message:'Approval failed.');throw e;}
  finally{setLoading(false);}
 },[caseId,workflow?.revision]);
 return {enabled,snapshot,workflow,loading,error,refresh,transition};
}
export function PurchaseApprovalControls({approval,hasUnsavedChanges,ready}:{approval:ReturnType<typeof usePurchaseApproval>;hasUnsavedChanges:boolean;ready:boolean}){
 const [action,setAction]=useState<'submit'|'approve'|'return'|null>(null),[reason,setReason]=useState('');
 if(!approval.enabled)return null;
 const {workflow,snapshot,loading,error}=approval;const state=workflow?.state??'draft';
 const selfBlocked=Boolean(snapshot&&!snapshot.allowSelfApproval&&(workflow?.submitted_by===snapshot.member.user_id||workflow?.prepared_by===snapshot.member.user_id));
 return <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label="Purchase approval">
  <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">{({draft:'Draft',awaiting_approval:'Awaiting approval',approved:'Approved',posting:'Posting to Tally',posted:'Posted'})[state]}</h3><p className="mt-1 text-xs text-slate-600">{state==='draft'?'Save the financial details before submitting for review.':state==='awaiting_approval'&&selfBlocked?'Another approver must review this purchase.':state==='approved'?'The approved financial revision is locked. Posting requires separate permission.':'Submitted financial details are locked until returned for correction.'}</p></div>
  <div className="flex flex-wrap gap-2">
   <Button variant="outline" disabled={loading} onClick={()=>void approval.refresh().catch(()=>{})}>Refresh approval</Button>
   {state==='draft'&&canAccess(snapshot,'purchases.submit')&&<Button disabled={loading||hasUnsavedChanges||!ready||Boolean(error)} onClick={()=>setAction('submit')}>Submit for review</Button>}
   {state==='awaiting_approval'&&canAccess(snapshot,'purchases.approve')&&<Button disabled={loading||selfBlocked||Boolean(error)} onClick={()=>setAction('approve')}>Approve purchase</Button>}
   {['awaiting_approval','approved'].includes(state)&&canAccess(snapshot,'purchases.approve')&&<Button variant="outline" disabled={loading} onClick={()=>setAction('return')}>Return for correction</Button>}
  </div></div>
  {workflow?.last_return_reason&&state==='draft'&&<p className="mt-2 text-sm text-amber-800">Returned: {workflow.last_return_reason}</p>}
  {error&&<p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
  <Dialog open={action!==null} onOpenChange={open=>{if(!open&&!loading){setAction(null);setReason('');}}}><DialogContent><DialogHeader><DialogTitle>{action==='return'?'Return this purchase?':action==='approve'?'Approve this financial revision?':'Submit this purchase for review?'}</DialogTitle><DialogDescription>{action==='return'?'Approval will be removed and the team can correct the details.':'The saved financial details will be locked. This does not send a voucher to Tally.'}</DialogDescription></DialogHeader>
   {action==='return'&&<label className="text-sm">Reason<textarea className="mt-2 w-full rounded-md border p-2" value={reason} onChange={event=>setReason(event.target.value)} maxLength={1000}/></label>}
   <DialogFooter><Button variant="outline" disabled={loading} onClick={()=>setAction(null)}>Cancel</Button><Button disabled={loading||(action==='return'&&!reason.trim())} onClick={()=>{if(action)void approval.transition(action,reason.trim()).then(()=>{setAction(null);setReason('');}).catch(()=>{});}}>{loading?'Saving…':'Confirm'}</Button></DialogFooter>
  </DialogContent></Dialog>
 </section>;
}

'use client';
import {createPortal} from 'react-dom';
import {Fragment,useCallback,useEffect,useState} from 'react';
import {ArrowLeft,Download,MessageCircle,Repeat2,MoreHorizontal} from 'lucide-react';
import {Popover,PopoverTrigger,PopoverContent} from '@/components/ui/popover';
import {apiFetch} from '@/lib/api-client';
import {useActionAccess} from '@/components/access/useActionAccess';
import {Dialog,DialogContent,DialogTitle,DialogDescription,DialogFooter} from '@/components/ui/dialog';
import {type ReminderPlan,type ReminderStage} from '@autodealer/shared/lib/followup-pipeline';
import styles from './CollectionsDashboardPage.module.css';

type Invoice={partyLedgerName:string;linkedInvoiceNumber:string|null;linkedInvoiceDate:string|null;partyPhone:string|null};
type Row={mode?:'once'|'pipeline';id:string;revision:number;customer:string;invoice:string;outstanding:number|null;status:string;plan_name:string;stage_index:number;stage_sent:number;stages:ReminderStage[];next_due_at:string|null;verification_expires_at:string|null;note:string|null;last_attempt?:{status:string;created_at:string;error:string|null}|null};
// What happened to a WhatsApp submission, in the words the page uses everywhere.
const attemptLabel=(status:string)=>status==='accepted'?'Submitted':status==='rejected'?'Not sent':status==='submitting'?'Submitting':status==='skipped'?'Skipped':'Needs verification';
const SUBMITTED_NOTE='Submitted means WhatsApp accepted the message; delivery is not confirmed.';
type SendOutcome={customer:string;invoice:string;status:string;error:string|null;submittedAt:string|null;scheduleStatus:string|null;nextDueAt:string|null};
type Data={rows:Row[];total:number;pageSize:number;templates:Array<ReminderPlan&{id:string}>;messages:Array<{key:string;text:string}>;attempts?:Array<{id:string;status:string;recipient:string;outstanding:number;created_at:string;error:string|null;invoice_followup_pipelines:{customer:string;invoice:string}}>};
const money=(v:number|null)=>v===null?'Not checked':new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(v);
const date=(v:string|null)=>v?new Date(v).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'—';
const statusLabel:Record<string,string>={active:'Active',paused:'Paused',review:'Needs review',settled:'Settled',finished:'Limit reached',stopped:'Stopped',sending:'Submitting',uncertain:'Needs review · submission'};
function statusNote(row:Row) {
  if(row.status==='settled')return 'Payment verified in Tally';
  if(row.status==='finished'&&row.mode!=='once')return 'Sequence completed; payment not confirmed';
  return row.note;
}
function interval(value:number,unit:ReminderStage['unit']) {
  const singular=unit.slice(0,-1);
  return `${value} ${value===1?singular:unit}`;
}
function stageSchedule(stage:ReminderStage,index:number) {
  const start=stage.delay===0?'Immediately':`${interval(stage.delay,stage.unit)} after ${index===0?'starting':'the previous stage'}`;
  return stage.limit===1?`${start} · One message`:`${start} · Every ${interval(stage.every,stage.unit)}, up to ${stage.limit} messages`;
}
function stageState(row:Row,index:number) {
  if(index<row.stage_index||row.status==='finished')return {label:'Complete',tone:'complete'};
  if(index>row.stage_index)return {label:['settled','stopped'].includes(row.status)?'Not started':'Upcoming',tone:'muted'};
  if(row.status==='settled')return {label:'Stopped after payment',tone:'complete'};
  if(row.status==='stopped')return {label:'Stopped',tone:'muted'};
  if(row.status==='paused')return {label:'Paused',tone:'paused'};
  if(['review','uncertain'].includes(row.status))return {label:'Needs review',tone:'paused'};
  return {label:'Current',tone:'current'};
}
export function FollowUpPipelines({toolbarTarget,focusId='',view,connectionId,companyName,companyGuid,financialYear,companyId,invoice,onDueCount,onClearInvoice,onShowSent}:{toolbarTarget?:HTMLDivElement|null;focusId?:string;view:'due'|'pipelines'|'history';connectionId:string;companyName:string;companyGuid?:string;financialYear:string;companyId?:string;invoice:Invoice|null;onDueCount?:(count:number)=>void;onClearInvoice:()=>void;onShowSent?:()=>void}) {
  const allowed=useActionAccess(companyId);
  const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [filter,setFilter]=useState(view==='due'?'due':'all'),[page,setPage]=useState(1),[recipient,setRecipient]=useState('');
  const [checkNotice,setCheckNotice]=useState('');
  const [menuId,setMenuId]=useState<string|null>(null);
  const [selectedIds,setSelectedIds]=useState<Set<string>>(()=>new Set());
  const [selectedPlanId,setSelectedPlanId]=useState('');
  const [bulkResults,setBulkResults]=useState<Array<{key:string;status:string;message?:string}>>([]);
  const [bulkAction,setBulkAction]=useState('');
  // The result of the last single send, kept until dismissed (the reminder
  // itself leaves "Reminders due" once it is sent).
  const [sendOutcome,setSendOutcome]=useState<SendOutcome|null>(null);
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),15000);return ()=>clearInterval(timer);},[]);
  const [stopId,setStopId]=useState<string|null>(null);
  const [expandedStageId,setExpandedStageId]=useState<string|null>(null);
  const [savePhone,setSavePhone]=useState(false),[notice,setNotice]=useState('');
  const [requestId]=useState(()=>crypto.randomUUID());
  const [submitted,setSubmitted]=useState(false);
  const [preview,setPreview]=useState<{row:Row;text:string;recipient:string}|null>(null);
  const [history,setHistory]=useState<Array<{id:string;status:string;created_at:string;error:string|null}>|null>(null);
  const [panelTab,setPanelTab]=useState<'details'|'history'>('details');
  const [historyError,setHistoryError]=useState('');
  const scope={connectionId,companyId,companyGuid,companyName,financialYear};
  useEffect(()=>{
    setHistory(null);setHistoryError('');
    if(!expandedStageId||panelTab!=='history')return;
    const controller=new AbortController();
    void (async()=>{
      try {
        const response=await apiFetch('/api/collections/follow-ups/pipelines',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId,companyId,companyGuid,companyName,financialYear,action:'history',id:expandedStageId})});
        const result=await response.json();
        if(!response.ok)throw new Error(result.error||'Could not load message history.');
        if(!controller.signal.aborted)setHistory(result.attempts);
      } catch(e){if(!controller.signal.aborted)setHistoryError(e instanceof Error?e.message:'Could not load message history.');}
    })();
    return ()=>controller.abort();
  },[expandedStageId,panelTab,connectionId,companyId,companyGuid,companyName,financialYear]);
  const load=useCallback(async()=>{
    const response=await apiFetch(`/api/collections/follow-ups/pipelines?${new URLSearchParams({connectionId,companyId:companyId||'',companyGuid:companyGuid||'',companyName,financialYear,view,id:focusId,status:filter,page:String(page)})}`,{cache:'no-store'});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not load pipelines.');setData(result);if(view==='due'&&!focusId)onDueCount?.(result.total);
  },[connectionId,companyId,companyGuid,companyName,financialYear,filter,page,view,onDueCount,focusId]);
  useEffect(()=>{void load().catch(e=>setError(e.message));},[load]);
  useEffect(()=>{if(invoice){setRecipient(invoice.partyPhone||'');setError('');}},[invoice]);
  async function action(body:Record<string,unknown>) {
    const response=await apiFetch('/api/collections/follow-ups/pipelines',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...scope,...body})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Operation failed.');
    if(body.action==='check'&&result.row){const checked=result.row;setCheckNotice(`${checked.invoice}: ${checked.status==='settled'?'Invoice settled. No further reminders will be sent. View it in Reminder tracking → All statuses or Settled.':checked.status==='review'?'Needs review. Sending is blocked until the invoice is verified. Find it in Reminder tracking → Needs review.':`${checked.note||'Outstanding checked.'} Remaining: ${money(checked.outstanding)}`}`);}
    return result;
  }
  async function run(task:()=>Promise<void>){setBusy(true);setError('');try{await task();await load();}catch(e){setError(e instanceof Error?e.message:'Operation failed.');}finally{setBusy(false);}}
  async function bulk(actionName:string,extra:Record<string,unknown>={}){
    const rows=(data?.rows||[]).filter(row=>selectedIds.has(row.id));
    if(!rows.length)return;
    await run(async()=>{const result=await action({action:actionName,items:rows.map(row=>({id:row.id,revision:row.revision,key:row.invoice})),...extra});setBulkAction(actionName);setBulkResults(result.results||[]);setSelectedIds(new Set());});
  }
  function exportRows(){const rows=(data?.rows||[]).filter(row=>selectedIds.has(row.id));if(!rows.length)return;const quote=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;const csv=[['Customer','Invoice','Outstanding','Status','Plan','Next reminder'],...rows.map(row=>[row.customer,row.invoice,row.outstanding??'',statusLabel[row.status]||row.status,row.plan_name,row.next_due_at||''])].map(line=>line.map(quote).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='payment-follow-ups.csv';anchor.click();URL.revokeObjectURL(url);}
  async function submitInvoice(once:boolean){if(!invoice||busy||submitted)return;setBusy(true);setError('');try{const result=await action({action:once?'send_once':'enroll',requestId,recipient,savePhoneToTally:savePhone,customer:invoice.partyLedgerName,invoice:invoice.linkedInvoiceNumber,invoiceDate:invoice.linkedInvoiceDate});setSubmitted(true);if(result.error)setError(result.error);setNotice(`${once?(result.status==='accepted'?`Message submitted to WhatsApp. ${SUBMITTED_NOTE} It is listed in Sent messages.`:'Message requires verification. Check it in Sent messages before sending again.'):'Reminders started. They appear in Reminders due when each one is due.'} ${result.phoneNotice||''}`);}catch(e){setError(e instanceof Error?e.message:'Operation failed.');}finally{setBusy(false);}}
  const input='h-8 min-w-0 rounded-md border border-[#ded8d0] bg-white px-2 text-xs';
  const button=styles.messageAction;
  const close=()=>{if(busy)return;onClearInvoice();setPreview(null);setHistory(null);};
  const toolbar=!invoice?(<div className="flex flex-wrap items-center gap-2">{selectedIds.size?<><span className="text-xs font-semibold text-[#51483f]">{selectedIds.size} selected</span><button className={button} disabled={busy} onClick={()=>void bulk('bulk_check')}>Check Tally</button>{view==='due'?<button className={button} disabled={busy} onClick={()=>{if(window.confirm(`Verify and send ${selectedIds.size} due reminders? Each message will be recorded separately.`))void bulk('bulk_send');}}>Review & send due</button>:<><button className={button} disabled={busy} onClick={()=>void bulk('bulk_pause')}>Pause</button><button className={button} disabled={busy} onClick={()=>void bulk('bulk_resume')}>Resume</button><button className={button} disabled={busy} onClick={()=>{if(window.confirm(`Stop reminders for ${selectedIds.size} selected schedules?`))void bulk('bulk_stop');}}>Stop</button>{data?.templates?.length?<><select className={input} aria-label="Change reminder sequence" value={selectedPlanId} onChange={event=>setSelectedPlanId(event.target.value)}><option value="">Change sequence…</option>{data.templates.map(plan=><option value={plan.id} key={plan.id}>{plan.name}</option>)}</select><button className={button} disabled={busy||!selectedPlanId} onClick={()=>{const plan=data.templates.find(value=>value.id===selectedPlanId);if(plan&&window.confirm(`Restart the selected schedules using “${plan.name}”?`))void bulk('bulk_plan',{plan});}}>Apply</button></>:null}</>}<button className={button} disabled={busy} onClick={exportRows}><Download className="size-3.5"/>CSV</button><button className={button} disabled={busy} onClick={()=>setSelectedIds(new Set())}>Clear</button></>:<>{view==='pipelines'?<select aria-label="Pipeline status" className={input} value={filter} onChange={e=>{setFilter(e.target.value);setPage(1);}}><option value="all">All statuses</option>{Object.entries(statusLabel).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select>:null}<button className={button} disabled={busy} onClick={()=>void run(load)}>{view==='history'?'Refresh history':'Refresh'}</button></>}</div>):null;
  return <>
      {toolbarTarget?createPortal(toolbar,toolbarTarget):toolbar}
      <section className={styles.results} aria-label="Invoice reminders">
        <header className="my-2 flex items-center justify-between gap-3">{invoice?<button type="button" className="inline-flex items-center gap-1.5 rounded py-1 text-xs text-[#756b60] hover:text-[#28231f] focus-visible:outline focus-visible:outline-2" disabled={busy} onClick={close}><ArrowLeft className="size-3.5" aria-hidden="true"/>Back to invoices</button>:<p className="sr-only">{view==='due'?'Check outstanding, review the message, then send.':view==='history'?'Submitted messages and unsuccessful attempts.':'Track stages and manage each invoice’s schedule.'}</p>}</header>
        {checkNotice?<div role="status" className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-[#ded8d0] bg-[#faf8f5] p-3 text-xs leading-5"><p>{checkNotice}</p><button type="button" className="shrink-0 underline" onClick={()=>setCheckNotice('')}>Dismiss</button></div>:null}
        {sendOutcome?<div role="status" className={`mb-3 flex items-start justify-between gap-3 rounded-lg border p-3 text-xs leading-5 ${sendOutcome.status==='accepted'?'border-emerald-200 bg-emerald-50 text-emerald-900':'border-amber-200 bg-amber-50 text-amber-900'}`}>
          <div>
            <p><strong>{sendOutcome.status==='accepted'?'Reminder submitted to WhatsApp':sendOutcome.status==='rejected'?'Reminder not sent':'Reminder needs verification'}</strong> · {sendOutcome.customer} · {sendOutcome.invoice}{sendOutcome.submittedAt?` · ${date(sendOutcome.submittedAt)}`:''}</p>
            {sendOutcome.status==='accepted'?<p>{sendOutcome.nextDueAt?`Next reminder ${date(sendOutcome.nextDueAt)}.`:sendOutcome.scheduleStatus==='finished'?'That was the last reminder in this sequence.':'No further reminder is scheduled.'} {SUBMITTED_NOTE}</p>
              :<p>{sendOutcome.error||'The provider did not confirm the submission.'} {sendOutcome.status==='rejected'?'Nothing was delivered; you can retry after fixing the cause.':'Check its message history before sending again.'}</p>}
            {onShowSent?<button type="button" className="mt-1 underline" onClick={()=>{setSendOutcome(null);onShowSent();}}>View in Sent messages</button>:null}
          </div>
          <button type="button" className="shrink-0 underline" onClick={()=>setSendOutcome(null)}>Dismiss</button>
        </div>:null}
        {bulkResults.length?<div role="status" className="mb-3 rounded-lg border border-[#ded8d0] bg-[#faf8f5] p-3 text-xs leading-5">
          {bulkAction==='bulk_send'?<>
            <p><strong>{bulkResults.filter(result=>result.status==='accepted').length} submitted to WhatsApp</strong>{bulkResults.some(result=>result.status!=='accepted')?<span> · {bulkResults.filter(result=>result.status!=='accepted').length} need attention</span>:null}<button type="button" className="ml-3 underline" onClick={()=>setBulkResults([])}>Dismiss</button>{onShowSent?<button type="button" className="ml-3 underline" onClick={()=>{setBulkResults([]);onShowSent();}}>View in Sent messages</button>:null}</p>
            <ul className="mt-1">{bulkResults.map(result=><li key={result.key} className={result.status==='accepted'?'':'text-amber-800'}>{result.key}: {attemptLabel(result.status)}{result.message?` — ${result.message}`:''}</li>)}</ul>
            <p className="mt-1 text-[#756b60]">{SUBMITTED_NOTE}</p>
          </>:<>
            <strong>{bulkResults.filter(result=>!['skipped','uncertain','rejected'].includes(result.status)).length} completed</strong>{bulkResults.some(result=>['skipped','uncertain','rejected'].includes(result.status))?<span> · {bulkResults.filter(result=>['skipped','uncertain','rejected'].includes(result.status)).length} need attention</span>:null}<button type="button" className="ml-3 underline" onClick={()=>setBulkResults([])}>Dismiss</button>{bulkResults.filter(result=>result.message).map(result=><p className="mt-1 text-amber-800" key={result.key}>{result.key}: {result.message}</p>)}
          </>}
        </div>:null}
        {error?<p role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{error}</p>:null}
        <div className="min-h-0 overflow-auto">
        {invoice?<div className="w-full max-w-3xl overflow-hidden rounded-xl border border-[#ded8d0] bg-white">
          <div className="border-b border-[#e8e2db] px-5 py-4 sm:px-6">
            <p className="mb-1 text-[11px] font-medium text-[#756b60]">Invoice reminder</p>
            <h3 className="break-words text-base font-semibold leading-6 text-[#28231f]">{invoice.partyLedgerName}</h3>
            <p className="mt-1 text-xs text-[#756b60]">{invoice.linkedInvoiceNumber||'Missing invoice'}{invoice.linkedInvoiceDate?` · ${new Date(`${invoice.linkedInvoiceDate}T00:00:00`).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}`:''}</p>
          </div>
          <fieldset disabled={busy||submitted} className="space-y-3 px-5 py-5 sm:px-6">
            {!invoice.partyPhone?<label className="flex max-w-sm flex-col gap-2 text-xs font-medium text-[#51483f]">Customer’s WhatsApp number<input className="h-10 w-full min-w-0 rounded-lg border border-[#ded8d0] bg-white px-3 text-sm font-normal outline-none focus:border-[#9e8b78] focus:ring-2 focus:ring-[#e9e0d5] disabled:bg-stone-50" type="tel" autoComplete="tel" placeholder="10-digit mobile number or +91…" value={recipient} inputMode="tel" maxLength={20} onChange={e=>setRecipient(e.target.value)}/></label>:<div><p className="text-xs text-[#756b60]">Send to WhatsApp</p><p className="mt-1 text-sm font-medium text-[#28231f]">{recipient}</p></div>}
            {!invoice.partyPhone&&allowed('connections.manage')?<label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-[#51483f]"><input className="mt-1 size-3.5 accent-[#332c26]" type="checkbox" checked={savePhone} onChange={e=>setSavePhone(e.target.checked)}/>Also save this number in the customer’s Tally ledger</label>:null}
          </fieldset>
          <div className="border-t border-[#e8e2db] bg-[#faf8f5] px-5 py-4 sm:px-6">
            <div className="grid gap-4 sm:grid-cols-2">
              {allowed('followups.prepare')?<div><button type="button" className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#2f2924] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1f1b18] disabled:cursor-not-allowed disabled:opacity-45" disabled={busy||submitted||!recipient.trim()} onClick={()=>void submitInvoice(false)}><Repeat2 className="size-4" aria-hidden="true"/>Start reminders</button><p className="mt-2 text-[11px] leading-4 text-[#756b60]">Add this invoice to your saved sequence. Send due reminders from the Reminders due tab.</p></div>:null}
              {allowed('followups.export')?<div><button type="button" className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-[#ded8d0] bg-white px-4 py-2 text-xs font-semibold text-[#332c26] hover:bg-[#f3eee8] disabled:cursor-not-allowed disabled:opacity-45" disabled={busy||submitted||!recipient.trim()} onClick={()=>void submitInvoice(true)}><MessageCircle className="size-4" aria-hidden="true"/>Send once</button><p className="mt-2 text-[11px] leading-4 text-[#756b60]">Send one WhatsApp reminder now, without starting a sequence.</p></div>:null}
            </div>
            <p className="mt-4 text-[11px] leading-4 text-[#756b60]" role={busy?'status':undefined}>{busy?'Checking the invoice and processing your request…':'We check the outstanding balance in Tally before continuing.'}</p>
          </div>
          {notice?<p role="status" className="border-t border-[#e8e2db] px-5 py-4 text-xs leading-5 text-[#51483f] sm:px-6">{notice}</p>:null}
        </div>:view==='history'?<>

          <p className="mb-2 text-xs text-[#756b60]">Every WhatsApp reminder submitted, newest first. {SUBMITTED_NOTE}</p>
          <div className="overflow-x-auto"><table className={styles.createdTable}><thead><tr><th>Customer / invoice</th><th>Amount</th><th>WhatsApp number</th><th>Submitted at</th><th>Status</th></tr></thead><tbody>{data?.attempts?.map(a=><tr key={a.id}><td>{a.invoice_followup_pipelines.customer}<span className={styles.secondary}>{a.invoice_followup_pipelines.invoice}</span></td><td>{money(a.outstanding)}</td><td>{a.recipient}</td><td>{date(a.created_at)}</td><td>{attemptLabel(a.status)}<span className={styles.secondary}>{a.error}</span></td></tr>)}</tbody></table></div>
          {!error&&!data?.attempts?.length?<p className="py-8 text-center text-xs">No messages submitted yet.</p>:null}
          <footer className="my-3 flex justify-end gap-4 text-xs"><span>{data?.total||0} messages · Page {page}</span><button disabled={busy||page===1} onClick={()=>setPage(p=>p-1)}>Previous</button><button disabled={busy||page*25>=(data?.total||0)} onClick={()=>setPage(p=>p+1)}>Next</button></footer>
        </>:<>

          <div className={styles.flatTable}><table className={`${styles.createdTable} ${styles.pipelineTable}`}><thead><tr><th className="w-9"><input type="checkbox" aria-label="Select this page" checked={Boolean(data?.rows.length)&&data!.rows.every(row=>selectedIds.has(row.id))} onChange={event=>setSelectedIds(event.target.checked?new Set(data?.rows.map(row=>row.id)):new Set())}/></th><th>Customer / invoice</th><th>Outstanding</th><th>Stage</th><th>Next reminder</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{data?.rows.map(row=><Fragment key={row.id}><tr>
            <td><input type="checkbox" aria-label={`Select ${row.invoice}`} checked={selectedIds.has(row.id)} onChange={event=>setSelectedIds(current=>{const next=new Set(current);event.target.checked?next.add(row.id):next.delete(row.id);return next;})}/></td><td><span className={styles.customerName}>{row.customer}</span><span className={styles.secondary}>{row.invoice}</span></td><td>{money(row.outstanding)}</td>
            <td>{row.mode==='once'?<span>One-time message</span>:<button type="button" className="rounded text-left focus-visible:outline focus-visible:outline-2" aria-expanded={expandedStageId===row.id} aria-controls={`stages-${row.id}`} onClick={()=>{setPanelTab('details');setExpandedStageId(row.id);}}><span aria-hidden="true">{expandedStageId===row.id?'▾':'▸'} </span>{row.stages[row.stage_index]?.name}<span className={styles.secondary}>Stage {row.stage_index+1} of {row.stages.length} · {row.stage_sent}/{row.stages[row.stage_index]?.limit} submitted</span></button>}</td>
            <td>{row.next_due_at?date(row.next_due_at):<span className={styles.mutedValue}>None</span>}</td><td><span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${row.status==='settled'?'bg-emerald-50 text-emerald-800':['review','uncertain'].includes(row.status)?'bg-amber-50 text-amber-800':'bg-stone-100 text-stone-600'}`}>{row.mode==='once'&&row.status==='finished'?'Message submitted':statusLabel[row.status]}</span>{statusNote(row)?<span className={styles.statusNote}>{statusNote(row)}</span>:null}{row.verification_expires_at?<span className={styles.secondary}>Check valid until {date(row.verification_expires_at)}</span>:null}{row.last_attempt?<span className={`${styles.secondary} ${row.last_attempt.status==='accepted'?'':'text-amber-800'}`} title={SUBMITTED_NOTE}>Last message: {attemptLabel(row.last_attempt.status)} · {date(row.last_attempt.created_at)}{row.last_attempt.error?` — ${row.last_attempt.error}`:''}</span>:row.mode!=='once'?<span className={styles.secondary}>No message sent yet</span>:null}</td>
            <td><div className="flex items-center gap-1.5">
              {allowed('followups.export')&&row.status==='active'&&row.verification_expires_at&&Date.parse(row.verification_expires_at)>now?
                <button className={button} disabled={busy||!row.next_due_at||Date.parse(row.next_due_at)>now} title={row.next_due_at&&Date.parse(row.next_due_at)>now?'This reminder is not due yet.':undefined} onClick={()=>void run(async()=>{const result=await action({action:'preview',id:row.id,revision:row.revision});setPreview({row,...result});})}>Review & send</button>:
                allowed('followups.prepare')&&['active','review','paused'].includes(row.status)?<button className={button} disabled={busy} onClick={()=>void run(async()=>{await action({action:'check',id:row.id,revision:row.revision});setNow(Date.now());})}>Check outstanding</button>:null}
              <Popover open={menuId===row.id} onOpenChange={open=>{setMenuId(open?row.id:null);setStopId(null);}}>
                <PopoverTrigger asChild><button type="button" className={styles.rowMenuButton} disabled={busy} aria-label={`More actions for ${row.invoice}`}><MoreHorizontal className="size-4" aria-hidden="true"/></button></PopoverTrigger>
                <PopoverContent align="end" className="w-52 rounded-lg border-[#ded8d0] bg-white p-1.5 text-[#332c26]">
                  <div className="flex flex-col [&>button]:rounded-md [&>button]:px-3 [&>button]:py-2 [&>button]:text-left [&>button]:text-xs [&>button:hover]:bg-[#f5f1eb] [&>button:disabled]:opacity-45">
                    <button type="button" onClick={()=>{setMenuId(null);setPanelTab('details');setExpandedStageId(row.id);}}>View details</button>
                    <button type="button" onClick={()=>{setMenuId(null);setPanelTab('history');setExpandedStageId(row.id);}}>Message history</button>
                    {allowed('followups.prepare')&&['active','paused','review'].includes(row.status)?<>
                      <div className="my-1 border-t border-[#e8e2db]"/>
                      <button type="button" className="rounded-md px-3 py-2 text-left text-xs hover:bg-[#f5f1eb]" disabled={busy} onClick={()=>{setMenuId(null);void run(async()=>{await action({action:'check',id:row.id,revision:row.revision});setNow(Date.now());});}}>Recheck outstanding</button>
                      <button type="button" className="rounded-md px-3 py-2 text-left text-xs hover:bg-[#f5f1eb]" disabled={busy} onClick={()=>{setMenuId(null);void run(async()=>{await action({action:row.status==='paused'?'resume':'pause',id:row.id,revision:row.revision});});}}>{row.status==='paused'?'Resume reminders':'Pause reminders'}</button>
                      {stopId===row.id?<div className="rounded-md bg-red-50 p-3 text-xs"><p>Stop reminders for this invoice?</p><div className="mt-2 flex gap-2"><button className={button} disabled={busy} onClick={()=>{setMenuId(null);void run(async()=>{await action({action:'stop',id:row.id,revision:row.revision});setStopId(null);});}}>Confirm stop</button><button disabled={busy} onClick={()=>setStopId(null)}>Cancel</button></div></div>:<button type="button" className="rounded-md px-3 py-2 text-left text-xs text-red-700 hover:bg-red-50" onClick={()=>setStopId(row.id)}>Stop reminders</button>}
                    </>:null}
                  </div>
                </PopoverContent>
              </Popover>
            </div></td>
          </tr></Fragment>)}</tbody></table></div>
          {!error&&!data?.rows.length?<p className="py-6 text-center text-xs text-[#756b60]">{data?(view==='due'?'No reminders due right now.':'No reminder schedules in this view.'):'Loading…'}</p>:null}
          <footer className="mt-3 flex items-center justify-end gap-3 text-xs"><span>{data?.total||0} invoices · Page {page}</span><button disabled={busy||page<=1} onClick={()=>setPage(p=>p-1)}>Previous</button><button disabled={busy||page*(data?.pageSize||25)>=(data?.total||0)} onClick={()=>setPage(p=>p+1)}>Next</button></footer>
        </>}
        </div>
      </section>
      <Dialog open={!!expandedStageId} onOpenChange={open=>{if(!open)setExpandedStageId(null);}}>
        <DialogContent placement="right" className="border-[#ded8d0] p-0">
          <div className="shrink-0 border-b border-[#e8e2db] px-5 py-5 pr-14">
            <DialogTitle className="text-base">Invoice reminders</DialogTitle>
            <DialogDescription className="mt-1 text-xs">{data?.rows.find(row=>row.id===expandedStageId)?.customer}</DialogDescription>
          </div>
          <div className="flex shrink-0 gap-5 border-b border-[#e8e2db] px-5" aria-label="Reminder views">
            {(['details','history'] as const).map(tab=><button key={tab} type="button" aria-pressed={panelTab===tab} onClick={()=>setPanelTab(tab)} className={`border-b-2 py-3 text-xs ${panelTab===tab?'border-[#2f2924] font-semibold text-[#2f2924]':'border-transparent text-[#756b60]'}`}>{tab==='details'?'Details':'Message history'}</button>)}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {panelTab==='history'?<section aria-label="Message history">
              {historyError?<p role="alert" className="text-xs text-red-800">{historyError}</p>:history===null?<p role="status" className="text-xs text-[#756b60]">Loading message history…</p>:history.length?<ol className="space-y-3">{history.map(a=><li key={a.id} className="rounded-lg border border-[#e8e2db] p-4"><div className="flex flex-wrap justify-between gap-2 text-xs"><strong>{a.status==='accepted'?'Submitted':a.status==='rejected'?'Not sent':a.status==='submitting'?'Submitting':'Needs verification'}</strong><span className="text-[#756b60]">{date(a.created_at)}</span></div>{a.error?<p className="mt-2 break-words text-xs leading-5 text-red-800">{a.error}</p>:null}</li>)}</ol>:<p className="text-xs text-[#756b60]">No messages submitted yet.</p>}
              <p className="mt-4 text-xs leading-5 text-[#756b60]">Submitted means WhatsApp accepted the message, not confirmed delivery.</p>
            </section>:<>
            {data?.rows.filter(row=>row.id===expandedStageId).map(row=><div key={row.id}>
              <dl className="mb-5 grid grid-cols-2 gap-4 text-xs">
                <div><dt className="text-[#756b60]">Invoice</dt><dd className="mt-1 break-words font-medium">{row.invoice}</dd></div>
                <div><dt className="text-[#756b60]">Outstanding</dt><dd className="mt-1 font-medium">{money(row.outstanding)}</dd></div>
                <div><dt className="text-[#756b60]">Status</dt><dd className="mt-1">{statusLabel[row.status]||row.status}</dd></div>
                <div><dt className="text-[#756b60]">Next reminder</dt><dd className="mt-1">{row.next_due_at?date(row.next_due_at):'None'}</dd></div>
              </dl>
              <section id={`stages-${row.id}`} aria-label={`Reminder sequence for ${row.invoice}`} className={styles.sequenceSummary}>
                <h3>Sequence</h3>
                <ol>{row.stages.map((stage,i)=>{const state=stageState(row,i);return <li key={i}>
                  <span className={styles.sequenceNumber} aria-hidden="true">{i+1}</span>
                  <div className={styles.sequenceCopy}><strong>{stage.name}</strong><span>{stageSchedule(stage,i)}</span>{i===row.stage_index&&row.stage_sent>0?<span>{row.stage_sent} of {stage.limit} sent</span>:null}</div>
                  <span className={`${styles.sequenceState} ${styles[`sequenceState_${state.tone}`]}`}>{state.label}</span>
                </li>;})}</ol>
              </section>
            </div>)}
            </>}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!preview} onOpenChange={open=>{if(!open&&!busy)setPreview(null);}}>
        <DialogContent className="flex max-h-[85dvh] max-w-xl flex-col overflow-hidden rounded-xl border-[#ded8d0] p-0" showClose={!busy}>
          <div className="shrink-0 border-b border-[#e8e2db] px-5 py-4 pr-14">
            <DialogTitle className="text-base font-semibold text-[#28231f]">Review reminder</DialogTitle>
            <DialogDescription className="mt-1 break-words text-xs text-[#756b60]">{preview?.row.customer} · {preview?.row.invoice}</DialogDescription>
          </div>
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            <p className="mb-3 text-xs text-[#756b60]">WhatsApp to <span className="font-medium text-[#28231f]">{preview?.recipient}</span></p>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-[#e8e2db] bg-[#faf8f5] p-4 text-sm leading-6 text-[#28231f]">{preview?.text}</p>
            {error?<p role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800">{error}</p>:null}
          </div>
          <DialogFooter className="m-0 shrink-0 border-t border-[#e8e2db] px-5 py-4">
            <button className={button} disabled={busy} onClick={()=>setPreview(null)}>Cancel</button>
            <button className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-[#2f2924] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1f1b18] disabled:opacity-45" disabled={busy} onClick={()=>{if(!preview||busy)return;const sent=preview.row;void run(async()=>{const result=await action({action:'send',id:sent.id,revision:sent.revision});setPreview(null);setSendOutcome({customer:sent.customer,invoice:sent.invoice,status:String(result.status||'uncertain'),error:result.error||null,submittedAt:result.submittedAt||null,scheduleStatus:result.scheduleStatus||null,nextDueAt:result.nextDueAt||null});});}}><MessageCircle className="size-4" aria-hidden="true"/>{busy?'Please wait…':'Send WhatsApp'}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  </>;
}

'use client';

import {useEffect,useMemo,useState} from 'react';
import {Copy,Info,Plus,Trash2} from 'lucide-react';
import {apiFetch} from '@/lib/api-client';
import type {ReminderPlan,ReminderStage} from '@autodealer/shared/lib/followup-pipeline';
import {standardReminderPlan} from '@autodealer/shared/lib/reminder-preset';

type ReminderMessage={key:string;text:string};
const DEFAULT_TEMPLATE='payment_reminder_v2';
const input='min-w-0 rounded-lg border border-[#ded8d0] bg-white px-3 py-2 text-xs text-[#28231f] outline-none transition focus:border-[#9e8b78] focus:ring-2 focus:ring-[#e9e0d5]';

function templateLabel(key:string){
 return key.replace(/_/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase());
}

export function PaymentReminderSettings(){
 const [plan,setPlan]=useState<ReminderPlan>(()=>standardReminderPlan());
 const [once,setOnce]=useState(DEFAULT_TEMPLATE);
 const [revision,setRevision]=useState(0);
 const [messages,setMessages]=useState<ReminderMessage[]>([]);
 const [status,setStatus]=useState('');
 const [error,setError]=useState(false);
 const [busy,setBusy]=useState(true);

 useEffect(()=>{
  let live=true;
  void apiFetch('/api/settings/payment-reminders').then(async response=>{
   const data=await response.json();
   if(!response.ok)throw Error(data.error);
   if(!live)return;
   setRevision(data.revision);
   setMessages(data.messages);
   const defaultKey=data.messages.some((message:ReminderMessage)=>message.key===DEFAULT_TEMPLATE)?DEFAULT_TEMPLATE:data.messages[0]?.key||'';
   if(data.value){setPlan(data.value.plan);setOnce(data.value.onceTemplate);}
   else if(defaultKey){setPlan(standardReminderPlan(defaultKey));setOnce(defaultKey);}
  }).catch(reason=>{
   if(live){setError(true);setStatus(reason instanceof Error?reason.message:'Reminder settings could not be loaded.');}
  }).finally(()=>{if(live)setBusy(false);});
  return()=>{live=false;};
 },[]);

 const totalReminders=useMemo(()=>plan.stages.reduce((sum,stage)=>sum+stage.limit,0),[plan.stages]);
 const updateStage=(index:number,patch:Partial<ReminderStage>)=>setPlan(current=>({...current,stages:current.stages.map((stage,stageIndex)=>stageIndex===index?{...stage,...patch}:stage)}));
 const removeStage=(index:number)=>setPlan(current=>({...current,stages:current.stages.filter((_,stageIndex)=>stageIndex!==index)}));
 const duplicateStage=(index:number)=>setPlan(current=>current.stages.length>=8?current:{...current,stages:[...current.stages.slice(0,index+1),{...current.stages[index],name:`${current.stages[index].name} copy`},...current.stages.slice(index+1)]});
 const addStage=()=>setPlan(current=>current.stages.length>=8?current:{...current,stages:[...current.stages,{name:'Next reminder',template:once||DEFAULT_TEMPLATE,unit:'days',delay:1,every:1,limit:3}]});

 const save=()=>{
  setBusy(true);setStatus('');setError(false);
  void apiFetch('/api/settings/payment-reminders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plan,onceTemplate:once,revision})})
   .then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error);setRevision(data.revision);setStatus('Reminder settings saved.');})
   .catch(reason=>{setError(true);setStatus(reason instanceof Error?reason.message:'Reminder settings could not be saved.');})
   .finally(()=>setBusy(false));
 };

 const templateOptions=<><option value="">Choose approved template</option>{messages.map(message=><option key={message.key} value={message.key}>{templateLabel(message.key)}</option>)}</>;

 return <section className="w-full rounded-xl border border-[#ded8d0] bg-white p-5 text-sm shadow-[0_1px_2px_rgba(52,42,32,0.04)] sm:p-6">
  <div className="flex flex-col gap-4 border-b border-[#e8e2db] pb-5 lg:flex-row lg:items-start lg:justify-between">
   <div><h2 className="text-base font-bold tracking-tight text-[#111827]">Reminder sequence</h2><p className="mt-1 text-xs text-[#5b4b3d]">Choose when reminders become due. Your team checks the balance and sends them.</p></div>
   <div className="flex shrink-0 items-center gap-2 self-start rounded-full border border-[#ded8d0] bg-[#faf8f5] px-3 py-2 text-xs text-[#675d54]"><Info aria-hidden="true" className="size-3.5"/><span>{plan.stages.length} {plan.stages.length===1?'stage':'stages'} · Up to {totalReminders} reminders</span></div>
  </div>

  {status?<p role="status" className={`mt-4 rounded-lg border px-3 py-2 text-xs ${error?'border-red-200 bg-red-50 text-red-700':'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{status}</p>:null}
  {!messages.length&&!busy?<p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">No approved payment-reminder template is available.</p>:null}

  <fieldset disabled={busy} className="mt-5 space-y-5 disabled:opacity-60">
   <div className="flex flex-col gap-2 rounded-lg border border-[#e5dfd8] bg-[#faf8f5] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
    <div><p className="text-xs font-semibold text-[#111827]">“Send once” template</p><p className="mt-0.5 text-xs text-[#8a7f72]">A single message, without adding the invoice to this sequence.</p></div>
    <select aria-label="One-time reminder template" className={`${input} w-full sm:w-64`} value={once} onChange={event=>setOnce(event.target.value)}>{templateOptions}</select>
   </div>

   <div className="relative">
    <div className="relative grid grid-cols-[repeat(auto-fit,minmax(min(100%,290px),1fr))] items-stretch gap-4">
     {plan.stages.map((stage,index)=><article key={index} className="flex min-w-0 flex-col">
      <div className="mb-2 flex items-center gap-2"><span className="grid size-6 shrink-0 place-items-center rounded-full border border-[#d8d0c7] bg-[#f3eee8] text-[11px] font-semibold text-[#51483f]">{index+1}</span><span className="text-xs text-[#8a7f72]">{index===0?'When an invoice is added':'After the previous stage'}</span></div>
      <div className="flex-1 overflow-hidden rounded-xl border border-[#dcd4cb] bg-white">
       <header className="flex items-center gap-2 border-b border-[#e8e2db] bg-[#faf8f5] px-4 py-3">
        <input aria-label={`Stage ${index+1} name`} title={stage.name} className="min-w-0 flex-1 rounded bg-transparent text-sm font-bold text-[#111827] outline-none focus:ring-2 focus:ring-[#ded8d0]" value={stage.name} maxLength={80} onChange={event=>updateStage(index,{name:event.target.value})}/>
        <button type="button" aria-label={`Duplicate ${stage.name}`} title="Duplicate stage" disabled={plan.stages.length>=8} className="rounded-md p-1.5 text-[#776b61] hover:bg-white hover:text-[#27221e] disabled:opacity-35" onClick={()=>duplicateStage(index)}><Copy aria-hidden="true" className="size-3.5"/></button>
        <button type="button" aria-label={`Remove ${stage.name}`} title="Remove stage" disabled={plan.stages.length===1} className="rounded-md p-1.5 text-[#776b61] hover:bg-white hover:text-red-700 disabled:opacity-35" onClick={()=>removeStage(index)}><Trash2 aria-hidden="true" className="size-3.5"/></button>
       </header>
       <div className="space-y-3 p-4">
        <label className="grid grid-cols-[1fr_72px_104px] items-center gap-2 text-xs text-[#51483f]"><span>Starts after</span><input aria-label={`${stage.name} start delay`} className={input} type="number" min={0} max={365} value={stage.delay} onChange={event=>updateStage(index,{delay:Number(event.target.value)})}/><select aria-label={`${stage.name} time unit`} className={input} value={stage.unit} onChange={event=>updateStage(index,{unit:event.target.value as ReminderStage['unit']})}><option value="days">Days</option><option value="hours">Hours</option><option value="minutes">Minutes</option></select></label>
        <label className="grid grid-cols-[1fr_72px_104px] items-center gap-2 text-xs text-[#51483f]"><span>Repeat every</span><input aria-label={`${stage.name} repeat interval`} className={input} type="number" min={1} max={365} value={stage.every} onChange={event=>updateStage(index,{every:Number(event.target.value)})}/><span className="px-3 text-[#82766b]">{stage.unit}</span></label>
        <label className="grid grid-cols-[1fr_72px_104px] items-center gap-2 text-xs text-[#51483f]"><span>Send up to</span><input aria-label={`${stage.name} reminder limit`} className={input} type="number" min={1} max={100} value={stage.limit} onChange={event=>updateStage(index,{limit:Number(event.target.value)})}/><span className="px-3 text-[#756a60]">reminders</span></label>
        <p className="text-xs text-[#8a7f72]">{stage.limit===1?'One reminder in this stage; no repeats.':index===plan.stages.length-1?'The sequence ends after this stage.':'Then move to the next stage.'}</p>
        <div className="border-t border-[#e8e2db] pt-3"><label className="flex flex-col gap-1.5 text-xs font-medium text-[#51483f]">Message template<select className={`${input} w-full`} value={stage.template} onChange={event=>updateStage(index,{template:event.target.value})}>{templateOptions}</select></label></div>
       </div>
      </div>
     </article>)}
    </div>
   </div>

   <div className="flex flex-col-reverse gap-3 border-t border-[#e8e2db] pt-5 sm:flex-row sm:items-center sm:justify-between">
    <button type="button" disabled={plan.stages.length>=8} className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#ded8d0] bg-[#faf8f5] px-4 py-2.5 text-xs font-semibold text-[#332c26] hover:bg-[#f3eee8] disabled:cursor-not-allowed disabled:opacity-40" onClick={addStage}><Plus aria-hidden="true" className="size-4"/>Add stage</button>
    <div className="flex flex-col gap-2 sm:items-end"><p className="text-xs text-[#8a7f72]">Changes apply to newly added invoices.</p><button type="button" disabled={busy||!messages.length} className="rounded-lg bg-[#2b1a10] px-5 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-[#3b271a] disabled:cursor-not-allowed disabled:opacity-45" onClick={save}>{busy?'Please wait…':'Save changes'}</button></div>
   </div>
  </fieldset>
 </section>;
}

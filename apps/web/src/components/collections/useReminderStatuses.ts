'use client';
import {useEffect,useState} from 'react';
import {apiFetch} from '@/lib/api-client';
export type ScheduleStatus={id:string;customer:string;invoice:string;invoice_date:string;status:string;next_due_at:string|null};
export const invoiceKey=(customer:string,invoice:string|null,date:string|null)=>JSON.stringify([customer.trim(),invoice?.trim(),date]);
export function reminderLabel(row:ScheduleStatus|undefined,now=Date.now()) {
 if(!row)return {label:'Not scheduled',action:'Set up reminders'};
 if(row.status==='active')return row.next_due_at&&Date.parse(row.next_due_at)<=now?{label:'Reminder due',action:'Check & send'}:{label:'Reminders active',action:'View schedule'};
 const labels:Record<string,string>={paused:'Reminders paused',finished:'Limit reached',review:'Needs review',uncertain:'Submission needs review',sending:'Submitting',settled:'Settled · verify balance',stopped:'Reminders stopped'};
 return {label:labels[row.status]||'Needs review',action:['paused','stopped'].includes(row.status)?'View schedule':'Review'};
}
export function useReminderStatuses(scope:{connectionId:string;companyId?:string;companyGuid?:string;companyName:string;financialYear:string},invoices:Array<{partyLedgerName:string;linkedInvoiceNumber:string|null;linkedInvoiceDate:string|null}>,enabled:boolean) {
 const requestKey=JSON.stringify({...scope,invoices:invoices.filter(i=>i.linkedInvoiceNumber&&i.linkedInvoiceDate).map(i=>({customer:i.partyLedgerName,invoice:i.linkedInvoiceNumber,date:i.linkedInvoiceDate}))});
 const [state,setState]=useState<{key:string;rows:Record<string,ScheduleStatus>;error:boolean}|null>(null);
 useEffect(()=>{if(!enabled)return;const abort=new AbortController();let active=true;
 void (async()=>{try{const response=await apiFetch('/api/collections/follow-ups/pipelines',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...JSON.parse(requestKey),action:'statuses'}),signal:abort.signal});const data=await response.json();if(!response.ok)throw Error();const rows:Record<string,ScheduleStatus>={};for(const row of data.rows as ScheduleStatus[]){const k=invoiceKey(row.customer,row.invoice,row.invoice_date);const previous=rows[k];if(!previous||(['finished','settled','stopped'].includes(previous.status)&&!['finished','settled','stopped'].includes(row.status)))rows[k]=row;}if(active)setState({key:requestKey,rows,error:false});}catch{if(active)setState({key:requestKey,rows:{},error:true});}})();return()=>{active=false;abort.abort();};},[requestKey,enabled]);
 return state?.key===requestKey?state:null;
}

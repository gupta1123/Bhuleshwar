import {createHash,randomUUID} from 'node:crypto';
import {withTeamAccess} from '@/lib/access/route-boundary';
import {requireDataset} from '@/lib/access/dataset';
import {AccessError} from '@/lib/access/server';
import {jsonWithCors,optionsWithCors} from '@/lib/api/cors';
import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import {validateReminderPlan,advanceReminder,stageMs,verificationOutcome,REMINDER_CHECK_MS,type ReminderStage} from '@autodealer/shared/lib/followup-pipeline';
import {readReminderBills} from '@/lib/followups/live-read';
import {reminderMessages,reminderPreview,submitReminder} from '@/lib/followups/messages';
import {WhatsappRejectedError,normalizeWhatsappPhone} from '@/lib/msg91/whatsapp';
import {reminderDefaults} from '@/lib/followups/defaults';
import {wakeTallyConnector} from '@/lib/tally/command-wake';

export const OPTIONS=optionsWithCors;
type Pipeline={id:string;organization_id:string;company_id:string;connection_id:string;installation_id:string;session_generation:number;company_guid:string;financial_year:string;company_name:string;customer:string;invoice:string;invoice_date:string;recipient:string;mode:'pipeline'|'once';stages:ReminderStage[];stage_index:number;stage_sent:number;status:string;revision:number;outstanding:number;next_due_at:string|null;verified_at:string|null;verification_expires_at:string|null;plan_name:string};
const scopeOf=(body:Record<string,unknown>)=>({companyId:body.companyId,companyGuid:body.companyGuid,companyName:body.companyName,financialYear:body.financialYear});
const failure=(request:Request,error:unknown)=>jsonWithCors(request,{error:error instanceof Error?error.message:'Follow-up operation failed.'},{status:error instanceof AccessError?error.status:503});
function checked<T>(result:{data:T;error:unknown}):T {if(result.error)throw new Error('Follow-up storage is unavailable. Check that the pipeline migration has been applied.');return result.data;}
async function context(request:Request,body:Record<string,unknown>,permission:string) {
  return requireDataset(request,String(body.connectionId||''),scopeOf(body),permission);
}
function phone(raw:unknown) {const value=normalizeWhatsappPhone(raw);if(!/^91\d{10}$/.test(value))throw new AccessError('Enter a valid Indian WhatsApp number.',400);return value;}
const batchItems=(value:unknown)=>{
  if(!Array.isArray(value)||!value.length||value.length>100)throw new AccessError('Select between 1 and 100 invoices.',400);
  return value as Array<Record<string,unknown>>;
};
async function GETHandler(request:Request) {
  try {
    const body=Object.fromEntries(new URL(request.url).searchParams);
    const {access,link,connection}=await context(request,body,'followups.view');
    const db=createSupabaseAdminClient();
    const limit=25, page=Math.max(1,Math.min(10000,Number(body.page)||1));
    if(body.view==='history') {
      const result=await db.from('invoice_followup_attempts').select('id,status,recipient,outstanding,stage_index,created_at,error,invoice_followup_pipelines!inner(customer,invoice,organization_id,company_id,connection_id,installation_id,company_guid,financial_year)',{count:'exact'})
        .eq('invoice_followup_pipelines.organization_id',access.organizationId).eq('invoice_followup_pipelines.company_id',link.company_id)
        .eq('invoice_followup_pipelines.installation_id',connection.installation_id).eq('invoice_followup_pipelines.company_guid',link.company_guid).eq('invoice_followup_pipelines.financial_year',link.financial_year)
        .order('created_at',{ascending:false}).order('id').range((page-1)*limit,page*limit-1);
      checked(result);
      return jsonWithCors(request,{attempts:result.data,total:result.count,pageSize:limit,rows:[],templates:[],messages:[]},{headers:{'Cache-Control':'private, no-store'}});
    }
    let query=db.from('invoice_followup_pipelines').select('*',{count:'exact'}).eq('organization_id',access.organizationId).eq('company_id',link.company_id).eq('installation_id',connection.installation_id).eq('company_guid',link.company_guid).eq('financial_year',link.financial_year);
    if(body.id)query=query.eq('id',body.id);
    if(body.status==='due')query=query.eq('mode','pipeline').eq('status','active').lte('next_due_at',new Date().toISOString());
    else if(['active','paused','review','settled','finished','stopped','sending','uncertain'].includes(body.status))query=query.eq('status',body.status);
    const rows=await query.order('next_due_at',{ascending:true,nullsFirst:false}).order('id').range((page-1)*limit,page*limit-1);
    checked(rows);
    const templates=checked(await db.from('followup_pipeline_templates').select('*').eq('organization_id',access.organizationId).order('name').limit(100));
    // The latest message of each schedule on this page, so the list can show
    // whether (and when) the last reminder was submitted.
    const pageIds=(rows.data||[]).map(row=>row.id);
    const latest=new Map<string,{status:string;created_at:string;error:string|null}>();
    if(pageIds.length){
      const attempts=checked(await db.from('invoice_followup_attempts').select('pipeline_id,status,created_at,error')
        .in('pipeline_id',pageIds).order('created_at',{ascending:false}).limit(500));
      for(const attempt of attempts||[])if(!latest.has(attempt.pipeline_id))latest.set(attempt.pipeline_id,{status:attempt.status,created_at:attempt.created_at,error:attempt.error});
    }
    const visibleRows=(rows.data||[]).map(row=>({...(row.connection_id===connection.id&&row.session_generation===connection.session_generation
      ?row:{...row,verification_expires_at:null,note:row.note||'Tally was reconnected. Check outstanding before sending again.'}),last_attempt:latest.get(row.id)??null}));
    return jsonWithCors(request,{rows:visibleRows,total:rows.count,page,pageSize:limit,templates,messages:reminderMessages().map(m=>({key:m.key,text:m.text})),checkValidityMinutes:5},{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return failure(request,error);}
}
async function POSTHandler(request:Request) {
  try {
    const body=await request.json();
    let action=String(body.action||'');
    const permission=action==='history'||action==='statuses'?'followups.view':action==='send'||action==='send_once'||action==='preview'||action==='bulk_send'||action==='bulk_send_once'?'followups.export':action==='save_template'?'settings.manage':'followups.prepare';
    const {access,link,connection}=await context(request,body,permission);
    const db=createSupabaseAdminClient();
    if(action.startsWith('bulk_')) {
      const items=batchItems(body.items);
      const results:Array<{key:string;status:string;message?:string;row?:unknown}>=[];
      const keyOf=(item:Record<string,unknown>)=>String(item.key||item.id||item.invoice||'').slice(0,500);
      if(action==='bulk_enroll'||action==='bulk_send_once') {
        const once=action==='bulk_send_once';
        const defaults=(await reminderDefaults(access.organizationId)).value;
        if(!defaults)throw new AccessError('Set up Payment reminders in Settings first.',409);
        if(once&&(!process.env.MSG91_AUTHKEY||!process.env.MSG91_WHATSAPP_NUMBER))throw new AccessError('Configure the WhatsApp sender before sending.',409);
        const plan=validateReminderPlan(once?{name:'One-time reminder',stages:[{name:'One-time reminder',template:defaults.onceTemplate,delay:0,every:1,unit:'days',limit:1}]}:defaults.plan);
        const valid=items.map(item=>({item,customer:String(item.customer||'').trim(),invoice:String(item.invoice||'').trim(),invoiceDate:String(item.invoiceDate||''),recipient:phone(item.recipient)}));
        if(valid.some(x=>!x.customer||!x.invoice||!/^\d{4}-\d{2}-\d{2}$/.test(x.invoiceDate)))throw new AccessError('Every selection needs a customer, invoice and invoice date.',400);
        const evidence=await readReminderBills(request,{connectionId:connection.id,companyName:link.company_name,financialYear:link.financial_year,organizationId:access.organizationId},valid.map(x=>x.customer));
        const byLedger=evidence.byLedger as Record<string,{openBills?:Parameters<typeof verificationOutcome>[0]}>|undefined;
        if(evidence.complete===false||!byLedger)throw new AccessError('Tally verification is incomplete. Nothing was changed.',409);
        for(const x of valid){
          try{
            const bills=byLedger[x.customer]?.openBills;if(!Array.isArray(bills))throw new Error('Tally did not return this customer completely.');
            const outcome=verificationOutcome(bills,x.invoice,x.invoiceDate);if(outcome.status!=='active')throw new Error('Invoice is settled or needs review in Tally.');
            const invoiceKey=createHash('sha256').update(JSON.stringify([x.customer,x.invoice,x.invoiceDate])).digest('hex');
            if(!once){const unfinished=checked(await db.from('invoice_followup_pipelines').select('id').eq('organization_id',access.organizationId).eq('company_id',link.company_id).eq('installation_id',connection.installation_id).eq('company_guid',link.company_guid).eq('financial_year',link.financial_year).eq('invoice_key',invoiceKey).eq('mode','pipeline').not('status','in','(settled,finished,stopped)').limit(1));if(unfinished?.length)throw new Error('A reminder schedule already exists.');}
            const id=/^[0-9a-f-]{36}$/i.test(String(x.item.requestId||''))?String(x.item.requestId):randomUUID();
            const inserted=checked(await db.from('invoice_followup_pipelines').insert({id,organization_id:access.organizationId,company_id:link.company_id,connection_id:connection.id,installation_id:connection.installation_id,session_generation:connection.session_generation,company_guid:link.company_guid,company_name:link.company_name,financial_year:link.financial_year,customer:x.customer,invoice:x.invoice,invoice_date:x.invoiceDate,invoice_key:invoiceKey,recipient:x.recipient,plan_name:plan.name,stages:plan.stages,next_due_at:new Date(Date.now()+stageMs(plan.stages[0],'delay')).toISOString(),created_by:access.member.user_id,mode:once?'once':'pipeline',outstanding:outcome.outstanding,verified_at:new Date().toISOString(),verification_expires_at:new Date(Date.now()+REMINDER_CHECK_MS).toISOString()}).select('*').single()) as Pipeline;
            if(x.item.savePhoneToTally===true){const queued=await db.rpc('followup_queue_phone',{p_actor:access.member.user_id,p_org:access.organizationId,p_id:inserted.id});if(!queued.error)await wakeTallyConnector(connection.id).catch(()=>{});}
            if(!once){results.push({key:keyOf(x.item),status:'enrolled',row:inserted});continue;}
            const claim=checked(await db.rpc('followup_claim_send',{p_id:inserted.id,p_revision:inserted.revision,p_actor:access.member.user_id,p_org:access.organizationId,p_company:link.company_id,p_installation:connection.installation_id,p_generation:connection.session_generation}));
            let sendStatus='uncertain',provider:string|null=null,sendError:string|null=null;try{provider=await submitReminder(plan.stages[0].template,inserted,x.recipient);sendStatus='accepted';}catch(reason){sendStatus=reason instanceof WhatsappRejectedError?'rejected':'uncertain';sendError=reason instanceof Error?reason.message:'Submission needs verification.';}
            const next=sendStatus==='accepted'?advanceReminder(plan.stages,0,0):null;checked(await db.rpc('followup_finish_send',{p_id:inserted.id,p_attempt:claim.attempt_id,p_status:sendStatus,p_provider:provider,p_error:sendError,p_next:next}));results.push({key:keyOf(x.item),status:sendStatus,message:sendError||undefined});
          }catch(error){results.push({key:keyOf(x.item),status:'skipped',message:error instanceof Error?error.message:'Could not process invoice.'});}
        }
        return jsonWithCors(request,{results});
      }
      const ids=items.map(item=>String(item.id||'')).filter(id=>/^[0-9a-f-]{36}$/i.test(id));if(ids.length!==items.length)throw new AccessError('Every selected schedule must have a valid identifier.',400);
      const rows=checked(await db.from('invoice_followup_pipelines').select('*').eq('organization_id',access.organizationId).eq('company_id',link.company_id).eq('installation_id',connection.installation_id).eq('company_guid',link.company_guid).eq('financial_year',link.financial_year).in('id',ids).limit(100)) as Pipeline[];
      const rowById=new Map(rows.map(row=>[row.id,row]));
      let evidence:Record<string,unknown>|null=null;if(action==='bulk_check'||action==='bulk_send')evidence=await readReminderBills(request,{connectionId:connection.id,companyName:link.company_name,financialYear:link.financial_year,organizationId:access.organizationId},[...new Set(rows.map(row=>row.customer))]);
      for(const item of items){const row=rowById.get(String(item.id));try{if(!row)throw new Error('Schedule was not found.');if(row.revision!==Number(item.revision))throw new Error('Schedule changed. Refresh and retry.');
        if(action==='bulk_pause'||action==='bulk_resume'||action==='bulk_stop'){const target=action==='bulk_pause'?'paused':action==='bulk_resume'?'active':'stopped';if(action==='bulk_pause'&&row.status!=='active')throw new Error('Only active schedules can be paused.');if(action==='bulk_resume'&&row.status!=='paused')throw new Error('Only paused schedules can be resumed.');if(action==='bulk_stop'&&!['active','paused','review'].includes(row.status))throw new Error('Schedule cannot be stopped in its current state.');const updated=checked(await db.from('invoice_followup_pipelines').update({status:target,revision:row.revision+1,updated_at:new Date().toISOString(),verification_expires_at:null,...(target==='active'?{next_due_at:new Date().toISOString()}:{})}).eq('id',row.id).eq('revision',row.revision).select('*').maybeSingle());if(!updated)throw new Error('Schedule changed. Refresh and retry.');results.push({key:keyOf(item),status:target,row:updated});continue;}
        if(action==='bulk_plan'){if(!['active','paused','review'].includes(row.status))throw new Error('The reminder sequence cannot be changed in its current state.');const plan=validateReminderPlan(item.plan||body.plan);if(plan.stages.some(s=>!reminderMessages().some(m=>m.key===s.template)))throw new Error('The selected reminder sequence is invalid.');const updated=checked(await db.from('invoice_followup_pipelines').update({plan_name:plan.name,stages:plan.stages,stage_index:0,stage_sent:0,next_due_at:new Date(Date.now()+stageMs(plan.stages[0],'delay')).toISOString(),revision:row.revision+1,updated_at:new Date().toISOString(),verification_expires_at:null}).eq('id',row.id).eq('revision',row.revision).select('*').maybeSingle());if(!updated)throw new Error('Schedule changed. Refresh and retry.');results.push({key:keyOf(item),status:'updated',row:updated});continue;}
        if(['sending','uncertain'].includes(row.status))throw new Error('The previous submission needs provider verification before another action.');
        if(!['active','review','paused'].includes(row.status))throw new Error('Schedule cannot be checked in its current state.');
        const byLedger=evidence?.byLedger as Record<string,{openBills?:Parameters<typeof verificationOutcome>[0]}>|undefined;const bills=byLedger?.[row.customer]?.openBills;if(evidence?.complete===false||!Array.isArray(bills))throw new Error('Tally did not return complete invoice evidence.');const outcome=verificationOutcome(bills,row.invoice,row.invoice_date,evidence?.settlementEvidence as Parameters<typeof verificationOutcome>[3],row.customer);
        const updated=checked(await db.from('invoice_followup_pipelines').update({outstanding:outcome.outstanding,status:row.status==='paused'&&outcome.status==='active'?'paused':outcome.status,note:outcome.note,verified_at:new Date().toISOString(),verification_expires_at:outcome.status==='active'?new Date(Date.now()+REMINDER_CHECK_MS).toISOString():null,...(outcome.status==='settled'?{next_due_at:null}:{}),revision:row.revision+1,updated_at:new Date().toISOString()}).eq('id',row.id).eq('revision',row.revision).select('*').maybeSingle()) as Pipeline|null;if(!updated)throw new Error('Schedule changed. Refresh and retry.');
        if(action==='bulk_check'){results.push({key:keyOf(item),status:outcome.status,row:updated});continue;}if(row.status!=='active')throw new Error('Only active schedules can send due reminders.');if(outcome.status!=='active')throw new Error('Invoice is settled or needs review.');if(!updated.next_due_at||Date.parse(updated.next_due_at)>Date.now())throw new Error('Reminder is not due yet.');const claim=checked(await db.rpc('followup_claim_send',{p_id:updated.id,p_revision:updated.revision,p_actor:access.member.user_id,p_org:access.organizationId,p_company:link.company_id,p_installation:connection.installation_id,p_generation:connection.session_generation}));let sendStatus='uncertain',provider:string|null=null,sendError:string|null=null;try{provider=await submitReminder(updated.stages[updated.stage_index].template,updated,updated.recipient);sendStatus='accepted';}catch(reason){sendStatus=reason instanceof WhatsappRejectedError?'rejected':'uncertain';sendError=reason instanceof Error?reason.message:'Submission needs verification.';}const next=sendStatus==='accepted'?advanceReminder(updated.stages,updated.stage_index,updated.stage_sent):null;checked(await db.rpc('followup_finish_send',{p_id:updated.id,p_attempt:claim.attempt_id,p_status:sendStatus,p_provider:provider,p_error:sendError,p_next:next}));results.push({key:keyOf(item),status:sendStatus,message:sendError||undefined});
      }catch(error){results.push({key:keyOf(item),status:'skipped',message:error instanceof Error?error.message:'Could not process schedule.'});}}
      return jsonWithCors(request,{results});
    }
    if(action==='statuses') {
      type InvoiceSelection = { customer: string; invoice: string; date: string };
      if(!Array.isArray(body.invoices)||body.invoices.length>200||body.invoices.some((value:unknown)=>{
        const x=value as Partial<InvoiceSelection>|null;
        return !x||['customer','invoice','date'].some(k=>typeof x[k as keyof InvoiceSelection]!=='string'||String(x[k as keyof InvoiceSelection]).length>500);
      }))throw new AccessError('Invalid invoice selection.',400);
      const keys=(body.invoices as InvoiceSelection[]).map((x)=>createHash('sha256').update(JSON.stringify([x.customer.trim(),x.invoice.trim(),x.date])).digest('hex'));
      if(!keys.length)return jsonWithCors(request,{rows:[]});
      const rows=checked(await db.from('invoice_followup_pipelines').select('id,customer,invoice,invoice_date,status,next_due_at,created_at')
        .eq('organization_id',access.organizationId).eq('company_id',link.company_id).eq('installation_id',connection.installation_id).eq('company_guid',link.company_guid).eq('financial_year',link.financial_year)
        .eq('mode','pipeline').in('invoice_key',keys).order('created_at',{ascending:false}).order('id').limit(1000));
      if(!rows||rows.length===1000)throw new AccessError('Schedule history could not be verified completely.',409);
      return jsonWithCors(request,{rows},{headers:{'Cache-Control':'private, no-store'}});
    }
    if(action==='save_template') {
      const plan=validateReminderPlan(body.plan);
      if(plan.stages.some(s=>!reminderMessages().some(m=>m.key===s.template)))throw new AccessError('Choose a configured reminder message for every stage.',400);
      const template=checked(await db.from('followup_pipeline_templates').insert({organization_id:access.organizationId,name:plan.name,stages:plan.stages,created_by:access.member.user_id}).select('*').single());
      return jsonWithCors(request,{template});
    }
    if(action==='enroll'||action==='send_once') {
      const defaults=(await reminderDefaults(access.organizationId)).value;
      if(!defaults)throw new AccessError('Set up Payment reminders in Settings first.',409);
      const once=action==='send_once';
      if(once&&(!process.env.MSG91_AUTHKEY||!process.env.MSG91_WHATSAPP_NUMBER))throw new AccessError('Configure the WhatsApp sender before sending.',409);
      const plan=validateReminderPlan(once?{name:'One-time reminder',stages:[{name:'One-time reminder',template:defaults.onceTemplate,delay:0,every:1,unit:'days',limit:1}]}:defaults.plan);
      if(plan.stages.some(s=>!reminderMessages().some(m=>m.key===s.template)))throw new AccessError('Choose a configured reminder message.',400);
      const recipient=phone(body.recipient);
      const customer=String(body.customer||'').trim(),invoice=String(body.invoice||'').trim(),invoiceDate=String(body.invoiceDate||'');
      if(!customer||customer.length>500||!invoice||invoice.length>500||!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)||!Number.isFinite(Date.parse(invoiceDate)))throw new AccessError('A customer, invoice reference and valid invoice date are required.',400);
      if(!/^[0-9a-f-]{36}$/i.test(body.requestId||''))throw new AccessError('A unique request identifier is required.',400);
      // Fresh evidence before either enrolling or sending. Never trust the browser balance.
      const evidence=await readReminderBills(request,{connectionId:connection.id,companyName:link.company_name,financialYear:link.financial_year,organizationId:access.organizationId},customer);
      const bills=(evidence.byLedger as Record<string,{openBills?:Parameters<typeof verificationOutcome>[0]}>)?.[customer]?.openBills;
      if(evidence.complete===false||!Array.isArray(bills))throw new AccessError('Tally verification is incomplete. Nothing was sent.',409);
      const outcome=verificationOutcome(bills,invoice,invoiceDate);
      if(outcome.status!=='active')throw new AccessError('Invoice is settled or needs review in Tally. Nothing was sent.',409);
      const invoiceKey=createHash('sha256').update(JSON.stringify([customer,invoice,invoiceDate])).digest('hex');
      const record={organization_id:access.organizationId,company_id:link.company_id,connection_id:connection.id,installation_id:connection.installation_id,session_generation:connection.session_generation,company_guid:link.company_guid,company_name:link.company_name,financial_year:link.financial_year,
        customer,invoice,invoice_date:invoiceDate,invoice_key:invoiceKey,recipient,plan_name:plan.name,stages:plan.stages,next_due_at:new Date(Date.now()+stageMs(plan.stages[0],'delay')).toISOString(),created_by:access.member.user_id};
      if(!once) {
        const unfinished=checked(await db.from('invoice_followup_pipelines').select('id').eq('organization_id',access.organizationId)
          .eq('company_id',link.company_id).eq('installation_id',connection.installation_id).eq('company_guid',link.company_guid)
          .eq('financial_year',link.financial_year).eq('invoice_key',invoiceKey).eq('mode','pipeline')
          .not('status','in','(settled,finished,stopped)').limit(1));
        if(unfinished?.length)throw new AccessError('This invoice already has a reminder schedule. Check reminder tracking before retrying.',409);
      }
      const result=await db.from('invoice_followup_pipelines').insert({...record,id:body.requestId,mode:once?'once':'pipeline',outstanding:outcome.outstanding,verified_at:new Date().toISOString(),verification_expires_at:new Date(Date.now()+REMINDER_CHECK_MS).toISOString()}).select('*').single();
      if(result.error?.code==='23505')throw new AccessError('This request was already recorded or the invoice already has a schedule. Check reminder tracking before retrying.',409);
      const inserted=checked(result);
      body.id=inserted.id;body.revision=inserted.revision;
      if(!once){
        let phoneNotice=null;
        if(body.savePhoneToTally===true){const queued=await db.rpc('followup_queue_phone',{p_actor:access.member.user_id,p_org:access.organizationId,p_id:inserted.id});phoneNotice=queued.error?'Reminders started, but the number could not be queued for Tally.':'Number queued for Tally; not yet confirmed saved.';if(!queued.error)await wakeTallyConnector(connection.id).catch(()=>{});}
        return jsonWithCors(request,{row:inserted,phoneNotice});
      }
      action='send';
    }
    const row=checked(await db.from('invoice_followup_pipelines').select('*').eq('id',body.id).eq('organization_id',access.organizationId).eq('company_id',link.company_id).eq('installation_id',connection.installation_id).eq('company_guid',link.company_guid).eq('financial_year',link.financial_year).maybeSingle()) as Pipeline|null;
    if(!row)throw new AccessError('Invoice pipeline not found.',404);
    if(action==='history')return jsonWithCors(request,{attempts:checked(await db.from('invoice_followup_attempts').select('id,status,created_at,finished_at,provider_reference,error').eq('pipeline_id',row.id).order('created_at',{ascending:false}).limit(100))});
    if(row.revision!==body.revision)throw new AccessError('This pipeline changed. Refresh before continuing.',409);
    if(['sending','uncertain'].includes(row.status))throw new AccessError('The last submission needs provider verification before this pipeline can change.',409);
    if(['preview','send'].includes(action)&&(row.connection_id!==connection.id||row.session_generation!==connection.session_generation))throw new AccessError('Tally was reconnected. Check outstanding before sending again.',409);
    const save=async(patch:Record<string,unknown>)=>{
      const updated=checked(await db.from('invoice_followup_pipelines').update({...patch,revision:row.revision+1,updated_at:new Date().toISOString()}).eq('id',row.id).eq('revision',row.revision).select('*').maybeSingle());
      if(!updated)throw new AccessError('Another operation changed this pipeline. Refresh.',409);
      return jsonWithCors(request,{row:updated});
    };
    if(action==='pause'||action==='stop'||action==='resume') {
      if(['finished','settled','stopped'].includes(row.status))throw new AccessError('This pipeline has ended. Start a new one if needed.',409);
      if(action==='resume'&&row.status!=='paused')throw new AccessError('Only a paused pipeline can be resumed. Check outstanding for review items.',409);
      return save({status:action==='pause'?'paused':action==='stop'?'stopped':'active',verification_expires_at:null,...(action==='resume'?{next_due_at:new Date().toISOString()}:{} )});
    }
    if(action==='check') {
      if(!['active','review','paused'].includes(row.status))throw new AccessError('This pipeline cannot be checked in its current state.',409);
      const result=await readReminderBills(request,{connectionId:connection.id,companyName:link.company_name,financialYear:link.financial_year,organizationId:access.organizationId},row.customer,{invoice:row.invoice,invoiceDate:row.invoice_date});
      const byLedger=result.byLedger as Record<string,{openBills?:Parameters<typeof verificationOutcome>[0]}>|undefined;
      if(result.complete===false||!byLedger||!Array.isArray(byLedger[row.customer]?.openBills))throw new AccessError('Tally did not return complete invoice evidence.',409);
      const outcome=verificationOutcome(byLedger[row.customer].openBills!,row.invoice,row.invoice_date,result.settlementEvidence as Parameters<typeof verificationOutcome>[3],row.customer);
      return save({outstanding:outcome.outstanding,status:row.status==='paused'&&outcome.status==='active'?'paused':outcome.status,note:outcome.note,...(outcome.status==='settled'?{next_due_at:null}:{}),verified_at:new Date().toISOString(),verification_expires_at:outcome.status==='active'?new Date(Date.now()+REMINDER_CHECK_MS).toISOString():null,connection_id:connection.id,installation_id:connection.installation_id,session_generation:connection.session_generation});
    }
    if(action==='preview') {
      return jsonWithCors(request,{text:reminderPreview(row.stages[row.stage_index].template,row),recipient:row.recipient,outstanding:row.outstanding});
    }
    if(action==='send') {
      reminderPreview(row.stages[row.stage_index].template,row);
      if(!process.env.MSG91_AUTHKEY||!process.env.MSG91_WHATSAPP_NUMBER)throw new AccessError('Configure the WhatsApp sender before sending.',409);
      const claim=checked(await db.rpc('followup_claim_send',{p_id:row.id,p_revision:row.revision,p_actor:access.member.user_id,p_org:access.organizationId,p_company:link.company_id,p_installation:connection.installation_id,p_generation:connection.session_generation}));
      if(!claim?.attempt_id)throw new AccessError('Check outstanding again before sending. The invoice may have changed or reached its limit.',409);
      let status='uncertain',provider:string|null=null,error:string|null=null;
      try {provider=await submitReminder(row.stages[row.stage_index].template,row,row.recipient);status='accepted';}
      catch(reason){status=reason instanceof WhatsappRejectedError?'rejected':'uncertain';error=reason instanceof Error?reason.message:'Submission needs verification.';}
      const next=status==='accepted'?advanceReminder(row.stages,row.stage_index,row.stage_sent):null;
      checked(await db.rpc('followup_finish_send',{p_id:row.id,p_attempt:claim.attempt_id,p_status:status,p_provider:provider,p_error:error,p_next:next}));
      let phoneNotice=null;
      if(status==='accepted'&&body.savePhoneToTally===true){const queued=await db.rpc('followup_queue_phone',{p_actor:access.member.user_id,p_org:access.organizationId,p_id:row.id});phoneNotice=queued.error?'Message submitted, but the number could not be queued for Tally.':'Number queued for Tally; not yet confirmed saved.';if(!queued.error)await wakeTallyConnector(connection.id).catch(()=>{});}
      // Where the schedule stands now, so the page can say what happens next.
      const after=await db.from('invoice_followup_pipelines').select('status,next_due_at').eq('id',row.id).maybeSingle();
      return jsonWithCors(request,{status,error,phoneNotice,submittedAt:new Date().toISOString(),
        scheduleStatus:after.data?.status??null,nextDueAt:after.data?.next_due_at??null});
    }
    throw new AccessError('Unknown pipeline action.',400);
  }catch(error){return failure(request,error);}
}
export const GET=withTeamAccess(GETHandler);
export const POST=withTeamAccess(POSTHandler);

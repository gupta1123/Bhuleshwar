import {WhatsappRejectedError} from '@/lib/msg91/whatsapp';

type Message = {key:string;name:string;language:string;namespace:string;text:string;components:Record<string,string>};
const fields=['customer','company','invoice','invoice_date','outstanding'];

// This is an approved MSG91 template owned by the Kalika account. Keeping the
// safe metadata here means a fresh install can use the reminder flow before an
// environment-specific template registry has been configured. Deployments can
// still add/override templates through FOLLOWUP_WHATSAPP_TEMPLATES_JSON.
const BUILTIN_MESSAGES:Message[]=[{
  key:'payment_reminder_v2',
  name:'payment_reminder_v2',
  language:'en',
  namespace:'2bf6cec8_61b1_4925_8632_49e9ddebff44',
  text:'Hello {{customer}},\n\nThis is a payment reminder for ₹{{outstanding}} pending against invoice {{invoice}} dated {{invoice_date}}.\n\nPlease arrange payment at your earliest convenience. If payment has already been made, please ignore this message.\n\nRegards,\n{{company}} Accounts Team',
  components:{body_1:'customer',body_2:'outstanding',body_3:'invoice',body_4:'invoice_date',body_5:'company'},
}];
export function reminderMessages():Message[] {
  const raw=JSON.parse(process.env.FOLLOWUP_WHATSAPP_TEMPLATES_JSON||'[]');
  if (!Array.isArray(raw)) throw new Error('Follow-up messages are not configured correctly.');
  const configured=raw.filter((m:Message)=>m&&typeof m.key==='string'&&typeof m.name==='string'&&typeof m.language==='string'&&typeof m.namespace==='string'&&typeof m.text==='string'&&m.components&&Object.values(m.components).every(x=>fields.includes(x)));
  const byKey=new Map(BUILTIN_MESSAGES.map(m=>[m.key,m]));
  for(const message of configured)byKey.set(message.key,message);
  return [...byKey.values()];
}
export function reminderMessageValues(row:{customer:string;company_name:string;invoice:string;invoice_date?:string;outstanding:number}) {
  const invoiceDate=row.invoice_date?new Intl.DateTimeFormat('en-IN',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(`${row.invoice_date}T00:00:00`)):'';
  return {customer:row.customer,company:row.company_name,invoice:row.invoice,invoice_date:invoiceDate,outstanding:new Intl.NumberFormat('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(row.outstanding)};
}
export function reminderPreview(key:string,row:Parameters<typeof reminderMessageValues>[0]) {
  const message=reminderMessages().find(m=>m.key===key);
  if(!message)throw new Error('Select a configured WhatsApp reminder template.');
  const values=reminderMessageValues(row);
  return message.text.replace(/\{\{(customer|company|invoice|invoice_date|outstanding)\}\}/g,(_,field:keyof typeof values)=>values[field]);
}
export async function submitReminder(key:string,row:Parameters<typeof reminderMessageValues>[0],phone:string) {
  const message=reminderMessages().find(m=>m.key===key);
  if(!message||!process.env.MSG91_AUTHKEY||!process.env.MSG91_WHATSAPP_NUMBER)throw new WhatsappRejectedError('Configure a WhatsApp sender and approved reminder template first.');
  const values=reminderMessageValues(row);
  const response=await fetch('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/',{
    method:'POST',headers:{authkey:process.env.MSG91_AUTHKEY,'content-type':'application/json'},signal:AbortSignal.timeout(20_000),
    body:JSON.stringify({integrated_number:process.env.MSG91_WHATSAPP_NUMBER,content_type:'template',payload:{messaging_product:'whatsapp',type:'template',template:{name:message.name,namespace:message.namespace,language:{code:message.language,policy:'deterministic'},to_and_components:[{to:[phone],components:Object.fromEntries(Object.entries(message.components).map(([key,field])=>[key,{type:'text',value:values[field as keyof typeof values]}]))}]}}}),
  });
  const payload=await response.json().catch(()=>null);
  if([400,401,403,404,422].includes(response.status))throw new WhatsappRejectedError('WhatsApp rejected the template or recipient. Check configuration before retrying.');
  if(!response.ok||!payload||payload.hasError||!['success','accepted'].includes(String(payload.type||payload.status||'').toLowerCase()))throw new Error('Provider acknowledgement is uncertain. Verify it before resending.');
  return String(payload.request_id||payload.requestId||payload.message_id||'accepted').slice(0,200);
}

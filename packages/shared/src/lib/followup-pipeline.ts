export type ReminderStage = { name: string; template: string; delay: number; every: number; unit: 'minutes'|'hours'|'days'; limit: number };
export type ReminderPlan = { name: string; stages: ReminderStage[] };
export const REMINDER_CHECK_MS = 5 * 60_000;
export function stageMs(stage: ReminderStage, field: 'delay'|'every') {
  return stage[field] * ({ minutes:60_000, hours:3_600_000, days:86_400_000 }[stage.unit]);
}
export function validateReminderPlan(value: unknown): ReminderPlan {
  const plan = value as ReminderPlan;
  if (!plan || typeof plan.name !== 'string' || !plan.name.trim() || plan.name.length > 80 || !Array.isArray(plan.stages) || !plan.stages.length || plan.stages.length > 8) throw new Error('Enter a name and between 1 and 8 stages.');
  for (const stage of plan.stages) {
    if (!stage || typeof stage.name !== 'string' || !stage.name.trim() || stage.name.length > 80 || typeof stage.template !== 'string' || !stage.template || stage.template.length > 120 || !['minutes','hours','days'].includes(stage.unit) || !Number.isInteger(stage.delay) || stage.delay < 0 || stage.delay > 365 || !Number.isInteger(stage.every) || stage.every < 1 || stage.every > 365 || !Number.isInteger(stage.limit) || stage.limit < 1 || stage.limit > 100) throw new Error('Each stage needs a message, a valid interval, and a limit of 1–100 reminders.');
  }
  return {name:plan.name.trim(), stages:plan.stages.map(s=>({name:s.name.trim(),template:s.template,delay:s.delay,every:s.every,unit:s.unit,limit:s.limit}))};
}
export function advanceReminder(stages:ReminderStage[], index:number, sent:number, now=Date.now()) {
  const stage=stages[index];
  if (!stage) throw new Error('Invalid pipeline stage.');
  if (sent+1 < stage.limit) return { stage_index:index, stage_sent:sent+1, status:'active', next_due_at:new Date(now+stageMs(stage,'every')).toISOString() };
  if (index+1 < stages.length) return { stage_index:index+1, stage_sent:0, status:'active', next_due_at:new Date(now+stageMs(stages[index+1],'delay')).toISOString() };
  return { stage_index:index, stage_sent:sent+1, status:'finished', next_due_at:null };
}
export function verificationOutcome(bills:Array<{referenceName?:string;voucherNumber?:string;invoiceDate?:string;pendingAmount?:number;originalAmount?:number}>, invoice:string, date:string, proof?:{verified?:boolean;ledgerName?:string;invoice?:string;invoiceDate?:string;originalAmount?:number;allocatedAmount?:number}|null, ledger?:string) {
  const matches=bills.filter(b=>(b.referenceName===invoice||b.voucherNumber===invoice)&&b.invoiceDate===date);
  if(matches.length===0&&ledger&&proof?.verified===true&&proof.ledgerName===ledger&&proof.invoice===invoice&&proof.invoiceDate===date&&Number.isFinite(proof.originalAmount)&&proof.originalAmount!>0&&proof.allocatedAmount===proof.originalAmount) return {status:'settled',outstanding:0,note:'Invoice settled. Linked Tally allocations verified. No further reminders will be sent.'};
  // Absence can also mean cancellation, renaming or an adjustment. Stop
  // reminders for review rather than claiming a payment that was not observed.
  if (matches.length!==1) return {status:'review', outstanding:null, note:matches.length ? 'Multiple matching bills. Review in Tally.' : 'No matching open bill. Check whether it was settled, adjusted or changed.'};
  const amount=matches[0].pendingAmount;
  if (typeof amount!=='number'||!Number.isFinite(amount)||amount<0) throw new Error('Tally returned an invalid outstanding amount.');
  return {status:amount<=0.005?'settled':'active',outstanding:Math.round(amount*100)/100,note:amount<=0.005?'Invoice settled. No further reminders will be sent.':typeof matches[0].originalAmount==='number'&&matches[0].originalAmount!>amount+0.005?'Part payment recorded. Reminders continue for the remaining balance.':null};
}

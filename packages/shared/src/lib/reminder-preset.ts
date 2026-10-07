import type {ReminderPlan} from './followup-pipeline';
export function standardReminderPlan(template='payment_reminder_v2'):ReminderPlan {
 return {name:'Standard payment reminders',stages:[
  {name:'First reminder',template,unit:'days',delay:0,every:1,limit:1},
  {name:'Regular follow-up',template,unit:'days',delay:2,every:2,limit:3},
  {name:'Final reminders',template,unit:'days',delay:1,every:1,limit:3},
 ]};
}

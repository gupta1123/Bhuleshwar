import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import {AccessError} from '@/lib/access/server';
import {standardReminderPlan} from '@autodealer/shared/lib/reminder-preset';
export const REMINDER_SETTING='payment-reminders';
export const DEFAULT_REMINDER_SETTING={plan:standardReminderPlan('payment_reminder_v2'),onceTemplate:'payment_reminder_v2'};
export async function reminderDefaults(org:string) {
 const {data,error}=await createSupabaseAdminClient().from('access_organization_settings').select('value,revision').eq('organization_id',org).eq('setting_key',REMINDER_SETTING).maybeSingle();
 if(error)throw new AccessError('Reminder settings are unavailable.',503);
 // A missing row is a normal first-run state. Use the approved built-in
 // template until an administrator saves an organization-specific plan.
 return data||{value:DEFAULT_REMINDER_SETTING,revision:0};
}

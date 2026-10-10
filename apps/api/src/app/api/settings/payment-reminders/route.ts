import {requirePermission,AccessError} from '@/lib/access/server';
import {withTeamAccess} from '@/lib/access/route-boundary';
import {jsonWithCors,optionsWithCors} from '@/lib/api/cors';
import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import {reminderDefaults,REMINDER_SETTING} from '@/lib/followups/defaults';
import {reminderMessages} from '@/lib/followups/messages';
import {validateReminderPlan} from '@autodealer/shared/lib/followup-pipeline';
export const OPTIONS=optionsWithCors;
async function handle(request:Request) {
 try {
  const access=await requirePermission(request,'settings.manage');
  const messages=reminderMessages();
  if(request.method==='GET')return jsonWithCors(request,{...await reminderDefaults(access.organizationId),messages:messages.map(m=>({key:m.key,text:m.text}))},{headers:{'Cache-Control':'private, no-store'}});
  const body=await request.json();const plan=validateReminderPlan(body.plan);
  if(!Number.isSafeInteger(body.revision)||body.revision<0||![body.onceTemplate,...plan.stages.map(s=>s.template)].every(k=>messages.some(m=>m.key===k)))throw new AccessError('Choose approved templates and reload the current settings.',400);
  const result=await createSupabaseAdminClient().rpc('access_save_setting',{p_actor:access.member.user_id,p_org:access.organizationId,p_key:REMINDER_SETTING,p_revision:body.revision,p_value:{plan,onceTemplate:body.onceTemplate}});
  if(result.error)throw new AccessError('Settings changed or could not be saved. Reload and try again.',409);
  return jsonWithCors(request,result.data);
 }catch(e){return jsonWithCors(request,{error:e instanceof Error?e.message:'Settings unavailable'},{status:e instanceof AccessError?e.status:400});}
}
export const GET=withTeamAccess(handle);export const POST=withTeamAccess(handle);

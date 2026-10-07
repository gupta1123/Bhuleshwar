import {canAccess} from '@autodealer/shared/lib/access';
import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import type {TallyBridgeCommandRow} from '@/lib/tally/commands';
import {AccessError,requireAccessContext} from './server';

const visibilityPermissions=['purchases.view','bank.view','discounts.view','followups.view',
 'purchases.export','bank.export','discounts.export','followups.export','connections.manage'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Scope in SQL before LIMIT. A connection administrator does not inherit
 * financial result access. The backend-only view requires a matching receipt,
 * current pairing and verified GUID/year; legacy unclassified results stay out. */
export async function readTeamCommands(request:Request,connectionId:string,ids:string[]=[],limit=20):Promise<TallyBridgeCommandRow[]> {
 if(!uuid.test(connectionId)||ids.length>100||ids.some(id=>!uuid.test(id)))throw new AccessError('Invalid command selection.',400);
 const access=await requireAccessContext(request);
 const clauses=access.companies.flatMap(company=>visibilityPermissions.filter(p=>canAccess(access,p,company.id))
  .map(permission=>`and(access_company_id.eq.${JSON.stringify(company.id)},visibility_permission.eq.${JSON.stringify(permission)})`));
 if(!clauses.length)return [];
 if(clauses.length>900)throw new AccessError('Command access scope exceeds the supported limit.',503);
 let query=createSupabaseAdminClient().from('access_visible_commands').select('*')
  .eq('organization_id',access.organizationId).eq('connection_id',connectionId).or(clauses.join(','))
  .order('created_at',{ascending:false}).order('id',{ascending:false}).limit(Math.min(200,Math.max(1,Math.trunc(limit)||20)));
 if(ids.length)query=query.in('id',ids);
 const {data,error}=await query;
 if(error)throw new AccessError('Command status is unavailable. Check the access migration setup.',503);
 return (data||[]) as unknown as TallyBridgeCommandRow[];
}

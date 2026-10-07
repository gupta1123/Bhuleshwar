import {canAccess} from '@autodealer/shared/lib/access';
import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import {TALLY_CONNECTION_SELECT,type TallyConnectionRow} from '@/lib/tally/connections';
import {AccessError,requireAccessContext} from './server';
import {CONNECTION_STATUS_PERMISSIONS} from './route-policy';

const lookups=new WeakMap<Request,Map<string,ReturnType<typeof loadConnections>>>();
export function permittedConnections(request:Request,connectionId?:string) {
  let entries=lookups.get(request);if(!entries){entries=new Map();lookups.set(request,entries);}
  const key=connectionId||'*';let result=entries.get(key);
  if(!result){result=loadConnections(request,connectionId);entries.set(key,result);}return result;
}
async function loadConnections(request:Request,connectionId?:string) {
  const access=await requireAccessContext(request);
  const db=createSupabaseAdminClient();
  let query=db.from('access_company_links').select('connection_id,installation_id,company_id,company_guid,financial_year')
    .eq('organization_id',access.organizationId);
  if(connectionId)query=query.eq('connection_id',connectionId);
  if(!access.member.all_companies)query=query.in('company_id',access.member.company_ids.length?access.member.company_ids:['00000000-0000-0000-0000-000000000000']);
  const mapped=await query.limit(1000);
  if(mapped.error||(mapped.data?.length||0)>=1000)throw new AccessError('Company routing could not be completely verified.',503);
  const companyNames=new Map(access.companies.map(c=>[c.id,c.name]));
  const links=(mapped.data||[]).filter(link=>companyNames.has(link.company_id)&&CONNECTION_STATUS_PERMISSIONS.some(p=>canAccess(access,p,link.company_id)))
    .map(link=>({...link,company_name:companyNames.get(link.company_id)!}));
  const ids=[...new Set(links.map(link=>link.connection_id))];
  if(!ids.length)return {access,links,rows:[] as TallyConnectionRow[]};
  const result=await db.from('tally_connections').select(TALLY_CONNECTION_SELECT).in('id',ids).is('revoked_at',null);
  if(result.error)throw new AccessError('Connection status is unavailable.',503);
  const rows=(result.data||[]) as unknown as TallyConnectionRow[];
  const currentLinks=links.filter(link=>rows.some(row=>row.id===link.connection_id&&row.installation_id===link.installation_id));
  return {access,links:currentLinks,rows:rows.filter(row=>currentLinks.some(link=>link.connection_id===row.id)).map(row=>{
    const knownCompany=currentLinks.some(link=>link.connection_id===row.id&&link.company_name===row.last_company_name);
    // Raw status/errors may describe another company on the same machine.
    return {...row,last_company_name:knownCompany?row.last_company_name:null,last_company_loaded:knownCompany&&row.last_company_loaded,
      last_error:null,agent_status:{}};
  })};
}

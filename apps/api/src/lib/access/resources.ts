import { canAccess } from '@autodealer/shared/lib/access';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AccessError, requireAccessContext } from './server';
import {permittedConnections} from './connection-scope';

export type AccessResourceType = 'case' | 'bank_import' | 'bank_account' | 'proposal' | 'connection';
export type ResourceScope = { organization_id: string; company_id: string | null; creator_user_id: string | null; source_revision: number };
const scopes = new WeakMap<Request,Map<string,Promise<ResourceScope|null>>>();

/** Resource identity comes from a reviewed database mapping, never from request company names. */
export async function requireResourceAccess(request: Request, type: AccessResourceType, id: string, permission: string) {
  const access = await requireAccessContext(request);
  if (!canAccess(access, permission)) throw new AccessError('You do not have permission for this action.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AccessError('Resource not found.', 404);
  const db = createSupabaseAdminClient();
  if(type==='connection') {
    const {links,rows}=await permittedConnections(request,id);
    const link=links.find(link=>canAccess(access,permission,link.company_id));
    if(!link||!rows.length)throw new AccessError('Connection not found or outside your company access.',404);
    if(permission==='connections.manage') {
      const all=await db.from('access_company_links').select('organization_id,company_id')
        .eq('connection_id',id).eq('installation_id',rows[0].installation_id).limit(1000);
      if(all.error||(all.data?.length||0)>=1000)throw new AccessError('Connection management scope is unavailable.',503);
      if((all.data||[]).some(entry=>entry.organization_id!==access.organizationId||
        !(access.member.all_companies||access.member.company_ids.includes(entry.company_id))))throw new AccessError('Managing this connection would affect companies outside your access.');
    }
    return {access,db,scope:{organization_id:access.organizationId,company_id:link.company_id,
      creator_user_id:rows[0].owner_user_id,source_revision:0} as ResourceScope};
  }
  let requestScopes=scopes.get(request);
  if(!requestScopes){requestScopes=new Map();scopes.set(request,requestScopes);}
  const key=`${access.organizationId}:${type}:${id}`;
  let pending=requestScopes.get(key);
  if(!pending){pending=(async()=>{
    const result = await db.from('access_resource_scopes').select('organization_id,company_id,creator_user_id,source_revision')
      .eq('resource_type', type).eq('resource_id', id).eq('organization_id', access.organizationId).maybeSingle();
    if(result.error)throw new AccessError('Resource authorization is unavailable.',503);
    return result.data as ResourceScope|null;
  })();requestScopes.set(key,pending);}
  const scope=await pending;
  if (!scope || !scope.company_id || !(access.member.all_companies||access.member.company_ids.includes(scope.company_id)) || !canAccess(access, permission, scope.company_id)) throw new AccessError('Resource not found or outside your company access.', 404);
  return { access, scope, db };
}

/** SQL-side indexed scope filter shared by lists, totals and search, without per-row reads. */
export async function scopedResourceIds(request: Request, type: AccessResourceType, permission: string, page = 1, pageSize = 50) {
  const access = await requireAccessContext(request);
  if (!canAccess(access, permission)) throw new AccessError('You do not have permission for this action.');
  const size = Math.min(100, Math.max(1, Math.trunc(pageSize)));
  const offset = (Math.max(1, Math.trunc(page)) - 1) * size;
  let query = createSupabaseAdminClient().from('access_resource_scopes').select('resource_id,company_id', { count: 'exact' })
    .eq('organization_id', access.organizationId).eq('resource_type', type).not('company_id', 'is', null);
  if (!access.member.all_companies) {
    if (!access.member.company_ids.length) return { resources: [], total: 0 };
    query = query.in('company_id', access.member.company_ids);
  }
  const result = await query.order('resource_id').range(offset, offset + size - 1).abortSignal(request.signal);
  if (result.error) throw new AccessError('Resource authorization is unavailable.', 503);
  return { resources: result.data || [], total: result.count || 0 };
}

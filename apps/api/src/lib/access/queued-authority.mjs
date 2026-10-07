/** Explicit service entry point: the worker secret authenticates the worker, not the initiating user's permission. */
export class QueuedAccessDenied extends Error { constructor(){super('The initiating user no longer has access to this work.');this.name='QueuedAccessDenied';} }
export async function assertQueuedResource(db,{actorId,resourceType,resourceId,permission},enabled=process.env.TEAM_ACCESS_ENFORCEMENT==='true'){
 if(!enabled)return null;
 if(!actorId||!resourceId)throw new QueuedAccessDenied();
 const scope=await db.from('access_resource_scopes').select('organization_id,company_id').eq('resource_type',resourceType).eq('resource_id',resourceId).maybeSingle();
 if(scope.error)throw Error('Queued authorization infrastructure is unavailable.');
 if(!scope.data?.company_id)throw new QueuedAccessDenied();
 const checked=await db.rpc('access_assert_permission',{p_actor:actorId,p_org:scope.data.organization_id,p_permission:permission,p_company:scope.data.company_id});
 if(checked.error){if(checked.error.code==='42501')throw new QueuedAccessDenied();throw Error('Queued authorization infrastructure is unavailable.');}
 return scope.data;
}

import { canAccess, type AccessSnapshot } from '@autodealer/shared/lib/access';
import { requireRequestUser } from '@/lib/api/request-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
export class AccessError extends Error { constructor(message:string, public status=403){super(message);} }
const contexts=new WeakMap<Request,Promise<AccessSnapshot>>();
export function requireAccessContext(request:Request):Promise<AccessSnapshot> {
  let pending=contexts.get(request);
  if(!pending){pending=resolve(request);contexts.set(request,pending);}
  return pending;
}
async function resolve(request:Request):Promise<AccessSnapshot> {
  const user=await requireRequestUser(request);
  if(!user) throw new AccessError('Please sign in.',401);
  if(user.id==='local-dev-user') throw new AccessError('Team access requires explicit test accounts; local authentication bypass is not supported.',503);
  const {data,error}=await createSupabaseAdminClient().rpc('access_snapshot',{p_user:user.id,p_org:request.headers.get('X-Kalika-Organization')||null});
  if(error){
    if(error.code==='42501') throw new AccessError('Your access is suspended or you are not a member of this organization.');
    throw new AccessError('Team access is not ready. Ask your administrator to check the database setup.',503);
  }
  if(data?.selectionRequired) throw new AccessError('Select an organization before continuing.',409);
  if(!data?.member||!data?.role) throw new AccessError('No active membership.');
  return data as AccessSnapshot;
}
export async function requirePermission(request:Request,permission:string,companyId?:string|null) {
  const context=await requireAccessContext(request);
  if(!canAccess(context,permission,companyId)) throw new AccessError(context.member.must_change_password?'Change your temporary password before continuing.':'You do not have permission for this action.');
  return context;
}

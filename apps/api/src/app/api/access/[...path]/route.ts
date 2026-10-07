import { type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { jsonWithCors, optionsWithCors } from '@/lib/api/cors';
import { requireRequestUser } from '@/lib/api/request-auth';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AccessError, requireAccessContext, requirePermission } from '@/lib/access/server';
import { canAccess, validatePermissions } from '@autodealer/shared/lib/access';
import { accessEventStream, publishAccessChange } from '@/lib/access/events';

export const dynamic='force-dynamic';
export function OPTIONS(request:Request){return optionsWithCors(request);}
function reply(request:Request,body:unknown,status=200){return jsonWithCors(request,body&&typeof body==='object'?{enforcementRequired:process.env.TEAM_ACCESS_ENFORCEMENT==='true',...body}:body,{status,headers:{'Cache-Control':'private, no-store'}});}
function failure(request:Request,error:unknown){return reply(request,{error:error instanceof AccessError?error.message:'Unable to complete this access request.'},error instanceof AccessError?error.status:500);}
function dbError(error:{code?:string}|null){if(error)throw new AccessError(error.code==='40001'?'This was changed by someone else. Reload and review it again.':error.code==='42501'?'You cannot make this access change.':error.code==='23505'?'That role name already exists.':'The change is not valid. Check dependencies, assigned members and owner protection.',error.code==='40001'?409:error.code==='42501'?403:400);}
export async function GET(request:NextRequest,ctx:{params:Promise<{path:string[]}>}){
 try{
  const path=(await ctx.params).path.join('/');const db=createSupabaseAdminClient();
  if(path==='me'){
   const user=await requireRequestUser(request);if(!user)return reply(request,{error:'Please sign in.'},401);
   if(user.id==='local-dev-user')return reply(request,{available:false,reason:'Explicit test accounts are required.'},503);
   const r=await db.rpc('access_snapshot',{p_user:user.id,p_org:request.headers.get('X-Kalika-Organization')||null});
   if(r.error)return reply(request,{available:false,error:r.error.code==='42501'?'No active membership.':'Team access database setup is not installed.'},r.error.code==='42501'?403:503);
   return reply(request,{available:true,...r.data});
  }
  const access=await requireAccessContext(request);const org=access.organizationId;
  if(path==='events'){
   if(access.member.must_change_password)throw new AccessError('Change your temporary password before continuing.');
   const response=reply(request,null);response.headers.set('Content-Type','text/event-stream');response.headers.set('X-Accel-Buffering','no');
   return new Response(accessEventStream(request,access.member.user_id,org),{headers:response.headers});
  }
  if(path==='roles'||/^roles\/[^/]+\/impact$/.test(path)){
   if(!canAccess(access,'roles.manage')&&!canAccess(access,'team.manage'))throw new AccessError('Team or role management access is required.');
   if(path!=='roles'){
    const id=path.split('/')[1];const r=await db.from('access_members').select('user_id,display_name',{count:'exact'}).eq('organization_id',org).eq('role_id',id).order('display_name').limit(20);dbError(r.error);
    return reply(request,{members:r.data,total:r.count,accessRevision:access.revision});
   }
   const r=await db.from('access_roles').select('*').eq('organization_id',org).order('name');dbError(r.error);return reply(request,{roles:r.data});
  }
  if(path==='team'){
   await requirePermission(request,'team.manage');
   const page=Math.max(1,Math.min(100000,Math.floor(Number(request.nextUrl.searchParams.get('page'))||1)));const size=20;
   const q=(request.nextUrl.searchParams.get('q')||'').trim().slice(0,100);
   let query=db.from('access_members').select('*',{count:'exact'}).eq('organization_id',org);
   if(q){const literal=q.replace(/[\\%_]/g,'\\$&').replace(/"/g,'\\"');query=query.or(`display_name.ilike."%${literal}%",email.ilike."%${literal}%"`);}
   const r=await query.order('display_name').order('user_id').range((page-1)*size,page*size-1).abortSignal(request.signal);dbError(r.error);
   return reply(request,{members:r.data,total:r.count,page,pageSize:size});
  }
  if(/^team\/[^/]+\/impact$/.test(path)){
   await requirePermission(request,'team.manage');
   const r=await db.rpc('access_member_work',{p_actor:access.member.user_id,p_org:org,p_member:path.split('/')[1]});dbError(r.error);
   return reply(request,{...r.data,accessRevision:access.revision});
  }
  return reply(request,{error:'Not found.'},404);
 }catch(e){return failure(request,e);}
}
export async function POST(request:NextRequest,ctx:{params:Promise<{path:string[]}>}){
 try{
  const path=(await ctx.params).path;const access=await requireAccessContext(request);
  const raw=await request.text();if(raw.length>20000)throw new AccessError('Request too large.',413);
  let body;try{body=JSON.parse(raw);}catch{throw new AccessError('Invalid request.',400);}
  if(!body||typeof body!=='object'||Array.isArray(body))throw new AccessError('Request must be an object.',400);
  if(path.join('/')==='password'){
   if(typeof body.currentPassword!=='string'||typeof body.newPassword!=='string'||body.newPassword.length<12||body.newPassword.length>256||body.newPassword===body.currentPassword)throw new AccessError('Use a different password with 12–256 characters.',400);
   const db=createSupabaseAdminClient();const u=await db.auth.admin.getUserById(access.member.user_id);
   if(u.error||!u.data.user?.email)throw new AccessError('Could not verify account.',401);
   const verifier=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
   const verified=await verifier.auth.signInWithPassword({email:u.data.user.email,password:body.currentPassword});
   if(verified.error||verified.data.user?.id!==access.member.user_id)throw new AccessError('Current password is incorrect.',403);
   await verifier.auth.signOut({scope:'local'});
   const changed=await db.auth.admin.updateUserById(access.member.user_id,{password:body.newPassword,app_metadata:{...u.data.user.app_metadata,kalika_password_change_required:false}});
   if(changed.error)throw new AccessError('Password could not be updated.',400);
   const completed=await db.rpc('access_password_changed',{p_user:access.member.user_id});
   if(completed.error)throw new AccessError('Password changed, but access setup could not finish. Contact the Kalika team; do not keep using the temporary password.',503);
   return reply(request,{success:true});
  }
  if(access.member.must_change_password)throw new AccessError('Change your temporary password before continuing.');
  let action='';let target:string|null=null;let data:Record<string,unknown>={};
  if(path[0]==='roles'){
   await requirePermission(request,'roles.manage');
   target=path[1]||null;action=path[2]==='archive'?'role.archive':target?'role.update':'role.create';
   data={name:body.name,cloneId:body.cloneId};
   if(body.permissions!==undefined){if(!Array.isArray(body.permissions)||body.permissions.some((p:unknown)=>typeof p!=='string'))throw new AccessError('Invalid permissions.',400);try{data.permissions=validatePermissions(body.permissions);}catch(e){throw new AccessError((e as Error).message,400);}}
  }else if(path[0]==='team'&&path.length===2){
   await requirePermission(request,'team.manage');action='member.update';target=path[1];
   if(body.status!==undefined&&!['active','suspended'].includes(body.status))throw new AccessError('Invalid membership status.',400);
   if(body.allCompanies!==undefined&&typeof body.allCompanies!=='boolean')throw new AccessError('Choose an explicit company scope.',400);
   for(const field of ['companyIds','modules'])if(body[field]!==undefined&&(!Array.isArray(body[field])||body[field].some((v:unknown)=>typeof v!=='string')||body[field].length!==new Set(body[field]).size))throw new AccessError('Invalid or duplicated scope selections.',400);
   data=Object.fromEntries(['roleId','companyIds','modules','allCompanies','status'].filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));
  }else if(path[0]==='policy'&&path.length===1){if(typeof body.allowSelfApproval!=='boolean')throw new AccessError('Choose an approval policy.',400);action='policy.update';data={allowSelfApproval:body.allowSelfApproval};}
  else if(path[0]==='ownership'&&path.length===2){if(typeof body.isOwner!=='boolean')throw new AccessError('Choose an ownership state.',400);action='owner.update';target=path[1];data={isOwner:body.isOwner};}
  else return reply(request,{error:'Not found.'},404);
  if(!Number.isSafeInteger(body.accessRevision)||body.accessRevision<1)throw new AccessError('Reload the current access summary before saving.',409);
  data._accessRevision=body.accessRevision;
  if(!['role.create'].includes(action)&&(!Number.isSafeInteger(body.revision)||body.revision<1))throw new AccessError('A current revision is required.',400);
  const r=await createSupabaseAdminClient().rpc('access_change',{p_actor:access.member.user_id,p_org:access.organizationId,p_action:action,p_target:target,p_expected:body.revision||0,p_data:data});dbError(r.error);
  // Committed changes are authoritative even if the notification transport is unavailable.
  await publishAccessChange(access.organizationId,access.revision+1);
  return reply(request,r.data);
 }catch(e){return failure(request,e);}
}

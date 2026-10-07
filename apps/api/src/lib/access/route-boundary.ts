import { canAccess } from '@autodealer/shared/lib/access';
import { jsonWithCors } from '@/lib/api/cors';
import { AccessError, requireAccessContext } from './server';
import { requireResourceAccess } from './resources';
import { CONNECTION_STATUS_PERMISSIONS, userRoutePolicy } from './route-policy';

async function readAction(request:Request) {
  if(!request.headers.get('content-type')?.includes('application/json')) return {};
  const reader=request.clone().body?.getReader();
  if(!reader) return {};
  const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>1024*1024)throw new AccessError('Command metadata is too large.',413);chunks.push(next.value);}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid body');
    return data as Record<string,unknown>;
  } catch(error){if(error instanceof AccessError)throw error;throw new AccessError('Invalid request body.',400);}
  finally{void reader.cancel().catch(()=>{});}
}

/** Wrap the exported handler, outside its legacy try/catch, to preserve 401/403/409.
 * Disabled until reviewed mapping and full activation gates pass.
 */
export function withTeamAccess<R extends Request,A extends unknown[]>(handler:(request:R,...args:A)=>Promise<Response>, options?:{bridgeSession?:boolean}) {
  return async (request:R,...args:A):Promise<Response> => {
    if(process.env.TEAM_ACCESS_ENFORCEMENT!=='true') return handler(request,...args);
    try {
      // Only the dual-authentication session endpoint uses this option. Its
      // connector branch independently validates the current bridge token.
      if(options?.bridgeSession && request.headers.has('x-bridge-token')) {
        const body=await readAction(request);
        if(body.role==='connector') return handler(request,...args);
      }
      const context=await requireAccessContext(request);
      if(context.member.must_change_password)throw new AccessError('Change your temporary password before continuing.',403);
      if(!context.sharingEnabled)throw new AccessError('Team access has not been activated for this organization.',503);
      const path=new URL(request.url).pathname.replace(/\/$/,'');
      let policy=userRoutePolicy(path,request.method);
      if(policy?.inspectAction){
        const body=await readAction(request);
        const action=request.method==='DELETE'&&new URL(request.url).searchParams.get('mode')==='hard'?'permanent':typeof body.action==='string'?body.action:undefined;
        policy=userRoutePolicy(path,request.method,action,typeof body.commandType==='string'?body.commandType:undefined);
      }
      if(!policy||!policy.permissions.length)throw new AccessError('This operation is not authorized for team access.',403);
      for(const key of policy.permissions){
        const permission=key==='@connection-status'?CONNECTION_STATUS_PERMISSIONS.find(p=>canAccess(context,p)):key;
        if(!permission||!canAccess(context,permission))throw new AccessError('You do not have permission for this action.',403);
        if(policy.resource)await requireResourceAccess(request,policy.resource.type,policy.resource.id,permission);
      }
      return handler(request,...args);
    } catch(error) {
      return jsonWithCors(request,{error:error instanceof AccessError?error.message:'Access verification is unavailable.'},{status:error instanceof AccessError?error.status:503,headers:{'Cache-Control':'private, no-store'}});
    }
  };
}

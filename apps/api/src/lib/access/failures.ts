import {jsonWithCors} from '@/lib/api/cors';
import {AccessError} from './server';
/** Do not expose database details from an authorization or revision conflict. */
export function accessFailureResponse(request:Request,error:unknown):Response|null {
 if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
 if(process.env.TEAM_ACCESS_ENFORCEMENT!=='true'||!error||typeof error!=='object')return null;
 const code='code' in error?String(error.code):'';
 if(code==='42501')return jsonWithCors(request,{error:'Your current access does not permit this action.'},{status:403});
 if(['22023','22007','22008'].includes(code))return jsonWithCors(request,{error:'The supplied scope, dates or operation parameters are invalid.'},{status:400});
 if(['40001','55000'].includes(code))return jsonWithCors(request,{error:'This record changed or is locked for approval or ERP verification. Refresh before continuing.'},{status:409});
 return null;
}

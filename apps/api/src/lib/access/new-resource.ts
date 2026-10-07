import {canAccess} from '@autodealer/shared/lib/access';
import {AccessError,requireAccessContext} from './server';

export async function newResourceScope(request:Request,company:unknown,permission:string){
 if(process.env.TEAM_ACCESS_ENFORCEMENT!=='true')return null;
 const context=await requireAccessContext(request);
 const permitted=context.companies.filter(c=>canAccess(context,permission,c.id));
 const companyId=typeof company==='string'&&company.trim()?company.trim():permitted.length===1?permitted[0].id:null;
 if(!companyId)throw new AccessError('Select the company for this record.',400);
 if(!permitted.some(c=>c.id===companyId))throw new AccessError('The selected company is outside your access.',403);
 return {access_organization_id:context.organizationId,access_company_id:companyId};
}

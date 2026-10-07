import {canAccess} from '@autodealer/shared/lib/access';
import {AccessError} from './server';
import {permittedConnections} from './connection-scope';

/** Resolve exactly one verified dataset. Names may narrow existing mappings but
 * never establish identity, merge companies or select another installation. */
export async function requireDataset(request:Request,connectionId:string,selection:{
 companyId?:unknown;companyGuid?:unknown;financialYear?:unknown;companyName?:unknown;
},permission:string) {
 const {access,links,rows}=await permittedConnections(request,connectionId);
 const matches=links.filter(link=>canAccess(access,permission,link.company_id)&&
  (!selection.companyId||selection.companyId===link.company_id)&&
  (!selection.companyGuid||selection.companyGuid===link.company_guid)&&
  (!selection.financialYear||selection.financialYear===link.financial_year)&&
  (!selection.companyName||selection.companyName===link.company_name));
 if(matches.length!==1)throw new AccessError('Select one permitted company and financial year.',409);
 const link=matches[0],connection=rows.find(row=>row.id===link.connection_id&&row.installation_id===link.installation_id);
 if(!connection)throw new AccessError('The selected installation is unavailable.',409);
 return {access,link,connection,columns:{access_organization_id:access.organizationId,access_company_id:link.company_id},
  predicate:`and(access_organization_id.eq.${JSON.stringify(access.organizationId)},access_company_id.eq.${JSON.stringify(link.company_id)})`};
}

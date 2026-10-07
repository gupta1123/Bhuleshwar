import {canAccess} from '@autodealer/shared/lib/access';
import {AccessError,requireAccessContext} from './server';
import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import {LIVE_OPERATION_PERMISSIONS} from './live-policy';
import {CONNECTION_STATUS_PERMISSIONS} from './route-policy';
import {hashSecret} from '@/lib/tally/connections';
import {restoreConnectionCompanyLinks} from './connection-company-links';

function canonicalFinancialYear(value:unknown) {
  const match=/^(20\d{2})-(\d{2}|20\d{2})$/.exec(String(value||'').trim().replace(/[–—]/g,'-'));
  if(!match)return String(value||'').trim();
  const end=match[2].length===2?`20${match[2]}`:match[2];
  return `${match[1]}-${end}`;
}

export async function authorizeLiveConnection(request:Request,body:Record<string,unknown>) {
  const access=await requireAccessContext(request);
  const operation=String(body.operation||'');
  const permissions=operation?LIVE_OPERATION_PERMISSIONS[operation]:CONNECTION_STATUS_PERMISSIONS;
  if(!permissions)throw new AccessError('Unsupported live operation.');
  const db=createSupabaseAdminClient();
  const result=await db.from('tally_connections').select('id,owner_user_id,installation_id,session_generation,revoked_at,bridge_token_hash')
    .eq('id',String(body.connectionId||'')).is('revoked_at',null).maybeSingle();
  if(result.error)throw new AccessError('Connection authorization is unavailable.',503);
  if(!result.data)throw new AccessError('Connection unavailable.',404);
  const connection=result.data;
  if(operation){
    const bridgeToken=request.headers.get('x-bridge-token');
    if(!bridgeToken||!connection.bridge_token_hash||hashSecret(bridgeToken)!==connection.bridge_token_hash)throw new AccessError('The connector pairing changed. Reconnect before continuing.',409);
  }
  let mapped=await db.from('access_company_links').select('company_id,company_guid,financial_year')
    .eq('organization_id',access.organizationId).eq('connection_id',connection.id).eq('installation_id',connection.installation_id);
  if(mapped.error)throw new AccessError('Company authorization is unavailable.',503);
  // A migration or upgrade may happen after this connector session was paired.
  // Rehydrate its reviewed mappings from the durable installation identity on
  // first use instead of requiring another pairing cycle.
  if(!(mapped.data?.length)) {
    try {
      await restoreConnectionCompanyLinks({organizationId:access.organizationId,installationId:connection.installation_id,
        connectionId:connection.id,db});
      mapped=await db.from('access_company_links').select('company_id,company_guid,financial_year')
        .eq('organization_id',access.organizationId).eq('connection_id',connection.id).eq('installation_id',connection.installation_id);
    } catch {
      throw new AccessError('Company authorization could not be restored.',503);
    }
    if(mapped.error)throw new AccessError('Company authorization is unavailable.',503);
  }
  const companies=new Map(access.companies.map(c=>[c.id,c.name]));
  const eligible=(mapped.data||[]).filter(link=>companies.has(link.company_id)
    && (access.member.all_companies||access.member.company_ids.includes(link.company_id))
    && permissions.some(p=>canAccess(access,p,link.company_id)))
    .map(link=>({...link,company_name:companies.get(link.company_id)!}));
  if(!eligible.length)throw new AccessError('This connection is outside your permitted company access.',404);
  if(!operation)return {ownerUserId:connection.owner_user_id,initiatingUserId:access.member.user_id,organizationId:access.organizationId,datasets:eligible};
  if(body.installationId&&body.installationId!==connection.installation_id)throw new AccessError('The connector installation changed.',409);
  if(body.sessionGeneration!==undefined&&body.sessionGeneration!==connection.session_generation)throw new AccessError('The pairing session changed.',409);
  if(operation==='company_check'&&!body.companyName)return {ownerUserId:connection.owner_user_id,initiatingUserId:access.member.user_id,
    organizationId:access.organizationId,installationId:connection.installation_id,sessionGeneration:connection.session_generation,datasets:eligible};
  // A name may select a previously verified mapping, but never supplies its
  // identity. Ambiguity across years/datasets must be resolved explicitly.
  const matches=eligible.filter(link=>(!body.companyGuid||link.company_guid===body.companyGuid)
    && (!body.financialYear||canonicalFinancialYear(link.financial_year)===canonicalFinancialYear(body.financialYear))
    && link.company_name===body.companyName);
  if(matches.length!==1)throw new AccessError('Select one verified company and financial year.',409);
  const link=matches[0];
  if(Array.isArray(body.companyNames)&&body.companyNames.some(name=>name!==link.company_name))throw new AccessError('A live request cannot span other companies.');
  return {ownerUserId:connection.owner_user_id,initiatingUserId:access.member.user_id,organizationId:access.organizationId,
    installationId:connection.installation_id,sessionGeneration:connection.session_generation,
    companyGuid:link.company_guid,financialYear:link.financial_year,companyName:link.company_name};
}

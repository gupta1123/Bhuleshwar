import {canAccess} from '@autodealer/shared/lib/access';
import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import {requireDataset} from './dataset';
import {AccessError, requireAccessContext} from './server';

export async function requireMasterDataset(request:Request, connectionId:string, selection:Record<string,unknown>, write:boolean|string=false) {
  const access=await requireAccessContext(request);
  const permission=typeof write==='string'?write:write?'connections.manage':[
    'connections.manage','purchases.view','bank.view','discounts.view','followups.view',
  ].find(key=>canAccess(access,key));
  if(!permission)throw new AccessError('Master data is not permitted.',403);
  const scope=await requireDataset(request,connectionId,selection,permission);
  const {data,error}=await createSupabaseAdminClient().from('access_master_datasets').select('id,revision,updated_at')
    .eq('organization_id',scope.access.organizationId).eq('connection_id',connectionId)
    .eq('installation_id',scope.link.installation_id).eq('company_guid',scope.link.company_guid)
    .eq('financial_year',scope.link.financial_year).maybeSingle();
  if(error)throw error;
  return {...scope,dataset:data as {id:string;revision:number;updated_at:string}|null};
}

export function datasetSelection(url:URL) {
  return Object.fromEntries(['companyId','companyGuid','companyName','financialYear'].map(key=>[key,url.searchParams.get(key)||undefined]));
}

export async function saveDatasetMapping(request:Request, connectionId:string, body:Record<string,unknown>, mapping:Record<string,unknown>) {
  const scope=await requireMasterDataset(request,connectionId,body,true);
  if(!scope.dataset)throw new AccessError('Sync this company’s masters before saving a mapping.',409);
  if(!Number.isSafeInteger(body.revision)||Number(body.revision)<0)throw new AccessError('A mapping revision is required; reload before saving.',409);
  const {data,error}=await createSupabaseAdminClient().rpc('access_save_dataset_mapping',{
    p_actor:scope.access.member.user_id,p_org:scope.access.organizationId,p_dataset:scope.dataset.id,
    p_revision:body.revision,p_mapping:mapping,
  });
  if(error)throw error;
  return {scope,mapping:data};
}

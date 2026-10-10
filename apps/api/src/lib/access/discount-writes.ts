import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import {wakeTallyConnector} from '@/lib/tally/command-wake';
import {requireDataset} from './dataset';
import {AccessError} from './server';
export async function enqueueTeamDiscount(scope:Awaited<ReturnType<typeof requireDataset>>,payload:Record<string,unknown>,proposalId:string|null=null) {
 const {data,error}=await createSupabaseAdminClient().rpc('access_enqueue_discount',{
  p_actor:scope.access.member.user_id,p_org:scope.access.organizationId,p_company:scope.link.company_id,p_connection:scope.connection.id,
  p_installation:scope.link.installation_id,p_generation:scope.connection.session_generation,p_guid:scope.link.company_guid,p_year:scope.link.financial_year,
  p_payload:payload,p_proposal:proposalId,
 });
 if(error)throw error;
 if(!data?.command?.id)throw new AccessError('Debit note could not be queued.',503);
 await wakeTallyConnector(scope.connection.id).catch(()=>{});
 return data;
}
const text=(v:unknown,max=500)=>typeof v==='string'&&v.trim()?v.trim().slice(0,max):null;
export function discountCompletion(success:boolean,result:Record<string,unknown>,payload:Record<string,unknown>,error:string|null) {
 return {success,possibleDuplicateInTally:result.possibleDuplicateInTally===true,voucherId:text(result.voucherId)||text(result.masterId),
  voucherGuid:text(result.voucherGuid)||text(result.guid),voucherNumber:text(result.voucherNumber)||text(payload.referenceNumber),
  voucherDate:text(result.voucherDate,20)||text(payload.voucherDate,20),openReferenceName:text(result.openReferenceName)||text(payload.referenceNumber),error:text(error,2000)};
}

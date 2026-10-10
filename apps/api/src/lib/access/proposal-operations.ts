import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import {wakeTallyConnector} from '@/lib/tally/command-wake';
import {uploadNativeTallyDebitNotePdf} from '@/lib/debit-notes/pdf';
import {requireResourceAccess} from './resources';
import {requireDataset} from './dataset';
import {AccessError} from './server';
import {verifiedProposalPdf} from './proposal-pdf.mjs';

export async function queueProposalOperation(request:Request,id:string,connectionId:string|undefined,operation:'native_pdf'|'phone',phone?:string) {
 const resource=await requireResourceAccess(request,'proposal',id,'discounts.export');
 const db=createSupabaseAdminClient();
 const {data:proposal,error}=await db.from('debit_note_proposals').select('*').eq('id',id)
  .eq('access_organization_id',resource.scope.organization_id).eq('access_company_id',resource.scope.company_id).maybeSingle();
 if(error)throw error;
 if(!proposal)throw new AccessError('Proposal not found.',404);
 const scope=await requireDataset(request,connectionId||proposal.connection_id,{companyId:resource.scope.company_id,financialYear:proposal.financial_year},operation==='phone'?'connections.manage':'discounts.export');
 const {data:command,error:queueError}=await db.rpc('access_enqueue_proposal_operation',{
  p_actor:scope.access.member.user_id,p_org:scope.access.organizationId,p_proposal:id,p_connection:scope.connection.id,
  p_installation:scope.link.installation_id,p_generation:scope.connection.session_generation,p_guid:scope.link.company_guid,
  p_year:scope.link.financial_year,p_operation:operation,p_phone:phone||null,
 });
 if(queueError)throw queueError;
 await wakeTallyConnector(scope.connection.id).catch(()=>{});
 return {command,proposal};
}

export async function completeProposalOperation(input:{db:ReturnType<typeof createSupabaseAdminClient>;command:{id:string;created_at:string;payload:Record<string,unknown>};connectionId:string;tokenHash:string;success:boolean;result:Record<string,unknown>;base64:string|null;error:string|null}) {
 const {db,command}=input;
 const compact:Record<string,unknown>={success:input.success,error:input.error};
 let patch:Record<string,unknown>={};
 if(command.payload.operation==='export_native_pdf'&&input.success) {
  const {data:authority,error:authorityError}=await db.from('access_command_authority').select('*').eq('command_id',command.id).maybeSingle();
  if(authorityError)throw authorityError;
  if(!authority||!['issued','completed','uncertain'].includes(authority.state))throw new AccessError('Issued PDF export required.');
  const {error:permissionError}=await db.rpc('access_assert_permission',{p_actor:authority.initiating_user_id,p_org:authority.organization_id,p_permission:'discounts.export',p_company:authority.company_id});
  if(permissionError)throw permissionError;
  const {data:proposal,error}=await db.from('debit_note_proposals').select('*').eq('id',command.payload.proposalId)
   .eq('access_organization_id',authority.organization_id).eq('access_company_id',authority.company_id).maybeSingle();
  if(error)throw error;
  if(!proposal)throw new AccessError('Proposal not found.',404);
  let verified:ReturnType<typeof verifiedProposalPdf>|undefined;
  try {verified=verifiedProposalPdf(proposal,input.result,input.base64,command.created_at);}
  catch(error) {compact.success=false;compact.error=error instanceof Error?error.message:'Native PDF verification failed.';}
  if(verified) {
   const uploaded=await uploadNativeTallyDebitNotePdf(db as unknown as Parameters<typeof uploadNativeTallyDebitNotePdf>[0],proposal,verified.pdf,true);
   patch={tally_pdf_reference:uploaded.reference,nativeTallyPdf:verified.evidence};
   compact.sha256=verified.evidence.sha256;
  }
 }
 const {data,error}=await db.rpc('access_complete_proposal_operation',{p_command:command.id,p_connection:input.connectionId,p_token_hash:input.tokenHash,p_result:compact,p_patch:patch});
 if(error)throw error;
 return data;
}

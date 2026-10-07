import {createSupabaseAdminClient} from '@/lib/supabase/admin';
import {wakeTallyConnector} from '@/lib/tally/command-wake';
import {serializeTallyBridgeCommand,type TallyBridgeCommandRow} from '@/lib/tally/commands';
import {requireDataset} from './dataset';
import {AccessError} from './server';
import {MASTER_TYPES} from '@/lib/tally/masters';
const permissions:Record<string,string>={sync_masters:'connections.manage',sync_bank_masters:'bank.prepare',fetch_bank_ledgers:'bank.prepare',fetch_purchase_masters:'purchases.prepare',fetch_customer_open_bills:'discounts.prepare'};
export async function queueTeamRead(request:Request,connectionId:string,body:Record<string,unknown>) {
 const type=typeof body.commandType==='string'?body.commandType:'';
 if(!permissions[type])throw new AccessError('This shared command path is not ready. Use its scoped workflow endpoint.',409);
 const raw=body.payload&&typeof body.payload==='object'&&!Array.isArray(body.payload)?body.payload as Record<string,unknown>:{};
 const dataset=await requireDataset(request,connectionId,{
  companyId:raw.companyId,companyGuid:raw.companyGuid,financialYear:raw.financialYear,companyName:raw.companyName,
 },permissions[type]);
 const {connection,link,access}=dataset;
 if(!connection.last_tally_reachable||!connection.last_company_loaded||connection.last_company_name!==link.company_name)
  throw new AccessError('Open the selected company in Tally and refresh its connection.',409);
 if(Array.isArray(raw.companyNames)&&raw.companyNames.some(name=>name!==link.company_name))
  throw new AccessError('Select one company per request.',400);
 let payload:Record<string,unknown>={companyName:link.company_name};
 if(type==='fetch_bank_ledgers')payload.companyNames=[link.company_name];
 if(type==='fetch_purchase_masters')payload.purpose='purchase_posting_dropdowns';
 if(type==='fetch_customer_open_bills') {
  const input=Array.isArray(raw.ledgerNames)?raw.ledgerNames:[raw.ledgerName];
  if(!input.length||input.length>250||input.some(name=>typeof name!=='string'||!name.trim()||name.length>500))
   throw new AccessError('Provide between 1 and 250 valid party ledger names.',400);
  const names=[...new Set((input as string[]).map(name=>name.trim()))];
  payload={...payload,ledgerName:names[0],ledgerNames:names};
  if(typeof raw.scanId==='string')payload.scanId=raw.scanId.slice(0,120);
 }
 const sync=type==='sync_masters'||type==='sync_bank_masters';
 const types=type==='sync_bank_masters'?['ledger','group']:raw.requestedMasterTypes===undefined?MASTER_TYPES:raw.requestedMasterTypes;
 if(sync&&(!Array.isArray(types)||!types.length||types.length>7||types.some(value=>!MASTER_TYPES.includes(value))))
  throw new AccessError('Select supported master types.',400);
 const {data,error}=await createSupabaseAdminClient().rpc(sync?'access_enqueue_master_sync':'access_enqueue_read',{
  p_actor:access.member.user_id,p_org:access.organizationId,p_company:link.company_id,
  p_connection:connection.id,p_installation:connection.installation_id,p_generation:connection.session_generation,
  p_guid:link.company_guid,p_year:link.financial_year,
  ...(sync?{p_types:types,p_permission:permissions[type]}:{p_type:type,p_payload:payload}),
 });
 if(error)throw error;
 if(!data?.id)throw new AccessError('Command could not be saved.',503);
 // A lost wake does not undo a committed command; normal polling recovers it.
 await wakeTallyConnector(connection.id).catch(()=>undefined);
 return {command:serializeTallyBridgeCommand(data as TallyBridgeCommandRow)};
}

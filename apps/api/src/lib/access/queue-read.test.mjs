import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import ts from 'typescript';
const code=ts.transpileModule(await readFile(new URL('./queue-read.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class AccessError extends Error{constructor(message,status){super(message);this.status=status;}}
function fixture(){const calls=[],exports={};
 const dataset={access:{organizationId:'org',member:{user_id:'actor'}},link:{company_id:'company',company_guid:'guid',financial_year:'2026-27',company_name:'Company'},connection:{id:'connection',installation_id:'install',session_generation:7,last_tally_reachable:true,last_company_loaded:true,last_company_name:'Company'}};
 const imports={'@/lib/supabase/admin':{createSupabaseAdminClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return {data:{id:'command'}};}})},'@/lib/tally/command-wake':{wakeTallyConnector:async()=>{throw Error('lost wake');}},'@/lib/tally/commands':{serializeTallyBridgeCommand:x=>x},'./dataset':{requireDataset:async()=>dataset},'./server':{AccessError}};
 imports['@/lib/tally/masters']={MASTER_TYPES:['ledger','group','stock_item','unit','voucher_type','gst_ledger','tax_ledger']};
 vm.runInNewContext(code,{exports,require:key=>imports[key]});return {calls,run:body=>exports.queueTeamRead({},'connection',body)};
}
test('read receipt preserves initiator and pinned dataset; lost wake retains committed command',async()=>{
 const f=fixture();const result=await f.run({commandType:'fetch_purchase_masters',payload:{companyName:'Company',secret:'not forwarded'}});
 assert.equal(result.command.id,'command');assert.equal(f.calls[0].args.p_actor,'actor');assert.equal(f.calls[0].args.p_generation,7);
 assert.equal(f.calls[0].args.p_guid,'guid');assert.equal(f.calls[0].args.p_payload.secret,undefined);
});

test('master sync uses scoped admission and never forwards arbitrary XML or URLs',async()=>{
 const f=fixture();await f.run({commandType:'sync_masters',payload:{requestedMasterTypes:['ledger','group'],xml:'unsafe',tallyUrl:'http://other'}});
 assert.equal(f.calls[0].name,'access_enqueue_master_sync');assert.deepEqual(Array.from(f.calls[0].args.p_types),['ledger','group']);
 assert.equal(f.calls[0].args.p_payload,undefined);
 await assert.rejects(f.run({commandType:'sync_masters',payload:{requestedMasterTypes:['voucher']}}),e=>e.status===400);
 assert.equal(f.calls.length,1);
});
test('writes, cross-company lists and oversized ledger input cannot reach admission',async()=>{
 const f=fixture();await assert.rejects(f.run({commandType:'post_bank_voucher'}),e=>e.status===409);
 await assert.rejects(f.run({commandType:'fetch_bank_ledgers',payload:{companyNames:['Other']}}),e=>e.status===400);
 await assert.rejects(f.run({commandType:'fetch_customer_open_bills',payload:{ledgerNames:Array(251).fill('Ledger')}}),e=>e.status===400);
 assert.equal(f.calls.length,0);
});
test('bank operators refresh only ledger/group snapshots without connection administration',async()=>{
 const f=fixture();await f.run({commandType:'sync_bank_masters',payload:{requestedMasterTypes:['stock_item'],xml:'ignored'}});
 assert.equal(f.calls[0].args.p_permission,'bank.prepare');
 assert.deepEqual(Array.from(f.calls[0].args.p_types),['ledger','group']);
 assert.equal(f.calls[0].args.p_payload,undefined);
});

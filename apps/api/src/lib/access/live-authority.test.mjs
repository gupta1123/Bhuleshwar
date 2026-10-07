import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import vm from 'node:vm';import ts from 'typescript';
import {canAccess,DEFAULT_ROLES} from '../../../../../packages/shared/src/lib/access.ts';
import {LIVE_OPERATION_PERMISSIONS} from './live-policy.ts';import {CONNECTION_STATUS_PERMISSIONS} from './route-policy.ts';
class AccessError extends Error{constructor(message,status=403){super(message);this.status=status;}}
const source=await readFile(new URL('./live-authority.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({role=DEFAULT_ROLES[2],companies=['company-a'],status='active',generation=2}={}){
 const snapshot={organizationId:'org-a',member:{user_id:'actor',modules:['bank','purchases','discounts'],status,must_change_password:false,all_companies:false,company_ids:companies,is_owner:false},role:{...role,archived:false},companies:[{id:'company-a',name:'Company A'},{id:'company-b',name:'Company B'}]};
 const records={tally_connections:[{id:'connection',owner_user_id:'paired-user',installation_id:'install',session_generation:generation,revoked_at:null,bridge_token_hash:'hash:bridge'}],access_company_links:[{organization_id:'org-a',connection_id:'connection',installation_id:'install',company_id:'company-a',company_guid:'guid-a',financial_year:'2026-27'},{organization_id:'org-b',connection_id:'connection',installation_id:'install',company_id:'company-b',company_guid:'guid-b',financial_year:'2026-27'}]};
 const db={from(table){let rows=records[table];return {select(){return this;},eq(k,v){rows=rows.filter(r=>r[k]===v);return this;},is(k,v){return this.eq(k,v);},maybeSingle(){return Promise.resolve({data:rows[0]||null,error:null});},then(resolve,reject){return Promise.resolve({data:rows,error:null}).then(resolve,reject);}};}};
 const exports={};const imports={'@autodealer/shared/lib/access':{canAccess},'./server':{AccessError,requireAccessContext:async()=>snapshot},'@/lib/supabase/admin':{createSupabaseAdminClient:()=>db},'./live-policy':{LIVE_OPERATION_PERMISSIONS},'./route-policy':{CONNECTION_STATUS_PERMISSIONS},'@/lib/tally/connections':{hashSecret:s=>`hash:${s}`},'./connection-company-links':{restoreConnectionCompanyLinks:async()=>({restored:0,conflicts:[]})}};
 vm.runInNewContext(compiled,{exports,require:key=>{if(!(key in imports))throw Error(key);return imports[key];}});
 const request=new Request('http://localhost/api/collections/live/session',{headers:{'x-bridge-token':'bridge'}});
 return {run:(body={},req=request)=>exports.authorizeLiveConnection(req,{connectionId:'connection',operation:'bank_ledgers',companyName:'Company A',financialYear:'2026-27',...body})};
}
test('live authority preserves paired identity and identifies the real initiator',async()=>{
 const value=await fixture().run();assert.equal(value.ownerUserId,'paired-user');assert.equal(value.initiatingUserId,'actor');assert.equal(value.companyGuid,'guid-a');assert.equal(value.sessionGeneration,2);
});
test('live authority treats short and expanded financial years as the same verified dataset',async()=>{
 const value=await fixture().run({financialYear:'2026-2027',companyGuid:'guid-a'});
 assert.equal(value.financialYear,'2026-27');
});
test('wrong company, organization, year, installation, session and bridge proof fail closed',async()=>{
 for(const body of [{companyName:'Company B'},{companyGuid:'guid-b'},{financialYear:'2025-26'},{installationId:'different'},{sessionGeneration:1},{operation:'unknown'},{companyNames:['Company A','Company B']}])await assert.rejects(()=>fixture().run(body),AccessError);
 await assert.rejects(()=>fixture().run({},new Request('http://localhost')),/pairing changed/);
 await assert.rejects(()=>fixture().run({},new Request('http://localhost',{headers:{'x-bridge-token':'old'}})),/pairing changed/);
});
test('suspended, view-only and wrong company scope cannot read live ledgers',async()=>{
 for(const options of [{status:'suspended'},{role:DEFAULT_ROLES[3]},{companies:['company-b']}])await assert.rejects(()=>fixture(options).run(),AccessError);
 await assert.rejects(()=>fixture().run({operation:'create_debit_note'}),AccessError);
});
test('connection bootstrap returns only permitted reviewed company metadata',async()=>{
 const value=await fixture({role:DEFAULT_ROLES[3]}).run({operation:'company_check',companyName:''});assert.equal(value.datasets.length,1);assert.equal(value.datasets[0].company_guid,'guid-a');
});

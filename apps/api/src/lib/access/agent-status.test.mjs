import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {canAccess} from '../../../../../packages/shared/src/lib/access.ts';

test('shared agent status uses verified datasets rather than requester ownership or raw machine data', async () => {
  const source=await readFile(new URL('../../app/api/tally/connections/[id]/agent-status/route.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const filters=[],exports={};
  const query={select(){return this;},eq(k,v){filters.push([k,v]);return this;},limit(){return Promise.resolve({data:[
    {company_guid:'allowed',financial_year:'2026-27',cache_size_bytes:10},
    {company_guid:'private',financial_year:'2026-27',cache_size_bytes:99},
    {company_guid:'allowed',financial_year:'2025-26',cache_size_bytes:99},
  ]});}};
  const imports={
    '@/lib/access/route-boundary':{withTeamAccess:fn=>fn},
    '@/lib/access/connection-scope':{permittedConnections:async()=>({access:{organizationId:'org'},
      links:[{company_id:'id',company_guid:'allowed',financial_year:'2026-27',company_name:'Allowed'}],
      rows:[{id:'connection',owner_user_id:'paired-not-requester',installation_id:'install',session_generation:2,
        agent_version:'1.0.0',last_company_name:'Private',last_companies_snapshot:[{companyName:'Private'}],
        agent_status:{activeJob:{secret:'Other organization'}}}]})},
    '@/lib/access/failures':{accessFailureResponse:()=>null},
    '@/lib/access/server':{requireAccessContext:async()=>({organizationId:'org',member:{status:'active',must_change_password:false,is_owner:false,all_companies:false,company_ids:['id'],modules:['bank']},role:{archived:false,permissions:['bank.view']}})},
    '@autodealer/shared/lib/access':{canAccess},
    '@/lib/api/cors':{jsonWithCors:(_r,data,init)=>Response.json(data,init),optionsWithCors:()=>new Response()},
    '@/lib/api/request-auth':{requireRequestUser:async()=>({id:'requester'})},
    '@/lib/supabase/admin':{createSupabaseAdminClient:()=>({from:()=>query})},
  };
  vm.runInNewContext(code,{exports,require:key=>imports[key],process:{env:{TEAM_ACCESS_ENFORCEMENT:'true'}},console});
  const result=await exports.GET(new Request('http://local/api/tally/connections/connection/agent-status'),{params:Promise.resolve({id:'connection'})});
  assert.equal(result.status,200);const body=await result.json();
  assert.equal(body.datasets.length,1);assert.equal(body.connection.companies.length,1);
  assert.equal(body.connection.companies[0].accessCompanyId,'id');
  assert.deepEqual(body.agent.status,{});
  assert.ok(filters.some(([k,v])=>k==='organization_id'&&v==='org'));
  assert.ok(filters.some(([k,v])=>k==='installation_id'&&v==='install'));
  assert.ok(!filters.some(([k])=>k==='owner_user_id'));
  assert.equal(JSON.stringify(body).includes('Private'),false);
});

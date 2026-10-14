import test from 'node:test';
import assert from 'node:assert/strict';
import {bankWorkerDataset,bankMasterQuery} from './bank-worker-scope.mjs';
import {QueuedAccessDenied} from './queued-authority.mjs';

const access={organization_id:'org',company_id:'company'};
const identity={organizationId:'org',companyId:'company',connectionId:'pc',installationId:'install',sessionGeneration:3,companyGuid:'guid',financialYear:'2026-27'};

function fake(overrides={}) {
  const calls=[];
  const rows={tally_connections:{id:'pc',organization_id:'org',installation_id:'install',session_generation:3},access_company_links:{company_id:'company'},access_master_datasets:{id:'dataset'},...overrides};
  return {calls,async rpc(name,args){calls.push([name,args]);return {};},from(table){calls.push(['from',table]);return {select(){return this;},eq(k,v){calls.push([table,k,v]);return this;},async maybeSingle(){return {data:rows[table]};}};}};
}

test('legacy worker remains independent of access infrastructure',async()=>{
  const db=fake();
  assert.equal(await bankWorkerDataset(db,{},null,{}),null);
  assert.equal(db.calls.length,0);
});

test('worker validates complete pairing and company identity',async()=>{
  const db=fake();
  const result=await bankWorkerDataset(db,{id:'job'},access,{accessDataset:identity});
  assert.equal(result.datasetId,'dataset');
  for(const field of ['organization_id','connection_id','installation_id','company_guid','financial_year']) {
    assert.ok(db.calls.some(c=>c[0]==='access_master_datasets'&&c[1]===field));
  }
  assert.equal(db.calls.some(c=>c[1]==='owner_user_id'),false);
});

test('wrong organization, company, generation, missing mapping and revoked pairing fail closed',async()=>{
  for(const field of ['organizationId','companyId']) {
    await assert.rejects(
      bankWorkerDataset(fake(),{id:'job'},access,{accessDataset:{...identity,[field]:'other'}}),
      QueuedAccessDenied
    );
  }
  for(const rows of [
    {tally_connections:null},
    {access_company_links:null},
    {tally_connections:{id:'pc',organization_id:'org',installation_id:'install',session_generation:4}},
  ]) {
    await assert.rejects(bankWorkerDataset(fake(rows),{id:'job'},access,{accessDataset:identity}),QueuedAccessDenied);
  }
});

test('master queries keep shared dataset reads separate from legacy owner filters',()=>{
  const db=fake();
  bankMasterQuery(db,'*','actor','pc','dataset','Company');
  assert.deepEqual(db.calls,[['from','access_dataset_masters'],['access_dataset_masters','dataset_id','dataset']]);

  const legacy=fake();
  bankMasterQuery(legacy,'*','actor','pc',null,'Company');
  assert.ok(legacy.calls.some(c=>c[1]==='company_name'&&c[2]==='Company'));
});

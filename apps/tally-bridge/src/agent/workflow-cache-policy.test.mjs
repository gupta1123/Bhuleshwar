import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workflowCacheState } from './workflow-cache-policy.mjs';
import { datasetKey, normalizeFinancialYear } from './identity.mjs';

test('same local day is fresh; yesterday, invalid and future timestamps are stale', () => {
  const now = new Date(2026, 8, 7, 12);
  assert.equal(workflowCacheState(new Date(2026, 8, 7, 1), now).stale, false);
  for (const date of [new Date(2026, 8, 6, 23, 59), 'invalid', new Date(2026, 8, 8)]) {
    assert.equal(workflowCacheState(date, now).stale, true);
  }
});

const source = fs.readFileSync(new URL('./runtime.mjs', import.meta.url), 'utf8');
const methods = source.slice(source.indexOf('  async getWorkflowSnapshot('), source.indexOf('  expectedIdentity('));
const Runtime = new Function('datasetKey', 'normalizeFinancialYear', `return class { ${methods} }`)(datasetKey, normalizeFinancialYear);
function runtime() {
  const agent = new Runtime();
  agent.activeIdentity = { organizationId:'org', connectionId:'conn', installationId:'pc', companyGuid:'guid', companyName:'Company', financialYear:'2026-27' };
  agent.activeIdentityObservedAt = Date.now();
  agent.workflowSnapshotKey = (workflow, scope) => JSON.stringify([workflow, scope]);
  agent.storage = { call: async (operation) => operation === 'getDataset' ? { status:'ready' } : { payload:{ scanSummary:{complete:true} }, updatedAt:new Date().toISOString() } };
  return agent;
}
const scope = { companyName:'Company', companyGuid:'guid', financialYear:'2026-27' };
test('snapshot lookup rejects different company, GUID, year and stale identity', async () => {
  const agent = runtime();
  assert.equal((await agent.getWorkflowSnapshot('cash_discount',scope)).cache.source, 'encrypted_local_agent');
  for (const change of [{companyName:'Other'}, {companyGuid:'other'}, {financialYear:'2025-26'}]) {
    assert.equal(await agent.getWorkflowSnapshot('cash_discount',{...scope,...change}),null);
    assert.equal(await agent.putWorkflowSnapshot('cash_discount',{...scope,...change},{}),null);
  }
  agent.activeIdentityObservedAt = 0;
  assert.equal(await agent.getWorkflowSnapshot('cash_discount',scope),null);
});
test('quarantined datasets cannot be reused', async () => {
  const agent = runtime();
  agent.storage.call = async () => ({ status:'quarantined' });
  assert.equal(await agent.getWorkflowSnapshot('cash_discount',scope),null);
});

test('purchase master catalogues are never copied into workflow snapshots', async () => {
  const agent = runtime();
  let writes = 0;
  agent.storage.call = async (operation) => {
    if (operation === 'getDataset') return { status: 'ready' };
    if (operation === 'putWorkflowSnapshot') writes += 1;
    return null;
  };
  assert.equal(await agent.getWorkflowSnapshot('purchase_masters', scope, Infinity), null);
  assert.equal(await agent.putWorkflowSnapshot('purchase_masters', scope, { masters: { ledgers: [{ name: 'Large catalogue' }] } }), null);
  assert.equal(writes, 0);
});

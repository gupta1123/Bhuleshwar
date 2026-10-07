import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const code = ts.transpileModule(await readFile(new URL('./agent-reads.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
class AccessError extends Error { constructor(message, status) { super(message); this.status = status; } }
function fixture(permission = 'discounts.prepare') {
  const calls = [], exports = {};
  const dataset = {
    access: { organizationId: 'org', member: { user_id: 'teammate' } },
    link: { company_id: 'company', company_guid: 'guid', financial_year: '2026-27', company_name: 'Company' },
    connection: { id: 'connection', owner_user_id: 'paired-owner', installation_id: 'install', session_generation: 7,
      agent_protocol_version: 1, agent_capabilities: ['agent-job-envelope-v1'] },
  };
  const imports = {
    '@/lib/supabase/admin': { createSupabaseAdminClient: () => ({ rpc: async (name, args) => {
      calls.push({ name, args }); return { data: { id: 'saved-job', owner_user_id: args.p_owner } };
    } }) },
    '@/lib/tally/command-wake': { wakeTallyConnector: async () => { throw Error('Wake unavailable'); } },
    '@/lib/tally/commands': { serializeTallyBridgeCommand: value => value },
    './dataset': { requireDataset: async (_request, _id, selection, actualPermission) => {
      assert.equal(actualPermission, permission);
      assert.equal(selection.companyGuid, 'guid'); return dataset;
    } },
    './server': { AccessError },
  };
  vm.runInNewContext(code, { exports, require: key => imports[key] });
  const body = { commandType: 'agent_query_open_bills', identity: {
    organizationId: 'org', ownerUserId: 'paired-owner', connectionId: 'connection',
    installationId: 'install', sessionGeneration: 7, companyGuid: 'guid', companyName: 'Company',
    financialYear: '2026-27', protocolVersion: 1,
  }, payload: { ledgerNames: ['Ledger A'] } };
  return { calls, body, dataset, run: () => exports.queueTeamAgentRead({}, body) };
}
test('shared agent read pins transport owner, records teammate and survives lost wake', async () => {
  const f = fixture(); f.body.payload.xml = '<IMPORT>not allowed</IMPORT>';
  f.body.payload.agentIdentity = { companyName: 'Other' };
  const result = await f.run(); const args = f.calls[0].args;
  assert.equal(result.job.id, 'saved-job'); assert.equal(args.p_actor, 'teammate');
  assert.equal(args.p_owner, 'paired-owner'); assert.equal(args.p_payload.xml, undefined);
  assert.equal(args.p_payload.agentIdentity, undefined); assert.equal(args.p_payload.dateFrom, '20260401');
  assert.equal(args.p_payload.dateTo, '20270331'); assert.equal(args.p_generation, 7);
});
test('changed pairing, organization, protocol or owner fails before admission', async () => {
  for (const [key, value] of Object.entries({ organizationId: 'other', ownerUserId: 'teammate', installationId: 'other', sessionGeneration: 8, protocolVersion: 2 })) {
    const f = fixture(); f.body.identity[key] = value;
    await assert.rejects(f.run(), e => e.status === 409); assert.equal(f.calls.length, 0);
  }
});
test('unbounded or invalid reports cannot be enqueued', async () => {
  for (const patch of [{ ledgerNames: [] }, { ledgerNames: Array(251).fill('A') }, { ledgerNames: [''] },
    { dateFrom: '20260201' }, { dateTo: '20270230' }, { dateFrom: '20270101', dateTo: '20260401' }, { dateFrom: '01-05-2026' }]) {
    const f = fixture(); Object.assign(f.body.payload, patch);
    await assert.rejects(f.run(), e => e.status === 400); assert.equal(f.calls.length, 0);
  }
});
test('discount workflow uses only allowed reports; generic writes and maintenance stay excluded', async () => {
  const f = fixture(); f.body.commandType = 'agent_query_workflow_vouchers'; f.body.payload.workflow = 'turnover_discount';
  await f.run(); assert.equal(f.calls[0].args.p_payload.workflow, 'turnover_discount');
  for (const type of ['create_purchase_voucher', 'post_bank_voucher', 'agent_parse_document', 'agent_clear_cache', 'agent_update_settings', 'agent_voucher_identity']) {
    const blocked = fixture(); blocked.body.commandType = type;
    await assert.rejects(blocked.run(), e => e.status === 409); assert.equal(blocked.calls.length, 0);
  }
});
test('old connectors are rejected and an omitted owner is resolved from the verified connection', async () => {
  const old = fixture(); old.dataset.connection.agent_capabilities = [];
  await assert.rejects(old.run(), e => e.status === 409); assert.equal(old.calls.length, 0);
  const current = fixture(); delete current.body.identity.ownerUserId;
  await current.run(); assert.equal(current.calls[0].args.p_owner, 'paired-owner');
});

test('dataset sync uses administrative authority, pinned identity and no caller payload', async () => {
  for (const commandType of ['agent_sync_dataset','agent_reconcile_dataset']) {
    const f = fixture('connections.manage'); f.body.commandType = commandType; f.body.payload = {};
    await f.run(); assert.equal(f.calls[0].name, 'access_enqueue_agent_sync');
    assert.equal(f.calls[0].args.p_actor, 'teammate');
    assert.equal(f.calls[0].args.p_owner, 'paired-owner');
    f.body.payload = {xml: '<unsafe />'};
    await assert.rejects(f.run(), e => e.status === 400);
    assert.equal(f.calls.length, 1);
  }
});

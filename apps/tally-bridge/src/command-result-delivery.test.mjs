import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('./bridge.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function sendCommandResult(');
const end = source.indexOf('\nfunction safeDocumentPathSegment', start);
assert.ok(start >= 0 && end > start);

async function deliver(status) {
  const acknowledgements = [];
  const context = vm.createContext({
    console: {log() {}}, AGENT_PROTOCOL_VERSION: 1,
    fetch: async () => ({ok: status === 200, status}),
    readJsonResponse: async () => ({error: 'Rejected'}),
  });
  vm.runInContext(source.slice(start, end), context);
  const config = {apiBase: 'http://test.invalid', connectionId: 'connection',
    bridgeToken: 'synthetic', __agentRuntime: {
      acknowledgeOutcome: async id => acknowledgements.push(id),
    }};
  const pending = context.sendCommandResult(config, {id: 'command'},
    {success: true}, {id: 'receipt'});
  if (status === 200) await pending;
  else await assert.rejects(pending, /Rejected/);
  return acknowledgements;
}

test('successful duplicate callback acknowledges the durable outbox', async () => {
  assert.deepEqual(await deliver(200), ['receipt']);
});

test('rejected callbacks never discard a saved outcome, including 404 and 409', async () => {
  for (const status of [400, 401, 403, 404, 409, 500, 503]) {
    assert.deepEqual(await deliver(status), [], `HTTP ${status}`);
  }
});

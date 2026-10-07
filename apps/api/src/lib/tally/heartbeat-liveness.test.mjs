import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function api({ tokenHash = "valid", installation = "pc-1" } = {}) {
  const changes = [];
  const original = { id: "c1", owner_user_id: "u1", installation_id: installation, bridge_token_hash: tokenHash,
    last_tested_at: "2026-08-01T00:00:00Z", last_company_name: "Original Company", last_company_loaded: true };
  const client = { from: () => ({
    select() { return this; }, eq() { return this; }, is() { return this; },
    async maybeSingle() { return { data: original }; },
    update(value) { changes.push(value); return this; },
    async single() { return { data: { ...original, ...changes.at(-1) } }; },
    async insert() { return {}; },
  }) };
  const exports = {};
  const source = fs.readFileSync(new URL("../../app/api/tally/bridge/heartbeat/route.ts", import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, console, require: () => ({
      createSupabaseAdminClient: () => client,
      jsonWithCors: (_request, value, options) => ({ value, status: options?.status || 200 }),
      isLocalDbMode: () => false, hashSecret: () => "valid", connectorSupportsReliableActiveCompany: () => true,
      isReliableInstallationId: () => true, serializeTallyConnectionStatus: (row) => row,
    }),
  });
  return { changes, post: (livenessOnly) => exports.POST(new Request("http://test/heartbeat", {
    method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId: "c1", bridgeVersion: "0.1.63", bridgeMachineId: "pc-1", livenessOnly }),
  })) };
}

test("busy heartbeat preserves company observations and their original timestamp", async () => {
  const h = api(); const response = await h.post(true);
  assert.equal(response.status, 200);
  assert.equal(response.value.livenessSupported, true);
  assert.deepEqual(Object.keys(h.changes[0]).sort(), ["bridge_version", "last_heartbeat_at"]);
  assert.equal(response.value.connection.last_tested_at, "2026-08-01T00:00:00Z");
  assert.equal(response.value.connection.last_company_name, "Original Company");
});

test("liveness does not bypass connector token or installation checks", async () => {
  for (const [configuration, status] of [[{ tokenHash: "wrong" }, 401], [{ installation: "other-pc" }, 409]]) {
    const h = api(configuration); assert.equal((await h.post(true)).status, status);
    assert.equal(h.changes.length, 0);
  }
});

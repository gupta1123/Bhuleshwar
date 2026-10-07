import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const exports = {};
const source = fs.readFileSync(new URL("./agent-datasets.ts", import.meta.url), "utf8");
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports });

test("heartbeat canonicalizes reconnect history before the dataset upsert", () => {
  const result = exports.canonicalAgentDatasetRows({
    datasets: [
      { status: "syncing", updated_at: "2026-09-08T10:00:00Z", identity: { organizationId: "u1", installationId: "pc-1", connectionId: "old", companyGuid: "g1", companyName: "Solution Nyx", financialYear: "2026-27" }, cursors: { ledger: 1 } },
      { status: "ready", updated_at: "2026-09-08T09:00:00Z", identity: { organizationId: "u1", installationId: "pc-1", connectionId: "new", companyGuid: "g1", companyName: "Solution Nyx", financialYear: "2026-27" }, cursors: { ledger: 9 } },
      { status: "ready", identity: { organizationId: "another-user", installationId: "pc-1", companyGuid: "foreign", financialYear: "2026-27" } },
    ],
    agentStatus: { storage: { sizeBytes: 42 } },
    connection: { id: "current", owner_user_id: "u1", organization_id: null, installation_id: "pc-1" },
    agentVersion: "1.1.0",
    protocolVersion: 1,
    now: "2026-09-08T11:00:00Z",
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rejected, 1);
  assert.equal(result.rows[0].connection_id, "current");
  assert.deepEqual(result.rows[0].sync_cursors, { ledger: 9 });
});

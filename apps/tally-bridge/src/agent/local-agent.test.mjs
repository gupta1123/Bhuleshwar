import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { datasetKey, assertAgentIdentity } from "./identity.mjs";
import { createInlinePriorityScheduler } from "./scheduler.mjs";
import {
  deterministicLedgerCandidates,
  localLedgerEmbedding,
  LOCAL_LEDGER_VECTOR_DIMENSIONS,
  LOCAL_LEDGER_VECTOR_MODEL,
} from "./vector-service.mjs";
import { LocalVectorService } from "./vector-service.mjs";
import { LocalAgentStorage, windowsAclHardeningCommands } from "./storage.mjs";
import { IncrementalSyncEngine } from "./sync-engine.mjs";

const identity = {
  organizationId: "org-a", ownerUserId: "user-a", connectionId: "connection-a",
  installationId: "machine-a", sessionGeneration: 3, companyGuid: "guid-a",
  companyName: "Solution Nyx", financialYear: "2026-27", protocolVersion: 1,
};

test("dataset identity isolates organization, machine, company and financial year", () => {
  const key = datasetKey(identity);
  assert.ok(key.includes("org-a"));
  assert.notEqual(key, datasetKey({ ...identity, installationId: "machine-b" }));
  assert.notEqual(key, datasetKey({ ...identity, financialYear: "2025-26" }));
  assert.equal(key, datasetKey({ ...identity, connectionId: "reconnected", sessionGeneration: 99 }));
  assert.throws(() => assertAgentIdentity(identity, { ...identity, connectionId: "wrong" }), /identity mismatch/i);
});

test("Windows ACL hardening grants the user before removing root inheritance", () => {
  const commands = windowsAclHardeningCommands("C:\\agent", "S-1-5-21-1-2-3-1001");
  assert.deepEqual(commands, [
    ["C:\\agent", "/inheritance:e", "/T", "/C"],
    ["C:\\agent", "/grant:r", "*S-1-5-21-1-2-3-1001:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"],
    ["C:\\agent", "/inheritance:r"],
  ]);
  assert.ok(commands.slice(1).every((command) => !command.includes("/T")));
  assert.throws(() => windowsAclHardeningCommands("C:\\agent", ""), /user SID/i);
});

test("single Tally lane prioritizes interactive work between jobs and permits safe re-entry", async () => {
  const scheduler = createInlinePriorityScheduler();
  const order = [];
  let release;
  const first = scheduler.run(async () => { order.push("background-1"); await new Promise((resolve) => { release = resolve; }); });
  const second = scheduler.run(async () => { order.push("background-2"); }, { priority: 10 });
  const interactive = scheduler.run(async () => { order.push("interactive"); await scheduler.run(async () => order.push("nested")); }, { priority: 80 });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second, interactive]);
  assert.deepEqual(order, ["background-1", "interactive", "nested", "background-2"]);
});

test("deterministic matching ranks identifier, saved mapping, exact name, then fuzzy", () => {
  const ledgers = [
    { guid: "gst", name: "Other", gstin: "27ABCDE1234F1Z5" },
    { guid: "saved", name: "Unrelated" },
    { guid: "exact", name: "Surya Steel Trading Company" },
    { guid: "fuzzy", name: "Surya Steel Trading Co" },
  ];
  const result = deterministicLedgerCandidates(
    { name: "Surya Steel Trading Company", gstin: "27ABCDE1234F1Z5" },
    ledgers,
    [{ source: "Surya Steel Trading Company", masterId: "saved" }],
  );
  assert.deepEqual(result.map((item) => item.source), ["exact_identifier", "saved_mapping", "exact_name", "fuzzy"]);
});

test("semantic vectors use the Gajkesari OpenRouter model and dimensions", () => {
  assert.equal(LOCAL_LEDGER_VECTOR_MODEL, "openai/text-embedding-3-small");
  assert.equal(LOCAL_LEDGER_VECTOR_DIMENSIONS, 512);
  // The deterministic fallback remains useful when semantic suggestions are
  // explicitly disabled, but it is no longer used to populate ZVec.
  const query = localLedgerEmbedding("Surya Steel Trading Company");
  const close = localLedgerEmbedding("Surya Steel Trading Co.");
  const unrelated = localLedgerEmbedding("Bank Charges and Commission");
  const similarity = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
  assert.ok(similarity(query, close) > similarity(query, unrelated));
  assert.equal(query.length, 512);
});

test("vector index paths stay below Windows path limits without losing identity isolation", () => {
  const service = new LocalVectorService({ vectorsDirectory: "C:\\Kalika\\vectors" });
  const first = service.indexPath("org|machine|company|2026-27".repeat(20));
  const second = service.indexPath("org|machine|company|2025-26".repeat(20));
  assert.match(path.basename(first), /^[a-f0-9]{64}$/);
  assert.ok(first.length < 100);
  assert.notEqual(first, second);
});

test("encrypted storage rejects a wrong key and clear cache preserves settings and receipts", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-agent-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storage = new LocalAgentStorage({ baseDirectory: directory, keyHex: "01".repeat(32) });
  for (const [id, jobClass, version] of [['v2-document', 'document_parse', 2], ['legacy-document', 'document_parse', 1], ['read', 'interactive_read', 2]]) {
    await storage.call('enqueueJob', { job: { id, commandId: id, jobClass, identity, payload: { pipelineVersion: version }, priority: jobClass === 'interactive_read' ? 100 : 50 } });
  }
  assert.equal((await storage.call('claimNextJob', { lane: 'document' })).id, 'v2-document');
  assert.equal(await storage.call('claimNextJob', { lane: 'document' }), null);
  assert.equal((await storage.call('claimNextJob', { lane: 'tally' })).id, 'read');
  assert.equal((await storage.call('claimNextJob', { lane: 'tally' })).id, 'legacy-document');
  const recovery = await storage.call('recoverJobs');
  assert.equal(recovery.interruptedDocuments, 1);
  assert.equal((await storage.call('getJob', { id: 'v2-document' })).status, 'failed');
  assert.equal((await storage.call('getJob', { id: 'legacy-document' })).status, 'queued');
  await storage.call("setSetting", { key: "localZvecEnabled", value: true });
  await storage.call("upsertReceipt", { receipt: { idempotencyKey: "write-1", commandId: "command-1", commandType: "post_bank_voucher", status: "succeeded", result: { success: true } } });
  await storage.call("upsertDataset", { datasetKey: datasetKey(identity), identity });
  await storage.call("upsertMasters", { datasetKey: datasetKey(identity), masterType: "ledger", masters: [{ guid: "ledger-1", name: "Ledger 1", alterId: 1 }] });
  await storage.call("upsertVectorDocumentStates", { datasetKey: datasetKey(identity), documents: [{ entityKey: "ledger-1", contentHash: "hash-1", alterId: 1 }] });
  await storage.call("clearRebuildableCache");
  assert.equal(await storage.call("getSetting", { key: "localZvecEnabled" }), true);
  assert.equal((await storage.call("getReceipt", { idempotencyKey: "write-1" })).status, "succeeded");
  assert.equal((await storage.call("listMasters", { datasetKey: datasetKey(identity), masterType: "ledger" })).length, 0);
  assert.equal((await storage.call("listVectorDocumentStates", { datasetKey: datasetKey(identity) })).length, 0);
  await storage.close();
  const wrong = new LocalAgentStorage({ baseDirectory: directory, keyHex: "02".repeat(32) });
  await assert.rejects(wrong.call("health"));
  await wrong.close().catch(() => {});
});

test("schema upgrade preserves existing Local Agent settings", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-agent-upgrade-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyHex = "03".repeat(32);
  const previous = new LocalAgentStorage({ baseDirectory: directory, keyHex, schemaVersion: 1 });
  await previous.call("setSetting", { key: "localDataModules", value: { purchase: true, bank: false, cashDiscount: true, followups: false } });
  await previous.call("setSetting", { key: "localZvecEnabled", value: true });
  await previous.close();
  const dataDirectory = path.join(directory, "data");
  fs.copyFileSync(path.join(dataDirectory, "agent.db"), path.join(dataDirectory, "agent.db.pre-v1-100.bak"));
  fs.copyFileSync(path.join(dataDirectory, "agent.db"), path.join(dataDirectory, "agent.db.pre-v2-200.bak"));
  const upgraded = new LocalAgentStorage({ baseDirectory: directory, keyHex, schemaVersion: 3 });
  assert.deepEqual(await upgraded.call("getSetting", { key: "localDataModules" }), { purchase: true, bank: false, cashDiscount: true, followups: false });
  assert.equal(await upgraded.call("getSetting", { key: "localZvecEnabled" }), true);
  assert.equal((await upgraded.call("health")).schemaVersion, 3);
  await upgraded.close();
  // A successful upgrade leaves no full-size database copies on disk.
  const backups = fs.readdirSync(dataDirectory).filter((name) => /^agent\.db\.pre-v\d+-\d+\.bak$/.test(name));
  assert.deepEqual(backups, []);
});

test("routine launches do not copy an up-to-date database", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-agent-nocopy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyHex = "04".repeat(32);
  for (let launch = 0; launch < 2; launch += 1) {
    const storage = new LocalAgentStorage({ baseDirectory: directory, keyHex, schemaVersion: 3 });
    await storage.call("health");
    await storage.close();
  }
  const dataDirectory = path.join(directory, "data");
  assert.deepEqual(fs.readdirSync(dataDirectory).filter((name) => name.endsWith(".bak")), []);
});

test("maintenance prunes delivered results and completed jobs without removing active work", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-agent-retention-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storage = new LocalAgentStorage({ baseDirectory: directory, keyHex: "05".repeat(32) });
  await storage.call("upsertDataset", { datasetKey: datasetKey(identity), identity });
  await storage.call("putWorkflowSnapshot", { datasetKey: datasetKey(identity), workflow: "purchase_masters", snapshotKey: "purchase", payload: { masters: { ledgers: [{ name: "duplicate" }] } } });
  await storage.call("putWorkflowSnapshot", { datasetKey: datasetKey(identity), workflow: "cash_discount", snapshotKey: "cash", payload: { openBillsResult: { result: {} } } });
  for (const [id, status] of [["finished", "succeeded"], ["active", "queued"]]) {
    await storage.call("enqueueJob", { job: { id, commandId: id, jobClass: "interactive_read", identity, payload: {}, priority: 1 } });
    if (status !== "queued") await storage.call("updateJob", { id, status, result: { success: true } });
  }
  await storage.call("enqueueOutbox", { item: { id: "sent", commandId: "finished", payload: { ok: true } } });
  await storage.call("acknowledgeOutbox", { id: "sent" });
  await storage.call("enqueueOutbox", { item: { id: "pending", commandId: "active", payload: { ok: true } } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const maintenance = await storage.call("maintenance", {
    completedJobRetentionMs: 0,
    deliveredOutboxRetentionMs: 0,
    workflowSnapshotRetentionMs: 30 * 86400000,
  });
  assert.equal(maintenance.deleted.completedJobs, 1);
  assert.equal(maintenance.deleted.deliveredOutbox, 1);
  assert.equal(maintenance.deleted.workflowSnapshots, 1);
  assert.equal(await storage.call("getJob", { id: "finished" }), null);
  assert.equal((await storage.call("getJob", { id: "active" })).status, "queued");
  assert.equal(await storage.call("getWorkflowSnapshot", { datasetKey: datasetKey(identity), workflow: "purchase_masters", snapshotKey: "purchase" }), null);
  assert.ok(await storage.call("getWorkflowSnapshot", { datasetKey: datasetKey(identity), workflow: "cash_discount", snapshotKey: "cash" }));
  assert.equal((await storage.call("listOutbox", { limit: 10 })).length, 1);
  await storage.close();
});

test("schema v3 merges reconnect datasets and preserves the newest incremental cache", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-agent-stable-identity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keyHex = "04".repeat(32);
  const oldKeyA = "org-a|connection-old|machine-a|guid-a|2026-2027";
  const oldKeyB = "org-a|connection-new|machine-a|guid-a|2026-2027";
  const oldIdentityA = { ...identity, connectionId: "connection-old" };
  const oldIdentityB = { ...identity, connectionId: "connection-new" };
  const previous = new LocalAgentStorage({ baseDirectory: directory, keyHex, schemaVersion: 2 });
  await previous.call("upsertDataset", { datasetKey: oldKeyA, identity: oldIdentityA, status: "syncing", cursors: { ledger: 8, item: 2 } });
  await previous.call("upsertDataset", { datasetKey: oldKeyB, identity: oldIdentityB, status: "ready", cursors: { ledger: 5, item: 9 } });
  await previous.call("upsertMasters", { datasetKey: oldKeyA, masterType: "ledger", masters: [{ guid: "ledger-1", name: "Older name", alterId: 8 }] });
  await previous.call("upsertMasters", { datasetKey: oldKeyB, masterType: "ledger", masters: [{ guid: "ledger-1", name: "Latest name", alterId: 11 }, { guid: "ledger-2", name: "Second ledger", alterId: 9 }] });
  await previous.call("upsertVectorDocumentStates", { datasetKey: oldKeyB, documents: [{ entityKey: "ledger-1", contentHash: "old-index", alterId: 11 }] });
  await previous.close();

  const upgraded = new LocalAgentStorage({ baseDirectory: directory, keyHex, schemaVersion: 3 });
  const datasets = await upgraded.call("listDatasets");
  assert.equal(datasets.length, 1);
  assert.equal(datasets[0].dataset_key, datasetKey(identity));
  assert.deepEqual(datasets[0].cursors, { ledger: 8, item: 9 });
  assert.equal(datasets[0].status, "ready");
  const masters = await upgraded.call("listMasters", { datasetKey: datasetKey(identity), masterType: "ledger" });
  assert.deepEqual(masters.map((row) => row.name).sort(), ["Latest name", "Second ledger"]);
  assert.equal((await upgraded.call("listVectorDocumentStates", { datasetKey: datasetKey(identity) })).length, 0);
  assert.deepEqual((await upgraded.call("getSetting", { key: "pendingVectorCleanup" })).sort(), [oldKeyA, oldKeyB].sort());
  await upgraded.close();
});

test("incremental sync drains pages and quarantines a regressed AlterID dataset", async () => {
  const calls = [];
  const state = { dataset: null, masters: [] };
  const storage = { async call(operation, payload) {
    if (operation === "getDataset") return state.dataset;
    if (operation === "upsertDataset") return state.dataset = { identity: payload.identity, cursors: {}, cacheHealth: {} };
    if (operation === "upsertMasters") { state.masters.push(...payload.masters); return {}; }
    if (operation === "markDatasetSync") return state.dataset = { ...state.dataset, cursors: payload.cursors, cacheHealth: payload.cacheHealth };
    if (operation === "quarantineDataset") { state.dataset = null; calls.push("quarantined"); return null; }
    if (operation === "resetDatasetData") { state.masters = []; return null; }
    if (operation === "reconcileMasterKeys") return {};
    throw new Error(operation);
  } };
  const gateway = {
    highest: 3,
    async capabilities() { return { companyGuid: identity.companyGuid, highestAlterId: this.highest, version: 1 }; },
    async changedMasters(_identity, { masterType, afterAlterId }) {
      calls.push(`${masterType}:${afterAlterId}`);
      if (afterAlterId >= 3) return { masters: [], highestAlterId: afterAlterId, hasMore: false };
      return { masters: [{ guid: `${masterType}-${afterAlterId + 1}`, name: masterType, alterId: afterAlterId + 1 }], highestAlterId: afterAlterId + 1, hasMore: afterAlterId < 2 };
    },
  };
  const engine = new IncrementalSyncEngine({ storage, gateway });
  await engine.sync(identity);
  assert.ok(calls.includes("ledger:1"));
  state.dataset.cacheHealth = { highestAlterId: 3 };
  state.dataset.cursors = { ledger: 9 };
  gateway.highest = 2;
  await engine.sync(identity);
  assert.ok(calls.includes("quarantined"));
});


test("fallback capabilities validate per-type cursors without resetting a healthy catalogue", async () => {
  const calls = [];
  const state = {
    dataset: {
      identity,
      status: "ready",
      cursors: { ledger: 40, stock_item: 30, group: 20, unit: 10 },
      cacheHealth: { highestAlterId: 0, capabilityVersion: 0, dataUpdatedAt: "2026-09-08T00:00:00.000Z" },
      last_sync_at: "2026-09-08T00:00:00.000Z",
    },
  };
  const storage = { async call(operation, payload) {
    if (operation === "getDataset") return state.dataset;
    if (operation === "upsertMasters") return {};
    if (operation === "markDatasetSync") {
      state.dataset = { ...state.dataset, cursors: payload.cursors, cacheHealth: payload.cacheHealth };
      return state.dataset;
    }
    if (operation === "quarantineDataset" || operation === "resetDatasetData") {
      calls.push(operation);
      return null;
    }
    if (operation === "reconcileMasterKeys") return {};
    throw new Error(operation);
  } };
  const gateway = {
    async capabilities() {
      return { companyGuid: identity.companyGuid, highestAlterId: 0, version: 0, fallback: true };
    },
    async changedMasters(_identity, { masterType, afterAlterId }) {
      calls.push(`${masterType}:${afterAlterId}`);
      return { masters: [], highestAlterId: afterAlterId, hasMore: false };
    },
  };
  const engine = new IncrementalSyncEngine({ storage, gateway });
  const result = await engine.sync(identity, { cursorNamespace: "purchase", fieldProfile: "purchase" });
  assert.deepEqual(calls, ["ledger:40", "stock_item:30", "group:20", "unit:10"]);
  assert.equal(result.cursors["purchase:ledger"], 40);
  assert.equal(result.cursors["purchase:stock_item"], 30);
  assert.equal(result.cacheHealth.watermarkReliable, false);
  assert.ok(result.cacheHealth.validatedAt);
  assert.equal(result.cacheHealth.dataUpdatedAt, "2026-09-08T00:00:00.000Z");
});

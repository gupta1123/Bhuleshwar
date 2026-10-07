import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LocalAgentStorage, prepareLocalAgentDirectoryAcl } from "./storage.mjs";
import { resolveLocalAgentKey } from "./key-vault.mjs";
import { AgentJobScheduler } from "./scheduler.mjs";
import { TallyAgentGateway } from "./tally-gateway.mjs";
import { IncrementalSyncEngine } from "./sync-engine.mjs";
import { LocalDocumentService } from "./document-service.mjs";
import { BrowserDocumentUpload } from "./browser-upload.mjs";
import {
  LocalVectorService,
  deterministicLedgerCandidates,
  ledgerSearchText,
  LOCAL_LEDGER_VECTOR_DIMENSIONS,
  LOCAL_LEDGER_VECTOR_INDEX_VERSION,
  LOCAL_LEDGER_VECTOR_MODEL,
} from "./vector-service.mjs";
import { AGENT_CAPABILITIES, AGENT_PROTOCOL_VERSION, AGENT_VERSION, LOCAL_SCHEMA_VERSION, TDL_REPORT_VERSION, jobClassForCommand } from "./protocol.mjs";
import { assertAgentIdentity, identityFromCommand, datasetKey, normalizeFinancialYear } from "./identity.mjs";
import { resourceSnapshot } from "./resource-policy.mjs";
import { automaticCatalogueSyncPlan } from "./sync-policy.mjs";
import { ReceivablesPreparer, financialYearRange } from "./receivables.mjs";

const AGENT_COMMANDS = new Set([
  "agent_sync_dataset",
  "agent_reconcile_dataset",
  "agent_parse_document",
  "agent_vector_suggest",
  "agent_cache_maintenance",
  "agent_clear_cache",
  "agent_update_settings",
  "agent_rebuild_cache",
  "agent_diagnostics",
  "agent_query_open_bills",
  "agent_query_workflow_vouchers",
  "agent_voucher_identity",
]);

// Product decisions, not client preferences. Stored values from older builds
// (or from the old web settings menu) are ignored so every install behaves the
// same way.
const MANAGED_SETTINGS = Object.freeze({
  localAnydocEnabled: true,
  localZvecEnabled: true,
  localDataModules: Object.freeze({ purchase: true, bank: true, cashDiscount: true, followups: true }),
  startWithWindows: true,
  // Upper bound for rebuildable cached Tally data on client PCs.
  cacheLimitBytes: 512 * 1024 * 1024,
});

function financialYearDates(value) {
  const match = String(value || "").match(/(\d{4})\D+(\d{2,4})/);
  if (!match) return { dateFrom: null, dateTo: new Date().toISOString().slice(0, 10) };
  const startYear = Number(match[1]);
  const endYear = match[2].length === 2 ? Math.floor(startYear / 100) * 100 + Number(match[2]) : Number(match[2]);
  return { dateFrom: `${startYear}-04-01`, dateTo: `${endYear}-03-31` };
}

function defaultAgentDirectory() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Kalika", "LocalAgent");
}

function ledgerLookupKey(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-IN").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function buildLedgerLookup(rows) {
  const byName = new Map();
  const byGstin = new Map();
  const byId = new Map();
  const byToken = new Map();
  for (const ledger of rows) {
    const id = String(ledger.guid || ledger.masterId || ledger.id || ledger.name || "");
    const name = ledgerLookupKey(ledger.name);
    if (name) byName.set(name, ledger);
    if (ledger.gstin) byGstin.set(ledgerLookupKey(ledger.gstin), ledger);
    if (id) byId.set(id, ledger);
    for (const token of new Set(name.split(/\s+/).filter((item) => item.length > 2))) {
      const values = byToken.get(token) || [];
      if (values.length < 500) values.push(ledger);
      byToken.set(token, values);
    }
  }
  return { rows, byName, byGstin, byId, byToken };
}

function shortlistLedgers(query, lookup, savedMappings = []) {
  const name = ledgerLookupKey(query?.name || query);
  const gstin = ledgerLookupKey(query?.gstin);
  const candidates = [];
  const seen = new Set();
  const add = (ledger) => {
    const id = String(ledger?.guid || ledger?.masterId || ledger?.id || ledger?.name || "");
    if (id && !seen.has(id)) { seen.add(id); candidates.push(ledger); }
  };
  add(lookup.byGstin.get(gstin));
  add(lookup.byName.get(name));
  for (const mapping of savedMappings || []) {
    if (ledgerLookupKey(mapping.source) === name) add(lookup.byId.get(String(mapping.masterId || "")));
  }
  for (const token of name.split(/\s+/).filter((item) => item.length > 2)) {
    for (const ledger of lookup.byToken.get(token) || []) {
      add(ledger);
      if (candidates.length >= 500) return candidates;
    }
  }
  return candidates;
}

export function canonicalDatasetStatuses(datasets = [], config = {}) {
  const organizationId = String(config.organizationId || "default");
  const installationId = String(config.installationId || config.bridgeMachineId || "");
  const selected = new Map();
  for (const dataset of datasets) {
    const identity = dataset?.identity || {};
    if (String(identity.organizationId || "default") !== organizationId) continue;
    if (installationId && String(identity.installationId || "") !== installationId) continue;
    const canonicalIdentity = {
      ...identity,
      organizationId,
      installationId: installationId || identity.installationId,
      connectionId: config.connectionId || identity.connectionId,
      sessionGeneration: Number(config.sessionGeneration ?? identity.sessionGeneration ?? 0),
    };
    const key = datasetKey(canonicalIdentity);
    if (!key) continue;
    const current = selected.get(key);
    const score = (row) => (row?.status === "ready" ? 3 : row?.status === "syncing" ? 2 : 1);
    const currentTime = Date.parse(current?.last_sync_at || current?.updated_at || 0) || 0;
    const nextTime = Date.parse(dataset.last_sync_at || dataset.updated_at || 0) || 0;
    if (!current || score(dataset) > score(current) || (score(dataset) === score(current) && nextTime >= currentTime)) {
      selected.set(key, { ...dataset, dataset_key: key, identity: canonicalIdentity });
    }
  }
  return [...selected.values()];
}

export class LocalAgentRuntime {
  constructor({ config, baseDirectory = defaultAgentDirectory(), keyHex, safeStorage, tallyExecutor, onProgress, onLog }) {
    this.config = config;
    this.baseDirectory = baseDirectory;
    // Repair legacy permissions before attempting to read the DPAPI key.
    prepareLocalAgentDirectoryAcl(baseDirectory);
    this.keyHex = keyHex || resolveLocalAgentKey({ baseDirectory, safeStorage });
    this.storage = new LocalAgentStorage({ baseDirectory, keyHex: this.keyHex });
    this.gateway = new TallyAgentGateway({ tallyUrl: config.tallyUrl, execute: tallyExecutor });
    this.sync = new IncrementalSyncEngine({ storage: this.storage, gateway: this.gateway });
    this.browserUpload = new BrowserDocumentUpload({ temporaryDirectory: this.storage.paths.temporary });
    this.vectors = new LocalVectorService({ vectorsDirectory: this.storage.paths.vectors, enabled: false });
    this.documents = new LocalDocumentService({ temporaryDirectory: this.storage.paths.temporary, browserUpload: this.browserUpload,
      suggestLedgerBatch: (queries, options) => this.suggestLedgerBatch(queries, options) });
    this.scheduler = new AgentJobScheduler({ storage: this.storage });
    // Used only by a scan that already holds the Tally queue.
    this.directGateway = new TallyAgentGateway({ tallyUrl: config.tallyUrl });
    this.receivables = new ReceivablesPreparer({
      storage: this.storage,
      invoke: (xml, options) => this.gateway.invoke(xml, options),
      onProgress: (progress) => this.onProgress?.(progress),
      onLog: (level, message) => this.onLog?.(level, message),
      // The Payment Follow-ups page watches this revision to refresh itself.
      onChanged: (key, state) => void this.storage.call("setSetting", {
        key: `followup-last-change:${key}`,
        value: { changedAt: new Date().toISOString(), cursor: Number(state.watermark || 0) },
      }).catch(() => {}),
    });
    this.onProgress = onProgress;
    this.onLog = onLog;
    this.started = false;
    this.lastWatermarkAt = 0;
    this.activeIdentity = null;
    this.activeIdentityObservedAt = 0;
    this.ledgerLookupCache = new Map();
    this.vectorIndexCheckedAt = new Map();
    this.vectorIndexPromises = new Map();
    this.datasetSyncPromises = new Map();
    this.fallbackCatalogueLogKeys = new Set();

    this.scheduler.register("agent_sync_dataset", async (job, progress) => {
      const result = await this.syncDataset(job.identity, { progress });
      this.ledgerLookupCache.delete(datasetKey(job.identity));
      await this.ensureVectorIndex(job.identity, progress, { force: true }).catch((error) => this.onLog?.("warn", `Local ledger index: ${error.message}`));
      return result;
    });
    this.scheduler.register("agent_sync_followup_changes", async (job, progress) => {
      const key = datasetKey(job.identity);
      const cursorKey = `followup-voucher-alter-id:${key}`;
      const savedCursor = await this.storage.call("getSetting", { key: cursorKey, fallback: null });
      if (savedCursor === null) {
        const { dateFrom, dateTo } = financialYearDates(job.identity.financialYear);
        const latest = await this.gateway.workflowVouchers(job.identity, {
          workflow: "payment_followups", dateFrom, dateTo, afterAlterId: 0, limit: 1, newestFirst: true,
        });
        const baseline = latest.reduce((highest, voucher) => Math.max(highest, Number(voucher.alterId || 0)), 0);
        await this.storage.call("setSetting", { key: cursorKey, value: baseline });
        // The first watcher run deliberately avoids exporting years of voucher
        // history. Expire the aggregate view once so its next read establishes
        // a fresh open-bill baseline; later runs process only AlterID deltas.
        await this.invalidateWorkflowSnapshots("cash_discount");
        await this.invalidateWorkflowSnapshots("open_bills");
        return { changed: 0, affectedLedgers: 0, cursor: baseline, baseline: true };
      }
      let cursor = Number(savedCursor) || 0;
      const changed = [];
      const { dateFrom, dateTo } = financialYearDates(job.identity.financialYear);
      for (;;) {
        await progress({ phase: "checking_followup_changes", processed: changed.length, total: null });
        const page = await this.gateway.workflowVouchers(job.identity, {
          workflow: "payment_followups", dateFrom, dateTo, afterAlterId: cursor, limit: 50,
        });
        if (!page.length) break;
        const nextCursor = page.reduce((highest, voucher) => Math.max(highest, Number(voucher.alterId || 0)), cursor);
        if (nextCursor <= cursor) throw new Error("Tally returned a non-advancing payment voucher AlterID page.");
        changed.push(...page);
        cursor = nextCursor;
        await this.storage.call("setSetting", { key: cursorKey, value: cursor });
        if (page.length < 50) break;
      }
      if (!changed.length) return { changed: 0, affectedLedgers: 0, cursor };
      const [masters, groups] = await Promise.all([
        this.storage.call("listMasters", { datasetKey: key, masterType: "ledger" }),
        this.storage.call("listMasters", { datasetKey: key, masterType: "group" }),
      ]);
      const groupParents = new Map(groups.map((group) => [ledgerLookupKey(group.name), group.parent]));
      const belongsToDebtors = (ledger) => {
        let parent = String(ledger.parent || "");
        const visited = new Set();
        while (parent && !visited.has(ledgerLookupKey(parent))) {
          if (/sundry\s+debtors/i.test(parent)) return true;
          visited.add(ledgerLookupKey(parent));
          parent = String(groupParents.get(ledgerLookupKey(parent)) || "");
        }
        return false;
      };
      const debtorNames = new Map(masters
        .filter(belongsToDebtors)
        .map((ledger) => [ledgerLookupKey(ledger.name), ledger.name]));
      const affectedLedgers = [...new Set(changed.flatMap((voucher) => [voucher.partyLedgerName, ...(voucher.ledgerNames || [])])
        .map((name) => debtorNames.get(ledgerLookupKey(name)))
        .filter(Boolean))];
      if (affectedLedgers.length) {
        // Re-read the complete outstanding set for only the affected parties.
        // An older carry-forward bill can be settled by a voucher altered today.
        const bills = await this.gateway.openBills(job.identity, {
          ledgerNames: affectedLedgers, dateTo: new Date().toISOString().slice(0, 10),
        });
        for (const ledgerName of affectedLedgers) {
          await this.storage.call("replaceOpenBills", {
            datasetKey: key, ledgerKey: ledgerName,
            bills: bills.filter((bill) => ledgerLookupKey(bill.ledgerName) === ledgerLookupKey(ledgerName)),
          });
        }
      }
      await this.invalidateWorkflowSnapshots("cash_discount");
      await this.invalidateWorkflowSnapshots("open_bills");
      await this.storage.call("setSetting", { key: `followup-last-change:${key}`, value: {
        changedAt: new Date().toISOString(), cursor, affectedLedgers,
      } });
      return { changed: changed.length, affectedLedgers: affectedLedgers.length, cursor };
    });
    this.scheduler.register("agent_reconcile_dataset", async (job, progress) => {
      const result = await this.syncDataset(job.identity, { forceReconcile: true, progress });
      this.ledgerLookupCache.delete(datasetKey(job.identity));
      await this.ensureVectorIndex(job.identity, progress, { force: true }).catch((error) => this.onLog?.("warn", `Local ledger index: ${error.message}`));
      return result;
    });
    this.scheduler.register("agent_parse_document", async (job, progress) => {
      await progress({ phase: "downloading_document", processed: 0, total: 1 });
      const result = await this.documents.parse(job.payload);
      await progress({ phase: "document_parsed", processed: 1, total: 1 });
      return { ...result, markdownGzip: undefined, markdown: undefined };
    });
    this.scheduler.register("agent_vector_suggest", async (job, progress) => {
      await progress({ phase: "vector_matching", processed: 0, total: 1 });
      return this.suggestLedgers(job.payload.query, {
        identity: job.identity,
        ledgers: job.payload.ledgers,
        savedMappings: job.payload.savedMappings,
      });
    });
    this.scheduler.register("agent_cache_maintenance", () => this.runMaintenance());
    this.scheduler.register("agent_clear_cache", () => this.storage.call("clearRebuildableCache"));
    this.scheduler.register("agent_update_settings", (job) => this.updateSettings(job.payload?.settings || {}));
    this.scheduler.register("agent_rebuild_cache", async (job, progress) => {
      await this.storage.call("clearRebuildableCache");
      return this.syncDataset(job.identity, { progress });
    });
    this.scheduler.register("agent_diagnostics", () => this.status());
    this.scheduler.register("agent_query_open_bills", async (job, progress) => {
      await progress({ phase: "reading_open_bills", processed: 0, total: null });
      const bills = await this.gateway.openBills(job.identity, job.payload);
      const key = datasetKey(job.identity);
      for (const ledgerName of job.payload.ledgerNames || []) {
        await this.storage.call("replaceOpenBills", { datasetKey: key, ledgerKey: ledgerName, bills: bills.filter((bill) => bill.ledgerName === ledgerName) });
      }
      return { bills, cachedAt: new Date().toISOString() };
    });
    this.scheduler.register("agent_query_workflow_vouchers", async (job, progress) => {
      await progress({ phase: `reading_${job.payload.workflow || "workflow"}_vouchers`, processed: 0, total: null });
      const vouchers = await this.gateway.workflowVouchers(job.identity, job.payload);
      return { workflow: job.payload.workflow, vouchers, cachedAt: new Date().toISOString() };
    });
    this.scheduler.register("agent_voucher_identity", (job) => this.gateway.voucherIdentity(job.identity, job.payload));
    this.scheduler.onProgress((progress) => this.onProgress?.(progress));
  }

  supports(commandType) { return AGENT_COMMANDS.has(commandType); }

  async start() {
    if (this.started) return;
    await this.storage.call("health");
    await this.runMaintenance();
    const pendingVectorCleanup = await this.storage.call("getSetting", { key: "pendingVectorCleanup", fallback: [] });
    for (const oldDatasetKey of pendingVectorCleanup || []) this.vectors.reset(oldDatasetKey);
    if (pendingVectorCleanup?.length) {
      await this.storage.call("setSetting", { key: "pendingVectorCleanup", value: [] });
    }
    await this.browserUpload.start();
    this.started = true;
    void this.scheduler.start().catch((error) => this.onLog?.("error", error.message));
  }

  async stop() {
    this.scheduler.stop();
    await this.vectors.stop();
    await this.browserUpload.stop();
    await this.storage.close();
    this.started = false;
  }

  async status() {
    const active = this.scheduler.activeJob;
    const [storage, datasets, settings, activeJob] = await Promise.all([
      this.storage.call("health"), this.storage.call("listDatasets"), this.settings(),
      active ? this.storage.call("getJob", { id: active.id }) : null,
    ]);
    const canonicalDatasets = canonicalDatasetStatuses(datasets, this.config);
    const datasetsWithWorkflowRevisions = await Promise.all(canonicalDatasets.map(async (dataset) => {
      const [followupCursor, followupChange, metrics] = await Promise.all([
        this.storage.call("getSetting", {
          key: `followup-voucher-alter-id:${dataset.dataset_key}`,
          fallback: null,
        }),
        this.storage.call("getSetting", {
          key: `followup-last-change:${dataset.dataset_key}`,
          fallback: null,
        }),
        this.storage.call("getDatasetMetrics", { datasetKey: dataset.dataset_key }),
      ]);
      const followupRevision = Number(followupChange?.cursor ?? followupCursor);
      return {
        ...dataset,
        metrics,
        cacheHealth: {
          ...(dataset.cacheHealth || {}),
          workflowRevisions: {
            ...(dataset.cacheHealth?.workflowRevisions || {}),
            followups: Number.isFinite(followupRevision) ? {
              revision: followupRevision,
              changedAt: followupChange?.changedAt || null,
            } : null,
          },
        },
      };
    }));
    return {
      agentVersion: AGENT_VERSION,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      localSchemaVersion: LOCAL_SCHEMA_VERSION,
      tdlVersion: TDL_REPORT_VERSION,
      capabilities: AGENT_CAPABILITIES,
      resources: resourceSnapshot(),
      storage,
      datasets: datasetsWithWorkflowRevisions,
      settings,
      receivables: await this.activeReceivablesStatus().catch(() => null),
      activeJob: activeJob ? { id: activeJob.id, commandId: activeJob.command_id, jobClass: activeJob.job_class, progress: activeJob.progress } : null,
    };
  }

  async syncActiveDataset({ forceReconcile = false } = {}) {
    const identity = this.activeIdentity;
    if (!identity) throw new Error("Open a company in Tally Prime before synchronizing ledgers.");
    const operation = forceReconcile ? "reconcile" : "sync";
    const progress = async (value = {}) => this.onProgress?.({ ...value, operation, localUi: true });
    const dataset = await this.syncDataset(identity, { forceReconcile, progress });
    const vector = await this.ensureVectorIndex(identity, progress, { force: true });
    return { dataset, vector, identity };
  }

  // Once customer dues are ready, a check only applies what changed in Tally
  // (about a second). The full check runs the first time or when asked for.
  async prepareActiveReceivables({ full = false } = {}) {
    const identity = this.activeIdentity;
    if (!identity) throw new Error("Open a company in Tally Prime first.");
    const key = datasetKey(identity);
    const state = await this.storage.call("getReceivableState", { datasetKey: key });
    if (full || state?.status !== "ready" || financialYearRange(identity.financialYear).label !== state.financialYear) {
      // "Check everything again" starts over; otherwise an interrupted
      // preparation continues where it stopped.
      return this.receivables.prepare(identity, key, { fresh: full });
    }
    this.onProgress?.({ operation: "receivables", localUi: true, phase: "checking_changes", processed: 0, total: null });
    try {
      await this.receivables.checkForChanges(identity, key, { force: true });
    } finally {
      this.onProgress?.({ operation: "receivables", localUi: true, phase: "complete", processed: 1, total: 1 });
    }
    return this.receivables.status(key);
  }

  // Prepared customer dues for a Cash Discount / Follow-up scan, or null when
  // they are not ready for this company and financial year (the scan then
  // reads Tally live). Latest Tally changes are applied first.
  async preparedReceivablesFor({ companyName, financialYear }) {
    const identity = this.activeIdentity;
    if (!identity || String(identity.companyName || "").toLowerCase().replace(/[^a-z0-9]/g, "") !==
      String(companyName || "").toLowerCase().replace(/[^a-z0-9]/g, "")) return null;
    const key = datasetKey(identity);
    const state = await this.storage.call("getReceivableState", { datasetKey: key });
    if (state?.status !== "ready") return null;
    if (financialYear && financialYearRange(financialYear).label !== state.financialYear) return null;
    // Quick delta only: a full customer re-check (after a deletion) takes
    // minutes and runs in the background instead of holding up the scan.
    await this.receivables.checkForChanges(identity, key, {
      force: true,
      allowFullCheck: false,
      invoke: (xml, options) => this.directGateway.invoke(xml, options),
    }).catch((error) => this.onLog?.("warn", `Customer dues check before scan: ${error.message}`));
    // Scans, reminder checks and bank matching all answer from the dues held
    // in memory (loaded once, reloaded only after the dues change).
    const snapshot = await this.receivables.loadSnapshot(key);
    return {
      datasetKey: key,
      state: await this.storage.call("getReceivableState", { datasetKey: key }),
      recordsFor: async (ledgerNames, options) => snapshot.recordsFor(ledgerNames, options),
      allBills: async () => snapshot.allBills(),
    };
  }

  async activeReceivablesStatus() {
    return this.activeIdentity ? this.receivables.status(datasetKey(this.activeIdentity)) : { status: "no_company" };
  }

  async rebuildActiveVectorIndex() {
    const identity = this.activeIdentity;
    if (!identity) throw new Error("Open a company in Tally Prime before updating the matching index.");
    const progress = async (value = {}) => this.onProgress?.({ ...value, operation: "vector", localUi: true });
    const vector = await this.ensureVectorIndex(identity, progress, { force: true });
    return { vector, identity };
  }

  async updateSettings(settings = {}) {
    // Managed settings are intentionally not writable.
    const allowed = ["diagnosticRetentionDays", "markdownRetentionDays", "completedJobRetentionDays", "deliveredOutboxRetentionDays", "workflowSnapshotRetentionDays", "syncIntervalSeconds", "updateChannel"];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        await this.storage.call("setSetting", { key, value: settings[key] });
      }
    }
    return this.settings();
  }

  async settings() {
    const entries = await Promise.all([
      ["diagnosticRetentionDays", 14], ["markdownRetentionDays", 30], ["completedJobRetentionDays", 7],
      ["deliveredOutboxRetentionDays", 7], ["workflowSnapshotRetentionDays", 7],
      ["syncIntervalSeconds", 60], ["updateChannel", "stable"],
    ].map(async ([key, fallback]) => [key, await this.storage.call("getSetting", { key, fallback })]));
    return { ...Object.fromEntries(entries), ...MANAGED_SETTINGS };
  }

  async runMaintenance() {
    const settings = await this.settings();
    const days = (value, fallback) => Math.max(1, Number(value) || fallback) * 86_400_000;
    return this.storage.call("maintenance", {
      cacheLimitBytes: Number(settings.cacheLimitBytes),
      diagnosticsRetentionMs: days(settings.diagnosticRetentionDays, 14),
      completedJobRetentionMs: days(settings.completedJobRetentionDays, 7),
      deliveredOutboxRetentionMs: days(settings.deliveredOutboxRetentionDays, 7),
      workflowSnapshotRetentionMs: days(settings.workflowSnapshotRetentionDays, 7),
    });
  }

  async observeTallyCompanies(companies = []) {
    const company = companies.find((entry) => entry?.isActive && entry?.guid && entry?.financialYear);
    if (!company) return;
    const identity = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      organizationId: this.config.organizationId || "default",
      ownerUserId: this.config.ownerUserId || "unknown",
      connectionId: this.config.connectionId,
      installationId: this.config.installationId || this.config.bridgeMachineId,
      sessionGeneration: Number(this.config.sessionGeneration || 1),
      companyGuid: company.guid,
      companyName: company.companyName,
      financialYear: company.financialYear,
    };
    this.activeIdentity = identity;
    this.activeCompanyProfile = {
      name: company.companyName,
      guid: company.guid,
      gstin: company.gstin || null,
      stateName: company.stateName || null,
      countryName: company.countryName || null,
      stateCode: String(company.gstin || "").match(/^\d{2}/)?.[0] || null,
    };
    this.activeIdentityObservedAt = Date.now();
    void this.ensureVectorIndex(identity)
      .catch((error) => this.onLog?.("warn", `Local ledger index: ${error.message}`));
    // Keeps prepared customer dues current (at most one counter check a minute).
    void this.receivables.checkForChanges(identity, datasetKey(identity))
      .catch((error) => this.onLog?.("warn", `Customer dues check: ${error.message}`));
    // Once per start-up, load the prepared dues into memory in the background,
    // so the first Cash Discount or Follow-ups scan does not wait for it.
    const warmKey = datasetKey(identity);
    if (this.receivablesWarmedKey !== warmKey) {
      this.receivablesWarmedKey = warmKey;
      setTimeout(() => {
        void this.storage.call("getReceivableState", { datasetKey: warmKey })
          .then((state) => state?.status === "ready"
            ? this.receivables.loadSnapshot(warmKey).then(() => undefined)
            : undefined)
          .catch(() => { this.receivablesWarmedKey = null; });
      }, 20_000).unref?.();
    }
    const intervalSeconds = Number(await this.storage.call("getSetting", { key: "syncIntervalSeconds", fallback: 60 })) || 60;
    if (Date.now() - this.lastWatermarkAt < Math.max(15, intervalSeconds) * 1_000 || this.scheduler.busy) return;
    this.lastWatermarkAt = Date.now();
    const key = datasetKey(identity);
    const existing = await this.storage.call("getDataset", { datasetKey: key });
    const cachedPlan = automaticCatalogueSyncPlan(existing);
    if (!cachedPlan.probeCapabilities) {
      if (!this.fallbackCatalogueLogKeys.has(key)) {
        this.fallbackCatalogueLogKeys.add(key);
        this.onLog?.("info", "Using the saved Tally catalogue without automatic fallback scans. Use Refresh or Sync now to check for master changes.");
      }
      return;
    }
    const capabilities = await this.gateway.capabilities(identity);
    const plan = automaticCatalogueSyncPlan(existing, capabilities);
    if (!existing) {
      await this.scheduler.enqueue({ type: "agent_sync_dataset", identity, payload: { reason: "initial_company_observation" }, jobClass: "incremental_sync", priority: 45 });
      return;
    }
    if (!plan.probeCapabilities) return;
    this.fallbackCatalogueLogKeys.delete(key);
    await this.scheduler.enqueue({
      id: `followup-watch:${createHash("sha256").update(key).digest("hex").slice(0, 20)}:${Math.floor(this.lastWatermarkAt / (Math.max(15, intervalSeconds) * 1_000))}`,
      type: "agent_sync_followup_changes", identity, payload: {
        reason: "periodic_voucher_delta_check", highestAlterId: Number(capabilities.highestAlterId || 0),
      },
      jobClass: "incremental_sync", priority: 46,
    });
    if (!plan.sync) return;
    await this.scheduler.enqueue({ type: "agent_sync_dataset", identity, payload: { reason: plan.reason }, jobClass: "incremental_sync", priority: 45 });
  }

  async moduleEnabled(moduleName) {
    return MANAGED_SETTINGS.localDataModules[moduleName] !== false;
  }

  async syncDataset(identity, options = {}) {
    const key = datasetKey(identity);
    if (!key) throw Object.assign(new Error("A verified Tally company and financial year are required for synchronization."), { code: "DATASET_IDENTITY_INCOMPLETE" });
    const syncKey = `${key}:${String(options.cursorNamespace || "full")}`;
    const existing = this.datasetSyncPromises.get(syncKey);
    if (existing) return existing;
    const pending = this.sync.sync(identity, options).finally(() => {
      if (this.datasetSyncPromises.get(syncKey) === pending) this.datasetSyncPromises.delete(syncKey);
    });
    this.datasetSyncPromises.set(syncKey, pending);
    return pending;
  }

  async refreshLocalMasterCatalogue(scope = {}, { moduleName = "bank", signal, progress = async () => {} } = {}) {
    if (!this.activeIdentity || !(await this.moduleEnabled(moduleName))) return null;
    if (scope.companyGuid && String(scope.companyGuid) !== String(this.activeIdentity.companyGuid)) {
      throw Object.assign(new Error("Tally changed company before the local catalogue could be validated."), { code: "COMPANY_CHANGED" });
    }
    if (scope.companyName && String(scope.companyName).trim().toLowerCase() !== String(this.activeIdentity.companyName).trim().toLowerCase()) {
      throw Object.assign(new Error("The requested company is not active in Tally."), { code: "COMPANY_CHANGED" });
    }
    if (normalizeFinancialYear(scope.financialYear) !== normalizeFinancialYear(this.activeIdentity.financialYear)) {
      throw Object.assign(new Error("The requested financial year is not active in the Local Agent."), { code: "FINANCIAL_YEAR_CHANGED" });
    }
    const key = datasetKey(this.activeIdentity);
    const currentDataset = await this.storage.call("getDataset", { datasetKey: key });
    if (!currentDataset || currentDataset.status !== "ready" || currentDataset.quarantined_at) return null;
    const requested = new Set(scope.requestedTypes || ["ledger", "group"]);
    const masterTypes = ["ledger", "stock_item", "group", "unit"].filter((type) =>
      requested.has(type) || (type === "ledger" && (requested.has("gst_ledger") || requested.has("tax_ledger")))
    );
    await progress("Checking Tally for master changes…");
    const dataset = await this.syncDataset(this.activeIdentity, {
      masterTypes,
      cursorNamespace: moduleName === "purchase" ? "purchase" : "",
      fieldProfile: moduleName === "purchase" ? "purchase" : "full",
      signal,
      progress: async (update) => progress(update?.phase === "syncing_masters"
        ? `Checking ${String(update.entityType || "master").replace(/_/g, " ")} changes in Tally…`
        : "Validating the local Tally catalogue…"),
    });
    this.ledgerLookupCache.delete(datasetKey(this.activeIdentity));
    if (Number(dataset?.cacheHealth?.processed || 0) > 0) {
      void this.ensureVectorIndex(this.activeIdentity, async () => {}, { force: true })
        .catch((error) => this.onLog?.("warn", `Local ledger index: ${error.message}`));
    }
    const catalogue = await this.localMasterCatalogue(scope, { moduleName });
    if (!catalogue) throw new Error("The Local Agent could not build a complete master catalogue after synchronization.");
    return catalogue;
  }

  async ensureVectorIndex(identity = this.activeIdentity, progress = async () => {}, options = {}) {
    if (!identity) return { indexed: 0, skipped: true };
    const key = datasetKey(identity);
    const existing = this.vectorIndexPromises.get(key);
    if (existing) return existing;
    const work = this.buildVectorIndex(identity, progress, options);
    this.vectorIndexPromises.set(key, work);
    try {
      return await work;
    } finally {
      if (this.vectorIndexPromises.get(key) === work) this.vectorIndexPromises.delete(key);
    }
  }

  async buildVectorIndex(identity = this.activeIdentity, progress = async () => {}, { force = false } = {}) {
    if (!identity) return { indexed: 0, skipped: true };
    const key = datasetKey(identity);
    if (!force && Date.now() - Number(this.vectorIndexCheckedAt.get(key) || 0) < 30_000) return { indexed: 0, skipped: true, fresh: true };
    const dataset = await this.storage.call("getDataset", { datasetKey: key });
    if (!dataset || dataset.status !== "ready" || dataset.quarantined_at) return { indexed: 0, skipped: true };
    const ledgers = await this.storage.call("listMasters", { datasetKey: key, masterType: "ledger" });
    const metadata = await this.storage.call("getVectorMetadata", { datasetKey: key });
    const incompatible = !metadata || metadata.model_id !== LOCAL_LEDGER_VECTOR_MODEL ||
      Number(metadata.dimensions) !== LOCAL_LEDGER_VECTOR_DIMENSIONS ||
      Number(metadata.index_version) !== LOCAL_LEDGER_VECTOR_INDEX_VERSION;
    if (incompatible) {
      await this.vectors.stop();
      this.vectors.reset(key);
      await this.storage.call("deleteVectorDocumentStates", {
        datasetKey: key,
        entityKeys: (await this.storage.call("listVectorDocumentStates", { datasetKey: key })).map((row) => row.entityKey),
      });
    }
    const previous = new Map((incompatible ? [] : await this.storage.call("listVectorDocumentStates", { datasetKey: key }))
      .map((row) => [String(row.entityKey), row]));
    const activeIds = new Set();
    const changed = [];
    for (const ledger of ledgers) {
      const id = String(ledger.guid || ledger.masterId || ledger.id || ledger.name || "").trim();
      if (!id) continue;
      activeIds.add(id);
      const text = ledgerSearchText(ledger);
      const contentHash = createHash("sha256").update(text).digest("hex");
      if (previous.get(id)?.contentHash === contentHash) continue;
      changed.push({
        id,
        text: `Ledger: ${ledger.name || ""}\nGroup: ${ledger.parent || "Unspecified"}\nDetails: ${text}`,
        entityKey: id,
        contentHash,
        alterId: Number(ledger.alterId || 0),
      });
    }
    const removed = [...previous.keys()].filter((id) => !activeIds.has(id));
    this.vectors.enabled = true;
    for (let offset = 0; offset < changed.length; offset += 256) {
      const batch = changed.slice(offset, offset + 256);
      await progress({ phase: "indexing_ledger_names", processed: offset, total: changed.length });
      const embeddings = await this.requestSemanticEmbeddings(batch.map((document) => document.text));
      const documents = batch.map((document, index) => ({ ...document, embedding: embeddings[index] }));
      await this.vectors.upsert({ datasetKey: key, dimensions: LOCAL_LEDGER_VECTOR_DIMENSIONS, documents });
      await this.storage.call("upsertVectorDocumentStates", { datasetKey: key, documents });
    }
    if (removed.length) {
      await this.vectors.delete({ datasetKey: key, dimensions: LOCAL_LEDGER_VECTOR_DIMENSIONS, ids: removed });
      await this.storage.call("deleteVectorDocumentStates", { datasetKey: key, entityKeys: removed });
    }
    const indexedAlterId = ledgers.reduce((highest, ledger) => Math.max(highest, Number(ledger.alterId || 0)), 0);
    await this.storage.call("putVectorMetadata", {
      datasetKey: key,
      modelId: LOCAL_LEDGER_VECTOR_MODEL,
      dimensions: LOCAL_LEDGER_VECTOR_DIMENSIONS,
      indexVersion: LOCAL_LEDGER_VECTOR_INDEX_VERSION,
      indexedAlterId,
    });
    this.vectorIndexCheckedAt.set(key, Date.now());
    return { indexed: changed.length, removed: removed.length, total: ledgers.length };
  }

  async requestSemanticEmbeddings(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 256) {
      throw new Error("Semantic embedding batches require 1-256 inputs.");
    }
    const response = await fetch(`${this.config.apiBase}/api/tally/bridge/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.bridgeToken}`,
      },
      body: JSON.stringify({ connectionId: this.config.connectionId, inputs }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(payload?.error || `Semantic embedding request failed (${response.status}).`));
    }
    if (
      payload?.model !== LOCAL_LEDGER_VECTOR_MODEL ||
      Number(payload?.dimensions) !== LOCAL_LEDGER_VECTOR_DIMENSIONS ||
      !Array.isArray(payload?.embeddings) ||
      payload.embeddings.length !== inputs.length ||
      payload.embeddings.some((embedding) =>
        !Array.isArray(embedding) ||
        embedding.length !== LOCAL_LEDGER_VECTOR_DIMENSIONS ||
        embedding.some((value) => !Number.isFinite(value))
      )
    ) {
      throw new Error("The semantic embedding service returned an incompatible response.");
    }
    return payload.embeddings;
  }

  async suggestLedgers(query, { identity = this.activeIdentity, ledgers, savedMappings = [] } = {}) {
    if (!identity) return { suggestions: [], deterministic: [], vectorEnabled: false };
    const key = datasetKey(identity);
    const rows = Array.isArray(ledgers) && ledgers.length
      ? ledgers
      : await this.storage.call("listMasters", { datasetKey: key, masterType: "ledger" });
    let lookup = this.ledgerLookupCache.get(key);
    if (!lookup || lookup.rows.length !== rows.length) {
      lookup = buildLedgerLookup(rows);
      this.ledgerLookupCache.set(key, lookup);
    }
    const shortlist = shortlistLedgers(query, lookup, savedMappings);
    const deterministic = deterministicLedgerCandidates(query, shortlist, savedMappings).slice(0, 8);
    await this.ensureVectorIndex(identity);
    this.vectors.enabled = true;
    const [embedding] = await this.requestSemanticEmbeddings([String(query?.name || query || "").trim()]);
    const hits = await this.vectors.query({
      datasetKey: key,
      dimensions: LOCAL_LEDGER_VECTOR_DIMENSIONS,
      embedding,
      topK: 8,
    });
    const byId = new Map(rows.map((ledger) => [String(ledger.guid || ledger.masterId || ledger.id || ledger.name), ledger]));
    const vector = hits.flatMap((hit) => {
      const ledger = byId.get(String(hit.id));
      return ledger ? [{ ledger, score: Number(hit.score || 0), source: "local_vector" }] : [];
    });
    const seen = new Set();
    const suggestions = [...deterministic.filter((item) => item.score >= 0.94), ...vector, ...deterministic]
      .filter((item) => {
        const id = String(item.ledger?.guid || item.ledger?.masterId || item.ledger?.name || "");
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, 8);
    return { suggestions, deterministic: deterministic.slice(0, 5), vectorEnabled: true };
  }

  async suggestLedgerBatch(queries = [], { identity = this.activeIdentity, savedMappings = [] } = {}) {
    if (!identity) return {};
    const key = datasetKey(identity);
    const rows = await this.storage.call("listMasters", { datasetKey: key, masterType: "ledger" });
    let lookup = this.ledgerLookupCache.get(key);
    if (!lookup || lookup.rows.length !== rows.length) {
      lookup = buildLedgerLookup(rows);
      this.ledgerLookupCache.set(key, lookup);
    }
    const prepared = queries.slice(0, 256).map((query, index) => {
      const shortlist = shortlistLedgers(query, lookup, savedMappings);
      return {
        id: String(query.id || query.name || index),
        query,
        deterministic: deterministicLedgerCandidates(query, shortlist, savedMappings).slice(0, 8),
      };
    });
    await this.ensureVectorIndex(identity);
    this.vectors.enabled = true;
    const embeddings = await this.requestSemanticEmbeddings(
      prepared.map((item) => String(item.query?.name || item.query || "").trim())
    );
    const hitBatches = await Promise.all(embeddings.map((embedding) => this.vectors.query({
      datasetKey: key,
      dimensions: LOCAL_LEDGER_VECTOR_DIMENSIONS,
      embedding,
      topK: 8,
    })));
    const byId = new Map(rows.map((ledger) => [String(ledger.guid || ledger.masterId || ledger.id || ledger.name), ledger]));
    return Object.fromEntries(prepared.map((item, index) => {
      const vector = hitBatches[index].flatMap((hit) => {
        const ledger = byId.get(String(hit.id));
        return ledger ? [{ ledger, score: Number(hit.score || 0), source: "openrouter_vector" }] : [];
      });
      const seen = new Set();
      const suggestions = [...item.deterministic.filter((entry) => entry.score >= 0.94), ...vector, ...item.deterministic]
        .filter((entry) => {
          const id = String(entry.ledger?.guid || entry.ledger?.masterId || entry.ledger?.name || "");
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .slice(0, 8);
      return [item.id, {
        suggestions,
        deterministic: item.deterministic.slice(0, 5),
        vectorEnabled: true,
        embeddingModel: LOCAL_LEDGER_VECTOR_MODEL,
      }];
    }));
  }

  async localMasterCatalogue(scope = {}, { moduleName = "bank" } = {}) {
    if (!this.activeIdentity || !(await this.moduleEnabled(moduleName))) return null;
    if (scope.companyGuid && String(scope.companyGuid) !== String(this.activeIdentity.companyGuid)) return null;
    if (scope.companyName && String(scope.companyName).trim().toLowerCase() !== String(this.activeIdentity.companyName).trim().toLowerCase()) return null;
    if (normalizeFinancialYear(scope.financialYear) !== normalizeFinancialYear(this.activeIdentity.financialYear)) return null;
    const key = datasetKey(this.activeIdentity);
    const dataset = await this.storage.call("getDataset", { datasetKey: key });
    if (!dataset || dataset.status !== "ready" || dataset.quarantined_at) return null;
    const requested = new Set(scope.requestedTypes || ["ledger", "group"]);
    const [ledgers, groups, stockItems, units] = await Promise.all([
      requested.has("ledger") ? this.storage.call("listMasters", { datasetKey: key, masterType: "ledger" }) : [],
      requested.has("group") ? this.storage.call("listMasters", { datasetKey: key, masterType: "group" }) : [],
      requested.has("stock_item") ? this.storage.call("listMasters", { datasetKey: key, masterType: "stock_item" }) : [],
      requested.has("unit") ? this.storage.call("listMasters", { datasetKey: key, masterType: "unit" }) : [],
    ]);
    if (requested.has("ledger") && !ledgers.length) return null;
    const totals = { ledger: ledgers.length, group: groups.length, stock_item: stockItems.length, unit: units.length, godown: 0 };
    const validatedAt = dataset.cacheHealth?.validatedAt || dataset.last_sync_at;
    const dataUpdatedAt = dataset.cacheHealth?.dataUpdatedAt || dataset.last_sync_at;
    const completeTypes = ["ledger", "group", "stock_item", "unit"].filter((type) => requested.has(type));
    const catalogueDigest = createHash("sha256").update(JSON.stringify({
      companyGuid: this.activeIdentity.companyGuid,
      financialYear: normalizeFinancialYear(this.activeIdentity.financialYear),
      requestedTypes: [...requested].sort(),
      cursors: dataset.cursors || {},
      totals,
    })).digest("hex");
    return {
      source: "live_tally",
      companyName: this.activeIdentity.companyName,
      financialYear: this.activeIdentity.financialYear,
      fetchedAt: dataUpdatedAt,
      validatedAt,
      companyProfile: this.activeCompanyProfile || { name: this.activeIdentity.companyName, guid: this.activeIdentity.companyGuid },
      requestedMasterTypes: [...requested],
      masters: { ledgers, groups, stockItems, units, godowns: [] },
      ledgers, groups, stockItems, units,
      totals,
      validation: {
        version: 1,
        mode: "incremental_alter_id",
        validatedAt,
        dataUpdatedAt,
        companyGuid: this.activeIdentity.companyGuid,
        financialYear: this.activeIdentity.financialYear,
        cursors: dataset.cursors || {},
        completeTypes,
        catalogueDigest,
      },
      cache: { source: "encrypted_local_agent_incremental", updatedAt: dataUpdatedAt, validatedAt },
    };
  }

  workflowSnapshotKey(workflow, scope) {
    return createHash("sha256").update(JSON.stringify([workflow, scope])).digest("hex");
  }

  async getWorkflowSnapshot(workflow, scope, maxAgeMs = 60_000) {
    if (workflow === "purchase_masters") return null;
    if (!this.activeIdentity || Date.now() - this.activeIdentityObservedAt > 45_000) return null;
    if (scope.companyName && String(scope.companyName).trim().toLowerCase() !== String(this.activeIdentity.companyName).trim().toLowerCase()) return null;
    if (scope.companyGuid && scope.companyGuid !== this.activeIdentity.companyGuid) return null;
    if (normalizeFinancialYear(scope.financialYear) !== normalizeFinancialYear(this.activeIdentity.financialYear)) return null;
    const key = datasetKey(this.activeIdentity);
    if (!key) return null;
    const dataset = await this.storage.call('getDataset', { datasetKey: key });
    if (dataset?.quarantined_at || dataset?.status === 'quarantined') return null;
    const snapshot = await this.storage.call("getWorkflowSnapshot", { datasetKey: key, workflow, snapshotKey: this.workflowSnapshotKey(workflow, scope) });
    if (!snapshot || Date.now() - new Date(snapshot.updatedAt).getTime() > maxAgeMs) return null;
    return { ...snapshot.payload, cache: { source: "encrypted_local_agent", updatedAt: snapshot.updatedAt } };
  }

  async putWorkflowSnapshot(workflow, scope, payload) {
    if (workflow === "purchase_masters") return null;
    if (!this.activeIdentity) return null;
    if (scope.companyGuid && scope.companyGuid !== this.activeIdentity.companyGuid) return null;
    if (normalizeFinancialYear(scope.financialYear) !== normalizeFinancialYear(this.activeIdentity.financialYear)) return null;
    if (String(scope.companyName || '').trim().toLowerCase() !== String(this.activeIdentity.companyName || '').trim().toLowerCase()) return null;
    const key = datasetKey(this.activeIdentity);
    if (!key) return null;
    return this.storage.call("putWorkflowSnapshot", { datasetKey: key, workflow, snapshotKey: this.workflowSnapshotKey(workflow, scope), payload });
  }

  async invalidateWorkflowSnapshots(workflow) {
    const key = this.activeIdentity && datasetKey(this.activeIdentity);
    if (key) await this.storage.call('invalidateWorkflowSnapshots', { datasetKey: key, workflow });
  }

  expectedIdentity(command) {
    return identityFromCommand(command, this.config);
  }

  validateCommandIdentity(command) {
    const supplied = command.identity || command.payload?.agentIdentity;
    if (!supplied || Number(supplied.protocolVersion || 0) < 1) return this.expectedIdentity(command);
    return assertAgentIdentity({
      organizationId: this.config.organizationId || "default",
      connectionId: this.config.connectionId,
      installationId: this.config.installationId || this.config.bridgeMachineId,
      sessionGeneration: this.config.sessionGeneration,
      companyGuid: command.payload?.companyGuid || supplied.companyGuid,
      financialYear: command.payload?.financialYear || supplied.financialYear,
    }, supplied);
  }

  async cachedWriteOutcome(command) {
    const idempotencyKey = String(command.payload?.idempotencyKey || command.idempotencyKey || "").trim();
    if (!idempotencyKey) return null;
    const receipt = await this.storage.call("getReceipt", { idempotencyKey });
    return receipt?.status === "succeeded" ? receipt.result : null;
  }

  async writeReceipt(command) {
    const idempotencyKey = String(command.payload?.idempotencyKey || command.idempotencyKey || "").trim();
    return idempotencyKey ? this.storage.call("getReceipt", { idempotencyKey }) : null;
  }

  async markWriteStarted(command) {
    const idempotencyKey = String(command.payload?.idempotencyKey || command.idempotencyKey || "").trim();
    if (!idempotencyKey) return;
    await this.storage.call("upsertReceipt", { receipt: { idempotencyKey, commandId: command.id, commandType: command.commandType, status: "running", result: null } });
  }

  async recordOutcome(command, outcome) {
    const idempotencyKey = String(command.payload?.idempotencyKey || command.idempotencyKey || "").trim();
    if (idempotencyKey) {
      await this.storage.call("upsertReceipt", { receipt: { idempotencyKey, commandId: command.id, commandType: command.commandType, status: outcome.success ? "succeeded" : "failed", result: outcome } });
    }
    const item = {
      id: randomUUID(),
      commandId: command.id,
      payload: {
        outcome,
        identity: command.identity ?? command.payload?.agentIdentity ?? null,
      },
    };
    await this.storage.call("enqueueOutbox", { item });
    return item;
  }

  acknowledgeOutcome(itemId) { return this.storage.call("acknowledgeOutbox", { id: itemId }); }

  pendingOutcomes(limit = 20) { return this.storage.call("listOutbox", { limit }); }

  retryOutcome(itemId, attempts = 0) {
    const delayMs = Math.min(300_000, 5_000 * (2 ** Math.min(6, Number(attempts || 0))));
    return this.storage.call("failOutbox", { id: itemId, retryAt: Date.now() + delayMs });
  }

  async execute(command) {
    const identity = this.validateCommandIdentity(command);
    const job = await this.scheduler.enqueue({
      // A redelivered command must attach to the existing local job, including
      // its terminal result, rather than create another parser/AI attempt.
      ...(command.payload?.pipelineVersion === 2 && command.commandType === 'agent_parse_document'
        ? { id: command.id } : {}),
      commandId: command.id,
      type: command.commandType,
      identity,
      payload: command.payload || {},
      idempotencyKey: command.idempotencyKey || command.payload?.idempotencyKey || null,
      jobClass: command.jobClass || jobClassForCommand(command.commandType),
      priority: command.priority,
      deadlineAt: command.deadlineAt ? new Date(command.deadlineAt).getTime() : null,
    });
    const timeoutAt = Date.now() + Math.max(10_000, (job.deadline_at || Date.now() + 120_000) - Date.now());
    while (Date.now() < timeoutAt) {
      const current = await this.storage.call("getJob", { id: job.id });
      if (current?.status === "succeeded") return { success: true, result: current.result || {} };
      if (current?.status === "failed") return { success: false, result: {}, error: current.error?.message || "Local Agent job failed." };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { success: false, result: {}, error: "Local Agent job exceeded its deadline." };
  }
}

export function createLocalAgentRuntime(options) {
  return new LocalAgentRuntime(options);
}

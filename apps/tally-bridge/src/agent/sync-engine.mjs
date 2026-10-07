import { datasetKey } from "./identity.mjs";
import { adaptiveBatchSize, resourceSnapshot } from "./resource-policy.mjs";

const RECONCILE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export class IncrementalSyncEngine {
  constructor({ storage, gateway }) {
    this.storage = storage;
    this.gateway = gateway;
  }

  async sync(identity, { forceReconcile = false, masterTypes, cursorNamespace = "", fieldProfile = "full", signal, progress = async () => {} } = {}) {
    const key = datasetKey(identity);
    if (!key) throw Object.assign(new Error("A verified company GUID and financial year are required before local synchronization."), { code: "DATASET_IDENTITY_INCOMPLETE" });
    const capabilities = await this.gateway.capabilities(identity, { signal });
    if (capabilities.companyGuid !== identity.companyGuid) throw Object.assign(new Error("Tally changed company while synchronization was starting."), { code: "COMPANY_CHANGED" });
    let dataset = await this.storage.call("getDataset", { datasetKey: key });
    const cursors = dataset?.cursors || {};
    const reliableGlobalWatermark = capabilities.fallback !== true &&
      Number(capabilities.version || 0) > 0 &&
      Number(capabilities.highestAlterId || 0) > 0;
    if (dataset && reliableGlobalWatermark && Number(capabilities.highestAlterId || 0) < Math.max(0, ...Object.values(cursors).map(Number))) {
      await this.storage.call("quarantineDataset", { datasetKey: key, reason: "Tally AlterID moved backwards, which indicates a restored company backup." });
      await this.storage.call("resetDatasetData", { datasetKey: key });
      dataset = null;
    }
    if (!dataset) await this.storage.call("upsertDataset", { datasetKey: key, identity, status: "syncing", cursors: {} });
    const nextCursors = { ...(dataset?.cursors || {}) };
    const supportedTypes = new Set(["ledger", "stock_item", "group", "unit"]);
    const types = Array.isArray(masterTypes) && masterTypes.length
      ? [...new Set(masterTypes.filter((type) => supportedTypes.has(type)))]
      : [...supportedTypes];
    if (!types.length) throw new Error("No supported Tally master type was requested for synchronization.");
    let processed = 0;
    const processedByType = {};
    for (let index = 0; index < types.length; index += 1) {
      signal?.throwIfAborted?.();
      const masterType = types[index];
      const cursorKey = cursorNamespace ? `${cursorNamespace}:${masterType}` : masterType;
      let afterAlterId = Number(nextCursors[cursorKey] ?? nextCursors[masterType] ?? 0);
      let hasMore = true;
      while (hasMore) {
        signal?.throwIfAborted?.();
        const batchSize = adaptiveBatchSize({ snapshot: resourceSnapshot() });
        await progress({ phase: "syncing_masters", entityType: masterType, processed, total: null, batchSize });
        let delta = await this.gateway.changedMasters(identity, {
          masterType,
          afterAlterId,
          batchSize,
          fieldProfile: fieldProfile === "full" ? "identity" : fieldProfile,
          signal,
        });
        // On large companies even an empty full Ledger export can be slow
        // because Tally evaluates expensive balance/contact methods. Probe the
        // AlterID window with identity fields first, and fetch full fields only
        // when at least one row actually changed.
        if (fieldProfile === "full" && (delta.masters || []).length > 0) {
          delta = await this.gateway.changedMasters(identity, { masterType, afterAlterId, batchSize, fieldProfile, signal });
        }
        const masters = delta.masters || [];
        await this.storage.call("upsertMasters", {
          datasetKey: key,
          masterType,
          masters,
          mergeExisting: fieldProfile !== "full",
        });
        const nextAlterId = Number(delta.highestAlterId || afterAlterId);
        if (nextAlterId <= afterAlterId && masters.length > 0) {
          throw new Error(`Tally returned a non-advancing ${masterType} AlterID page.`);
        }
        afterAlterId = nextAlterId;
        nextCursors[cursorKey] = afterAlterId;
        processed += masters.length;
        processedByType[masterType] = Number(processedByType[masterType] || 0) + masters.length;
        hasMore = delta.hasMore === true && masters.length > 0;
      }
    }
    const reconciledAt = dataset?.last_reconciled_at ? new Date(dataset.last_reconciled_at).getTime() : 0;
    // A new dataset was just read from AlterID zero, so a second complete pass
    // cannot discover anything new. Reconcile existing datasets weekly to find
    // deletions, and honor explicit maintenance requests.
    const reconcile = forceReconcile || !cursorNamespace && Boolean(dataset) && reconciledAt > 0 && Date.now() - reconciledAt >= RECONCILE_INTERVAL_MS;
    if (reconcile) {
      await progress({ phase: "reconciling", processed, total: null });
      for (const masterType of types) {
        let afterAlterId = 0;
        let hasMore = true;
        const currentKeys = [];
        while (hasMore) {
          signal?.throwIfAborted?.();
          const batchSize = adaptiveBatchSize({ snapshot: resourceSnapshot() });
          const page = await this.gateway.changedMasters(identity, { masterType, afterAlterId, batchSize, fieldProfile: "identity", signal });
          for (const master of page.masters || []) currentKeys.push(String(master.guid || master.masterId || master.name));
          const nextAlterId = Number(page.highestAlterId || afterAlterId);
          hasMore = page.hasMore === true && nextAlterId > afterAlterId;
          afterAlterId = nextAlterId;
        }
        await this.storage.call("reconcileMasterKeys", { datasetKey: key, masterType, currentKeys, alterId: Number(capabilities.highestAlterId || 0) });
      }
    }
    const validatedAt = new Date().toISOString();
    const previousHealth = dataset?.cacheHealth || {};
    return await this.storage.call("markDatasetSync", {
      datasetKey: key,
      cursors: nextCursors,
      cacheHealth: {
        ...previousHealth,
        processed,
        processedByType,
        highestAlterId: capabilities.highestAlterId,
        capabilityVersion: capabilities.version,
        watermarkReliable: reliableGlobalWatermark,
        validatedAt,
        dataUpdatedAt: processed > 0
          ? validatedAt
          : previousHealth.dataUpdatedAt || dataset?.last_sync_at || validatedAt,
      },
      // A dataset created from cursor zero is already a complete key pass. Old
      // pre-v1.1.4 datasets without this marker also get a baseline timestamp
      // without repeating the entire catalogue read on their first validation.
      reconciled: reconcile || !dataset || !dataset?.last_reconciled_at,
    });
  }
}

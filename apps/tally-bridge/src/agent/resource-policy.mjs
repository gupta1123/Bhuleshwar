import os from "node:os";

export const RESOURCE_LIMITS = Object.freeze({
  minimumFreeBytes: 750 * 1024 * 1024,
  lowMemoryBytes: 1024 * 1024 * 1024,
  comfortableMemoryBytes: 2 * 1024 * 1024 * 1024,
  defaultBatchSize: 50,
  lowMemoryBatchSize: 25,
  criticalBatchSize: 10,
  tallySlowMs: 8_000,
  tallyFastMs: 3_000,
});

export function resourceSnapshot() {
  const memory = process.memoryUsage();
  return {
    totalSystemBytes: os.totalmem(),
    freeSystemBytes: os.freemem(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    cpuCount: os.cpus().length,
    capturedAt: new Date().toISOString(),
  };
}

export function shouldPauseBackgroundWork(snapshot = resourceSnapshot()) {
  return snapshot.freeSystemBytes < RESOURCE_LIMITS.minimumFreeBytes;
}

export function adaptiveBatchSize({ snapshot = resourceSnapshot(), recentTallyMs = 0 } = {}) {
  if (snapshot.freeSystemBytes < RESOURCE_LIMITS.lowMemoryBytes || recentTallyMs >= RESOURCE_LIMITS.tallySlowMs) {
    return snapshot.freeSystemBytes < RESOURCE_LIMITS.minimumFreeBytes
      ? RESOURCE_LIMITS.criticalBatchSize
      : RESOURCE_LIMITS.lowMemoryBatchSize;
  }
  return RESOURCE_LIMITS.defaultBatchSize;
}


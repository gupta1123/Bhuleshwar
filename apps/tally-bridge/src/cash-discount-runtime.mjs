import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInlinePriorityScheduler } from "./agent/scheduler.mjs";

export const cashDiscountReadContext = new AsyncLocalStorage();
export const CASH_DISCOUNT_READ_MS = 20_000;
export const CASH_DISCOUNT_SCAN_MS = 90_000;
export const CASH_DISCOUNT_XML_BYTES = 8 * 1024 * 1024;
export const CASH_DISCOUNT_RESULT_BYTES = 4 * 1024 * 1024;
const BENCHMARK_DIRECTORY = process.env.KALIKA_BENCHMARK_DIRECTORY ||
  path.join(os.homedir(), ".autodealer-tally-bridge", "diagnostics");
export const BENCHMARK_DIAGNOSTICS_ENABLED = process.env.KALIKA_BENCHMARK_DIAGNOSTICS === "1" ||
  fs.existsSync(path.join(os.homedir(), ".autodealer-tally-bridge", "diagnostics.enabled"));

function memorySample() {
  const memory = process.memoryUsage();
  return {
    atMs: performance.now(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    systemFreeBytes: os.freemem(),
  };
}

export function createConnectorBenchmarkTrace({ requestId, operation, companyName } = {}) {
  if (!BENCHMARK_DIAGNOSTICS_ENABLED && !['cash_discount_scan','cash_discount_revalidate','verify_bank_transaction','fetch_customer_open_bills'].includes(operation)) return null;
  const startedAt = performance.now();
  const startedCpu = process.cpuUsage();
  const samples = [memorySample()];
  const trace = {
    schemaVersion: 1,
    requestId: String(requestId || "unknown"),
    operation: String(operation || "unknown"),
    companyName: String(companyName || "") || null,
    startedAtIso: new Date().toISOString(),
    startedAt,
    stages: {},
    tallyReads: [],
    samples,
    sampleTimer: null,
    startedCpu,
  };
  trace.sampleTimer = setInterval(() => { if (samples.length < 1000) samples.push(memorySample()); }, 500);
  trace.sampleTimer.unref?.();
  return trace;
}

export function markConnectorBenchmarkStage(trace, name, durationMs) {
  if (!trace) return;
  trace.stages[String(name)] = Number(Number(durationMs || 0).toFixed(2));
}

export function recordConnectorTallyRead(trace, read) {
  if (!trace) return;
  trace.tallyReads.push({
    label: String(read.label || "Tally export"),
    durationMs: Number(Number(read.durationMs || 0).toFixed(2)),
    requestBytes: Number(read.requestBytes || 0),
    responseBytes: Number(read.responseBytes || 0),
    success: read.success === true,
    error: read.error ? String(read.error).slice(0, 500) : null,
  });
}

export function finishConnectorBenchmarkTrace(trace, { success, error } = {}) {
  if (!trace) return null;
  if (trace.sampleTimer) clearInterval(trace.sampleTimer);
  trace.samples.push(memorySample());
  const totalMs = performance.now() - trace.startedAt;
  const cpu = process.cpuUsage(trace.startedCpu);
  const maximum = (field) => Math.max(...trace.samples.map((sample) => Number(sample[field] || 0)));
  const summary = {
    schemaVersion: trace.schemaVersion,
    requestId: trace.requestId,
    operation: trace.operation,
    companyName: trace.companyName,
    startedAt: trace.startedAtIso,
    completedAt: new Date().toISOString(),
    success: success === true,
    error: error ? String(error).slice(0, 1000) : null,
    totalMs: Number(totalMs.toFixed(2)),
    stages: trace.stages,
    tally: {
      callCount: trace.tallyReads.length,
      totalReadMs: Number(trace.tallyReads.reduce((sum, read) => sum + read.durationMs, 0).toFixed(2)),
      requestBytes: trace.tallyReads.reduce((sum, read) => sum + read.requestBytes, 0),
      responseBytes: trace.tallyReads.reduce((sum, read) => sum + read.responseBytes, 0),
      reads: trace.tallyReads,
    },
    connector: {
      cpuUserMs: Number((cpu.user / 1000).toFixed(2)),
      cpuSystemMs: Number((cpu.system / 1000).toFixed(2)),
      peakRssBytes: maximum("rssBytes"),
      peakHeapUsedBytes: maximum("heapUsedBytes"),
      peakExternalBytes: maximum("externalBytes"),
      minimumSystemFreeBytes: Math.min(...trace.samples.map((sample) => sample.systemFreeBytes)),
      sampleCount: trace.samples.length,
    },
  };
  if (!BENCHMARK_DIAGNOSTICS_ENABLED) {
    delete summary.tally.reads;
    return summary;
  }
  try {
    fs.mkdirSync(BENCHMARK_DIRECTORY, { recursive: true });
    const safeId = trace.requestId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
    const filePath = path.join(BENCHMARK_DIRECTORY, `${Date.now()}-${safeId}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    summary.localTraceWritten = true;
  } catch (writeError) {
    summary.localWriteError = writeError instanceof Error ? writeError.message : String(writeError);
  }
  return summary;
}

// Used only for explicit continuation of a partial scan, never for posting or
// a full Refresh. Fresh bill fingerprints and verified company GUIDs form keys.
export function createCashDiscountResultCache({ maxBytes = CASH_DISCOUNT_RESULT_BYTES, ttlMs = 300_000, now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = (key) => { const entry = entries.get(key); if (entry) bytes -= entry.bytes; entries.delete(key); };
  return {
    clear() { entries.clear(); bytes = 0; },
    get(key) {
      const entry = entries.get(key);
      if (!entry || now() - entry.at > ttlMs) { remove(key); return null; }
      return structuredClone(entry.value);
    },
    set(key, value) {
      const size = Buffer.byteLength(JSON.stringify(value));
      if (!key || size > maxBytes) return;
      remove(key);
      while (bytes + size > maxBytes) remove(entries.keys().next().value);
      entries.set(key, { bytes: size, at: now(), value: structuredClone(value) });
      bytes += size;
    },
  };
}

export function checkReadBudget(context = cashDiscountReadContext.getStore()) {
  context?.signal?.throwIfAborted();
  if (context?.deadlineAt <= Date.now()) throw new Error("Cash Discount scan reached its time budget. Remaining customers need review.");
}

// Bound bytes while streaming, BEFORE building a large string or parsing XML.
export async function readBoundedXml(response, limit = CASH_DISCOUNT_XML_BYTES) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Tally response exceeded the safe Cash Discount size limit.");
  }
  if (!response.body) throw new Error("Tally returned an empty response.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Tally response exceeded the safe Cash Discount size limit.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// One FIFO for Tally HTTP work. Waiting jobs are cancellable and expire before
// executing, so retrying in the browser cannot leave orphaned scans behind.
export function createTallyScheduler() {
  return createInlinePriorityScheduler();
}

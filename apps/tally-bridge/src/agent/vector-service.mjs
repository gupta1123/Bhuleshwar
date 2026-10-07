import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const VECTOR_IDLE_STOP_MS = 3 * 60_000;
const WORKER_PATH =path.join(path.dirname(fileURLToPath(import.meta.url)), "vector-worker.mjs");

function normalized(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-IN").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export const LOCAL_LEDGER_VECTOR_MODEL = "openai/text-embedding-3-small";
export const LOCAL_LEDGER_VECTOR_DIMENSIONS = 512;
export const LOCAL_LEDGER_VECTOR_INDEX_VERSION = 3;

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function ledgerSearchText(ledger = {}) {
  return [ledger.name, ledger.parent, ledger.gstin, ledger.alias, ledger.mailingName, ledger.stateName, ledger.countryName]
    .map(normalized).filter(Boolean).join(" ");
}

// A deterministic local embedding: word and character n-grams provide useful
// typo/alias similarity without sending company masters to a paid API.
export function localLedgerEmbedding(value, dimensions = LOCAL_LEDGER_VECTOR_DIMENSIONS) {
  const text = normalized(typeof value === "string" ? value : ledgerSearchText(value));
  const words = text.split(/\s+/).filter(Boolean);
  const features = [...words, ...words.flatMap((word) => {
    const padded = `^${word}$`;
    const grams = [];
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index + size <= padded.length; index += 1) grams.push(padded.slice(index, index + size));
    }
    return grams;
  })];
  const vector = Array(dimensions).fill(0);
  for (const feature of features) {
    const hash = hashToken(feature);
    vector[hash % dimensions] += (hash & 0x80000000) ? -1 : 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => item / magnitude);
}

function editDistance(left, right) {
  const a = normalized(left); const b = normalized(right);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[b.length];
}

export function deterministicLedgerCandidates(query, ledgers, savedMappings = []) {
  const q = normalized(query?.name || query);
  const gstin = normalized(query?.gstin);
  const mappedId = savedMappings.find((mapping) => normalized(mapping.source) === q)?.masterId;
  return (ledgers || []).map((ledger) => {
    const exactId = gstin && normalized(ledger.gstin) === gstin;
    const saved = mappedId && String(ledger.guid || ledger.masterId) === String(mappedId);
    const exactName = normalized(ledger.name) === q;
    const denominator = Math.max(q.length, normalized(ledger.name).length, 1);
    const fuzzy = 1 - editDistance(q, ledger.name) / denominator;
    return { ledger, source: exactId ? "exact_identifier" : saved ? "saved_mapping" : exactName ? "exact_name" : "fuzzy", score: exactId ? 1 : saved ? 0.999 : exactName ? 0.998 : fuzzy };
  }).sort((left, right) => right.score - left.score);
}

export class LocalVectorService {
  #child = null;
  #pending = new Map();

  constructor({ vectorsDirectory, enabled = false }) {
    this.vectorsDirectory = vectorsDirectory;
    this.enabled = enabled;
  }

  #ensureChild() {
    if (this.#child) return;
    this.#child = fork(WORKER_PATH, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: ["--max-old-space-size=256"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
    });
    this.#child.on("message", ({ id, result, error }) => {
      const pending = this.#pending.get(id); if (!pending) return;
      this.#pending.delete(id);
      if (error) { const failure = new Error(error.message); failure.code = error.code; pending.reject(failure); }
      else pending.resolve(result);
    });
    this.#child.on("exit", () => { this.#child = null; for (const pending of this.#pending.values()) pending.reject(new Error("The local vector worker stopped.")); this.#pending.clear(); });
  }

  call(operation, payload) {
    if (!this.enabled) return Promise.reject(Object.assign(new Error("Local vector suggestions are disabled."), { code: "VECTOR_DISABLED" }));
    this.#ensureChild();
    clearTimeout(this.#idleTimer);
    const id = randomUUID();
    const request = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.send({ id, operation, ...payload });
    });
    return request.finally(() => this.#scheduleIdleStop());
  }

  // The worker holds the index in memory (up to its 256 MB heap). Release it
  // once no suggestions have been requested for a while; the next call
  // restarts it transparently.
  #idleTimer = null;
  #scheduleIdleStop() {
    clearTimeout(this.#idleTimer);
    if (this.#pending.size) return;
    this.#idleTimer = setTimeout(() => {
      if (!this.#pending.size) void this.stop();
    }, VECTOR_IDLE_STOP_MS);
    this.#idleTimer.unref?.();
  }

  indexPath(datasetKey) {
    const identityHash = createHash("sha256").update(String(datasetKey)).digest("hex");
    return path.join(this.vectorsDirectory, identityHash);
  }
  upsert({ datasetKey, dimensions, documents }) { return this.call("upsert", { indexPath: this.indexPath(datasetKey), dimensions, documents }); }
  delete({ datasetKey, dimensions, ids }) { return this.call("delete", { indexPath: this.indexPath(datasetKey), dimensions, ids }); }
  query({ datasetKey, dimensions, embedding, topK = 5 }) { return this.call("query", { indexPath: this.indexPath(datasetKey), dimensions, embedding, topK }); }
  reset(datasetKey) { fs.rmSync(this.indexPath(datasetKey), { recursive: true, force: true }); }
  async stop() {
    clearTimeout(this.#idleTimer);
    const child = this.#child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
    if (this.#child === child) this.#child = null;
  }
}

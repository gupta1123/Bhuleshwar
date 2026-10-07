import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function suggestionName(item) {
  return item?.ledger?.name || item?.ledger?.masterName || item?.name || null;
}

const pdfPath = path.resolve(process.env.KALIKA_BENCHMARK_PDF || process.argv[2] || "");
const manifestInput = process.env.KALIKA_BENCHMARK_MANIFEST || process.argv[3];
const outputInput = process.env.KALIKA_BENCHMARK_OUTPUT || process.argv[4];
const manifestPath = manifestInput ? path.resolve(manifestInput) : null;
const outputPath = outputInput ? path.resolve(outputInput) : null;
const progressPath = outputPath ? `${outputPath}.progress.log` : null;
const mark = (message) => {
  if (progressPath) fs.appendFileSync(progressPath, `${new Date().toISOString()} ${message}\n`);
};
if (!pdfPath || !fs.existsSync(pdfPath)) throw new Error("Pass an existing PDF path as the first argument.");

let electronApp = null;
let safeStorage = null;
let createLocalAgentRuntime = null;
let parseDocumentLocal = null;
let readConfig = null;
if (process.versions.electron) {
  ({ app: electronApp, safeStorage } = await import("electron"));
  await electronApp.whenReady();
  const packagedBridge = "../../../../installer/tally-bridge/output/win-unpacked/resources/app.asar/node_modules/@autodealer/tally-bridge/src";
  ({ createLocalAgentRuntime } = await import(`${packagedBridge}/agent/runtime.mjs`));
  ({ parseDocumentLocal } = await import("../document-parsing/parser.mjs"));
  ({ readConfig } = await import("../bridge.mjs"));
} else {
  ({ createLocalAgentRuntime } = await import("./runtime.mjs"));
  ({ parseDocumentLocal } = await import("../document-parsing/parser.mjs"));
  ({ readConfig } = await import("../bridge.mjs"));
}
const config = readConfig();
if (!config) throw new Error("Kalika Local Agent is not paired/configured on this machine.");
const runtime = createLocalAgentRuntime({ config, safeStorage, onLog: () => {} });
try {
  mark("runtime-created");
  const status = await runtime.status();
  mark("status-loaded");
  const datasets = status.datasets || [];
  const dataset = datasets.find((item) => normalize(item.identity?.companyName || item.company_name || item.companyName) === "solution nyx") || datasets[0];
  if (!dataset) throw new Error("No local Tally dataset is available.");
  const identity = {
    ...dataset.identity,
    organizationId: dataset.identity?.organizationId || dataset.organization_id || dataset.organizationId || config.organizationId,
    companyGuid: dataset.identity?.companyGuid || dataset.company_guid || dataset.companyGuid,
    companyName: dataset.identity?.companyName || dataset.company_name || dataset.companyName,
    financialYear: dataset.identity?.financialYear || dataset.financial_year || dataset.financialYear,
  };
  runtime.activeIdentity = identity;

  const parseStarted = performance.now();
  const parsed = await parseDocumentLocal({ filePath: pdfPath, output: "json" });
  mark("pdf-parsed");
  const parseWallMs = performance.now() - parseStarted;
  const transactions = parsed?.content?.transactions || [];

  let expectedRows = [];
  if (manifestPath && fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expectedRows = (manifest.tests || []).find((test) => test.file === path.basename(pdfPath))?.rows || [];
  }

  const queries = transactions.map((transaction, index) => ({
    id: String(index),
    name: transaction.description,
    description: transaction.description,
    referenceNumber: transaction.reference_number,
    amount: transaction.credit_amount || transaction.debit_amount,
  }));
  const suggestionStarted = performance.now();
  const batch = await runtime.suggestLedgerBatch(queries, { identity });
  mark("suggestions-complete");
  const suggestionWallMs = performance.now() - suggestionStarted;

  const rows = transactions.map((transaction, index) => {
    const expected = expectedRows[index]?.party || null;
    const response = batch[String(index)] || {};
    const suggestions = (response.suggestions || []).slice(0, 5).map((item) => ({
      name: suggestionName(item), score: item.score, source: item.source,
    }));
    const expectedNormalized = normalize(expected);
    const ranks = suggestions.map((item) => normalize(item.name));
    return {
      row: index + 1,
      description: transaction.description,
      expected,
      suggestions,
      expectedRank: expected ? (ranks.indexOf(expectedNormalized) >= 0 ? ranks.indexOf(expectedNormalized) + 1 : null) : null,
    };
  });
  const measured = rows.filter((row) => row.expected);
  const result = {
    generatedAt: new Date().toISOString(),
    pdf: pdfPath,
    dataset: {
      companyName: identity.companyName,
      financialYear: identity.financialYear,
      ledgerCount: dataset.metrics?.ledgerCount ?? dataset.metrics?.ledger_count ?? dataset.ledger_count ?? null,
      vectorCount: dataset.metrics?.vectorCount ?? dataset.metrics?.vector_count ?? dataset.vector_count ?? null,
    },
    parser: {
      transactions: transactions.length,
      reportedMs: parsed?.metadata?.durationMs ?? null,
      wallMs: Number(parseWallMs.toFixed(2)),
      pipeline: parsed?.metadata?.diagnostics?.pipeline ?? null,
    },
    suggestions: {
      vectorEnabled: Object.values(batch)[0]?.vectorEnabled === true,
      embeddingModel: Object.values(batch)[0]?.embeddingModel || null,
      batchWallMs: Number(suggestionWallMs.toFixed(2)),
      averagePerRowMs: Number((suggestionWallMs / Math.max(1, transactions.length)).toFixed(2)),
      estimatedP50PerRowMs: Number((suggestionWallMs / Math.max(1, transactions.length)).toFixed(2)),
      top1Correct: measured.filter((row) => row.expectedRank === 1).length,
      top3Correct: measured.filter((row) => row.expectedRank && row.expectedRank <= 3).length,
      evaluatedRows: measured.length,
      top1Accuracy: measured.length ? measured.filter((row) => row.expectedRank === 1).length / measured.length : null,
      top3Accuracy: measured.length ? measured.filter((row) => row.expectedRank && row.expectedRank <= 3).length / measured.length : null,
    },
    rows,
  };
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await runtime.stop().catch(() => {});
  electronApp?.quit();
}

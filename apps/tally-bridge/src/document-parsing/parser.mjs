import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { formatFromBytes, formatFromExtension, toDocument, toMarkdownBytes } from "@firecrawl/anydoc";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  ".doc", ".docx", ".docm", ".odt", ".rtf", ".epub", ".pdf",
  ".ppt", ".pps", ".pot", ".pptx", ".pptm", ".ppsx", ".ppsm", ".odp",
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".ods", ".csv",
];

let bankStatementModulesPromise = null;

async function loadBankStatementModules() {
  if (bankStatementModulesPromise) return bankStatementModulesPromise;
  const runtimeRoot = new URL("./backend-logic/", import.meta.url);
  const sourceRoot = new URL("../../../api/worker/", import.meta.url);
  const packagedRoot = process.env.KALIKA_BANK_WORKER_ROOT
    ? pathToFileURL(path.resolve(process.env.KALIKA_BANK_WORKER_ROOT) + path.sep)
    : process.resourcesPath
      ? pathToFileURL(path.join(process.resourcesPath, "bank-statement-worker") + path.sep)
      : null;
  const load = async (name) => {
    try {
      return await import(new URL(name, runtimeRoot));
    } catch {
      try {
        return await import(new URL(name, sourceRoot));
      } catch (sourceError) {
        if (!packagedRoot) throw sourceError;
        return import(new URL(name, packagedRoot));
      }
    }
  };
  bankStatementModulesPromise = Promise.all([
    load("bank-statement-deterministic.mjs"),
    load("bank-statement-account.mjs"),
    load("bank-statement-markdown-amounts.mjs"),
    load("bank-statement-running-balance.mjs"),
    load("bank-statement-resilience.mjs"),
    load("bank-statement-pdf-columns.mjs"),
  ]).then(([deterministic, account, amounts, runningBalance, resilience, pdfColumns]) => ({
    deterministic,
    account,
    amounts,
    runningBalance,
    resilience,
    pdfColumns,
  }));
  return bankStatementModulesPromise;
}

function normalizeOutput(value) {
  const output = String(value || "markdown").trim().toLowerCase();
  if (output === "md") return "markdown";
  if (output !== "markdown" && output !== "json") {
    throw new Error('Document output must be "markdown" or "json".');
  }
  return output;
}

async function readRequestBytes(request) {
  if (request?.filePath) {
    const filePath = path.resolve(String(request.filePath));
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Document path does not point to a file.");
    if (stat.size === 0) throw new Error("Document is empty.");
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
    return { bytes: fs.readFileSync(filePath), fileName: path.basename(filePath) };
  }

  const remoteUrl = request?.documentUrl || request?.sourceUrl || request?.url;
  if (remoteUrl) {
    const parsedUrl = new URL(String(remoteUrl));
    if (parsedUrl.protocol !== "https:") throw new Error("Remote documents must use HTTPS.");
    const response = await fetch(parsedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Document download failed with HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
    if (!response.body) throw new Error("Document download returned no content.");
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        throw new Error("Document is larger than the 25 MB limit.");
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, byteLength);
    if (!bytes.length) throw new Error("Document is empty.");
    const urlName = path.basename(decodeURIComponent(parsedUrl.pathname)) || "document";
    return { bytes, fileName: path.basename(String(request?.fileName || urlName)) };
  }

  let bytes = null;
  if (Buffer.isBuffer(request?.bytes) || request?.bytes instanceof Uint8Array) {
    bytes = Buffer.from(request.bytes);
  } else if (typeof request?.base64 === "string" && request.base64.trim()) {
    const encoded = request.base64.trim().replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
      throw new Error("Document base64 content is invalid.");
    }
    bytes = Buffer.from(encoded, "base64");
  }
  if (!bytes?.length) throw new Error("Document request requires filePath, bytes, or base64.");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Document is larger than the 25 MB limit.");
  return { bytes, fileName: path.basename(String(request?.fileName || "document")) };
}

function requestedFormat(request, fileName, bytes) {
  const explicit = String(request?.format || "").trim().toLowerCase().replace(/^\./, "");
  if (explicit) {
    const format = formatFromExtension(explicit);
    if (!format) throw new Error(`Unsupported document format: ${explicit}.`);
    return format;
  }
  return formatFromBytes(bytes) || formatFromExtension(path.extname(fileName));
}

function jsonSafeDocument(document) {
  return {
    ...document,
    assets: (document.assets || []).map((asset) => {
      const { data, ...rest } = asset;
      return {
        ...rest,
        byteLength: data?.length || 0,
        dataBase64: data ? Buffer.from(data).toString("base64") : "",
      };
    }),
  };
}

function metadata({ fileName, format, bytes, startedAt, structured }) {
  return {
    fileName,
    format,
    byteLength: bytes.length,
    structured,
    parser: "firecrawl-anydoc",
    processing: "local",
    ocrUsed: false,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  };
}

function approximatePdfPageCount(bytes) {
  const source = Buffer.from(bytes).toString("latin1");
  return Math.max(1, (source.match(/\/Type\s*\/Page\b/g) || []).length);
}

function physicalDate(value) {
  const match = String(value || "").match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  return match ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : null;
}

function transactionsFromPhysicalRows(rows) {
  return rows.map((row, sourceIndex) => ({
    row_index: sourceIndex + 1,
    transaction_date: physicalDate(row.sourceDate),
    value_date: physicalDate(row.sourceDate),
    description: String(row.narration || "").replace(/\s+/g, " ").trim(),
    reference_number: row.reference || null,
    debit_amount: row.debitAmount > 0 ? row.debitAmount : null,
    credit_amount: row.creditAmount > 0 ? row.creditAmount : null,
    balance_amount: row.balanceAmount,
    transaction_type: "unknown",
    category: row.creditAmount > 0 ? "receipt" : "payment",
    counterparty_name: null,
    suggested_ledger_name: null,
    suggestion_confidence: null,
    suggestion_reason: null,
    confirmed_ledger_name: null,
    additional_charges: [],
    confidence: 0.95,
    raw_payload: {
      rowNumber: sourceIndex + 1,
      source: "physical_pdf_columns",
      extractionProvenance: {
        startPage: row.page,
        endPage: row.page,
        sourceIndex,
        method: "physical_pdf_columns",
      },
    },
  }));
}

export async function processBankStatementMarkdownLocal(markdown, { pageCount = 1, pdfBytes = null } = {}) {
  const { deterministic, account, amounts, runningBalance, resilience, pdfColumns } =
    await loadBankStatementModules();
  let normalized = deterministic.deterministicTransactionsFromAnydoc(markdown);
  let pipeline = "deterministic_anydoc";
  let physical = null;
  if (!normalized?.transactions?.length && pdfBytes) {
    physical = await pdfColumns.readBankStatementPhysicalColumns(pdfBytes);
    if (physical.detected && physical.rows.length) {
      normalized = {
        headers: [`physical:${physical.layout}`],
        transactions: transactionsFromPhysicalRows(physical.rows),
      };
      pipeline = "physical_pdf_columns";
    }
  }
  if (!normalized?.transactions?.length) {
    const error = new Error("The bank-statement tables could not be normalized deterministically.");
    error.code = "deterministic_extraction_unavailable";
    throw error;
  }
  const source = amounts.extractBankStatementMarkdownAmounts(markdown);
  // AnyDoc can preserve all cells while shifting an empty debit/credit cell in
  // the normalized table. Reapply the amounts read from the original Markdown
  // columns before judging running-balance continuity. This is the same
  // authoritative reconciliation used by the main bank-statement pipeline.
  if (pipeline === "deterministic_anydoc") {
    normalized = amounts.reconcileBankStatementMarkdownAmounts(
      { ...normalized, openingBalance: source.openingBalance },
      markdown
    );
  }
  const accountFromMarkdown = account.extractAccountFromBankStatementMarkdown(markdown);
  const balanceValidation = runningBalance.validateRunningBalanceContinuity(
    normalized.transactions,
    source.openingBalance
  );
  // A balance mismatch is a review condition, not a parser crash. The backend
  // repeats this validation and safely marks the import as requiring manual
  // review, so no inconsistent statement can be posted automatically.
  return {
    parsed: {
      account: account.mergeBankStatementAccount({}, accountFromMarkdown),
      statementPeriodStart: null,
      statementPeriodEnd: null,
      openingBalance: source.openingBalance,
      transactions: pipeline === "physical_pdf_columns"
        ? normalized.transactions
        : resilience.addBankStatementPageProvenance(normalized.transactions, {
            startPage: 1,
            endPage: Math.max(1, Number(pageCount) || 1),
            method: "deterministic_anydoc",
          }),
      pageResults: [],
    },
    diagnostics: {
      pipeline,
      physicalLayout: physical?.layout ?? null,
      rowCount: normalized.transactions.length,
      headers: normalized.headers,
      normalized: true,
      markdownAmounts: normalized.markdownAmountDiagnostics ?? null,
      balanceValidation,
      used: true,
    },
  };
}

export async function parseDocumentLocal(request = {}) {
  const startedAt = performance.now();
  const output = normalizeOutput(request.output || request.outputFormat);
  const { bytes, fileName } = await readRequestBytes(request);
  const format = requestedFormat(request, fileName, bytes);
  if (!format) {
    throw new Error("Document format could not be detected. Supply a supported file extension or format.");
  }

  try {
    if (output === "markdown") {
      const markdown = await toMarkdownBytes(bytes, format);
      return {
        outputFormat: "markdown",
        content: markdown,
        metadata: metadata({ fileName, format, bytes, startedAt, structured: false }),
      };
    }
    if (format === "pdf") {
      const markdown = await toMarkdownBytes(bytes, format);
      const bankStatement = await processBankStatementMarkdownLocal(markdown, {
        pageCount: request.pageCount || approximatePdfPageCount(bytes),
        pdfBytes: bytes,
      });
      return {
        outputFormat: "json",
        content: bankStatement.parsed,
        metadata: {
          ...metadata({ fileName, format, bytes, startedAt, structured: true }),
          sourceFormat: "anydoc_markdown",
          diagnostics: bankStatement.diagnostics,
        },
      };
    }
    const document = await toDocument(bytes, format);
    return {
      outputFormat: "json",
      content: jsonSafeDocument(document),
      metadata: metadata({ fileName, format, bytes, startedAt, structured: true }),
    };
  } catch (error) {
    const wrapped = new Error(error?.message || "Document could not be parsed locally.");
    wrapped.code = error?.code || "parse_failed";
    throw wrapped;
  }
}

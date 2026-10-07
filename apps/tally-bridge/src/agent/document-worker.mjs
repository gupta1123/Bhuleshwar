import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { processBankStatementMarkdownLocal } from "../document-parsing/parser.mjs";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 300;

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function downloadSource({ sourceUrl, temporaryPath, maxBytes = MAX_BYTES }) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw errorWithCode(`Document download failed with HTTP ${response.status}.`, "DOCUMENT_DOWNLOAD_FAILED");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw errorWithCode("The document exceeds the 25 MB Local Agent limit.", "DOCUMENT_TOO_LARGE");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw errorWithCode("The document exceeds the 25 MB Local Agent limit.", "DOCUMENT_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  fs.writeFileSync(temporaryPath, bytes, { mode: 0o600 });
  return bytes;
}

function approximatePdfPages(bytes) {
  return (bytes.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length;
}

function hasUsefulText(markdown) {
  const text = String(markdown || "").replace(/\s+/g, " ").trim();
  const useful = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return text.length >= 100 && useful >= 60;
}

async function parseDocument(job) {
  const { sourceUrl, localSourcePath, expectedSha256, originalName = "document.pdf", temporaryDirectory, resultUploadUrl, resultUploadToken } = job;
  if (!localSourcePath && !/^https?:\/\//i.test(String(sourceUrl || ""))) throw errorWithCode("A valid document source is required.", "DOCUMENT_URL_INVALID");
  fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  const extension = /^\.[a-z0-9]{1,10}$/i.test(path.extname(originalName)) ? path.extname(originalName) : ".pdf";
  const temporaryPath = localSourcePath || path.join(temporaryDirectory, `${job.id}${extension}`);
  try {
    const bytes = localSourcePath ? fs.readFileSync(localSourcePath) : await downloadSource({ sourceUrl, temporaryPath });
    if (bytes.length > MAX_BYTES) throw errorWithCode("Document exceeds the local size limit.", "DOCUMENT_TOO_LARGE");
    const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    if (expectedSha256 && sha256 !== String(expectedSha256).replace(/[^a-f0-9]/gi, "").toUpperCase()) {
      throw errorWithCode("The downloaded document checksum does not match the requested file.", "DOCUMENT_HASH_MISMATCH");
    }
    const pageCount = approximatePdfPages(bytes);
    if (extension.toLowerCase() === ".pdf" && /\/Encrypt\b/.test(bytes.toString("latin1"))) {
      throw errorWithCode("This PDF is encrypted or password-protected.", "DOCUMENT_ENCRYPTED");
    }
    if (pageCount > MAX_PAGES) throw errorWithCode("The document exceeds the 300-page Local Agent limit.", "DOCUMENT_TOO_MANY_PAGES");

    const parseStarted = performance.now();
    process.send?.({ id: job.id, phase: "parsing_document" });
    const anydoc = await import("@firecrawl/anydoc");
    let markdown;
    try {
      markdown = await anydoc.toMarkdown(temporaryPath);
    } catch (firstError) {
      let format;
      try { format = anydoc.formatFromExtension?.(path.extname(originalName).slice(1) || "pdf"); } catch {}
      try {
        markdown = anydoc.toMarkdownBytes
          ? await anydoc.toMarkdownBytes(bytes, format || anydoc.Format?.PDF || "pdf")
          : await anydoc.toMarkdown(bytes, format || anydoc.Format?.PDF || "pdf");
      } catch (secondError) {
        const message = `${firstError?.message || ""} ${secondError?.message || ""}`;
        if (/password|encrypt/i.test(message)) throw errorWithCode("This document is encrypted or password-protected.", "DOCUMENT_ENCRYPTED");
        throw errorWithCode("This document is malformed or uses an unsupported structure.", "DOCUMENT_MALFORMED");
      }
    }
    const parseMs = Math.round(performance.now() - parseStarted);
    // V2 may still be waiting for ledger context. Only the backend claim can
    // announce AI analysis; parsing completion must not impersonate that phase.
    if (job.pipelineVersion !== 2) process.send?.({ id: job.id, phase: "analyzing_document" });
    markdown = String(markdown || "");
    if (!hasUsefulText(markdown)) {
      throw errorWithCode("This PDF appears to be scanned or image-only. Local OCR is not enabled in Local Agent v1.", "SCAN_REQUIRES_OCR");
    }
    let structured = null;
    if (job.pipelineVersion === 2 && extension.toLowerCase() === ".pdf") {
      structured = await processBankStatementMarkdownLocal(markdown, { pageCount, pdfBytes: bytes });
    }
    const compressed = gzipSync(Buffer.from(markdown, "utf8"));
    if (resultUploadUrl) {
      const response = await fetch(resultUploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/markdown",
          "Content-Encoding": "gzip",
          "X-Kalika-Document-Sha256": sha256,
          ...(resultUploadToken ? { Authorization: `Bearer ${resultUploadToken}` } : {}),
        },
        body: compressed,
        signal: AbortSignal.timeout(210_000),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        const code = /^AI_[A-Z_]+$/.test(detail?.code || "") ? detail.code : "DOCUMENT_RESULT_UPLOAD_FAILED";
        const message = code.startsWith("AI_") && typeof detail?.error === "string"
          ? detail.error.slice(0, 300) : `Backend document processing failed with HTTP ${response.status}.`;
        throw errorWithCode(message, code);
      }
    }
    return { sha256, pageCount, parseMs: Math.round(performance.now() - parseStarted), markdownBytes: Buffer.byteLength(markdown),
      markdownGzip: compressed, markdown: resultUploadUrl ? null : markdown, parsed: structured?.parsed || null,
      parserDiagnostics: structured?.diagnostics || null, uploaded: Boolean(resultUploadUrl) };
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

process.on("message", async (message) => {
  try {
    const result = await parseDocument(message);
    process.send?.({ id: message.id, result });
  } catch (error) {
    process.send?.({ id: message.id, error: { code: error?.code || "DOCUMENT_PARSE_FAILED", message: error instanceof Error ? error.message : String(error) } });
  }
});

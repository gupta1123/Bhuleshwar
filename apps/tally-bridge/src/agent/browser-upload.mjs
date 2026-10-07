import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const BROWSER_UPLOAD_PORT = 17843;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

// A cloud-authenticated command installs a one-use ticket. Browser requests
// cannot choose a path, parser options, company, or cloud destination.
export class BrowserDocumentUpload {
  constructor({ temporaryDirectory, port = BROWSER_UPLOAD_PORT }) {
    this.temporaryDirectory = temporaryDirectory;
    this.port = port;
    this.pending = new Map();
    this.progressStreams = new Map();
    this.contexts = new Map();
  }
  reportPhase(tokenHash, phase, error) {
    if (phase === "complete" || phase === "failed") {
      const context = this.contexts.get(tokenHash);
      clearTimeout(context?.timer);
      if (phase === 'failed') context?.controller.abort(new Error(error || 'Document session ended.'));
      context?.reject(new Error(error || 'Document session ended.'));
      this.contexts.delete(tokenHash);
    }
    const stream = this.progressStreams.get(tokenHash);
    if (!stream) return;
    if (!stream.response.destroyed) stream.response.write(`${JSON.stringify({ phase, ...(error ? { error } : {}) })}\n`);
    if (phase === "complete" || phase === "failed") {
      clearTimeout(stream.timer);
      stream.response.end();
      this.progressStreams.delete(tokenHash);
    }
  }
  async start() {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 60_000;
    server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", resolve);
    });
    this.server = server;
    this.port = server.address().port;
  }
  waitForUpload({ tokenHash, origin, expectedSha256, sizeBytes, expiresAt, pipelineVersion, identity }, timeoutMs = 120_000) {
    if (!/^[a-f0-9]{64}$/i.test(tokenHash || "") || !/^https?:\/\//.test(origin || "") ||
        !/^[a-f0-9]{64}$/i.test(expectedSha256 || "") || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_DOCUMENT_BYTES || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return Promise.reject(new Error("Invalid local document upload ticket."));
    }
    if (this.pending.has(tokenHash) || this.contexts.has(tokenHash)) return Promise.reject(new Error('Document session already exists.'));
    if (pipelineVersion === 2 && (!identity || ['organizationId', 'ownerUserId', 'connectionId', 'installationId', 'companyGuid', 'companyName', 'financialYear'].some(field => typeof identity[field] !== 'string' || !identity[field]) || !Number.isInteger(identity.sessionGeneration))) {
      return Promise.reject(new Error('Incomplete document identity.'));
    }
    return new Promise((resolve, reject) => {
      const ticket = { origin, expectedSha256, sizeBytes, resolve, reject, used: false };
      if (pipelineVersion === 2) {
        let contextResolve, contextReject;
        const promise = new Promise((yes, no) => { contextResolve = yes; contextReject = no; });
        promise.catch(() => {});
        const context = { origin, identity: { ...identity }, promise, resolve: contextResolve, reject: contextReject, expiresAt, hash: null, controller: new AbortController() };
        context.timer = setTimeout(() => {
          context.reject(new Error('Ledger preparation timed out. Reselect the PDF.'));
          context.controller.abort(new Error('Ledger preparation timed out.'));
          this.contexts.delete(tokenHash);
        }, Math.max(1, expiresAt - Date.now()));
        this.contexts.set(tokenHash, context);
      }
      ticket.timer = setTimeout(() => {
        this.pending.delete(tokenHash);
        this.contexts.get(tokenHash)?.reject(new Error('Document upload expired. Reselect the PDF.'));
        this.contexts.get(tokenHash)?.controller.abort(new Error('Document upload expired.'));
        clearTimeout(this.contexts.get(tokenHash)?.timer);
        this.contexts.delete(tokenHash);
        ticket.request?.destroy();
        reject(new Error("Local PDF upload timed out. Keep this browser and the selected agent on the same PC, then retry."));
      }, Math.min(timeoutMs, expiresAt - Date.now()));
      this.pending.set(tokenHash, ticket);
    });
  }
  contextSignal(tokenHash) { return this.contexts.get(tokenHash)?.controller.signal; }
  async waitForContext(tokenHash) {
    const context = this.contexts.get(tokenHash);
    if (!context) throw new Error('Document context session is unavailable.');
    let timer;
    try { return await Promise.race([context.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Ledger preparation timed out.')), Math.max(1, context.expiresAt - Date.now()));
    })]); } finally { clearTimeout(timer); }
  }
  async handle(req, res) {
    const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const origin = req.headers.origin;
    if (req.headers.host !== `127.0.0.1:${this.port}` || !origin || !/^https?:\/\//.test(origin)) return reply(403, { error: "Origin or host rejected." });
    // Preflight grants no access: every actual request still needs the ticket
    // and exact origin registered by its authenticated command.
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") return reply(204, {});
    const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
    if (!token) return reply(401, { error: "Upload ticket required." });
    const key = createHash("sha256").update(token).digest("hex");
    const context = this.contexts.get(key);
    if (req.method === 'POST' && req.url === '/document/context') {
      // The browser can reach localhost before the authenticated cloud command
      // has registered its one-use ticket. That is normal pending state, not a
      // conflict; genuine replacement/conflicting contexts still return 409.
      if (!context || Date.now() > context.expiresAt) return reply(202, { code: 'CONTEXT_NOT_READY', error: 'Document context is not ready or expired.' });
      if (origin !== context.origin) return reply(403, { error: 'Upload origin mismatch.' });
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('Ledger context too large.'); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.pipelineVersion !== 2) return reply(400, { error: 'Document context protocol must be version 2.' });
        for (const field of ['organizationId','ownerUserId','connectionId','installationId','sessionGeneration','companyGuid','companyName','financialYear']) {
          if (String(body.identity?.[field] ?? '') !== String(context.identity?.[field] ?? '')) return reply(403, { error: 'Document context identity mismatch.' });
        }
        // V2 schema 3 performs retrieval against the connector's prepared local
        // vector index. In that mode the browser intentionally sends no ledger
        // catalogue; retaining support for a populated list keeps older clients
        // compatible during rolling upgrades.
        if (!Array.isArray(body.ledgerNames) || body.ledgerNames.length > 20000 || body.ledgerNames.some(x => typeof x !== 'string') || !Array.isArray(body.bankAccountCandidates)) throw new Error('Invalid ledger context.');
        const value = { ledgerNames: body.ledgerNames, bankAccountCandidates: body.bankAccountCandidates };
        const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
        if (context.hash && context.hash !== hash) return reply(409, { error: 'Conflicting document context.' });
        context.hash = hash; clearTimeout(context.timer); context.resolve({ ...value, contextHash: hash });
        return reply(200, { accepted: true, contextHash: hash });
      } catch (error) { return reply(400, { error: error.message }); }
    }
    if (req.method === 'POST' && req.url === '/document/cancel' && context) {
      if (origin !== context.origin) return reply(403, { error: 'Upload origin mismatch.' });
      context.reject(new Error('Document preparation cancelled.')); this.contexts.delete(key);
      context.controller.abort(new Error('Document preparation cancelled.'));
      clearTimeout(context.timer);
      if (!this.pending.has(key)) {
        this.reportPhase(key, 'failed', 'Document preparation cancelled.');
        return reply(200, { cancelled: true });
      }
    }
    const ticket = this.pending.get(key);
    if (!ticket) return req.method === "GET" && req.url === "/document/ready"
      ? reply(202, { ready: false }) : reply(409, { error: "Upload ticket not ready or expired." });
    if (origin !== ticket.origin) return reply(403, { error: "Upload origin mismatch." });
    if (req.method === "POST" && req.url === "/document/cancel") {
      clearTimeout(ticket.timer); this.pending.delete(key); ticket.request?.destroy();
      ticket.reject(new Error("Browser cancelled local PDF transfer."));
      return reply(200, { cancelled: true });
    }
    if (req.method === "GET" && req.url === "/document/ready") return reply(ticket.used ? 409 : 200, { ready: !ticket.used });
    if (req.method !== "POST" || req.url !== "/document" || ticket.used) return reply(409, { error: "Invalid or consumed upload." });
    if (Number(req.headers["content-length"] || 0) > ticket.sizeBytes) return reply(413, { error: "Document too large." });
    ticket.used = true;
    ticket.request = req;
    let temporaryPath;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > ticket.sizeBytes || size > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds expected size.");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      if (size !== ticket.sizeBytes || createHash("sha256").update(bytes).digest("hex").toLowerCase() !== ticket.expectedSha256.toLowerCase()) throw new Error("Document size or checksum mismatch.");
      if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("Only PDF documents are accepted.");
      await fs.mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
      temporaryPath = path.join(this.temporaryDirectory, `${randomUUID()}.pdf`);
      await fs.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      clearTimeout(ticket.timer);
      this.pending.delete(key);
      // Status stays on this loopback response; no database polling is needed
      // to distinguish a short parse from the much longer AI request.
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const timer = setTimeout(() => this.reportPhase(key, "failed", "Document processing timed out."), 360_000);
      this.progressStreams.set(key, { response: res, timer });
      this.reportPhase(key, "preparing_document");
      ticket.resolve(temporaryPath);
    } catch (error) {
      clearTimeout(ticket.timer);
      this.pending.delete(key);
      if (temporaryPath) await fs.rm(temporaryPath, { force: true });
      ticket.reject(error);
      this.reportPhase(key, 'failed', 'Document transfer failed.');
      if (!res.destroyed) reply(400, { error: error.message });
    }
  }
  async stop() {
    for (const context of this.contexts.values()) { clearTimeout(context.timer); context.reject(new Error('Local Agent stopped.')); context.controller.abort(new Error('Local Agent stopped.')); }
    this.contexts.clear();
    for (const ticket of this.pending.values()) {
      clearTimeout(ticket.timer); ticket.request?.destroy(); ticket.reject(new Error("Local Agent stopped."));
    }
    this.pending.clear();
    for (const key of this.progressStreams.keys()) this.reportPhase(key, "failed", "Document processing stopped.");
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); this.server = null; }
  }
}

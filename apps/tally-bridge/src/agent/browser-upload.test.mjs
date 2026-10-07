import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { BrowserDocumentUpload } from "./browser-upload.mjs";
import { LocalDocumentService } from "./document-service.mjs";
import { handleLocalBankV2 } from '../../../api/src/lib/processing/bank-local-v2-http.mjs';

const origin = "https://kalika.example.test";
const pdf = Buffer.from("%PDF-1.4 test-only document");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kalika-direct-upload-test-"));
  const server = new BrowserDocumentUpload({ temporaryDirectory: dir, port: 0 });
  await server.start();
  t.after(async () => {
    await server.stop();
    // Delete only this test's checked, freshly created temporary directory.
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith("kalika-direct-upload-test-"));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const token = randomBytes(32).toString("hex");
  const ticket = { tokenHash: hash(token), origin, expectedSha256: hash(pdf), sizeBytes: pdf.length, expiresAt: Date.now() + 60_000 };
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { Origin: origin, Authorization: `Bearer ${token}` };
  return { dir, server, token, ticket, base, headers };
}

test("direct upload requires exact ticket and origin; validates bytes and consumes ticket once", async t => {
  const f = await setup(t);
  const pending = f.server.waitForUpload(f.ticket);
  assert.equal((await fetch(`${f.base}/document/ready`, { headers: { Origin: origin } })).status, 401);
  assert.equal((await fetch(`${f.base}/document/ready`, { headers: { ...f.headers, Origin: "https://wrong.test" } })).status, 403);
  assert.equal((await fetch(`${f.base}/document/ready`, { headers: f.headers })).status, 200);
  assert.equal((await fetch(`${f.base}/document`, { method: "POST", headers: f.headers, body: pdf })).status, 200);
  const filename = await pending;
  assert.deepEqual(await fs.readFile(filename), pdf);
  assert.equal((await fetch(`${f.base}/document`, { method: "POST", headers: f.headers, body: pdf })).status, 409);
});

test("checksum failure never creates a local source", async t => {
  const f = await setup(t);
  const pending = assert.rejects(f.server.waitForUpload({ ...f.ticket, expectedSha256: "00".repeat(32) }), /checksum/);
  assert.equal((await fetch(`${f.base}/document`, { method: "POST", headers: f.headers, body: pdf })).status, 400);
  await pending;
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test("expired uploads reject and no listener remains after shutdown", async t => {
  const f = await setup(t);
  await assert.rejects(f.server.waitForUpload(f.ticket, 10), /timed out/);
  const ready = await fetch(`${f.base}/document/ready`, { headers: f.headers });
  assert.equal(ready.status, 202);
  assert.deepEqual(await ready.json(), { ready: false });
  assert.equal((await fetch(`${f.base}/document`, { method: "POST", headers: f.headers, body: pdf })).status, 409);
});

test("DNS-rebinding hosts rejected; browser preflight allowed without authorizing an upload", async t => {
  const f = await setup(t);
  const response = await fetch(`${f.base}/document`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-max-age"), "600");
  const status = await new Promise((resolve, reject) => {
    const req = http.get(`${f.base}/document/ready`, { headers: { ...f.headers, Host: "evil.example.test" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  assert.equal(status, 403);
});

test("real PDF travels browser → agent → Markdown-only callback with no retained source", async t => {
  const f = await setup(t);
  const source = await fs.readFile(new URL("../../../../test-assets/bank-statements/kalika-sbi-june-ai-sample.pdf", import.meta.url));
  let received;
  const callback = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { type: req.headers["content-type"], markdown: gunzipSync(Buffer.concat(chunks)).toString("utf8") };
    // Opt-in integration regression: emulate a >60s AI response without a paid
    // provider call or any database writes.
    if (process.env.KALIKA_TEST_SLOW_DOCUMENT_HANDOFF === "1") await new Promise(resolve => setTimeout(resolve, 95_000));
    res.end("{}");
  });
  await new Promise(resolve => callback.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => callback.close(resolve)));
  const service = new LocalDocumentService({ temporaryDirectory: f.dir, browserUpload: f.server });
  const resultPromise = service.parse({
    browserUpload: { ...f.ticket, sizeBytes: source.length }, expectedSha256: hash(source),
    resultUploadUrl: `http://127.0.0.1:${callback.address().port}/result`,
  });
  const uploadResponse = await fetch(`${f.base}/document`, { method: "POST", headers: f.headers, body: source });
  assert.equal(uploadResponse.status, 200);
  const result = await resultPromise;
  const phases = (await uploadResponse.text()).trim().split("\n").map(line => JSON.parse(line).phase);
  assert.deepEqual(phases, ["preparing_document", "parsing_document", "analyzing_document", "complete"]);
  assert.equal(result.uploaded, true);
  assert.equal(result.cached, false);
  assert.ok(result.parseMs >= 0);
  assert.equal(received.type, "text/markdown");
  assert.ok(received.markdown.length > 100);
  assert.ok(!received.markdown.startsWith("%PDF"));
  assert.deepEqual(await fs.readdir(f.dir), []);
});

const identity = { organizationId: 'org', ownerUserId: 'owner', connectionId: 'connection', installationId: 'installation', sessionGeneration: 2, companyGuid: 'company-guid', companyName: 'Company', financialYear: '2026-27' };
const contextBody = { pipelineVersion: 2, identity, ledgerNames: ['Bank', 'Customer A'], bankAccountCandidates: [{ ledgerName: 'Bank', accountNumber: '1234' }] };
async function contextRequest(f, body = contextBody, extraHeaders = {}) {
  return fetch(`${f.base}/document/context`, { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
}

test('v2 reports an unregistered context as pending rather than conflicting', async t => {
  const f = await setup(t);
  const response = await contextRequest(f);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).code, 'CONTEXT_NOT_READY');
});

test('v2 accepts an empty browser ledger catalogue for connector-local vector retrieval', async t => {
  const f = await setup(t);
  const pending = assert.rejects(f.server.waitForUpload({ ...f.ticket, pipelineVersion: 2, identity }), /cancelled/);
  const body = { ...contextBody, ledgerNames: [], bankAccountCandidates: [] };
  assert.equal((await contextRequest(f, body)).status, 200);
  const context = await f.server.waitForContext(f.ticket.tokenHash);
  assert.deepEqual(context.ledgerNames, []);
  assert.deepEqual(context.bankAccountCandidates, []);
  assert.equal((await fetch(`${f.base}/document/cancel`, { method: 'POST', headers: f.headers })).status, 200);
  await pending;
});

for (const contextFirst of [true, false]) {
  test(`v2 context may arrive ${contextFirst ? 'before' : 'after'} PDF transfer without changing ledger order`, async t => {
    const f = await setup(t);
    const pending = f.server.waitForUpload({ ...f.ticket, pipelineVersion: 2, identity });
    if (contextFirst) assert.equal((await contextRequest(f)).status, 200);
    const response = await fetch(`${f.base}/document`, { method: 'POST', headers: f.headers, body: pdf });
    await pending;
    if (!contextFirst) assert.equal((await contextRequest(f)).status, 200);
    const context = await f.server.waitForContext(f.ticket.tokenHash);
    assert.deepEqual(context.ledgerNames, contextBody.ledgerNames);
    assert.deepEqual(context.bankAccountCandidates, contextBody.bankAccountCandidates);
    assert.equal(context.contextHash, hash(JSON.stringify({ ledgerNames: contextBody.ledgerNames, bankAccountCandidates: contextBody.bankAccountCandidates })));
    assert.equal((await contextRequest(f)).status, 200);
    assert.equal((await contextRequest(f, { ...contextBody, ledgerNames: ['Replacement'] })).status, 409);
    f.server.reportPhase(f.ticket.tokenHash, 'complete');
    await response.text();
    assert.equal(f.server.contexts.size, 0);
  });
}

test('v2 rejects every mismatched identity field, wrong origin and wrong protocol', async t => {
  const f = await setup(t);
  const pending = assert.rejects(f.server.waitForUpload({ ...f.ticket, pipelineVersion: 2, identity }), /cancelled/);
  for (const field of Object.keys(identity)) {
    assert.equal((await contextRequest(f, { ...contextBody, identity: { ...identity, [field]: 'wrong' } })).status, 403, field);
  }
  assert.equal((await contextRequest(f, { ...contextBody, pipelineVersion: 1 })).status, 400);
  assert.equal((await contextRequest(f, contextBody, { Origin: 'https://wrong.test' })).status, 403);
  assert.equal((await fetch(`${f.base}/document/cancel`, { method: 'POST', headers: f.headers })).status, 200);
  await pending;
});

test('v2 cancellation after upload rejects context and closes progress without a 409', async t => {
  const f = await setup(t);
  const pending = f.server.waitForUpload({ ...f.ticket, pipelineVersion: 2, identity });
  const context = assert.rejects(f.server.waitForContext(f.ticket.tokenHash), /cancelled/);
  const response = await fetch(`${f.base}/document`, { method: 'POST', headers: f.headers, body: pdf });
  await pending;
  assert.equal((await fetch(`${f.base}/document/cancel`, { method: 'POST', headers: f.headers })).status, 200);
  await context;
  assert.match(await response.text(), /cancelled/);
  assert.equal(f.server.contexts.size, 0);
});

test('duplicate session registration cannot replace a pending upload', async t => {
  const f = await setup(t);
  const pending = assert.rejects(f.server.waitForUpload({ ...f.ticket, pipelineVersion: 2, identity }), /cancelled/);
  await assert.rejects(f.server.waitForUpload({ ...f.ticket, pipelineVersion: 2, identity }), /already exists/);
  await fetch(`${f.base}/document/cancel`, { method: 'POST', headers: f.headers });
  await pending;
});

for (const contextFirst of [true, false]) test(`v2 real parser and HTTP finalization: ${contextFirst ? 'context' : 'parsing'} finishes first`, async t => {
  const f = await setup(t);
  const source = await fs.readFile(new URL('../../../../test-assets/bank-statements/kalika-sbi-june-ai-sample.pdf', import.meta.url));
  let committed = false, calls = 0, claims = 0, receivedContext;
  // This fixture tests transport/coordination, not the AI's extraction accuracy.
  const callback = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await handleLocalBankV2(new Request('http://localhost/result', {
        method: 'POST', headers: req.headers, body: Buffer.concat(chunks),
      }), {
        verifyToken: token => token === 'test-job-token' ? { jobId: 'command', ownerUserId: identity.ownerUserId, connectionId: identity.connectionId } : null,
        store: {
          claim: async () => { claims++; return { state: 'accepted', revision: 2 }; },
          finalize: async (_e, _digest, prepared) => {
            assert.equal(prepared.rows.length, 1);
            for (const key of ['markdown', 'ledgerNames', 'bankAccountCandidates', 'token']) assert.equal(Object.hasOwn(prepared, key), false);
            committed = true; return { state: 'completed', importId: 'import', revision: 3 };
          },
          fail: async () => { throw new Error('unexpected analysis failure'); },
        },
        analyze: async input => {
          calls++; assert.ok(input.markdown.length > 100); assert.ok(!input.markdown.startsWith('%PDF'));
          receivedContext = { ledgerNames: input.ledgerNames, bankAccountCandidates: input.bankAccountCandidates };
          return { data: { account: {}, transactions: [{ date: '2026-09-01', description: 'Fixture receipt', credit: 20, balance: 120, suggestedLedgerName: 'Customer A' }] },
            aiMs: 1, coverage: { complete: true, sourceRows: 1 } };
        },
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => callback.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => callback.close(resolve)));
  const base = `http://127.0.0.1:${callback.address().port}`;
  const service = new LocalDocumentService({ temporaryDirectory: f.dir, browserUpload: f.server });
  let parsedResolve;
  const parsed = new Promise(resolve => { parsedResolve = resolve; });
  const originalParse = service.parseFresh.bind(service);
  service.parseFresh = async payload => { const result = await originalParse(payload); parsedResolve(); return result; };
  const processing = service.parse({ pipelineVersion: 2, agentIdentity: identity, bankStatementJobId: 'job', commandId: 'command',
    browserUpload: { ...f.ticket, sizeBytes: source.length }, expectedSha256: hash(source), documentDeadlineAt: Date.now() + 60_000,
    resultUploadUrl: `${base}/result`, resultStatusUrl: `${base}/status`, resultUploadToken: 'test-job-token' });
  processing.catch(() => {});
  if (contextFirst) assert.equal((await contextRequest(f)).status, 200);
  const upload = await fetch(`${f.base}/document`, { method: 'POST', headers: f.headers, body: source });
  if (!contextFirst) { await parsed; assert.equal(calls, 0); assert.equal((await contextRequest(f)).status, 200); }
  const result = await processing;
  const stream = await upload.text();
  assert.equal(result.result.state, 'completed'); assert.equal(committed, true);
  assert.equal(claims, 1); assert.equal(calls, 1);
  assert.deepEqual(receivedContext, { ledgerNames: contextBody.ledgerNames, bankAccountCandidates: contextBody.bankAccountCandidates });
  assert.match(stream, /saving_preview/); assert.match(stream, /complete/);
  assert.equal(stream.includes('Fixture receipt'), false);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

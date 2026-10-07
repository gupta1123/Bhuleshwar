import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LocalDocumentService } from "./document-service.mjs";

function fixture(error) {
  const requests = [];
  let storageCalls = 0;
  const service = new LocalDocumentService({
    temporaryDirectory: "unused-test-directory",
    storage: { call() { storageCalls++; throw new Error("Document cache must not be accessed"); } },
    forkWorker() {
      const child = new EventEmitter();
      child.kill = () => {};
      child.send = (payload) => {
        requests.push(payload);
        queueMicrotask(() => child.emit("message", {
          id: payload.id,
          ...(error ? { error } : { result: {
            sha256: payload.expectedSha256, uploaded: true, parseMs: 12,
          } }),
        }));
      };
      return child;
    },
  });
  return { service, requests, storageCalls: () => storageCalls };
}

test("identical PDF hashes always invoke fresh workers without reading or writing cache", async () => {
  const f = fixture();
  const payload = { expectedSha256: "AB".repeat(32), sourceUrl: "https://example.test/document.pdf" };
  const first = await f.service.parse(payload);
  const second = await f.service.parse(payload);
  assert.equal(f.requests.length, 2);
  assert.notEqual(f.requests[0].id, f.requests[1].id);
  assert.equal(f.requests[0].expectedSha256, payload.expectedSha256);
  assert.equal(first.cached, false);
  assert.equal(second.cached, false);
  assert.equal(second.parseMs, 12);
  assert.equal(f.storageCalls(), 0);
});

test("parse failure propagates rather than falling back to cached Markdown", async () => {
  const f = fixture({ code: "DOCUMENT_HASH_MISMATCH", message: "Checksum mismatch" });
  await assert.rejects(f.service.parse({ expectedSha256: "AB".repeat(32) }), {
    code: "DOCUMENT_HASH_MISMATCH",
  });
  assert.equal(f.storageCalls(), 0);
});

test('cancelling preparation terminates the active parser without sending an AbortSignal over IPC', async () => {
  const controller = new AbortController(); let killed = false, sent;
  const service = new LocalDocumentService({ temporaryDirectory: 'unused', forkWorker() {
    const child = new EventEmitter(); child.kill = () => { killed = true; };
    child.send = value => { sent = value; }; return child;
  } });
  const parsing = service.parseFresh({ signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Object.hasOwn(sent, 'signal'), false);
  controller.abort(new Error('preparation cancelled'));
  await assert.rejects(parsing, /preparation cancelled/); assert.equal(killed, true);
});

test('an expired v2 job cannot start a parser process', async () => {
  const f = fixture();
  await assert.rejects(f.service.parseFresh({ pipelineVersion: 2, documentDeadlineAt: Date.now()-1 }), { code: 'JOB_DEADLINE_EXCEEDED' });
  assert.equal(f.requests.length, 0);
});

test("AI handoff can exceed the parse budget after parsing completes", async () => {
  const service = new LocalDocumentService({ temporaryDirectory: "unused", timeoutMs: 20, resultTimeoutMs: 200,
    forkWorker() {
      const child = new EventEmitter();
      child.kill = () => {};
      child.send = ({ id }) => {
        queueMicrotask(() => child.emit("message", { id, phase: "analyzing_document" }));
        setTimeout(() => child.emit("message", { id, result: { uploaded: true } }), 60);
      };
      return child;
    },
  });
  assert.equal((await service.parseFresh({})).uploaded, true);
});

test("AI handoff timeout is not mislabeled as a parser timeout", async () => {
  const service = new LocalDocumentService({ temporaryDirectory: "unused", timeoutMs: 200, resultTimeoutMs: 20,
    forkWorker() {
      const child = new EventEmitter(); child.kill = () => {};
      child.send = ({ id }) => queueMicrotask(() => child.emit("message", { id, phase: "analyzing_document" }));
      return child;
    },
  });
  await assert.rejects(service.parseFresh({}), { code: "DOCUMENT_RESULT_TIMEOUT" });
});

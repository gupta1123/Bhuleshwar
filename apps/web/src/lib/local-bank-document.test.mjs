import test from "node:test";
import assert from "node:assert/strict";
import { readDocumentProgress, sendPdfToLocalAgent } from "./local-bank-document.ts";

test("pending readiness waits and a backend failure does not send a stale cancel", async (t) => {
  const calls = [];
  const responses = [
    Response.json({ ready: false }, { status: 202 }),
    Response.json({ ready: true }),
    new Response(JSON.stringify({ phase: "failed", error: "AI analysis exceeded three minutes." }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } }),
  ];
  t.mock.method(globalThis, "fetch", async (url) => { calls.push(url); return responses.shift(); });
  await assert.rejects(sendPdfToLocalAgent(new File(["pdf"], "test.pdf"), "a".repeat(64)), /AI analysis exceeded/);
  assert.deepEqual(calls.map(url => new URL(url).pathname), ["/document/ready", "/document/ready", "/document"]);
});

test("accepted transfer timeout is not reported as an unreachable agent", async (t) => {
  const stream = new ReadableStream({ start(controller) { controller.error(new DOMException("Timed out", "TimeoutError")); } });
  const responses = [Response.json({ ready: true }), new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } })];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return responses.shift(); });
  await assert.rejects(sendPdfToLocalAgent(new File(["pdf"], "test.pdf"), "a".repeat(64)), /analysis connection was interrupted or timed out/);
  assert.equal(calls, 2);
});

test("Document parsing only appears for the actual parser phase", async () => {
  const phases = ["preparing_document", "parsing_document", "analyzing_document", "complete"];
  const response = new Response(phases.map(phase => JSON.stringify({ phase })).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
  const labels = [];
  assert.equal(await readDocumentProgress(response, label => labels.push(label)), true);
  assert.deepEqual(labels, ["Preparing document", "Document parsing", "Analyzing transactions", "Finalizing results"]);
});

test("legacy acknowledgements do not imply parsing is active", async () => {
  const labels = [];
  assert.equal(await readDocumentProgress(new Response('{"accepted":true}'), label => labels.push(label)), false);
  assert.deepEqual(labels, ["Processing document"]);
});

test("interrupted or failed parser does not report completion", async () => {
  for (const phase of ["parsing_document", "failed"]) {
    const response = new Response(JSON.stringify({ phase }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
    await assert.rejects(readDocumentProgress(response, () => {}));
  }
});

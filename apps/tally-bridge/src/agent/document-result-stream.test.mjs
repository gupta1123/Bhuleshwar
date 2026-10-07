import test from 'node:test';
import assert from 'node:assert/strict';
import { readDocumentResultStream, uploadDocumentEnvelope } from './document-result-stream.mjs';

test('stream accepts split progress, keepalive and terminal line without newline', async () => {
  const encoder = new TextEncoder(); const phases = [];
  const response = new Response(new ReadableStream({ start(controller) {
    for (const text of ['{"type":"keepalive"}\n{"ty','pe":"progress","phase":"analyzing_document"}\n','{"type":"result","state":"completed"}']) controller.enqueue(encoder.encode(text));
    controller.close();
  } }));
  assert.equal((await readDocumentResultStream(response, x => phases.push(x.phase))).state, 'completed');
  assert.deepEqual(phases, ['analyzing_document']);
});
test('stream truncation is not a successful acknowledgement', async () => {
  await assert.rejects(readDocumentResultStream(new Response('{"type":"keepalive"}\n')), /interrupted/);
});
test('lost response queries durable status instead of repeating AI upload', async () => {
  const calls = [];
  const result = await uploadDocumentEnvelope({ url: 'http://test/result', statusUrl: 'http://test/status', token: 'secret',
    envelope: {}, deadlineAt: Date.now()+60000, sleep: async () => {}, fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method || 'GET' });
      if (options.method === 'POST') throw new TypeError('connection lost');
      return Response.json({ state: 'completed' });
    } });
  assert.equal(result.state, 'completed'); assert.deepEqual(calls.map(x => x.method), ['POST','GET']);
});
test('status failure stops rather than resending uncertain data', async () => {
  let uploads=0;
  await assert.rejects(uploadDocumentEnvelope({ url: 'http://test/result', statusUrl: 'http://test/status', token: 'secret',
    envelope: {}, deadlineAt: Date.now()+60000, fetchImpl: async (_url, options) => {
      if (options.method === 'POST') { uploads++; throw new TypeError('lost'); }
      return new Response('', { status: 503 });
    } }), /No AI retry/);
  assert.equal(uploads,1);
});

test('fractional database deadlines are normalized before creating timeout signals', async () => {
  const result = await uploadDocumentEnvelope({ url: 'http://test/result', statusUrl: 'http://test/status', token: 'secret',
    envelope: {}, deadlineAt: Date.now() + 60_000.354, fetchImpl: async () =>
      new Response('{"type":"result","state":"completed"}\n') });
  assert.equal(result.state, 'completed');
});

test('checkpoint recovery waits for saving without resending the AI input', async () => {
  const calls = [];
  const result = await uploadDocumentEnvelope({ url: 'http://test/result', statusUrl: 'http://test/status', token: 'secret',
    envelope: {}, deadlineAt: Date.now()+60000, sleep: async () => {}, fetchImpl: async (_url, options) => {
      calls.push(options.method || 'GET');
      if (options.method === 'POST') return new Response('{"type":"result","state":"recovery"}\n');
      return Response.json({ state: calls.length === 2 ? 'recovery' : 'completed' });
    } });
  assert.equal(result.state, 'completed'); assert.deepEqual(calls, ['POST','GET','GET']);
});

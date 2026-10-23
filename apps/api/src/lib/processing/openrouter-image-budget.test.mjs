import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-image-budget-'));
for (const file of ['image-request-budget', 'openrouter']) {
  const source = fs.readFileSync(new URL(`./${file}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  fs.writeFileSync(path.join(directory, `${file}.mjs`), output.replaceAll('"./image-request-budget.ts"', '"./image-request-budget.mjs"'));
}
const oldKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = 'test-key-never-sent';
const { callOpenRouter } = await import(pathToFileURL(path.join(directory, 'openrouter.mjs')).href);
if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('OpenRouter imports directly in the unbundled Node worker runtime', () => {
  const url = new URL('./openrouter.ts', import.meta.url).href;
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `await import(${JSON.stringify(url)});`], { stdio: 'pipe' });
});

test('aggregate oversize is caught before fetch even when individual images fit', async (t) => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected network request'); };
  t.after(() => { globalThis.fetch = previous; });
  const url = `data:image/jpeg;base64,${Buffer.alloc(8 * 1024 * 1024).toString('base64')}`;
  await assert.rejects(callOpenRouter([{ role: 'user', content: [
    { type: 'image_url', image_url: { url } }, { type: 'image_url', image_url: { url } },
  ] }]), /Packet image request exceeds/);
  assert.equal(calls, 0);
});
test('provider image limits never retry unchanged, including HTTP 200 error payloads and 502s', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  for (const status of [200, 400, 502]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'Downloaded image content cannot exceed 30MB' } }), { status });
    };
    await assert.rejects(callOpenRouter([{ role: 'user', content: 'test' }], { maxRetries: 2 }), /30MB/);
    assert.equal(calls, 1, `status ${status}`);
  }
});
test('safe image requests still return provider content', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.messages[0].content[0].image_url.url, 'data:image/jpeg;base64,YQ==');
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"documents":[]}' } }] }));
  };
  assert.equal(await callOpenRouter([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YQ==' } }] }]), '{"documents":[]}');
});

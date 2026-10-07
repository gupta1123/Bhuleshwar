import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankPreviewCompletion } from './bank-preview-completion.ts';

test('completion fetch starts immediately and concurrent triggers load preview once', async () => {
  let snapshots = 0, previews = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const waiter = createBankPreviewCompletion({ snapshot: async () => { snapshots++; await barrier; return { processing: false }; },
    preview: async () => { previews++; return { processing: false, rows: [1] }; } });
  waiter.setOnline(true); waiter.check(); waiter.check();
  assert.equal(snapshots, 1); release();
  assert.deepEqual((await waiter.promise).rows, [1]); assert.equal(previews, 1);
});
test('an early notification does not expose preview before commit', async () => {
  let committed = false, previews = 0;
  const waiter = createBankPreviewCompletion({ snapshot: async () => ({ processing: !committed }),
    preview: async () => { previews++; return { processing: false }; } });
  try {
    waiter.setOnline(true); await waiter.check(); assert.equal(previews, 0);
    committed = true; await waiter.check(); await waiter.promise; assert.equal(previews, 1);
  } finally { waiter.stop(); }
});
test('durable fallback keeps polling while socket is online and terminal stops polling', async () => {
  let count = 0, ready = false;
  const waiter = createBankPreviewCompletion({ pollMs: 10, snapshot: async () => { count++; return { processing: !ready }; },
    preview: async () => ({ processing: false }) });
  try {
    await new Promise(resolve => setTimeout(resolve, 30)); assert.ok(count > 0);
    waiter.setOnline(true); await waiter.check(); const onlineCount = count;
    await new Promise(resolve => setTimeout(resolve, 30)); assert.ok(count > onlineCount);
    ready = true; await waiter.check(); await waiter.promise; const finalCount = count;
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(count, finalCount);
  } finally { waiter.stop(); }
});
test('cancellation is terminal and cannot load a preview', async () => {
  const waiter = createBankPreviewCompletion({ snapshot: async () => ({ processing: false, job: { status: 'cancelled' } }),
    preview: async () => { throw new Error('must not fetch'); } });
  await waiter.check(); await assert.rejects(waiter.promise, /cancelled/);
});

test('completion arriving during a stale pre-commit read is not lost on a healthy socket', async () => {
  let release, reads = 0, previews = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const waiter = createBankPreviewCompletion({ snapshot: async () => {
    if (++reads === 1) { await barrier; return { processing: true }; }
    return { processing: false };
  }, preview: async () => { previews++; return { processing: false }; } });
  try {
    waiter.setOnline(true);
    void waiter.check(); // The committed completion event races the older read.
    release();
    await waiter.promise;
    assert.equal(reads, 2);
    assert.equal(previews, 1);
  } finally { waiter.stop(); }
});

test('a transient preview read failure retries without needing a second socket event', async () => {
  let attempts = 0;
  const waiter = createBankPreviewCompletion({ readRetryDelaysMs: [1, 1, 1],
    snapshot: async () => ({ processing: false }),
    preview: async () => { if (++attempts === 1) throw new Error('temporary'); return { processing: false }; } });
  waiter.setOnline(true);
  await waiter.promise;
  assert.equal(attempts, 2);
});

test('persistent status-read failure is bounded and never presented as an AI retry', async () => {
  let attempts = 0;
  const waiter = createBankPreviewCompletion({ readRetryDelaysMs: [1, 1, 1],
    snapshot: async () => { attempts++; throw new Error('offline'); },
    preview: async () => { throw new Error('must not fetch'); } });
  waiter.setOnline(true);
  await assert.rejects(waiter.promise, /no new AI call/);
  assert.equal(attempts, 4);
});

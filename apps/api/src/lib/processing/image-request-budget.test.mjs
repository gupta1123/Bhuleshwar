import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  imageDataBytes, planImageBatches, mergeOverlappingPageGroups,
  runWithImageSizeFallback, isImageSizeError, IMAGE_REQUEST_BUDGET_BYTES,
} from './image-request-budget.ts';

const image = (bytes) => `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`;
test('decoded sizes account for base64 padding', () => {
  for (const bytes of [0, 1, 2, 3, 100, 101]) assert.equal(imageDataBytes(image(bytes)), bytes);
});
test('large packet batches respect bytes and count while covering every page', () => {
  const images = Array.from({ length: 11 }, () => image(5 * 1024 * 1024));
  const batches = planImageBatches(images);
  const covered = new Set();
  for (const [index, batch] of batches.entries()) {
    assert.ok(batch.bytes <= IMAGE_REQUEST_BUDGET_BYTES);
    assert.ok(batch.end - batch.start <= 4);
    for (let page = batch.start; page < batch.end; page++) covered.add(page);
    if (index) assert.equal(batch.start, batches[index - 1].end - 1);
  }
  assert.equal(covered.size, 11);
});
test('small pages are limited to four per batch and empty packets terminate', () => {
  assert.deepEqual(planImageBatches([]), []);
  assert.deepEqual(planImageBatches(Array(7).fill(image(3))).map(({ start, end }) => [start, end]), [[0, 4], [3, 7]]);
});
test('single oversized pages fail before any provider call; single-page batches make progress', () => {
  assert.throws(() => planImageBatches([image(13 * 1024 * 1024)]), /safe image budget/);
  const batches = planImageBatches(Array(3).fill(image(7 * 1024 * 1024)));
  assert.deepEqual(batches.map(({ start, end }) => [start, end]), [[0, 1], [1, 2], [2, 3]]);
});
test('overlapping continuation is merged without repeating pages or mutating input', () => {
  const groups = [
    { documentType: 'Invoice', documentNumber: 'INV/23', pageStart: 2, pageEnd: 4 },
    { documentType: 'Invoice', documentNumber: 'INV/23', pageStart: 4, pageEnd: 6 },
    { documentType: 'PAN Card', pageStart: 6, pageEnd: 6 },
  ];
  const result = mergeOverlappingPageGroups(groups);
  assert.equal(result.length, 2);
  assert.equal(result[0].pageEnd, 6);
  assert.equal(groups[0].pageEnd, 4);
});
test('separate invoices, conflicting parties and multi-card types remain separate', () => {
  for (const other of [{ documentNumber: 'B' }, { primaryPartyName: 'Other Ltd' }, { documentType: 'PAN Card' }]) {
    const base = { documentType: 'Invoice', documentNumber: 'A', primaryPartyName: 'Acme Ltd', pageStart: 4, pageEnd: 4 };
    assert.equal(mergeOverlappingPageGroups([base, { ...base, ...other }]).length, 2);
  }
  const a = { documentType: 'Invoice', pageStart: 1, pageEnd: 2 };
  assert.equal(mergeOverlappingPageGroups([a, { ...a, pageStart: 3, pageEnd: 4 }]).length, 2);
});
test('size rejection splits the request and preserves absolute page references', async () => {
  const calls = [];
  const result = await runWithImageSizeFallback(5, 9, async (start, end) => {
    calls.push([start, end]);
    if (end - start > 2) throw new Error('Downloaded image content cannot exceed 30MB');
    return [{ documentType: 'Invoice', documentNumber: 'A', pageStart: start + 1, pageEnd: end }];
  });
  assert.ok(calls.length > 1);
  assert.deepEqual(mergeOverlappingPageGroups(result), [{ documentType: 'Invoice', documentNumber: 'A', pageStart: 6, pageEnd: 9 }]);
});
test('network errors are not split, and a rejected single page is not retried unchanged', async () => {
  for (const [end, message] of [[4, 'Network disconnected'], [1, 'Downloaded image content cannot exceed 30MB']]) {
    let count = 0;
    await assert.rejects(runWithImageSizeFallback(0, end, async () => { count++; throw new Error(message); }), { message });
    assert.equal(count, 1);
  }
  assert.equal(isImageSizeError(new Error('Packet image request exceeds safe image budget')), true);
  assert.equal(isImageSizeError(new Error('Rate limit exceeded')), false);
});

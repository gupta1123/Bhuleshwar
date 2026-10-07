import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePurchaseDocumentFolder, withFolderTimeout } from './purchase-document-folder.mjs';

test('shared purchase folders accept UNC server and IP paths', () => {
  assert.equal(validatePurchaseDocumentFolder('\\\\AccountsServer\\Invoices\\Kalika\\'), '\\\\AccountsServer\\Invoices\\Kalika');
  assert.equal(validatePurchaseDocumentFolder('\\\\192.168.1.10\\Accounts\\Purchase PDFs'), '\\\\192.168.1.10\\Accounts\\Purchase PDFs');
});

test('shared purchase folders reject device paths, traversal and local drives', () => {
  for (const folder of ['', 'C:\\Invoices', 'Z:\\Invoices', '\\\\server', '\\\\?\\C:\\Invoices',
    '\\\\server\\share\\..\\other', '\\\\server\\share/../other', '\\\\server\\share\\bad.\\file',
    'https://server/invoices', '\\\\server\\share\\file:stream']) {
    assert.throws(() => validatePurchaseDocumentFolder(folder), /shared Windows folder/);
  }
});

test('an unresponsive share ends the caller wait', async () => {
  await assert.rejects(withFolderTimeout(() => new Promise(() => {}), 10), /did not respond/);
  assert.equal(await withFolderTimeout(async () => 'ready', 50), 'ready');
});

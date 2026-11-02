import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePurchaseDocumentFolder, withFolderTimeout } from './purchase-document-folder.mjs';

test('shared purchase folders accept UNC server and IP paths', () => {
  assert.equal(validatePurchaseDocumentFolder('\\\\AccountsServer\\Invoices\\Kalika\\'), '\\\\AccountsServer\\Invoices\\Kalika');
  assert.equal(validatePurchaseDocumentFolder('\\\\192.168.1.10\\Accounts\\Purchase PDFs'), '\\\\192.168.1.10\\Accounts\\Purchase PDFs');
});

test('shared purchase folders reject device paths and traversal', () => {
  for (const folder of ['', '\\\\server', '\\\\?\\C:\\Invoices',
    '\\\\server\\share\\..\\other', '\\\\server\\share/../other', '\\\\server\\share\\bad.\\file',
    'https://server/invoices', '\\\\server\\share\\file:stream']) {
    assert.throws(() => validatePurchaseDocumentFolder(folder), /network folder/);
  }
});

test('an unresponsive share ends the caller wait', async () => {
  await assert.rejects(withFolderTimeout(() => new Promise(() => {}), 10), /did not respond/);
  assert.equal(await withFolderTimeout(async () => 'ready', 50), 'ready');
});

test('accepts a local drive folder and rejects bad local paths', () => {
  assert.equal(validatePurchaseDocumentFolder('C:\\BhuleshwarInvoices\\'), 'C:\\BhuleshwarInvoices');
  assert.throws(() => validatePurchaseDocumentFolder('C:\\Bad:Name'), /network folder/);
  assert.throws(() => validatePurchaseDocumentFolder('C:'), /network folder/);
  assert.throws(() => validatePurchaseDocumentFolder('invoices\\x'), /network folder/);
});

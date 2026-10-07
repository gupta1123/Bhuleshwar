import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function validatePurchaseDocumentFolder(value) {
  if (typeof value !== 'string') throw new Error('Enter a shared folder path.');
  const folder = value.trim().replace(/\\+$/, '');
  if (!folder || folder.length > 500 || !/^\\\\[^\\]+\\[^\\]+/.test(folder) ||
      /^\\\\[?.]\\/.test(folder) || /[<>:"|?*\/\x00-\x1f]/.test(folder) ||
      folder.split('\\').some(part => /[. ]$/.test(part))) {
    throw new Error('Use a shared Windows folder such as \\\\AccountsServer\\Invoices\\Kalika.');
  }
  return path.win32.normalize(folder);
}

export async function withFolderTimeout(operation, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The shared invoice folder did not respond. Check the LAN connection and try again.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function testPurchaseDocumentFolder(value) {
  return withFolderTimeout(() => probePurchaseDocumentFolder(value));
}

async function probePurchaseDocumentFolder(value) {
  const folder = validatePurchaseDocumentFolder(value);
  if (process.platform !== 'win32') throw new Error('Shared Windows folders require the Windows connector.');
  const probe = path.win32.join(folder, `.kalika-access-test-${randomUUID()}.tmp`);
  let created = false;
  try {
    const stat = await fs.stat(folder);
    if (!stat.isDirectory()) throw new Error('The configured path is not a folder.');
    await fs.writeFile(probe, 'Kalika folder access test', { flag: 'wx' });
    created = true;
    if (await fs.readFile(probe, 'utf8') !== 'Kalika folder access test') throw new Error('Folder read-back failed.');
    await fs.unlink(probe);
    created = false;
    return { folderPath: folder, readable: true, writable: true };
  } catch (error) {
    throw new Error(`Cannot use the purchase invoice folder (${error.code || error.message}). Check the LAN connection and Windows share permissions.`);
  } finally {
    if (created) await fs.unlink(probe).catch(() => {});
  }
}

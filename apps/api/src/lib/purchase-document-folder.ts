import path from 'node:path';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export function validatePurchaseDocumentFolder(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a shared folder path.');
  const folder = value.trim().replace(/\\+$/, '');
  if (!folder) return '';
  const isUnc = /^\\\\[^\\]+\\[^\\]+/.test(folder);
  const isLocal = /^[A-Za-z]:\\[^\\]/.test(folder);
  const rest = isLocal ? folder.slice(2) : folder;
  if (folder.length > 500 || (!isUnc && !isLocal) ||
      /^\\\\[?.]\\/.test(folder) || /[<>:"|?*\/\x00-\x1f]/.test(rest) ||
      folder.split('\\').some(part => /[. ]$/.test(part))) {
    throw new Error('Use a network folder like \\\\AccountsServer\\Invoices\\Bhuleshwar, or a folder on this PC like C:\\BhuleshwarInvoices.');
  }
  return path.win32.normalize(folder);
}

// Keys to look a company's folder up by, preferred first. The Tally company
// GUID survives a connector re-pair (new connection id); the older
// connection-and-name key is kept as a fallback for folders saved before.
export function purchaseDocumentCompanyKeys(companyId: string | undefined, connectionId: string, companyName: string, companyGuid?: string | null) {
  if (companyId) return [companyId];
  const guid = String(companyGuid || '').trim().toLowerCase();
  return [
    ...(guid ? [`guid:${guid}`] : []),
    `legacy:${connectionId}:${companyName.trim().toLowerCase()}`,
  ];
}

export async function readPurchaseDocumentFolder(organizationId: string, companyKeys: string | string[]) {
  const keys = Array.isArray(companyKeys) ? companyKeys : [companyKeys];
  const { data, error } = await createSupabaseAdminClient().from('purchase_document_folders')
    .select('company_key,folder_path').eq('organization_id', organizationId).in('company_key', keys);
  if (error) {
    // Without the migration no folder can have been saved, so posting keeps
    // using connector-local storage instead of blocking every purchase.
    if (['42P01', 'PGRST205'].includes(String(error.code || ''))) return '';
    throw new Error('Purchase document folder settings are unavailable. Try again.');
  }
  const byKey = new Map((data ?? []).map((row) => [row.company_key, row.folder_path]));
  const saved = keys.map((key) => byKey.get(key)).find((value) => value !== undefined);
  return validatePurchaseDocumentFolder(saved || '');
}

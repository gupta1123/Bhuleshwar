// Keep the legacy presentation helpers, but do not fetch unrelated workflow,
// AI or upload metadata for directory rows.
const BASE = 'id,slug,display_name,buyer_name,po_number,invoice_number,status,risk_score,upload_count,document_count,mismatch_count,created_at';
export const CASE_LIST_META_KEYS = ['caseCategory','packetCategory','documentTypes','termsComplianceMismatchMode','termsComplianceChecklist','recycleBin'] as const;
export const CASE_LIST_COLUMNS_LEGACY = `${BASE},${CASE_LIST_META_KEYS.map(key => `list_${key}:processing_meta->${key}`).join(',')}`;
export const CASE_LIST_COLUMNS = `${CASE_LIST_COLUMNS_LEGACY},deleted_at`;
export function restoreCaseListMetadata<T extends Record<string, unknown>>(row: T): T & {processing_meta: unknown} {
  if (Object.hasOwn(row, 'processing_meta')) return row as T & {processing_meta: unknown};
  return {...row, processing_meta:Object.fromEntries(CASE_LIST_META_KEYS.map(key => [key,row[`list_${key}`] ?? null]))};
}

type Scope = 'active' | 'deleted';
type Sort = 'recent' | 'oldest' | 'name';
export type CaseDirectoryCursor = {sortValue:string; id:string; sort?:Sort; scope?:Scope};
export function makeCaseCursor(row: {id:string;created_at:string;deleted_at?:string|null;display_name:string}, scope:Scope, sort:Sort) {
  const sortValue = scope === 'deleted' ? row.deleted_at : sort === 'name' ? row.display_name : row.created_at;
  return sortValue == null ? null : Buffer.from(JSON.stringify({sortValue,id:row.id,scope,sort})).toString('base64url');
}
export function readCaseCursor(raw:string|null, scope:Scope, sort:Sort): CaseDirectoryCursor|null {
  if (!raw) return null;
  if(raw.length>4096) throw new Error('Invalid pagination cursor');
  let value;
  try { value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8')); } catch { throw new Error('Invalid pagination cursor'); }
  if (!value || typeof value.sortValue!=='string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.id || '') ||
    (value.scope && value.scope!==scope) || (value.sort && value.sort!==sort) ||
    (!value.sort && sort!=='recent') ||
    ((scope==='deleted'||sort!=='name') && !Number.isFinite(Date.parse(value.sortValue)))) throw new Error('Invalid pagination cursor');
  return value;
}
export function cursorPredicate(cursor:CaseDirectoryCursor, scope:Scope, sort:Sort) {
  const column = scope==='deleted'?'deleted_at':sort==='name'?'display_name':'created_at';
  const ascending = scope!=='deleted' && sort!=='recent';
  const direction = ascending?'gt':'lt';
  const idDirection = scope!=='deleted' && sort==='name'?'gt':'lt';
  const quoted = `"${cursor.sortValue.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
  return `${column}.${direction}.${quoted},and(${column}.eq.${quoted},id.${idDirection}.${cursor.id})`;
}
export function missingCaseColumn(error:unknown, column:string) {
  const e=error as {code?:string;message?:string;details?:string};
  return ['42703','PGRST204'].includes(e?.code || '') && `${e.message || ''} ${e.details || ''}`.includes(column);
}

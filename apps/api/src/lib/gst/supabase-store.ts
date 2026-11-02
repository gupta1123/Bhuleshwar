import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { CallLogEntry, GstStore, ReturnKey, StoredReturn } from './return-store';

const MISSING_TABLE = ['42P01', 'PGRST205'];

function fail(action: string, error: { code?: string } | null): never {
  const hint = MISSING_TABLE.includes(String(error?.code || '')) ? ' Ensure the gst_reconciliation migration has been applied.' : '';
  throw new Error(`Could not ${action}.${hint}`);
}

export function createSupabaseGstStore(db = createSupabaseAdminClient()): GstStore {
  return {
    async readSnapshot(key: ReturnKey) {
      const { data, error } = await db.from('gst_return_snapshots')
        .select('payload,transaction_id,is_final,fetched_at,fetch_count')
        .eq('organization_id', key.organizationId).eq('gstin', key.gstin)
        .eq('return_type', key.returnType).eq('period', key.period).eq('section', 'all').maybeSingle();
      if (error) fail('read the saved GST return', error);
      if (!data) return null;
      return {
        payload: data.payload, transactionId: data.transaction_id ?? '', isFinal: data.is_final,
        fetchedAt: data.fetched_at, fetchCount: data.fetch_count,
      } satisfies StoredReturn;
    },
    async saveSnapshot(key, row, fetchedBy) {
      const { error } = await db.from('gst_return_snapshots').upsert({
        organization_id: key.organizationId, gstin: key.gstin, return_type: key.returnType, period: key.period, section: 'all',
        payload: row.payload, transaction_id: row.transactionId || null, is_final: row.isFinal,
        fetched_at: row.fetchedAt, fetched_by: fetchedBy, fetch_count: row.fetchCount,
      }, { onConflict: 'organization_id,gstin,return_type,period,section' });
      if (error) fail('save the GST return', error);
    },
    async countCallsSince(organizationId, sinceIso) {
      const { count, error } = await db.from('gst_api_calls').select('id', { count: 'exact', head: true })
        .eq('organization_id', organizationId).gte('created_at', sinceIso);
      if (error) fail('read the GST call log', error);
      return count ?? 0;
    },
    async logCalls(entries: CallLogEntry[]) {
      if (!entries.length) return;
      const { error } = await db.from('gst_api_calls').insert(entries.map((entry) => ({
        organization_id: entry.organizationId, gstin: entry.gstin, endpoint: entry.endpoint, return_type: entry.returnType,
        period: entry.period, requested_by: entry.requestedBy, ok: entry.ok, transaction_id: entry.transactionId || null,
        error: entry.error,
      })));
      // The call already happened; a lost log row must not fail the request.
      if (error) console.error('GST call log insert failed', error.code);
    },
  };
}

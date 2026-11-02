import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { wakeTallyConnector } from '@/lib/tally/command-wake';
import type { GstScope } from './scope';

type Db = ReturnType<typeof createSupabaseAdminClient>;
type Obj = { [key: string]: unknown };

export class BooksError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const asObj = (value: unknown): Obj => (value && typeof value === 'object' ? (value as Obj) : {});

// Registers are read from the user's own Tally, so only a connection they own
// (and that is open to the requested company) may be asked.
async function requireOpenCompany(db: Db, connectionId: string, companyName: string) {
  const { data } = await db.from('tally_connections')
    .select('id,last_company_name,last_tally_reachable,last_company_loaded')
    .eq('id', connectionId).is('revoked_at', null).maybeSingle();
  if (!data) throw new BooksError('Connection unavailable.', 404);
  if (!data.last_tally_reachable || !data.last_company_loaded || !data.last_company_name) {
    throw new BooksError('Tally must be open with a company loaded to read purchase books.', 409);
  }
  if (String(data.last_company_name).trim().toLowerCase() !== companyName.trim().toLowerCase()) {
    throw new BooksError(`Tally is open to ${data.last_company_name}. Switch Tally to ${companyName} first.`, 409);
  }
  return data.id as string;
}

export async function queueBooksRead(scope: GstScope, input: { connectionId: string; companyName: string; period: string }) {
  const db = createSupabaseAdminClient();
  await requireOpenCompany(db, input.connectionId, input.companyName);
  const { data, error } = await db.from('tally_bridge_commands').insert({
    connection_id: input.connectionId, owner_user_id: scope.userId, command_type: 'fetch_purchase_register',
    status: 'queued', priority: 12, payload: { companyName: input.companyName, period: input.period },
  }).select('id').single();
  if (error || !data) throw new BooksError('Could not queue the purchase books read.', 500);
  await wakeTallyConnector(input.connectionId);
  return { commandId: data.id as string };
}

async function saveBooks(db: Db, scope: GstScope, input: { connectionId: string; commandId: string; period: string }, register: Obj) {
  const vouchers = Array.isArray(register.vouchers) ? register.vouchers : [];
  const payloadText = JSON.stringify(register);
  const { createHash } = await import('node:crypto');
  const { error } = await db.from('tally_books_snapshots').upsert({
    organization_id: scope.organizationId, company_key: scope.companyKey, period: input.period,
    payload: register, voucher_count: vouchers.length,
    payload_hash: createHash('sha256').update(payloadText).digest('hex'),
    connection_id: input.connectionId, command_id: input.commandId, fetched_at: new Date().toISOString(),
  }, { onConflict: 'organization_id,company_key,period' });
  if (error) throw new BooksError('Could not save the purchase books.', 500);
}

export async function readSavedBooks(scope: GstScope, period: string, withPayload: boolean) {
  const db = createSupabaseAdminClient();
  const { data } = await db.from('tally_books_snapshots').select('payload,voucher_count,fetched_at')
    .eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey).eq('period', period).maybeSingle();
  if (!data) return null;
  const skipped = asObj(asObj(data.payload).skipped);
  return {
    fetchedAt: data.fetched_at as string, voucherCount: data.voucher_count as number,
    skippedNoGstin: Array.isArray(skipped.noGstin) ? skipped.noGstin.length : 0,
    ...(withPayload ? { payload: data.payload } : {}),
  };
}

// Poll step: when the connector has finished, save the register once.
export async function finishBooksRead(scope: GstScope, input: { connectionId: string; commandId: string; period: string }) {
  const db = createSupabaseAdminClient();
  const { data } = await db.from('tally_bridge_commands').select('status,result,error,command_type,connection_id')
    .eq('id', input.commandId).eq('connection_id', input.connectionId).maybeSingle();
  if (!data || data.command_type !== 'fetch_purchase_register') throw new BooksError('Books read not found.', 404);
  if (data.status === 'failed' || data.status === 'canceled') return { state: 'failed' as const, error: data.error || 'The purchase books read failed.' };
  if (data.status !== 'succeeded') return { state: 'pending' as const };
  const result = asObj(data.result);
  const register = Array.isArray(result.vouchers) ? result : asObj(result.result);
  if (!Array.isArray(register.vouchers)) return { state: 'failed' as const, error: 'The connector returned no purchase register.' };
  await saveBooks(db, scope, input, register);
  return { state: 'saved' as const, books: await readSavedBooks(scope, input.period, false) };
}

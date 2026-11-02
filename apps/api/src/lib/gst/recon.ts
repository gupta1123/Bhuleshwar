import { reconcile } from '@autodealer/shared/lib/gst-engine';
import * as N from '@autodealer/shared/lib/gst-normalize';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseGstStore } from './supabase-store';
import { loadConnection, loadPolicy, platformToken, sandboxClientFromEnv, GstServiceError } from './service';
import type { GstScope } from './scope';

type Db = ReturnType<typeof createSupabaseAdminClient>;
type Obj = { [key: string]: unknown };

const asObj = (value: unknown): Obj => (value && typeof value === 'object' ? (value as Obj) : {});
type EngineResult = { summary: unknown; movement: unknown; buckets: Obj[]; rows: Obj[]; filed: unknown; suppliers: unknown };
const DECISIONS = ['hold', 'chase_supplier', 'accept', 'reject', 'book_it', 'reopen'] as const;
const SUPPLIER_TTL_DAYS = 60;

export class ReconError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type ReconSettings = { tolerance: { amount: number; percent: number; dateWindowDays: number }; includeA2: boolean; fuzzy: boolean };
const DEFAULT_SETTINGS: ReconSettings = { tolerance: { amount: 1, percent: 0, dateWindowDays: 7 }, includeA2: true, fuzzy: true };

function mergeSettings(raw: unknown): ReconSettings {
  const value = asObj(raw);
  const tolerance = asObj(value.tolerance);
  const number = (candidate: unknown, fallback: number) => (typeof candidate === 'number' && candidate >= 0 ? candidate : fallback);
  return {
    tolerance: {
      amount: number(tolerance.amount, DEFAULT_SETTINGS.tolerance.amount),
      percent: number(tolerance.percent, DEFAULT_SETTINGS.tolerance.percent),
      dateWindowDays: number(tolerance.dateWindowDays, DEFAULT_SETTINGS.tolerance.dateWindowDays),
    },
    includeA2: value.includeA2 !== false,
    fuzzy: value.fuzzy !== false,
  };
}

export async function readSettings(scope: GstScope) {
  const db = createSupabaseAdminClient();
  const { data } = await db.from('gst_recon_settings').select('settings,daily_call_cap,min_refresh_minutes')
    .eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey).maybeSingle();
  return {
    ...mergeSettings(data?.settings),
    dailyCallCap: data?.daily_call_cap ?? 100,
    minRefreshMinutes: data?.min_refresh_minutes ?? 60,
  };
}

export async function saveSettings(scope: GstScope, input: Obj) {
  const db = createSupabaseAdminClient();
  const current = await readSettings(scope);
  const next = mergeSettings({ ...current, ...input, tolerance: { ...current.tolerance, ...asObj(input.tolerance) } });
  const cap = Number(input.dailyCallCap ?? current.dailyCallCap);
  const gap = Number(input.minRefreshMinutes ?? current.minRefreshMinutes);
  if (!Number.isInteger(cap) || cap < 0 || cap > 1000) throw new ReconError('Daily call limit must be between 0 and 1000.', 400);
  if (!Number.isInteger(gap) || gap < 0 || gap > 1440) throw new ReconError('Minimum gap must be between 0 and 1440 minutes.', 400);
  const { error } = await db.from('gst_recon_settings').upsert({
    organization_id: scope.organizationId, company_key: scope.companyKey, settings: next,
    daily_call_cap: cap, min_refresh_minutes: gap, updated_by: scope.userId, updated_at: new Date().toISOString(),
  }, { onConflict: 'organization_id,company_key' });
  if (error) throw new ReconError('Could not save the settings.', 500);
  return readSettings(scope);
}

function validPeriods(value: unknown) {
  const periods = Array.isArray(value) ? value.map(String) : [];
  if (!periods.length || periods.length > 12 || periods.some((p) => !/^\d{4}-(0[1-9]|1[0-2])$/.test(p))) {
    throw new ReconError('Choose between 1 and 12 months (YYYY-MM).', 400);
  }
  return [...new Set(periods)].sort();
}

// What is saved for each month, so the screen can show what is missing before spending any calls.
export async function dataReadiness(scope: GstScope, periodsInput: unknown) {
  const periods = validPeriods(periodsInput);
  const db = createSupabaseAdminClient();
  const connection = await loadConnection(db, scope);
  const gstin = connection?.gstin ?? '';
  const [returns, books] = await Promise.all([
    gstin ? db.from('gst_return_snapshots').select('return_type,period,fetched_at,is_final')
      .eq('organization_id', scope.organizationId).eq('gstin', gstin).in('period', periods) : { data: [] },
    db.from('tally_books_snapshots').select('period,fetched_at,voucher_count')
      .eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey).in('period', periods),
  ]);
  return periods.map((period) => {
    const rows = (returns.data ?? []).filter((row) => row.period === period);
    const pick = (type: string) => rows.find((row) => row.return_type === type);
    const book = (books.data ?? []).find((row) => row.period === period);
    return {
      period,
      books: book ? { fetchedAt: book.fetched_at, voucherCount: book.voucher_count } : null,
      gstr2b: pick('gstr2b') ? { fetchedAt: pick('gstr2b')!.fetched_at, isFinal: pick('gstr2b')!.is_final } : null,
      gstr2a: pick('gstr2a') ? { fetchedAt: pick('gstr2a')!.fetched_at, isFinal: pick('gstr2a')!.is_final } : null,
      gstr3b: pick('gstr3b') ? { fetchedAt: pick('gstr3b')!.fetched_at, isFinal: pick('gstr3b')!.is_final } : null,
    };
  });
}

// Reconcile on what is already saved. Never calls the GST portal or Tally.
export async function runReconcile(scope: GstScope, input: Obj) {
  const periods = validPeriods(input.periods);
  const db = createSupabaseAdminClient();
  const connection = await loadConnection(db, scope);
  if (!connection) throw new GstServiceError('Connect a GST account for this company first.', 'not_connected', 409);
  const gstin = String(connection.gstin);
  const store = createSupabaseGstStore(db);
  const settings = mergeSettings((await readSettings(scope)));

  const books: unknown[] = []; const a2: unknown[] = []; const b2: unknown[] = []; const g3b: unknown[] = [];
  const missing: { kind: string; period: string }[] = [];
  const versions: Record<string, string> = {};
  let booksAsOf: string | null = null;

  for (const period of periods) {
    const { data: bookRow } = await db.from('tally_books_snapshots').select('payload,fetched_at')
      .eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey).eq('period', period).maybeSingle();
    if (bookRow) {
      books.push(...N.fromBooks(bookRow.payload));
      versions[`books:${period}`] = bookRow.fetched_at;
      if (!booksAsOf || bookRow.fetched_at < booksAsOf) booksAsOf = bookRow.fetched_at;
    } else missing.push({ kind: 'books', period });

    const key = (returnType: 'gstr2a' | 'gstr2b' | 'gstr3b') => ({ organizationId: scope.organizationId, gstin, returnType, period });
    const [r2b, r2a, r3b] = await Promise.all([store.readSnapshot(key('gstr2b')), store.readSnapshot(key('gstr2a')), store.readSnapshot(key('gstr3b'))]);
    if (r2b) { b2.push(...N.from2B(r2b.payload)); versions[`gstr2b:${period}`] = r2b.fetchedAt; } else missing.push({ kind: 'gstr2b', period });
    if (r2a) { a2.push(...N.from2A(r2a.payload)); versions[`gstr2a:${period}`] = r2a.fetchedAt; }
    if (r3b) { const parsed = N.from3B(r3b.payload); if (parsed) g3b.push(parsed); versions[`gstr3b:${period}`] = r3b.fetchedAt; }
  }
  // Books and GSTR-2B are the two sides of the match; 2A and 3B only add detail.
  if (missing.length) return { state: 'incomplete' as const, missing };

  const { data: previous } = await db.from('gst_recon_runs').select('id').eq('organization_id', scope.organizationId)
    .eq('company_key', scope.companyKey).eq('status', 'complete').order('created_at', { ascending: false }).limit(1).maybeSingle();
  const prior: Record<string, { b: string; p?: number }> = {};
  if (previous) {
    const { data: priorItems } = await db.from('gst_recon_items').select('item_key,bucket,g2b').eq('run_id', previous.id).limit(20000);
    for (const item of priorItems ?? []) prior[item.item_key] = { b: item.bucket, p: item.g2b ? 1 : 0 };
  }
  const { data: supplierRows } = await db.from('supplier_profiles').select('gstin,filing_frequency').not('filing_frequency', 'is', null);
  const suppliers = (supplierRows ?? []).map((row) => ({ gstin: row.gstin, filingFrequency: row.filing_frequency }));

  const result = (reconcile as unknown as (input: Obj) => EngineResult)({
    books, a2, b2, g3b, suppliers,
    opts: { asOf: new Date().toISOString().slice(0, 10), tolerance: settings.tolerance, includeA2: settings.includeA2, fuzzy: settings.fuzzy, prior },
  });

  const { data: run, error } = await db.from('gst_recon_runs').insert({
    organization_id: scope.organizationId, company_key: scope.companyKey, gstin, periods, settings,
    totals: { summary: result.summary, movement: result.movement, buckets: result.buckets.map((b) => ({ id: b.id, label: b.label, count: b.count })), filed: result.filed, suppliers: result.suppliers },
    data_versions: versions, books_as_of: booksAsOf, status: 'complete', created_by: scope.userId,
  }).select('id,created_at').single();
  if (error || !run) throw new ReconError('Could not save the reconciliation run.', 500);

  const rows = result.rows.map((row) => ({
    run_id: run.id, organization_id: scope.organizationId, item_key: String(row.key), period: (row.period as string) || null,
    supplier_gstin: row.gstin as string, invoice_no: row.invoiceNo as string, invoice_date: (row.invoiceDate as string) || null,
    doc_type: row.docType as string, bucket: row.bucket as string,
    flags: [row.awaited && 'awaited', row.fuzzyLinked && 'fuzzy', row.amended && 'amended', row.rcm && 'rcm', row.imsRejected && 'ims_rejected', row.expired && 'expired'].filter(Boolean),
    reason: row.reason as string, match_type: row.fuzzyLinked ? 'fuzzy' : row.b2 && row.books ? 'exact' : null,
    itc_at_risk: Number(row.atRiskTax) || 0,
    books: row.books ?? null, g2b: row.b2 ?? null, g2a: row.a2 ?? null,
  }));
  for (let start = 0; start < rows.length; start += 400) {
    const { error: itemError } = await db.from('gst_recon_items').insert(rows.slice(start, start + 400));
    if (itemError) {
      await db.from('gst_recon_runs').update({ status: 'failed', error: 'Could not save the result rows.' }).eq('id', run.id);
      throw new ReconError('Could not save the reconciliation result.', 500);
    }
  }
  return { state: 'done' as const, runId: run.id as string, createdAt: run.created_at as string, itemCount: rows.length };
}

// Latest run, rows joined with the current decision for each item.
export async function readRun(scope: GstScope, runId?: string) {
  const db = createSupabaseAdminClient();
  let query = db.from('gst_recon_runs').select('*').eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey).eq('status', 'complete');
  query = runId ? query.eq('id', runId) : query.order('created_at', { ascending: false }).limit(1);
  const { data: run } = await query.maybeSingle();
  if (!run) return null;
  const [items, decisions] = await Promise.all([
    db.from('gst_recon_items').select('*').eq('run_id', run.id).limit(20000),
    db.from('gst_recon_decisions').select('item_key,decision,note,decided_by_name,decided_at')
      .eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey).order('decided_at', { ascending: false }).limit(20000),
  ]);
  const latest = new Map<string, Obj>();
  for (const decision of decisions.data ?? []) if (!latest.has(decision.item_key)) latest.set(decision.item_key, decision);
  return {
    run: { id: run.id, createdAt: run.created_at, gstin: run.gstin, periods: run.periods, booksAsOf: run.books_as_of, dataVersions: run.data_versions, totals: run.totals },
    items: (items.data ?? []).map((item) => ({
      key: item.item_key, period: item.period, gstin: item.supplier_gstin, invoiceNo: item.invoice_no, invoiceDate: item.invoice_date,
      docType: item.doc_type, bucket: item.bucket, flags: item.flags, reason: item.reason, matchType: item.match_type,
      atRisk: Number(item.itc_at_risk), books: item.books, g2b: item.g2b, g2a: item.g2a, decision: latest.get(item.item_key) ?? null,
    })),
  };
}

export async function recentRuns(scope: GstScope) {
  const { data } = await createSupabaseAdminClient().from('gst_recon_runs').select('id,created_at,periods,totals,books_as_of')
    .eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey).eq('status', 'complete')
    .order('created_at', { ascending: false }).limit(30);
  return (data ?? []).map((run) => ({ id: run.id, createdAt: run.created_at, periods: run.periods, booksAsOf: run.books_as_of, summary: asObj(run.totals).summary }));
}

async function displayName(db: Db, userId: string) {
  const { data } = await db.auth.admin.getUserById(userId);
  const meta = asObj(data?.user?.user_metadata);
  return String(meta.full_name || meta.name || data?.user?.email || 'Team member').slice(0, 120);
}

export async function recordDecision(scope: GstScope, input: Obj) {
  const decision = String(input.decision || '');
  const itemKey = String(input.itemKey || '');
  const note = String(input.note || '').trim().slice(0, 1000);
  if (!(DECISIONS as readonly string[]).includes(decision)) throw new ReconError('Unknown decision.', 400);
  if (!itemKey) throw new ReconError('Choose an invoice first.', 400);
  const db = createSupabaseAdminClient();
  const { error } = await db.from('gst_recon_decisions').insert({
    organization_id: scope.organizationId, company_key: scope.companyKey, item_key: itemKey,
    run_id: typeof input.runId === 'string' && input.runId ? input.runId : null, decision, note: note || null,
    decided_by: scope.userId, decided_by_name: await displayName(db, scope.userId),
  });
  if (error) throw new ReconError('Could not save the decision.', 500);
  return { ok: true };
}

export async function decisionHistory(scope: GstScope, itemKey: string) {
  const { data } = await createSupabaseAdminClient().from('gst_recon_decisions').select('decision,note,decided_by_name,decided_at')
    .eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey).eq('item_key', itemKey)
    .order('decided_at', { ascending: false }).limit(50);
  return data ?? [];
}

// Supplier status from the portal, saved for 60 days and shared across clients (public data).
export async function lookupSupplier(scope: GstScope, gstinInput: string, refresh: boolean) {
  const gstin = N.gstin(gstinInput);
  if (!N.isValidGstin(gstin)) throw new ReconError('That is not a valid GSTIN.', 400);
  const db = createSupabaseAdminClient();
  const { data: saved } = await db.from('supplier_profiles').select('*').eq('gstin', gstin).maybeSingle();
  const fresh = saved && Date.now() - Date.parse(saved.verified_at) < SUPPLIER_TTL_DAYS * 86_400_000;
  if (saved && fresh && !refresh) return { source: 'saved' as const, profile: serializeSupplier(saved) };

  const connection = await loadConnection(db, scope);
  const policy = await loadPolicy(db, scope);
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const used = await createSupabaseGstStore(db).countCallsSince(scope.organizationId, since);
  if (used + 1 > policy.dailyCap) throw new ReconError('Today\'s GST call limit is reached. Try again tomorrow or raise the limit in Settings.', 429);
  const found = await sandboxClientFromEnv().searchGstin(await platformToken(db), gstin);
  await createSupabaseGstStore(db).logCalls([{
    organizationId: scope.organizationId, gstin: connection?.gstin ?? gstin, endpoint: 'gstin/search', returnType: 'gstr2b', period: new Date().toISOString().slice(0, 7),
    requestedBy: scope.userId, ok: true, transactionId: found.transactionId, error: null,
  }]);
  const info = asObj(asObj(asObj(found.payload).data).data);
  const row = {
    gstin, legal_name: String(info.lgnm || '') || null, trade_name: String(info.tradeNam || '') || null,
    status: String(info.sts || '') || null, cancellation_date: /^\d{2}\/\d{2}\/\d{4}$/.test(String(info.cxdt || ''))
      ? String(info.cxdt).split('/').reverse().join('-') : null,
    taxpayer_type: String(info.dty || '') || null, constitution: String(info.ctb || '') || null,
    state_code: gstin.slice(0, 2), address: asObj(asObj(info.pradr).addr), raw: info, source: 'portal', verified_at: new Date().toISOString(),
  };
  if (!row.status) throw new ReconError('The portal returned no status for this GSTIN.', 502);
  await db.from('supplier_profiles').upsert(row, { onConflict: 'gstin' });
  return { source: 'portal' as const, profile: serializeSupplier(row) };
}

function serializeSupplier(row: Obj) {
  const type = String(row.taxpayer_type || '');
  const status = String(row.status || '');
  return {
    gstin: row.gstin, legalName: row.legal_name, tradeName: row.trade_name, status, cancellationDate: row.cancellation_date,
    taxpayerType: type, constitution: row.constitution, verifiedAt: row.verified_at,
    warning: /cancel|suspend/i.test(status) ? 'This supplier\'s registration is not active. ITC on new invoices is at risk.'
      : /composition/i.test(type) ? 'Composition supplier. They cannot charge GST, so ITC is not available.' : null,
  };
}

export async function savedSuppliers(gstins: string[]) {
  if (!gstins.length) return [];
  const { data } = await createSupabaseAdminClient().from('supplier_profiles').select('*').in('gstin', gstins.slice(0, 500));
  return (data ?? []).map((row) => serializeSupplier(row));
}

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { DEFAULT_PULL_POLICY, getReturn, type GstReturnType, type PullPolicy } from './return-store';
import { createSandboxClient, SandboxError, type TaxpayerSession } from './sandbox-client';
import { decryptSecret, encryptSecret } from './secret-box';
import type { GstScope } from './scope';
import { createSupabaseGstStore } from './supabase-store';

export class GstServiceError extends Error {
  constructor(message: string, readonly code: 'not_connected' | 'session_expired' | 'not_configured', readonly status: number) {
    super(message);
  }
}

type Db = ReturnType<typeof createSupabaseAdminClient>;

export function sandboxClientFromEnv() {
  const { SANDBOX_BASE_URL, SANDBOX_API_KEY, SANDBOX_API_SECRET, SANDBOX_API_VERSION } = process.env;
  if (!SANDBOX_BASE_URL || !SANDBOX_API_KEY || !SANDBOX_API_SECRET) {
    throw new GstServiceError('GST access is not configured on the server.', 'not_configured', 503);
  }
  return createSandboxClient({ baseUrl: SANDBOX_BASE_URL, apiKey: SANDBOX_API_KEY, apiSecret: SANDBOX_API_SECRET, apiVersion: SANDBOX_API_VERSION });
}

async function loadConnection(db: Db, scope: GstScope) {
  const { data, error } = await db.from('gst_connections').select('*')
    .eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey)
    .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error('Could not read the GST connection. Ensure the gst_reconciliation migration has been applied.');
  return data;
}

async function loadPolicy(db: Db, scope: GstScope): Promise<PullPolicy> {
  const { data } = await db.from('gst_recon_settings').select('daily_call_cap,min_refresh_minutes')
    .eq('organization_id', scope.organizationId).eq('company_key', scope.companyKey).maybeSingle();
  return data ? { dailyCap: data.daily_call_cap, minRefreshMinutes: data.min_refresh_minutes } : DEFAULT_PULL_POLICY;
}

async function saveSession(db: Db, connectionId: string, session: TaxpayerSession) {
  const { error } = await db.from('gst_connections').update({
    status: 'active', session_token_enc: encryptSecret(session.token),
    session_expiry: new Date(session.sessionExpiry).toISOString(), token_expiry: new Date(session.tokenExpiry).toISOString(),
    verified_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString(),
  }).eq('id', connectionId);
  if (error) throw new Error('Could not save the refreshed GST session.');
}

export async function gstStatus(scope: GstScope) {
  const db = createSupabaseAdminClient();
  const connection = await loadConnection(db, scope);
  if (!connection) return { connected: false as const };
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const [calls, snapshots, policy] = await Promise.all([
    db.from('gst_api_calls').select('id', { count: 'exact', head: true }).eq('organization_id', scope.organizationId).gte('created_at', since),
    db.from('gst_return_snapshots').select('return_type,period,fetched_at,is_final,fetch_count')
      .eq('organization_id', scope.organizationId).eq('gstin', connection.gstin).order('period', { ascending: false }).limit(60),
    loadPolicy(db, scope),
  ]);
  const sessionLive = connection.status === 'active' && Date.parse(connection.session_expiry) > Date.now();
  return {
    connected: true as const,
    gstin: connection.gstin,
    username: connection.gst_username,
    status: sessionLive ? 'active' : connection.status === 'active' ? 'expired' : connection.status,
    sessionExpiry: connection.session_expiry,
    verifiedAt: connection.verified_at,
    callsLast24h: calls.count ?? 0,
    dailyCap: policy.dailyCap,
    minRefreshMinutes: policy.minRefreshMinutes,
    snapshots: (snapshots.data ?? []).map((row) => ({
      returnType: row.return_type, period: row.period, fetchedAt: row.fetched_at, isFinal: row.is_final, fetchCount: row.fetch_count,
    })),
  };
}

export async function pullGstReturn(scope: GstScope, input: { returnType: GstReturnType; period: string; refresh: boolean }) {
  const db = createSupabaseAdminClient();
  const connection = await loadConnection(db, scope);
  if (!connection) throw new GstServiceError('Connect a GST account for this company first.', 'not_connected', 409);
  const client = sandboxClientFromEnv();

  const fetchFromPortal = async (returnType: GstReturnType, period: string) => {
    if (!connection.session_token_enc) throw new GstServiceError('The GST session has expired. A new OTP is needed.', 'session_expired', 409);
    const stored: TaxpayerSession = {
      token: decryptSecret(connection.session_token_enc),
      sessionExpiry: Date.parse(connection.session_expiry), tokenExpiry: Date.parse(connection.token_expiry),
    };
    try {
      const { session, refreshed } = await client.ensureSession(stored);
      if (refreshed) await saveSession(db, connection.id, session);
      if (returnType === 'gstr2b') return await client.getGstr2b(session, period);
      if (returnType === 'gstr3b') return await client.getGstr3b(session, period);
      return await client.getGstr2a(session, period, ['b2b', 'cdn']);
    } catch (error) {
      if (error instanceof SandboxError && error.kind === 'session') {
        await db.from('gst_connections').update({ status: 'expired', last_error: error.message, updated_at: new Date().toISOString() }).eq('id', connection.id);
        throw new GstServiceError('The GST session has expired. A new OTP is needed.', 'session_expired', 409);
      }
      throw error;
    }
  };

  return getReturn(
    { store: createSupabaseGstStore(db), fetchFromPortal },
    { organizationId: scope.organizationId, gstin: connection.gstin, returnType: input.returnType, period: input.period },
    { refresh: input.refresh, userId: scope.userId, policy: await loadPolicy(db, scope) },
  );
}

// One shared Sandbox token for every client, cached so OTP calls do not re-authenticate.
async function platformToken(db: Db) {
  const client = sandboxClientFromEnv();
  const { data } = await db.from('gst_platform_tokens').select('access_token_enc,expires_at').eq('id', 1).maybeSingle();
  if (data && Date.parse(data.expires_at) - Date.now() > 10 * 60_000) return decryptSecret(data.access_token_enc);
  const fresh = await client.authenticate();
  await db.from('gst_platform_tokens').upsert({
    id: 1, access_token_enc: encryptSecret(fresh.accessToken), issued_at: new Date().toISOString(), expires_at: new Date(fresh.expiresAt).toISOString(),
  });
  return fresh.accessToken;
}

async function upsertConnection(db: Db, scope: GstScope, gstin: string, username: string, status: string) {
  const { data, error } = await db.from('gst_connections').upsert({
    organization_id: scope.organizationId, company_key: scope.companyKey, gstin, gst_username: username,
    status, created_by: scope.userId, updated_at: new Date().toISOString(),
  }, { onConflict: 'organization_id,gstin' }).select('id').single();
  if (error || !data) throw new Error('Could not save the GST connection.');
  return data.id as string;
}

export async function sendGstOtp(scope: GstScope, input: { gstin: string; username: string }) {
  const db = createSupabaseAdminClient();
  await sandboxClientFromEnv().generateOtp(await platformToken(db), input);
  await upsertConnection(db, scope, input.gstin, input.username, 'otp_sent');
}

export async function verifyGstOtp(scope: GstScope, input: { gstin: string; username: string; otp: string }) {
  const db = createSupabaseAdminClient();
  const session = await sandboxClientFromEnv().verifyOtp(await platformToken(db), input);
  const id = await upsertConnection(db, scope, input.gstin, input.username, 'active');
  await saveSession(db, id, session);
  return { sessionExpiry: new Date(session.sessionExpiry).toISOString() };
}

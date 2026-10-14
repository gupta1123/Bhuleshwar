import { createClient } from '@supabase/supabase-js';

const TYPES = new Set(['bank_job_progress','bank_job_completed','bank_job_failed','bank_job_cancelled']);
export function compactBankJobEvent(type, value) {
  if (!TYPES.has(type) || typeof value?.jobId !== 'string' || value.jobId.length > 128 ||
      !Number.isSafeInteger(Number(value.revision)) || Number(value.revision) < 1) return null;
  return { type, jobId: value.jobId, ...(typeof value.importId === 'string' ? { importId: value.importId } : {}),
    revision: Number(value.revision), state: String(value.state || '').slice(0, 32) };
}
const topicFor = (owner, connection) => `bank-jobs:${owner}:${connection}`;
function configuration() {
  return { url: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
export async function publishBankJobEvent(identity, type, value, fetchImpl = fetch) {
  const event = compactBankJobEvent(type, value); const { url, key } = configuration();
  if (!event || !url || !key || !identity.ownerUserId || !identity.connectionId) return false;
  const endpoint = `${url.replace(/\/+$/, '')}/realtime/v1/api/broadcast/${encodeURIComponent(topicFor(identity.ownerUserId, identity.connectionId))}/events/bank_job?private=true`;
  try {
    const response = await fetchImpl(endpoint, { method: 'POST', headers: {
      apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(event), signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch { return false; }
}
const subscriptions = new Map();
let client;
export function subscribeBankJobEvents(owner, connection, onEvent, onStatus) {
  const { url, key } = configuration();
  if (!url || !key || !owner || !connection) { onStatus(false); return () => {}; }
  client ||= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const topic = topicFor(owner, connection);
  let entry = subscriptions.get(topic);
  if (!entry) {
    entry = { listeners: new Set(), online: false, channel: client.channel(topic, { config: { private: true } }) };
    subscriptions.set(topic, entry);
    const current = entry;
    current.channel.on('broadcast', { event: 'bank_job' }, ({ payload }) => {
      const event = compactBankJobEvent(payload?.type, payload);
      if (event) for (const listener of current.listeners) { try { listener.onEvent(event); } catch { /* isolated socket */ } }
    }).subscribe(status => {
      current.online = status === 'SUBSCRIBED';
      for (const listener of current.listeners) { try { listener.onStatus(current.online); } catch { /* isolated socket */ } }
    });
  }
  const listener = { onEvent, onStatus }; entry.listeners.add(listener); onStatus(entry.online);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size && subscriptions.get(topic) === entry) {
      subscriptions.delete(topic);
      const channelClient = client;
      const last = subscriptions.size === 0;
      if (last) client = undefined;
      return channelClient.removeChannel(entry.channel).catch(() => {}).finally(() => {
        if (last) return channelClient.realtime.disconnect();
      });
    }
  };
}

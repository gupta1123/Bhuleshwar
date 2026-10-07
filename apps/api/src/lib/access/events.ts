import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export function accessEvent(value: unknown): { revision: number } | null {
  if (!value || typeof value !== 'object') return null;
  const revision = (value as { revision?: unknown }).revision;
  return Number.isSafeInteger(revision) && Number(revision) > 0 ? { revision: Number(revision) } : null;
}

/** Server-side jobs observe revocation without adding a fast database poll. */
export function subscribeAccessChanges(organization:string,onChange:()=>void,onStatus:(online:boolean)=>void) {
 const db=createSupabaseAdminClient();
 const channel=db.channel(`access:${organization}`,{config:{private:true}});
 channel.on('broadcast',{event:'access_changed'},({payload})=>{if(accessEvent(payload))onChange();})
  .subscribe(status=>onStatus(status==='SUBSCRIBED'));
 return ()=>db.removeChannel(channel).catch(()=>{}).finally(()=>db.realtime.disconnect()).catch(()=>{});
}

// Shared private Supabase transport: API replicas and the live server see the same change.
// Membership and company data never appear in notifications.
export async function publishAccessChange(organization: string, revision: number) {
  const event = accessEvent({ revision });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!event || !url || !key) return false;
  try {
    const result = await fetch(`${url.replace(/\/+$/, '')}/realtime/v1/api/broadcast/${encodeURIComponent(`access:${organization}`)}/events/access_changed?private=true`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event), signal: AbortSignal.timeout(2500),
    });
    return result.ok;
  } catch { return false; }
}

export function accessEventStream(request: Request, userId: string, organization: string) {
  const db = createSupabaseAdminClient();
  const encoder = new TextEncoder();
  let dispose = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let checking = false;
      const send = (event: string, value: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
      };
      const channel = db.channel(`access:${organization}`, { config: { private: true } });
      const check = async () => {
        if (checking || closed) return;
        checking = true;
        try {
          const result = await db.rpc('access_snapshot', { p_user: userId, p_org: organization });
          if (result.error || !result.data?.member || result.data.member.must_change_password) {
            send('access_revoked', {}); dispose(); return;
          }
          send('access_changed', { revision: result.data.revision });
        } catch { send('transport', { online: false }); }
        finally { checking = false; }
      };
      channel.on('broadcast', { event: 'access_changed' }, ({ payload }) => {
        if (accessEvent(payload)) void check();
      }).subscribe(status => send('transport', { online: status === 'SUBSCRIBED' }));
      // Proxies in front of the API (Netlify, Heroku's router) close a request
      // after about 30 s. The stream therefore ends itself at 25 s: it first
      // re-checks access (covering any lost notification; never trust a
      // notification as authority), then tells the page to reconnect at once.
      const timer = setTimeout(() => {
        void check().finally(() => { send('reconnect', {}); dispose(); });
      }, 25_000);
      dispose = () => {
        if (closed) return;
        closed = true; clearTimeout(timer); request.signal.removeEventListener('abort', dispose);
        void db.removeChannel(channel).catch(() => {}).finally(() => db.realtime.disconnect()).catch(() => {});
        try { controller.close(); } catch { /* The response reader may already have cancelled. */ }
      };
      request.signal.addEventListener('abort', dispose, { once: true });
      if (request.signal.aborted) dispose();
      else send('snapshot', { organizationId: organization });
    },
    cancel() { dispose(); },
  });
}

'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { AccessSnapshot } from '@autodealer/shared/lib/access';
import { apiFetch } from '@/lib/api-client';
import { consumeAccessEvents } from '@/lib/access-live';

type State = {
  snapshot: AccessSnapshot | null; loading: boolean; error: string | null;
  enforcementRequired: boolean;
  organizations: Array<{ id: string; name: string }>;
  refresh: () => Promise<void>; selectOrganization: (id: string) => void;
};
const Context = createContext<State>({ snapshot: null, loading: true, error: null, enforcementRequired: false, organizations: [], refresh: async () => {}, selectOrganization: () => {} });
export function AccessProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AccessSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enforcementRequired,setEnforcementRequired]=useState(process.env.NEXT_PUBLIC_TEAM_ACCESS_ENFORCEMENT==='true');
  const [organizations, setOrganizations] = useState<State['organizations']>([]);
  const running = useRef(false), generation = useRef(0), revision = useRef(''), available = useRef(false), live = useRef(false);
  const waiting = useRef<Array<()=>void>>([]);
  const mounted = useRef(true);
  const currentRevision = useRef(0);
  const pathname = usePathname(), router = useRouter();
  const invalidate = useCallback(() => {
    window.dispatchEvent(new CustomEvent('kalika-access-invalidated'));
    window.dispatchEvent(new CustomEvent('kalika:tally-status-invalidated'));
  }, []);
  const refresh = useCallback(async () => {
    if (running.current) {
      // A mutation must await a fresh snapshot, not an older in-flight read.
      generation.current++;
      return new Promise<void>(resolve=>waiting.current.push(resolve));
    }
    running.current = true; const version = generation.current;
    try {
      const response = await apiFetch('/api/access/me', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (version !== generation.current) return;
      if(data.sharingEnabled||data.enforcementRequired)setEnforcementRequired(true);
      if (!response.ok) {
        available.current = response.status !== 503;
        if (revision.current) invalidate();
        revision.current = ''; currentRevision.current = 0;
        setSnapshot(null); setOrganizations([]); setError(data.error || data.reason || 'Team access is unavailable.'); return;
      }
      available.current = true; setOrganizations(data.organizations || []); setError(null);
      if (data.selectionRequired) { if (revision.current) invalidate(); revision.current = ''; setSnapshot(null); return; }
      const key = data.member.user_id + ':' + data.organizationId + ':' + data.revision;
      const unchanged = revision.current === key;
      if (revision.current && !unchanged) invalidate();
      revision.current = key; currentRevision.current = data.revision;
      setSnapshot(previous => previous && unchanged ? previous : data);
    } catch {
      if (version === generation.current) { invalidate(); setSnapshot(null); setError('Could not verify access. Try again.'); }
    } finally {
      running.current = false;
      if (version === generation.current || !mounted.current) {
        if(mounted.current)setLoading(false);
        for(const resolve of waiting.current.splice(0))resolve();
      } else void refresh();
    }
  }, [invalidate]);
  useEffect(() => {
    mounted.current=true;
    void refresh();
    const focus = () => { if (document.visibilityState === 'visible') void refresh(); };
    const authChanged = () => { generation.current++; revision.current = ''; setSnapshot(null); setLoading(true); invalidate(); void refresh(); };
    window.addEventListener('focus', focus); window.addEventListener('kalika-access-changed', focus);
    window.addEventListener('kalika-auth-changed', authChanged);
    const timer = setInterval(() => { if (available.current && !live.current) focus(); }, 30000);
    return () => {
      mounted.current=false;
      generation.current++; clearInterval(timer);
      window.removeEventListener('focus', focus); window.removeEventListener('kalika-access-changed', focus);
      window.removeEventListener('kalika-auth-changed', authChanged);
    };
  }, [refresh, invalidate]);
  const org = snapshot?.organizationId, user = snapshot?.member.user_id, passwordRequired = snapshot?.member.must_change_password;
  useEffect(() => {
    if (!org || !user || passwordRequired) return;
    const controller = new AbortController(); let reconnect: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      // The server ends each stream after ~25 s (proxies cut long requests)
      // with a "reconnect" event: reconnect at once. Any other end is a
      // failure: re-check access and retry after a pause.
      let rotated = false;
      try {
        const response = await apiFetch('/api/access/events', { signal: controller.signal, headers: { 'X-Kalika-Organization': org } });
        await consumeAccessEvents(response, (type, data) => {
          if (controller.signal.aborted) return;
          if (type === 'transport') live.current = data.online === true;
          if (type === 'reconnect') rotated = true;
          if (type === 'access_revoked' || (type === 'access_changed' && Number(data.revision) > currentRevision.current)) void refresh();
        });
      } catch { /* durable snapshot fallback remains active */ }
      finally {
        if (!controller.signal.aborted) {
          if (rotated) void connect();
          else { live.current = false; reconnect = setTimeout(() => { void refresh(); void connect(); }, 15000); }
        }
      }
    };
    void connect();
    return () => { controller.abort(); if (reconnect) clearTimeout(reconnect); live.current = false; };
  }, [org, user, passwordRequired, refresh]);
  useEffect(() => {
    if (passwordRequired && pathname !== '/account/change-password' && !pathname.startsWith('/auth/')) router.replace('/account/change-password');
  }, [passwordRequired, pathname, router]);
  const selectOrganization = useCallback((id: string) => {
    if (!organizations.some(o => o.id === id)) return;
    generation.current++; sessionStorage.setItem('kalika-access-organization', id);
    setSnapshot(null); setLoading(true); invalidate(); void refresh();
  }, [organizations, refresh, invalidate]);
  return <Context.Provider value={{ snapshot, loading, error, enforcementRequired, organizations, refresh, selectOrganization }}>{children}</Context.Provider>;
}
export const useAccess = () => useContext(Context);

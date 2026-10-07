"use client";

import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';
import { readPreferredTallyConnectionId } from '@/lib/tally-company-selection';
import { deriveTallyIndicator, heartbeatAge, INITIAL_TALLY_INDICATOR,
  type ConnectionObservation, type IndicatorScope } from '@/lib/tally-status-state';

const Context = createContext(INITIAL_TALLY_INDICATOR);
export const useTallyIndicator = () => useContext(Context);

function selectedScope(): IndicatorScope {
  const connectionId = readPreferredTallyConnectionId();
  try {
    const company = JSON.parse(localStorage.getItem('kalika.bankStatements.selectedCompany.v1') || 'null');
    return { connectionId, companyName: company?.connectionId === connectionId ? company?.companyName : null };
  } catch { return { connectionId }; }
}

export function TallyStatusProvider({children}: {children: React.ReactNode}) {
  const [value, setValue] = useState(INITIAL_TALLY_INDICATOR);
  const pathname = usePathname();
  const publicPage = /^\/(?:auth|login|signin|signup)(?:\/|$)/.test(pathname);
  useEffect(() => {
    if (publicPage) { setValue(INITIAL_TALLY_INDICATOR); return; }
    let alive = true, generation = 0, pending = false, received = 0, lastRefresh = -Infinity, invalidatedAt = -Infinity, observedAt = -Infinity;
    let connections: ConnectionObservation[] | null = null;
    let scope = selectedScope(), scopeKey = JSON.stringify(scope), serverDate = NaN;
    const update = () => {
      if (!alive) return;
      const next = selectedScope(), nextKey = JSON.stringify(next);
      if (scopeKey !== nextKey) {
        scope = next; scopeKey = nextKey; generation++; connections = null; lastRefresh = -Infinity; invalidatedAt = performance.now();
        setValue(INITIAL_TALLY_INDICATOR);
      }
      if (!navigator.onLine) { setValue({status:'unavailable',companyName:null}); return; }
      if (connections) {
        const connection = scope.connectionId ? connections.find(c => c.id === scope.connectionId)
          : connections.length === 1 ? connections[0] : undefined;
        const age = performance.now() - received;
        const nextValue = deriveTallyIndicator(connections, scope, age, heartbeatAge(connection, serverDate) + age, true);
        setValue(previous => previous.status === nextValue.status && previous.companyName === nextValue.companyName ? previous : nextValue);
      }
    };
    const refresh = async (force = false) => {
      update();
      if (!alive || pending || !navigator.onLine || document.visibilityState !== 'visible' ||
        (!force && performance.now() - lastRefresh < 15000)) return;
      pending = true; lastRefresh = performance.now(); const requestGeneration = generation, requestStarted = lastRefresh;
      try {
        const response = await apiFetch('/api/tally/connections', {cache:'no-store', signal:AbortSignal.timeout(8000)});
        if (!response.ok) throw new Error('Status unavailable');
        const payload = await response.json();
        update();
        if (!alive || requestGeneration !== generation) return;
        if (requestStarted < observedAt) return;
        connections = payload.connections || []; received = performance.now();
        serverDate = Date.parse(payload.observedAt || response.headers.get('date') || '');
        update();
      } catch {
        if (alive && requestGeneration === generation) { connections = null; setValue({status:'unavailable',companyName:null}); }
      } finally { pending = false; }
    };
    const invalidated = () => { generation++; invalidatedAt = performance.now(); connections = null; lastRefresh = -Infinity; setValue({status:'unavailable',companyName:null}); void refresh(true); };
    const observed = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      update();
      if (!alive || !Array.isArray(detail?.connections) || !Number.isFinite(detail.started) ||
        detail.started < invalidatedAt || detail.started < observedAt) return;
      observedAt = detail.started; connections = detail.connections; received = performance.now(); lastRefresh = received;
      serverDate = Date.parse(detail.serverDate || ''); update();
    };
    const storageChanged = (event: StorageEvent) => {
      if (!event.key || /tally|selectedCompany|auth-token|organization/i.test(event.key)) invalidated();
    };
    const focused = () => { update(); void refresh(); };
    const timer = window.setInterval(focused, 1000);
    window.addEventListener('focus', focused); window.addEventListener('online', focused);
    window.addEventListener('offline', update); window.addEventListener('storage', storageChanged);
    window.addEventListener('kalika:tally-status-invalidated', invalidated);
    window.addEventListener('kalika:tally-status-observed', observed);
    document.addEventListener('visibilitychange', focused);
    void refresh(true);
    return () => { alive = false; generation++; clearInterval(timer);
      window.removeEventListener('focus', focused); window.removeEventListener('online', focused);
      window.removeEventListener('offline', update); window.removeEventListener('storage', storageChanged);
      window.removeEventListener('kalika:tally-status-invalidated', invalidated);
      window.removeEventListener('kalika:tally-status-observed', observed);
      document.removeEventListener('visibilitychange', focused);
    };
  }, [publicPage]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

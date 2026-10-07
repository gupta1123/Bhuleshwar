export type TallyIndicator = { status: 'checking' | 'connected' | 'attention' | 'disconnected' | 'unavailable'; companyName: string | null };
export type ConnectionObservation = {
  id: string; bridgeConnected?: boolean; tallyReachable?: boolean; companyLoaded?: boolean;
  lastCompanyName?: string | null; lastHeartbeatAt?: string | null; lastTestedAt?: string | null;
};
export type IndicatorScope = { connectionId: string | null; companyName?: string | null };
export const INITIAL_TALLY_INDICATOR: TallyIndicator = { status: 'checking', companyName: null };

export function deriveTallyIndicator(connections: ConnectionObservation[], scope: IndicatorScope,
  ageMs: number, observationAgeMs: number, online: boolean): TallyIndicator {
  const result = (status: TallyIndicator['status'], companyName: string | null = null) => ({status, companyName});
  if (!online || ageMs > 45000) return result('unavailable');
  // Never substitute another PC when the saved selection disappears. With no
  // selection, only an unambiguous single connection can supply global status.
  const connection = scope.connectionId ? connections.find(c => c.id === scope.connectionId)
    : connections.length === 1 ? connections[0] : undefined;
  if (!connection?.bridgeConnected) return result('disconnected');
  if (observationAgeMs > 45000) return result('unavailable');
  if (!connection.tallyReachable || !connection.companyLoaded ||
    (scope.companyName && scope.companyName !== connection.lastCompanyName)) return result('attention');
  return result('connected', connection.lastCompanyName || null);
}

// Start from the server-observed timestamp difference, then advance with the
// browser's monotonic clock. Never compare unrelated client/server wall clocks.
export function heartbeatAge(connection: ConnectionObservation | undefined, serverDate: number) {
  if (!connection) return 0;
  const heartbeat = Date.parse(connection.lastHeartbeatAt || '');
  const tested = Date.parse(connection.lastTestedAt || '');
  if (!Number.isFinite(heartbeat) || !Number.isFinite(tested) || !Number.isFinite(serverDate)) return Infinity;
  return Math.max(0, serverDate - heartbeat, serverDate - tested);
}

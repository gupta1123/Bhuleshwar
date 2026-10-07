const COMMAND_WAKE_EVENT = "command_queued";

function requiredRealtimeEnv() {
  const supabaseUrl = String(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? ""
  ).replace(/\/+$/, "");
  const publishableKey = String(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
  ).trim();
  const serverKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  return { supabaseUrl, publishableKey, serverKey };
}
export function tallyCommandWakeTopic(connectionId: string) {
  return `tally-command:${connectionId}`;
}

export function tallyCommandRealtimeConfig(connectionId: string) {
  const { supabaseUrl, publishableKey } = requiredRealtimeEnv();
  if (!supabaseUrl || !publishableKey) return null;
  const websocketUrl = new URL("/realtime/v1/websocket", supabaseUrl);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  return {
    websocketUrl: websocketUrl.toString(),
    publishableKey,
    topic: tallyCommandWakeTopic(connectionId),
    event: COMMAND_WAKE_EVENT,
  };
}

/**
 * Best-effort only. The database command is the source of truth and the
 * connector's normal 15-second cycle remains the recovery path if Realtime is
 * unavailable or this notification is missed.
 */
export async function wakeTallyConnector(connectionId: string) {
  const { supabaseUrl, serverKey } = requiredRealtimeEnv();
  if (!supabaseUrl || !serverKey || !connectionId) return false;

  const topic = tallyCommandWakeTopic(connectionId);
  const endpoint = `${supabaseUrl}/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/${COMMAND_WAKE_EVENT}`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: serverKey,
        Authorization: `Bearer ${serverKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wake: true }),
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) {
      console.warn(`Tally command wake broadcast failed with HTTP ${response.status}; polling fallback remains active.`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      "Tally command wake broadcast failed; polling fallback remains active.",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

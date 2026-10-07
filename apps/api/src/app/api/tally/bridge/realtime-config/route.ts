import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { tallyCommandRealtimeConfig } from "@/lib/tally/command-wake";
import { hashSecret, TALLY_CONNECTION_SELECT, type TallyConnectionRow } from "@/lib/tally/connections";

function bridgeToken(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ??
    request.headers.get("x-bridge-token") ??
    "";
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const connectionId = new URL(request.url).searchParams.get("connectionId")?.trim() ?? "";
    const token = bridgeToken(request);
    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();
    if (error) throw error;
    const connection = data as unknown as TallyConnectionRow | null;
    if (!connection || connection.revoked_at) {
      return jsonWithCors(request, { error: "This connector session is no longer active." }, { status: 409 });
    }
    if (!connection.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    const realtime = tallyCommandRealtimeConfig(connection.id);
    if (!realtime) {
      return jsonWithCors(
        request,
        { error: "Realtime command notifications are not configured.", fallbackPolling: true },
        { status: 503 }
      );
    }
    return jsonWithCors(request, { realtime, fallbackPolling: true });
  } catch (error) {
    console.error("Error in GET /api/tally/bridge/realtime-config:", error);
    return jsonWithCors(request, { error: "Could not configure realtime command notifications." }, { status: 500 });
  }
}

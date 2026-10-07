import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isLocalDbMode } from "@/lib/local/mode";
import { disconnectLocalTallyConnectionFromBridge } from "@/lib/local/tally-store";
import {
  hashSecret,
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";

function getBridgeToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] ?? request.headers.get("x-bridge-token") ?? "";
}

function disconnectedUpdatePayload(disconnectedAt: string) {
  return {
    status: "waiting_for_bridge",
    pairing_code_hash: null,
    pairing_code_expires_at: null,
    bridge_token_hash: null,
    control_token_hash: null,
    paired_at: null,
    last_heartbeat_at: null,
    last_tested_at: null,
    last_tally_reachable: null,
    last_company_loaded: null,
    last_company_name: null,
    revoked_at: disconnectedAt,
    revoked_reason: "Disconnected by connector.",
    last_error: "Disconnected by connector.",
  };
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request) {
  try {
    const token = getBridgeToken(request);
    const body = await request.json().catch(() => ({}));
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";

    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    if (isLocalDbMode()) {
      const connection = await disconnectLocalTallyConnectionFromBridge(connectionId, token);
      if (!connection) {
        return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
      }
      return jsonWithCors(request, {
        connection: serializeTallyConnectionStatus(connection),
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) throw error;

    const connection = data as unknown as TallyConnectionRow | null;
    if (connection?.revoked_at) {
      return jsonWithCors(
        request,
        { error: "This connector session is already revoked." },
        { status: 409 }
      );
    }
    if (!connection?.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    const disconnectedAt = new Date().toISOString();
    const { data: updatedData, error: updateError } = await supabase
      .from("tally_connections")
      .update(disconnectedUpdatePayload(disconnectedAt))
      .eq("id", connection.id)
      .is("revoked_at", null)
      .select(TALLY_CONNECTION_SELECT)
      .single();

    if (updateError) throw updateError;

    const { error: cancelError } = await supabase
      .from("tally_bridge_commands")
      .update({
        status: "canceled",
        error: "Connection was disconnected.",
        completed_at: disconnectedAt,
      })
      .eq("connection_id", connection.id)
      .in("status", ["queued", "claimed"]);

    if (cancelError) throw cancelError;

    await supabase.from("tally_connection_events").insert({
      connection_id: connection.id,
      owner_user_id: connection.owner_user_id,
      event_type: "bridge_disconnected",
      message: "Tally bridge disconnected by connector.",
      payload: {
        source: "desktop",
      },
    });

    return jsonWithCors(request, {
      connection: serializeTallyConnectionStatus(updatedData as unknown as TallyConnectionRow),
    });
  } catch (error) {
    console.error("Error in POST /api/tally/bridge/disconnect:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

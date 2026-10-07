import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { isLocalDbMode, LOCAL_USER_ID } from "@/lib/local/mode";
import { disconnectLocalOtherTallyConnections } from "@/lib/local/tally-store";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";

function disconnectedUpdatePayload(disconnectedAt: string) {
  const reason = "Disconnected from another device by user.";
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
    revoked_reason: reason,
    last_error: reason,
    updated_at: disconnectedAt,
  };
}

function readKeepConnectionId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(request: Request) {
  try {
    const localMode = isLocalDbMode();
    const user = localMode
      ? { id: LOCAL_USER_ID }
      : await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const keepConnectionId = readKeepConnectionId(body.keepConnectionId);

    if (localMode) {
      const result = await disconnectLocalOtherTallyConnections({
        ownerUserId: user.id,
        keepConnectionId,
      });
      return jsonWithCors(request, {
        disconnectedCount: result.disconnectedIds.length,
        disconnectedConnectionIds: result.disconnectedIds,
        connections: result.connections.map(serializeTallyConnectionStatus),
      });
    }

    const supabase = createSupabaseAdminClient();
    let query = supabase
      .from("tally_connections")
      .select("id")
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .not("bridge_token_hash", "is", null)
      .not("paired_at", "is", null);

    if (keepConnectionId) {
      query = query.neq("id", keepConnectionId);
    }

    const { data: rows, error: readError } = await query;
    if (readError) throw readError;

    const disconnectedConnectionIds = (rows ?? []).map((row) => String(row.id));
    const disconnectedAt = new Date().toISOString();

    if (disconnectedConnectionIds.length > 0) {
      const { error: updateError } = await supabase
        .from("tally_connections")
        .update(disconnectedUpdatePayload(disconnectedAt))
        .in("id", disconnectedConnectionIds)
        .eq("owner_user_id", user.id)
        .is("revoked_at", null);

      if (updateError) throw updateError;

      const { error: cancelError } = await supabase
        .from("tally_bridge_commands")
        .update({
          status: "canceled",
          error: "Connection was disconnected from another device.",
          completed_at: disconnectedAt,
        })
        .in("connection_id", disconnectedConnectionIds)
        .in("status", ["queued", "claimed"]);

      if (cancelError) throw cancelError;

      const { error: eventError } = await supabase
        .from("tally_connection_events")
        .insert(
          disconnectedConnectionIds.map((connectionId) => ({
            connection_id: connectionId,
            owner_user_id: user.id,
            event_type: "bridge_disconnected",
            message: "Tally bridge disconnected from another device by user.",
            payload: {
              source: "web",
              origin: request.headers.get("origin"),
              referer: request.headers.get("referer"),
              userAgent:
                request.headers.get("user-agent")?.slice(0, 500) ?? null,
              forwardedFor:
                request.headers.get("x-forwarded-for")?.slice(0, 200) ?? null,
              keepConnectionId,
            },
          })),
        );

      if (eventError) throw eventError;
    }

    const { data: remainingRows, error: remainingError } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .order("updated_at", { ascending: false });

    if (remainingError) throw remainingError;

    return jsonWithCors(request, {
      disconnectedCount: disconnectedConnectionIds.length,
      disconnectedConnectionIds,
      connections: ((remainingRows ?? []) as unknown as TallyConnectionRow[])
        .filter(
          (row) =>
            Boolean(row.bridge_token_hash) &&
            Boolean(row.installation_id) &&
            Boolean(row.paired_at) &&
            !row.revoked_at,
        )
        .map(serializeTallyConnectionStatus),
    });
  } catch (error) {
    console.error(
      "Error in POST /api/tally/connections/disconnect-others:",
      error,
    );
    return jsonWithCors(
      request,
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export const POST = withTeamAccess(POSTHandler);

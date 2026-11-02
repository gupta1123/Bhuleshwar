import { withTeamAccess } from '@/lib/access/route-boundary';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isLocalDbMode, LOCAL_USER_ID } from "@/lib/local/mode";
import { disconnectLocalTallyConnection } from "@/lib/local/tally-store";
import {
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";

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
    revoked_reason: "Disconnected by user.",
    last_error: "Disconnected by user.",
  };
}

function getControlToken(request: Request) {
  return request.headers.get("x-tally-control-token")?.trim() ?? "";
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const localMode = isLocalDbMode();
    const user = localMode ? { id: LOCAL_USER_ID } : await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const controlToken = getControlToken(request);

    if (localMode) {
      const connection = await disconnectLocalTallyConnection(id, user.id, controlToken);
      if (!connection) {
        return jsonWithCors(
          request,
          { error: "This browser cannot disconnect that Tally connection." },
          { status: 403 }
        );
      }
      return jsonWithCors(request, {
        connection: serializeTallyConnectionStatus(connection),
      });
    }

    const supabase = createSupabaseAdminClient();
    // Any signed-in user allowed to manage connections may disconnect it; which browser created
    // the connection no longer matters. Reconnect resumes this same connection.
    const disconnectedAt = new Date().toISOString();
    const { data, error } = await supabase
      .from("tally_connections")
      .update(disconnectedUpdatePayload(disconnectedAt))
      .eq("id", id)
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .select(TALLY_CONNECTION_SELECT)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return jsonWithCors(request, { error: "Tally connection not found" }, { status: 404 });
    }

    const connection = data as unknown as TallyConnectionRow;
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
      owner_user_id: user.id,
      event_type: "bridge_disconnected",
      message: "Tally bridge disconnected by user.",
      payload: {
        source: "web",
        origin: request.headers.get("origin"),
        referer: request.headers.get("referer"),
        userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
        forwardedFor: request.headers.get("x-forwarded-for")?.slice(0, 200) ?? null,
      },
    });

    return jsonWithCors(request, {
      connection: serializeTallyConnectionStatus(connection),
    });
  } catch (error) {
    console.error("Error in POST /api/tally/connections/[id]/disconnect:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withTeamAccess(POSTHandler);

import { withTeamAccess } from "@/lib/access/route-boundary";
import { authorizeLiveConnection } from "@/lib/access/live-authority";
import { AccessError } from "@/lib/access/server";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashSecret, TALLY_CONNECTION_SELECT, type TallyConnectionRow } from "@/lib/tally/connections";

function bridgeToken(request: Request) {
  return request.headers.get("x-bridge-token") ||
    request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ||
    "";
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function POSTHandler(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const role = String(body.role || "");
    const connectionId = String(body.connectionId || "").trim();
    if (!connectionId || !["browser", "connector"].includes(role)) {
      return jsonWithCors(request, { error: "A valid live-session role and connection are required." }, { status: 400 });
    }

    const db = createSupabaseAdminClient();
    if (role === "browser") {
      const user = await requireRequestUser(request);
      if (!user) return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });

      if (process.env.TEAM_ACCESS_ENFORCEMENT === "true") {
        const authority = await authorizeLiveConnection(request, body);
        return jsonWithCors(request, {
          authenticated: true,
          teamAccess: true,
          connectionId,
          ...authority,
        }, { headers: { "Cache-Control": "private, no-store" } });
      }

      const { data, error } = await db
        .from("tally_connections")
        .select(TALLY_CONNECTION_SELECT)
        .eq("id", connectionId)
        .eq("owner_user_id", user.id)
        .is("revoked_at", null)
        .maybeSingle();
      if (error) throw error;
      const connection = data as unknown as TallyConnectionRow | null;
      if (!connection) return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });

      if (body.operation) {
        const token = bridgeToken(request);
        if (!token || !connection.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
          return jsonWithCors(request, { error: "The connector pairing changed. Reconnect before continuing." }, { status: 409 });
        }
      }

      return jsonWithCors(request, {
        authenticated: true,
        ownerUserId: user.id,
        connectionId,
        organizationId: connection.organization_id || null,
        installationId: connection.installation_id,
        sessionGeneration: connection.session_generation,
      }, { headers: { "Cache-Control": "private, no-store" } });
    }

    const token = bridgeToken(request);
    if (!token) return jsonWithCors(request, { error: "Bridge token is required." }, { status: 401 });
    const { data, error } = await db
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

    return jsonWithCors(request, {
      authenticated: true,
      ownerUserId: connection.owner_user_id,
      connectionId: connection.id,
      organizationId: connection.organization_id || null,
      installationId: connection.installation_id,
      sessionGeneration: connection.session_generation,
      bridgeVersion: connection.bridge_version,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AccessError) {
      return jsonWithCors(request, { error: error.message }, { status: error.status });
    }
    console.error("Error in POST /api/tally/live/session:", error);
    return jsonWithCors(request, { error: "Could not authenticate the case Tally session." }, { status: 500 });
  }
}

export const POST = withTeamAccess(POSTHandler, { bridgeSession: true });

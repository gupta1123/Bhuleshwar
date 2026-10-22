import { resolveOwnerOrganization } from "@/lib/tally/owner-organization";
import { withTeamAccess } from '@/lib/access/route-boundary';
import {permittedConnections} from '@/lib/access/connection-scope';
import {AccessError,requireAccessContext} from '@/lib/access/server';
import {canAccess} from '@autodealer/shared/lib/access';
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import {
  createLocalTallyConnection,
  listLocalTallyConnections,
} from "@/lib/local/tally-store";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  createBridgeToken,
  createPairingCode,
  createPairingExpiry,
  hashSecret,
  serializeTallyConnection,
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";

const DEFAULT_TALLY_URL = "http://localhost:9000";
// Revocations that mean "paused by the user"; Reconnect resumes these.
const RESUMABLE_REVOKE_REASONS = ["Disconnected by user.", "Disconnected by connector."];

function normalizeTallyUrl(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_TALLY_URL;
  }

  return value.trim().replace(/\/+$/, "");
}

function normalizeDisplayName(value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "Tally Prime";
  }

  return value.trim().slice(0, 120);
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return [record.message, record.details, record.hint]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" ");
  }
  return String(error ?? "").trim();
}

function tallyConnectionErrorPayload(error: unknown) {
  const message = errorText(error);
  if (/tally_connections|tally_connection_events|relation .*does not exist|schema cache/i.test(message)) {
    return {
      error: "Tally Connector setup is not ready.",
      userAction: "Run the latest Bhuleshwar Tally connector database migration, then try again.",
    };
  }
  return {
    error: message || "Could not load Tally connections.",
    userAction: "Check the API server logs if this continues.",
  };
}

function connectionSortTime(connection: ReturnType<typeof serializeTallyConnectionStatus>) {
  const heartbeatTime = connection.lastHeartbeatAt
    ? new Date(connection.lastHeartbeatAt).getTime()
    : 0;
  if (heartbeatTime) return heartbeatTime;
  return new Date(connection.updatedAt ?? connection.createdAt ?? 0).getTime();
}

function pickRelevantConnections(rows: TallyConnectionRow[]) {
  const serialized = rows
    // A connection attempt is not a workstation. Only a connector that
    // completed pairing and supplied its durable installation identity belongs
    // in the workstation list.
    .filter(
      (row) =>
        Boolean(row.installation_id) &&
        !row.revoked_at &&
        (Boolean(row.bridge_token_hash) || row.status === "waiting_for_bridge")
    )
    .map(serializeTallyConnectionStatus);
  // A user can legitimately have connectors on multiple Tally machines.
  // Returning only the latest live row made a newly paired browser silently
  // jump back to another machine's connector during its next refresh.
  return [...serialized]
    .sort((left, right) => connectionSortTime(right) - connectionSortTime(left))
    .slice(0, 12);
}

async function logConnectionEvent(
  connectionId: string,
  ownerUserId: string,
  eventType: string,
  message: string,
  payload: Record<string, unknown> = {}
) {
  const supabase = createSupabaseAdminClient();
  await supabase.from("tally_connection_events").insert({
    connection_id: connectionId,
    owner_user_id: ownerUserId,
    event_type: eventType,
    message,
    payload,
  });
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(request: Request) {
  try {
    if(process.env.TEAM_ACCESS_ENFORCEMENT==='true') {
      const access=await requireAccessContext(request);
      let rows:TallyConnectionRow[];
      if(canAccess(access,'connections.manage')&&access.member.all_companies) {
        const result=await createSupabaseAdminClient().from('tally_connections').select(TALLY_CONNECTION_SELECT)
          .eq('organization_id',access.organizationId).eq('owner_user_id',access.member.user_id)
          .is('revoked_at',null).order('updated_at',{ascending:false}).limit(50);
        if(result.error)throw result.error;
        rows=(result.data||[]) as unknown as TallyConnectionRow[];
      } else {
        rows=(await permittedConnections(request)).rows;
      }
      return jsonWithCors(request,{connections:pickRelevantConnections(rows),observedAt:new Date().toISOString()},
        {headers:{'Cache-Control':'private, no-store'}});
    }
    const localMode = isLocalDbMode();
    const user = localMode ? { id: "local-dev-user" } : await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    if (localMode) {
      return jsonWithCors(request, {
        connections: pickRelevantConnections(await listLocalTallyConnections(user.id)),
        observedAt: new Date().toISOString(),
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .order("updated_at", { ascending: false });

    if (error) {
      throw error;
    }

    const rows = (data ?? []) as unknown as TallyConnectionRow[];
    const now = new Date();
    const expiredPendingIds = rows
      .filter(
        (row) =>
          !row.bridge_token_hash &&
          (!row.pairing_code_expires_at ||
            new Date(row.pairing_code_expires_at).getTime() <= now.getTime())
      )
      .map((row) => row.id);

    if (expiredPendingIds.length > 0) {
      const retiredAt = now.toISOString();
      const { error: cleanupError } = await supabase
        .from("tally_connections")
        .update({
          revoked_at: retiredAt,
          revoked_reason: "Expired connector pairing attempt.",
          pairing_code_hash: null,
          pairing_code_expires_at: null,
          last_error: "Pairing attempt expired. Start a new connection when ready.",
          updated_at: retiredAt,
        })
        .in("id", expiredPendingIds)
        .eq("owner_user_id", user.id)
        .is("revoked_at", null);

      if (cleanupError) {
        console.warn("Could not retire expired Tally pairing attempts:", cleanupError);
      }
    }

    return jsonWithCors(request, {
      connections: pickRelevantConnections(rows),
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
    console.error("Error in GET /api/tally/connections:", error);
    return jsonWithCors(request, tallyConnectionErrorPayload(error), { status: 500 });
  }
}

async function POSTHandler(request: Request) {
  try {
    const localMode = isLocalDbMode();
    const user = localMode ? { id: "local-dev-user" } : await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));

    if (localMode) {
      const local = await createLocalTallyConnection({
        ownerUserId: user.id,
        displayName: normalizeDisplayName(body.displayName),
        tallyUrl: normalizeTallyUrl(body.tallyUrl),
      });
      return jsonWithCors(
        request,
        {
          connection: serializeTallyConnection(local.connection),
          pairingCode: local.pairingCode,
          controlToken: local.controlToken,
        },
        { status: 201 }
      );
    }

    const pairingCode = createPairingCode();
    const teamContext=process.env.TEAM_ACCESS_ENFORCEMENT==='true'?await requireAccessContext(request):null;
    const controlToken = createBridgeToken();
    const supabase = createSupabaseAdminClient();
    const reuseConnectionId =
      typeof body.reuseConnectionId === "string" && body.reuseConnectionId.trim()
        ? body.reuseConnectionId.trim()
        : null;

    // Disconnect is a pause: reconnecting resumes the same connection, so its
    // mappings, folder setting and posting history stay attached. Only a
    // connection the user (or its connector) disconnected is resumed; ones
    // superseded, expired or disconnected from another session stay retired.
    const scopeFilter = teamContext ? `organization_id.eq.${JSON.stringify(teamContext.organizationId)}` : 'id.not.is.null';
    let resumeId = reuseConnectionId;
    if (!resumeId) {
      const { data: live, error: liveError } = await supabase
        .from("tally_connections")
        .select("id")
        .eq("owner_user_id", user.id)
        .or(scopeFilter)
        .is("revoked_at", null)
        .not("bridge_token_hash", "is", null)
        .limit(1);
      if (liveError) throw liveError;
      if (!live?.length) {
        // No live connector for this user: resume their latest disconnected one.
        const { data: paused, error: pausedError } = await supabase
          .from("tally_connections")
          .select("id")
          .eq("owner_user_id", user.id)
          .or(scopeFilter)
          .in("revoked_reason", RESUMABLE_REVOKE_REASONS)
          .is("bridge_token_hash", null)
          .order("revoked_at", { ascending: false })
          .limit(1);
        if (pausedError) throw pausedError;
        resumeId = paused?.[0]?.id ?? null;
      }
    }

    if (resumeId) {
      const { data: existingData, error: existingError } = await supabase
        .from("tally_connections")
        .select(TALLY_CONNECTION_SELECT)
        .eq("id", resumeId)
        .eq("owner_user_id", user.id)
        .or(scopeFilter)
        .is("bridge_token_hash", null)
        .maybeSingle();
      if (existingError) throw existingError;
      const existing = existingData as unknown as TallyConnectionRow | null;
      const resumable = existing && (
        !existing.revoked_at || RESUMABLE_REVOKE_REASONS.includes(existing.revoked_reason ?? "")
      );
      if (existing && resumable) {
        const { data: resumed, error: resumeError } = await supabase
          .from("tally_connections")
          .update({
            status: "waiting_for_bridge",
            pairing_code_hash: hashSecret(pairingCode),
            pairing_code_expires_at: createPairingExpiry(),
            control_token_hash: hashSecret(controlToken),
            revoked_at: null,
            revoked_reason: null,
            last_error: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", resumeId)
          .select(TALLY_CONNECTION_SELECT)
          .single();
        if (resumeError) throw resumeError;
        await logConnectionEvent(
          resumeId,
          user.id,
          "connection_resume_requested",
          existing.revoked_at
            ? "Disconnected Bhuleshwar Tally connection resumed."
            : "Temporary Bhuleshwar Tally connection resume requested.",
          { reused: true, resumedAfterDisconnect: Boolean(existing.revoked_at) },
        );
        return jsonWithCors(request, {
          connection: serializeTallyConnection(resumed as unknown as TallyConnectionRow),
          pairingCode,
          controlToken,
          reused: true,
        });
      }
    }
    const retiredAt = new Date().toISOString();
    const { error: retirePendingError } = await supabase
      .from("tally_connections")
      .update({
        revoked_at: retiredAt,
        revoked_reason: "Superseded by a newer connector pairing attempt.",
        pairing_code_hash: null,
        pairing_code_expires_at: null,
        last_error: "Superseded by a newer connection attempt.",
        updated_at: retiredAt,
      })
      .eq("owner_user_id", user.id)
      .or(teamContext?`organization_id.eq.${JSON.stringify(teamContext.organizationId)}`:'id.not.is.null')
      .is("revoked_at", null)
      .is("bridge_token_hash", null);

    if (retirePendingError) {
      throw retirePendingError;
    }

    const ownerOrganizationId = teamContext ? null : await resolveOwnerOrganization(supabase, user.id);
    const { data, error } = await supabase
      .from("tally_connections")
      .insert({
        owner_user_id: user.id,
        ...(teamContext?{organization_id:teamContext.organizationId}:ownerOrganizationId?{organization_id:ownerOrganizationId}:{}),
        display_name: normalizeDisplayName(body.displayName),
        status: "waiting_for_bridge",
        tally_url: normalizeTallyUrl(body.tallyUrl),
        pairing_code_hash: hashSecret(pairingCode),
        pairing_code_expires_at: createPairingExpiry(),
        last_error: null,
      })
      .select(TALLY_CONNECTION_SELECT)
      .single();

    if (error) {
      throw error;
    }

    const row = data as unknown as TallyConnectionRow;

    await logConnectionEvent(
      row.id,
      user.id,
      "connection_created",
      "Tally connection created and waiting for bridge pairing.",
      { tallyUrl: row.tally_url }
    );

    return jsonWithCors(
      request,
      {
        connection: serializeTallyConnection(row),
        pairingCode,
        controlToken,
      },
      { status: 201 }
    );
  } catch (error) {
    if(error instanceof AccessError)return jsonWithCors(request,{error:error.message},{status:error.status});
    console.error("Error in POST /api/tally/connections:", error);
    return jsonWithCors(request, tallyConnectionErrorPayload(error), { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);
export const POST = withTeamAccess(POSTHandler);

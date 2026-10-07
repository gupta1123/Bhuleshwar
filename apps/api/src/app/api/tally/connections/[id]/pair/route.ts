import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { pairLocalTallyConnection } from "@/lib/local/tally-store";
import { restoreConnectionCompanyLinks } from "@/lib/access/connection-company-links";
import {
  connectorSupportsReliableActiveCompany,
  createBridgeToken,
  hashSecret,
  isReliableInstallationId,
  serializeTallyConnection,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
} from "@/lib/tally/connections";

function normalizeMetadata(value: unknown, fallback: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  return value.trim().slice(0, 160);
}

function readPairingCode(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function toNullableText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

function toNullableBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const pairingCode = readPairingCode(body.pairingCode);
    const controlToken = readPairingCode(body.controlToken);
    const bridgeVersion = normalizeMetadata(body.bridgeVersion, "unknown");
    const bridgeMachineId = normalizeMetadata(body.bridgeMachineId, "unknown");
    const bridgeMachineName = normalizeMetadata(body.bridgeMachineName, "This computer");

    if (!pairingCode) {
      return jsonWithCors(request, { error: "Pairing code is required." }, { status: 400 });
    }
    if (!controlToken) {
      return jsonWithCors(request, { error: "Connection control token is required." }, { status: 400 });
    }

    if (
      !connectorSupportsReliableActiveCompany(bridgeVersion) ||
      !isReliableInstallationId(bridgeMachineId)
    ) {
      return jsonWithCors(
        request,
        {
          error:
            "This connector is outdated and cannot be paired safely. Install the latest Kalika Tally Connector and try again.",
        },
        { status: 426 }
      );
    }

    if (isLocalDbMode()) {
      const result = await pairLocalTallyConnection({
        connectionId: id,
        pairingCode,
        bridgeName: normalizeMetadata(body.bridgeName, "Tally Bridge"),
        bridgeVersion,
        bridgeMachineId,
        bridgeMachineName,
        controlToken,
      });

      if ("error" in result) {
        return jsonWithCors(request, { error: result.error }, { status: result.status });
      }

      return jsonWithCors(request, {
        connection: serializeTallyConnection(result.connection),
        bridgeToken: result.bridgeToken,
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", id)
      .is("revoked_at", null)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }

    const connection = data as unknown as TallyConnectionRow;
    const now = Date.now();
    const expiresAt = connection.pairing_code_expires_at
      ? new Date(connection.pairing_code_expires_at).getTime()
      : 0;

    if (!connection.pairing_code_hash || !expiresAt) {
      await logConnectionEvent(
        connection.id,
        connection.owner_user_id,
        "pairing_rejected",
        "Bridge pairing rejected because no active pairing code exists.",
        { reason: "missing_pairing_code" }
      );

      return jsonWithCors(
        request,
        { error: "This connection does not have an active pairing code." },
        { status: 409 }
      );
    }

    if (expiresAt <= now) {
      await supabase
        .from("tally_connections")
        .update({
          pairing_code_hash: null,
          pairing_code_expires_at: null,
          status: "waiting_for_bridge",
          last_error: "Pairing code expired. Create a new Tally connection or regenerate the code.",
        })
        .eq("id", connection.id);

      await logConnectionEvent(
        connection.id,
        connection.owner_user_id,
        "pairing_expired",
        "Bridge pairing rejected because the pairing code expired.",
        { expiredAt: connection.pairing_code_expires_at }
      );

      return jsonWithCors(request, { error: "Pairing code expired." }, { status: 410 });
    }

    if (hashSecret(pairingCode) !== connection.pairing_code_hash) {
      await logConnectionEvent(
        connection.id,
        connection.owner_user_id,
        "pairing_rejected",
        "Bridge pairing rejected because the pairing code was invalid.",
        { reason: "invalid_pairing_code" }
      );

      return jsonWithCors(request, { error: "Invalid pairing code." }, { status: 401 });
    }

    const bridgeToken = createBridgeToken();
    const protocolVersion = Math.max(0, Math.trunc(Number(body.protocolVersion || 0)));
    const agentCapabilities = Array.isArray(body.agentCapabilities)
      ? body.agentCapabilities.filter((value: unknown): value is string => typeof value === "string").slice(0, 100)
      : [];
    const companyName = toNullableText(body.companyName);
    const tallyReachable = toNullableBoolean(body.tallyReachable);
    const reportedCompanyLoaded = toNullableBoolean(body.companyLoaded);
    const companyLoaded =
      tallyReachable === true && reportedCompanyLoaded === true && Boolean(companyName);
    const pairedAt = new Date().toISOString();

    const { data: supersededData, error: supersededReadError } = await supabase
      .from("tally_connections")
      .select("id")
      .eq("owner_user_id", connection.owner_user_id)
      .eq("organization_id", connection.organization_id || connection.owner_user_id)
      .eq("installation_id", bridgeMachineId)
      .is("revoked_at", null)
      .not("bridge_token_hash", "is", null)
      .neq("id", connection.id);

    if (supersededReadError) throw supersededReadError;

    const supersededIds = (supersededData ?? []).map((row) => String(row.id));
    if (supersededIds.length > 0) {
      const supersededReason =
        "Superseded by a newer session from this connector installation.";
      const { error: supersedeError } = await supabase
        .from("tally_connections")
        .update({
          status: "waiting_for_bridge",
          bridge_token_hash: null,
          control_token_hash: null,
          paired_at: null,
          last_heartbeat_at: null,
          last_tally_reachable: null,
          last_company_loaded: null,
          last_company_name: null,
          revoked_at: pairedAt,
          revoked_reason: supersededReason,
          last_error: supersededReason,
        })
        .in("id", supersededIds);

      if (supersedeError) throw supersedeError;

      const { error: cancelError } = await supabase
        .from("tally_bridge_commands")
        .update({
          status: "canceled",
          error: "Connection session was superseded.",
          completed_at: pairedAt,
        })
        .in("connection_id", supersededIds)
        .in("status", ["queued", "claimed"]);

      if (cancelError) throw cancelError;
    }

    const { data: updatedData, error: updateError } = await supabase
      .from("tally_connections")
      .update({
        status: "bridge_connected",
        pairing_code_hash: null,
        pairing_code_expires_at: null,
        control_token_hash: hashSecret(controlToken),
        paired_at: pairedAt,
        bridge_token_hash: hashSecret(bridgeToken),
        bridge_name: normalizeMetadata(body.bridgeName, "Tally Bridge"),
        bridge_version: bridgeVersion,
        bridge_machine_id: bridgeMachineId,
        bridge_machine_name: bridgeMachineName,
        installation_id: bridgeMachineId,
        organization_id: connection.organization_id || connection.owner_user_id,
        agent_protocol_version: protocolVersion,
        agent_version: toNullableText(body.agentVersion) || bridgeVersion,
        agent_capabilities: agentCapabilities,
        agent_last_seen_at: pairedAt,
        revoked_at: null,
        revoked_reason: null,
        session_generation: Number(connection.session_generation ?? 0) + 1,
        last_heartbeat_at: pairedAt,
        last_tally_reachable: tallyReachable ?? false,
        last_company_loaded: companyLoaded,
        last_company_name: companyLoaded ? companyName : null,
        last_error: null,
      })
      .eq("id", connection.id)
      .is("revoked_at", null)
      .select(TALLY_CONNECTION_SELECT)
      .single();

    if (updateError) {
      throw updateError;
    }

    const updatedConnection = updatedData as unknown as TallyConnectionRow;

    const restoredMappings = await restoreConnectionCompanyLinks({
      db: supabase,
      organizationId: updatedConnection.organization_id || updatedConnection.owner_user_id,
      installationId: updatedConnection.installation_id!,
      connectionId: updatedConnection.id,
      now: pairedAt,
    });

    await logConnectionEvent(
      updatedConnection.id,
      updatedConnection.owner_user_id,
      "bridge_paired",
      "Tally bridge paired successfully.",
      {
        bridgeName: updatedConnection.bridge_name,
        bridgeVersion: updatedConnection.bridge_version,
        bridgeMachineId: updatedConnection.bridge_machine_id,
        bridgeMachineName: updatedConnection.bridge_machine_name,
        supersededConnectionIds: supersededIds,
        companyName,
        tallyReachable,
        companyLoaded,
        restoredCompanyMappings: restoredMappings.restored,
        mappingConflicts: restoredMappings.conflicts,
      }
    );

    return jsonWithCors(request, {
      connection: serializeTallyConnection(updatedConnection),
      bridgeToken,
      agentIdentity: {
        protocolVersion,
        organizationId: updatedConnection.organization_id || updatedConnection.owner_user_id,
        ownerUserId: updatedConnection.owner_user_id,
        connectionId: updatedConnection.id,
        installationId: updatedConnection.installation_id,
        sessionGeneration: updatedConnection.session_generation,
      },
    });
  } catch (error) {
    console.error("Error in POST /api/tally/connections/[id]/pair:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

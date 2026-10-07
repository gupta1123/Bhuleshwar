import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { isLocalDbMode } from "@/lib/local/mode";
import { updateLocalTallyHeartbeat } from "@/lib/local/tally-store";
import { canonicalAgentDatasetRows } from "@/lib/tally/agent-datasets";
import { automaticallyLinkObservedActiveCompanies } from "@/lib/access/connection-company-links";
import {
  hashSecret,
  connectorSupportsReliableActiveCompany,
  isReliableInstallationId,
  serializeTallyConnectionStatus,
  TALLY_CONNECTION_SELECT,
  type TallyConnectionRow,
  type TallyConnectionStatus,
} from "@/lib/tally/connections";

function getBridgeToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] ?? request.headers.get("x-bridge-token") ?? "";
}

function toBoolean(value: unknown) {
  return value === true;
}

function toNullableText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : null;
}

function toCompanies(value: unknown, activeCompanyName: string | null) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const companies: Array<{
    companyName: string;
    guid: string | null;
    financialYear: string | null;
    financialYearStart: string | null;
    booksFrom: string | null;
    currentPeriod: string | null;
    isActive: boolean;
  }> = [];

  for (const item of value) {
    let name: unknown = item;
    let row: Record<string, unknown> = {};
    if (item && typeof item === "object") {
      row = item as Record<string, unknown>;
      name = row.companyName ?? row.name;
    }
    const text = toNullableText(name);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    companies.push({
      companyName: text,
      guid: toNullableText(row.guid),
      financialYear: toNullableText(row.financialYear),
      financialYearStart: toNullableText(row.financialYearStart),
      booksFrom: toNullableText(row.booksFrom),
      currentPeriod: toNullableText(row.currentPeriod),
      isActive:
        key === activeCompanyName?.trim().toLowerCase() ||
        (row.isActive === true && Boolean(activeCompanyName)),
    });
  }

  if (activeCompanyName && !seen.has(activeCompanyName.toLowerCase())) {
    companies.unshift({
      companyName: activeCompanyName,
      guid: null,
      financialYear: null,
      financialYearStart: null,
      booksFrom: null,
      currentPeriod: null,
      isActive: true,
    });
  }

  return companies;
}

function resolveStatus(input: {
  tallyReachable: boolean;
  companyLoaded: boolean;
  error: string | null;
}): TallyConnectionStatus {
  if (input.companyLoaded) return "company_loaded";
  if (input.tallyReachable) return "tally_reachable";
  if (input.error) return "connection_error";
  return "bridge_connected";
}

function snapshotChanged(
  previous: Array<Record<string, unknown>> | null | undefined,
  next: Array<Record<string, unknown>>
) {
  return JSON.stringify(previous ?? []) !== JSON.stringify(next);
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function POST(request: Request) {
  try {
    const token = getBridgeToken(request);
    const body = await request.json().catch(() => ({}));
    const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
    const bridgeVersion = toNullableText(body.bridgeVersion);
    const bridgeMachineId = toNullableText(body.bridgeMachineId);
    const bridgeMachineName = toNullableText(body.bridgeMachineName);
    const protocolVersion = Math.max(0, Math.trunc(Number(body.protocolVersion || 0)));
    const sessionGeneration = Math.max(0, Math.trunc(Number(body.sessionGeneration || 0)));

    if (!connectionId || !token) {
      return jsonWithCors(request, { error: "Connection id and bridge token are required." }, { status: 400 });
    }

    if (
      !connectorSupportsReliableActiveCompany(bridgeVersion) ||
      !isReliableInstallationId(bridgeMachineId)
    ) {
      return jsonWithCors(
        request,
        {
            error:
              "Connector update required. Install and reconnect using the latest Kalika Tally Connector.",
        },
        { status: 426 }
      );
    }

    const tallyReachable = toBoolean(body.tallyReachable);
    const reportedCompanyLoaded = toBoolean(body.companyLoaded);
    const companyName = toNullableText(body.companyName);
    const companyLoaded = tallyReachable && reportedCompanyLoaded && Boolean(companyName);
    const companies = toCompanies(body.companies, companyLoaded ? companyName : null);
    const errorMessage =
      toNullableText(body.error) ??
      (tallyReachable && reportedCompanyLoaded && !companyName
        ? "Tally responded but did not identify the active company."
        : null);
    const status = resolveStatus({
      tallyReachable,
      companyLoaded,
      error: errorMessage,
    });

    if (isLocalDbMode()) {
      const connection = await updateLocalTallyHeartbeat({
        connectionId,
        token,
        status,
        tallyUrl: toNullableText(body.tallyUrl),
        bridgeVersion,
        bridgeMachineId: bridgeMachineId!,
        bridgeMachineName,
        tallyReachable,
        companyLoaded,
        companyName: companyLoaded ? companyName : null,
        error: errorMessage,
        companies,
        livenessOnly: body.livenessOnly === true,
      });

      if (!connection) {
        return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
      }

      return jsonWithCors(request, {
        livenessSupported: true,
        connection: serializeTallyConnectionStatus(connection),
      });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tally_connections")
      .select(TALLY_CONNECTION_SELECT)
      .eq("id", connectionId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    const connection = data as unknown as TallyConnectionRow | null;

    if (connection?.revoked_at) {
      return jsonWithCors(
        request,
        { error: "This connector session has been revoked. Reconnect this computer." },
        { status: 409 }
      );
    }

    if (!connection?.bridge_token_hash || hashSecret(token) !== connection.bridge_token_hash) {
      return jsonWithCors(request, { error: "Invalid bridge token." }, { status: 401 });
    }

    if (
      !connection.installation_id ||
      connection.installation_id !== bridgeMachineId
    ) {
      await supabase.from("tally_connection_events").insert({
        connection_id: connection.id,
        owner_user_id: connection.owner_user_id,
        event_type: "heartbeat_rejected",
        message: "Heartbeat rejected because it came from a different connector installation.",
        payload: {
          pairedMachineId: connection.installation_id,
          reportedMachineId: bridgeMachineId,
          reportedBridgeVersion: bridgeVersion,
        },
      });
      return jsonWithCors(
        request,
        {
          error:
            "This connection belongs to a different connector installation. Reconnect this machine.",
        },
        { status: 409 }
      );
    }

    if (protocolVersion >= 1 && sessionGeneration !== Number(connection.session_generation || 0)) {
      return jsonWithCors(
        request,
        { error: "This Local Agent session was superseded. Reconnect this computer." },
        { status: 409 }
      );
    }

    // Connections paired before organization-aware access was introduced can
    // still have a valid installation-bound token but no organization. Repair
    // only an unambiguous active membership; never move an already-scoped
    // connection between organizations.
    if (!connection.organization_id) {
      const { data: memberships, error: membershipError } = await supabase
        .from("access_members")
        .select("organization_id")
        .eq("user_id", connection.owner_user_id)
        .eq("status", "active")
        .limit(3);
      if (membershipError) throw membershipError;
      const organizations = [...new Set((memberships ?? []).map((row) => String(row.organization_id)).filter(Boolean))];
      const legacyOwnerOrganization = organizations.find((id) => id === connection.owner_user_id);
      const organizationId = legacyOwnerOrganization || (organizations.length === 1 ? organizations[0] : "");
      if (!organizationId) {
        return jsonWithCors(request, { error: "Reconnect this connector and select the intended organization." }, { status: 409 });
      }
      const { data: repaired, error: repairError } = await supabase
        .from("tally_connections")
        .update({ organization_id: organizationId })
        .eq("id", connection.id)
        .eq("owner_user_id", connection.owner_user_id)
        .eq("installation_id", bridgeMachineId)
        .is("organization_id", null)
        .is("revoked_at", null)
        .select("organization_id")
        .single();
      if (repairError) throw repairError;
      connection.organization_id = String(repaired.organization_id);
    }

    const agentIdentity = {
      protocolVersion,
      organizationId: connection.organization_id,
      ownerUserId: connection.owner_user_id,
      connectionId: connection.id,
      installationId: connection.installation_id,
      sessionGeneration: connection.session_generation,
    };

    const now = new Date().toISOString();
    // An alive connector is not a new Tally/company observation. While a read
    // owns Tally's HTTP queue, update ONLY liveness and preserve last_tested_at.
    if (body.livenessOnly === true) {
      const livenessUpdate: Record<string, unknown> = {
        last_heartbeat_at: now,
        bridge_version: bridgeVersion,
      };
      if (protocolVersion >= 1) livenessUpdate.agent_last_seen_at = now;
      const { data: live, error: liveError } = await supabase.from("tally_connections")
        .update(livenessUpdate)
        .eq("id", connection.id).eq("installation_id", bridgeMachineId).is("revoked_at", null)
        .select(TALLY_CONNECTION_SELECT).single();
      if (liveError) throw liveError;
      return jsonWithCors(request, { livenessSupported: true, agentIdentity, connection: serializeTallyConnectionStatus(live as unknown as TallyConnectionRow) });
    }
    const resolvedCompanyName = companyLoaded ? companyName : null;
    const agentStatus = body.agentStatus && typeof body.agentStatus === "object" ? body.agentStatus : {};
    const capabilities = Array.isArray(body.agentCapabilities)
      ? body.agentCapabilities.filter((value: unknown): value is string => typeof value === "string").slice(0, 100)
      : [];
    const heartbeatStateChanged =
      connection.status !== status ||
      connection.last_tally_reachable !== tallyReachable ||
      connection.last_company_loaded !== companyLoaded ||
      (connection.last_company_name ?? null) !== resolvedCompanyName ||
      (connection.last_error ?? null) !== errorMessage ||
      snapshotChanged(connection.last_companies_snapshot, companies);

    const { data: updatedData, error: updateError } = await supabase
      .from("tally_connections")
      .update({
        status,
        tally_url: toNullableText(body.tallyUrl) ?? connection.tally_url,
        bridge_version: bridgeVersion,
        bridge_machine_name: bridgeMachineName ?? connection.bridge_machine_name,
        last_heartbeat_at: now,
        last_tested_at: now,
        last_tally_reachable: tallyReachable,
        last_company_loaded: companyLoaded,
        last_company_name: resolvedCompanyName,
        last_error: errorMessage,
        last_companies_snapshot: companies,
        agent_protocol_version: protocolVersion,
        agent_version: toNullableText(body.agentVersion),
        agent_capabilities: capabilities,
        agent_status: agentStatus,
        agent_last_seen_at: protocolVersion >= 1 ? now : connection.agent_last_seen_at,
        tdl_version: Number.isFinite(Number((agentStatus as Record<string, unknown>).tdlVersion))
          ? Number((agentStatus as Record<string, unknown>).tdlVersion)
          : null,
        local_schema_version: Number.isFinite(Number((agentStatus as Record<string, unknown>).localSchemaVersion))
          ? Number((agentStatus as Record<string, unknown>).localSchemaVersion)
          : null,
      })
      .eq("id", connection.id)
      .eq("installation_id", bridgeMachineId)
      .is("revoked_at", null)
      .select(TALLY_CONNECTION_SELECT)
      .single();

    if (updateError) {
      throw updateError;
    }

    try {
      await automaticallyLinkObservedActiveCompanies({
        db: supabase,
        organizationId: connection.organization_id!,
        connectionId: connection.id,
        installationId: connection.installation_id!,
        companies: companies as Array<Record<string, unknown>>,
        now,
      });
    } catch (linkError) {
      console.error("Automatic active-company linking failed after heartbeat was accepted:", {
        connectionId: connection.id,
        error: linkError,
      });
    }

    let datasetStatus: { accepted: number; rejected: number; errorCode: string | null } | undefined;
    if (protocolVersion >= 1 && Array.isArray((agentStatus as Record<string, unknown>).datasets)) {
      const statusRecord = agentStatus as Record<string, unknown>;
      const canonical = canonicalAgentDatasetRows({
        datasets: statusRecord.datasets as Array<Record<string, unknown>>,
        agentStatus: statusRecord,
        connection,
        agentVersion: toNullableText(body.agentVersion) || bridgeVersion || "unknown",
        protocolVersion,
        now,
      });
      datasetStatus = { accepted: canonical.rows.length, rejected: canonical.rejected, errorCode: null };
      if (canonical.rows.length) {
        const { error: datasetError } = await supabase.from("tally_agent_datasets").upsert(canonical.rows, {
          onConflict: "organization_id,connection_id,installation_id,company_guid,financial_year",
        });
        if (datasetError) {
          datasetStatus.errorCode = "AGENT_DATASET_STATUS_WRITE_FAILED";
          console.error("Agent dataset status write failed after heartbeat was accepted:", {
            connectionId: connection.id,
            code: datasetError.code,
            message: datasetError.message,
          });
        }
      }
    }

    if (heartbeatStateChanged) {
      const { error: eventError } = await supabase.from("tally_connection_events").insert({
        connection_id: connection.id,
        owner_user_id: connection.owner_user_id,
        event_type: "bridge_heartbeat",
        message: errorMessage ?? "Bridge heartbeat state changed.",
        payload: {
          status,
          tallyReachable,
          companyLoaded,
          companyName: resolvedCompanyName,
          heartbeatCompanyName: companyName,
          bridgeVersion,
          bridgeMachineId,
          bridgeMachineName,
          companies,
        },
      });
      if (eventError) throw eventError;
    }

    return jsonWithCors(request, {
      livenessSupported: true,
      agentIdentity,
      datasetStatus,
      connection: serializeTallyConnectionStatus(updatedData as unknown as TallyConnectionRow),
    });
  } catch (error) {
    console.error("Error in POST /api/tally/bridge/heartbeat:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

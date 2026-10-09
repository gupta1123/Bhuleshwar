import { createHash, randomBytes, randomInt } from "node:crypto";
import { localAgentUpdateInfo } from "./agent-updates";

export type TallyConnectionStatus =
  | "not_connected"
  | "waiting_for_bridge"
  | "bridge_connected"
  | "tally_reachable"
  | "company_loaded"
  | "connection_error";

export type TallyConnectionRow = {
  id: string;
  owner_user_id: string;
  organization_id?: string | null;
  display_name: string;
  status: TallyConnectionStatus;
  tally_url: string;
  pairing_code_hash: string | null;
  pairing_code_expires_at: string | null;
  paired_at: string | null;
  bridge_token_hash: string | null;
  bridge_name: string | null;
  bridge_version: string | null;
  bridge_machine_id: string | null;
  bridge_machine_name: string | null;
  installation_id: string | null;
  control_token_hash: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  session_generation: number;
  agent_protocol_version?: number;
  agent_version?: string | null;
  agent_capabilities?: string[] | null;
  agent_status?: Record<string, unknown> | null;
  agent_last_seen_at?: string | null;
  tdl_version?: number | null;
  local_schema_version?: number | null;
  last_heartbeat_at: string | null;
  last_tested_at: string | null;
  last_tally_reachable: boolean | null;
  last_company_loaded: boolean | null;
  last_company_name: string | null;
  last_error: string | null;
  last_companies_snapshot?: Array<Record<string, unknown>> | null;
  created_at: string;
  updated_at: string;
};

const PAIRING_CODE_TTL_MINUTES = 10;

export const TALLY_CONNECTION_SELECT = [
  "id",
  "owner_user_id",
  "organization_id",
  "display_name",
  "status",
  "tally_url",
  "pairing_code_hash",
  "pairing_code_expires_at",
  "paired_at",
  "bridge_token_hash",
  "bridge_name",
  "bridge_version",
  "bridge_machine_id",
  "bridge_machine_name",
  "installation_id",
  "control_token_hash",
  "revoked_at",
  "revoked_reason",
  "session_generation",
  "agent_protocol_version",
  "agent_version",
  "agent_capabilities",
  "agent_status",
  "agent_last_seen_at",
  "tdl_version",
  "local_schema_version",
  "last_heartbeat_at",
  "last_tested_at",
  "last_tally_reachable",
  "last_company_loaded",
  "last_company_name",
  "last_error",
  "last_companies_snapshot",
  "created_at",
  "updated_at",
].join(", ");

export function connectorSupportsReliableActiveCompany(value: string | null | undefined) {
  const match = String(value ?? "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 0 || minor > 1 || (minor === 1 && patch >= 32);
}

export function isReliableInstallationId(value: string | null | undefined) {
  return /-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value ?? "").trim()
  );
}

export function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createPairingCode() {
  return String(randomInt(100000, 1000000));
}

export function createBridgeToken() {
  return randomBytes(32).toString("base64url");
}

export function createPairingExpiry() {
  return new Date(Date.now() + PAIRING_CODE_TTL_MINUTES * 60 * 1000).toISOString();
}

export function serializeTallyConnection(row: TallyConnectionRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    tallyUrl: row.tally_url,
    pairingCodeExpiresAt: row.pairing_code_expires_at,
    pairedAt: row.paired_at,
    bridgeName: row.bridge_name,
    bridgeVersion: row.bridge_version,
    bridgeMachineId: row.bridge_machine_id,
    bridgeMachineName: row.bridge_machine_name,
    installationId: row.installation_id,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    sessionGeneration: row.session_generation,
    organizationId: row.organization_id,
    agentProtocolVersion: row.agent_protocol_version ?? 0,
    agentVersion: row.agent_version,
    agentCapabilities: row.agent_capabilities ?? [],
    agentStatus: row.agent_status ?? {},
    agentLastSeenAt: row.agent_last_seen_at,
    tdlVersion: row.tdl_version,
    localSchemaVersion: row.local_schema_version,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastTestedAt: row.last_tested_at,
    lastTallyReachable: row.last_tally_reachable,
    lastCompanyLoaded: row.last_company_loaded,
    lastCompanyName: row.last_company_name,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agentUpdate: localAgentUpdateInfo(row.agent_version || row.bridge_version),
  };
}

export function serializeTallyConnectionStatus(row: TallyConnectionRow) {
  const lastHeartbeatAt = row.last_heartbeat_at
    ? new Date(row.last_heartbeat_at).getTime()
    : 0;
  const revoked = Boolean(row.revoked_at);
  const bridgeStale = !lastHeartbeatAt || Date.now() - lastHeartbeatAt > 45_000;
  const observationStale = !row.last_tested_at || Date.now() - Date.parse(row.last_tested_at) > 45_000;
  const companyDetectionReliable = connectorSupportsReliableActiveCompany(row.bridge_version);
  const connectorUpdateRequired =
    !revoked && !bridgeStale && Boolean(row.paired_at) && !companyDetectionReliable;
  const effectiveStatus: TallyConnectionStatus =
    revoked
      ? "waiting_for_bridge"
      : row.status === "waiting_for_bridge" || row.status === "not_connected"
      ? row.status
      : connectorUpdateRequired
        ? "connection_error"
      : bridgeStale
        ? "waiting_for_bridge"
        : row.status;

  return {
    ...serializeTallyConnection(row),
    // Reachability and active-company state are observations from a specific
    // connector/Tally session. Once its heartbeat is stale they are no longer
    // facts about the currently running instance.
    lastCompanyName:
      revoked || bridgeStale || !companyDetectionReliable ? null : row.last_company_name,
    lastError: connectorUpdateRequired
      ? "Connector update required. Reconnect using the latest Bhuleshwar Tally Connector."
      : revoked
        ? row.revoked_reason ?? "This connector session is no longer active."
      : row.last_error,
    status: effectiveStatus,
    bridgeConnected:
      !revoked && !bridgeStale && companyDetectionReliable && Boolean(row.paired_at),
    tallyReachable:
      !revoked && !bridgeStale && !observationStale && companyDetectionReliable && row.last_tally_reachable === true,
    companyLoaded:
      !revoked && !bridgeStale && !observationStale && companyDetectionReliable && row.last_company_loaded === true,
    tallyObservationStale: observationStale,
    heartbeatStale: !revoked && Boolean(row.paired_at) && bridgeStale,
    connectorUpdateRequired,
    revoked,
  };
}

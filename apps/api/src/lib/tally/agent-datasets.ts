import type { TallyConnectionRow } from "./connections";

type AgentDatasetRow = Record<string, unknown> & {
  company_guid: string;
  financial_year: string;
};

function nullableText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

export function canonicalAgentDatasetRows(input: {
  datasets: Array<Record<string, unknown>>;
  agentStatus: Record<string, unknown>;
  connection: Pick<TallyConnectionRow, "id" | "owner_user_id" | "organization_id" | "installation_id">;
  agentVersion: string;
  protocolVersion: number;
  now: string;
}) {
  const expectedOrganization = String(input.connection.organization_id || input.connection.owner_user_id);
  const expectedInstallation = String(input.connection.installation_id || "");
  const storage = input.agentStatus.storage && typeof input.agentStatus.storage === "object"
    ? input.agentStatus.storage as Record<string, unknown>
    : {};
  const selected = new Map<string, { row: AgentDatasetRow; rank: number; timestamp: number }>();
  let rejected = 0;

  for (const dataset of input.datasets) {
    const identity = dataset.identity && typeof dataset.identity === "object"
      ? dataset.identity as Record<string, unknown>
      : {};
    const companyGuid = nullableText(identity.companyGuid);
    const financialYear = nullableText(identity.financialYear);
    const reportedOrganization = nullableText(identity.organizationId);
    const reportedInstallation = nullableText(identity.installationId);
    if (
      !companyGuid || !financialYear ||
      (reportedOrganization && reportedOrganization !== expectedOrganization) ||
      (reportedInstallation && reportedInstallation !== expectedInstallation)
    ) {
      rejected += 1;
      continue;
    }

    const status = String(dataset.status || "");
    const rank = status === "ready" ? 3 : status === "syncing" ? 2 : 1;
    const timestamp = Date.parse(String(dataset.last_sync_at || dataset.updated_at || 0)) || 0;
    const key = `${companyGuid}\u0000${financialYear}`;
    const row: AgentDatasetRow = {
      owner_user_id: input.connection.owner_user_id,
      organization_id: expectedOrganization,
      connection_id: input.connection.id,
      installation_id: expectedInstallation,
      company_guid: companyGuid,
      company_name: String(identity.companyName || ""),
      financial_year: financialYear,
      agent_version: input.agentVersion,
      protocol_version: input.protocolVersion,
      tdl_version: Number(input.agentStatus.tdlVersion || 0) || null,
      local_schema_version: Number(input.agentStatus.localSchemaVersion || 0) || null,
      sync_cursors: dataset.cursors || {},
      cache_health: dataset.cacheHealth || {},
      cache_size_bytes: Math.max(0, Number(storage.sizeBytes || 0)),
      last_synced_at: dataset.last_sync_at || null,
      last_reconciled_at: dataset.last_reconciled_at || null,
      quarantined_at: dataset.quarantined_at || null,
      quarantine_reason: dataset.quarantine_reason || null,
      updated_at: input.now,
    };
    const current = selected.get(key);
    if (!current || rank > current.rank || (rank === current.rank && timestamp >= current.timestamp)) {
      selected.set(key, { row, rank, timestamp });
    }
  }

  return { rows: [...selected.values()].map((entry) => entry.row), rejected };
}

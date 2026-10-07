export type TallyBridgeCommandType =
  | "alter_ledger"
  | "create_ledger"
  | "fetch_bank_ledgers"
  | "fetch_purchase_masters"
  | "sync_masters"
  | "post_bank_voucher"
  | "fetch_customer_open_bills"
  | "create_debit_note"
  | "export_debit_note_pdf"
  | "create_purchase_voucher"
  | "verify_bank_transaction"
  | "agent_sync_dataset"
  | "agent_reconcile_dataset"
  | "agent_parse_document"
  | "agent_vector_suggest"
  | "agent_cache_maintenance"
  | "agent_clear_cache"
  | "agent_update_settings"
  | "agent_rebuild_cache"
  | "agent_diagnostics"
  | "agent_query_open_bills"
  | "agent_query_workflow_vouchers"
  | "agent_voucher_identity";

export type TallyBridgeCommandStatus =
  | "queued"
  | "claimed"
  | "succeeded"
  | "failed"
  | "canceled";

export type TallyBridgeCommandRow = {
  id: string;
  connection_id: string;
  owner_user_id: string;
  command_type: TallyBridgeCommandType;
  status: TallyBridgeCommandStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  available_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  bridge_version: string | null;
  created_at: string;
  updated_at: string;
  organization_id?: string | null;
  installation_id?: string | null;
  session_generation?: number | null;
  company_guid?: string | null;
  company_name?: string | null;
  financial_year?: string | null;
  protocol_version?: number | null;
  job_class?: string | null;
  deadline_at?: string | null;
  compact_progress?: Record<string, unknown> | null;
  agent_receipt?: string | null;
  external_result_reference?: string | null;
};

export const TALLY_BRIDGE_COMMAND_TYPES: TallyBridgeCommandType[] = [
  "alter_ledger",
  "create_ledger",
  "fetch_bank_ledgers",
  "fetch_purchase_masters",
  "sync_masters",
  "post_bank_voucher",
  "fetch_customer_open_bills",
  "create_debit_note",
  "export_debit_note_pdf",
  "create_purchase_voucher",
  "verify_bank_transaction",
  "agent_sync_dataset",
  "agent_reconcile_dataset",
  "agent_parse_document",
  "agent_vector_suggest",
  "agent_cache_maintenance",
  "agent_clear_cache",
  "agent_update_settings",
  "agent_rebuild_cache",
  "agent_diagnostics",
  "agent_query_open_bills",
  "agent_query_workflow_vouchers",
  "agent_voucher_identity",
];

export function serializeTallyBridgeCommand(row: TallyBridgeCommandRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    commandType: row.command_type,
    status: row.status,
    priority: row.priority,
    payload: row.payload,
    result: row.result,
    error: row.error,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    bridgeVersion: row.bridge_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    protocolVersion: row.protocol_version ?? 0,
    jobClass: row.job_class ?? null,
    deadlineAt: row.deadline_at ?? null,
    progress: row.compact_progress ?? {},
    agentReceipt: row.agent_receipt ?? null,
    externalResultReference: row.external_result_reference ?? null,
    identity: {
      protocolVersion: row.protocol_version ?? 0,
      organizationId: row.organization_id ?? null,
      ownerUserId: row.owner_user_id,
      connectionId: row.connection_id,
      installationId: row.installation_id ?? null,
      sessionGeneration: row.session_generation ?? null,
      companyGuid: row.company_guid ?? null,
      companyName: row.company_name ?? null,
      financialYear: row.financial_year ?? null,
    },
  };
}

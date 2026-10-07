export const AGENT_VERSION = "1.2.28";
export const AGENT_PROTOCOL_VERSION = 1;
export const LOCAL_SCHEMA_VERSION = 3;
export const TDL_REPORT_VERSION = 1;

export const AGENT_CAPABILITIES = Object.freeze([
  "purchase-shared-folder-v1",
  "agent-job-envelope-v1",
  "company-guid-routing",
  "persistent-priority-queue",
  "durable-command-receipts",
  "incremental-alter-id-sync",
  "workflow-cache-v1",
  "local-anydoc-v1",
  "browser-document-upload-v1",
  "bank-local-pipeline-v2",
  "local-zvec-v1",
  "openrouter-ledger-embeddings-v3",
  "shared-incremental-catalogue-v1",
  "purchase-catalogue-freshness-v1",
  "stable-dataset-identity-v1",
  "multiplexed-progress-v1",
  "purchase-canonical-v2",
  "purchase-bounded-reads-v1",
  "purchase-strict-readback-v1",
  "purchase-eway-details-v1",
  "followup-voucher-delta-v1",
  "bank-voucher-batch-v1",
  "bank-reference-preflight-v1",
  "document-cli-v1",
]);

export const JOB_CLASSES = Object.freeze({
  TALLY_WRITE: "tally_write",
  INTERACTIVE_READ: "interactive_read",
  INCREMENTAL_SYNC: "incremental_sync",
  DOCUMENT_PARSE: "document_parse",
  VECTOR_INDEX: "vector_index",
  RECONCILIATION: "reconciliation",
  MAINTENANCE: "maintenance",
});

export const JOB_PRIORITY = Object.freeze({
  [JOB_CLASSES.TALLY_WRITE]: 100,
  [JOB_CLASSES.INTERACTIVE_READ]: 80,
  [JOB_CLASSES.INCREMENTAL_SYNC]: 50,
  [JOB_CLASSES.DOCUMENT_PARSE]: 35,
  [JOB_CLASSES.RECONCILIATION]: 20,
  [JOB_CLASSES.VECTOR_INDEX]: 10,
  [JOB_CLASSES.MAINTENANCE]: 5,
});

const WRITE_COMMANDS = new Set([
  "alter_ledger",
  "create_ledger",
  "post_bank_voucher",
  "create_debit_note",
  "create_purchase_voucher",
  "adjust_customer_advance",
]);

const INTERACTIVE_COMMANDS = new Set([
  "fetch_bank_ledgers",
  "fetch_purchase_masters",
  "fetch_customer_open_bills",
  "verify_bank_transaction",
  "export_debit_note_pdf",
  "agent_query_open_bills",
  "agent_query_workflow_vouchers",
  "agent_voucher_identity",
]);

export function jobClassForCommand(commandType) {
  if (WRITE_COMMANDS.has(commandType)) return JOB_CLASSES.TALLY_WRITE;
  if (INTERACTIVE_COMMANDS.has(commandType)) return JOB_CLASSES.INTERACTIVE_READ;
  if (commandType === "sync_masters" || commandType === "agent_sync_dataset") {
    return JOB_CLASSES.INCREMENTAL_SYNC;
  }
  if (commandType === "agent_parse_document") return JOB_CLASSES.DOCUMENT_PARSE;
  if (commandType === "agent_vector_suggest") return JOB_CLASSES.VECTOR_INDEX;
  if (commandType === "agent_reconcile_dataset") return JOB_CLASSES.RECONCILIATION;
  return JOB_CLASSES.MAINTENANCE;
}

export function serializeAgentError(error, code = "AGENT_JOB_FAILED", retryable = false) {
  return {
    code,
    message: error instanceof Error ? error.message : String(error || "Agent job failed."),
    retryable: Boolean(retryable),
  };
}

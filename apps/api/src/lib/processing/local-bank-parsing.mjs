import { randomUUID } from "node:crypto";
import { createAgentJobToken } from "../tally/agent-job-token.ts";
import { wakeTallyConnector } from "../tally/command-wake.ts";

const financialYear = (value) => String(value || "").replace(/[–—]/g, "-").replace(/^(20\d{2})-(\d{2})$/, (_, a, b) => `${a}-${a.slice(0, 2)}${b}`);

// Resolve from the authenticated owner's exact connection. Never pick a different PC.
export function bankParsingPolicy(connection, { companyName, year, ownerUserId }, now = Date.now()) {
  if (!connection || connection.revoked_at || connection.owner_user_id !== ownerUserId) throw new Error("The selected Tally connection is unavailable. Reconnect this machine.");
  if (!connection.agent_version) return { mode: "backend" }; // Legacy connectors.
  const enabled = connection.agent_status?.settings?.localAnydocEnabled;
  if (typeof enabled !== "boolean") throw new Error("Waiting for the Local Agent's parsing settings. Refresh its connection and retry.");
  if (now - Date.parse(connection.agent_last_seen_at || "") > 60_000 || !Number.isFinite(Date.parse(connection.agent_last_seen_at || ""))) throw new Error("The selected Local Agent is offline. Reconnect it before analysis.");
  if (!enabled) return { mode: "backend" };
  if (!connection.agent_capabilities?.includes("local-anydoc-v1")) throw new Error("Update this Local Agent to support local document parsing.");
  const matches = (connection.last_companies_snapshot || []).filter((c) => c.companyName === companyName && financialYear(c.financialYear) === financialYear(year));
  if (matches.length !== 1 || !matches[0].guid || !connection.installation_id) throw new Error("The selected company identity could not be verified for local parsing.");
  return { mode: "local_agent", machineName: connection.bridge_machine_name, identity: {
    protocolVersion: 1, organizationId: connection.organization_id || ownerUserId, ownerUserId,
    connectionId: connection.id, installationId: connection.installation_id,
    sessionGeneration: connection.session_generation, companyGuid: matches[0].guid,
    companyName: matches[0].companyName, financialYear: financialYear(year),
  } };
}

export async function parseBankOnAgent({ supabase, job, importRow, policy, apiBase, progress, timeoutMs = 600_000, wakeConnector = wakeTallyConnector }) {
  const identity = policy.identity;
  const { data: connection, error: connectionError } = await supabase.from("tally_connections").select("*")
    .eq("id", identity.connectionId).eq("owner_user_id", job.owner_user_id).maybeSingle();
  if (connectionError) throw connectionError;
  const current = bankParsingPolicy(connection, { companyName: identity.companyName, year: identity.financialYear, ownerUserId: job.owner_user_id });
  if (current.mode !== "local_agent" || current.identity.installationId !== identity.installationId || current.identity.companyGuid !== identity.companyGuid || Number(current.identity.sessionGeneration) !== Number(identity.sessionGeneration)) throw new Error("Local parsing settings or pairing changed. Retry this upload with the selected agent.");
  let source;
  if (policy.browserUpload) {
    if (!connection.agent_capabilities?.includes("browser-document-upload-v1")) throw new Error("Update the selected Local Agent for direct PDF transfer.");
    source = { browserUpload: policy.browserUpload };
  } else {
    // Compatibility for already queued, cloud-backed imports only.
    if (!importRow.storage_path) throw new Error("The local PDF must be reselected. No cloud copy exists.");
    const { data: signed, error: signingError } = await supabase.storage.from(importRow.storage_bucket).createSignedUrl(importRow.storage_path, 600);
    if (signingError) throw signingError;
    source = { sourceUrl: signed.signedUrl };
  }
  const commandId = randomUUID();
  const deadline = new Date(Date.now() + timeoutMs).toISOString();
  const payload = {
    agentIdentity: identity, ...source, expectedSha256: importRow.content_sha256,
    originalName: "bank-statement.pdf", bankStatementJobId: job.id, bankStatementImportId: importRow.id,
    resultUploadUrl: new URL("/api/tally/agent/document-result", apiBase).toString(),
    resultUploadToken: createAgentJobToken({ jobId: commandId, connectionId: identity.connectionId, ownerUserId: job.owner_user_id }),
  };
  const { error } = await supabase.from("tally_bridge_commands").insert({
    id: commandId, connection_id: identity.connectionId, owner_user_id: job.owner_user_id,
    organization_id: identity.organizationId, installation_id: identity.installationId,
    session_generation: identity.sessionGeneration, company_guid: identity.companyGuid,
    company_name: identity.companyName, financial_year: identity.financialYear,
    protocol_version: 1, command_type: "agent_parse_document", job_class: "document_parse",
    status: "queued", priority: 80, max_attempts: 1, payload, deadline_at: deadline,
    available_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Could not queue local parsing: ${error.message}. Check the Local Agent command migration.`);
  void wakeConnector(identity.connectionId);
  await progress({ progress: 32, stage: "Preparing document" });
  try {
    while (Date.now() < Date.parse(deadline)) {
      const { data: saved, error: readError } = await supabase.from("bank_statement_extraction_jobs").select("status,result,error").eq("id", job.id).eq("owner_user_id", job.owner_user_id).single();
      if (readError) throw readError;
      if (saved.result?.localExtraction?.commandId === commandId) return saved.result.localExtraction;
      if (["cancelled", "failed"].includes(saved.status)) throw new Error(saved.error || "Bank statement analysis was cancelled or failed.");
      const { data: command, error: commandError } = await supabase.from("tally_bridge_commands").select("status,error").eq("id", commandId).single();
      if (commandError) throw commandError;
      if (["failed", "canceled"].includes(command.status)) throw new Error(`Local parsing failed: ${command.error || command.status}. No backend parsing fallback was used.`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("Local parsing/AI result timed out. No backend parsing fallback was used. Check the selected agent and retry.");
  } catch (error) {
    await supabase.from("tally_bridge_commands").update({ status: "canceled", error: String(error.message), completed_at: new Date().toISOString() }).eq("id", commandId).in("status", ["queued", "claimed"]);
    throw error;
  }
}



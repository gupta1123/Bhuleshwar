import { AGENT_PROTOCOL_VERSION } from "./protocol.mjs";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeFinancialYear(value) {
  const raw = text(value);
  if (!raw) return "";
  const match = raw.match(/(20\d{2})\D+(\d{2,4})/);
  if (!match) return raw.slice(0, 40);
  const end = match[2].length === 2 ? `${match[1].slice(0, 2)}${match[2]}` : match[2];
  return `${match[1]}-${end}`;
}

export function normalizeAgentIdentity(value = {}, fallback = {}) {
  return {
    protocolVersion: Number(value.protocolVersion || fallback.protocolVersion || AGENT_PROTOCOL_VERSION),
    organizationId: text(value.organizationId || fallback.organizationId || "default"),
    ownerUserId: text(value.ownerUserId || fallback.ownerUserId),
    connectionId: text(value.connectionId || fallback.connectionId),
    installationId: text(value.installationId || fallback.installationId),
    sessionGeneration: Number(value.sessionGeneration ?? fallback.sessionGeneration ?? 0),
    companyGuid: text(value.companyGuid || fallback.companyGuid),
    companyName: text(value.companyName || fallback.companyName),
    financialYear: normalizeFinancialYear(value.financialYear || fallback.financialYear),
  };
}

export function datasetKey(identity) {
  const normalized = normalizeAgentIdentity(identity);
  const required = [
    normalized.organizationId,
    normalized.installationId,
    normalized.companyGuid,
    normalized.financialYear,
  ];
  if (required.some((value) => !value)) return null;
  return required.map((value) => encodeURIComponent(value)).join("|");
}

export function assertAgentIdentity(expected, actual, options = {}) {
  const left = normalizeAgentIdentity(expected);
  const right = normalizeAgentIdentity(actual);
  const fields = ["organizationId", "connectionId", "installationId", "sessionGeneration"];
  if (!options.allowMissingCompany) fields.push("companyGuid", "financialYear");
  for (const field of fields) {
    if (!left[field] || !right[field] || String(left[field]) !== String(right[field])) {
      const error = new Error(`Agent identity mismatch for ${field}. Re-select the intended Tally connection and company.`);
      error.code = "AGENT_IDENTITY_MISMATCH";
      error.field = field;
      throw error;
    }
  }
  return right;
}

export function identityFromCommand(command, config = {}) {
  return normalizeAgentIdentity(command?.identity || command?.payload?.agentIdentity, {
    organizationId: config.organizationId || "default",
    ownerUserId: config.ownerUserId,
    connectionId: config.connectionId,
    installationId: config.installationId || config.bridgeMachineId,
    sessionGeneration: config.sessionGeneration,
    companyGuid: command?.payload?.companyGuid,
    companyName: command?.payload?.companyName || config.companyName,
    financialYear: command?.payload?.financialYear,
  });
}


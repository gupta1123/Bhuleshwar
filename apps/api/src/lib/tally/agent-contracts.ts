export const AGENT_PROTOCOL_VERSION = 1 as const;

export type AgentIdentity = {
  protocolVersion: number;
  organizationId: string;
  ownerUserId: string;
  connectionId: string;
  installationId: string;
  sessionGeneration: number;
  companyGuid: string;
  companyName: string;
  financialYear: string;
};

export type AgentCapabilities = {
  agentVersion: string;
  protocolVersion: number;
  localSchemaVersion: number;
  tdlVersion: number;
  capabilities: string[];
};

export type AgentJobEnvelope = {
  id: string;
  commandType: string;
  jobClass: string;
  priority: number;
  deadlineAt: string | null;
  identity: AgentIdentity;
  payload: Record<string, unknown>;
  idempotencyKey?: string | null;
};

export type AgentProgress = {
  jobId: string;
  phase: string;
  processed?: number;
  total?: number | null;
  elapsedMs?: number;
  message?: string;
};

export type AgentError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type AgentResult = {
  jobId: string;
  success: boolean;
  receipt?: string | null;
  result?: Record<string, unknown>;
  error?: AgentError | null;
};

export function normalizeFinancialYear(value: unknown) {
  const text = String(value ?? "").trim().replace(/[–—]/g, "-");
  const match = text.match(/(20\d{2})\D+(20\d{2}|\d{2})/);
  if (!match) return text;
  const start = Number(match[1]);
  const end = match[2].length === 2 ? Math.floor(start / 100) * 100 + Number(match[2]) : Number(match[2]);
  return `${start}-${end}`;
}

export function assertCompleteAgentIdentity(identity: Partial<AgentIdentity>): asserts identity is AgentIdentity {
  const required: Array<keyof AgentIdentity> = [
    "organizationId", "ownerUserId", "connectionId", "installationId",
    "sessionGeneration", "companyGuid", "companyName", "financialYear",
  ];
  const missing = required.filter((key) => identity[key] === null || identity[key] === undefined || identity[key] === "");
  if (missing.length) throw new Error(`Agent identity is incomplete: ${missing.join(", ")}.`);
}

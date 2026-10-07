import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createBridgeToken,
  createPairingCode,
  createPairingExpiry,
  hashSecret,
  type TallyConnectionRow,
  type TallyConnectionStatus,
} from "@/lib/tally/connections";
import type {
  TallyBridgeCommandRow,
  TallyBridgeCommandType,
} from "@/lib/tally/commands";
import { LOCAL_USER_ID } from "./mode";

type LocalConnectionRow = TallyConnectionRow & {
  bridge_token_hash: string | null;
};

type LocalState = {
  connections: LocalConnectionRow[];
  commands: TallyBridgeCommandRow[];
  events: Record<string, unknown>[];
};

const STORE_PATH = path.join(process.cwd(), ".local-data", "tally-store.json");

const CONNECTION_FIELDS = [
  "id",
  "owner_user_id",
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
  "last_heartbeat_at",
  "last_tested_at",
  "last_tally_reachable",
  "last_company_loaded",
  "last_company_name",
  "last_error",
  "last_companies_snapshot",
  "created_at",
  "updated_at",
] as const;

async function readState(): Promise<LocalState> {
  try {
    return JSON.parse(await readFile(STORE_PATH, "utf8")) as LocalState;
  } catch {
    return { connections: [], commands: [], events: [] };
  }
}

async function writeState(state: LocalState) {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function publicConnection(row: LocalConnectionRow): TallyConnectionRow {
  return Object.fromEntries(
    CONNECTION_FIELDS.map((field) => [field, row[field]]),
  ) as TallyConnectionRow;
}

function nowIso() {
  return new Date().toISOString();
}

export async function listLocalTallyConnections(ownerUserId = LOCAL_USER_ID) {
  const state = await readState();
  const now = nowIso();
  let changed = false;

  for (const connection of state.connections) {
    if (
      connection.owner_user_id !== ownerUserId ||
      connection.revoked_at ||
      connection.bridge_token_hash ||
      (connection.pairing_code_expires_at &&
        new Date(connection.pairing_code_expires_at).getTime() > Date.now())
    ) {
      continue;
    }

    connection.revoked_at = now;
    connection.revoked_reason = "Expired connector pairing attempt.";
    connection.pairing_code_hash = null;
    connection.pairing_code_expires_at = null;
    connection.last_error =
      "Pairing attempt expired. Start a new connection when ready.";
    connection.updated_at = now;
    changed = true;
  }

  if (changed) {
    await writeState(state);
  }

  return state.connections
    .filter(
      (connection) =>
        connection.owner_user_id === ownerUserId && !connection.revoked_at,
    )
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .map(publicConnection);
}

export async function createLocalTallyConnection(input: {
  displayName: string;
  tallyUrl: string;
  ownerUserId?: string;
}) {
  const state = await readState();
  const createdAt = nowIso();
  const ownerUserId = input.ownerUserId ?? LOCAL_USER_ID;

  for (const existing of state.connections) {
    if (
      existing.owner_user_id !== ownerUserId ||
      existing.revoked_at ||
      existing.bridge_token_hash
    ) {
      continue;
    }

    existing.revoked_at = createdAt;
    existing.revoked_reason =
      "Superseded by a newer connector pairing attempt.";
    existing.pairing_code_hash = null;
    existing.pairing_code_expires_at = null;
    existing.last_error = "Superseded by a newer connection attempt.";
    existing.updated_at = createdAt;
  }

  const pairingCode = createPairingCode();
  const controlToken = createBridgeToken();
  const row: LocalConnectionRow = {
    id: randomUUID(),
    owner_user_id: ownerUserId,
    display_name: input.displayName,
    status: "waiting_for_bridge",
    tally_url: input.tallyUrl,
    pairing_code_hash: hashSecret(pairingCode),
    pairing_code_expires_at: createPairingExpiry(),
    paired_at: null,
    bridge_token_hash: null,
    bridge_name: null,
    bridge_version: null,
    bridge_machine_id: null,
    bridge_machine_name: null,
    installation_id: null,
    control_token_hash: null,
    revoked_at: null,
    revoked_reason: null,
    session_generation: 0,
    last_heartbeat_at: null,
    last_tested_at: null,
    last_tally_reachable: null,
    last_company_loaded: null,
    last_company_name: null,
    last_error: null,
    last_companies_snapshot: [],
    created_at: createdAt,
    updated_at: createdAt,
  };

  state.connections.unshift(row);
  await writeState(state);
  return { connection: publicConnection(row), pairingCode, controlToken };
}

export async function getLocalTallyConnection(
  connectionId: string,
  ownerUserId = LOCAL_USER_ID,
) {
  const state = await readState();
  const row = state.connections.find(
    (connection) =>
      connection.id === connectionId &&
      connection.owner_user_id === ownerUserId,
  );
  return row ? publicConnection(row) : null;
}

export async function pairLocalTallyConnection(input: {
  connectionId: string;
  pairingCode: string;
  bridgeName: string;
  bridgeVersion: string;
  bridgeMachineId: string;
  bridgeMachineName: string;
  controlToken: string;
}) {
  const state = await readState();
  const row = state.connections.find(
    (connection) => connection.id === input.connectionId,
  );
  if (!row)
    return { error: "Tally connection not found.", status: 404 as const };
  if (!row.pairing_code_hash || !row.pairing_code_expires_at) {
    return {
      error: "This connection does not have an active pairing code.",
      status: 409 as const,
    };
  }
  if (new Date(row.pairing_code_expires_at).getTime() <= Date.now()) {
    row.pairing_code_hash = null;
    row.pairing_code_expires_at = null;
    row.status = "waiting_for_bridge";
    row.last_error = "Pairing code expired.";
    row.updated_at = nowIso();
    await writeState(state);
    return { error: "Pairing code expired.", status: 410 as const };
  }
  if (hashSecret(input.pairingCode) !== row.pairing_code_hash) {
    return { error: "Invalid pairing code.", status: 401 as const };
  }

  const now = nowIso();

  for (const existing of state.connections) {
    if (
      existing.id === row.id ||
      existing.owner_user_id !== row.owner_user_id ||
      existing.installation_id !== input.bridgeMachineId ||
      existing.revoked_at ||
      !existing.bridge_token_hash
    ) {
      continue;
    }
    existing.status = "waiting_for_bridge";
    existing.bridge_token_hash = null;
    existing.control_token_hash = null;
    existing.paired_at = null;
    existing.last_heartbeat_at = null;
    existing.last_tally_reachable = null;
    existing.last_company_loaded = null;
    existing.last_company_name = null;
    existing.revoked_at = now;
    existing.revoked_reason =
      "Superseded by a newer session from this connector installation.";
    existing.last_error = existing.revoked_reason;
    existing.updated_at = now;

    for (const command of state.commands) {
      if (
        command.connection_id === existing.id &&
        (command.status === "queued" || command.status === "claimed")
      ) {
        command.status = "canceled";
        command.error = "Connection session was superseded.";
        command.completed_at = now;
        command.updated_at = now;
      }
    }
  }

  const bridgeToken = createBridgeToken();
  row.status = "bridge_connected";
  row.pairing_code_hash = null;
  row.pairing_code_expires_at = null;
  row.control_token_hash = hashSecret(input.controlToken);
  row.paired_at = now;
  row.bridge_token_hash = hashSecret(bridgeToken);
  row.bridge_name = input.bridgeName;
  row.bridge_version = input.bridgeVersion;
  row.bridge_machine_id = input.bridgeMachineId;
  row.bridge_machine_name = input.bridgeMachineName;
  row.installation_id = input.bridgeMachineId;
  row.revoked_at = null;
  row.revoked_reason = null;
  row.session_generation = Number(row.session_generation ?? 0) + 1;
  row.last_heartbeat_at = now;
  row.last_error = null;
  row.updated_at = now;
  await writeState(state);

  return { connection: publicConnection(row), bridgeToken };
}

export async function getLocalConnectionForBridge(
  connectionId: string,
  token: string,
) {
  const state = await readState();
  const row = state.connections.find(
    (connection) => connection.id === connectionId,
  );
  if (
    !row?.bridge_token_hash ||
    row.revoked_at ||
    hashSecret(token) !== row.bridge_token_hash
  ) {
    return null;
  }
  return row;
}

export async function updateLocalTallyHeartbeat(input: {
  livenessOnly?: boolean;
  connectionId: string;
  token: string;
  status: TallyConnectionStatus;
  tallyUrl?: string | null;
  bridgeVersion?: string | null;
  bridgeMachineId: string;
  bridgeMachineName?: string | null;
  tallyReachable: boolean;
  companyLoaded: boolean;
  companyName?: string | null;
  error?: string | null;
  companies?: Array<Record<string, unknown>>;
}) {
  const state = await readState();
  const row = state.connections.find(
    (connection) => connection.id === input.connectionId,
  );
  if (
    !row?.bridge_token_hash ||
    hashSecret(input.token) !== row.bridge_token_hash
  ) {
    return null;
  }
  if (
    !row.bridge_machine_id ||
    row.bridge_machine_id !== input.bridgeMachineId
  ) {
    return null;
  }

  const now = nowIso();
  if (input.livenessOnly) {
    row.last_heartbeat_at = now;
    row.bridge_version = input.bridgeVersion || row.bridge_version;
    row.updated_at = now;
    await writeState(state);
    return publicConnection(row);
  }
  row.status = input.status;
  row.tally_url = input.tallyUrl || row.tally_url;
  row.bridge_version = input.bridgeVersion || row.bridge_version;
  row.bridge_machine_name = input.bridgeMachineName || row.bridge_machine_name;
  row.last_heartbeat_at = now;
  row.last_tested_at = now;
  row.last_tally_reachable = input.tallyReachable;
  row.last_company_loaded = input.companyLoaded;
  row.last_company_name = input.companyName || null;
  row.last_error = input.error || null;
  row.last_companies_snapshot = input.companies ?? row.last_companies_snapshot ?? [];
  row.updated_at = now;
  await writeState(state);
  return publicConnection(row);
}

export async function disconnectLocalTallyConnection(
  connectionId: string,
  ownerUserId = LOCAL_USER_ID,
  controlToken = "",
) {
  const state = await readState();
  const row = state.connections.find(
    (connection) =>
      connection.id === connectionId &&
      connection.owner_user_id === ownerUserId,
  );
  if (!row) return null;
  if (
    !row.control_token_hash ||
    hashSecret(controlToken) !== row.control_token_hash
  ) {
    return null;
  }

  row.status = "waiting_for_bridge";
  row.pairing_code_hash = null;
  row.pairing_code_expires_at = null;
  row.bridge_token_hash = null;
  row.control_token_hash = null;
  row.paired_at = null;
  row.last_heartbeat_at = null;
  row.last_tested_at = null;
  row.last_tally_reachable = null;
  row.last_company_loaded = null;
  row.last_company_name = null;
  row.revoked_at = nowIso();
  row.revoked_reason = "Disconnected by user.";
  row.last_error = "Disconnected by user.";
  row.updated_at = row.revoked_at;

  for (const command of state.commands) {
    if (
      command.connection_id === row.id &&
      (command.status === "queued" || command.status === "claimed")
    ) {
      command.status = "canceled";
      command.error = "Connection was disconnected.";
      command.completed_at = row.revoked_at;
      command.updated_at = row.revoked_at;
    }
  }
  await writeState(state);
  return publicConnection(row);
}

export async function disconnectLocalOtherTallyConnections(input: {
  ownerUserId?: string;
  keepConnectionId?: string | null;
}) {
  const state = await readState();
  const disconnectedAt = nowIso();
  const ownerUserId = input.ownerUserId ?? LOCAL_USER_ID;
  const keepConnectionId = input.keepConnectionId ?? null;
  const disconnectedIds: string[] = [];

  for (const connection of state.connections) {
    if (
      connection.owner_user_id !== ownerUserId ||
      connection.revoked_at ||
      !connection.bridge_token_hash ||
      !connection.paired_at ||
      connection.id === keepConnectionId
    ) {
      continue;
    }

    connection.status = "waiting_for_bridge";
    connection.pairing_code_hash = null;
    connection.pairing_code_expires_at = null;
    connection.bridge_token_hash = null;
    connection.control_token_hash = null;
    connection.paired_at = null;
    connection.last_heartbeat_at = null;
    connection.last_tested_at = null;
    connection.last_tally_reachable = null;
    connection.last_company_loaded = null;
    connection.last_company_name = null;
    connection.revoked_at = disconnectedAt;
    connection.revoked_reason = "Disconnected from another device by user.";
    connection.last_error = connection.revoked_reason;
    connection.updated_at = disconnectedAt;
    disconnectedIds.push(connection.id);
  }

  if (disconnectedIds.length > 0) {
    for (const command of state.commands) {
      if (
        disconnectedIds.includes(command.connection_id) &&
        (command.status === "queued" || command.status === "claimed")
      ) {
        command.status = "canceled";
        command.error = "Connection was disconnected from another device.";
        command.completed_at = disconnectedAt;
        command.updated_at = disconnectedAt;
      }
    }
    await writeState(state);
  }

  return {
    disconnectedIds,
    connections: state.connections
      .filter(
        (connection) =>
          connection.owner_user_id === ownerUserId && !connection.revoked_at,
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map(publicConnection),
  };
}

export async function disconnectLocalTallyConnectionFromBridge(
  connectionId: string,
  token: string,
) {
  const state = await readState();
  const row = state.connections.find(
    (connection) => connection.id === connectionId,
  );
  if (
    !row?.bridge_token_hash ||
    row.revoked_at ||
    hashSecret(token) !== row.bridge_token_hash
  ) {
    return null;
  }

  const disconnectedAt = nowIso();
  row.status = "waiting_for_bridge";
  row.bridge_token_hash = null;
  row.control_token_hash = null;
  row.paired_at = null;
  row.last_heartbeat_at = null;
  row.last_tested_at = null;
  row.last_tally_reachable = null;
  row.last_company_loaded = null;
  row.last_company_name = null;
  row.revoked_at = disconnectedAt;
  row.revoked_reason = "Disconnected by connector.";
  row.last_error = row.revoked_reason;
  row.updated_at = disconnectedAt;

  for (const command of state.commands) {
    if (
      command.connection_id === row.id &&
      (command.status === "queued" || command.status === "claimed")
    ) {
      command.status = "canceled";
      command.error = "Connection was disconnected.";
      command.completed_at = disconnectedAt;
      command.updated_at = disconnectedAt;
    }
  }

  await writeState(state);
  return publicConnection(row);
}

export async function createLocalTallyCommand(input: {
  connectionId: string;
  ownerUserId?: string;
  commandType: TallyBridgeCommandType;
  payload: Record<string, unknown>;
  priority?: number;
}) {
  const state = await readState();
  const now = nowIso();
  const command: TallyBridgeCommandRow = {
    id: randomUUID(),
    connection_id: input.connectionId,
    owner_user_id: input.ownerUserId ?? LOCAL_USER_ID,
    command_type: input.commandType,
    status: "queued",
    priority: input.priority ?? 10,
    payload: input.payload,
    result: null,
    error: null,
    attempts: 0,
    max_attempts: 3,
    available_at: now,
    claimed_at: null,
    completed_at: null,
    bridge_version: null,
    created_at: now,
    updated_at: now,
  };
  state.commands.unshift(command);
  await writeState(state);
  return command;
}

export async function listLocalTallyCommands(input: {
  connectionId: string;
  ownerUserId?: string;
  ids?: string[];
  limit?: number;
}) {
  const state = await readState();
  const ids = new Set(input.ids ?? []);
  return state.commands
    .filter((command) => command.connection_id === input.connectionId)
    .filter(
      (command) =>
        command.owner_user_id === (input.ownerUserId ?? LOCAL_USER_ID),
    )
    .filter((command) => ids.size === 0 || ids.has(command.id))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, input.limit ?? 20);
}

export async function claimNextLocalTallyCommand(input: {
  connectionId: string;
  token: string;
  bridgeVersion?: string | null;
}) {
  const state = await readState();
  const row = state.connections.find(
    (connection) => connection.id === input.connectionId,
  );
  if (
    !row?.bridge_token_hash ||
    row.revoked_at ||
    hashSecret(input.token) !== row.bridge_token_hash
  ) {
    return { unauthorized: true, command: null };
  }

  const now = nowIso();
  const command = state.commands
    .filter((entry) => entry.connection_id === input.connectionId)
    .filter((entry) => entry.status === "queued")
    .filter((entry) => entry.available_at <= now)
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.created_at.localeCompare(right.created_at),
    )[0];

  if (!command) return { command: null };

  command.status = "claimed";
  command.claimed_at = now;
  command.attempts += 1;
  command.bridge_version = input.bridgeVersion ?? null;
  command.updated_at = now;
  await writeState(state);
  return { command };
}

export async function completeLocalTallyCommand(input: {
  connectionId: string;
  token: string;
  commandId: string;
  success: boolean;
  result: Record<string, unknown>;
  error: string | null;
}) {
  const state = await readState();
  const row = state.connections.find(
    (connection) => connection.id === input.connectionId,
  );
  if (
    !row?.bridge_token_hash ||
    row.revoked_at ||
    hashSecret(input.token) !== row.bridge_token_hash
  ) {
    return { unauthorized: true, command: null };
  }

  const command = state.commands.find(
    (entry) =>
      entry.id === input.commandId &&
      entry.connection_id === input.connectionId,
  );
  if (!command) return { command: null };

  command.status = input.success ? "succeeded" : "failed";
  command.result = input.result;
  command.error = input.error;
  command.completed_at = nowIso();
  command.updated_at = command.completed_at;
  // A command result is an authenticated message from the running connector.
  // Keep its session alive even when a long Tally operation occupied the
  // connector beyond the normal heartbeat freshness window.
  row.last_heartbeat_at = command.completed_at;
  row.updated_at = command.completed_at;
  await writeState(state);
  return { command };
}

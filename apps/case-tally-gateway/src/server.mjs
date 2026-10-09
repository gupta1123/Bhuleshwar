import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const REQUEST_TIMEOUT_MS = 4 * 60_000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
const SUPPORTED_OPERATIONS = new Set([
  "company_check",
  "ledger_masters",
  "ledger_suggestions",
  "test_purchase_document_folder",
]);

const metadata = new WeakMap();
const connectors = new Map();
const pending = new Map();
let apiBaseUrl = "http://127.0.0.1:3001";

function send(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function failPending(requestId, error) {
  const item = pending.get(requestId);
  if (!item) return;
  clearTimeout(item.timeout);
  pending.delete(requestId);
  send(item.browser, {
    type: "result",
    requestId,
    success: false,
    error: error instanceof Error ? error.message : String(error || "The live Tally request failed."),
  });
}

async function apiRequest(path, { accessToken, bridgeToken, organizationId, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (bridgeToken) headers["X-Bridge-Token"] = bridgeToken;
  if (organizationId) headers["X-Kalika-Organization"] = organizationId;
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(25_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Live Tally authentication failed with HTTP ${response.status}.`);
  }
  return payload;
}

async function authenticate(socket, message) {
  const role = String(message.role || "");
  const connectionId = String(message.connectionId || "").trim();
  const token = String(message.token || "");
  if (!connectionId || !token || !["browser", "connector"].includes(role)) {
    throw new Error("Live-session credentials are incomplete.");
  }

  const session = await apiRequest("/api/tally/live/session", {
    accessToken: role === "browser" ? token : null,
    bridgeToken: role === "connector" ? token : null,
    organizationId: role === "browser" ? String(message.organizationId || "") : null,
    body: {
      role,
      connectionId,
      companyName: role === "browser" ? String(message.companyName || "").trim() : null,
    },
  });

  const meta = {
    authenticated: true,
    role,
    connectionId,
    ownerUserId: session.ownerUserId,
    organizationId: session.organizationId || String(message.organizationId || ""),
    installationId: session.installationId,
    sessionGeneration: session.sessionGeneration,
    accessToken: role === "browser" ? token : null,
    bridgeToken: role === "connector" ? token : null,
    bridgeVersion: String(message.bridgeVersion || session.bridgeVersion || ""),
    alive: true,
  };
  metadata.set(socket, meta);

  if (role === "connector") {
    const previous = connectors.get(connectionId);
    if (previous && previous !== socket) {
      closeWithError(previous, "A newer connector live session replaced this one.", 1000);
    }
    connectors.set(connectionId, socket);
  }

  send(socket, { type: "authenticated", role, connectionId });
}

async function authorizeLiveOperation(browserMeta, message, connectorMeta) {
  const authority = await apiRequest("/api/tally/live/session", {
    accessToken: browserMeta.accessToken,
    bridgeToken: connectorMeta?.bridgeToken,
    organizationId: browserMeta.organizationId,
    body: {
      role: "browser",
      connectionId: browserMeta.connectionId,
      operation: message.operation,
      companyName: message.companyName,
      companyGuid: message.companyGuid,
      companyNames: message.companyNames,
      financialYear: message.financialYear,
    },
  });
  if (authority.ownerUserId !== browserMeta.ownerUserId) {
    throw new Error("The paired connection changed. Reconnect before continuing.");
  }
  if (authority.installationId && connectorMeta?.installationId &&
      authority.installationId !== connectorMeta.installationId) {
    throw new Error("The live connector belongs to an older pairing session. Reconnect before continuing.");
  }
  return authority;
}

function closeWithError(socket, message, code = 1008) {
  send(socket, { type: "error", error: message });
  socket.close(code, String(message).slice(0, 120));
}

async function handleBrowserRequest(socket, message) {
  const browserMeta = metadata.get(socket);
  const requestId = String(message.requestId || randomUUID());
  const operation = String(message.operation || "");
  if (!SUPPORTED_OPERATIONS.has(operation)) {
    send(socket, { type: "result", requestId, success: false, error: "Unsupported case Tally operation." });
    return;
  }
  if (pending.has(requestId)) {
    send(socket, { type: "result", requestId, success: false, error: "This live request is already running." });
    return;
  }

  const connector = connectors.get(browserMeta.connectionId);
  const connectorMeta = connector && metadata.get(connector);
  if (!connector || connector.readyState !== WebSocket.OPEN ||
      connectorMeta?.ownerUserId !== browserMeta.ownerUserId) {
    send(socket, {
      type: "result",
      requestId,
      success: false,
      error: "The Tally connector is not on the live channel. Restart it and refresh.",
    });
    return;
  }

  let authority;
  try {
    authority = await authorizeLiveOperation(browserMeta, message, connectorMeta);
  } catch (error) {
    send(socket, { type: "result", requestId, success: false, error: error.message });
    return;
  }

  const timeout = setTimeout(
    () => failPending(requestId, new Error("The live Tally request timed out.")),
    REQUEST_TIMEOUT_MS,
  );
  pending.set(requestId, { browser: socket, connector, timeout });

  send(connector, {
    type: "operation",
    requestId,
    operation,
    deadlineAt: Date.now() + 180_000,
    companyName: String(message.companyName || "").trim(),
    companyGuid: authority.companyGuid || message.companyGuid || null,
    financialYear: authority.financialYear || message.financialYear || null,
    companyNames: Array.isArray(message.companyNames) ? message.companyNames : undefined,
    agentIdentity: authority,
    payload: message.payload && typeof message.payload === "object" ? message.payload : undefined,
  });
}

async function handleConnectorResult(socket, message) {
  const requestId = String(message.requestId || "");
  const item = pending.get(requestId);
  if (!item || item.connector !== socket) return;
  clearTimeout(item.timeout);
  pending.delete(requestId);
  send(item.browser, {
    type: "result",
    requestId,
    success: message.success === true,
    data: message.data,
    ...(message.success === true ? {} : { error: String(message.error || "Tally could not complete the request.") }),
  });
}

export function startCaseTallyGateway(options = {}) {
  const attachedServer = options.server;
  const gatewayPath = options.path || (attachedServer ? "/agent-live" : "/");
  const acceptedPaths = new Set([gatewayPath, ...(options.legacyPaths || [])]);
  apiBaseUrl = String(
    options.apiBaseUrl || process.env.CASE_TALLY_API_BASE_URL || process.env.CASH_DISCOUNT_API_BASE_URL || "http://127.0.0.1:3001",
  ).replace(/\/+$/, "");

  const server = attachedServer
    ? new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
    : new WebSocketServer({
        host: options.host || process.env.CASE_TALLY_GATEWAY_HOST || "0.0.0.0",
        port: Number(options.port || process.env.CASE_TALLY_GATEWAY_PORT || 3002),
        path: gatewayPath,
        maxPayload: MAX_MESSAGE_BYTES,
      });

  if (attachedServer) {
    attachedServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      if (!acceptedPaths.has(pathname)) return;
      server.handleUpgrade(request, socket, head, (client) => server.emit("connection", client, request));
    });
  }

  server.on("connection", (socket) => {
    const meta = { authenticated: false, alive: true };
    metadata.set(socket, meta);
    const authTimer = setTimeout(() => {
      if (!metadata.get(socket)?.authenticated) closeWithError(socket, "Live-session authentication timed out.");
    }, AUTH_TIMEOUT_MS);

    socket.on("pong", () => {
      const current = metadata.get(socket);
      if (current) current.alive = true;
    });

    socket.on("message", async (buffer) => {
      try {
        const message = JSON.parse(buffer.toString());
        const current = metadata.get(socket);
        if (!current?.authenticated) {
          if (!['authenticate', 'hello'].includes(message.type)) throw new Error("Send hello before using the case Tally channel.");
          await authenticate(socket, message);
          clearTimeout(authTimer);
          return;
        }
        if (message.type === "request" && current.role === "browser") {
          await handleBrowserRequest(socket, message);
        } else if (["operation_result", "result"].includes(message.type) && current.role === "connector") {
          await handleConnectorResult(socket, message);
        } else if (message.type === "progress" && current.role === "connector") {
          const item = pending.get(String(message.requestId || ""));
          if (item?.connector === socket) send(item.browser, message);
        }
      } catch (error) {
        const current = metadata.get(socket);
        if (!current?.authenticated) closeWithError(socket, error instanceof Error ? error.message : "Authentication failed.");
        else send(socket, { type: "error", error: error instanceof Error ? error.message : "Invalid live-channel message." });
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      const current = metadata.get(socket);
      if (current?.role === "connector" && connectors.get(current.connectionId) === socket) {
        connectors.delete(current.connectionId);
      }
      for (const [requestId, item] of pending) {
        if (item.browser === socket) clearTimeout(item.timeout), pending.delete(requestId);
        else if (item.connector === socket) failPending(requestId, new Error("The Tally connector disconnected during the live request."));
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of server.clients) {
      const current = metadata.get(socket);
      if (current?.alive === false) {
        socket.terminate();
        continue;
      }
      if (current) current.alive = false;
      socket.ping();
    }
  }, 30_000);
  server.on("close", () => clearInterval(heartbeat));

  const location = attachedServer
    ? gatewayPath
    : `ws://${options.host || "0.0.0.0"}:${Number(options.port || 3002)}${gatewayPath}`;
  console.log(`Case Tally live gateway listening on ${location}`);
  return server;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) startCaseTallyGateway();

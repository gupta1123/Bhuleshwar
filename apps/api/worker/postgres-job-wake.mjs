import pg from "pg";

const { Client } = pg;

export const BANK_STATEMENT_WAKE_CHANNEL = "kalika_bank_statement_jobs";

function normalizedWorkerPool(value) {
  return String(value ?? "").trim().toLowerCase() === "local" ? "local" : "remote";
}

export function createCoalescingWakeSignal() {
  let pending = false;
  let waiter = null;

  return {
    notify() {
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve("notify");
        return;
      }
      pending = true;
    },

    wait(timeoutMs) {
      if (pending) {
        pending = false;
        return Promise.resolve("notify");
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (waiter === finish) waiter = null;
          resolve("poll");
        }, timeoutMs);

        function finish(reason) {
          clearTimeout(timer);
          resolve(reason);
        }

        waiter = finish;
      });
    },
  };
}

export function notificationTargetsWorker(payload, workerPool) {
  if (!payload) return true;
  try {
    const parsed = JSON.parse(payload);
    return normalizedWorkerPool(parsed?.workerPool) === normalizedWorkerPool(workerPool);
  } catch {
    return true;
  }
}

export function buildSessionPoolerUrl({ directUrl, projectRef, poolerHost }) {
  if (!directUrl || !projectRef || !poolerHost) return null;
  try {
    const url = new URL(directUrl);
    url.hostname = poolerHost;
    url.port = "5432";
    url.username = `postgres.${projectRef}`;
    url.searchParams.set("sslmode", "require");
    // pg 8.23 opts into libpq-compatible `require`: encryption is mandatory,
    // while Supabase's managed certificate chain does not need a local CA file.
    url.searchParams.set("uselibpqcompat", "true");
    return url.toString();
  } catch {
    return null;
  }
}

export function resolvePostgresWakeUrl(env = process.env) {
  const explicit = String(env.SUPABASE_LISTENER_DB_URL ?? "").trim();
  if (explicit) return explicit;

  return buildSessionPoolerUrl({
    directUrl: env.SUPABASE_DB_URL,
    projectRef: env.SUPABASE_PROJECT_REF,
    poolerHost: env.SUPABASE_DB_SESSION_POOLER_HOST,
  });
}

export function startPostgresJobWake({
  connectionString,
  workerPool,
  wakeSignal,
  logger = console,
  reconnectDelayMs = 5000,
  ClientClass = Client,
}) {
  if (!connectionString) {
    logger.warn(
      "[worker] PostgreSQL wake disabled; set SUPABASE_LISTENER_DB_URL or SUPABASE_DB_SESSION_POOLER_HOST. Polling remains active."
    );
    return { stop: async () => {} };
  }

  let stopped = false;
  let client = null;
  let reconnectTimer = null;
  let reconnectScheduled = false;

  function scheduleReconnect(message) {
    if (stopped || reconnectScheduled) return;
    reconnectScheduled = true;
    logger.warn(`[worker] PostgreSQL wake unavailable (${message}); polling remains active.`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectScheduled = false;
      void connect();
    }, reconnectDelayMs);
  }

  async function connect() {
    if (stopped) return;
    const nextClient = new ClientClass({
      connectionString,
      application_name: `kalika-worker-${normalizedWorkerPool(workerPool)}`,
      connectionTimeoutMillis: 8000,
      keepAlive: true,
    });
    client = nextClient;

    nextClient.on("notification", (notification) => {
      if (
        notification?.channel === BANK_STATEMENT_WAKE_CHANNEL &&
        notificationTargetsWorker(notification.payload, workerPool)
      ) {
        wakeSignal.notify();
      }
    });
    nextClient.on("error", (error) => {
      if (client === nextClient) client = null;
      scheduleReconnect(error?.code ?? error?.message ?? "connection error");
    });
    nextClient.on("end", () => {
      if (client === nextClient) client = null;
      scheduleReconnect("connection ended");
    });

    try {
      await nextClient.connect();
      await nextClient.query(`LISTEN ${BANK_STATEMENT_WAKE_CHANNEL}`);
      logger.log(
        `[worker] PostgreSQL wake listening pool=${normalizedWorkerPool(workerPool)}; polling fallback=${reconnectDelayMs}ms`
      );
      // Close the startup race: immediately make the main loop inspect the queue
      // after LISTEN is committed.
      wakeSignal.notify();
    } catch (error) {
      if (client === nextClient) client = null;
      await nextClient.end().catch(() => {});
      scheduleReconnect(error?.code ?? error?.message ?? "connection failed");
    }
  }

  void connect();

  return {
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const activeClient = client;
      client = null;
      if (activeClient) await activeClient.end().catch(() => {});
    },
  };
}

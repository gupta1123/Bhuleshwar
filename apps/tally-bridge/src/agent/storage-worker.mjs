import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3-multiple-ciphers";
import { datasetKey as stableDatasetKey } from "./identity.mjs";


const { databasePath, keyHex, schemaVersion = 1 } = workerData;
fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
if (!/^[a-f0-9]{64}$/i.test(keyHex || "")) throw new Error("The Local Agent database key is invalid.");

const existed = fs.existsSync(databasePath);
let migrationBackupPath = null;
const migrationBackupPattern = new RegExp(`^${path.basename(databasePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.pre-v\\d+-\\d+\\.bak$`);
// Reads the schema version already applied to the existing database, or 0 if
// it cannot be determined (which conservatively triggers a backup).
function storedSchemaVersion() {
  let probe = null;
  try {
    probe = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5_000 });
    probe.pragma("cipher='sqlcipher'");
    probe.pragma("legacy=4");
    probe.key(Buffer.from(keyHex, "hex"));
    return Number(probe.prepare("select max(version) as version from schema_migrations").get()?.version || 0);
  } catch {
    return 0;
  } finally {
    try { probe?.close(); } catch {}
  }
}

// Copy the database only when this build is about to upgrade its schema, so
// the migration can be rolled back. Routine launches make no copy.
if (existed && storedSchemaVersion() < Number(schemaVersion)) {
  migrationBackupPath = `${databasePath}.pre-v${schemaVersion}-${Date.now()}.bak`;
  fs.copyFileSync(databasePath, migrationBackupPath);
}

const db = new Database(databasePath, { timeout: 5_000 });
db.pragma("cipher='sqlcipher'");
db.pragma("legacy=4");
db.key(Buffer.from(keyHex, "hex"));
db.pragma("journal_mode=WAL");
db.pragma("synchronous=NORMAL");
db.pragma("foreign_keys=ON");
db.pragma("busy_timeout=5000");
// 16 MB page cache (SQLite's default is 2 MB): repeated reads come from memory
// instead of a slow or busy disk.
db.pragma("cache_size=-16384");

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function newestIso(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function mergeCursorValues(left, right) {
  if (typeof left === "number" && typeof right === "number") return Math.max(left, right);
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const merged = { ...left };
    for (const [key, value] of Object.entries(right)) merged[key] = mergeCursorValues(merged[key], value);
    return merged;
  }
  return right ?? left;
}

function preferAlterRow(current, candidate) {
  if (!current) return candidate;
  const currentAlter = Number(current.alter_id || 0);
  const candidateAlter = Number(candidate.alter_id || 0);
  if (candidateAlter !== currentAlter) return candidateAlter > currentAlter ? candidate : current;
  return String(candidate.updated_at || candidate.deleted_at || "") >= String(current.updated_at || current.deleted_at || "")
    ? candidate
    : current;
}

function migrateStableDatasetIdentities() {
  const rows = db.prepare("select * from company_datasets").all();
  const groups = new Map();
  const pendingVectorCleanup = [];
  for (const row of rows) {
    const identity = parseJson(row.identity_json, {});
    const targetKey = stableDatasetKey(identity);
    if (!targetKey) continue;
    const group = groups.get(targetKey) || [];
    group.push({ ...row, identity });
    groups.set(targetKey, group);
  }

  const selectByKeys = (table, keys) => {
    const placeholders = keys.map(() => "?").join(",");
    return db.prepare(`select * from ${table} where dataset_key in (${placeholders})`).all(...keys);
  };
  const deleteByKeys = (table, keys) => {
    const placeholders = keys.map(() => "?").join(",");
    db.prepare(`delete from ${table} where dataset_key in (${placeholders})`).run(...keys);
  };

  for (const [targetKey, group] of groups) {
    const sourceKeys = [...new Set(group.map((row) => row.dataset_key))];
    if (sourceKeys.length === 1 && sourceKeys[0] === targetKey) continue;
    pendingVectorCleanup.push(...sourceKeys.filter((key) => key !== targetKey));

    const rank = (row) => {
      const status = row.status === "ready" ? 3 : row.status === "syncing" ? 2 : row.status === "new" ? 1 : 0;
      return [status, Date.parse(row.last_sync_at || row.updated_at || 0) || 0];
    };
    const winner = [...group].sort((a, b) => {
      const [as, at] = rank(a);
      const [bs, bt] = rank(b);
      return bs - as || bt - at;
    })[0];
    const cursors = group.reduce((merged, row) => mergeCursorValues(merged, parseJson(row.cursor_json, {})), {});
    const healthy = group.some((row) => row.status === "ready");
    const status = healthy ? "ready" : winner.status;
    const cacheHealth = healthy
      ? parseJson(group.find((row) => row.status === "ready")?.cache_health_json, {})
      : parseJson(winner.cache_health_json, {});

    const masters = new Map();
    for (const row of selectByKeys("master_cache", sourceKeys)) {
      const key = `${row.master_type}\u0000${row.master_key}`;
      masters.set(key, preferAlterRow(masters.get(key), row));
    }
    const bills = new Map();
    for (const row of selectByKeys("open_bill_cache", sourceKeys)) {
      const key = `${row.ledger_key}\u0000${row.bill_key}`;
      bills.set(key, preferAlterRow(bills.get(key), row));
    }
    const vouchers = new Map();
    for (const row of selectByKeys("workflow_voucher_cache", sourceKeys)) {
      const key = `${row.workflow}\u0000${row.voucher_key}`;
      vouchers.set(key, preferAlterRow(vouchers.get(key), row));
    }
    const tombstones = new Map();
    for (const row of selectByKeys("tombstones", sourceKeys)) {
      const key = `${row.entity_type}\u0000${row.entity_key}`;
      tombstones.set(key, preferAlterRow(tombstones.get(key), row));
    }

    for (const table of [
      "master_cache", "open_bill_cache", "workflow_voucher_cache", "tombstones",
      "vector_document_state", "vector_index_metadata", "company_datasets",
    ]) deleteByKeys(table, sourceKeys);

    db.prepare(`insert into company_datasets(
      dataset_key,identity_json,status,cursor_json,cache_health_json,last_sync_at,last_reconciled_at,
      quarantined_at,quarantine_reason,updated_at
    ) values(?,?,?,?,?,?,?,?,?,?)`).run(
      targetKey,
      JSON.stringify(winner.identity),
      status,
      JSON.stringify(cursors),
      JSON.stringify(cacheHealth),
      newestIso(group.map((row) => row.last_sync_at)),
      newestIso(group.map((row) => row.last_reconciled_at)),
      status === "quarantined" ? winner.quarantined_at : null,
      status === "quarantined" ? winner.quarantine_reason : null,
      newestIso(group.map((row) => row.updated_at)) || new Date().toISOString(),
    );

    const insertMaster = db.prepare(`insert into master_cache(
      dataset_key,master_type,master_key,alter_id,name,normalized_name,gstin,payload_json,is_deleted,updated_at
    ) values(?,?,?,?,?,?,?,?,?,?)`);
    for (const row of masters.values()) insertMaster.run(targetKey, row.master_type, row.master_key, row.alter_id, row.name, row.normalized_name, row.gstin, row.payload_json, row.is_deleted, row.updated_at);

    const insertBill = db.prepare(`insert into open_bill_cache(
      dataset_key,ledger_key,bill_key,alter_id,payload_json,updated_at
    ) values(?,?,?,?,?,?)`);
    for (const row of bills.values()) insertBill.run(targetKey, row.ledger_key, row.bill_key, row.alter_id, row.payload_json, row.updated_at);

    const insertVoucher = db.prepare(`insert into workflow_voucher_cache(
      dataset_key,workflow,voucher_key,alter_id,voucher_date,ledger_key,payload_json,updated_at
    ) values(?,?,?,?,?,?,?,?)`);
    for (const row of vouchers.values()) insertVoucher.run(targetKey, row.workflow, row.voucher_key, row.alter_id, row.voucher_date, row.ledger_key, row.payload_json, row.updated_at);

    const insertTombstone = db.prepare(`insert into tombstones(
      dataset_key,entity_type,entity_key,alter_id,deleted_at
    ) values(?,?,?,?,?)`);
    for (const row of tombstones.values()) insertTombstone.run(targetKey, row.entity_type, row.entity_key, row.alter_id, row.deleted_at);

    db.prepare(`insert into diagnostics(category,payload_json,created_at) values(?,?,?)`).run(
      "stable_dataset_migration",
      JSON.stringify({ targetKey, mergedDatasetCount: sourceKeys.length, retainedMasters: masters.size, vectorsRequireRebuild: true }),
      Date.now(),
    );
  }

  if (pendingVectorCleanup.length > 0) {
    db.prepare(`insert into agent_settings(key,value_json,updated_at) values(?,?,?)
      on conflict(key) do update set value_json=excluded.value_json,updated_at=excluded.updated_at`).run(
      "pendingVectorCleanup",
      JSON.stringify([...new Set(pendingVectorCleanup)]),
      new Date().toISOString(),
    );
  }
}

try {
db.exec("begin immediate");
db.exec(`
  create table if not exists schema_migrations (
    version integer primary key,
    applied_at text not null
  );
  create table if not exists agent_settings (
    key text primary key,
    value_json text not null,
    updated_at text not null
  );
  create table if not exists company_datasets (
    dataset_key text primary key,
    identity_json text not null,
    status text not null default 'new',
    cursor_json text not null default '{}',
    cache_health_json text not null default '{}',
    last_sync_at text,
    last_reconciled_at text,
    quarantined_at text,
    quarantine_reason text,
    updated_at text not null
  );
  create table if not exists master_cache (
    dataset_key text not null,
    master_type text not null,
    master_key text not null,
    alter_id integer not null default 0,
    name text not null,
    normalized_name text not null,
    gstin text,
    payload_json text not null,
    is_deleted integer not null default 0,
    updated_at text not null,
    primary key (dataset_key, master_type, master_key)
  );
  create index if not exists master_cache_lookup_idx
    on master_cache(dataset_key, master_type, normalized_name, is_deleted);
  create table if not exists open_bill_cache (
    dataset_key text not null,
    ledger_key text not null,
    bill_key text not null,
    alter_id integer not null default 0,
    payload_json text not null,
    updated_at text not null,
    primary key (dataset_key, ledger_key, bill_key)
  );
  create index if not exists open_bill_cache_ledger_idx
    on open_bill_cache(dataset_key, ledger_key);
  create table if not exists workflow_voucher_cache (
    dataset_key text not null,
    workflow text not null,
    voucher_key text not null,
    alter_id integer not null default 0,
    voucher_date text,
    ledger_key text,
    payload_json text not null,
    updated_at text not null,
    primary key (dataset_key, workflow, voucher_key)
  );
  create index if not exists workflow_voucher_scope_idx
    on workflow_voucher_cache(dataset_key, workflow, voucher_date, ledger_key);
  create table if not exists tombstones (
    dataset_key text not null,
    entity_type text not null,
    entity_key text not null,
    alter_id integer not null default 0,
    deleted_at text not null,
    primary key(dataset_key, entity_type, entity_key)
  );
  create table if not exists agent_jobs (
    id text primary key,
    command_id text,
    idempotency_key text,
    job_class text not null,
    priority integer not null,
    status text not null,
    identity_json text not null,
    payload_json text not null,
    progress_json text not null default '{}',
    result_json text,
    error_json text,
    available_at integer not null,
    deadline_at integer,
    attempts integer not null default 0,
    created_at text not null,
    updated_at text not null
  );
  create index if not exists agent_jobs_runnable_idx
    on agent_jobs(status, priority desc, available_at, created_at);
  create unique index if not exists agent_jobs_active_idempotency_idx
    on agent_jobs(idempotency_key)
    where idempotency_key is not null and status in ('queued','running','succeeded');
  create table if not exists command_receipts (
    idempotency_key text primary key,
    command_id text,
    command_type text not null,
    status text not null,
    tally_identity_json text,
    result_json text,
    created_at text not null,
    updated_at text not null
  );
  create table if not exists result_outbox (
    id text primary key,
    command_id text not null,
    payload_json text not null,
    status text not null default 'pending',
    attempts integer not null default 0,
    next_attempt_at integer not null,
    created_at text not null,
    updated_at text not null
  );
  create index if not exists result_outbox_pending_idx
    on result_outbox(status, next_attempt_at);
  create table if not exists document_cache (
    sha256 text primary key,
    markdown_gzip blob not null,
    metadata_json text not null default '{}',
    expires_at integer not null,
    created_at text not null,
    last_accessed_at text not null
  );
  create table if not exists vector_index_metadata (
    dataset_key text primary key,
    model_id text not null,
    dimensions integer not null,
    index_version integer not null,
    indexed_alter_id integer not null default 0,
    updated_at text not null
  );
  create table if not exists vector_document_state (
    dataset_key text not null,
    entity_key text not null,
    content_hash text not null,
    alter_id integer not null default 0,
    updated_at text not null,
    primary key (dataset_key, entity_key)
  );
  create table if not exists diagnostics (
    id integer primary key autoincrement,
    category text not null,
    payload_json text not null,
    created_at integer not null
  );
  create index if not exists diagnostics_created_idx on diagnostics(created_at);
  -- Customer receivables prepared locally for Payment Follow-ups and Cash
  -- Discounts. Each bill and voucher is stored as fields (JSON, column
  -- "fields", added below); the "xml" column is left empty.
  -- Deliberately separate from workflow_voucher_cache, which expires.
  create table if not exists receivable_state (
    dataset_key text primary key,
    state_json text not null,
    updated_at text not null
  );
  create table if not exists receivable_bills (
    dataset_key text not null,
    ledger_key text not null,
    bill_key text not null,
    xml text not null,
    updated_at text not null,
    primary key (dataset_key, ledger_key, bill_key)
  );
  create table if not exists receivable_vouchers (
    dataset_key text not null,
    master_id text not null,
    alter_id integer not null default 0,
    voucher_date text,
    xml text not null,
    updated_at text not null,
    primary key (dataset_key, master_id)
  );
  create table if not exists receivable_voucher_ledgers (
    dataset_key text not null,
    master_id text not null,
    ledger_key text not null,
    primary key (dataset_key, master_id, ledger_key)
  );
  create index if not exists receivable_voucher_ledgers_lookup_idx
    on receivable_voucher_ledgers(dataset_key, ledger_key);
`);

const previousSchemaVersion = Number(db.prepare("select max(version) as version from schema_migrations").get()?.version || 0);
if (previousSchemaVersion < 3 && Number(schemaVersion) >= 3) migrateStableDatasetIdentities();
// Customer dues are stored as fields (JSON) instead of Tally XML. Rows from
// earlier versions are converted once, after this migration (see below).
for (const table of ["receivable_bills", "receivable_vouchers"]) {
  if (!db.prepare(`pragma table_info(${table})`).all().some((column) => column.name === "fields")) {
    db.exec(`alter table ${table} add column fields text`);
  }
}

db.prepare("insert or ignore into schema_migrations(version, applied_at) values (?, ?)")
  .run(schemaVersion, new Date().toISOString());
db.exec("commit");

// The pre-migration copy exists only to roll back a failed migration within
// this startup (see the catch below). Once the schema has opened and migrated
// successfully, every copy is redundant, and each can be as large as the
// complete encrypted database, so none are kept on the client's disk.
try {
  for (const entry of fs.readdirSync(path.dirname(databasePath), { withFileTypes: true })) {
    if (entry.isFile() && migrationBackupPattern.test(entry.name)) {
      fs.rmSync(path.join(path.dirname(databasePath), entry.name), { force: true });
    }
  }
} catch {
  // A managed endpoint may temporarily deny cleanup. The verified database
  // remains usable and the next successful launch will retry retention.
}
} catch (migrationError) {
  try { db.exec("rollback"); } catch {}
  try { db.close(); } catch {}
  if (migrationBackupPath && fs.existsSync(migrationBackupPath)) {
    fs.copyFileSync(migrationBackupPath, databasePath);
  }
  throw migrationError;
}

markXmlReceivablesForNewCheck();

// Customer dues stored as Tally XML by 1.2.16-1.2.21 are not converted here:
// converting at start-up held the whole agent for minutes on a large, busy
// database. Instead the dues are marked as needing a new check (one small
// update). They are not used meanwhile (scans read Tally live), and the next
// "Check customer dues" clears the old rows and stores fields.
function markXmlReceivablesForNewCheck() {
  const pending = db.prepare("select distinct dataset_key from receivable_bills where fields is null union select distinct dataset_key from receivable_vouchers where fields is null").all();
  const mark = db.prepare(`insert into receivable_state(dataset_key,state_json,updated_at) values(?,?,?)
    on conflict(dataset_key) do update set state_json=excluded.state_json,updated_at=excluded.updated_at`);
  for (const { dataset_key: key } of pending) {
    mark.run(key, JSON.stringify({ status: "failed", lastError: "The connector was updated. Click Check customer dues once to prepare them again." }), new Date().toISOString());
  }
}

function nowIso() { return new Date().toISOString(); }
function toJson(value) { return JSON.stringify(value ?? null); }
function fromJson(value, fallback = null) {
  return parseJson(value, fallback);
}
function hydrateJob(row) {
  if (!row) return null;
  return {
    ...row,
    identity: fromJson(row.identity_json, {}),
    payload: fromJson(row.payload_json, {}),
    progress: fromJson(row.progress_json, {}),
    result: fromJson(row.result_json),
    error: fromJson(row.error_json),
  };
}

const operations = {
  health() {
    const sizeBytes = fs.statSync(databasePath).size;
    const queuedJobs = db.prepare("select count(*) as count from agent_jobs where status='queued'").get().count;
    const pendingOutbox = db.prepare("select count(*) as count from result_outbox where status='pending'").get().count;
    return { schemaVersion, databasePath, encrypted: true, sizeBytes, queuedJobs, pendingOutbox };
  },
  getSetting({ key, fallback = null }) {
    return fromJson(db.prepare("select value_json from agent_settings where key=?").get(key)?.value_json, fallback);
  },
  setSetting({ key, value }) {
    db.prepare(`insert into agent_settings(key,value_json,updated_at) values(?,?,?)
      on conflict(key) do update set value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key, toJson(value), nowIso());
    return value;
  },
  upsertDataset({ datasetKey, identity, status = "ready", cursors = {}, cacheHealth = {} }) {
    const at = nowIso();
    db.prepare(`insert into company_datasets(dataset_key,identity_json,status,cursor_json,cache_health_json,updated_at)
      values(?,?,?,?,?,?) on conflict(dataset_key) do update set identity_json=excluded.identity_json,
      status=excluded.status,cursor_json=excluded.cursor_json,cache_health_json=excluded.cache_health_json,
      updated_at=excluded.updated_at`)
      .run(datasetKey, toJson(identity), status, toJson(cursors), toJson(cacheHealth), at);
    return operations.getDataset({ datasetKey });
  },
  getDataset({ datasetKey }) {
    const row = db.prepare("select * from company_datasets where dataset_key=?").get(datasetKey);
    return row ? { ...row, identity: fromJson(row.identity_json, {}), cursors: fromJson(row.cursor_json, {}), cacheHealth: fromJson(row.cache_health_json, {}) } : null;
  },
  listDatasets() {
    return db.prepare("select * from company_datasets order by updated_at desc").all().map((row) => ({
      ...row, identity: fromJson(row.identity_json, {}), cursors: fromJson(row.cursor_json, {}), cacheHealth: fromJson(row.cache_health_json, {}),
    }));
  },
  getDatasetMetrics({ datasetKey }) {
    const masterCounts = db.prepare(`select master_type,count(*) as count from master_cache
      where dataset_key=? and is_deleted=0 group by master_type`).all(datasetKey);
    const vector = db.prepare(`select count(*) as count,max(updated_at) as updated_at
      from vector_document_state where dataset_key=?`).get(datasetKey);
    return {
      masterCounts: Object.fromEntries(masterCounts.map((row) => [row.master_type, Number(row.count || 0)])),
      ledgerCount: Number(masterCounts.find((row) => row.master_type === "ledger")?.count || 0),
      vectorCount: Number(vector?.count || 0),
      vectorUpdatedAt: vector?.updated_at || null,
      vectorMetadata: operations.getVectorMetadata({ datasetKey }),
    };
  },
  markDatasetSync({ datasetKey, cursors, cacheHealth = {}, reconciled = false }) {
    const at = nowIso();
    const current = operations.getDataset({ datasetKey });
    const mergedCursors = { ...(current?.cursors || {}), ...(cursors || {}) };
    const mergedCacheHealth = { ...(current?.cacheHealth || {}), ...(cacheHealth || {}) };
    mergedCacheHealth.validatedAt = newestIso([current?.cacheHealth?.validatedAt, cacheHealth?.validatedAt]) || at;
    mergedCacheHealth.dataUpdatedAt = newestIso([current?.cacheHealth?.dataUpdatedAt, cacheHealth?.dataUpdatedAt]) || mergedCacheHealth.validatedAt;
    db.prepare(`update company_datasets set status='ready',cursor_json=?,cache_health_json=?,last_sync_at=?,
      last_reconciled_at=case when ? then ? else last_reconciled_at end,updated_at=? where dataset_key=?`)
      .run(toJson(mergedCursors), toJson(mergedCacheHealth), at, reconciled ? 1 : 0, at, at, datasetKey);
    return operations.getDataset({ datasetKey });
  },
  quarantineDataset({ datasetKey, reason }) {
    const at = nowIso();
    db.prepare("update company_datasets set status='quarantined',quarantined_at=?,quarantine_reason=?,updated_at=? where dataset_key=?")
      .run(at, String(reason || "Dataset identity changed."), at, datasetKey);
    return operations.getDataset({ datasetKey });
  },
  upsertMasters({ datasetKey, masterType, masters, mergeExisting = false }) {
    const statement = db.prepare(`insert into master_cache(dataset_key,master_type,master_key,alter_id,name,normalized_name,gstin,payload_json,is_deleted,updated_at)
      values(?,?,?,?,?,?,?,?,?,?) on conflict(dataset_key,master_type,master_key) do update set
      alter_id=excluded.alter_id,name=excluded.name,normalized_name=excluded.normalized_name,gstin=excluded.gstin,
      payload_json=excluded.payload_json,is_deleted=excluded.is_deleted,updated_at=excluded.updated_at`);
    const transaction = db.transaction((rows) => {
      const at = nowIso();
      const existingStatement = mergeExisting
        ? db.prepare("select payload_json from master_cache where dataset_key=? and master_type=? and master_key=?")
        : null;
      for (const master of rows || []) {
        const key = String(master.guid || master.masterId || master.id || master.name || "").trim();
        if (!key) continue;
        const previous = existingStatement
          ? fromJson(existingStatement.get(datasetKey, masterType, key)?.payload_json, {})
          : {};
        const merged = mergeExisting
          ? { ...previous, ...master, raw: { ...(previous.raw || {}), ...(master.raw || {}) } }
          : master;
        const name = String(merged.name || merged.tallyName || "").trim();
        statement.run(datasetKey, masterType, key, Number(merged.alterId || 0), name, name.toLocaleLowerCase("en-IN").replace(/\s+/g, " ").trim(), merged.gstin || null, toJson(merged), merged.isDeleted ? 1 : 0, at);
      }
    });
    transaction(masters);
    return { count: masters?.length || 0 };
  },
  listMasters({ datasetKey, masterType, includeDeleted = false }) {
    const rows = db.prepare(`select payload_json from master_cache where dataset_key=? and master_type=? ${includeDeleted ? "" : "and is_deleted=0"} order by normalized_name`).all(datasetKey, masterType);
    return rows.map((row) => fromJson(row.payload_json, {}));
  },
  resetDatasetData({ datasetKey }) {
    const transaction = db.transaction(() => {
      db.prepare("delete from master_cache where dataset_key=?").run(datasetKey);
      db.prepare("delete from open_bill_cache where dataset_key=?").run(datasetKey);
      db.prepare("delete from workflow_voucher_cache where dataset_key=?").run(datasetKey);
      db.prepare("delete from tombstones where dataset_key=?").run(datasetKey);
      db.prepare("delete from vector_document_state where dataset_key=?").run(datasetKey);
      db.prepare("delete from vector_index_metadata where dataset_key=?").run(datasetKey);
      db.prepare("update company_datasets set status='new',cursor_json='{}',cache_health_json='{}',last_sync_at=null,last_reconciled_at=null,quarantined_at=null,quarantine_reason=null,updated_at=? where dataset_key=?")
        .run(nowIso(), datasetKey);
    });
    transaction();
    return operations.getDataset({ datasetKey });
  },
  listVectorDocumentStates({ datasetKey }) {
    return db.prepare("select entity_key,content_hash,alter_id,updated_at from vector_document_state where dataset_key=?")
      .all(datasetKey).map((row) => ({ entityKey: row.entity_key, contentHash: row.content_hash, alterId: row.alter_id, updatedAt: row.updated_at }));
  },
  upsertVectorDocumentStates({ datasetKey, documents = [] }) {
    const statement = db.prepare(`insert into vector_document_state(dataset_key,entity_key,content_hash,alter_id,updated_at)
      values(?,?,?,?,?) on conflict(dataset_key,entity_key) do update set content_hash=excluded.content_hash,
      alter_id=excluded.alter_id,updated_at=excluded.updated_at`);
    const transaction = db.transaction(() => {
      const at = nowIso();
      for (const document of documents) statement.run(datasetKey, String(document.entityKey), String(document.contentHash), Number(document.alterId || 0), at);
    });
    transaction();
    return { count: documents.length };
  },
  deleteVectorDocumentStates({ datasetKey, entityKeys = [] }) {
    if (!entityKeys.length) return { count: 0 };
    const statement = db.prepare("delete from vector_document_state where dataset_key=? and entity_key=?");
    const transaction = db.transaction(() => {
      let count = 0;
      for (const key of entityKeys) count += statement.run(datasetKey, String(key)).changes;
      return count;
    });
    return { count: transaction() };
  },
  reconcileMasterKeys({ datasetKey, masterType, currentKeys, alterId = 0 }) {
    const keys = new Set((currentKeys || []).map(String));
    const rows = db.prepare("select master_key from master_cache where dataset_key=? and master_type=? and is_deleted=0").all(datasetKey, masterType);
    const missing = rows.map((row) => row.master_key).filter((key) => !keys.has(String(key)));
    const transaction = db.transaction(() => {
      const at = nowIso();
      const mark = db.prepare("update master_cache set is_deleted=1,updated_at=? where dataset_key=? and master_type=? and master_key=?");
      const tombstone = db.prepare(`insert into tombstones(dataset_key,entity_type,entity_key,alter_id,deleted_at) values(?,?,?,?,?)
        on conflict(dataset_key,entity_type,entity_key) do update set alter_id=excluded.alter_id,deleted_at=excluded.deleted_at`);
      for (const key of missing) { mark.run(at, datasetKey, masterType, key); tombstone.run(datasetKey, masterType, key, alterId, at); }
    });
    transaction();
    return { deleted: missing.length };
  },
  replaceOpenBills({ datasetKey, ledgerKey, bills }) {
    const transaction = db.transaction(() => {
      db.prepare("delete from open_bill_cache where dataset_key=? and ledger_key=?").run(datasetKey, ledgerKey);
      const statement = db.prepare("insert into open_bill_cache(dataset_key,ledger_key,bill_key,alter_id,payload_json,updated_at) values(?,?,?,?,?,?)");
      const at = nowIso();
      for (const bill of bills || []) {
        const key = String(bill.guid || bill.masterId || bill.referenceName || bill.name || "").trim();
        if (key) statement.run(datasetKey, ledgerKey, key, Number(bill.alterId || 0), toJson(bill), at);
      }
    });
    transaction();
    return { count: bills?.length || 0 };
  },
  listOpenBills({ datasetKey, ledgerKeys = [] }) {
    if (!ledgerKeys.length) return [];
    const placeholders = ledgerKeys.map(() => "?").join(",");
    return db.prepare(`select payload_json from open_bill_cache where dataset_key=? and ledger_key in (${placeholders})`)
      .all(datasetKey, ...ledgerKeys).map((row) => fromJson(row.payload_json, {}));
  },
  getWorkflowSnapshot({ datasetKey, workflow, snapshotKey }) {
    const row = db.prepare("select payload_json,updated_at from workflow_voucher_cache where dataset_key=? and workflow=? and voucher_key=?")
      .get(datasetKey, workflow, snapshotKey);
    return row ? { payload: fromJson(row.payload_json, {}), updatedAt: row.updated_at } : null;
  },
  putWorkflowSnapshot({ datasetKey, workflow, snapshotKey, payload, alterId = 0, voucherDate = null, ledgerKey = null }) {
    const at = nowIso();
    db.prepare(`insert into workflow_voucher_cache(dataset_key,workflow,voucher_key,alter_id,voucher_date,ledger_key,payload_json,updated_at)
      values(?,?,?,?,?,?,?,?) on conflict(dataset_key,workflow,voucher_key) do update set alter_id=excluded.alter_id,
      voucher_date=excluded.voucher_date,ledger_key=excluded.ledger_key,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
      .run(datasetKey, workflow, snapshotKey, alterId, voucherDate, ledgerKey, toJson(payload), at);
    return { updatedAt: at };
  },
  enqueueJob({ job }) {
    const at = nowIso();
    db.prepare(`insert into agent_jobs(id,command_id,idempotency_key,job_class,priority,status,identity_json,payload_json,
      progress_json,available_at,deadline_at,created_at,updated_at) values(?,?,?,?,?,'queued',?,?,?, ?,?,?,?)
      on conflict(id) do nothing`).run(job.id, job.commandId || null, job.idempotencyKey || null, job.jobClass,
      job.priority, toJson(job.identity), toJson(job.payload), toJson(job.progress || {}), job.availableAt || Date.now(),
      job.deadlineAt || null, at, at);
    return hydrateJob(db.prepare("select * from agent_jobs where id=?").get(job.id));
  },
  getJob({ id }) {
    return hydrateJob(db.prepare("select * from agent_jobs where id=?").get(id));
  },
  claimNextJob({ lane = 'tally' } = {}) {
    if (!['tally', 'document'].includes(lane)) throw new Error('Unknown agent resource lane.');
    const claim = db.transaction(() => {
      // Only v2 bank documents use the independent lane. Legacy jobs retain
      // their original scheduling, and a document can never claim Tally work.
      const document = "(job_class='document_parse' and coalesce(json_extract(payload_json,'$.pipelineVersion'),0)=2)";
      const row = db.prepare(`select * from agent_jobs where status='queued' and available_at<=?
        and ${lane === 'document' ? document : `not ${document}`}
        order by priority desc,created_at asc limit 1`).get(Date.now());
      if (!row) return null;
      const at = nowIso();
      db.prepare("update agent_jobs set status='running',attempts=attempts+1,updated_at=? where id=? and status='queued'").run(at, row.id);
      return hydrateJob(db.prepare("select * from agent_jobs where id=?").get(row.id));
    });
    return claim();
  },
  updateJob({ id, status, progress, result, error }) {
    const row = db.prepare("select * from agent_jobs where id=?").get(id);
    if (!row) return null;
    db.prepare(`update agent_jobs set status=?,progress_json=?,result_json=?,error_json=?,updated_at=? where id=?`)
      .run(status || row.status, toJson(progress ?? fromJson(row.progress_json, {})), result === undefined ? row.result_json : toJson(result), error === undefined ? row.error_json : toJson(error), nowIso(), id);
    return hydrateJob(db.prepare("select * from agent_jobs where id=?").get(id));
  },
  recoverJobs() {
    // Browser bytes/context are volatile. Never replay an interrupted paid
    // analysis merely because its local job was running at process exit.
    const documents = db.prepare(`update agent_jobs set status='failed',error_json=?,updated_at=?
      where status in ('running','queued') and job_class='document_parse'
      and coalesce(json_extract(payload_json,'$.pipelineVersion'),0)=2`)
      .run(toJson({ code: 'DOCUMENT_SESSION_LOST', message: 'The agent restarted. Check statement status before reselecting the document.' }), nowIso());
    const info = db.prepare("update agent_jobs set status='queued',updated_at=? where status='running' and job_class not in ('tally_write')").run(nowIso());
    const writes = db.prepare("update agent_jobs set status='needs_verification',updated_at=? where status='running' and job_class='tally_write'").run(nowIso());
    return { resumedReads: info.changes, uncertainWrites: writes.changes, interruptedDocuments: documents.changes };
  },
  getReceipt({ idempotencyKey }) {
    const row = db.prepare("select * from command_receipts where idempotency_key=?").get(idempotencyKey);
    return row ? { ...row, tallyIdentity: fromJson(row.tally_identity_json), result: fromJson(row.result_json) } : null;
  },
  upsertReceipt({ receipt }) {
    const at = nowIso();
    db.prepare(`insert into command_receipts(idempotency_key,command_id,command_type,status,tally_identity_json,result_json,created_at,updated_at)
      values(?,?,?,?,?,?,?,?) on conflict(idempotency_key) do update set status=excluded.status,
      tally_identity_json=excluded.tally_identity_json,result_json=excluded.result_json,updated_at=excluded.updated_at`)
      .run(receipt.idempotencyKey, receipt.commandId || null, receipt.commandType, receipt.status,
        toJson(receipt.tallyIdentity), toJson(receipt.result), at, at);
    return operations.getReceipt({ idempotencyKey: receipt.idempotencyKey });
  },
  enqueueOutbox({ item }) {
    const at = nowIso();
    db.prepare("insert or replace into result_outbox(id,command_id,payload_json,status,attempts,next_attempt_at,created_at,updated_at) values(?,?,?,'pending',0,?,?,?)")
      .run(item.id, item.commandId, toJson(item.payload), Date.now(), at, at);
    return item;
  },
  listOutbox({ limit = 20 }) {
    return db.prepare("select * from result_outbox where status='pending' and next_attempt_at<=? order by created_at limit ?")
      .all(Date.now(), Math.max(1, Math.min(100, limit))).map((row) => ({ ...row, payload: fromJson(row.payload_json, {}) }));
  },
  acknowledgeOutbox({ id }) {
    db.prepare("update result_outbox set status='sent',updated_at=? where id=?").run(nowIso(), id);
    return true;
  },
  failOutbox({ id, retryAt }) {
    db.prepare("update result_outbox set attempts=attempts+1,next_attempt_at=?,updated_at=? where id=?").run(retryAt, nowIso(), id);
    return true;
  },
  getDocument({ sha256 }) {
    const row = db.prepare("select * from document_cache where sha256=? and expires_at>?").get(sha256, Date.now());
    if (!row) return null;
    db.prepare("update document_cache set last_accessed_at=? where sha256=?").run(nowIso(), sha256);
    return { ...row, metadata: fromJson(row.metadata_json, {}) };
  },
  getVectorMetadata({ datasetKey }) {
    return db.prepare("select * from vector_index_metadata where dataset_key=?").get(datasetKey) || null;
  },
  putVectorMetadata({ datasetKey, modelId, dimensions, indexVersion = 1, indexedAlterId = 0 }) {
    db.prepare(`insert into vector_index_metadata(dataset_key,model_id,dimensions,index_version,indexed_alter_id,updated_at)
      values(?,?,?,?,?,?) on conflict(dataset_key) do update set model_id=excluded.model_id,dimensions=excluded.dimensions,
      index_version=excluded.index_version,indexed_alter_id=excluded.indexed_alter_id,updated_at=excluded.updated_at`)
      .run(datasetKey, modelId, dimensions, indexVersion, indexedAlterId, nowIso());
    return operations.getVectorMetadata({ datasetKey });
  },
  putDocument({ sha256, markdownGzip, metadata = {}, ttlMs = 30 * 86400000 }) {
    const at = nowIso();
    db.prepare(`insert into document_cache(sha256,markdown_gzip,metadata_json,expires_at,created_at,last_accessed_at)
      values(?,?,?,?,?,?) on conflict(sha256) do update set markdown_gzip=excluded.markdown_gzip,
      metadata_json=excluded.metadata_json,expires_at=excluded.expires_at,last_accessed_at=excluded.last_accessed_at`)
      .run(sha256, Buffer.from(markdownGzip), toJson(metadata), Date.now() + ttlMs, at, at);
    return true;
  },
  recordDiagnostic({ category, payload }) {
    db.prepare("insert into diagnostics(category,payload_json,created_at) values(?,?,?)").run(category, toJson(payload), Date.now());
    return true;
  },
  maintenance({
    diagnosticsRetentionMs = 14 * 86400000,
    completedJobRetentionMs = 7 * 86400000,
    deliveredOutboxRetentionMs = 7 * 86400000,
    workflowSnapshotRetentionMs = 7 * 86400000,
    cacheLimitBytes = 1024 ** 3,
  }) {
    const now = Date.now();
    const diagnostics = db.prepare("delete from diagnostics where created_at<?").run(now - diagnosticsRetentionMs).changes;
    const documents = db.prepare("delete from document_cache where expires_at<?").run(now).changes;
    const outboxCutoff = new Date(now - deliveredOutboxRetentionMs).toISOString();
    const jobsCutoff = new Date(now - completedJobRetentionMs).toISOString();
    const snapshotsCutoff = new Date(now - workflowSnapshotRetentionMs).toISOString();
    const deliveredOutbox = db.prepare("delete from result_outbox where status='sent' and updated_at<?").run(outboxCutoff).changes;
    // Purchase catalogues now live only in normalized master_cache rows. Drop
    // legacy full-catalogue snapshots and expire other derived workflow data.
    const workflowSnapshots = db.prepare("delete from workflow_voucher_cache where workflow='purchase_masters' or updated_at<?")
      .run(snapshotsCutoff).changes;
    const completedJobs = db.prepare(`delete from agent_jobs
      where status in ('succeeded','failed') and updated_at<?
      and not exists (
        select 1 from result_outbox
        where result_outbox.command_id=agent_jobs.command_id and result_outbox.status='pending'
      )`).run(jobsCutoff).changes;
    db.pragma("wal_checkpoint(TRUNCATE)");
    const usedBytes = () => Number(db.pragma("page_count", { simple: true })) * Number(db.pragma("page_size", { simple: true }));
    let evictedDocuments = 0;
    let evictedVouchers = 0;
    while (usedBytes() > cacheLimitBytes) {
      const info = db.prepare("delete from document_cache where sha256 in (select sha256 from document_cache order by last_accessed_at asc limit 100)").run();
      evictedDocuments += info.changes;
      if (!info.changes) break;
    }
    while (usedBytes() > cacheLimitBytes) {
      const info = db.prepare("delete from workflow_voucher_cache where rowid in (select rowid from workflow_voucher_cache order by updated_at asc limit 500)").run();
      evictedVouchers += info.changes;
      if (!info.changes) break;
    }
    const pageCount = Number(db.pragma("page_count", { simple: true }));
    const freePages = Number(db.pragma("freelist_count", { simple: true }));
    if (evictedDocuments || evictedVouchers || (freePages > 0 && freePages / Math.max(1, pageCount) >= 0.2)) db.exec("vacuum");
    const sizeBytes = fs.statSync(databasePath).size;
    return {
      sizeBytes, cacheLimitBytes, overLimit: sizeBytes > cacheLimitBytes,
      deleted: { diagnostics, documents, deliveredOutbox, completedJobs, workflowSnapshots },
      evictedDocuments, evictedVouchers,
    };
  },
  exportDiagnostics() {
    const rows = db.prepare("select category,payload_json,created_at from diagnostics order by created_at desc limit 5000").all();
    return rows.map((row) => ({ category: row.category, createdAt: row.created_at, payload: fromJson(row.payload_json, {}) }));
  },
  getReceivableState({ datasetKey }) {
    const row = db.prepare("select state_json from receivable_state where dataset_key=?").get(datasetKey);
    return row ? fromJson(row.state_json, null) : null;
  },
  putReceivableState({ datasetKey, state }) {
    db.prepare(`insert into receivable_state(dataset_key,state_json,updated_at) values(?,?,?)
      on conflict(dataset_key) do update set state_json=excluded.state_json,updated_at=excluded.updated_at`)
      .run(datasetKey, toJson(state), nowIso());
    return state;
  },
  clearReceivables({ datasetKey }) {
    const transaction = db.transaction(() => {
      for (const table of ["receivable_bills", "receivable_vouchers", "receivable_voucher_ledgers"]) {
        db.prepare(`delete from ${table} where dataset_key=?`).run(datasetKey);
      }
    });
    transaction();
    return true;
  },
  // Replaces the open bills of the given customers. Customers with no open
  // bills are passed with an empty list so stale rows are removed.
  replaceReceivableBills({ datasetKey, byLedger = {} }) {
    const remove = db.prepare("delete from receivable_bills where dataset_key=? and ledger_key=?");
    const insert = db.prepare(`insert or replace into receivable_bills(dataset_key,ledger_key,bill_key,xml,fields,updated_at) values(?,?,?,'',?,?)`);
    const at = nowIso();
    let count = 0;
    db.transaction(() => {
      for (const [ledgerKey, bills] of Object.entries(byLedger)) {
        remove.run(datasetKey, ledgerKey);
        for (const bill of bills || []) { insert.run(datasetKey, ledgerKey, bill.key, toJson(bill.fields), at); count += 1; }
      }
    })();
    return { count };
  },
  upsertReceivableVouchers({ datasetKey, vouchers = [] }) {
    const upsert = db.prepare(`insert into receivable_vouchers(dataset_key,master_id,alter_id,voucher_date,xml,fields,updated_at) values(?,?,?,?,'',?,?)
      on conflict(dataset_key,master_id) do update set alter_id=excluded.alter_id,voucher_date=excluded.voucher_date,xml='',fields=excluded.fields,updated_at=excluded.updated_at`);
    const removeLedgers = db.prepare("delete from receivable_voucher_ledgers where dataset_key=? and master_id=?");
    const removeVoucher = db.prepare("delete from receivable_vouchers where dataset_key=? and master_id=?");
    const addLedger = db.prepare("insert or ignore into receivable_voucher_ledgers(dataset_key,master_id,ledger_key) values(?,?,?)");
    const at = nowIso();
    db.transaction(() => {
      for (const voucher of vouchers) {
        removeLedgers.run(datasetKey, voucher.masterId);
        // An edited voucher that no longer touches any customer is dropped.
        if (!voucher.ledgerKeys?.length) { removeVoucher.run(datasetKey, voucher.masterId); continue; }
        upsert.run(datasetKey, voucher.masterId, Number(voucher.alterId || 0), voucher.date || null, toJson(voucher.fields), at);
        for (const ledgerKey of voucher.ledgerKeys) addLedger.run(datasetKey, voucher.masterId, ledgerKey);
      }
    })();
    return { count: vouchers.length };
  },
  listReceivableBills({ datasetKey, ledgerKeys = [] }) {
    if (!ledgerKeys.length) return [];
    const rows = [];
    // Same order as the full snapshot: by bill key within a customer.
    const statement = db.prepare("select ledger_key,fields from receivable_bills where dataset_key=? and ledger_key=? order by bill_key");
    for (const ledgerKey of ledgerKeys) rows.push(...statement.all(datasetKey, ledgerKey));
    return rows.map((row) => ({ ledgerKey: row.ledger_key, fields: row.fields }));
  },
  listReceivableVouchers({ datasetKey, ledgerKeys = [], dateFrom = null, dateTo = null }) {
    if (!ledgerKeys.length) return [];
    const seen = new Set();
    const result = [];
    const statement = db.prepare(`select v.master_id,v.voucher_date,v.fields from receivable_voucher_ledgers l
      join receivable_vouchers v on v.dataset_key=l.dataset_key and v.master_id=l.master_id
      where l.dataset_key=? and l.ledger_key=?`);
    for (const ledgerKey of ledgerKeys) {
      for (const row of statement.all(datasetKey, ledgerKey)) {
        if (seen.has(row.master_id)) continue;
        if (dateFrom && row.voucher_date && row.voucher_date < dateFrom) continue;
        if (dateTo && row.voucher_date && row.voucher_date > dateTo) continue;
        seen.add(row.master_id);
        result.push(row.fields);
      }
    }
    return result;
  },
  // Replaces every voucher linked to the given customers with a fresh set read
  // from Tally. Vouchers deleted in Tally disappear; vouchers left with no
  // customer link are removed.
  replaceReceivableVouchersForLedgers({ datasetKey, ledgerKeys = [], vouchers = [] }) {
    if (!ledgerKeys.length) return { count: 0 };
    const unlink = db.prepare("delete from receivable_voucher_ledgers where dataset_key=? and ledger_key=?");
    db.transaction(() => { for (const ledgerKey of ledgerKeys) unlink.run(datasetKey, ledgerKey); })();
    operations.upsertReceivableVouchers({ datasetKey, vouchers });
    db.prepare(`delete from receivable_vouchers where dataset_key=? and not exists (
      select 1 from receivable_voucher_ledgers l where l.dataset_key=receivable_vouchers.dataset_key and l.master_id=receivable_vouchers.master_id)`).run(datasetKey);
    return { count: vouchers.length };
  },
  listReceivableVoucherLedgerKeys({ datasetKey, masterId }) {
    return db.prepare("select ledger_key from receivable_voucher_ledgers where dataset_key=? and master_id=?")
      .all(datasetKey, masterId).map((row) => row.ledger_key);
  },
  // Every bill, voucher and customer link of a dataset in three sequential
  // reads. A scan loads this once instead of thousands of per-customer
  // lookups, which are slow on busy spinning disks.
  listAllReceivableRecords({ datasetKey }) {
    return {
      // Fields stay JSON text here; the caller parses them once.
      bills: db.prepare("select ledger_key,bill_key,fields from receivable_bills where dataset_key=? order by rowid").all(datasetKey)
        .map((row) => ({ ledgerKey: row.ledger_key, billKey: row.bill_key, fields: row.fields })),
      vouchers: db.prepare("select master_id,voucher_date,fields from receivable_vouchers where dataset_key=?").all(datasetKey)
        .map((row) => ({ masterId: row.master_id, date: row.voucher_date, fields: row.fields })),
      links: db.prepare("select ledger_key,master_id from receivable_voucher_ledgers where dataset_key=? order by rowid").all(datasetKey)
        .map((row) => ({ ledgerKey: row.ledger_key, masterId: row.master_id })),
    };
  },
  listReceivableLedgerKeys({ datasetKey }) {
    return db.prepare("select distinct ledger_key from receivable_bills where dataset_key=?").all(datasetKey).map((row) => row.ledger_key);
  },
  receivableCounts({ datasetKey }) {
    const count = (sql) => Number(db.prepare(sql).get(datasetKey)?.count || 0);
    return {
      customersWithBills: count("select count(distinct ledger_key) as count from receivable_bills where dataset_key=?"),
      bills: count("select count(*) as count from receivable_bills where dataset_key=?"),
      vouchers: count("select count(*) as count from receivable_vouchers where dataset_key=?"),
    };
  },
  invalidateWorkflowSnapshots({ datasetKey, workflow }) {
    db.prepare('delete from workflow_voucher_cache where dataset_key=? and workflow=?').run(datasetKey, workflow);
    return true;
  },
  clearRebuildableCache() {
    const transaction = db.transaction(() => {
      db.exec("delete from master_cache; delete from open_bill_cache; delete from workflow_voucher_cache; delete from tombstones; delete from document_cache; delete from vector_index_metadata; delete from vector_document_state; delete from receivable_state; delete from receivable_bills; delete from receivable_vouchers; delete from receivable_voucher_ledgers;");
      db.prepare("update company_datasets set status='new',cursor_json='{}',cache_health_json='{}',last_sync_at=null,updated_at=?").run(nowIso());
    });
    transaction();
    return true;
  },
  close() { db.close(); return true; },
};

parentPort.on("message", async ({ id, operation, payload }) => {
  try {
    const handler = operations[operation];
    if (!handler) throw new Error(`Unknown storage operation: ${operation}`);
    const result = await handler(payload || {});
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error instanceof Error ? error.message : String(error), code: error?.code || "STORAGE_ERROR" } });
  }
});

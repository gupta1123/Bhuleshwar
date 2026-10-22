#!/usr/bin/env node

import fs from "node:fs";
import { validatePurchaseDocumentFolder, testPurchaseDocumentFolder, withFolderTimeout } from './purchase-document-folder.mjs';
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { cashDiscountReadContext, checkReadBudget, readBoundedXml, createTallyScheduler, createCashDiscountResultCache,
  createConnectorBenchmarkTrace, finishConnectorBenchmarkTrace, markConnectorBenchmarkStage,
  recordConnectorTallyRead, CASH_DISCOUNT_READ_MS, CASH_DISCOUNT_SCAN_MS,
  CASH_DISCOUNT_RESULT_BYTES } from "./cash-discount-runtime.mjs";
import { createLocalAgentRuntime } from "./agent/runtime.mjs";
import { openBillAmountIndexFromFields, openBillFromFields, openBillsByLedgerFromFields } from "./agent/receivable-fields.mjs";
import { buildLiveCashDiscountDashboard } from "./collections-analysis/cash-discount-live-dashboard.mjs";
import { collectionRowsById, collectionRowsByInvoice, dashboardShell, queryCollections } from "./collections-analysis/collections-query.mjs";
import { powershellProtectedData } from "./agent/key-vault.mjs";
import { workflowCacheState } from './agent/workflow-cache-policy.mjs';
import { startDetachedDocument } from "./agent/detached-document.mjs";
import { assertBankDocumentScope } from './agent/bank-document-scope.mjs';
import { buildTargetedMastersXml } from "./targeted-masters.mjs";
import { readScopedOpenBills } from "./open-bill-discovery.mjs";
import { AGENT_CAPABILITIES, AGENT_PROTOCOL_VERSION, AGENT_VERSION, jobClassForCommand } from "./agent/protocol.mjs";

const BRIDGE_VERSION = AGENT_VERSION;
const MAX_COMMANDS_PER_CYCLE = 50;
const DEFAULT_TALLY_URL = "http://localhost:9000";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_COMPANY_LIST_INTERVAL_MS = 5 * 60_000;
const TALLY_IMPORT_TIMEOUT_MS = 30_000;
const TALLY_READINESS_TIMEOUT_MS = 5_000;
// Exports can be larger than imports, but they must still release the bridge
// cycle if Tally is busy or has stopped responding.
const TALLY_EXPORT_TIMEOUT_MS = 60_000;
const BANK_MATCH_READ_TIMEOUT_MS = 20_000;
const BANK_MATCH_MAX_XML_BYTES = 8 * 1024 * 1024;
const OPEN_BILL_LEDGER_BATCH_SIZE = 50;
const CASH_DISCOUNT_VOUCHER_DAYS_PER_CHUNK = 31;
const CASH_DISCOUNT_EVIDENCE_LEDGER_BATCH_SIZE = 20;
const CASH_DISCOUNT_NATIVE_UNION_BATCH_SIZE = 50;
const CASH_DISCOUNT_LOW_MEMORY_UNION_BATCH_SIZE = 25;
const CASH_DISCOUNT_MAX_VOUCHER_CHUNKS = 60;
const CASH_DISCOUNT_READINESS_REUSE_MS = 5_000;
const CASH_DISCOUNT_VOUCHER_FIELDS =
  "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount";
const LEGACY_CONFIG_DIR = path.join(os.homedir(), ".autodealer-tally-bridge");
const CONFIG_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Bhuleshwar",
  "LocalAgent",
  "config"
);
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const INSTALLATION_ID_PATH = path.join(CONFIG_DIR, "installation-id");
const LEGACY_CONFIG_PATH = path.join(LEGACY_CONFIG_DIR, "config.json");
const LEGACY_INSTALLATION_ID_PATH = path.join(LEGACY_CONFIG_DIR, "installation-id");
const MAX_NATIVE_DEBIT_NOTE_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PURCHASE_SOURCE_PDF_BYTES = 25 * 1024 * 1024;
const PURCHASE_DOCUMENT_UDFS = {
  path: { name: "KalikaSourceDocumentPath", index: 30001 },
  name: { name: "KalikaSourceDocumentName", index: 30002 },
  sha256: { name: "KalikaSourceDocumentSha256", index: 30003 },
  id: { name: "KalikaSourceDocumentId", index: 30004 },
  vehicle: { name: "KalikaVehicleNumber", index: 30005 },
};
const DEFAULT_TALLY_DATA_ROOT = path.join(process.env.PUBLIC || "C:\\Users\\Public", "TallyPrime", "data");
const CURRENT_FILE = fileURLToPath(import.meta.url);
let cachedTrustedCaCertificates = null;
const recentCompanyReadiness = new Map();
const cashDiscountResultCache = createCashDiscountResultCache();
const livenessCapableBackends = new Set();

// Live reads already shrink their batch size as free memory drops (see
// cashDiscountNativeUnionBatchSize) and cap the XML they buffer, so they are
// refused only as a last resort: when the machine is nearly out of memory, or
// when the agent itself has grown unusually large. The old fixed 750 MB
// free-memory floor rejected reads on ordinary 4 GB client PCs.
const LIVE_READ_MIN_FREE_BYTES = 256 * 1024 * 1024;
const LIVE_READ_MAX_AGENT_RSS_BYTES = 1024 * 1024 * 1024;

export function liveReadMemoryPressure({ freeBytes = os.freemem(), rssBytes = process.memoryUsage().rss } = {}) {
  return freeBytes < LIVE_READ_MIN_FREE_BYTES || rssBytes > LIVE_READ_MAX_AGENT_RSS_BYTES;
}

function cashDiscountNativeUnionBatchSize() {
  const benchmarkOverride = Number(process.env.KALIKA_CASH_DISCOUNT_UNION_BATCH_SIZE);
  const free = os.freemem();
  const safeMaximum = free < 1500 * 1024 * 1024 ? 10 : os.totalmem() <= 6 * 1024 * 1024 * 1024 ? 25 : 50;
  if (Number.isInteger(benchmarkOverride) && benchmarkOverride > 0) {
    return Math.min(safeMaximum, benchmarkOverride);
  }
  return safeMaximum;
}

function trustedCaCertificates() {
  if (cachedTrustedCaCertificates) return cachedTrustedCaCertificates;
  const certificates = [...tls.rootCertificates];
  if (typeof tls.getCACertificates === "function") {
    certificates.push(...tls.getCACertificates("system"));
  }
  if (process.platform === "win32") {
    try {
      const pem = fs.readFileSync(path.join(CONFIG_DIR, "windows-ca-bundle.pem"), "utf8");
      certificates.push(...(pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []));
    } catch {
      // Bundled and Node-provided roots remain available before the desktop
      // wrapper creates the Windows trust bundle on first launch.
    }
  }
  cachedTrustedCaCertificates = [...new Set(certificates)];
  return cachedTrustedCaCertificates;
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      continue;
    }

    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function required(value, name) {
  if (!value) {
    throw new Error(`Missing required argument: --${name}`);
  }

  return value;
}

function normalizeBaseUrl(value) {
  return required(value, "api-base").replace(/\/+$/, "");
}

function normalizeTallyUrl(value) {
  const raw = (value || DEFAULT_TALLY_URL).replace(/\/+$/, "");
  try {
    const url = new URL(raw);
    // Tally commonly binds only to IPv4 on Windows. Node/Electron may resolve
    // localhost to ::1 first, which makes the connector report Tally offline
    // even though http://127.0.0.1:9000 works from the same machine.
    if (url.hostname.toLowerCase() === "localhost") url.hostname = "127.0.0.1";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

function formatTallyConnectivityError(tallyUrl, error) {
  const target = normalizeTallyUrl(tallyUrl);
  const baseMessage = error instanceof Error ? error.message : String(error ?? "Unable to reach Tally.");
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
  const causeCode = cause && typeof cause.code === "string" ? cause.code : "";
  const causeMessage = cause?.message || "";
  const combined = `${baseMessage} ${causeMessage} ${causeCode}`.trim();

  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|AbortError/i.test(combined)) {
    return `Unable to reach Tally at ${target}. Check the Tally server IP/hostname, port 9000, Windows firewall, and that this connector machine is on the same LAN or VPN.`;
  }

  return combined || `Unable to reach Tally at ${target}.`;
}

// Moves the pre-1.0 connector configuration (~\.autodealer-tally-bridge) into
// the Local Agent folder exactly once, then deletes the legacy folder. Earlier
// builds kept the legacy file and re-imported it whenever the current config
// was removed by a disconnect, resurrecting a revoked token and leaving a new
// backup copy each time.
function migrateLegacyConfiguration() {
  if (!fs.existsSync(LEGACY_CONFIG_PATH) && !fs.existsSync(LEGACY_INSTALLATION_ID_PATH)) return;
  try {
    // An existing installation-id means this machine was already migrated
    // (or set up fresh); a missing config.json then means "disconnected".
    const alreadyMigrated = fs.existsSync(INSTALLATION_ID_PATH);
    if (!alreadyMigrated && fs.existsSync(LEGACY_CONFIG_PATH) && !fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, "utf8"));
      writeConfig({ ...legacy, bridgeVersion: BRIDGE_VERSION });
    }
    if (fs.existsSync(LEGACY_INSTALLATION_ID_PATH) && !fs.existsSync(INSTALLATION_ID_PATH)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.copyFileSync(LEGACY_INSTALLATION_ID_PATH, INSTALLATION_ID_PATH);
    }
    // Remove ONLY the old pairing files. The legacy folder also holds
    // documents\ with purchase PDFs that existing Tally vouchers link to by
    // absolute path, so it must never be deleted wholesale.
    fs.rmSync(LEGACY_CONFIG_PATH, { force: true });
    fs.rmSync(LEGACY_INSTALLATION_ID_PATH, { force: true });
    if (!fs.readdirSync(LEGACY_CONFIG_DIR).length) fs.rmdirSync(LEGACY_CONFIG_DIR);
  } catch (error) {
    console.error(`Legacy connector configuration cleanup deferred: ${error instanceof Error ? error.message : error}`);
  }
}

// The bridge token authenticates this computer to Kalika, so it is stored
// encrypted with Windows DPAPI (current user) rather than as plain text.
// Decryption spawns PowerShell, so results are cached for the process.
const protectedTokenCache = new Map();

function protectBridgeToken(token) {
  for (const [cipher, plain] of protectedTokenCache) if (plain === token) return cipher;
  const cipher = powershellProtectedData("protect", Buffer.from(token, "utf8")).toString("base64");
  protectedTokenCache.set(cipher, token);
  return cipher;
}

function unprotectBridgeToken(cipher) {
  if (!protectedTokenCache.has(cipher)) {
    protectedTokenCache.set(cipher, powershellProtectedData("unprotect", Buffer.from(cipher, "base64")).toString("utf8"));
  }
  return protectedTokenCache.get(cipher);
}

function readConfig() {
  migrateLegacyConfiguration();
  if (!fs.existsSync(CONFIG_PATH)) {
    return null;
  }

  const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const { bridgeTokenProtected, ...config } = stored;
  if (bridgeTokenProtected) {
    config.bridgeToken = unprotectBridgeToken(bridgeTokenProtected);
  } else if (config.bridgeToken && process.platform === "win32") {
    // Older builds saved the token in plain text; re-save it encrypted.
    writeConfig(config);
  }

  // Older connector releases persisted the last detected Tally company here.
  // That value is session state, not configuration: on the next launch it can
  // incorrectly override the company that is actually active in TallyPrime.
  if (Object.prototype.hasOwnProperty.call(config, "companyName")) {
    delete config.companyName;
    writeConfig(config);
  }

  if (config.bridgeVersion !== BRIDGE_VERSION) {
    config.bridgeVersion = BRIDGE_VERSION;
    writeConfig(config);
  }

  const normalizedTallyUrl = normalizeTallyUrl(config.tallyUrl);
  if (config.tallyUrl !== normalizedTallyUrl) {
    config.tallyUrl = normalizedTallyUrl;
    writeConfig(config);
  }

  return config;
}

function formatCliError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;
  if (cause instanceof Error) {
    const code = typeof cause.code === "string" ? ` (${cause.code})` : "";
    return `${error.message}: ${cause.message}${code}`;
  }

  return error.message;
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const stored = { ...config };
  if (stored.bridgeToken && process.platform === "win32") {
    try {
      stored.bridgeTokenProtected = protectBridgeToken(stored.bridgeToken);
      delete stored.bridgeToken;
    } catch (error) {
      // A managed endpoint can block DPAPI; stay connected rather than fail.
      console.error(`Could not encrypt the connector token: ${error instanceof Error ? error.message : error}`);
    }
  }
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, CONFIG_PATH);
}

function deleteConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.rmSync(CONFIG_PATH, { force: true });
  }
}

function createMachineId() {
  migrateLegacyConfiguration();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  let installationId = "";
  if (fs.existsSync(INSTALLATION_ID_PATH)) {
    installationId = fs.readFileSync(INSTALLATION_ID_PATH, "utf8").trim();
  }
  if (!installationId) {
    installationId = randomUUID();
    fs.writeFileSync(INSTALLATION_ID_PATH, `${installationId}\n`, { mode: 0o600 });
  }

  return `${os.hostname()}-${os.platform()}-${os.arch()}-${installationId}`;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `HTTP ${response.status}` };
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXmlEntities(value) {
  let decoded = String(value ?? "");
  for (let index = 0; index < 3; index += 1) {
    const next = decoded
      .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
        const parsed = Number.parseInt(code, 16);
        return Number.isFinite(parsed) && parsed >= 32 ? String.fromCodePoint(parsed) : " ";
      })
      .replace(/&#(\d+);/g, (_, code) => {
        const parsed = Number.parseInt(code, 10);
        return Number.isFinite(parsed) && parsed >= 32 ? String.fromCodePoint(parsed) : " ";
      })
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function cleanXmlText(value) {
  return decodeXmlEntities(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTagText(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? cleanXmlText(match[1]) : null;
}

function getAttributeFromAnyElement(block, attributeName) {
  const match = String(block || "").match(new RegExp(
    `<[^>\\s]+\\b[^>]*\\b${attributeName}\\s*=\\s*(["'])(.*?)\\1`,
    "i"
  ));
  return match ? cleanXmlText(match[2]) : null;
}

function getUdfTagText(block, tagName) {
  const match = block.match(
    new RegExp(`<(?:UDF:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:UDF:)?${tagName}>`, "i")
  );
  return match ? cleanXmlText(match[1]) : null;
}

function getTagTexts(block, tagName) {
  const matches = [...block.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi"))];
  return matches.map((match) => cleanXmlText(match[1])).filter(Boolean);
}

function getXmlValues(block, tagNames) {
  const values = [];
  for (const tagName of tagNames) {
    values.push(...getTagTexts(block, tagName));
    const attributeValue = getAttributeFromAnyElement(block, tagName);
    if (attributeValue) values.push(attributeValue);
  }
  return values.filter(Boolean);
}

function hsnCodeFromBlock(block, ...tagNames) {
  for (const raw of getXmlValues(block, tagNames)) {
    if (/^(?:not\s+found|not\s+available|n\/?a|none|null|undefined|-+)$/i.test(raw)) continue;
    const value = raw.replace(/\D/g, "");
    if (/^\d{4,8}$/.test(value)) return value;
  }
  return null;
}

function getAttribute(block, attributeName) {
  const match = block.match(new RegExp(`\\b${attributeName}\\s*=\\s*"([^"]*)"`, "i"));
  return match ? cleanXmlText(match[1]) : null;
}

function extractBlocks(xml, tagName) {
  const blocks = [];
  const regex = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi");
  let match = regex.exec(xml);

  while (match) {
    blocks.push(match[0]);
    match = regex.exec(xml);
  }

  return blocks;
}

// Tally places response counters in the same XML document as collection rows
// (for example CMPINFO contains <LEDGER>0</LEDGER>). Those scalar elements are
// not ledger records and must not enter the bill scan. A real collection row
// is either NAME-attributed or contains a nested NAME field; nested rows that
// lack a name remain an error so malformed accounting data is never ignored.
function extractNamedCollectionNames(xml, tagName) {
  return extractBlocks(xml, tagName).flatMap((block) => {
    const name = getAttribute(block, "NAME") || getTagText(block, "NAME");
    if (name) return [name];
    const inner = block
      .replace(new RegExp(`^<${tagName}\\b[^>]*>`, "i"), "")
      .replace(new RegExp(`</${tagName}>$`, "i"), "")
      .trim();
    if (!inner || !inner.includes("<")) return [];
    throw new Error(`Open-bill ledger discovery returned an unidentified ${tagName.toLowerCase()} record.`);
  });
}

function buildCollectionExportXml({
  collectionName,
  tallyType,
  fetchFields,
  companyName,
  childOf,
  dateFrom,
  dateTo,
  formulae = [],
  filterNames = [],
}) {
  const companyVariable = companyName
    ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`
    : "";
  const dateVariables = [
    dateFrom ? `<SVFROMDATE TYPE="Date">${escapeXml(String(dateFrom).replaceAll("-", ""))}</SVFROMDATE>` : "",
    dateTo ? `<SVTODATE TYPE="Date">${escapeXml(String(dateTo).replaceAll("-", ""))}</SVTODATE>` : "",
  ].filter(Boolean);
  const childOfFilter = childOf
    ? `<ADD>CHILD OF : ${escapeXml(childOf)}</ADD>`
    : "";
  const safeFormulae = formulae.filter(
    (formula) => formula && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(formula.name || "")) && String(formula.formula || "").trim()
  );
  const availableFormulaNames = new Set(safeFormulae.map((formula) => formula.name));
  const appliedFilterNames = filterNames.filter((name) => availableFormulaNames.has(name));
  const collectionFilter = appliedFilterNames.length > 0
    ? `<FILTER>${escapeXml(appliedFilterNames.join(","))}</FILTER>`
    : "";
  const formulaDefinitions = safeFormulae.map(
    ({ name, formula }) =>
      `<SYSTEM TYPE="Formulae" NAME="${escapeXml(name)}" ISMODIFY="No">${escapeXml(String(formula).trim())}</SYSTEM>`
  );

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<VERSION>1</VERSION>",
    "<TALLYREQUEST>Export</TALLYREQUEST>",
    "<TYPE>Collection</TYPE>",
    `<ID>${escapeXml(collectionName)}</ID>`,
    "</HEADER>",
    "<BODY>",
    "<DESC>",
    "<STATICVARIABLES>",
    companyVariable,
    ...dateVariables,
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    "</STATICVARIABLES>",
    "<TDL>",
    "<TDLMESSAGE>",
    `<COLLECTION NAME="${escapeXml(collectionName)}" ISMODIFY="No">`,
    `<TYPE>${escapeXml(tallyType)}</TYPE>`,
    childOfFilter,
    collectionFilter,
    `<FETCH>${escapeXml(fetchFields)}</FETCH>`,
    "</COLLECTION>",
    ...formulaDefinitions,
    "</TDLMESSAGE>",
    "</TDL>",
    "</DESC>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

function buildLedgerBalanceExportXml({ companyName, ledgerName, dateFrom, dateTo }) {
  const companyVariable = companyName
    ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`
    : "";
  const fromDate = String(dateFrom || dateTo || "").replaceAll("-", "");
  const toDate = String(dateTo || dateFrom || "").replaceAll("-", "");

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<VERSION>1</VERSION>",
    "<TALLYREQUEST>EXPORT</TALLYREQUEST>",
    "<TYPE>OBJECT</TYPE>",
    "<SUBTYPE>Ledger</SUBTYPE>",
    `<ID TYPE="Name">${escapeXml(ledgerName)}</ID>`,
    "</HEADER>",
    "<BODY>",
    "<DESC>",
    "<STATICVARIABLES>",
    companyVariable,
    fromDate ? `<SVFROMDATE TYPE="Date">${escapeXml(fromDate)}</SVFROMDATE>` : "",
    toDate ? `<SVTODATE TYPE="Date">${escapeXml(toDate)}</SVTODATE>` : "",
    toDate ? `<SVCURRENTDATE TYPE="Date">${escapeXml(toDate)}</SVCURRENTDATE>` : "",
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    "</STATICVARIABLES>",
    "<FETCHLIST>",
    "<FETCH>Name</FETCH>",
    "<FETCH>ClosingBalance</FETCH>",
    "</FETCHLIST>",
    "</DESC>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

// TallyPrime 3+ stores a ledger's GST registration in the effective-dated
// `Led GST Reg Details` aggregate. Broad Ledger collections commonly omit this
// aggregate even when the GSTIN is visible in Ledger Alteration, so read the
// exact native Ledger object and explicitly fetch the registration storage.
function buildLedgerGstRegistrationExportXml({ companyName, ledgerName }) {
  const companyVariable = companyName
    ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`
    : "";

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<VERSION>1</VERSION>",
    "<TALLYREQUEST>EXPORT</TALLYREQUEST>",
    "<TYPE>OBJECT</TYPE>",
    "<SUBTYPE>Ledger</SUBTYPE>",
    `<ID TYPE="Name">${escapeXml(ledgerName)}</ID>`,
    "</HEADER>",
    "<BODY>",
    "<DESC>",
    "<STATICVARIABLES>",
    companyVariable,
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    "</STATICVARIABLES>",
    "<FETCHLIST>",
    "<FETCH>Name</FETCH>",
    "<FETCH>GUID</FETCH>",
    "<FETCH>Parent</FETCH>",
    "<FETCH>PartyGSTIN</FETCH>",
    "<FETCH>GSTIN</FETCH>",
    "<FETCH>Led GST Reg Details</FETCH>",
    "<FETCH>LedGSTRegDetails.*</FETCH>",
    "</FETCHLIST>",
    "</DESC>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

function tallyFormulaString(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function buildRequestedLedgerFormula(ledgerNames, methodNames = ["$LedgerName"]) {
  const names = uniquePayloadLedgerNames({ ledgerNames });
  const methods = Array.from(new Set(methodNames.map((method) => String(method || "").trim()).filter(Boolean)));
  if (names.length === 0 || methods.length === 0) return "$$IsEmpty:$Name AND NOT $$IsEmpty:$Name";
  return names
    .flatMap((ledgerName) => methods.map((method) => `$$IsEqual:${method}:${tallyFormulaString(ledgerName)}`))
    .map((condition) => `(${condition})`)
    .join(" OR ");
}

function buildAlterLedgerXml(payload, fallbackCompanyName) {
  const oldName = payload?.oldName;
  const newName = payload?.newName || oldName;
  const parentName = payload?.parentName;
  const phoneNumber = payload?.phoneNumber || payload?.ledgerMobile || payload?.ledgerPhone;
  const companyName = payload?.companyName || fallbackCompanyName;

  if (!oldName || !newName) {
    throw new Error("Ledger edit command is missing oldName or newName.");
  }

  const companyVariable = companyName
    ? `<SVCurrentCompany>${escapeXml(companyName)}</SVCurrentCompany>`
    : "";
  const parentBlock = parentName ? `<PARENT>${escapeXml(parentName)}</PARENT>` : "";
  const phoneBlock = phoneNumber
    ? [
        `<LEDGERMOBILE>${escapeXml(phoneNumber)}</LEDGERMOBILE>`,
        `<LEDGERPHONE>${escapeXml(phoneNumber)}</LEDGERPHONE>`,
        `<PHONENUMBER>${escapeXml(phoneNumber)}</PHONENUMBER>`,
      ].join("")
    : "";

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<TALLYREQUEST>Import Data</TALLYREQUEST>",
    "</HEADER>",
    "<BODY>",
    "<IMPORTDATA>",
    "<REQUESTDESC>",
    "<REPORTNAME>All Masters</REPORTNAME>",
    "<STATICVARIABLES>",
    companyVariable,
    "</STATICVARIABLES>",
    "</REQUESTDESC>",
    "<REQUESTDATA>",
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<LEDGER NAME="${escapeXml(oldName)}" ACTION="Alter">`,
    `<NAME>${escapeXml(newName)}</NAME>`,
    parentBlock,
    phoneBlock,
    "<LANGUAGENAME.LIST>",
    '<NAME.LIST TYPE="String">',
    `<NAME>${escapeXml(newName)}</NAME>`,
    "</NAME.LIST>",
    '<LANGUAGEID TYPE="Number">1033</LANGUAGEID>',
    "</LANGUAGENAME.LIST>",
    "</LEDGER>",
    "</TALLYMESSAGE>",
    "</REQUESTDATA>",
    "</IMPORTDATA>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

function buildCreateLedgerXml(payload, fallbackCompanyName) {
  const name = String(payload?.name || "").trim();
  const parentName = String(payload?.parentName || "").trim();
  const companyName = payload?.companyName || fallbackCompanyName;

  if (!name || !parentName) {
    throw new Error("Ledger create command is missing name or parentName.");
  }

  const companyVariable = companyName
    ? `<SVCurrentCompany>${escapeXml(companyName)}</SVCurrentCompany>`
    : "";

  return [
    "<ENVELOPE>",
    "<HEADER>",
    "<TALLYREQUEST>Import Data</TALLYREQUEST>",
    "</HEADER>",
    "<BODY>",
    "<IMPORTDATA>",
    "<REQUESTDESC>",
    "<REPORTNAME>All Masters</REPORTNAME>",
    "<STATICVARIABLES>",
    companyVariable,
    "</STATICVARIABLES>",
    "</REQUESTDESC>",
    "<REQUESTDATA>",
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<LEDGER NAME="${escapeXml(name)}" ACTION="Create">`,
    `<NAME>${escapeXml(name)}</NAME>`,
    `<PARENT>${escapeXml(parentName)}</PARENT>`,
    "<ISBILLWISEON>No</ISBILLWISEON>",
    "<AFFECTSSTOCK>No</AFFECTSSTOCK>",
    "<LANGUAGENAME.LIST>",
    '<NAME.LIST TYPE="String">',
    `<NAME>${escapeXml(name)}</NAME>`,
    "</NAME.LIST>",
    '<LANGUAGEID TYPE="Number">1033</LANGUAGEID>',
    "</LANGUAGENAME.LIST>",
    "</LEDGER>",
    "</TALLYMESSAGE>",
    "</REQUESTDATA>",
    "</IMPORTDATA>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

function buildDebitNoteXml(payload, fallbackCompanyName) {
  const companyName = payload?.companyName || fallbackCompanyName;
  const voucherDate = toIsoLikeDate(payload?.voucherDate);
  const partyLedgerName = String(payload?.partyLedgerName || "").trim();
  // A missed cash discount increases the value of the original sale.  The
  // debit note must therefore credit the Sales ledger used by that invoice,
  // not a generic "Cash Discount Reversal" ledger.
  const salesLedgerName = String(payload?.salesLedgerName || "").trim();
  const amount = toMoney(payload?.amount);
  const referenceNumber = String(payload?.referenceNumber || "").trim();
  const linkedInvoiceNumber = String(payload?.linkedInvoiceNumber || "").trim();
  const debitNoteReferenceName = referenceNumber || `DN-CD-${linkedInvoiceNumber || Date.now()}`;
  const narration = String(
    payload?.narration ||
      `Cash discount reversal${linkedInvoiceNumber ? ` against Sales Invoice ${linkedInvoiceNumber}` : ""}.`
  ).trim();

  if (!partyLedgerName) {
    throw new Error("Debit note command requires partyLedgerName.");
  }
  if (!salesLedgerName) {
    throw new Error("Debit note command requires the Sales ledger from the original invoice.");
  }

  const debitNoteEntries = [
    buildLedgerEntryXml({
      ledgerName: partyLedgerName,
      amount,
      isDebit: true,
      isPartyLedger: true,
      billAllocations: buildBillAllocationsXml({
        allocations: [
          {
            referenceType: "New Ref",
            referenceName: debitNoteReferenceName,
            amount,
          },
        ],
        isDebit: true,
      }),
    }),
    buildLedgerEntryXml({
      ledgerName: salesLedgerName,
      amount,
      isDebit: false,
    }),
  ];

  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    messages: [
      buildVoucherMessageXml({
        voucherDate,
        voucherType: "Debit Note",
        referenceNumber,
        narration,
        entries: debitNoteEntries,
        partyLedgerName,
      }),
    ],
  });
}

function toIsoLikeDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{8}$/.test(raw)) {
    return raw;
  }
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]}${match[2]}${match[3]}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Bank voucher command is missing a valid voucher date.");
  }
  return parsed.toISOString().slice(0, 10).replaceAll("-", "");
}

function toDisplayDate(value) {
  const date = toIsoLikeDate(value);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function isLikelyEducationalModeDateRestriction(voucherDate, error) {
  if (!/voucher date is missing/i.test(String(error || ""))) return false;
  const date = toIsoLikeDate(voucherDate);
  const day = date.slice(6, 8);
  return day !== "01" && day !== "02" && day !== "31";
}

function explainVoucherTallyError(outcome, payload) {
  if (!outcome?.success && isLikelyEducationalModeDateRestriction(payload?.voucherDate, outcome?.error)) {
    const displayDate = toDisplayDate(payload.voucherDate);
    return {
      ...outcome,
      error:
        `${outcome.error} This matches Tally Educational Mode date restrictions: imports are accepted only on allowed dates such as the 1st, 2nd, and 31st. ` +
        `The voucher date ${displayDate} is blocked by Tally, not missing from the XML. Activate licensed Tally or test with an allowed date.`,
      result: {
        ...(outcome.result || {}),
        diagnosedReason: "tally_educational_mode_date_restriction",
        voucherDate: displayDate,
      },
    };
  }

  return outcome;
}

function toMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Bank voucher command is missing a positive amount.");
  }
  return parsed.toFixed(2);
}

function buildBankAllocationXml({ voucherDate, referenceNumber, amount, isDebit }) {
  const signedAmount = isDebit ? `-${amount}` : amount;
  const escapedReferenceNumber = escapeXml(referenceNumber);

  return [
    "<BANKALLOCATIONS.LIST>",
    `<DATE>${voucherDate}</DATE>`,
    `<INSTRUMENTDATE>${voucherDate}</INSTRUMENTDATE>`,
    escapedReferenceNumber ? `<NAME>${escapedReferenceNumber}</NAME>` : "",
    escapedReferenceNumber ? `<INSTRUMENTNUMBER>${escapedReferenceNumber}</INSTRUMENTNUMBER>` : "",
    "<TRANSACTIONTYPE>Others</TRANSACTIONTYPE>",
    `<AMOUNT>${signedAmount}</AMOUNT>`,
    "</BANKALLOCATIONS.LIST>",
  ].join("");
}

function normalizeBillAllocationType(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "advance") return "Advance";
  if (normalized === "new ref" || normalized === "newref") return "New Ref";
  return "Agst Ref";
}

function buildBillAllocationsXml({ allocations, isDebit }) {
  if (!Array.isArray(allocations) || allocations.length === 0) return "";
  return allocations
    .map((allocation) => {
      const referenceName = String(allocation?.referenceName || "").trim();
      const amount = Number(allocation?.amount);
      if (!referenceName || !Number.isFinite(amount) || amount <= 0) return "";
      const signedAmount = isDebit ? `-${amount.toFixed(2)}` : amount.toFixed(2);
      const billDate = allocation?.billDate
        ? toIsoLikeDate(allocation.billDate)
        : "";
      return [
        "<BILLALLOCATIONS.LIST>",
        `<NAME>${escapeXml(referenceName)}</NAME>`,
        `<BILLTYPE>${normalizeBillAllocationType(allocation?.referenceType)}</BILLTYPE>`,
        billDate ? `<BILLDATE>${billDate}</BILLDATE>` : "",
        `<AMOUNT>${signedAmount}</AMOUNT>`,
        "</BILLALLOCATIONS.LIST>",
      ].join("");
    })
    .join("");
}

function buildLedgerEntryXml({
  ledgerName,
  amount,
  isDebit,
  isPartyLedger = false,
  invoiceRate = null,
  bankAllocation = null,
  billAllocations = null,
  listTag = "ALLLEDGERENTRIES.LIST",
  // Invoice-form side, when it differs from the Dr/Cr of AMOUNT. On a Purchase
  // invoice every line below the items belongs to the item (Dr) side; a
  // deduction is a negative addition there (Yes + credit amount), which is how
  // Tally stores "-418" typed on the invoice. AMOUNT alone decides the books.
  deemedPositive = null,
}) {
  const signedAmount = isDebit ? `-${amount}` : amount;
  const deemed = deemedPositive === null ? isDebit : deemedPositive;
  const numericInvoiceRate = Number(invoiceRate);
  const invoiceRateXml = Number.isFinite(numericInvoiceRate) && numericInvoiceRate !== 0
    ? [
        '<BASICRATEOFINVOICETAX.LIST TYPE="Number">',
        `<BASICRATEOFINVOICETAX>${(-Math.abs(numericInvoiceRate)).toFixed(2)}</BASICRATEOFINVOICETAX>`,
        "</BASICRATEOFINVOICETAX.LIST>",
        "<ROUNDTYPE/>",
      ].join("")
    : "";
  return [
    `<${listTag}>`,
    invoiceRateXml,
    `<LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>`,
    `<ISPARTYLEDGER>${isPartyLedger ? "Yes" : "No"}</ISPARTYLEDGER>`,
    "<REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>",
    `<ISDEEMEDPOSITIVE>${deemed ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `<AMOUNT>${signedAmount}</AMOUNT>`,
    billAllocations || "",
    bankAllocation || "",
    `</${listTag}>`,
  ].join("");
}

function buildVoucherMessageXml({
  voucherDate,
  voucherType,
  referenceNumber,
  narration,
  entries,
  partyLedgerName = null,
}) {
  const escapedReferenceNumber = escapeXml(referenceNumber);
  const voucherReferenceBlock = referenceNumber
    ? [
        `<VOUCHERNUMBER>${escapedReferenceNumber}</VOUCHERNUMBER>`,
        `<REFERENCE>${escapedReferenceNumber}</REFERENCE>`,
      ].join("")
    : "";
  const partyLedgerBlock = partyLedgerName
    ? `<PARTYLEDGERNAME>${escapeXml(partyLedgerName)}</PARTYLEDGERNAME>`
    : "";

  return [
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    `<VOUCHER VCHTYPE="${escapeXml(voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    `<DATE>${voucherDate}</DATE>`,
    `<EFFECTIVEDATE>${voucherDate}</EFFECTIVEDATE>`,
    `<VOUCHERTYPENAME>${escapeXml(voucherType)}</VOUCHERTYPENAME>`,
    voucherReferenceBlock,
    `<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>`,
    "<ISINVOICE>No</ISINVOICE>",
    "<ISOPTIONAL>No</ISOPTIONAL>",
    "<DIFFACTUALQTY>No</DIFFACTUALQTY>",
    "<FORJOBCOSTING>No</FORJOBCOSTING>",
    partyLedgerBlock,
    `<NARRATION>${escapeXml(narration)}</NARRATION>`,
    ...entries,
    "</VOUCHER>",
    "</TALLYMESSAGE>",
  ].join("");
}

function buildCustomerAdvanceAdjustmentXml(payload, fallbackCompanyName) {
  const companyName = payload?.companyName || fallbackCompanyName;
  const voucherDate = toIsoLikeDate(payload?.voucherDate);
  const ledgerName = String(payload?.ledgerName || "").trim();
  const referenceNumber = String(payload?.referenceNumber || "").trim();
  const narration = String(payload?.narration || `Adjust customer advance ${referenceNumber}`).trim();
  const adjustments = Array.isArray(payload?.adjustments) ? payload.adjustments : [];

  if (!ledgerName) {
    throw new Error("Customer advance adjustment requires ledgerName.");
  }

  const normalizedAdjustments = adjustments.flatMap((adjustment) => {
    const advanceReferenceName = String(adjustment?.advanceReferenceName || "").trim();
    const billReferenceName = String(adjustment?.billReferenceName || "").trim();
    const amount = Number(adjustment?.amount);
    if (!advanceReferenceName || !billReferenceName || !Number.isFinite(amount) || amount <= 0) return [];
    return [{ advanceReferenceName, billReferenceName, amount: amount.toFixed(2) }];
  });

  if (normalizedAdjustments.length === 0) {
    throw new Error("Customer advance adjustment requires at least one valid adjustment line.");
  }

  const totalAmount = normalizedAdjustments
    .reduce((sum, adjustment) => sum + Number(adjustment.amount), 0)
    .toFixed(2);
  const advanceBillAllocations = normalizedAdjustments
    .map((adjustment) =>
      buildBillAllocationsXml({
        allocations: [
          {
            referenceType: "Advance",
            referenceName: adjustment.advanceReferenceName,
            amount: adjustment.amount,
          },
        ],
        isDebit: true,
      })
    )
    .join("");
  const billAllocations = normalizedAdjustments
    .map((adjustment) =>
      buildBillAllocationsXml({
        allocations: [
          {
            referenceType: "Agst Ref",
            referenceName: adjustment.billReferenceName,
            amount: adjustment.amount,
          },
        ],
        isDebit: false,
      })
    )
    .join("");

  const message = buildVoucherMessageXml({
    voucherDate,
    voucherType: "Journal",
    referenceNumber,
    narration,
    partyLedgerName: ledgerName,
    entries: [
      buildLedgerEntryXml({
        ledgerName,
        amount: totalAmount,
        isDebit: true,
        isPartyLedger: true,
        billAllocations: advanceBillAllocations,
      }),
      buildLedgerEntryXml({
        ledgerName,
        amount: totalAmount,
        isDebit: false,
        isPartyLedger: true,
        billAllocations,
      }),
    ],
  });

  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    messages: [message],
  });
}

function wrapVoucherMessagesXml({
  companyName,
  voucherDate,
  messages,
  legacyHeader = false,
  legacyEnvelope = false,
}) {
  const staticVariables = [
    companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : "",
    `<SVFROMDATE>${voucherDate}</SVFROMDATE>`,
    `<SVTODATE>${voucherDate}</SVTODATE>`,
    `<SVCURRENTDATE>${voucherDate}</SVCURRENTDATE>`,
  ].filter(Boolean);
  if (legacyEnvelope) {
    return [
      "<ENVELOPE>",
      "<HEADER>",
      "<VERSION>1</VERSION>",
      "<TALLYREQUEST>Import</TALLYREQUEST>",
      "<TYPE>Data</TYPE>",
      "<ID>Vouchers</ID>",
      "</HEADER>",
      "<BODY>",
      "<DESC>",
      "<STATICVARIABLES>",
      ...staticVariables,
      "</STATICVARIABLES>",
      "</DESC>",
      "<DATA>",
      ...messages,
      "</DATA>",
      "</BODY>",
      "</ENVELOPE>",
    ].join("");
  }
  const header = legacyHeader
    ? [
        "<HEADER>",
        "<VERSION>1</VERSION>",
        "<TALLYREQUEST>Import Data</TALLYREQUEST>",
        "<TYPE>Data</TYPE>",
        "<ID>Vouchers</ID>",
        "</HEADER>",
      ]
    : [
        "<HEADER>",
        "<TALLYREQUEST>Import Data</TALLYREQUEST>",
        "</HEADER>",
      ];

  return [
    "<ENVELOPE>",
    ...header,
    "<BODY>",
    "<IMPORTDATA>",
    "<REQUESTDESC>",
    "<REPORTNAME>Vouchers</REPORTNAME>",
    "<STATICVARIABLES>",
    ...staticVariables,
    "</STATICVARIABLES>",
    "</REQUESTDESC>",
    "<REQUESTDATA>",
    ...messages,
    "</REQUESTDATA>",
    "</IMPORTDATA>",
    "</BODY>",
    "</ENVELOPE>",
  ].join("");
}

export function buildBankVoucherXml(payload, fallbackCompanyName, options = {}) {
  const companyName = payload?.companyName || fallbackCompanyName;
  const voucherType = payload?.voucherType || "Payment";
  const voucherDate = toIsoLikeDate(payload?.voucherDate);
  const bankLedgerName = String(payload?.bankLedgerName || "").trim();
  const counterpartyLedgerName = String(payload?.counterpartyLedgerName || "").trim();
  const counterpartyIsPartyLedger = payload?.counterpartyIsPartyLedger === true;
  const bankLedgerEntryIsDebit = payload?.bankLedgerEntryIsDebit === true;
  const amount = toMoney(payload?.amount);
  const narration = String(payload?.narration || payload?.description || "").trim();
  const referenceNumber = String(payload?.referenceNumber || payload?.transactionId || "").trim();
  const billAllocations = Array.isArray(payload?.billAllocations) ? payload.billAllocations : [];

  if (!bankLedgerName || !counterpartyLedgerName) {
    throw new Error("Bank voucher command requires bank and counterparty ledgers.");
  }

  const partyLedgerName = counterpartyIsPartyLedger ? counterpartyLedgerName : bankLedgerName;
  const bankAllocation =
    voucherType !== "Journal" && options.includeBankAllocation === true
      ? buildBankAllocationXml({
          voucherDate,
          referenceNumber,
          amount,
          isDebit: bankLedgerEntryIsDebit,
        })
      : null;

  const entries =
    voucherType === "Journal"
      ? bankLedgerEntryIsDebit
        ? [
            buildLedgerEntryXml({ ledgerName: bankLedgerName, amount, isDebit: true }),
            buildLedgerEntryXml({ ledgerName: counterpartyLedgerName, amount, isDebit: false }),
          ]
        : [
            buildLedgerEntryXml({ ledgerName: counterpartyLedgerName, amount, isDebit: true }),
            buildLedgerEntryXml({ ledgerName: bankLedgerName, amount, isDebit: false }),
          ]
      : voucherType === "Receipt"
      ? [
          buildLedgerEntryXml({
            ledgerName: counterpartyLedgerName,
            amount,
            isDebit: false,
            isPartyLedger: counterpartyIsPartyLedger,
            billAllocations: buildBillAllocationsXml({ allocations: billAllocations, isDebit: false }),
          }),
          buildLedgerEntryXml({
            ledgerName: bankLedgerName,
            amount,
            isDebit: true,
            bankAllocation,
          }),
        ]
      : voucherType === "Contra"
        ? bankLedgerEntryIsDebit
          ? [
              buildLedgerEntryXml({
                ledgerName: bankLedgerName,
                amount,
                isDebit: true,
                bankAllocation,
              }),
              buildLedgerEntryXml({ ledgerName: counterpartyLedgerName, amount, isDebit: false }),
            ]
          : [
              buildLedgerEntryXml({ ledgerName: counterpartyLedgerName, amount, isDebit: true }),
              buildLedgerEntryXml({
                ledgerName: bankLedgerName,
                amount,
                isDebit: false,
                bankAllocation,
              }),
            ]
        : [
            buildLedgerEntryXml({
              ledgerName: counterpartyLedgerName,
              amount,
              isDebit: true,
              isPartyLedger: counterpartyIsPartyLedger,
              billAllocations: buildBillAllocationsXml({ allocations: billAllocations, isDebit: true }),
            }),
            buildLedgerEntryXml({
              ledgerName: bankLedgerName,
              amount,
              isDebit: false,
              bankAllocation,
            }),
          ];

  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    legacyHeader: options.legacyHeader === true,
    messages: [
      buildVoucherMessageXml({
        voucherDate,
        voucherType,
        referenceNumber,
        narration,
        entries,
        partyLedgerName: voucherType === "Journal" ? null : partyLedgerName,
      }),
    ],
  });
}

export function buildBankVoucherBatchXml(payloads, fallbackCompanyName) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new Error("Bank voucher batch requires at least one voucher.");
  }

  const companyName = payloads[0]?.companyName || fallbackCompanyName;
  const voucherDate = toIsoLikeDate(payloads[0]?.voucherDate);
  const messages = payloads.map((payload) => {
    const voucherXml = buildBankVoucherXml(payload, companyName);
    const message = voucherXml.match(/<TALLYMESSAGE\b[\s\S]*?<\/TALLYMESSAGE>/i)?.[0];
    if (!message) {
      throw new Error("Could not build a Tally message for a bank voucher batch.");
    }
    return message;
  });

  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    messages,
    legacyEnvelope: true,
  });
}

export function explainBankVoucherTallyError(outcome, payload) {
  return explainVoucherTallyError(outcome, payload);
}

export function isStrongBankReference(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.length >= 8 && /[a-z]/.test(normalized) && /\d/.test(normalized);
}

export function baseBankTransactionCandidates(vouchers, transaction, bankLedgerName, reservedVoucherIndexes = new Set(), byDate = null) {
  const voucherDate = typeof normalizeDateForCompare === "function" ? normalizeDateForCompare(transaction.voucherDate) : String(transaction.voucherDate || "").trim();
  const amount = Number(transaction.amount || 0);
  const entries = byDate ? byDate.get(voucherDate) || [] : vouchers.map((voucher, index) => ({ voucher, index }));
  return entries.flatMap(({ voucher, index }) => {
    if (reservedVoucherIndexes.has(index)) return [];
    const date = typeof normalizeDateForCompare === "function" ? normalizeDateForCompare(voucher.effectiveDate || voucher.date) : String(voucher.effectiveDate || voucher.date || "").trim();
    if (!voucherDate || date !== voucherDate) return [];
    const bankEntry = getBankLedgerEntry(voucher, bankLedgerName, amount, transaction.expectedDirection);
    if (!voucherDate || date !== voucherDate || !bankEntry) return [];
    return [{ voucher, index, bankEntry }];
  });
}

function toSignedMoney(value, label, options = {}) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(parsed) || (!options.allowZero && parsed === 0)) {
    throw new Error(`Purchase voucher command requires ${label}.`);
  }
  if (!options.allowNegative && parsed < 0) {
    throw new Error(`Purchase voucher ${label} cannot be negative.`);
  }
  return parsed;
}

function buildPurchaseInventoryEntryXml(item) {
  const stockItemName = String(item?.stockItemName || "").trim();
  const purchaseLedgerName = String(item?.purchaseLedgerName || "").trim();
  const description = String(item?.description || "").trim();
  const hsn = String(item?.hsn || "").replace(/\D/g, "").slice(0, 8);
  const unit = String(item?.unit || "").trim();
  const quantity = toSignedMoney(item?.quantity, "a positive item quantity");
  const rate = toSignedMoney(item?.rate, "a positive item rate");
  const amount = toSignedMoney(item?.taxableAmount, "a positive item taxable amount");

  if (!stockItemName || !purchaseLedgerName || !unit || !hsn) {
    throw new Error("Purchase voucher items require stock item, purchase ledger, unit, and full HSN values.");
  }

  // Keep the approved decimal representation. Converting back through Number
  // and toFixed(2) silently changed valid Tally rates such as 23100.1250.
  const quantityText = String(item?.quantity ?? "").replace(/,/g, "").trim();
  const rateText = String(item?.rate ?? "").replace(/,/g, "").trim();
  const formattedQuantity = `${quantityText} ${unit}`;
  const formattedRate = `${rateText}/${unit}`;
  const formattedAmount = amount.toFixed(2);
  // A godown is optional in Kalika. Never invent Tally's conventional
  // "Main Location" name: companies may rename or remove it, and an implicit
  // allocation would then make an otherwise valid voucher fail at import.
  const godownName = String(item?.godownName || "").trim();
  const batchName = String(item?.batchName || "").trim();
  // Emit a batch allocation only when the reviewer selected a real godown.
  // When present, Tally still needs its implicit "Primary Batch" bucket for
  // stock items that do not use an explicitly named batch.
  const batchAllocation = godownName
    ? [
        "<BATCHALLOCATIONS.LIST>",
        `<GODOWNNAME>${escapeXml(godownName)}</GODOWNNAME>`,
        `<BATCHNAME>${escapeXml(batchName || "Primary Batch")}</BATCHNAME>`,
        `<DESTINATIONGODOWNNAME>${escapeXml(godownName)}</DESTINATIONGODOWNNAME>`,
        `<AMOUNT>-${formattedAmount}</AMOUNT>`,
        `<ACTUALQTY>${escapeXml(formattedQuantity)}</ACTUALQTY>`,
        `<BILLEDQTY>${escapeXml(formattedQuantity)}</BILLEDQTY>`,
        "</BATCHALLOCATIONS.LIST>",
      ].join("")
    : "";

  return [
    "<ALLINVENTORYENTRIES.LIST>",
    `<STOCKITEMNAME>${escapeXml(stockItemName)}</STOCKITEMNAME>`,
    description ? `<DESCRIPTION>${escapeXml(description)}</DESCRIPTION>` : "",
    "<GSTHSNINFERAPPLICABILITY>Specify Details Here</GSTHSNINFERAPPLICABILITY>",
    `<GSTHSNNAME>${escapeXml(hsn)}</GSTHSNNAME>`,
    description ? `<GSTHSNDESCRIPTION>${escapeXml(description)}</GSTHSNDESCRIPTION>` : "",
    "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>",
    `<RATE>${formattedRate}</RATE>`,
    `<AMOUNT>-${formattedAmount}</AMOUNT>`,
    `<ACTUALQTY>${escapeXml(formattedQuantity)}</ACTUALQTY>`,
    `<BILLEDQTY>${escapeXml(formattedQuantity)}</BILLEDQTY>`,
    batchAllocation,
    "<ACCOUNTINGALLOCATIONS.LIST>",
    `<LEDGERNAME>${escapeXml(purchaseLedgerName)}</LEDGERNAME>`,
    "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>",
    `<AMOUNT>-${formattedAmount}</AMOUNT>`,
    "</ACCOUNTINGALLOCATIONS.LIST>",
    "</ALLINVENTORYENTRIES.LIST>",
  ].join("");
}

function buildPurchaseDocumentUdfXml(payload) {
  const documentValues = [
    [PURCHASE_DOCUMENT_UDFS.path, payload?.sourceDocumentPath],
    [PURCHASE_DOCUMENT_UDFS.name, payload?.sourceDocumentName],
    [PURCHASE_DOCUMENT_UDFS.sha256, payload?.sourceDocumentSha256],
    [PURCHASE_DOCUMENT_UDFS.id, payload?.sourceDocumentId],
  ];

  const hasDocument = documentValues.some(([, value]) => String(value || "").trim());
  if (hasDocument && documentValues.some(([, value]) => !String(value || "").trim())) {
    throw new Error("Purchase source document metadata is incomplete.");
  }
  const values = [
    ...(hasDocument ? documentValues : []),
    ...(String(payload?.vehicleNumber || "").trim()
      ? [[PURCHASE_DOCUMENT_UDFS.vehicle, payload.vehicleNumber]]
      : []),
  ];
  if (values.length === 0) return "";

  return values.map(([definition, value]) => {
    const tag = definition.name.toUpperCase();
    return [
      `<UDF:${tag}.LIST DESC="'${definition.name}'" ISLIST="YES" TYPE="String" INDEX="${definition.index}">`,
      `<UDF:${tag} DESC="'${definition.name}'">${escapeXml(String(value).trim())}</UDF:${tag}>`,
      `</UDF:${tag}.LIST>`,
    ].join("");
  }).join("") + buildAttachDocumentsAddOnXml(payload);
}

// The client's "Attach Documents" add-on (as exported from their Tally):
// UdfForSaveDocAttachSave (2200, Logical) is the "Attach Documents ? Yes"
// switch, and DocAttachDetail (21000) holds the file path, file name and
// folder. Written only when the PDF was saved to the configured shared folder,
// so their own add-on shows and opens it.
const ATTACH_DOCUMENTS_ADDON = {
  detail: { name: "DocAttachDetail", index: 21000 },
  filePath: { name: "UDFForLinkDocumentFile", index: 2697 },
  fileName: { name: "DocAttachName", index: 21001 },
  folder: { name: "UDFVCHTypeLocation", index: 26552 },
  folderSetPath: { name: "UDFVCHLoctionSetPath", index: 26554 },
  attach: { name: "UdfForSaveDocAttachSave", index: 2200 },
};

function buildAttachDocumentsAddOnXml(payload) {
  const filePath = String(payload?.sourceDocumentPath || "").trim();
  if (!filePath || !String(payload?.sourceDocumentFolder || "").trim()) return "";
  const fileName = String(payload?.sourceDocumentName || path.win32.basename(filePath)).trim();
  const folder = `${path.win32.dirname(filePath).replace(/\\+$/, "")}\\`;
  const udf = (definition, type, value) => {
    const tag = definition.name.toUpperCase();
    return `<UDF:${tag}.LIST DESC="\`${definition.name}\`" ISLIST="YES" TYPE="${type}" INDEX="${definition.index}">` +
      `<UDF:${tag} DESC="\`${definition.name}\`">${escapeXml(value)}</UDF:${tag}></UDF:${tag}.LIST>`;
  };
  const detailTag = ATTACH_DOCUMENTS_ADDON.detail.name.toUpperCase();
  return `<UDF:${detailTag}.LIST DESC="\`${ATTACH_DOCUMENTS_ADDON.detail.name}\`" INDEX="${ATTACH_DOCUMENTS_ADDON.detail.index}">` +
    udf(ATTACH_DOCUMENTS_ADDON.filePath, "String", filePath) +
    udf(ATTACH_DOCUMENTS_ADDON.fileName, "String", fileName) +
    udf(ATTACH_DOCUMENTS_ADDON.folder, "String", folder) +
    udf(ATTACH_DOCUMENTS_ADDON.folderSetPath, "String", folder) +
    `</UDF:${detailTag}.LIST>` +
    udf(ATTACH_DOCUMENTS_ADDON.attach, "Logical", "Yes");
}

// The supplier's e-way bill, recorded on the purchase as reference exactly as
// the client books it (their exported voucher): details filled in, but Tally's
// e-way bill applicability left at No, since the supplier generated it.
// The consignee (To) is the company's own address, read from Tally.
function buildPurchaseEwayBillXml(ewayBill) {
  const number = String(ewayBill?.number || "").replace(/\D/g, "");
  const date = /^\d{4}-\d{2}-\d{2}/.test(String(ewayBill?.date || "")) ? toIsoLikeDate(ewayBill.date) : "";
  if (!/^\d{12}$/.test(number) || !date) return "";
  const value = (input) => escapeXml(String(input ?? "").trim());
  const consignee = ewayBill.consignee || {};
  const toAddress = consignee.address || "";
  const toPlace = consignee.place || ewayBill.toPlace || "";
  const toPincode = consignee.pincode || ewayBill.toPincode || "";
  const toState = consignee.state || ewayBill.toState || "";
  const distance = /^\d{1,4}$/.test(String(ewayBill.distanceKm || "")) ? ` ${ewayBill.distanceKm}` : "";
  return [
    "<ISEWAYBILLAPPLICABLE>No</ISEWAYBILLAPPLICABLE>",
    "<OVRDNEWAYBILLAPPLICABILITY>No</OVRDNEWAYBILLAPPLICABILITY>",
    "<EWAYBILLDETAILS.LIST>",
    ewayBill.fromAddress ? `<CONSIGNORADDRESS.LIST TYPE="String"><CONSIGNORADDRESS>${value(ewayBill.fromAddress)}</CONSIGNORADDRESS></CONSIGNORADDRESS.LIST>` : "",
    toAddress ? `<CONSIGNEEADDRESS.LIST TYPE="String"><CONSIGNEEADDRESS>${value(toAddress)}</CONSIGNEEADDRESS></CONSIGNEEADDRESS.LIST>` : "",
    `<BILLDATE>${date}</BILLDATE>`,
    "<DOCUMENTTYPE>Tax Invoice</DOCUMENTTYPE>",
    toPincode ? `<CONSIGNEEPINCODE>${value(toPincode)}</CONSIGNEEPINCODE>` : "",
    `<BILLNUMBER>${number}</BILLNUMBER>`,
    "<SUBTYPE>Supply</SUBTYPE>",
    ewayBill.fromPlace ? `<CONSIGNORPLACE>${value(ewayBill.fromPlace)}</CONSIGNORPLACE>` : "",
    ewayBill.fromPincode ? `<CONSIGNORPINCODE>${value(ewayBill.fromPincode)}</CONSIGNORPINCODE>` : "",
    toPlace ? `<CONSIGNEEPLACE>${value(toPlace)}</CONSIGNEEPLACE>` : "",
    ewayBill.fromState ? `<SHIPPEDFROMSTATE>${value(ewayBill.fromState)}</SHIPPEDFROMSTATE>` : "",
    toState ? `<SHIPPEDTOSTATE>${value(toState)}</SHIPPEDTOSTATE>` : "",
    "<TRANSPORTDETAILS.LIST>",
    `<TRANSPORTMODE>${value(ewayBill.transportMode || "1 - Road")}</TRANSPORTMODE>`,
    ewayBill.vehicleNumber ? `<VEHICLENUMBER>${value(ewayBill.vehicleNumber)}</VEHICLENUMBER>` : "",
    distance ? `<DISTANCE>${distance}</DISTANCE>` : "",
    "</TRANSPORTDETAILS.LIST>",
    "</EWAYBILLDETAILS.LIST>",
  ].join("");
}

// The company's own mailing address from Tally, for the e-way bill consignee.
const companyAddressCache = new Map();
async function readCompanyAddress(tallyUrl, companyName) {
  const key = String(companyName || "").trim().toLowerCase();
  if (companyAddressCache.has(key)) return companyAddressCache.get(key);
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Company Address",
    tallyType: "Company",
    fetchFields: "Name,Address,PinCode,StateName",
    companyName: null,
    timeoutMs: 8_000,
  });
  const block = extractBlocks(xml, "COMPANY").find((candidate) =>
    String(getTagText(candidate, "NAME") || getAttribute(candidate, "NAME") || "").trim().toLowerCase() === key
  );
  // Exact <ADDRESS> lines only (not the enclosing <ADDRESS.LIST>).
  const address = block
    ? [...block.matchAll(/<ADDRESS(?:\s[^>]*)?>([\s\S]*?)<\/ADDRESS>/gi)]
        .map((match) => cleanXmlText(match[1]).trim()).filter(Boolean).join(", ")
    : "";
  const result = block ? {
    address,
    pincode: getTagText(block, "PINCODE") || "",
    state: getTagText(block, "STATENAME") || "",
  } : null;
  companyAddressCache.set(key, result);
  return result;
}

function buildPurchaseVoucherXml(payload, fallbackCompanyName) {
  const companyName = String(payload?.companyName || fallbackCompanyName || "").trim();
  const voucherDate = toIsoLikeDate(payload?.voucherDate || payload?.supplierInvoiceDate);
  const supplierInvoiceDate = toIsoLikeDate(payload?.supplierInvoiceDate);
  const supplierInvoiceNumber = String(payload?.supplierInvoiceNumber || "").trim();
  // Tally owns numbering for the standard automatically-numbered Purchase
  // voucher type. Only emit VOUCHERNUMBER when a caller deliberately opts into
  // a manual/custom-number voucher type; never fall back to the supplier bill
  // number, which belongs in REFERENCE and BILLALLOCATIONS.
  const requestedVoucherNumber = payload?.useCustomVoucherNumber === true
    ? String(payload?.voucherNumber || "").trim()
    : "";
  const supplierLedgerName = String(payload?.supplierLedgerName || "").trim();
  const baseNarration = String(payload?.narration || "").trim();
  const vehicleNumber = String(payload?.vehicleNumber || "").trim();
  const narrationHasVehicle = vehicleNumber &&
    baseNarration.replace(/[^a-z0-9]/gi, "").toLowerCase().includes(
      vehicleNumber.replace(/[^a-z0-9]/gi, "").toLowerCase()
    );
  const narration = [
    baseNarration,
    vehicleNumber && !narrationHasVehicle ? `Vehicle: ${vehicleNumber}` : "",
    payload?.sourceReferenceFallback && payload?.sourceDocumentReference
      ? `Source: ${String(payload.sourceDocumentReference).trim()}`
      : "",
  ].filter(Boolean).join(" | ");
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const charges = Array.isArray(payload?.charges) ? payload.charges : [];
  const withholdings = Array.isArray(payload?.withholdings) ? payload.withholdings : [];
  const ledgers = payload?.ledgers && typeof payload.ledgers === "object" ? payload.ledgers : {};
  const finalPayable = toSignedMoney(payload?.finalPayableAmount, "a positive final payable amount");

  if (!companyName || !supplierInvoiceNumber || !supplierLedgerName || items.length === 0) {
    throw new Error("Purchase voucher command requires company, supplier invoice, supplier ledger, and item lines.");
  }

  const inventoryEntries = items.map(buildPurchaseInventoryEntryXml);
  const ledgerEntries = [];
  const debitCharges = charges.length > 0
    ? charges
    : ["cgst", "sgst", "igst", "tcs"].map((key) => ledgers[key]).filter(Boolean);
  const deductionEntries = withholdings.length > 0
    ? withholdings
    : ledgers.tds ? [ledgers.tds] : [];
  if (Number(payload?.canonicalVersion || 0) >= 2) {
    const itemTotal = items.reduce((sum, item) => sum + toSignedMoney(item?.taxableAmount, "a positive item taxable amount"), 0);
    const chargeTotal = debitCharges.reduce((sum, entry) => sum + Math.abs(toSignedMoney(entry?.amount, "purchase charge amount", { allowZero: true, allowNegative: true })), 0);
    const deductionTotal = deductionEntries.reduce((sum, entry) => sum + Math.abs(toSignedMoney(entry?.amount, "withholding amount", { allowZero: true, allowNegative: true })), 0);
    const roundAmount = ledgers.roundOff
      ? toSignedMoney(ledgers.roundOff.amount, "round-off amount", { allowZero: true, allowNegative: true })
      : 0;
    const balancedPayable = itemTotal + chargeTotal - deductionTotal + roundAmount;
    if (Math.abs(balancedPayable - finalPayable) > 0.009) {
      throw new Error(`Approved Purchase voucher is not balanced. Allocations total ${balancedPayable.toFixed(2)}, but supplier payable is ${finalPayable.toFixed(2)}.`);
    }
  }
  const supplierIdentity = normalizeLooseName(supplierLedgerName);
  const conflictingSupplierRoles = [
    ...items.map((item) => ({ role: "purchase ledger", name: item?.purchaseLedgerName })),
    ...debitCharges.map((entry) => ({ role: "charge or tax ledger", name: entry?.name })),
    ...deductionEntries.map((entry) => ({ role: "withholding ledger", name: entry?.name })),
    ...(ledgers.roundOff ? [{ role: "round-off ledger", name: ledgers.roundOff.name }] : []),
  ].filter(
    (entry) => entry.name && normalizeLooseName(entry.name) === supplierIdentity
  );
  if (conflictingSupplierRoles.length > 0) {
    const roles = Array.from(new Set(conflictingSupplierRoles.map((entry) => entry.role)));
    throw new Error(
      `${supplierLedgerName} is selected as both the supplier and ${roles.join(" / ")}. ` +
      "Choose a separate Purchase, tax, deduction, or round-off ledger before posting."
    );
  }

  for (const ledger of debitCharges) {
    if (!ledger) continue;
    const name = String(ledger.name || "").trim();
    const amount = toSignedMoney(ledger.amount, "purchase charge amount", { allowZero: true });
    if (!name || amount === 0) continue;
    ledgerEntries.push(buildLedgerEntryXml({
      ledgerName: name,
      amount: Math.abs(amount).toFixed(2),
      isDebit: amount > 0,
      listTag: "LEDGERENTRIES.LIST",
    }));
  }

  for (const deduction of deductionEntries) {
    const name = String(deduction?.name || "").trim();
    const amount = toSignedMoney(deduction?.amount, "withholding amount", { allowZero: true });
    if (name && amount > 0) {
      ledgerEntries.push(buildLedgerEntryXml({
        ledgerName: name,
        amount: amount.toFixed(2),
        isDebit: false,
        // Item side on the invoice, so Tally subtracts it from the bill total.
        deemedPositive: true,
        invoiceRate: deduction?.rate,
        listTag: "LEDGERENTRIES.LIST",
      }));
    }
  }

  // Match the review preview: item lines, GST/charges, deductions and
  // round-off. The supplier party entry is emitted separately and first.
  const roundOff = ledgers.roundOff;
  if (roundOff) {
    const name = String(roundOff.name || "").trim();
    const amount = toSignedMoney(roundOff.amount, "round-off amount", {
      allowZero: true,
      allowNegative: true,
    });
    if (name && amount !== 0) {
      ledgerEntries.push(buildLedgerEntryXml({
        ledgerName: name,
        amount: Math.abs(amount).toFixed(2),
        isDebit: amount > 0,
        // A negative round-off reduces the bill: keep it on the item side too.
        deemedPositive: true,
        listTag: "LEDGERENTRIES.LIST",
      }));
    }
  }

  const supplierLedgerEntry = buildLedgerEntryXml({
    ledgerName: supplierLedgerName,
    amount: finalPayable.toFixed(2),
    isDebit: false,
    isPartyLedger: true,
    listTag: "LEDGERENTRIES.LIST",
    billAllocations: buildBillAllocationsXml({
      allocations: [{
        referenceType: "New Ref",
        referenceName: supplierInvoiceNumber,
        // Tally tracks a New Ref from the voucher date. The supplier's own
        // invoice date remains independently preserved in REFERENCE DATE.
        billDate: voucherDate,
        amount: finalPayable,
      }],
      isDebit: false,
    }),
  });

  const message = [
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    '<VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">',
    `<DATE>${voucherDate}</DATE>`,
    `<EFFECTIVEDATE>${voucherDate}</EFFECTIVEDATE>`,
    "<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>",
    requestedVoucherNumber
      ? `<VOUCHERNUMBER>${escapeXml(requestedVoucherNumber)}</VOUCHERNUMBER>`
      : "",
    `<REFERENCE>${escapeXml(supplierInvoiceNumber)}</REFERENCE>`,
    `<REFERENCEDATE>${supplierInvoiceDate}</REFERENCEDATE>`,
    `<PARTYLEDGERNAME>${escapeXml(supplierLedgerName)}</PARTYLEDGERNAME>`,
    `<BASICBASEPARTYNAME>${escapeXml(supplierLedgerName)}</BASICBASEPARTYNAME>`,
    "<PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>",
    "<VCHENTRYMODE>Item Invoice</VCHENTRYMODE>",
    "<ISINVOICE>Yes</ISINVOICE>",
    "<ISOPTIONAL>No</ISOPTIONAL>",
    "<DIFFACTUALQTY>No</DIFFACTUALQTY>",
    `<NARRATION>${escapeXml(narration)}</NARRATION>`,
    buildPurchaseEwayBillXml(payload?.ewayBill),
    // Tally's canonical Invoice Voucher XML puts the party allocation before
    // inventory and charge rows. PARTYLEDGERNAME alone is not enough because
    // bill allocations belong to this entry. Keeping it first lets Tally bind
    // it to the Party A/c header instead of rendering it as an extra line at
    // the bottom of the Item Invoice form.
    supplierLedgerEntry,
    ...inventoryEntries,
    ...ledgerEntries,
    buildPurchaseDocumentUdfXml(payload),
    "</VOUCHER>",
    "</TALLYMESSAGE>",
  ].join("");

  return wrapVoucherMessagesXml({
    companyName,
    voucherDate,
    messages: [message],
    legacyEnvelope: true,
  });
}

function removeTags(xml, tagNames) {
  return tagNames.reduce(
    (nextXml, tagName) =>
      nextXml.replace(new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi"), ""),
    xml
  );
}

function setAllPartyLedgerFlagsNo(xml) {
  return xml.replace(/<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>/gi, "<ISPARTYLEDGER>No</ISPARTYLEDGER>");
}

function withoutVoucherPresentationHints(xml) {
  return removeTags(xml.replace(/\sOBJVIEW="[^"]*"/gi, ""), ["PERSISTEDVIEW"]);
}

function withoutAccountingBooleans(xml) {
  return removeTags(xml, ["ISINVOICE", "ISOPTIONAL", "DIFFACTUALQTY", "FORJOBCOSTING"]);
}

function withVoucherDateAttribute(xml, voucherDate) {
  return xml.replace(/<VOUCHER\b(?![^>]*\bDATE=)/i, `<VOUCHER DATE="${voucherDate}"`);
}

function withVoucherNameAttribute(xml, referenceNumber) {
  const escapedReferenceNumber = escapeXml(referenceNumber);
  if (!escapedReferenceNumber) return xml;
  return xml.replace(/<VOUCHER\b(?![^>]*\bNAME=)/i, `<VOUCHER NAME="${escapedReferenceNumber}"`);
}

function buildBankVoucherDiagnosticVariants(payload, fallbackCompanyName) {
  const voucherDate = toIsoLikeDate(payload?.voucherDate);
  const referenceNumber = String(payload?.referenceNumber || payload?.transactionId || "").trim();
  const current = buildBankVoucherXml(payload, fallbackCompanyName);
  const noPartyLedgerMarkers = setAllPartyLedgerFlagsNo(removeTags(current, ["PARTYLEDGERNAME"]));
  const noPresentationHints = withoutVoucherPresentationHints(current);
  const minimalAccounting = withoutAccountingBooleans(
    withoutVoucherPresentationHints(noPartyLedgerMarkers)
  );

  return [
    {
      name: "current",
      description: "Current bridge XML.",
      xml: current,
    },
    {
      name: "with-voucher-date-attribute",
      description: "Current XML plus DATE on the VOUCHER attribute, matching the previous bridge attempt.",
      xml: withVoucherDateAttribute(current, voucherDate),
    },
    {
      name: "no-party-ledger-markers",
      description: "Removes PARTYLEDGERNAME and forces ISPARTYLEDGER=No on ledger entries.",
      xml: noPartyLedgerMarkers,
    },
    {
      name: "no-presentation-hints",
      description: "Removes OBJVIEW and PERSISTEDVIEW while keeping accounting/date fields.",
      xml: noPresentationHints,
    },
    {
      name: "minimal-accounting",
      description: "Keeps voucher date/type/reference/narration and ledger entries; removes view, party, and accounting boolean hints.",
      xml: minimalAccounting,
    },
    {
      name: "minimal-with-date-attribute",
      description: "Minimal accounting XML plus DATE on the VOUCHER attribute.",
      xml: withVoucherDateAttribute(minimalAccounting, voucherDate),
    },
    {
      name: "minimal-with-name-and-date-attributes",
      description: "Minimal accounting XML plus NAME and DATE on the VOUCHER attribute.",
      xml: withVoucherNameAttribute(withVoucherDateAttribute(minimalAccounting, voucherDate), referenceNumber),
    },
  ];
}

function getBankVoucherDiagnosticVariantXml(payload, fallbackCompanyName, variantName) {
  const variants = buildBankVoucherDiagnosticVariants(payload, fallbackCompanyName);
  const variant = variants.find((entry) => entry.name === variantName);
  if (!variant) {
    throw new Error(`Unknown variant "${variantName}". Available: ${variants.map((entry) => entry.name).join(", ")}`);
  }
  return variant.xml;
}

function parseExportResult(text, httpStatus) {
  const lineError = getTagText(text, "LINEERROR");
  const statusText = getTagText(text, "STATUS");

  return {
    success: httpStatus >= 200 && httpStatus < 300 && !lineError && statusText === "1",
    error: lineError,
    status: statusText,
    response: text,
  };
}

function extractCompanyName(xml) {
  const currentCompany = xml.match(/<CURRENTCOMPANY[^>]*>([^<]+)<\/CURRENTCOMPANY>/i)?.[1];
  if (currentCompany) {
    return cleanXmlText(currentCompany);
  }

  for (const companyBlock of extractBlocks(xml, "COMPANY")) {
    const name = getTagText(companyBlock, "NAME") || getAttribute(companyBlock, "NAME");
    if (name) {
      return name;
    }
  }

  return null;
}

function normalizeTallyDate(value) {
  const normalized = cleanXmlText(value);
  if (!normalized) return null;

  const compactMatch = normalized.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }

  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return normalized;

  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function financialYearFromStartDate(value) {
  const startDate = normalizeTallyDate(value);
  if (!startDate) return null;
  const year = Number(startDate.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

async function fetchAvailableCompanies(tallyUrl, activeCompanyName = null) {
  const companies = [];

  try {
    const xml = await exportTallyCollection(tallyUrl, {
      collectionName: "Autodealer Available Companies",
      tallyType: "Company",
      fetchFields: "Name,Guid,StartingFrom,BooksFrom,FinancialYearFrom,CurrentPeriod,AlterID,MasterID,PartyGSTIN,GSTIN,GSTRegistrationNumber,StateName,CountryName",
      companyName: null,
      timeoutMs: 8_000,
    });
    const seen = new Set();

    for (const companyBlock of extractBlocks(xml, "COMPANY")) {
      const name = getTagText(companyBlock, "NAME") || getAttribute(companyBlock, "NAME");
      const normalized = typeof name === "string" ? name.trim() : "";
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const financialYearStart =
        normalizeTallyDate(
          getTagText(companyBlock, "FINANCIALYEARFROM") ||
            getTagText(companyBlock, "STARTINGFROM")
        );
      companies.push({
        companyName: normalized,
        guid: getTagText(companyBlock, "GUID") || getAttribute(companyBlock, "GUID"),
        financialYear: financialYearFromStartDate(financialYearStart),
        financialYearStart,
        booksFrom: normalizeTallyDate(getTagText(companyBlock, "BOOKSFROM")),
        currentPeriod: getTagText(companyBlock, "CURRENTPERIOD"),
        gstin: getTagText(companyBlock, "PARTYGSTIN") || getTagText(companyBlock, "GSTIN") || getTagText(companyBlock, "GSTREGISTRATIONNUMBER") || null,
        stateName: getTagText(companyBlock, "STATENAME") || null,
        countryName: getTagText(companyBlock, "COUNTRYNAME") || null,
        isActive:
          Boolean(activeCompanyName) &&
          normalized.toLowerCase() === String(activeCompanyName).trim().toLowerCase(),
      });
    }
  } catch {
    // Tally's HTTP API returns an empty Company collection when no company is loaded.
  }

  return companies;
}

function mergeCompanyNames(values) {
  const seen = new Set();
  const names = [];

  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(normalized);
  }

  return names;
}

function tallyDataRoots() {
  return mergeCompanyNames([
    process.env.KALIKA_TALLY_DATA_ROOT,
    process.env.TALLY_DATA_ROOT,
    process.env.TALLY_DATA_PATH,
    DEFAULT_TALLY_DATA_ROOT,
  ]);
}

function readLocalTallyCompanyNames() {
  const names = [];

  for (const dataRoot of tallyDataRoots()) {
    try {
      if (!fs.existsSync(dataRoot)) continue;
      const entries = fs.readdirSync(dataRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const companyDir = path.join(dataRoot, entry.name);
        const companyName =
          readTallyCompanyNameFromFile(path.join(companyDir, "Company.1800")) ||
          readTallyCompanyNameFromFile(path.join(companyDir, "CmpSave.1800"));
        if (companyName) {
          names.push(companyName);
        }
      }
    } catch {
      // Local folder fallback is best-effort; heartbeat should still continue.
    }
  }

  return mergeCompanyNames(names);
}

function readTallyCompanyNameFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    const candidates = [
      ...extractReadableTallyStrings(buffer.toString("utf16le")),
      ...extractReadableTallyStrings(buffer.toString("latin1")),
    ];
    return candidates.find(isLikelyTallyCompanyName) ?? null;
  } catch {
    return null;
  }
}

function extractReadableTallyStrings(text) {
  return [...String(text).matchAll(/[A-Za-z0-9][A-Za-z0-9 .&()/_-]{1,78}/g)]
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function isLikelyTallyCompanyName(value) {
  const normalized = String(value ?? "").trim();
  const lower = normalized.toLowerCase();

  if (!normalized || normalized.length < 2 || normalized.length > 80) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (lower.includes("company features")) return false;
  if (lower === "company" || lower === "tally" || lower === "tally prime") return false;
  if (lower.startsWith("alter ") || lower.startsWith("create ")) return false;
  return /[a-z]/i.test(normalized);
}

function parseTallyImportResult(text, httpStatus) {
  const lineError = getTagText(text, "LINEERROR");
  const statusText = getTagText(text, "STATUS");
  const dataText = getTagText(text, "DATA");
  const errorsText = text.match(/<ERRORS[^>]*>([^<]+)<\/ERRORS>/i)?.[1]?.trim() ?? null;
  const alteredText = text.match(/<ALTERED[^>]*>([^<]+)<\/ALTERED>/i)?.[1]?.trim() ?? null;
  const createdText = text.match(/<CREATED[^>]*>([^<]+)<\/CREATED>/i)?.[1]?.trim() ?? null;
  const ignoredText = text.match(/<IGNORED[^>]*>([^<]+)<\/IGNORED>/i)?.[1]?.trim() ?? null;
  const cancelledText = text.match(/<CANCELLED[^>]*>([^<]+)<\/CANCELLED>/i)?.[1]?.trim() ?? null;
  const exceptionsText = text.match(/<EXCEPTIONS[^>]*>([^<]+)<\/EXCEPTIONS>/i)?.[1]?.trim() ?? null;
  const reportedLastVchId = getTagText(text, "LASTVCHID") || getTagText(text, "LASTVCHID.LIST");
  const lastCreatedVchId = getTagText(text, "LASTCREATEDVCHID");
  const lastVchId = Number(reportedLastVchId || 0) > 0
    ? reportedLastVchId
    : Number(lastCreatedVchId || 0) > 0
      ? lastCreatedVchId
      : null;
  const voucherNumber = getTagText(text, "VCHNUMBER");
  const errors = errorsText ? Number(errorsText) : null;
  const exceptions = exceptionsText ? Number(exceptionsText) : null;
  const responseError =
    lineError ||
    (statusText === "0" && dataText ? dataText.replace(/\s+/g, " ").trim() : null) ||
    (Number(exceptions ?? 0) > 0
      ? `Tally reported ${exceptions} import exception${exceptions === 1 ? "" : "s"}.`
      : null);

  return {
    success:
      httpStatus >= 200 &&
      httpStatus < 300 &&
      !responseError &&
      (errors === null || errors === 0) &&
      (exceptions === null || exceptions === 0),
    error: responseError,
    result: {
      httpStatus,
      altered: alteredText ? Number(alteredText) : null,
      created: createdText ? Number(createdText) : null,
      lastVchId,
      voucherNumber,
      errors,
      exceptions,
      ignored: ignoredText ? Number(ignoredText) : null,
      cancelled: cancelledText ? Number(cancelledText) : null,
      response: text.slice(0, 4000),
    },
  };
}

function requireCreatedVoucher(outcome) {
  const created = Number(outcome.result?.created ?? 0) || 0;
  const altered = Number(outcome.result?.altered ?? 0) || 0;

  if (!outcome.success || created > 0 || altered > 0) {
    return outcome;
  }

  return {
    ...outcome,
    success: false,
    error: `Tally accepted the voucher import request but did not report a created voucher. CREATED=${created}, ALTERED=${altered}.`,
  };
}

function purchaseVoucherReadbackComparison(voucher, payload, options = {}) {
  const differences = [];
  const expectedItems = Array.isArray(payload?.items) ? payload.items : [];
  const actualItems = Array.isArray(voucher?.inventoryEntries) ? voucher.inventoryEntries : [];
  const expectedPayable = Number(payload?.finalPayableAmount);
  const partyEntries = (voucher?.ledgerEntries || []).filter(
    (entry) => normalizeLooseName(entry.ledgerName) === normalizeLooseName(payload?.supplierLedgerName)
  );
  const partyEntry = partyEntries[0];
  const expectedAllocations = [
    ...(Array.isArray(payload?.charges) ? payload.charges : []),
    ...(Array.isArray(payload?.withholdings) ? payload.withholdings : []),
    ...(payload?.ledgers?.roundOff ? [{ ...payload.ledgers.roundOff, kind: "round_off" }] : []),
  ].filter((entry) => entry?.name && Number(entry?.amount) !== 0);
  const splitQuantity = (value) => {
    const match = String(value ?? "").trim().match(/^([+-]?[\d,.]+)\s*(.*)$/);
    return match ? { value: Number(match[1].replace(/,/g, "")), unit: normalizeLooseName(match[2]) } : { value: NaN, unit: "" };
  };
  const splitRate = (value) => {
    const match = String(value ?? "").trim().match(/^([+-]?[\d,.]+)\s*(?:\/\s*(.*))?$/);
    return match ? { value: Number(match[1].replace(/,/g, "")), unit: normalizeLooseName(match[2]) } : { value: NaN, unit: "" };
  };
  const closeMoney = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.01;

  // Tally's voucher number is controlled by the Purchase voucher type. In
  // Automatic mode it can legitimately differ from the requested display
  // reference. Supplier invoice identity is verified independently through
  // REFERENCE and bill allocations, so numbering alone is not an accounting
  // mismatch and must not turn a successfully created voucher into a failure.

  if (expectedItems.length !== actualItems.length) {
    differences.push(`Expected ${expectedItems.length} item line(s), Tally returned ${actualItems.length}.`);
  }

  const availableActualItems = actualItems.map((actual, index) => ({ actual, index, used: false }));
  expectedItems.forEach((expected, index) => {
    const matched = availableActualItems.find((candidate) =>
      !candidate.used &&
      normalizeLooseName(candidate.actual.stockItemName) === normalizeLooseName(expected.stockItemName) &&
      normalizeLooseName(candidate.actual.purchaseLedgerName) === normalizeLooseName(expected.purchaseLedgerName) &&
      String(candidate.actual.hsn || "").replace(/\D/g, "") === String(expected.hsn || "").replace(/\D/g, "")
    ) ?? availableActualItems.find((candidate) => !candidate.used);
    const actual = matched?.actual;
    if (!actual) return;
    matched.used = true;
    if (normalizeLooseName(actual.stockItemName) !== normalizeLooseName(expected.stockItemName)) {
      differences.push(`Line ${index + 1} stock item differs.`);
    }
    if (String(actual.hsn || "").replace(/\D/g, "") !== String(expected.hsn || "").replace(/\D/g, "")) {
      differences.push(`Line ${index + 1} HSN differs.`);
    }
    const expectedAmount = Number(expected.taxableAmount);
    if (Number.isFinite(expectedAmount) && Math.abs(Number(actual.amount || 0) - expectedAmount) > 0.01) {
      differences.push(`Line ${index + 1} taxable amount differs.`);
    }
    if (normalizeLooseName(actual.purchaseLedgerName) !== normalizeLooseName(expected.purchaseLedgerName)) {
      differences.push(`Line ${index + 1} purchase ledger differs.`);
    }
    const actualQuantity = splitQuantity(actual.quantity);
    if (!closeMoney(actualQuantity.value, Number(expected.quantity))) differences.push(`Line ${index + 1} quantity differs.`);
    if (actualQuantity.unit && actualQuantity.unit !== normalizeLooseName(expected.unit)) differences.push(`Line ${index + 1} unit differs.`);
    const actualRate = splitRate(actual.rate);
    if (!closeMoney(actualRate.value, Number(expected.rate))) differences.push(`Line ${index + 1} rate differs.`);
    if (actualRate.unit && actualRate.unit !== normalizeLooseName(expected.unit)) differences.push(`Line ${index + 1} rate unit differs.`);
    const expectedGodownName = String(expected.godownName || "").trim();
    const expectedBatchName = String(expected.batchName || "").trim();
    if (expectedGodownName && normalizeLooseName(actual.godownName) !== normalizeLooseName(expectedGodownName)) {
      differences.push(`Line ${index + 1} godown differs.`);
    }
    if (expectedBatchName && normalizeLooseName(actual.batchName) !== normalizeLooseName(expectedBatchName)) {
      differences.push(`Line ${index + 1} batch differs.`);
    }
    if (Number(actual.signedAmount) >= 0) differences.push(`Line ${index + 1} accounting direction differs.`);
  });

  if (!partyEntry) {
    differences.push("Supplier ledger allocation was not returned by Tally.");
  } else if (partyEntries.length !== 1) {
    differences.push(
      `Expected one supplier ledger allocation, Tally returned ${partyEntries.length}.`
    );
  } else if (Number.isFinite(expectedPayable) && Math.abs(Math.abs(Number(partyEntry.amount || 0)) - expectedPayable) > 0.01) {
    differences.push("Final supplier payable differs.");
  }

  const withholdingEntries = new Set(Array.isArray(payload?.withholdings) ? payload.withholdings : []);
  // Tally keeps one accounting row per purchase ledger: two items on the same
  // ledger come back as a single combined amount. Compare the ledger total;
  // each item line was already checked individually above.
  const purchaseLedgerTotals = new Map();
  for (const item of expectedItems) {
    const name = String(item?.purchaseLedgerName || "").trim();
    if (!name) continue;
    const key = normalizeLooseName(name);
    const current = purchaseLedgerTotals.get(key) || { name, amount: 0 };
    current.amount += Math.abs(Number(item?.taxableAmount) || 0);
    purchaseLedgerTotals.set(key, current);
  }
  const expectedSignedLedgerRows = [
    { name: payload?.supplierLedgerName, signedAmount: Number(payload?.finalPayableAmount), role: "supplier" },
    ...Array.from(purchaseLedgerTotals.values()).map((entry) => ({
      name: entry.name,
      signedAmount: -Math.round(entry.amount * 100) / 100,
      role: "purchase ledger",
      combinable: true,
    })),
    ...expectedAllocations.map((entry) => ({
      name: entry.name,
      signedAmount: entry.kind === "round_off"
        ? (Number(entry.amount) > 0 ? -Math.abs(Number(entry.amount)) : Math.abs(Number(entry.amount)))
        : withholdingEntries.has(entry) ? Math.abs(Number(entry.amount)) : -Math.abs(Number(entry.amount)),
      role: entry.kind || "allocation",
    })),
  ].filter((entry) => entry.name && Number.isFinite(entry.signedAmount));
  const actualLedgerRows = (voucher?.ledgerEntries || []).map((entry, index) => ({ ...entry, index, used: false }));
  for (const expected of expectedSignedLedgerRows) {
    const actual = actualLedgerRows.find((entry) =>
      !entry.used && normalizeLooseName(entry.ledgerName) === normalizeLooseName(expected.name) && closeMoney(Number(entry.amount), expected.signedAmount)
    );
    if (actual) {
      actual.used = true;
      continue;
    }
    // A purchase ledger may also come back split per item: accept rows on the
    // same ledger and side whose sum is the expected total.
    const sameLedgerRows = expected.combinable
      ? actualLedgerRows.filter((entry) =>
          !entry.used && normalizeLooseName(entry.ledgerName) === normalizeLooseName(expected.name) &&
          Math.sign(Number(entry.amount)) === Math.sign(expected.signedAmount))
      : [];
    const splitTotal = sameLedgerRows.reduce((total, entry) => total + Number(entry.amount), 0);
    if (sameLedgerRows.length > 1 && closeMoney(splitTotal, expected.signedAmount)) {
      sameLedgerRows.forEach((entry) => { entry.used = true; });
    } else {
      differences.push(`${expected.name} ${expected.role} amount or accounting direction differs.`);
    }
  }

  for (const unexpected of actualLedgerRows.filter((entry) => !entry.used)) {
    differences.push(`Unexpected ledger allocation returned by Tally: ${unexpected.ledgerName}.`);
  }

  if (
    !options.ignoreVoucherDate &&
    normalizeTallyDate(voucher?.date) !== normalizeTallyDate(payload?.voucherDate)
  ) {
    differences.push("Tally voucher date differs.");
  }
  if (
    normalizeTallyDate(voucher?.referenceDate) !==
    normalizeTallyDate(payload?.supplierInvoiceDate)
  ) {
    differences.push("Supplier invoice date differs.");
  }
  if (normalizeLooseName(voucher?.reference) !== normalizeLooseName(payload?.supplierInvoiceNumber)) {
    differences.push("Supplier invoice reference differs.");
  }
  const supplierBillAllocation = (voucher?.billAllocations || []).find(
    (allocation) =>
      normalizeLooseName(allocation.referenceName) ===
      normalizeLooseName(payload?.supplierInvoiceNumber)
  );
  if (!supplierBillAllocation) {
    differences.push("Supplier invoice bill reference was not returned by Tally.");
  } else {
    if (normalizeLooseName(supplierBillAllocation.billType) !== normalizeLooseName("New Ref")) {
      differences.push("Supplier invoice bill reference type differs from New Ref.");
    }
    if (
      !options.ignoreBillDate &&
      supplierBillAllocation.billDate &&
      normalizeTallyDate(supplierBillAllocation.billDate) !==
      normalizeTallyDate(payload?.voucherDate)
    ) {
      differences.push("Supplier outstanding bill date differs from the Tally voucher date.");
    }
    if (
      Number.isFinite(expectedPayable) &&
      Math.abs(Number(supplierBillAllocation.amount || 0) - expectedPayable) > 0.01
    ) {
      differences.push("Supplier outstanding bill amount differs.");
    }
  }
  if (payload?.sourceDocumentPath && !options.ignoreSourceDocumentIdentity) {
    const expectedDocument = {
      path: String(payload.sourceDocumentPath).trim(),
      name: String(payload.sourceDocumentName || "").trim(),
      sha256: String(payload.sourceDocumentSha256 || "").trim().toUpperCase(),
      id: String(payload.sourceDocumentId || "").trim(),
    };
    const actualDocument = {
      path: String(voucher?.sourceDocumentPath || "").trim(),
      name: String(voucher?.sourceDocumentName || "").trim(),
      sha256: String(voucher?.sourceDocumentSha256 || "").trim().toUpperCase(),
      id: String(voucher?.sourceDocumentId || "").trim(),
    };
    const addOnPath = String(voucher?.linkDocumentPath || "").trim();
    const sharedFolderConfigured = Boolean(String(payload?.sourceDocumentFolder || "").trim());
    const kalikaFieldsAbsent = !actualDocument.path && !actualDocument.name && !actualDocument.sha256 && !actualDocument.id;
    if (kalikaFieldsAbsent && !addOnPath && !sharedFolderConfigured) {
      // Purchases do not require the Kalika TDL. Without it and without a
      // shared folder (Attach Documents add-on), Tally has no field that can
      // hold the PDF details, so there is nothing to verify.
    } else if (!actualDocument.path && addOnPath) {
      // Kalika's own fields are readable only with the Kalika TDL. When the
      // client's Attach Documents add-on holds the path instead, that path is
      // the attachment users open, so it is what must match.
      if (addOnPath.toLowerCase() !== expectedDocument.path.toLowerCase()) {
        differences.push("Original invoice PDF path was not attached to the Tally voucher.");
      }
    } else {
      if (!actualDocument.path || actualDocument.path.toLowerCase() !== expectedDocument.path.toLowerCase()) {
        differences.push("Original invoice PDF path was not attached to the Tally voucher.");
      }
      if (!actualDocument.name || actualDocument.name !== expectedDocument.name) {
        differences.push("Original invoice PDF name differs.");
      }
      if (!actualDocument.sha256 || actualDocument.sha256 !== expectedDocument.sha256) {
        differences.push("Original invoice PDF checksum differs.");
      }
      if (!actualDocument.id || actualDocument.id !== expectedDocument.id) {
        differences.push("Original invoice document identity differs.");
      }
    }
  }
  const vehicleInNarration = payload?.vehicleNumber &&
    String(voucher?.narration || "").replace(/[^a-z0-9]/gi, "").toLowerCase().includes(
      String(payload.vehicleNumber).replace(/[^a-z0-9]/gi, "").toLowerCase()
    );
  if (
    payload?.vehicleNumber &&
    !vehicleInNarration &&
    normalizeLooseName(voucher?.vehicleNumber) !== normalizeLooseName(payload.vehicleNumber)
  ) {
    differences.push("Vehicle number was not preserved on the Tally voucher.");
  }

  return differences;
}

function existingPurchaseVoucherAttachmentDifferences(voucher, payload) {
  return purchaseVoucherReadbackComparison(voucher, payload, {
    ignoreVoucherDate: true,
    ignoreBillDate: true,
  });
}

function purchaseVoucherFinancialYearRange(value) {
  const normalized = normalizeTallyDate(value);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { dateFrom: value, dateTo: value };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  return {
    dateFrom: `${startYear}-04-01`,
    dateTo: `${startYear + 1}-03-31`,
  };
}

async function verifyPurchaseVoucherInTally(config, payload = {}, options = {}) {
  const companyName = payload?.companyName || config?.companyName || null;
  const tallyUrl = normalizeTallyUrl(payload?.tallyUrl || config?.tallyUrl);
  const voucherDate = payload?.voucherDate || payload?.supplierInvoiceDate;
  const supplierInvoiceNumber = String(payload?.supplierInvoiceNumber || "").trim();
  const supplierLedgerName = String(payload?.supplierLedgerName || "").trim();

  if (!companyName || !voucherDate || !supplierInvoiceNumber || !supplierLedgerName) {
    throw new Error("Purchase voucher verification requires company, date, invoice number, and supplier ledger.");
  }

  const searchRange = options.searchFinancialYear
    ? purchaseVoucherFinancialYearRange(voucherDate)
    : { dateFrom: voucherDate, dateTo: voucherDate };
  const preferredMasterId = String(options.preferredMasterId || "").trim();
  const preferredMasterFormula = /^\d+$/.test(preferredMasterId)
    ? [{ name: "KalikaPurchaseMasterId", formula: `$MasterID = ${preferredMasterId}` }]
    : [];
  const identityFormulae = [
    {
      name: "KalikaPurchaseInvoiceReference",
      formula: buildRequestedLedgerFormula([supplierInvoiceNumber], ["$Reference"]),
    },
    {
      name: "KalikaPurchaseSupplier",
      formula: buildRequestedLedgerFormula([supplierLedgerName], ["$PartyLedgerName"]),
    },
  ];
  const formulae = preferredMasterFormula.length > 0 ? preferredMasterFormula : identityFormulae;
  const filterNames = formulae.map((entry) => entry.name);
  const exportCandidates = async (dateFrom, dateTo, detailed) => parseVoucherCollection(
    await exportTallyCollection(tallyUrl, {
      collectionName: detailed ? "Autodealer Purchase Voucher Verification" : "Autodealer Purchase Voucher Identity",
      tallyType: "Voucher",
      fetchFields: detailed
        ? "Date,EffectiveDate,ReferenceDate,VoucherTypeName,VoucherNumber,Reference,PartyLedgerName,MasterID,AlterID,GUID,Narration,KalikaSourceDocumentPath,KalikaSourceDocumentName,KalikaSourceDocumentSha256,KalikaSourceDocumentId,KalikaVehicleNumber,UDFForLinkDocumentFile,AllLedgerEntries.*,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.BillDate,AllLedgerEntries.BillAllocations.Amount,AllInventoryEntries.*"
        : "Date,VoucherTypeName,VoucherNumber,Reference,PartyLedgerName,MasterID,GUID",
      companyName,
      dateFrom,
      dateTo,
      formulae,
      filterNames,
      timeoutMs: CASH_DISCOUNT_READ_MS,
    })
  ).filter((voucher) => {
    if (!/purchase/i.test(String(voucher.voucherType || ""))) return false;
    if (preferredMasterFormula.length > 0) {
      return String(voucher.masterId || "").trim() === preferredMasterId;
    }
    return normalizeLooseName(voucher.reference) === normalizeLooseName(supplierInvoiceNumber) &&
      normalizeLooseName(voucher.partyLedgerName) === normalizeLooseName(supplierLedgerName);
  });
  let candidates = [];
  if (options.searchFinancialYear) {
    for (const chunk of cashDiscountVoucherDateChunks(searchRange.dateFrom, searchRange.dateTo)) {
      candidates.push(...await exportCandidates(chunk.dateFrom, chunk.dateTo, false));
      if (candidates.length > 1) break;
    }
    if (candidates.length === 1) {
      const candidateDate = normalizeTallyDate(candidates[0].date) || voucherDate;
      candidates = await exportCandidates(candidateDate, candidateDate, true);
    }
  } else {
    candidates = await exportCandidates(searchRange.dateFrom, searchRange.dateTo, true);
  }

  if (candidates.length === 0) {
    return {
      success: true,
      result: {
        verificationStatus: "missing",
        supplierInvoiceNumber,
        supplierLedgerName,
        candidates: [],
      },
    };
  }

  if (candidates.length > 1) {
    return {
      success: true,
      result: {
        verificationStatus: "ambiguous",
        supplierInvoiceNumber,
        supplierLedgerName,
        candidates: candidates.slice(0, 10),
      },
    };
  }

  const voucher = candidates[0];
  const differences = purchaseVoucherReadbackComparison(voucher, payload, options.comparisonOptions);
  return {
    success: true,
    result: {
      verificationStatus: differences.length === 0 ? "verified" : "mismatch",
      differences,
      voucherId: voucher.masterId || voucher.voucherNumber || null,
      masterId: voucher.masterId || null,
      voucherNumber: voucher.voucherNumber || null,
      guid: voucher.guid || null,
      voucherDate: normalizeTallyDate(voucher.date),
      supplierInvoiceNumber,
      supplierLedgerName,
      voucher,
    },
  };
}

function purchasePayloadMasterNames(payload) {
  const ledgerNames = [
    payload?.supplierLedgerName,
    ...(Array.isArray(payload?.items) ? payload.items.map((item) => item?.purchaseLedgerName) : []),
    ...(Array.isArray(payload?.charges) ? payload.charges.map((entry) => entry?.name) : []),
    ...(Array.isArray(payload?.withholdings) ? payload.withholdings.map((entry) => entry?.name) : []),
    ...Object.values(payload?.ledgers && typeof payload.ledgers === "object" ? payload.ledgers : {})
      .map((entry) => entry?.name),
  ].filter(Boolean);
  const stockItemNames = (Array.isArray(payload?.items) ? payload.items : [])
    .map((item) => item?.stockItemName)
    .filter(Boolean);
  const godownNames = (Array.isArray(payload?.items) ? payload.items : [])
    .map((item) => item?.godownName)
    .filter(Boolean);
  return {
    ledgerNames: Array.from(new Set(ledgerNames.map((name) => String(name).trim()).filter(Boolean))),
    stockItemNames: Array.from(new Set(stockItemNames.map((name) => String(name).trim()).filter(Boolean))),
    godownNames: Array.from(new Set(godownNames.map((name) => String(name).trim()).filter(Boolean))),
  };
}

function purchaseProposedVoucherNumber(payload) {
  const invoiceNumber = String(payload?.supplierInvoiceNumber || "").trim();
  const isoDate = toIsoLikeDate(payload?.supplierInvoiceDate || payload?.voucherDate);
  const [year, month, day] = isoDate.split("-");
  const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1];
  return invoiceNumber && monthName
    ? `${invoiceNumber} / ${day}-${monthName}-${year.slice(-2)}`
    : invoiceNumber;
}

async function readPurchaseVoucherNumbering(tallyUrl, companyName) {
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Purchase Voucher Type Configuration",
    tallyType: "VoucherType",
    fetchFields: "Name,Parent,NumberingMethod,MethodOfVoucherNumbering",
    companyName,
  });
  const block = extractBlocks(xml, "VOUCHERTYPE").find((entry) =>
    normalizeLooseName(getAttribute(entry, "NAME") || getTagText(entry, "NAME")) === "purchase"
  );
  const method = block
    ? cleanXmlText(
        getTagText(block, "NUMBERINGMETHOD") ||
        getTagText(block, "METHODOFVOUCHERNUMBERING")
      )
    : "";
  return {
    method: method || "Automatic",
    acceptsProvidedNumber: /manual|override/i.test(method),
  };
}

function purchaseValidationExceptionApproved(payload, code, lineId = null) {
  const approvedBlockers = Array.isArray(payload?.validationOverrides?.blockers)
    ? payload.validationOverrides.blockers
    : [];
  const acknowledgedWarnings = Array.isArray(payload?.validationAcknowledgement?.warnings)
    ? payload.validationAcknowledgement.warnings
    : [];
  return [...approvedBlockers, ...acknowledgedWarnings].some((entry) => {
    if (String(entry?.code || "") !== code) return false;
    const approvedLineId = String(entry?.lineId || "").trim();
    return !approvedLineId || !lineId || approvedLineId === String(lineId);
  });
}

async function validatePurchasePayloadMasters(tallyUrl, companyName, payload) {
  const { ledgerNames, stockItemNames, godownNames } = purchasePayloadMasterNames(payload);
  if (ledgerNames.length === 0 || stockItemNames.length === 0) {
    throw new Error("Purchase voucher is missing its selected Tally ledgers or stock items.");
  }

  const ledgerFilterName = "KalikaRequestedPurchaseLedger";
  const stockFilterName = "KalikaRequestedPurchaseStock";
  const godownFilterName = "KalikaRequestedPurchaseGodown";
  // Tally's HTTP listener is effectively serial. Keep targeted master reads on
  // one lane so a large company cannot make Tally process overlapping exports.
  const ledgerXml = await exportTallyCollection(tallyUrl, {
      collectionName: "Kalika Validate Purchase Ledgers",
      tallyType: "Ledger",
      fetchFields: "Name,Parent,GUID,PartyGSTIN,GSTIN,GSTRegistrationNumber,GSTRegNumber,GSTNo,GSTNumber,GSTIdentificationNumber,LedgerGSTIN,TaxType,GSTDutyHead,RateOfTaxCalculation,GSTDetails.*,GSTDetails.LIST.*,GSTRegistrationDetails.*,GSTRegistrationDetails.LIST.*,LedgerGSTRegistrationDetails.*,LedgerGSTRegistrationDetails.LIST.*,LedgerGSTRegDetails.*,LedgerGSTRegDetails.LIST.*,LedGSTRegDetails.*,LedGSTRegDetails.LIST.*",
      companyName,
      formulae: [{
        name: ledgerFilterName,
        formula: buildRequestedLedgerFormula(ledgerNames, ["$Name"]),
      }],
      filterNames: [ledgerFilterName],
    });
  const stockXml = await exportTallyCollection(tallyUrl, {
      collectionName: "Kalika Validate Purchase Stock",
      tallyType: "StockItem",
      fetchFields: "Name,Parent,GUID,BaseUnits,OriginalBaseUnits,GSTHSNCode,GSTHSNName,GSTHSNSACCode,GSTHSNSACName,HSNCode,HSNSACCode,HSNSACName,GSTOVRDNHSNCODE,HSNOVRDNCLASSIFICATION,HSN,HSNSAC,HSNCLASSIFICATION,HSNName,HSNDescription,GSTHSN,GSTTaxRate,RateOfTaxCalculation,GSTRATE,RateOfVAT,GSTDetails.*,GSTDetails.LIST.*,GSTHSNDetails.*,GSTHSNDetails.LIST.*,HSNDetails.*,HSNDetails.LIST.*",
      companyName,
      formulae: [{
        name: stockFilterName,
        formula: buildRequestedLedgerFormula(stockItemNames, ["$Name"]),
      }],
      filterNames: [stockFilterName],
    });
  const godownXml = godownNames.length > 0
      ? await exportTallyCollection(tallyUrl, {
          collectionName: "Kalika Validate Purchase Godowns",
          tallyType: "Godown",
          fetchFields: "Name,Parent,GUID",
          companyName,
          formulae: [{
            name: godownFilterName,
            formula: buildRequestedLedgerFormula(godownNames, ["$Name"]),
          }],
          filterNames: [godownFilterName],
        })
      : "";

  const liveLedgerByName = new Map(parseMasterCollection(ledgerXml, "LEDGER").map((master) => [normalizeLooseName(master.name), master]));
  const liveStockByName = new Map(parseMasterCollection(stockXml, "STOCKITEM").map((master) => [normalizeLooseName(master.name), master]));
  const liveGodownNames = new Set(parseMasterCollection(godownXml, "GODOWN").map((master) => normalizeLooseName(master.name)));
  const missingLedgers = ledgerNames.filter((name) => !liveLedgerByName.has(normalizeLooseName(name)));
  const missingStockItems = stockItemNames.filter((name) => !liveStockByName.has(normalizeLooseName(name)));
  const missingGodowns = godownNames.filter((name) => !liveGodownNames.has(normalizeLooseName(name)));
  if (missingLedgers.length > 0 || missingStockItems.length > 0 || missingGodowns.length > 0) {
    throw new Error([
      missingLedgers.length > 0 ? `Ledger no longer exists in live Tally: ${missingLedgers.join(", ")}.` : "",
      missingStockItems.length > 0 ? `Stock item no longer exists in live Tally: ${missingStockItems.join(", ")}.` : "",
      missingGodowns.length > 0 ? `Godown no longer exists in live Tally: ${missingGodowns.join(", ")}.` : "",
      "Refresh Purchase masters and review the changed selection before posting.",
    ].filter(Boolean).join(" "));
  }

  const supplier = liveLedgerByName.get(normalizeLooseName(payload?.supplierLedgerName));
  const expectedSupplierGstin = String(payload?.supplierGstin || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const liveSupplierGstin = String(supplier?.gstin || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (
    expectedSupplierGstin &&
    liveSupplierGstin &&
    expectedSupplierGstin !== liveSupplierGstin &&
    !purchaseValidationExceptionApproved(payload, "SUPPLIER_LEDGER_GSTIN_MISMATCH")
  ) {
    throw new Error(`${supplier.name} now uses GSTIN ${supplier.gstin} in Tally, not ${payload.supplierGstin}. Refresh and review the supplier.`);
  }

  for (const charge of Array.isArray(payload?.charges) ? payload.charges : []) {
    if (!["cgst", "sgst", "igst"].includes(charge?.kind)) continue;
    const liveLedger = liveLedgerByName.get(normalizeLooseName(charge?.name));
    if (!liveLedger) continue;
    const identity = [liveLedger.name, liveLedger.parent, liveLedger.raw?.taxType, liveLedger.raw?.gstDutyHead]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/\boutput\b|\bsales?\b/.test(identity)) {
      throw new Error(`${liveLedger.name} is an output/sales tax ledger in Tally and cannot be used for Purchase input tax.`);
    }
    const wrongTaxRole =
      (charge.kind === "cgst" && /\b(sgst|igst|state tax|integrated tax)\b/.test(identity)) ||
      (charge.kind === "sgst" && /\b(cgst|igst|central tax|integrated tax)\b/.test(identity)) ||
      (charge.kind === "igst" && /\b(cgst|sgst|central tax|state tax)\b/.test(identity));
    if (wrongTaxRole) {
      throw new Error(`${liveLedger.name} no longer matches the selected ${String(charge.kind).toUpperCase()} role in Tally.`);
    }
    const expectedRate = Number(charge?.rate);
    const liveRate = Number(liveLedger.taxRate);
    if (Number.isFinite(expectedRate) && Number.isFinite(liveRate) && Math.abs(expectedRate - liveRate) > 0.0001) {
      throw new Error(`${liveLedger.name} now uses ${liveLedger.taxRate}% in Tally, not ${charge.rate}%. Refresh and review the tax allocation.`);
    }
  }

  for (const item of Array.isArray(payload?.items) ? payload.items : []) {
    const liveStock = liveStockByName.get(normalizeLooseName(item?.stockItemName));
    const selectedUnit = normalizeLooseName(item?.unit);
    const liveUnit = normalizeLooseName(liveStock?.unitName);
    if (
      selectedUnit &&
      liveUnit &&
      selectedUnit !== liveUnit &&
      !purchaseValidationExceptionApproved(payload, "STOCK_ITEM_UNIT_MISMATCH", item?.lineId)
    ) {
      throw new Error(`${liveStock.name} now uses ${liveStock.unitName} in Tally, not ${item.unit}. Refresh and review the item.`);
    }
    const selectedHsn = String(item?.hsn || "").replace(/\D/g, "");
    const liveHsn = String(liveStock?.hsnCode || "").replace(/\D/g, "");
    if (
      selectedHsn &&
      liveHsn &&
      selectedHsn !== liveHsn &&
      !purchaseValidationExceptionApproved(payload, "STOCK_ITEM_HSN_MISMATCH", item?.lineId)
    ) {
      throw new Error(`${liveStock.name} now uses HSN ${liveStock.hsnCode} in Tally, not ${item.hsn}. Refresh and review the item.`);
    }
  }
}

async function postPurchaseVoucher(tallyUrl, payload, companyName, options = {}) {
  const totalStartedAt = Date.now();
  const timings = {};
  const measure = async (name, operation) => {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      timings[`${name}Ms`] = Date.now() - startedAt;
    }
  };
  options.onStage?.("checking_duplicates");
  const preflight = await measure("duplicateCheck", () =>
    verifyPurchaseVoucherInTally(
      { tallyUrl, companyName },
      payload,
      {
        searchFinancialYear: true,
        comparisonOptions: {
          ignoreVoucherDate: true,
          ignoreBillDate: true,
          ignoreSourceDocumentIdentity: true,
        },
      },
    )
  );
  if (preflight.result?.verificationStatus === "verified") {
    timings.totalMs = Date.now() - totalStartedAt;
    const exactDifferences = existingPurchaseVoucherAttachmentDifferences(
      preflight.result.voucher,
      payload
    );
    if (exactDifferences.length > 0) {
      return {
        outcome: {
          success: false,
          error:
            "The Purchase voucher already exists in Tally, but its source PDF attachment does not match. " +
            "Repair the existing voucher instead of creating a duplicate.",
          result: {
            possibleDuplicateInTally: true,
            attachmentRepairRequired: true,
            differences: exactDifferences,
            verification: preflight.result,
            timings,
          },
        },
        xml: null,
      };
    }
    return {
      outcome: {
        success: true,
        result: {
          ...preflight.result,
          alreadyInTally: true,
          sourceDocumentVerified: Boolean(payload?.sourceDocumentPath),
          created: 0,
          altered: 0,
          timings,
        },
      },
      xml: null,
    };
  }
  if (["ambiguous", "mismatch"].includes(preflight.result?.verificationStatus)) {
    timings.totalMs = Date.now() - totalStartedAt;
    return {
      outcome: {
        success: false,
        error: "An existing purchase voucher with this supplier invoice needs review before posting.",
        result: {
          possibleDuplicateInTally: true,
          verification: preflight.result,
          timings,
        },
      },
      xml: null,
    };
  }
  if (payload?.verificationOnly === true) {
    timings.totalMs = Date.now() - totalStartedAt;
    return {
      outcome: {
        success: true,
        result: {
          ...preflight.result,
          verificationOnly: true,
          verifiedAbsent: preflight.result?.verificationStatus === "missing",
          created: 0,
          altered: 0,
          timings,
        },
      },
      xml: null,
    };
  }

  options.onStage?.("validating_masters");
  await measure("masterValidation", () =>
    validatePurchasePayloadMasters(tallyUrl, companyName, payload)
  );
  const numbering = await measure("voucherNumberingRead", () =>
    readPurchaseVoucherNumbering(tallyUrl, companyName)
  );
  const proposedVoucherNumber = String(payload?.voucherNumber || purchaseProposedVoucherNumber(payload)).trim();
  // A fully Automatic Tally voucher type ignores imported VOUCHERNUMBER values.
  // Only send the number displayed in Kalika when the live Voucher Type permits
  // manual input/override; otherwise omit it and read Tally's assigned number
  // back after creation.
  const numberedPayload = numbering.acceptsProvidedNumber && proposedVoucherNumber
    ? { ...payload, useCustomVoucherNumber: true, voucherNumber: proposedVoucherNumber }
    : { ...payload, useCustomVoucherNumber: false, voucherNumber: undefined };
  // E-way bill consignee is the company's own address from Tally. If it cannot
  // be read, the e-way bill's Ship To place/PIN are used instead.
  let postingPayload = numberedPayload;
  if (payload?.ewayBill) {
    const companyAddress = await readCompanyAddress(tallyUrl, companyName).catch(() => null);
    if (companyAddress) {
      postingPayload = { ...numberedPayload, ewayBill: { ...payload.ewayBill, consignee: companyAddress } };
    }
  }
  let xml = buildPurchaseVoucherXml(postingPayload, companyName);
  let importOutcome;
  try {
    options.onStage?.("importing_voucher");
    importOutcome = requireCreatedVoucher(
      await measure("voucherImport", () => invokeTallyXml(tallyUrl, xml))
    );
  } catch (error) {
    timings.totalMs = Date.now() - totalStartedAt;
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: {
        success: false,
        error: "The Purchase voucher write was sent to Tally, but its result is uncertain. Verify the existing voucher before retrying.",
        result: {
          voucherCreatedButVerificationFailed: true,
          uncertainWrite: true,
          uncertaintyReason: /timed out|abort/i.test(message) ? "import_timeout" : "import_transport_error",
          importError: message,
          timings,
        },
      },
      xml,
    };
  }
  if (!importOutcome.success) {
    const tallyAnswered = Number(importOutcome.result?.httpStatus || 0) >= 200 &&
      Number(importOutcome.result?.httpStatus || 0) < 300;
    const importExceptions = Number(importOutcome.result?.exceptions || 0);
    if (tallyAnswered && importExceptions > 0) {
      options.onStage?.("verifying_voucher", {
        lastVchId: importOutcome.result?.lastVchId ?? null,
        created: importOutcome.result?.created ?? null,
        exceptions: importExceptions,
      });
      try {
        const exceptionReadback = await measure("exceptionReadbackVerification", () =>
          verifyPurchaseVoucherInTally(
            { tallyUrl, companyName },
            postingPayload,
            {
              preferredMasterId: importOutcome.result?.lastVchId,
              searchFinancialYear: true,
              comparisonOptions: {
                ignoreVoucherDate: true,
                ignoreBillDate: true,
                ignoreSourceDocumentIdentity: true,
              },
            }
          )
        );
        timings.totalMs = Date.now() - totalStartedAt;
        if (exceptionReadback.result?.verificationStatus === "verified") {
          return {
            outcome: {
              success: true,
              result: {
                ...(importOutcome.result || {}),
                ...exceptionReadback.result,
                verification: exceptionReadback.result,
                importReportedException: true,
                sourceDocumentVerified: Boolean(payload?.sourceDocumentPath),
                voucherNumberingMethod: numbering.method,
                proposedVoucherNumber: numbering.acceptsProvidedNumber ? proposedVoucherNumber : null,
                voucherNumberAssignedByTally: !numbering.acceptsProvidedNumber,
                timings,
              },
            },
            xml,
          };
        }
        if (exceptionReadback.result?.verificationStatus === "missing") {
          return {
            outcome: {
              success: false,
              error:
                `Tally moved the Purchase voucher to Import Exceptions (${importExceptions} exception${importExceptions === 1 ? "" : "s"}). ` +
                "No voucher was created. Clear or resolve that Import Exception in Tally before retrying; the connector will not send a second import against an abandoned exception.",
              result: {
                ...(importOutcome.result || {}),
                verification: exceptionReadback.result,
                verifiedAbsent: true,
                voucherCreated: false,
                lastVchId: null,
                voucherNumber: null,
                uncertainWrite: false,
                diagnosedReason: "tally_import_exception_requires_resolution",
                voucherNumberingMethod: numbering.method,
                proposedVoucherNumber: numbering.acceptsProvidedNumber ? proposedVoucherNumber : null,
                timings,
              },
            },
            xml,
          };
        }
        return {
          outcome: {
            success: false,
            error: "Tally returned an import exception and the voucher read-back was inconclusive. Verify the voucher in Tally before retrying.",
            result: {
              ...(importOutcome.result || {}),
              verification: exceptionReadback.result,
              uncertainWrite: true,
              uncertaintyReason: "exception_readback_inconclusive",
              timings,
            },
          },
          xml,
        };
      } catch (error) {
        timings.totalMs = Date.now() - totalStartedAt;
        return {
          outcome: {
            success: false,
            error: "Tally returned an import exception and the voucher could not be read back. Verify it in Tally before retrying.",
            result: {
              ...(importOutcome.result || {}),
              uncertainWrite: true,
              uncertaintyReason: "exception_readback_failed",
              verificationError: error instanceof Error ? error.message : String(error),
              timings,
            },
          },
          xml,
        };
      }
    }
    const explained = explainVoucherTallyError(importOutcome, payload);
    return {
      outcome: {
        ...explained,
        result: {
          ...(explained.result || {}),
          uncertainWrite: importOutcome.result?.httpStatus === null || /timed out/i.test(importOutcome.error || ""),
          uncertaintyReason: /timed out/i.test(importOutcome.error || "") ? "import_timeout" : null,
        },
      },
      xml,
    };
  }

  options.onStage?.("verifying_voucher", {
    lastVchId: importOutcome.result?.lastVchId ?? null,
    created: importOutcome.result?.created ?? null,
    altered: importOutcome.result?.altered ?? null,
  });
  let readback;
  try {
    readback = await measure("readbackVerification", () =>
      verifyPurchaseVoucherInTally(
        { tallyUrl, companyName },
        postingPayload,
        { preferredMasterId: importOutcome.result?.lastVchId }
      )
    );
  } catch (error) {
    timings.totalMs = Date.now() - totalStartedAt;
    return {
      outcome: {
        success: false,
        error: "Tally reported that it created the Purchase voucher, but read-back verification could not complete.",
        result: {
          ...(importOutcome.result || {}),
          voucherCreatedButVerificationFailed: true,
          uncertainWrite: true,
          uncertaintyReason: "readback_failed",
          verificationError: error instanceof Error ? error.message : String(error),
          timings,
        },
      },
      xml,
    };
  }
  timings.totalMs = Date.now() - totalStartedAt;
  const verified = readback.result?.verificationStatus === "verified";
  return {
    outcome: verified
      ? {
          success: true,
          result: {
            ...(importOutcome.result || {}),
            ...readback.result,
            verification: readback.result,
            sourceDocumentVerified: Boolean(payload?.sourceDocumentPath),
            retriedWithDefaultInventoryAllocation: false,
            voucherNumberingMethod: numbering.method,
            proposedVoucherNumber: numbering.acceptsProvidedNumber ? proposedVoucherNumber : null,
            voucherNumberAssignedByTally: !numbering.acceptsProvidedNumber,
            timings,
          },
        }
      : {
          success: false,
          error: "Tally created the Purchase voucher, but read-back verification did not match the approved preview.",
          result: {
            ...(importOutcome.result || {}),
            voucherCreatedButVerificationFailed: true,
            verification: readback.result,
            retriedWithDefaultInventoryAllocation: false,
            timings,
          },
        },
    xml,
  };
}

async function postBankVoucher(tallyUrl, payload, companyName) {
  const voucherType = String(payload?.voucherType || "");
  const expectedDirection = payload?.expectedDirection || (/receipt/i.test(voucherType) ? "incoming" : "outgoing");
  const shouldCheckExisting =
    payload?.preflightVerifyExisting !== false &&
    /receipt|payment|contra|journal/i.test(voucherType);

  if (shouldCheckExisting) {
    const existingCheck = await verifyBankTransactionInTally(
      { tallyUrl, companyName },
      {
        ...payload,
        expectedDirection,
      }
    );
    const existingResult = existingCheck.result || {};

    if (existingResult.verificationStatus === "found") {
      return {
        outcome: {
          success: true,
          result: {
            alreadyInTally: true,
            created: 0,
            altered: 0,
            voucherId: existingResult.voucherId,
            voucherNumber: existingResult.voucherNumber,
            voucherType: existingResult.voucherType,
            voucherDate: existingResult.voucherDate,
            duplicateCheck: existingResult,
          },
        },
        xml: null,
        retriedWithLegacyHeader: false,
      };
    }

    if (existingResult.verificationStatus === "ambiguous") {
      return {
        outcome: {
          success: false,
          error: "Possible existing bank transaction found in Tally. Review before posting to avoid a duplicate.",
          result: {
            possibleDuplicateInTally: true,
            duplicateCheck: existingResult,
          },
        },
        xml: null,
        retriedWithLegacyHeader: false,
      };
    }
  }

  const primaryXml = buildBankVoucherXml(payload, companyName);
  const primaryOutcome = explainVoucherTallyError(
    requireCreatedVoucher(await invokeTallyXml(tallyUrl, primaryXml)),
    payload
  );

  return { outcome: primaryOutcome, xml: primaryXml, retriedWithLegacyHeader: false };
}

function normalizedGuid(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function resolveBankVoucherLedgerIdentities(payloads, liveMasters) {
  const byGuid = new Map();
  const byName = new Map();
  for (const master of liveMasters || []) {
    const guid = normalizedGuid(master?.guid);
    const name = String(master?.name || "").trim();
    if (guid) byGuid.set(guid, master);
    if (name) byName.set(normalizeLooseName(name), master);
  }
  const resolve = (nameValue, guidValue, label) => {
    const name = String(nameValue || "").trim();
    const guid = normalizedGuid(guidValue);
    const master = guid ? byGuid.get(guid) : byName.get(normalizeLooseName(name));
    if (!master) {
      throw new Error(`${label} '${name || guid || "unknown"}' is not present in the active Tally company. Refresh masters and review this row before posting.`);
    }
    return { name: master.name, guid: master.guid || guidValue || null };
  };
  return (payloads || []).map((payload) => {
    const bank = resolve(payload?.bankLedgerName, payload?.bankLedgerGuid, "Bank ledger");
    const counterparty = resolve(payload?.counterpartyLedgerName, payload?.counterpartyLedgerGuid, "Counterparty ledger");
    return {
      ...payload,
      bankLedgerName: bank.name,
      bankLedgerGuid: bank.guid,
      counterpartyLedgerName: counterparty.name,
      counterpartyLedgerGuid: counterparty.guid,
      matchedLedgerName: counterparty.name,
      liveMasterValidation: {
        checkedAt: new Date().toISOString(),
        bankLedger: bank,
        counterpartyLedger: counterparty,
      },
    };
  });
}

async function resolveBankVoucherLedgerPayloads(tallyUrl, payloads, companyName) {
  const identities = (payloads || []).flatMap((payload) => [
    { name: payload?.bankLedgerName, guid: payload?.bankLedgerGuid },
    { name: payload?.counterpartyLedgerName, guid: payload?.counterpartyLedgerGuid },
  ]).filter((identity) => identity.name || identity.guid);
  const names = identities.map((identity) => identity.name).filter(Boolean);
  const guids = identities.map((identity) => String(identity.guid || "").trim()).filter(Boolean);
  const nameFormula = buildRequestedLedgerFormula(names, ["$Name"]);
  const guidFormula = guids
    .map((guid) => `($$IsEqual:$GUID:${tallyFormulaString(guid)})`)
    .join(" OR ");
  const formula = [nameFormula, guidFormula].filter(Boolean).map((part) => `(${part})`).join(" OR ");
  const filterName = "KalikaBankVoucherLedgerIdentity";
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Bank Voucher Ledger Identity",
    tallyType: "Ledger",
    fetchFields: "Name,GUID,Parent,IsBillWiseOn",
    companyName,
    formulae: [{ name: filterName, formula }],
    filterNames: [filterName],
    timeoutMs: 20_000,
    maxResponseBytes: 1024 * 1024,
  });
  return resolveBankVoucherLedgerIdentities(payloads, parseBankStatementMasterCollection(xml, "LEDGER"));
}

async function validateBankVoucherBillAllocationsLive(config, payloads, companyName) {
  const allocatedPayloads = (payloads || []).filter((payload) =>
    Array.isArray(payload?.billAllocations) && payload.billAllocations.length > 0
  );
  if (allocatedPayloads.length === 0) return payloads;
  const ledgerNames = Array.from(new Set(
    allocatedPayloads.map((payload) => String(payload.counterpartyLedgerName || "").trim()).filter(Boolean)
  ));
  const asOfDate = allocatedPayloads
    .map((payload) => normalizeDateForCompare(payload.voucherDate))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const outcome = await fetchCustomerOpenBillsFromTally(
    config,
    {
      companyName,
      ledgerNames,
      asOfDate,
      queryPurpose: "bank_statement_match",
    }
  );
  const byLedger = outcome.result?.byLedger || {};
  const consumed = new Map();
  for (const payload of allocatedPayloads) {
    const ledgerName = String(payload.counterpartyLedgerName || "").trim();
    const bucket = byLedger[ledgerName];
    if (!bucket || !Array.isArray(bucket.openBills)) {
      throw new Error(`Open bills for '${ledgerName}' could not be verified immediately before posting.`);
    }
    const billByReference = new Map(
      bucket.openBills.map((bill) => [normalizeExactReference(bill.referenceName || bill.voucherNumber), bill])
    );
    for (const allocation of payload.billAllocations) {
      if (!/^agst\s+ref$/i.test(String(allocation?.referenceType || "").trim())) continue;
      const referenceKey = normalizeExactReference(allocation?.referenceName);
      const bill = billByReference.get(referenceKey);
      if (!referenceKey || !bill) {
        throw new Error(`Bill '${allocation?.referenceName || "unknown"}' is no longer open in '${ledgerName}'.`);
      }
      const amount = Math.abs(Number(allocation?.amount || 0));
      const consumedKey = `${normalizeLooseName(ledgerName)}|${referenceKey}`;
      const nextConsumed = Number(((consumed.get(consumedKey) || 0) + amount).toFixed(2));
      const pendingAmount = Math.abs(Number(bill.pendingAmount ?? bill.amount ?? 0));
      if (!(amount > 0) || nextConsumed - pendingAmount >= 0.005) {
        throw new Error(`Bill '${allocation.referenceName}' changed in Tally. Refresh matching before posting.`);
      }
      consumed.set(consumedKey, nextConsumed);
    }
  }
  const checkedAt = new Date().toISOString();
  return (payloads || []).map((payload) => ({
    ...payload,
    liveBillValidation: Array.isArray(payload?.billAllocations) && payload.billAllocations.length > 0
      ? { checkedAt, source: "live_tally_immediate_read" }
      : null,
  }));
}

export function getBankVoucherCommandBatchKey(payload = {}, fallbackCompanyName = null) {
  return [
    normalizeLooseName(payload.companyName || fallbackCompanyName),
    normalizeLooseName(payload.bankLedgerName),
  ].join("::");
}

async function runBankVoucherCommandBatch(config, commands, options = {}) {
  const groups = new Map();
  for (const command of commands) {
    const payload = command?.payload || {};
    // A Tally import envelope can contain different voucher types and each
    // TALLYMESSAGE carries its own bill allocations. Splitting on those fields
    // reduced a mixed bank statement to batches of one even though all commands
    // had been claimed together. Keep only the values shared by the duplicate
    // pre/post-flight lookup; this lets up to 50 statement vouchers use one
    // Tally request without weakening per-command result isolation.
    const key = getBankVoucherCommandBatchKey(payload, config.companyName);
    const group = groups.get(key) || [];
    group.push(command);
    groups.set(key, group);
  }

  for (const unresolvedGroup of groups.values()) {
    let group;
    try {
      const companyName = unresolvedGroup[0]?.payload?.companyName || config.companyName || null;
      const resolvedPayloads = await resolveBankVoucherLedgerPayloads(
        config.tallyUrl,
        unresolvedGroup.map((command) => command.payload || {}),
        companyName
      );
      const validatedPayloads = await validateBankVoucherBillAllocationsLive(
        config,
        resolvedPayloads,
        companyName
      );
      group = unresolvedGroup.map((command, index) => ({ ...command, payload: validatedPayloads[index] }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sendCommandResults(config, unresolvedGroup.map((command) => ({
        command,
        outcome: {
          success: false,
          error: message,
          result: {
            transactionId: command.payload?.transactionId,
            sourceBankTransactionId: command.payload?.transactionId,
            beforeExecution: true,
            liveMasterValidationFailed: true,
          },
        },
      })));
      console.log(`Bank voucher batch blocked before import: ${message}`);
      continue;
    }
    let preflightByTransactionId = null;
    try {
      const targets = new Set(group.map((command) => JSON.stringify(command.payload?.target)));
      if (targets.size !== 1) throw new Error("A Tally batch cannot cross company or connector sessions.");
      await assertCommandTarget(config, group[0]);
      const firstPayload = group[0]?.payload || {};
      const batchPreflight = await reconcileBankTransactionsInTally(config, {
        companyName: firstPayload.companyName || config.companyName || null,
        bankLedgerName: firstPayload.bankLedgerName,
        // Duplicate detection only needs the voucher collection. Fetching the
        // bank closing balance here added another unrelated Tally request to
        // every post and could consume the full export timeout.
        includeBalanceProof: false,
        transactions: group.map((command) => ({
          ...command.payload,
          expectedDirection:
            command.payload?.expectedDirection ||
            (/receipt/i.test(String(command.payload?.voucherType || "")) ? "incoming" : "outgoing"),
        })),
      });
      preflightByTransactionId = new Map(
        (batchPreflight.result?.transactions || []).map((row) => [String(row.transactionId || ""), row])
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sendCommandResults(config, group.map((command) => ({
        command,
        outcome: {
          success: false,
          error: `Duplicate check could not be completed. Nothing was posted. ${message}`,
          result: {
            transactionId: command.payload?.transactionId,
            sourceBankTransactionId: command.payload?.transactionId,
            beforeExecution: true,
            duplicateCheckIncomplete: true,
          },
        },
      })));
      console.warn(`Bank voucher batch blocked because duplicate preflight was unavailable: ${message}`);
      continue;
    }

    const pendingCommands = [];
    for (const command of group) {
      try {
        const transactionId = String(command.payload?.transactionId || "");
        const preflight = preflightByTransactionId?.get(transactionId) || null;
        if (preflight?.verificationStatus === "found") {
          await sendCommandResult(config, command, {
            success: true,
            result: {
              alreadyInTally: true,
              created: 0,
              altered: 0,
              voucherId: preflight.voucherId,
              voucherNumber: preflight.voucherNumber,
              voucherDate: preflight.voucherDate,
              duplicateCheck: preflight,
              transactionId,
            },
          });
          console.log(`Command ${command.id} completed: bank transaction already existed in Tally.`);
          continue;
        }
        if (preflight?.verificationStatus === "ambiguous") {
          await sendCommandResult(config, command, {
            success: false,
            error: "Possible existing bank transaction found in Tally. Review before posting to avoid a duplicate.",
            result: {
              possibleDuplicateInTally: true,
              duplicateCheck: preflight,
              transactionId,
            },
          });
          console.log(`Command ${command.id} needs review: possible duplicate bank transaction.`);
          continue;
        }

        if (preflight?.verificationStatus !== "missing") {
          await sendCommandResult(config, command, {
            success: false,
            error: "Duplicate check returned an incomplete result. Nothing was posted.",
            result: { transactionId, beforeExecution: true, duplicateCheckIncomplete: true },
          });
          continue;
        }
        pendingCommands.push(command);
      } catch (error) {
        console.error(
          `Command ${command.id} failed without blocking the remaining vouchers: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (pendingCommands.length === 0) continue;

    const firstPayload = pendingCommands[0].payload || {};
    const companyName = firstPayload.companyName || config.companyName || null;
    let batchXml = null;
    let batchOutcome = null;
    const batchStartedAt = Date.now();
    try {
      batchXml = buildBankVoucherBatchXml(
        pendingCommands.map((command) => command.payload),
        companyName
      );
      await assertCommandTarget(config, pendingCommands[0]);
      batchOutcome = await invokeTallyXml(config.tallyUrl, batchXml);
    } catch (error) {
      batchOutcome = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        result: {},
      };
    }

    const batchElapsedMs = Date.now() - batchStartedAt;
    // Tally import counters acknowledge the envelope, not each voucher. Always
    // read every target back, even when CREATED equals the requested batch size.
    let postflightByTransactionId = null;
    try {
      const postflight = await reconcileBankTransactionsInTally(config, {
        companyName,
        bankLedgerName: firstPayload.bankLedgerName,
        includeBalanceProof: false,
        transactions: pendingCommands.map((command) => ({
          ...command.payload,
          expectedDirection:
            command.payload?.expectedDirection ||
            (/receipt/i.test(String(command.payload?.voucherType || "")) ? "incoming" : "outgoing"),
        })),
      });
      postflightByTransactionId = new Map(
        (postflight.result?.transactions || []).map((row) => [String(row.transactionId || ""), row])
      );
    } catch (error) {
      console.warn(
        `Batch postflight verification was unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const acknowledgementEntries = [];
    for (const command of pendingCommands) {
      const transactionId = String(command.payload?.transactionId || "");
      const postflight = postflightByTransactionId?.get(transactionId) || null;
      if (postflight?.verificationStatus === "found") {
        acknowledgementEntries.push({ command, outcome: {
          success: true,
          result: {
            created: 1,
            transactionId,
            sourceBankTransactionId: transactionId,
            voucherId: postflight.voucherId || command.payload?.referenceNumber || command.id,
            voucherNumber: postflight.voucherNumber || command.payload?.referenceNumber || null,
            duplicateCheck: postflight,
            verificationStatus: "verified",
            requestXml: batchXml ? previewXml(batchXml) : null,
            batchImport: true,
            batchSize: pendingCommands.length,
            batchElapsedMs,
          },
        }});
        continue;
      }

      // A successful import followed by a missing/failed read-back is uncertain,
      // never proof that it is safe to create the voucher again.
      if (batchOutcome.success || !postflight || postflight.verificationStatus !== "missing") {
        acknowledgementEntries.push({ command, outcome: {
          success: false,
          error: "The batch import outcome is uncertain. Read back Tally before retrying.",
          result: {
            transactionId,
            reconciliationRequired: true,
            possibleDuplicateInTally: true,
            uncertaintyReason: !postflight ? "readback_unavailable" : "readback_did_not_confirm_import",
            importSummary: batchOutcome.result || {},
          },
        }});
        continue;
      }
      try {
        await runCommand(
          config,
          {
            ...command,
            payload: {
              ...command.payload,
              preflightVerifyExisting: postflightByTransactionId === null,
            },
          },
          options
        );
      } catch (error) {
        console.error(
          `Command ${command.id} failed after batch isolation: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    // The Tally import and postflight are already batch operations. Acknowledging
    // each command one by one made a 50-row post spend roughly two minutes on
    // avoidable API round trips. Keep per-command state, but report it in bounded
    // concurrent groups so Supabase and the bridge remain protected.
    if (acknowledgementEntries.length > 0) {
      await sendCommandResults(config, acknowledgementEntries, 10);
    }
  }
}

async function postCustomerAdvanceAdjustment(tallyUrl, payload, companyName) {
  const xml = buildCustomerAdvanceAdjustmentXml(payload, companyName);
  const outcome = requireCreatedVoucher(await invokeTallyXml(tallyUrl, xml));

  return { outcome, xml };
}

async function postDebitNote(tallyUrl, payload, companyName) {
  const xml = buildDebitNoteXml(payload, companyName);
  const outcome = requireCreatedVoucher(await invokeTallyXml(tallyUrl, xml));

  return { outcome, xml };
}

async function invokeTallyXml(tallyUrl, xml) {
  const controller = new AbortController();
  let timeout;

  try {
    const response = await Promise.race([
      fetch(tallyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml",
        },
        body: xml,
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          const error = new Error("Tally import timed out.");
          error.name = "AbortError";
          reject(error);
        }, TALLY_IMPORT_TIMEOUT_MS);
      }),
    ]);

    const text = await response.text();
    return parseTallyImportResult(text, response.status);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function previewXml(xml) {
  return xml.replace(/\s+/g, " ").trim().slice(0, 4000);
}

async function exportTallyCollection(tallyUrl, options) {
  return exportTallyXml(
    tallyUrl,
    buildCollectionExportXml(options),
    options.collectionName,
    options.timeoutMs
  );
}

async function exportTallyXml(tallyUrl, xml, label = "Tally export", timeoutMs = TALLY_EXPORT_TIMEOUT_MS) {
  const readContext = cashDiscountReadContext.getStore();
  if (readContext?.schedule && !readContext.inTallyLane) {
    return readContext.schedule(() => cashDiscountReadContext.run({ ...readContext, inTallyLane: true },
      () => exportTallyXml(tallyUrl, xml, label, timeoutMs)),
      { signal: readContext.signal, deadlineAt: readContext.deadlineAt, priority: 50 });
  }
  const benchmarkStartedAt = performance.now();
  let benchmarkResponseBytes = 0;
  let benchmarkSuccess = false;
  let benchmarkError = null;
  checkReadBudget(readContext);
  const controller = new AbortController();
  let boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : TALLY_EXPORT_TIMEOUT_MS;
  if (readContext) boundedTimeoutMs = Math.max(1, Math.min(boundedTimeoutMs, CASH_DISCOUNT_READ_MS, readContext.deadlineAt - Date.now()));
  const timeout = setTimeout(() => controller.abort(), boundedTimeoutMs);

  try {
    const response = await fetch(tallyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
      },
      body: xml,
      signal: readContext?.signal ? AbortSignal.any([controller.signal, readContext.signal]) : controller.signal,
    });

    const text = readContext ? await readBoundedXml(response) : await response.text();
    benchmarkResponseBytes = Buffer.byteLength(text);
    if (readContext && (!/<ENVELOPE[\s>]/i.test(text) || !/<\/ENVELOPE>\s*$/i.test(text))) {
      throw new Error(`Tally returned incomplete XML for ${label}.`);
    }
    const result = parseExportResult(text, response.status);
    if (!result.success) {
      throw new Error(
        result.error ||
          `Tally export failed for ${label} with HTTP ${response.status}.`
      );
    }

    benchmarkSuccess = true;
    return text;
  } catch (error) {
    benchmarkError = error instanceof Error ? error.message : String(error);
    if (error?.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(boundedTimeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    recordConnectorTallyRead(readContext?.benchmark, {
      label,
      durationMs: performance.now() - benchmarkStartedAt,
      requestBytes: Buffer.byteLength(xml),
      responseBytes: benchmarkResponseBytes,
      success: benchmarkSuccess,
      error: benchmarkError,
    });
  }
}

// Open bills indexed by pending amount (in paise), from customer dues.
// Tally's bill closing balance is negative for receivables (customer owes us)
// and positive for payables (we owe the supplier). Rebuilt only when the
// customer dues change (their Tally change counter moves).
const openBillAmountIndexCache = new Map();

export function buildOpenBillAmountIndex(billXml) {
  const byPaise = new Map();
  for (const block of extractBlocks(billXml, "BILL")) {
    const ledgerName = billLedgerName(block);
    const bill = ledgerName ? toOpenBill(block, ledgerName) : null;
    if (!bill || bill.kind !== "bill") continue;
    const closing = parseTallyAmount(getTagText(block, "CLOSINGBALANCE")) ??
      parseTallyAmount(getTagText(block, "PENDINGAMOUNT")) ?? parseTallyAmount(getTagText(block, "AMOUNT"));
    if (!closing) continue;
    const paise = Math.round(bill.pendingAmount * 100);
    const entry = { ledgerName, referenceName: bill.referenceName, invoiceDate: bill.invoiceDate, pendingAmount: bill.pendingAmount,
      direction: closing < 0 ? "receipt" : "payment" };
    byPaise.set(paise, [...(byPaise.get(paise) || []), entry]);
  }
  return byPaise;
}

async function openBillAmountIndex(prepared) {
  const key = `${prepared.datasetKey}|${prepared.state?.watermark ?? ""}|${prepared.state?.lastChangeAt ?? prepared.state?.preparedAt ?? ""}`;
  const cached = openBillAmountIndexCache.get(prepared.datasetKey);
  if (cached?.key === key) return cached.index;
  const index = openBillAmountIndexFromFields(await prepared.allBills());
  openBillAmountIndexCache.set(prepared.datasetKey, { key, index });
  return index;
}

// Suggestions for one bank line: parties with an open bill of exactly the
// line's amount (to the paisa), then within Rs 1. Money in (receipt) matches
// receivable bills; money out (payment) matches payable bills. Only used as
// suggestions; the user still confirms.
export function matchOpenBillsByAmount(byPaise, query, { maxParties = 3 } = {}) {
  const amount = Number(query?.amount);
  const direction = query?.direction === "payment" ? "payment" : query?.direction === "receipt" ? "receipt" : null;
  if (!(amount > 0) || !direction) return [];
  const paise = Math.round(amount * 100);
  const exact = (byPaise.get(paise) || []).filter((entry) => entry.direction === direction);
  const near = [];
  if (!exact.length) {
    for (let offset = -100; offset <= 100; offset += 1) {
      if (offset === 0) continue;
      for (const entry of byPaise.get(paise + offset) || []) if (entry.direction === direction) near.push(entry);
    }
  }
  const candidates = exact.length ? exact : near;
  const byParty = new Map();
  for (const entry of candidates) {
    const key = normalizeLooseName(entry.ledgerName);
    if (!byParty.has(key)) byParty.set(key, entry);
  }
  // Too many parties with the same amount is not a useful signal.
  if (!byParty.size || byParty.size > maxParties) return [];
  return [...byParty.values()].map((entry) => ({
    ledger: { name: entry.ledgerName },
    score: exact.length ? 0.99 : 0.9,
    source: exact.length ? "open_bill_amount" : "open_bill_amount_near",
    openBill: { referenceName: entry.referenceName, invoiceDate: entry.invoiceDate, pendingAmount: entry.pendingAmount },
  }));
}

export function uniqueVoucherBlocks(xml) {
  const seen = new Set();
  return String(xml || "").replace(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g, (block) => {
    const identity = getAttribute(block, "REMOTEID") || getTagText(block, "GUID") || getTagText(block, "MASTERID");
    if (!identity) return block;
    if (seen.has(identity)) return "";
    seen.add(identity);
    return block;
  });
}

async function exportCompactCashDiscountEvidenceXml(
  tallyUrl,
  { companyName, ledgerNames, dateFrom, dateTo },
  exportCollection = exportTallyCollection,
  exportXml = exportTallyXml
) {
  // Native `Vouchers : Ledger` collections are materially faster than a
  // company-wide Voucher filter in Tally. Combine a bounded number of those
  // native collections into one union so Tally pays the HTTP/report setup cost
  // once per batch instead of once per customer.
  const names = uniquePayloadLedgerNames({ ledgerNames });
  if (names.length === 0) return { xml: "", batchCount: 0, dateChunkCount: 0, retrySplitCount: 0, queryMode: "native_ledger_union" };
  // Bound historical traversal as well as ledger count. Disjoint inclusive
  // windows preserve receipts and carry-forward evidence without duplication.
  const startDate = Date.parse(`${dateFrom}T00:00:00Z`);
  const endDate = Date.parse(`${dateTo}T00:00:00Z`);
  const dayMs = 86_400_000;
  if (Number.isFinite(startDate) && Number.isFinite(endDate) && endDate - startDate >= 90 * dayMs) {
    const parts = [];
    let totalBytes = 0;
    let batchCount = 0;
    for (let from = startDate; from <= endDate; from += 90 * dayMs) {
      checkReadBudget();
      const part = await exportCompactCashDiscountEvidenceXml(tallyUrl, {
        companyName, ledgerNames: names,
        dateFrom: new Date(from).toISOString().slice(0,10),
        dateTo: new Date(Math.min(endDate, from + 89 * dayMs)).toISOString().slice(0,10),
      }, exportCollection, exportXml);
      totalBytes += Buffer.byteLength(part.xml);
      if (totalBytes > CASH_DISCOUNT_RESULT_BYTES * 2) throw new Error('Cash Discount evidence exceeded its safe size limit.');
      parts.push(part.xml); batchCount += part.batchCount;
    }
    // Tally ignores the date range on "Vouchers : Ledger" unions, so every
    // window returns the whole year. Keep each voucher once; otherwise receipts
    // are counted once per window and invoices look paid when they are not.
    return { xml: uniqueVoucherBlocks(parts.join('\n')), batchCount, dateChunkCount:parts.length, retrySplitCount:0, queryMode:'native_ledger_union_windowed' };
  }
  if (names.length === 1) {
    const xml = await exportCollection(tallyUrl, {
      collectionName: "Kalika Cash Discount Ledger Evidence",
      tallyType: "Vouchers : Ledger",
      childOf: tallyFormulaString(names[0]),
      fetchFields: CASH_DISCOUNT_VOUCHER_FIELDS,
      companyName,
      dateFrom,
      dateTo,
      timeoutMs: CASH_DISCOUNT_READ_MS,
    });
    return { xml, batchCount: 1, dateChunkCount: 1, retrySplitCount: 0, queryMode: "ledger_scoped" };
  }

  const batchSize = cashDiscountNativeUnionBatchSize();
  const responses = [];
  let bytes = 0;
  const batches = chunkValues(names, batchSize);
  for (const [index, batch] of batches.entries()) {
    checkReadBudget();
    const collectionNames = batch.map((_, memberIndex) => `KalikaCashDiscountLedger${memberIndex + 1}`);
    const memberCollections = batch.map((ledgerName, memberIndex) => [
      `<COLLECTION NAME="${collectionNames[memberIndex]}" ISMODIFY="No">`,
      "<TYPE>Vouchers : Ledger</TYPE>",
      `<CHILDOF>${escapeXml(tallyFormulaString(ledgerName))}</CHILDOF>`,
      `<FETCH>${escapeXml(CASH_DISCOUNT_VOUCHER_FIELDS)}</FETCH>`,
      "</COLLECTION>",
    ].join("")).join("");
    const unionName = `Kalika Cash Discount Evidence Union ${index + 1}`;
    const xml = await exportXml(tallyUrl, [
      "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>",
      `<ID>${escapeXml(unionName)}</ID></HEADER><BODY><DESC><STATICVARIABLES>`,
      companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : "",
      dateFrom ? `<SVFROMDATE TYPE="Date">${escapeXml(String(dateFrom).replaceAll("-", ""))}</SVFROMDATE>` : "",
      dateTo ? `<SVTODATE TYPE="Date">${escapeXml(String(dateTo).replaceAll("-", ""))}</SVTODATE>` : "",
      "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>",
      memberCollections,
      `<COLLECTION NAME="${escapeXml(unionName)}" ISMODIFY="No"><COLLECTIONS>${collectionNames.join(",")}</COLLECTIONS>`,
      `<FETCH>${escapeXml(CASH_DISCOUNT_VOUCHER_FIELDS)}</FETCH></COLLECTION>`,
      "</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>",
    ].join(""), unionName, CASH_DISCOUNT_READ_MS);
    bytes += Buffer.byteLength(xml);
    if (bytes > CASH_DISCOUNT_RESULT_BYTES * 2) throw new Error("Cash Discount evidence exceeded its safe size limit.");
    responses.push(xml);
  }
  return {
    xml: responses.join("\n"),
    batchCount: responses.length,
    dateChunkCount: 1,
    retrySplitCount: 0,
    queryMode: "native_ledger_union",
  };
}

function toMaster(block, tagName) {
  const name = getAttribute(block, "NAME") || getTagText(block, "NAME");
  if (!name) return null;
  const optionalMasterValue = (value) => {
    const normalized = cleanXmlText(value);
    return !normalized || /^(?:not\s+found|not\s+available|n\/?a|none|null|undefined|-+)$/i.test(normalized)
      ? null
      : normalized;
  };
  const gstinFromBlock = () => {
    for (const candidate of getXmlValues(block, [
      "PARTYGSTIN", "GSTIN", "GSTREGISTRATIONNUMBER", "GSTREGNUMBER",
      "GSTNO", "GSTNUMBER", "GSTIDENTIFICATIONNUMBER", "LEDGERGSTIN",
    ])) {
      const normalized = candidate.replace(/\s+/g, "").toUpperCase();
      if (/^\d{2}[0-9A-Z]{13}$/.test(normalized)) return normalized;
    }
    return null;
  };

  const bankName =
    getTagText(block, "BANKNAME") ||
    getTagText(block, "BANK") ||
    getTagText(block, "BANKERNAME");
  const bankAccountNumber =
    getTagText(block, "BANKACCOUNTNUMBER") ||
    getTagText(block, "ACCOUNTNUMBER") ||
    getTagText(block, "BANKACCOUNTNO") ||
    getTagText(block, "BANKACNO") ||
    getTagText(block, "ACNUMBER");
  const ifscCode =
    getTagText(block, "IFSCCODE") ||
    getTagText(block, "IFSCODE") ||
    getTagText(block, "IFSC") ||
    getTagText(block, "BANKIFSCCODE");
  const branchName =
    getTagText(block, "BRANCHNAME") ||
    getTagText(block, "BANKBRANCHNAME") ||
    getTagText(block, "BRANCH");
  const accountHolderName =
    getTagText(block, "BANKACCHOLDERNAME") ||
    getTagText(block, "BANKACCOUNTNAME") ||
    getTagText(block, "BANKACCOUNTHOLDERNAME") ||
    getTagText(block, "ACCOUNTHOLDERNAME");
  const email =
    getTagText(block, "EMAIL") ||
    getTagText(block, "EMAILID") ||
    getTagText(block, "LEDGEREMAIL") ||
    getTagText(block, "LEDGEREMAILID");
  const phone =
    getTagText(block, "LEDGERMOBILE") ||
    getTagText(block, "MOBILE") ||
    getTagText(block, "MOBILENO") ||
    getTagText(block, "PHONENUMBER") ||
    getTagText(block, "PHONE") ||
    getTagText(block, "LEDGERPHONE");
  const contactPerson =
    getTagText(block, "LEDGERCONTACT") ||
    getTagText(block, "CONTACTPERSON") ||
    getTagText(block, "CONTACT") ||
    getTagText(block, "ATTENTIONTO");
  const address = [
    ...getTagTexts(block, "ADDRESS"),
    getTagText(block, "ADDRESS1"),
    getTagText(block, "ADDRESS2"),
    getTagText(block, "ADDRESS3"),
    getTagText(block, "ADDRESS4"),
    getTagText(block, "PINCODE"),
  ].filter(Boolean).join(", ");
  const taxRate =
    getTagText(block, "RATEOFTAXCALCULATION") ||
    getTagText(block, "GSTTAXRATE") ||
    getTagText(block, "GSTRATE") ||
    getTagText(block, "RATEOFVAT");
  const closingBalance = parseLedgerClosingBalance(getTagText(block, "CLOSINGBALANCE"));

  return {
    name,
    guid: getTagText(block, "GUID"),
    parent: getTagText(block, "PARENT"),
    gstin: optionalMasterValue(gstinFromBlock()),
    bankName,
    bankAccountNumber,
    ifscCode,
    branchName,
    accountHolderName,
    email,
    phone,
    contactPerson,
    address,
    hsnCode: optionalMasterValue(hsnCodeFromBlock(
      block,
      "GSTHSNCODE",
      "GSTHSNSACCODE",
      "HSNCODE",
      "HSNSACCODE",
      "GSTOVRDNHSNCODE",
      "HSNOVRDNCLASSIFICATION",
      "HSN",
      "HSNSAC",
      "HSNCLASSIFICATION",
      "GSTHSNNAME",
      "GSTHSNSACNAME",
      "HSNSACNAME",
      "HSNNAME",
      "HSNDESCRIPTION"
    )),
    unitName: optionalMasterValue(getTagText(block, "BASEUNITS") || getTagText(block, "ORIGINALBASEUNITS")),
    taxRate: optionalMasterValue(taxRate),
    closingBalance: closingBalance.amount,
    closingBalanceType: closingBalance.type,
    raw: {
      tallyTag: tagName,
      reservedName: getAttribute(block, "RESERVEDNAME"),
      bankName,
      bankAccountNumber,
      ifscCode,
      branchName,
      accountHolderName,
      taxType: getTagText(block, "TAXTYPE"),
      gstDutyHead: getTagText(block, "GSTDUTYHEAD"),
      decimalPlaces: Number.isFinite(Number(getTagText(block, "DECIMALPLACES")))
        ? Number(getTagText(block, "DECIMALPLACES"))
        : null,
      billWiseEnabled: /^yes$/i.test(getTagText(block, "ISBILLWISEON")),
      closingBalance: closingBalance.amount,
      closingBalanceType: closingBalance.type,
      closingBalanceRaw: closingBalance.raw,
      email,
      phone,
      contactPerson,
      address,
      stateName: getTagText(block, "STATENAME") || getTagText(block, "STATE"),
      countryName: getTagText(block, "COUNTRYNAME") || getTagText(block, "COUNTRY"),
    },
  };
}

function dedupeMasters(masters) {
  const seen = new Set();
  const result = [];

  for (const master of masters) {
    const key = `${master.guid || ""}:${master.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(master);
  }

  return result;
}

function parseMasterCollection(xml, tagName) {
  return dedupeMasters(
    extractBlocks(xml, tagName)
      .map((block) => toMaster(block, tagName))
      .filter(Boolean)
  );
}

function parseNativeLedgerRegistrationXml(xml, ledgerName) {
  const nativeLedgers = parseMasterCollection(xml, "LEDGER");
  if (nativeLedgers.length > 0) return nativeLedgers;

  // Some Tally releases return an OBJECT export as a bare payload instead of
  // wrapping it in a LEDGER element. Re-wrap only the response body so the
  // normal, validated GSTIN parser remains the single source of truth.
  const response = String(xml || "").trim();
  if (!response) return [];
  const wrapped = `<LEDGER NAME="${escapeXml(ledgerName)}"><NAME>${escapeXml(ledgerName)}</NAME>${response}</LEDGER>`;
  const master = toMaster(wrapped, "LEDGER");
  return master?.gstin ? [master] : [];
}

async function exportNativeLedgerGstRegistrations(
  tallyUrl,
  { companyName, ledgerNames },
  exportXml = exportTallyXml
) {
  const names = [...new Set((ledgerNames || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))].slice(0, 10);
  const masters = [];
  for (const ledgerName of names) {
    const xml = await exportXml(
      tallyUrl,
      buildLedgerGstRegistrationExportXml({ companyName, ledgerName }),
      `Purchase supplier GST registration: ${ledgerName}`
    );
    const parsed = parseNativeLedgerRegistrationXml(xml, ledgerName);
    const exact = parsed.find((master) => normalizeLooseName(master.name) === normalizeLooseName(ledgerName));
    if (exact?.gstin) masters.push(exact);
  }
  return masters;
}

// Some Tally Prime releases omit PartyGSTIN from a broad Ledger collection
// while returning it for an exact named-master dereference. Merge only fields
// read from that exact Tally master; never infer a ledger GSTIN from an invoice.
function mergeTargetedPurchaseLedgerDetails(ledgers, targetedDetails) {
  const targetedByName = new Map(
    (targetedDetails || []).map((master) => [normalizeLooseName(master?.name), master])
  );
  return (ledgers || []).map((ledger) => {
    const targeted = targetedByName.get(normalizeLooseName(ledger?.name));
    if (!targeted) return ledger;
    return {
      ...ledger,
      guid: targeted.guid || ledger.guid,
      parent: targeted.parent || ledger.parent,
      gstin: targeted.gstin || ledger.gstin || null,
      raw: { ...(ledger.raw || {}), ...(targeted.raw || {}) },
    };
  });
}

const PURCHASE_MASTER_DIAGNOSTIC_TAGS = Object.freeze({
  ledger: [
    "PARTYGSTIN", "GSTIN", "GSTREGISTRATIONNUMBER", "GSTREGNUMBER",
    "GSTNO", "GSTNUMBER", "GSTIDENTIFICATIONNUMBER", "LEDGERGSTIN",
    "GSTDETAILS", "GSTREGISTRATIONDETAILS", "LEDGERGSTREGISTRATIONDETAILS", "LEDGSTREGDETAILS",
  ],
  stock_item: [
    "GSTHSNCODE", "GSTHSNSACCODE", "HSNCODE", "HSNSACCODE",
    "GSTOVRDNHSNCODE", "HSNOVRDNCLASSIFICATION", "HSN", "HSNSAC",
    "HSNCLASSIFICATION", "GSTHSNNAME", "GSTHSNSACNAME", "HSNSACNAME",
    "HSNNAME", "HSNDESCRIPTION", "GSTHSN", "GSTDETAILS", "GSTHSNDETAILS",
    "HSNDETAILS",
  ],
});

function diagnosticMasterName(block) {
  return getAttribute(block, "NAME") || getTagText(block, "NAME") || "";
}

function diagnosticTagEvidence(block, tagNames) {
  return Object.fromEntries(tagNames.flatMap((tagName) => {
    const values = getTagTexts(block, tagName);
    const attribute = getAttributeFromAnyElement(block, tagName);
    if (attribute) values.push(`@attribute:${attribute}`);
    const unique = [...new Set(values.filter(Boolean))];
    return unique.length ? [[tagName, unique]] : [];
  }));
}

function purchaseMasterDiagnostics(xml, tagName, requestedNames = []) {
  const normalizedTagName = String(tagName || "").toLowerCase();
  const targets = [...new Set(requestedNames
    .map((value) => String(value || "").trim())
    .filter(Boolean))].slice(0, 10);
  if (!targets.length) return [];

  const blocks = extractBlocks(xml, tagName);
  const tagNames = PURCHASE_MASTER_DIAGNOSTIC_TAGS[normalizedTagName] || [];
  return targets.map((requestedName) => {
    const block = blocks.find((candidate) => normalizeLooseName(diagnosticMasterName(candidate)) === normalizeLooseName(requestedName));
    if (!block) {
      return { requestedName, found: false, availableBlockCount: blocks.length };
    }
    const parsed = toMaster(block, tagName);
    return {
      requestedName,
      found: true,
      returnedName: diagnosticMasterName(block),
      parsed: parsed
        ? { gstin: parsed.gstin || null, hsnCode: parsed.hsnCode || null, unitName: parsed.unitName || null, parent: parsed.parent || null }
        : null,
      tagEvidence: diagnosticTagEvidence(block, tagNames),
      rawXml: block.slice(0, 50_000),
    };
  });
}

function toVoucher(block) {
  const ledgerEntries = extractBlocks(block, "ALLLEDGERENTRIES.LIST")
    .map((entry) => ({
      ledgerName: getTagText(entry, "LEDGERNAME"),
      amount: parseTallyAmount(getTagText(entry, "AMOUNT")),
      isDebit: /^yes$/i.test(getTagText(entry, "ISDEEMEDPOSITIVE") || ""),
    }))
    .filter((entry) => entry.ledgerName);
  const ledgerNames = ledgerEntries.map((entry) => entry.ledgerName).filter(Boolean);
  const bankReferences = extractBlocks(block, "BANKALLOCATIONS.LIST")
    .flatMap((entry) => [
      getTagText(entry, "INSTRUMENTNUMBER"),
      getTagText(entry, "TRANSACTIONNAME"),
      getTagText(entry, "NAME"),
    ])
    .filter(Boolean);
  const inventoryEntries = extractBlocks(block, "ALLINVENTORYENTRIES.LIST")
    .map((entry) => {
      const batch = extractBlocks(entry, "BATCHALLOCATIONS.LIST")[0] || "";
      return ({
      stockItemName: getTagText(entry, "STOCKITEMNAME"),
      description: getTagText(entry, "DESCRIPTION"),
      hsn:
        hsnCodeFromBlock(
          entry,
          "HSNOVRDNCLASSIFICATION",
          "GSTOVRDNHSNCODE",
          "GSTHSNCODE",
          "GSTHSNSACCODE",
          "HSNCODE",
          "HSNSACCODE",
          "HSN",
          "HSNSAC",
          "HSNCLASSIFICATION",
          "GSTHSNNAME",
          "GSTHSNSACNAME",
          "HSNSACNAME"
        ),
      quantity: getTagText(entry, "BILLEDQTY") || getTagText(entry, "ACTUALQTY"),
      rate: getTagText(entry, "RATE"),
      signedAmount: parseTallyAmount(getTagText(entry, "AMOUNT")),
      amount: Math.abs(parseTallyAmount(getTagText(entry, "AMOUNT")) ?? 0),
      godownName: getTagText(batch, "GODOWNNAME") || getTagText(batch, "DESTINATIONGODOWNNAME"),
      batchName: getTagText(batch, "BATCHNAME"),
      purchaseLedgerName:
        extractBlocks(entry, "ACCOUNTINGALLOCATIONS.LIST")
          .map((allocation) => getTagText(allocation, "LEDGERNAME"))
          .find(Boolean) || null,
    }); })
    .filter((entry) => entry.stockItemName);
  const billAllocations = extractBlocks(block, "BILLALLOCATIONS.LIST")
    .map((allocation) => ({
      referenceName: getTagText(allocation, "NAME"),
      billType: getTagText(allocation, "BILLTYPE") || getTagText(allocation, "TYPEOFREF"),
      billDate: getTagText(allocation, "BILLDATE"),
      amount: Math.abs(parseTallyAmount(getTagText(allocation, "AMOUNT")) ?? 0),
    }))
    .filter((allocation) => allocation.referenceName && allocation.amount > 0);

  return {
    date: getTagText(block, "DATE"),
    effectiveDate: getTagText(block, "EFFECTIVEDATE"),
    voucherType: getTagText(block, "VOUCHERTYPENAME") || getAttribute(block, "VCHTYPE"),
    voucherNumber: getTagText(block, "VOUCHERNUMBER"),
    reference: getTagText(block, "REFERENCE"),
    referenceDate: getTagText(block, "REFERENCEDATE"),
    narration: getTagText(block, "NARRATION"),
    partyLedgerName: getTagText(block, "PARTYLEDGERNAME"),
    ledgerNames,
    ledgerEntries,
    bankReferences,
    billAllocations,
    inventoryEntries,
    masterId: getTagText(block, "MASTERID"),
    alterId: getTagText(block, "ALTERID"),
    guid: getTagText(block, "GUID"),
    isCancelled: getTagText(block, "ISCANCELLED"),
    sourceDocumentPath: getUdfTagText(block, "KALIKASOURCEDOCUMENTPATH"),
    sourceDocumentName: getUdfTagText(block, "KALIKASOURCEDOCUMENTNAME"),
    sourceDocumentSha256: getUdfTagText(block, "KALIKASOURCEDOCUMENTSHA256"),
    sourceDocumentId: getUdfTagText(block, "KALIKASOURCEDOCUMENTID"),
    vehicleNumber: getUdfTagText(block, "KALIKAVEHICLENUMBER"),
    // The client's Attach Documents add-on path (readable when their TDL is loaded).
    linkDocumentPath: getUdfTagText(block, "UDFFORLINKDOCUMENTFILE"),
    rawPreview: previewXml(block),
  };
}

function parseVoucherCollection(xml) {
  return extractBlocks(xml, "VOUCHER").map(toVoucher);
}

function isSameTallyText(left, right) {
  const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return Boolean(normalize(left) && normalize(left) === normalize(right));
}

function isNumericMasterId(value) {
  return /^\d+$/.test(String(value ?? "").trim());
}

export async function resolveDebitNoteVoucher(tallyUrl, payload, fallbackCompanyName) {
  const companyName = payload?.companyName || fallbackCompanyName;
  const requestedMasterId = String(payload?.tallyVoucherId || payload?.voucherId || "").trim();
  const requestedReference = String(payload?.referenceNumber || payload?.expectedReference || "").trim();
  const requestedParty = String(payload?.partyLedgerName || "").trim();
  const requestedAmount = Number(payload?.amount ?? 0);
  if (!isNumericMasterId(requestedMasterId) && !requestedReference) throw new Error("Debit Note verification requires an ID or reference.");
  const identityFormula = isNumericMasterId(requestedMasterId)
    ? `$MasterID = ${requestedMasterId}`
    : `$$IsEqual:$Reference:${tallyFormulaString(requestedReference)}`;
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Debit Note Voucher Lookup",
    formulae: [{ name: "KalikaDebitNoteIdentity", formula: identityFormula }],
    filterNames: ["KalikaDebitNoteIdentity"],
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,GUID,IsCancelled,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive",
    companyName,
    // Tally's default collection window ends at its current date. Debit Notes
    // created with a future-effective date must still be found and exported.
    dateFrom: "2000-04-01",
    dateTo: "2099-03-31",
  });
  const vouchers = parseVoucherCollection(xml).filter(
    (voucher) => isSameTallyText(voucher.voucherType, "Debit Note") && !/^yes$/i.test(voucher.isCancelled || "")
  );

  let matches = isNumericMasterId(requestedMasterId)
    ? vouchers.filter((voucher) => String(voucher.masterId || "") === requestedMasterId)
    : [];

  if (matches.length === 0 && requestedReference) {
    matches = vouchers.filter((voucher) => isSameTallyText(voucher.reference, requestedReference));
  }
  // Validate identity conflicts below instead of treating them as absent.

  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "Tally did not return the expected Debit Note for native PDF export."
        : "More than one Tally Debit Note matched this request. Native PDF export was stopped."
    );
  }

  const voucher = matches[0];
  if (!voucher.masterId || !voucher.voucherNumber) {
    throw new Error("Tally returned a Debit Note without a MasterID or voucher number.");
  }
  if (requestedReference && !isSameTallyText(voucher.reference, requestedReference)) {
    throw new Error("Tally Debit Note reference does not match the Kalika request.");
  }
  if (requestedParty && !voucherHasLedger(voucher, requestedParty)) {
    throw new Error("Tally Debit Note customer does not match the Kalika request.");
  }
  if (requestedAmount > 0 && !voucherHasAnyAmount(voucher, requestedAmount)) {
    throw new Error("Tally Debit Note amount does not match the Kalika request.");
  }
  validateDebitNoteLedgerSides(voucher, payload);
  return voucher;
}

export function validateDebitNoteLedgerSides(voucher, payload) {
  const amount = Number(payload?.amount || 0);
  if (!(amount > 0)) return;
  for (const [name, debit] of [[payload.partyLedgerName, true], [payload.salesLedgerName, false]]) {
    if (!name) continue;
    const entries = voucher.ledgerEntries.filter(entry => isSameTallyText(entry.ledgerName, name));
    const total = entries.reduce((sum, entry) => sum + Math.abs(Number(entry.amount)), 0);
    if (!entries.length || entries.some(entry => entry.isDebit !== debit) || !Number.isFinite(total) || Math.abs(total - amount) > 0.005) {
      throw new Error(`Tally Debit Note ${debit ? 'customer debit' : 'sales credit'} does not match the request. Verify the existing entry before retrying.`);
    }
  }
}

function debitNoteVoucherAmount(voucher) {
  return voucher.ledgerEntries.reduce((largest, entry) => Math.max(largest, Math.abs(Number(entry.amount) || 0)), 0);
}

function debitNotePartyName(voucher, requestedParty) {
  return voucher.partyLedgerName || voucher.ledgerNames.find((ledgerName) => isSameTallyText(ledgerName, requestedParty)) || null;
}

function escapeHtml(value) {
  return escapeXml(value ?? "");
}

function formatDebitNoteDate(value) {
  const raw = String(value ?? "").trim();
  const compactDate = /^\d{8}$/.test(raw)
    ? raw
    : /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw.replaceAll("-", "")
      : "";
  if (compactDate) {
    const [, year, month, day] = compactDate.match(/^(\d{4})(\d{2})(\d{2})$/) || [];
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (!Number.isNaN(date.valueOf())) {
      return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "2-digit",
        timeZone: "UTC",
      }).format(date).replace(/ /g, "-");
    }
  }
  return raw || "—";
}

function formatIndianAmount(value) {
  const amount = Math.abs(Number(value) || 0);
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function amountInIndianWords(value) {
  const number = Math.round(Math.abs(Number(value) || 0) * 100);
  const rupees = Math.floor(number / 100);
  const paise = number % 100;
  const small = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const underThousand = (input) => {
    const valueToRead = Math.trunc(input);
    const parts = [];
    if (valueToRead >= 100) parts.push(`${small[Math.floor(valueToRead / 100)]} Hundred`);
    const remainder = valueToRead % 100;
    if (remainder >= 20) parts.push(`${tens[Math.floor(remainder / 10)]}${remainder % 10 ? ` ${small[remainder % 10]}` : ""}`);
    else if (remainder > 0) parts.push(small[remainder]);
    return parts.join(" ");
  };
  const whole = (input) => {
    if (input === 0) return "Zero";
    const parts = [];
    const crore = Math.floor(input / 10000000);
    const lakh = Math.floor((input % 10000000) / 100000);
    const thousand = Math.floor((input % 100000) / 1000);
    const rest = input % 1000;
    if (crore) parts.push(`${underThousand(crore)} Crore`);
    if (lakh) parts.push(`${underThousand(lakh)} Lakh`);
    if (thousand) parts.push(`${underThousand(thousand)} Thousand`);
    if (rest) parts.push(underThousand(rest));
    return parts.join(" ");
  };
  return `INR ${whole(rupees)}${paise ? ` and ${whole(paise)} Paise` : ""} Only`;
}

function buildVerifiedDebitNoteHtml({ companyName, voucher, requestedParty }) {
  const partyName = debitNotePartyName(voucher, requestedParty);
  const amount = debitNoteVoucherAmount(voucher);
  const reference = voucher.reference || voucher.voucherNumber || "—";
  const particulars = voucher.narration || `Debit note against reference ${reference}.`;
  const visibleAmount = formatIndianAmount(amount);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      @page { size: A4; margin: 15mm 17mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #111; font: 12px Arial, sans-serif; }
      .document { min-height: 255mm; display: flex; flex-direction: column; }
      .company { font-size: 16px; font-weight: 700; text-align: center; margin: 2px 0 16px; }
      .title { font-size: 18px; font-weight: 700; text-align: center; margin: 0 0 18px; }
      .details { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 30px; margin-bottom: 18px; }
      .label { color: #333; display: inline-block; min-width: 68px; margin-right: 8px; }
      .party { margin: 0 0 18px; font-size: 13px; }
      .party strong { font-size: 14px; }
      table { border-collapse: collapse; width: 100%; }
      th { border-top: 1px solid #111; border-bottom: 1px solid #111; padding: 7px 6px; text-align: left; font-weight: 700; }
      th:last-child, td:last-child { width: 155px; text-align: right; border-left: 1px solid #111; }
      td { vertical-align: top; padding: 18px 7px 122px; line-height: 1.45; }
      .words { width: 72%; padding-top: 0; font-weight: 700; }
      .total-row td { border-top: 1px solid #111; padding: 8px 7px; font-weight: 700; }
      .narration { border-top: 1px solid #111; margin-top: 18px; padding: 8px 0; }
      .footer { margin-top: auto; padding-top: 32px; text-align: right; font-weight: 700; }
      .signatory { margin-top: 70px; text-align: right; }
    </style>
  </head>
  <body>
    <main class="document" data-kalika-voucher-id="${escapeHtml(voucher.masterId)}">
      <div class="company">${escapeHtml(companyName)}</div>
      <div class="title">Debit Note</div>
      <section class="details">
        <div><span class="label">No.</span><strong>${escapeHtml(voucher.voucherNumber)}</strong></div>
        <div><span class="label">Dated</span><strong>${escapeHtml(formatDebitNoteDate(voucher.date || voucher.effectiveDate))}</strong></div>
        <div><span class="label">Ref.</span><strong>${escapeHtml(reference)}</strong></div>
      </section>
      <p class="party"><span class="label">Party's Name</span><strong>${escapeHtml(partyName)}</strong></p>
      <table>
        <thead><tr><th>Particulars</th><th>Amount</th></tr></thead>
        <tbody>
          <tr><td>${escapeHtml(particulars)}</td><td><strong>₹ ${escapeHtml(visibleAmount)}</strong></td></tr>
          <tr><td class="words">Amount (in words):<br>${escapeHtml(amountInIndianWords(amount))}</td><td></td></tr>
          <tr class="total-row"><td>Total</td><td>₹ ${escapeHtml(visibleAmount)}</td></tr>
        </tbody>
      </table>
      <div class="narration"><strong>Narration:</strong><br>${escapeHtml(voucher.narration || particulars)}</div>
      <div class="footer">for ${escapeHtml(companyName)}</div>
      <div class="signatory">Authorised Signatory</div>
    </main>
  </body>
</html>`;
}

function assertVerifiedDebitNoteHtml(html, voucher, requestedParty) {
  const visibleText = decodeXmlEntities(String(html ?? ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const partyName = debitNotePartyName(voucher, requestedParty);
  const amount = formatIndianAmount(debitNoteVoucherAmount(voucher));
  const expected = ["debit note", voucher.voucherNumber, partyName, amount];
  const missing = expected.filter((value) => value && !visibleText.includes(String(value).toLowerCase()));
  if (missing.length > 0) {
    throw new Error("Tally Debit Note PDF verification failed: voucher number, customer, or amount is missing from the document.");
  }
}

function voucherFromConfirmedDebitNotePayload(payload) {
  const masterId = String(payload?.tallyVoucherId ?? payload?.voucherId ?? "").trim();
  const voucherNumber = String(payload?.tallyVoucherNumber ?? payload?.voucherNumber ?? "").trim();
  const partyLedgerName = String(payload?.partyLedgerName ?? "").trim();
  const reference = String(payload?.referenceNumber ?? payload?.expectedReference ?? "").trim();
  const amount = Math.abs(Number(payload?.amount ?? 0));
  if (!masterId || !voucherNumber || !partyLedgerName || !reference || !(amount > 0)) {
    throw new Error("The confirmed Tally Debit Note details are incomplete; PDF export was stopped.");
  }

  const linkedInvoiceNumber = String(payload?.linkedInvoiceNumber ?? "").trim();
  const narration = String(payload?.narration ?? "").trim() ||
    `Cash discount recovery against invoice ${linkedInvoiceNumber || reference}.`;
  return {
    date: String(payload?.voucherDate ?? "").trim(),
    effectiveDate: String(payload?.voucherDate ?? "").trim(),
    voucherType: "Debit Note",
    voucherNumber,
    reference,
    narration,
    partyLedgerName,
    ledgerNames: [partyLedgerName],
    ledgerEntries: [{ ledgerName: partyLedgerName, amount, isDebit: true }],
    masterId,
    alterId: null,
    guid: null,
    isCancelled: "No",
  };
}

async function exportNativeDebitNotePdf(companyName, voucher, requestedParty, renderTallyPrintToPdf) {
  if (typeof renderTallyPrintToPdf !== "function") {
    throw new Error("The desktop Bhuleshwar connector must be running to prepare the official Tally PDF.");
  }
  // Tally's VCH Print HTTP report returns an unbound, blank voucher shell
  // even when the requested MasterID is supplied. It cannot be used as a
  // customer document. The payload here was saved only after the Debit Note
  // creation command was confirmed by Tally; render those confirmed fields
  // and reject any document that omits its identity.
  const tallyHtml = buildVerifiedDebitNoteHtml({
    companyName,
    voucher,
    requestedParty,
  });
  assertVerifiedDebitNoteHtml(tallyHtml, voucher, requestedParty);
  const pdf = await renderTallyPrintToPdf({
    html: tallyHtml,
    fileName: `Tally-Debit-Note-${voucher.voucherNumber || voucher.masterId}.pdf`,
  });
  if (!Buffer.isBuffer(pdf) || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("The desktop connector could not render the verified Tally Debit Note into a PDF.");
  }
  if (pdf.length > MAX_NATIVE_DEBIT_NOTE_PDF_BYTES) {
    throw new Error("The verified Tally Debit Note PDF exceeds the 5 MB document limit.");
  }
  return {
    nativePdfBase64: pdf.toString("base64"),
    nativePdfSha256: createHash("sha256").update(pdf).digest("hex"),
    nativePdfByteSize: pdf.length,
    nativePdfFileName: `Tally-Debit-Note-${voucher.voucherNumber || voucher.masterId}.pdf`,
  };
}

function normalizeDateForCompare(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return parseTallyDate(raw);
}

function amountMatches(left, right) {
  return Math.abs(Math.abs(Number(left ?? 0)) - Math.abs(Number(right ?? 0))) < 0.01;
}

function voucherHasLedger(voucher, ledgerName) {
  const key = normalizeLooseName(ledgerName);
  if (!key) return false;
  return [
    voucher.partyLedgerName,
    ...voucher.ledgerNames,
  ].some((name) => normalizeLooseName(name) === key);
}

function voucherHasLedgerAmount(voucher, ledgerName, amount) {
  const key = normalizeLooseName(ledgerName);
  if (!key) return false;
  return voucher.ledgerEntries.some(
    (entry) => normalizeLooseName(entry.ledgerName) === key && amountMatches(entry.amount, amount)
  );
}

function voucherHasAnyAmount(voucher, amount) {
  return voucher.ledgerEntries.some((entry) => amountMatches(entry.amount, amount));
}

function normalizedNeedle(value) {
  return normalizeLooseName(value);
}

function voucherSearchText(voucher) {
  return [
    voucher.voucherNumber,
    voucher.reference,
    voucher.narration,
    voucher.partyLedgerName,
    ...(voucher.bankReferences || []),
    ...voucher.ledgerNames,
    voucher.rawPreview,
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeExactReference(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function voucherHasExactReference(voucher, referenceNumber) {
  const expected = normalizeExactReference(referenceNumber);
  if (expected.length < 5) return false;
  return [voucher.reference, ...(voucher.bankReferences || [])]
    .some((value) => normalizeExactReference(value) === expected);
}

function getBankLedgerEntry(voucher, bankLedgerName, amount, expectedDirection) {
  const bankKey = normalizeLooseName(bankLedgerName);
  const incoming = String(expectedDirection || "").toLowerCase() === "incoming";
  const outgoing = String(expectedDirection || "").toLowerCase() === "outgoing";
  return voucher.ledgerEntries.find((entry) => {
    if (normalizeLooseName(entry.ledgerName) !== bankKey || !amountMatches(entry.amount, amount)) {
      return false;
    }
    if (incoming) return entry.isDebit === true;
    if (outgoing) return entry.isDebit === false;
    return false;
  }) || null;
}

function validateStatementBalanceSequence(transactions) {
  const rows = transactions.map((transaction) => ({
    debit: Number(transaction.debitAmount || 0),
    credit: Number(transaction.creditAmount || 0),
    balance:
      transaction.balanceAmount === null ||
      transaction.balanceAmount === undefined ||
      transaction.balanceAmount === ""
        ? null
        : Number(transaction.balanceAmount),
  }));
  if (rows.length === 0 || rows.some((row) => row.balance === null || !Number.isFinite(row.balance))) {
    return { available: false, valid: false, reason: "Statement running balances were unavailable." };
  }

  const test = (orderedRows) => {
    for (let index = 1; index < orderedRows.length; index += 1) {
      const previous = orderedRows[index - 1];
      const current = orderedRows[index];
      const expected = previous.balance + current.credit - current.debit;
      if (Math.abs(expected - current.balance) >= 0.01) return null;
    }
    const first = orderedRows[0];
    return {
      openingBalance: first.balance - first.credit + first.debit,
      closingBalance: orderedRows.at(-1).balance,
      movement: orderedRows.reduce((sum, row) => sum + row.credit - row.debit, 0),
    };
  };

  const forward = test(rows);
  const reversed = forward ? null : test([...rows].reverse());
  const result = forward || reversed;
  return result
    ? { available: true, valid: true, order: forward ? "statement" : "reversed", ...result }
    : { available: true, valid: false, reason: "Statement running balances do not follow the debit/credit sequence." };
}

async function fetchLedgerClosingBalance(tallyUrl, options) {
  const xml = await exportTallyXml(
    tallyUrl,
    buildLedgerBalanceExportXml(options),
    "Bank ledger closing balance"
  );
  return parseTallyAmount(getTagText(xml, "CLOSINGBALANCE"));
}

function indexBankVouchersByDate(vouchers) {
  const byDate = new Map();
  vouchers.forEach((voucher, index) => {
    const date = normalizeDateForCompare(voucher.effectiveDate || voucher.date);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ voucher, index });
  });
  return byDate;
}

function financialYearBounds(value) {
  const normalized = normalizeDateForCompare(value);
  if (!normalized) return null;
  const [year, month] = normalized.split("-").map(Number);
  const startYear = month >= 4 ? year : year - 1;
  return { dateFrom: `${startYear}-04-01`, dateTo: `${startYear + 1}-03-31` };
}

function strictBankTransactionCandidates(vouchers, transaction, bankLedgerName, reservedVoucherIndexes, byDate = null) {
  const referenceNumber = String(transaction.referenceNumber || "").trim();
  const counterpartyLedgerName = String(transaction.counterpartyLedgerName || "").trim();
  const baseCandidates = baseBankTransactionCandidates(
    vouchers,
    transaction,
    bankLedgerName,
    reservedVoucherIndexes,
    byDate
  );

  const hasUsableReference = isStrongBankReference(referenceNumber);
  const counterpartyKey = normalizeLooseName(counterpartyLedgerName);
  const hasUsableCounterparty = Boolean(counterpartyKey && !counterpartyKey.includes("suspense"));
  const identityInsufficient = !hasUsableReference && !hasUsableCounterparty;
  let candidates;
  if (hasUsableReference) {
    // A bank reference can reveal a duplicate posted on the wrong date. Search
    // the bounded financial-year identity export as well as same-date rows, but
    // still require bank ledger, amount and accounting direction.
    candidates = vouchers.flatMap((voucher, index) => {
      if (reservedVoucherIndexes.has(index) || !voucherHasExactReference(voucher, referenceNumber)) return [];
      const bankEntry = getBankLedgerEntry(
        voucher,
        bankLedgerName,
        Number(transaction.amount || 0),
        transaction.expectedDirection
      );
      return bankEntry ? [{ voucher, index, bankEntry }] : [];
    });
  } else if (hasUsableCounterparty) {
    // Without a bank reference, the exact selected counterparty is mandatory.
    // Same-date and same-amount vouchers belonging to another ledger are not a
    // match and must remain missing.
    candidates = baseCandidates.filter(({ voucher }) => voucherHasLedger(voucher, counterpartyLedgerName));
  } else {
    // Keep same-date/amount candidates only so the caller can report ambiguity;
    // one such voucher is never sufficient without a reference or party.
    candidates = baseCandidates;
  }

  return {
    candidates,
    baseCandidateCount: baseCandidates.length,
    hasUsableReference,
    hasUsableCounterparty,
    identityInsufficient,
  };
}

function serializeStrictVoucherMatch(candidate) {
  const voucher = candidate.voucher;
  return {
    date: normalizeDateForCompare(voucher.effectiveDate || voucher.date),
    voucherType: voucher.voucherType,
    voucherNumber: voucher.voucherNumber,
    reference: voucher.reference,
    bankReferences: voucher.bankReferences || [],
    partyLedgerName: voucher.partyLedgerName,
    ledgerNames: voucher.ledgerNames,
    masterId: voucher.masterId,
  };
}

async function fetchBankReconciliationVouchers(
  tallyUrl,
  { companyName, dateFrom, dateTo, bankLedgerName, transactions },
  dependencies = {}
) {
  const exportCollection = dependencies.exportCollection || exportTallyCollection;
  const startedAt = Date.now();
  const strongReferences = Array.from(new Set(
    (transactions || [])
      .map((transaction) => String(transaction.referenceNumber || "").trim())
      .filter(isStrongBankReference)
  ));
  const needsSameDateScan = (transactions || []).some(
    (transaction) => !isStrongBankReference(transaction.referenceNumber)
  );
  // Secondary collection: gather this bank's vouchers directly, instead of
  // gathering all company vouchers and applying FilterCount afterwards.
  // Fetch bank-allocation references with the primary export
  // so a missing top-level Reference does not trigger another serial Tally
  // request for the same vouchers.
  const leanXml = needsSameDateScan
    ? await exportCollection(tallyUrl, {
        collectionName: "Kalika Bank Statement Reconciliation",
        tallyType: "Vouchers : Ledger",
        childOf: tallyFormulaString(bankLedgerName),
        fetchFields:
          "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,PartyLedgerName,MasterID,IsCancelled,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BankAllocations.Name,AllLedgerEntries.BankAllocations.InstrumentNumber,AllLedgerEntries.BankAllocations.TransactionName",
        companyName,
        dateFrom,
        dateTo,
        timeoutMs: BANK_MATCH_READ_TIMEOUT_MS,
        maxResponseBytes: BANK_MATCH_MAX_XML_BYTES,
      })
    : "<ENVELOPE><COLLECTION></COLLECTION></ENVELOPE>";
  const leanCompletedAt = Date.now();
  checkReadBudget(cashDiscountReadContext.getStore());
  if (!/<\/ENVELOPE\s*>/i.test(leanXml) ||
      !/<(?:COLLECTION|VOUCHER)(?:\s|\/?>)/i.test(leanXml)) {
    throw new Error("Tally did not return a complete bank voucher collection. Duplicate checking could not be completed.");
  }
  const sameDateVouchers = parseVoucherCollection(leanXml).filter(
    (voucher) => !/^yes$/i.test(String(voucher.isCancelled || ""))
  );
  let crossDateVouchers = [];
  let crossDateExportMs = 0;
  const financialYear = financialYearBounds(dateFrom);
  if (strongReferences.length > 0 && financialYear) {
    const crossDateStartedAt = Date.now();
    const filterName = "KalikaBankReferenceIdentity";
    const referenceFormula = strongReferences
      .map((reference) => `($$IsEqual:$Reference:${tallyFormulaString(reference)})`)
      .join(" OR ");
    const crossDateXml = await exportCollection(tallyUrl, {
      collectionName: "Kalika Bank Reference Identity",
      tallyType: "Vouchers : Ledger",
      childOf: tallyFormulaString(bankLedgerName),
      fetchFields:
        "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,PartyLedgerName,MasterID,IsCancelled,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BankAllocations.Name,AllLedgerEntries.BankAllocations.InstrumentNumber,AllLedgerEntries.BankAllocations.TransactionName",
      companyName,
      dateFrom: financialYear.dateFrom,
      dateTo: financialYear.dateTo,
      formulae: [{ name: filterName, formula: referenceFormula }],
      filterNames: [filterName],
      timeoutMs: BANK_MATCH_READ_TIMEOUT_MS,
      maxResponseBytes: BANK_MATCH_MAX_XML_BYTES,
    });
    checkReadBudget(cashDiscountReadContext.getStore());
    if (!/<\/ENVELOPE\s*>/i.test(crossDateXml)) {
      throw new Error("Tally did not return a complete financial-year duplicate lookup.");
    }
    crossDateVouchers = parseVoucherCollection(crossDateXml).filter(
      (voucher) => !/^yes$/i.test(String(voucher.isCancelled || ""))
    );
    crossDateExportMs = Date.now() - crossDateStartedAt;
  }
  const voucherByIdentity = new Map();
  for (const voucher of [...sameDateVouchers, ...crossDateVouchers]) {
    const key = [
      voucher.masterId || "",
      voucher.voucherNumber || "",
      normalizeDateForCompare(voucher.effectiveDate || voucher.date) || "",
      voucher.reference || "",
    ].join("|");
    if (!voucherByIdentity.has(key)) voucherByIdentity.set(key, voucher);
  }
  const vouchers = Array.from(voucherByIdentity.values());

  return {
    vouchers,
    diagnostics: {
      leanExportMs: leanCompletedAt - startedAt,
      referenceExportMs: 0,
      crossDateExportMs,
      totalMs: Date.now() - startedAt,
      scannedVoucherCount: vouchers.length,
      detailedVoucherCount: 0,
      detailBatchCount: 0,
      primaryIncludesBankReferences: true,
      queryMode: strongReferences.length > 0
        ? needsSameDateScan
          ? "bank_ledger_plus_financial_year_reference"
          : "financial_year_reference"
        : "bank_ledger_child_of",
    },
  };
}

async function reconcileBankTransactionsInTally(config, commandPayload = {}, dependencies = {}) {
  const transactions = Array.isArray(commandPayload.transactions) ? commandPayload.transactions : [];
  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const bankLedgerName = String(commandPayload.bankLedgerName || "").trim();
  if (!bankLedgerName) throw new Error("Bank transaction verification requires the bank ledger name.");
  if (transactions.length === 0) throw new Error("Bank transaction verification requires at least one row.");

  const normalizedTransactions = transactions.map((transaction, index) => {
    const voucherDate = normalizeDateForCompare(transaction.voucherDate);
    const amount = Number(transaction.amount || 0);
    const expectedDirection = String(transaction.expectedDirection || "").toLowerCase();
    if (!voucherDate) throw new Error(`Bank statement row ${index + 1} requires a valid date.`);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Bank statement row ${index + 1} requires a positive amount.`);
    }
    if (!['incoming', 'outgoing'].includes(expectedDirection)) {
      throw new Error(`Bank statement row ${index + 1} requires a debit/credit direction.`);
    }
    return { ...transaction, voucherDate, amount, expectedDirection };
  });
  const dates = normalizedTransactions.map((transaction) => transaction.voucherDate).sort();
  const dateFrom = dates[0];
  const dateTo = dates.at(-1);
  const voucherRequest = { companyName, dateFrom, dateTo, bankLedgerName, transactions: normalizedTransactions };
  const { vouchers, diagnostics: queryDiagnostics } = dependencies.voucherProvider
    ? await dependencies.voucherProvider(tallyUrl, voucherRequest, dependencies)
    : await fetchBankReconciliationVouchers(tallyUrl, voucherRequest, dependencies);
  const reservedVoucherIndexes = new Set();
  const vouchersByDate = indexBankVouchersByDate(vouchers);
  const results = normalizedTransactions.map((transaction) => {
    const {
      candidates,
      baseCandidateCount,
      hasUsableReference,
      hasUsableCounterparty,
      identityInsufficient,
    } = strictBankTransactionCandidates(
      vouchers,
      transaction,
      bankLedgerName,
      reservedVoucherIndexes,
      vouchersByDate
    );
    const duplicateInTally = hasUsableReference && candidates.length > 1;
    const verificationStatus = identityInsufficient && candidates.length > 0
      ? "ambiguous"
      : candidates.length === 1
      ? "found"
      : candidates.length > 1
        ? "ambiguous"
        : "missing";
    if (verificationStatus === "found") {
      const indexesToReserve = duplicateInTally ? candidates.map((candidate) => candidate.index) : [candidates[0].index];
      indexesToReserve.forEach((index) => reservedVoucherIndexes.add(index));
    }
    const selectedCandidate = verificationStatus === "found" ? candidates[0] : null;
    return {
      transactionId: transaction.transactionId || null,
      verificationStatus,
      matchCount: candidates.length,
      duplicateInTally,
      duplicateVoucherCount: duplicateInTally ? candidates.length : 0,
      baseCandidateCount,
      scannedCount: vouchers.length,
      voucherId: selectedCandidate ? selectedCandidate.voucher.masterId || selectedCandidate.voucher.voucherNumber : null,
      voucherNumber: selectedCandidate ? selectedCandidate.voucher.voucherNumber : null,
      voucherDate: selectedCandidate
        ? normalizeDateForCompare(selectedCandidate.voucher.effectiveDate || selectedCandidate.voucher.date)
        : null,
      reason: duplicateInTally
        ? `${candidates.length} Tally vouchers have the same strict bank transaction reference. The statement row is already posted; review the duplicate Tally vouchers separately.`
        : verificationStatus === "found"
          ? "A unique Tally voucher matched the date, bank ledger, amount, direction and available reference."
        : identityInsufficient && verificationStatus === "ambiguous"
          ? "A same-date and same-amount voucher exists, but no usable bank reference or exact counterparty ledger proves it is this statement row. Review manually."
        : verificationStatus === "ambiguous"
          ? "More than one same-date and same-amount voucher matched, but no reliable bank reference identifies one transaction. Review manually."
          : !hasUsableReference && hasUsableCounterparty && baseCandidateCount > 0
            ? "Date, amount and direction matched, but the exact selected counterparty ledger did not."
          : hasUsableReference && baseCandidateCount > 0
            ? "Date, amount and direction matched, but the exact UTR/reference did not."
            : "No unused Tally voucher matched the date, selected bank ledger, amount and direction.",
      matches: candidates.slice(0, 5).map(serializeStrictVoucherMatch),
    };
  });

  const statementBalance = validateStatementBalanceSequence(normalizedTransactions);
  const periodBankEntries = vouchers.flatMap((voucher) => voucher.ledgerEntries.filter(
    (entry) => normalizeLooseName(entry.ledgerName) === normalizeLooseName(bankLedgerName)
  ));
  const tallyMovement = periodBankEntries.reduce((sum, entry) => sum - Number(entry.amount || 0), 0);
  const includeBalanceProof = commandPayload.includeBalanceProof !== false;
  let tallyClosingBalance = null;
  let balanceError = includeBalanceProof ? null : "Balance proof skipped for posting duplicate preflight.";
  if (includeBalanceProof) {
    try {
      const rawTallyClosingBalance = await fetchLedgerClosingBalance(tallyUrl, {
        companyName,
        ledgerName: bankLedgerName,
        dateFrom,
        dateTo,
      });
      // Tally's internal amount sign is opposite to the bank statement view for
      // asset bank ledgers: debit balances are negative internally.
      tallyClosingBalance = Number.isFinite(rawTallyClosingBalance)
        ? -Number(rawTallyClosingBalance)
        : null;
    } catch (error) {
      balanceError = error instanceof Error ? error.message : String(error);
    }
  }
  const derivedTallyOpeningBalance = Number.isFinite(tallyClosingBalance)
    ? Number(tallyClosingBalance) - tallyMovement
    : null;
  const balancesMatch = statementBalance.valid && Number.isFinite(tallyClosingBalance)
    ? Math.abs(statementBalance.openingBalance - derivedTallyOpeningBalance) < 0.01 &&
      Math.abs(statementBalance.closingBalance - Number(tallyClosingBalance)) < 0.01
    : null;

  return {
    success: true,
    result: {
      mode: "bank_statement_batch",
      dateFrom,
      dateTo,
      bankLedgerName,
      scannedCount: vouchers.length,
      queryDiagnostics,
      transactions: results,
      balanceProof: {
        available: statementBalance.available && Number.isFinite(tallyClosingBalance),
        statementSequenceValid: statementBalance.valid,
        statementOpeningBalance: statementBalance.valid ? statementBalance.openingBalance : null,
        statementClosingBalance: statementBalance.valid ? statementBalance.closingBalance : null,
        statementMovement: statementBalance.valid ? statementBalance.movement : null,
        tallyOpeningBalance: derivedTallyOpeningBalance,
        tallyClosingBalance,
        tallyMovement,
        balancesMatch,
        warning: balanceError || (!statementBalance.valid ? statementBalance.reason : null),
      },
    },
  };
}

function scoreBankTransactionVoucher(voucher, payload) {
  const voucherDate = normalizeDateForCompare(voucher.effectiveDate || voucher.date);
  const expectedDate = normalizeDateForCompare(payload.voucherDate);
  const amount = Number(payload.amount ?? 0);
  const bankLedgerName = String(payload.bankLedgerName || "").trim();
  const counterpartyLedgerName = String(payload.counterpartyLedgerName || "").trim();
  const referenceNumber = String(payload.referenceNumber || "").trim();
  const text = voucherSearchText(voucher);
  const normalizedText = normalizedNeedle(text);
  const referenceHit =
    referenceNumber &&
    normalizedNeedle(referenceNumber).length >= 5 &&
    normalizedText.includes(normalizedNeedle(referenceNumber));
  const bankLedgerHit = voucherHasLedger(voucher, bankLedgerName);
  const bankAmountHit = voucherHasLedgerAmount(voucher, bankLedgerName, amount);
  const anyAmountHit = voucherHasAnyAmount(voucher, amount);
  const partyHit = counterpartyLedgerName
    ? voucherHasLedger(voucher, counterpartyLedgerName) ||
      normalizedText.includes(normalizedNeedle(counterpartyLedgerName))
    : false;
  const dateHit = Boolean(expectedDate && voucherDate === expectedDate);
  const expectedDirection = String(payload.expectedDirection || "").toLowerCase();
  const likelyPaymentType =
    expectedDirection === "incoming"
      ? /receipt|journal|contra/i.test(String(voucher.voucherType || ""))
      : /payment|journal|contra/i.test(String(voucher.voucherType || ""));

  let score = 0;
  if (dateHit) score += 45;
  if (bankAmountHit) score += 35;
  else if (bankLedgerHit && anyAmountHit) score += 25;
  else if (anyAmountHit) score += 15;
  if (referenceHit) score += 30;
  if (partyHit) score += 20;
  if (likelyPaymentType) score += 5;

  const reasons = [];
  if (dateHit) reasons.push("same date");
  if (bankAmountHit) reasons.push("same bank ledger and amount");
  else if (bankLedgerHit) reasons.push("same bank ledger");
  else if (anyAmountHit) reasons.push("same amount");
  if (referenceHit) reasons.push("same UTR/reference");
  if (partyHit) reasons.push("same party ledger");

  return {
    score,
    reasons,
    dateHit,
    bankAmountHit,
    anyAmountHit,
    referenceHit,
    partyHit,
  };
}

async function verifyBankTransactionInTally(config, commandPayload = {}) {
  if (Array.isArray(commandPayload.transactions)) {
    return reconcileBankTransactionsInTally(config, commandPayload);
  }
  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const amount = Number(commandPayload.amount ?? 0);
  const voucherDate = normalizeDateForCompare(commandPayload.voucherDate);
  const bankLedgerName = String(commandPayload.bankLedgerName || "").trim();

  if (!voucherDate) {
    throw new Error("Bank transaction verification requires a valid date.");
  }
  if (!bankLedgerName) {
    throw new Error("Bank transaction verification requires the bank ledger name.");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Bank transaction verification requires a positive amount.");
  }

  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Autodealer Bank Payment Verification",
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,IsCancelled,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BankAllocations.Name,AllLedgerEntries.BankAllocations.InstrumentNumber,AllLedgerEntries.BankAllocations.TransactionName",
    companyName,
    dateFrom: voucherDate,
    dateTo: voucherDate,
  });
  const vouchers = parseVoucherCollection(xml).filter(
    (voucher) => !/^yes$/i.test(String(voucher.isCancelled || ""))
  );
  const strictResult = strictBankTransactionCandidates(
    vouchers,
    { ...commandPayload, voucherDate, amount },
    bankLedgerName,
    new Set()
  );
  const strictMatches = strictResult.candidates;
  const duplicateInTally = strictResult.hasUsableReference && strictMatches.length > 1;
  const verificationStatus = strictResult.identityInsufficient && strictMatches.length > 0
    ? "ambiguous"
    : strictMatches.length === 0
    ? "missing"
    : strictMatches.length === 1 || duplicateInTally
      ? "found"
      : "ambiguous";
  const selectedVoucher = verificationStatus === "found" ? strictMatches[0].voucher : null;

  return {
    success: true,
    result: {
      verificationStatus,
      scannedCount: vouchers.length,
      matchCount: strictMatches.length,
      duplicateInTally,
      duplicateVoucherCount: duplicateInTally ? strictMatches.length : 0,
      voucherId: selectedVoucher?.masterId || selectedVoucher?.voucherNumber || null,
      voucherNumber: selectedVoucher?.voucherNumber || null,
      voucherType: selectedVoucher?.voucherType || null,
      voucherDate: selectedVoucher
        ? normalizeDateForCompare(selectedVoucher.effectiveDate || selectedVoucher.date)
        : null,
      reason:
        duplicateInTally
          ? `${strictMatches.length} Tally vouchers have the same strict bank transaction reference. The bank row is already posted; review the duplicate Tally vouchers separately.`
          : verificationStatus === "found"
            ? "Found a unique strict match in Tally."
          : strictResult.identityInsufficient && verificationStatus === "ambiguous"
            ? "A same-date and same-amount voucher exists, but no usable bank reference or exact counterparty ledger proves it is this bank row. Review manually."
          : verificationStatus === "ambiguous"
            ? "More than one same-date and same-amount voucher matched, but no reliable bank reference identifies one transaction. Review manually."
            : !strictResult.hasUsableReference && strictResult.hasUsableCounterparty && strictResult.baseCandidateCount > 0
              ? "Date, amount and direction matched, but the exact selected counterparty ledger did not."
            : strictResult.hasUsableReference && strictResult.baseCandidateCount > 0
              ? "Date, amount and direction matched, but the exact UTR/reference did not."
              : "No matching Tally voucher found for this bank transaction.",
      matches: strictMatches.slice(0, 5).map(serializeStrictVoucherMatch),
    },
  };
}

function parseTallyAmount(value) {
  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/\s*(Dr|Cr)$/i, "")
    .trim();
  if (!cleaned) return null;
  const negative = cleaned.startsWith("-") || /^\(.*\)$/.test(cleaned);
  const normalized = cleaned.replace(/[()]/g, "").replace(/^-/, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function parseTallyDate(value) {
  const raw = String(value ?? "").trim();
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw || null;
}

function billReferenceType(block) {
  return (
    getTagText(block, "BILLTYPE") ||
    getTagText(block, "TYPEOFREF") ||
    getTagText(block, "REFERENCE_TYPE") ||
    ""
  ).trim();
}

function billLedgerName(block) {
  return (
    getTagText(block, "LEDGERNAME") ||
    getTagText(block, "PARTYLEDGERNAME") ||
    getTagText(block, "PARENT") ||
    getTagText(block, "LEDGER") ||
    ""
  ).trim();
}

function normalizeLooseName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function uniquePayloadLedgerNames(commandPayload = {}) {
  const values = [
    ...(Array.isArray(commandPayload.ledgerNames) ? commandPayload.ledgerNames : []),
    commandPayload.ledgerName,
  ];
  const seen = new Set();
  const ledgerNames = [];

  for (const value of values) {
    const ledgerName = String(value || "").trim();
    const key = normalizeLooseName(ledgerName);
    if (!ledgerName || !key || seen.has(key)) continue;
    seen.add(key);
    ledgerNames.push(ledgerName);
  }

  return ledgerNames;
}

function emptyOpenBillBucket(ledgerName) {
  return {
    ledgerName,
    openBills: [],
    existingAdvances: [],
    rawCount: 0,
  };
}

function classifyOpenBillReferenceKind({
  billType,
  sourceVoucherType,
  referenceName,
  knownInvoice = false,
  knownAdvance = false,
} = {}) {
  const type = String(billType || "").toLowerCase();
  if (type.includes("advance")) return "advance";
  if (knownInvoice) return "bill";
  if (knownAdvance) return "advance";

  // Some Tally Bill collection exports omit BillType for receipt advances.
  // ADV-prefixed references are a controlled fallback only when no Sales
  // invoice with that reference was found.
  const looksLikeAdvanceReference = /^(?:adv|advance)(?:[-/\s]|\d)/i.test(String(referenceName || "").trim());
  if (looksLikeAdvanceReference && (/receipt/i.test(String(sourceVoucherType || "")) || !sourceVoucherType)) {
    return "advance";
  }
  return "bill";
}

export function parseLedgerClosingBalance(value) {
  const raw = String(value ?? "").trim();
  const parsed = parseTallyAmount(raw);
  if (parsed === null) return { amount: null, type: null, raw: null };
  const explicitType = raw.match(/\b(Dr|Cr)\s*$/i)?.[1];
  const type = explicitType
    ? explicitType.toLowerCase() === "dr" ? "Dr" : "Cr"
    : parsed < 0 ? "Dr" : parsed > 0 ? "Cr" : null;
  return {
    amount: Math.abs(parsed),
    type,
    raw,
  };
}

function toOpenBill(block, ledgerName, evidence = {}) {
  const referenceName = getAttribute(block, "NAME") || getTagText(block, "NAME") || getTagText(block, "BILLREF");
  if (!referenceName) return null;
  const rowLedgerName = billLedgerName(block);
  if (rowLedgerName && normalizeLooseName(rowLedgerName) !== normalizeLooseName(ledgerName)) return null;

  const closing =
    parseTallyAmount(getTagText(block, "CLOSINGBALANCE")) ??
    parseTallyAmount(getTagText(block, "BALANCE")) ??
    parseTallyAmount(getTagText(block, "PENDINGAMOUNT")) ??
    parseTallyAmount(getTagText(block, "AMOUNT"));
  const pendingAmount = Math.abs(closing ?? 0);
  if (pendingAmount <= 0) return null;

  const sourceVoucherType = getTagText(block, "VOUCHERTYPENAME") || getTagText(block, "VOUCHERTYPE") || null;
  const kind = classifyOpenBillReferenceKind({
    billType: /^yes$/i.test(getTagText(block, "ISADVANCE")) ? "Advance" : billReferenceType(block),
    sourceVoucherType,
    referenceName,
    knownInvoice: evidence.knownInvoice === true,
    knownAdvance: evidence.knownAdvance === true,
  });
  const common = {
    referenceName,
    voucherNumber: getTagText(block, "VOUCHERNUMBER") || referenceName,
    invoiceDate: parseTallyDate(getTagText(block, "DATE") || getTagText(block, "BILLDATE")),
    dueDate: parseTallyDate(getTagText(block, "DUEDATE")),
    originalAmount: Math.abs(parseTallyAmount(getTagText(block, "OPENINGBALANCE")) ?? pendingAmount),
    settledAmount: null,
    pendingAmount,
    sourceVoucherType,
    status: "open",
  };

  if (kind === "advance") {
    return {
      kind: "advance",
      referenceName,
      receiptDate: common.invoiceDate,
      pendingAdvanceAmount: pendingAmount,
      status: "unadjusted",
    };
  }

  return { kind: "bill", ...common };
}

function openBillNarrationKey(ledgerName, referenceName) {
  return `${normalizeLooseName(ledgerName)}|${normalizeLooseName(referenceName)}`;
}

function isPartyInvoiceVoucher(block) {
  const voucherType = (getTagText(block, "VOUCHERTYPENAME") || getAttribute(block, "VCHTYPE") || "").toLowerCase();
  return /sales|purchase|invoice/.test(voucherType) && !/debit|credit|receipt|payment/.test(voucherType);
}

function isPartySettlementVoucher(block) {
  const voucherType = (getTagText(block, "VOUCHERTYPENAME") || getAttribute(block, "VCHTYPE") || "").toLowerCase();
  return /receipt|payment/.test(voucherType);
}

function voucherBillAllocations(entryBlock) {
  return extractBlocks(entryBlock, "BILLALLOCATIONS.LIST")
    .map((allocation) => {
      const referenceName = getTagText(allocation, "NAME");
      const amount = Math.abs(parseTallyAmount(getTagText(allocation, "AMOUNT")) ?? 0);
      return {
        referenceName,
        billType: getTagText(allocation, "BILLTYPE") || getTagText(allocation, "TYPEOFREF") || null,
        amount,
      };
    })
    .filter((allocation) => allocation.referenceName && allocation.amount > 0);
}

function voucherLedgerEntries(block) {
  return extractBlocks(block, "ALLLEDGERENTRIES.LIST")
    .map((entry) => {
      const rawAmount = parseTallyAmount(getTagText(entry, "AMOUNT")) ?? 0;
      const isDeemedPositive = /^yes$/i.test(getTagText(entry, "ISDEEMEDPOSITIVE"));
      return {
        ledgerName: getTagText(entry, "LEDGERNAME"),
        amount: Math.abs(rawAmount),
        // Tally marks debit entries as deemed-positive. The amount sign is a
        // useful fallback for companies whose export omits that flag.
        isDebit: isDeemedPositive || rawAmount < 0,
        billAllocations: voucherBillAllocations(entry),
      };
    })
    .filter((entry) => entry.ledgerName && entry.amount > 0);
}

function isLikelyTaxLedgerName(ledgerName) {
  return /(?:^|\s)(?:gst|cgst|sgst|igst|utgst|cess|tax)(?:\s|$)/i.test(String(ledgerName || ""));
}

function salesLedgerFromInvoiceVoucher(voucher, partyLedgerName) {
  const nonPartyEntries = voucherLedgerEntries(voucher).filter(
    (entry) => normalizeLooseName(entry.ledgerName) !== normalizeLooseName(partyLedgerName)
  );
  // A Sales voucher can contain output-tax ledgers as well. Prefer its first
  // non-tax credit ledger, which is the original Sales ledger in Tally's
  // accounting export.
  const salesEntry = nonPartyEntries.find((entry) => !entry.isDebit && !isLikelyTaxLedgerName(entry.ledgerName));
  return salesEntry?.ledgerName || null;
}

function indexInvoiceNarrations(xml, requestedLedgerByKey) {
  const narrationByBill = new Map();
  const invoiceReferencesByLedger = new Map();
  const invoiceReferenceKeys = new Set();
  const advanceReferenceKeys = new Set();
  const salesLedgerByBill = new Map();

  for (const voucher of extractBlocks(xml, "VOUCHER")) {
    if (!isPartyInvoiceVoucher(voucher)) continue;
    const narration = getTagText(voucher, "NARRATION");

    const ledgerNames = [
      getTagText(voucher, "PARTYLEDGERNAME"),
      ...extractBlocks(voucher, "ALLLEDGERENTRIES.LIST").map((entry) => getTagText(entry, "LEDGERNAME")),
    ].filter(Boolean);
    const billReferences = [
      getTagText(voucher, "VOUCHERNUMBER"),
      getTagText(voucher, "REFERENCE"),
      ...extractBlocks(voucher, "BILLALLOCATIONS.LIST").map((allocation) => getTagText(allocation, "NAME")),
    ].filter(Boolean);

    for (const ledgerName of ledgerNames) {
      const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(ledgerName));
      if (!requestedLedgerName) continue;
      const salesLedgerName = salesLedgerFromInvoiceVoucher(voucher, requestedLedgerName);
      for (const billReference of billReferences) {
        const key = openBillNarrationKey(requestedLedgerName, billReference);
        invoiceReferenceKeys.add(key);
        if (narration) narrationByBill.set(key, narration);
        if (salesLedgerName) salesLedgerByBill.set(key, salesLedgerName);
        const references = invoiceReferencesByLedger.get(requestedLedgerName) || new Set();
        references.add(billReference);
        invoiceReferencesByLedger.set(requestedLedgerName, references);
      }
    }
  }

  // A receipt's bill allocation is the strongest evidence that a payment was
  // applied to a particular invoice. Prefer it over narration/reference text,
  // which may be absent or may mention several invoices.
  const receiptEvidenceByBill = new Map();
  for (const voucher of extractBlocks(xml, "VOUCHER")) {
    if (!isPartySettlementVoucher(voucher)) continue;
    const receiptDate = parseTallyDate(getTagText(voucher, "EFFECTIVEDATE") || getTagText(voucher, "DATE"));
    if (!receiptDate) continue;
    const voucherText = [
      getTagText(voucher, "VOUCHERNUMBER"),
      getTagText(voucher, "REFERENCE"),
      getTagText(voucher, "NARRATION"),
    ].join(" ");
    const normalizedVoucherText = normalizeLooseName(voucherText);

    for (const entry of voucherLedgerEntries(voucher)) {
      const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(entry.ledgerName));
      if (!requestedLedgerName) continue;
      const references = invoiceReferencesByLedger.get(requestedLedgerName) || new Set();
      const referenceByKey = new Map(
        [...references].map((reference) => [normalizeLooseName(reference), reference])
      );
      let matchedAllocation = false;

      for (const allocation of entry.billAllocations) {
        const allocationKey = openBillNarrationKey(requestedLedgerName, allocation.referenceName);
        const allocationLooksLikeAdvance =
          /advance/i.test(String(allocation.billType || "")) ||
          (/^(?:adv|advance)(?:[-/\s]|\d)/i.test(allocation.referenceName) &&
            !invoiceReferenceKeys.has(allocationKey));
        if (allocationLooksLikeAdvance) advanceReferenceKeys.add(allocationKey);
        const invoiceReference = referenceByKey.get(normalizeLooseName(allocation.referenceName));
        if (!invoiceReference) continue;
        const key = openBillNarrationKey(requestedLedgerName, invoiceReference);
        const existing = receiptEvidenceByBill.get(key);
        receiptEvidenceByBill.set(key, {
          lastReceiptDate: !existing || receiptDate > existing.lastReceiptDate ? receiptDate : existing.lastReceiptDate,
          matchedReceiptAmount: (existing?.matchedReceiptAmount || 0) + allocation.amount,
        });
        matchedAllocation = true;
      }

      // Older Tally versions can omit allocation blocks from a collection
      // export. Preserve the explicit narration/reference fallback for that
      // case only; never add the full receipt to multiple invoice balances.
      if (matchedAllocation) continue;
      for (const invoiceReference of references) {
        const normalizedReference = normalizeLooseName(invoiceReference);
        if (normalizedReference.length < 8 || !normalizedVoucherText.includes(normalizedReference)) continue;
        const key = openBillNarrationKey(requestedLedgerName, invoiceReference);
        const existing = receiptEvidenceByBill.get(key);
        receiptEvidenceByBill.set(key, {
          lastReceiptDate: !existing || receiptDate > existing.lastReceiptDate ? receiptDate : existing.lastReceiptDate,
          matchedReceiptAmount: (existing?.matchedReceiptAmount || 0) + entry.amount,
        });
      }
    }
  }

  return {
    narrationByBill,
    receiptEvidenceByBill,
    salesLedgerByBill,
    invoiceReferenceKeys,
    advanceReferenceKeys,
  };
}

function chunkValues(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function addUtcDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function cashDiscountFinancialYearRange(financialYear, asOfDate) {
  const normalizedAsOfDate = /^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || ""))
    ? String(asOfDate)
    : new Date().toISOString().slice(0, 10);
  const match = String(financialYear || "").trim().match(/(\d{4})\D+(\d{2}|\d{4})/);
  const asOfYear = Number(normalizedAsOfDate.slice(0, 4));
  const asOfMonth = Number(normalizedAsOfDate.slice(5, 7));
  const startYear = match ? Number(match[1]) : asOfMonth >= 4 ? asOfYear : asOfYear - 1;
  const dateFrom = `${startYear}-04-01`;
  const financialYearEnd = `${startYear + 1}-03-31`;
  return {
    financialYear: `${startYear}-${String(startYear + 1).slice(-2)}`,
    dateFrom,
    dateTo: normalizedAsOfDate < financialYearEnd ? normalizedAsOfDate : financialYearEnd,
  };
}

function cashDiscountVoucherDateChunks(dateFrom, dateTo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateTo || ""))) {
    return [{ dateFrom: dateFrom || null, dateTo: dateTo || null }];
  }
  if (dateFrom > dateTo) {
    return [{ dateFrom, dateTo }];
  }

  const chunks = [];
  let cursor = dateFrom;
  while (cursor <= dateTo) {
    if (chunks.length >= CASH_DISCOUNT_MAX_VOUCHER_CHUNKS) {
      throw new Error("The Cash Discount voucher period is too large for one live scan.");
    }
    const maximumEnd = addUtcDays(cursor, CASH_DISCOUNT_VOUCHER_DAYS_PER_CHUNK - 1);
    const chunkEnd = maximumEnd < dateTo ? maximumEnd : dateTo;
    chunks.push({ dateFrom: cursor, dateTo: chunkEnd });
    cursor = addUtcDays(chunkEnd, 1);
  }
  return chunks;
}

function openBillPendingFormula() {
  return [
    `(NOT $$IsEmpty:$ClosingBalance AND NOT $$IsEqual:$ClosingBalance:0)`,
    `($$IsEmpty:$ClosingBalance AND NOT $$IsEmpty:$PendingAmount AND NOT $$IsEqual:$PendingAmount:0)`,
    `($$IsEmpty:$ClosingBalance AND $$IsEmpty:$PendingAmount AND NOT $$IsEmpty:$Balance AND NOT $$IsEqual:$Balance:0)`,
  ].join(" OR ");
}

function isTallyExportTimeout(error) {
  return error?.name === "AbortError" || /timed out after \d+ seconds|tally.*timed out/i.test(String(error?.message || error || ""));
}

function splitDateChunk(dateChunk) {
  if (!dateChunk.dateFrom || !dateChunk.dateTo || dateChunk.dateFrom >= dateChunk.dateTo) return null;
  const fromTime = Date.parse(`${dateChunk.dateFrom}T00:00:00.000Z`);
  const toTime = Date.parse(`${dateChunk.dateTo}T00:00:00.000Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime >= toTime) return null;
  const midpoint = new Date(fromTime + Math.floor((toTime - fromTime) / 2)).toISOString().slice(0, 10);
  return [
    { dateFrom: dateChunk.dateFrom, dateTo: midpoint },
    { dateFrom: addUtcDays(midpoint, 1), dateTo: dateChunk.dateTo },
  ];
}

function openBillBlockRequiresVoucherFallback(block) {
  const referenceName = getAttribute(block, "NAME") || getTagText(block, "NAME") || getTagText(block, "BILLREF");
  if (!referenceName) return false;
  const hasReferenceType = Boolean(billReferenceType(block));
  const hasReliablePendingAmount = ["CLOSINGBALANCE", "BALANCE", "PENDINGAMOUNT"]
    .some((tagName) => Boolean(getTagText(block, tagName)));
  return !hasReferenceType || !hasReliablePendingAmount;
}

function earliestBillDate(blocks) {
  const dates = blocks
    .map((block) => parseTallyDate(getTagText(block, "DATE") || getTagText(block, "BILLDATE")))
    .filter(Boolean)
    .sort();
  return dates[0] || null;
}

async function exportTargetedOpenBillXml(
  tallyUrl,
  { companyName, ledgerNames, dateFrom, asOfDate, forceTargeted = false },
  exportCollection = exportTallyCollection
) {
  const pendingFilterName = "AutodealerPendingBill";
  const pendingFormula = { name: pendingFilterName, formula: openBillPendingFormula() };
  if (!forceTargeted && ledgerNames.length > OPEN_BILL_LEDGER_BATCH_SIZE) {
    const xml = await exportCollection(tallyUrl, {
      collectionName: "Autodealer Customer Open Bills",
      tallyType: "Bill",
      fetchFields:
        "Name,Parent,LedgerName,PartyLedgerName,BillType,TypeOfRef,Date,BillDate,DueDate,VoucherNumber,VoucherTypeName,OpeningBalance,ClosingBalance,Balance,PendingAmount,Amount",
      companyName,
      dateFrom,
      dateTo: asOfDate,
      formulae: [pendingFormula],
      filterNames: [pendingFilterName],
    });
    return { xml, batchCount: 1, queryMode: "full" };
  }
  const batches = chunkValues(ledgerNames, forceTargeted ? 20 : OPEN_BILL_LEDGER_BATCH_SIZE);
  const responses = [];
  for (const [index, batch] of batches.entries()) {
    checkReadBudget(cashDiscountReadContext.getStore());
    cashDiscountReadContext.getStore()?.onProgress?.(`Loading party bills: batch ${index + 1} of ${batches.length}`);
    const ledgerFilterName = "AutodealerRequestedBillLedger";
    responses.push(await exportCollection(tallyUrl, {
      collectionName: `Autodealer Customer Open Bills ${index + 1}`,
      tallyType: "Bill",
      fetchFields:
        "Name,Parent,LedgerName,PartyLedgerName,BillType,TypeOfRef,Date,BillDate,DueDate,VoucherNumber,VoucherTypeName,OpeningBalance,ClosingBalance,Balance,PendingAmount,Amount",
      companyName,
      dateFrom,
      dateTo: asOfDate,
      formulae: [
        pendingFormula,
        {
          name: ledgerFilterName,
          formula: buildRequestedLedgerFormula(batch, ["$LedgerName", "$PartyLedgerName", "$Parent"]),
        },
      ],
      filterNames: [pendingFilterName, ledgerFilterName],
    }));
  }
  return { xml: responses.join("\n"), batchCount: batches.length, queryMode: "targeted" };
}

async function exportTargetedBillEvidenceXml(
  tallyUrl,
  { companyName, ledgerNames, dateFrom, dateTo },
  exportCollection = exportTallyCollection
) {
  const batches = chunkValues(ledgerNames, CASH_DISCOUNT_EVIDENCE_LEDGER_BATCH_SIZE);
  const dateChunks = cashDiscountVoucherDateChunks(dateFrom, dateTo);
  const responses = [];
  const successfulDateChunks = new Set();
  let requestSequence = 0;
  let retrySplitCount = 0;

  const exportSlice = async (dateChunk, batch) => {
    requestSequence += 1;
    if (requestSequence > CASH_DISCOUNT_MAX_VOUCHER_CHUNKS * 20) {
      throw new Error("The Cash Discount voucher evidence required too many Tally requests.");
    }
    try {
      const ledgerEntryFilterName = "AutodealerRequestedPartyEntry";
      const ledgerVoucherFilterName = "AutodealerRequestedPartyVoucher";
      responses.push(await exportCollection(tallyUrl, {
        collectionName: `Autodealer Customer Bill Evidence ${requestSequence}`,
        tallyType: "Voucher",
        fetchFields:
          "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,AllLedgerEntries.LedgerName,AllLedgerEntries.Amount,AllLedgerEntries.IsDeemedPositive,AllLedgerEntries.BillAllocations.Name,AllLedgerEntries.BillAllocations.BillType,AllLedgerEntries.BillAllocations.Amount",
        companyName,
        dateFrom: dateChunk.dateFrom,
        dateTo: dateChunk.dateTo,
        formulae: [
          {
            name: ledgerEntryFilterName,
            formula: buildRequestedLedgerFormula(batch, ["$LedgerName"]),
          },
          {
            name: ledgerVoucherFilterName,
            formula: `$$FilterCount:AllLedgerEntries:${ledgerEntryFilterName} > 0`,
          },
        ],
        // Keep custom voucher types. The returned vouchers are already limited
        // to the affected party ledgers and are classified after parsing.
        filterNames: [ledgerVoucherFilterName],
      }));
      successfulDateChunks.add(`${dateChunk.dateFrom}|${dateChunk.dateTo}`);
    } catch (error) {
      if (!isTallyExportTimeout(error)) throw error;
      const splitDates = splitDateChunk(dateChunk);
      if (splitDates) {
        retrySplitCount += 1;
        for (const smallerDateChunk of splitDates) await exportSlice(smallerDateChunk, batch);
        return;
      }
      if (batch.length > 1) {
        retrySplitCount += 1;
        const midpoint = Math.ceil(batch.length / 2);
        await exportSlice(dateChunk, batch.slice(0, midpoint));
        await exportSlice(dateChunk, batch.slice(midpoint));
        return;
      }
      throw error;
    }
  };

  for (const dateChunk of dateChunks) {
    for (const batch of batches) {
      await exportSlice(dateChunk, batch);
    }
  }
  return {
    xml: responses.join("\n"),
    batchCount: responses.length,
    dateChunkCount: successfulDateChunks.size,
    retrySplitCount,
  };
}

// Missing open bills are not proof of payment. Require one exact Sales New Ref
// and a balanced set of signed Receipt/Payment Agst Ref allocations.
export function verifyReminderAllocationXml(xml, ledgerName, invoice, invoiceDate) {
  let original = 0, credited = 0, sources = 0, allocations = 0, invalid = false;
  for (const voucher of extractBlocks(xml, "VOUCHER")) {
    if (/^yes$/i.test(getTagText(voucher, "ISCANCELLED")) || /^yes$/i.test(getTagText(voucher, "ISOPTIONAL"))) continue;
    const type = getTagText(voucher, "VOUCHERTYPENAME") || getAttribute(voucher, "VCHTYPE");
    for (const entry of extractBlocks(voucher, "ALLLEDGERENTRIES.LIST")) {
      if (getTagText(entry, "LEDGERNAME") !== ledgerName) continue;
      for (const allocation of extractBlocks(entry, "BILLALLOCATIONS.LIST")) {
        if (getTagText(allocation, "NAME") !== invoice) continue;
        const amount = parseTallyAmount(getTagText(allocation, "AMOUNT"));
        const kind = getTagText(allocation, "BILLTYPE");
        if (amount === null || !Number.isFinite(amount)) { invalid = true; continue; }
        const cents = Math.round(amount * 100);
        if (/^new ref$/i.test(kind) && /^sales$/i.test(type) && cents < 0 && parseTallyDate(getTagText(voucher, "DATE")) === invoiceDate) {
          sources++; original -= cents;
        } else if (/^agst ref$/i.test(kind) && /^(receipt|payment)$/i.test(type)) {
          credited += cents; allocations++;
        } else invalid = true;
      }
    }
  }
  return {ledgerName,invoice,invoiceDate,verified:!invalid&&sources===1&&original>0&&allocations>0&&credited===original,originalAmount:original/100,allocatedAmount:credited/100};
}

// A payment reminder names the invoice it is about. When that invoice is no
// longer among the open bills, Tally is read for that one customer to prove
// how it was settled. Only missing bills require this extra read.
async function reminderSettlementEvidence(tallyUrl, commandPayload, companyName, ledgerNames, firstLedgerBucket, exportCollection = exportTallyCollection) {
  const target = commandPayload.verificationInvoice;
  if (commandPayload.queryPurpose !== 'payment_followup' || ledgerNames.length !== 1 || !target) return null;
  const invoice = String(target.invoice || '');
  const invoiceDate = normalizeDateForCompare(target.invoiceDate);
  if (!invoice || invoice.length > 200 || !invoiceDate) throw new Error('Invalid invoice verification target.');
  // Never replace a live balance.
  if (firstLedgerBucket.openBills.some(b => b.referenceName === invoice && b.invoiceDate === invoiceDate)) return null;
  const range = cashDiscountFinancialYearRange(commandPayload.financialYear);
  const evidence = await exportTargetedBillEvidenceXml(tallyUrl, {companyName,ledgerNames,dateFrom:range.dateFrom,dateTo:range.dateTo}, async (url, options) => exportCollection(url, {...options,fetchFields:options.fetchFields+',IsCancelled,IsOptional'}));
  return verifyReminderAllocationXml(evidence.xml, ledgerNames[0], invoice, invoiceDate);
}

// fetchCustomerOpenBillsFromTally's result, from customer dues held as fields.
async function customerOpenBillsFromDues(config, commandPayload, records) {
  const ledgerNames = uniquePayloadLedgerNames(commandPayload);
  if (ledgerNames.length === 0) throw new Error("Party open bill fetch requires ledgerName.");
  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const { byLedger, billCount } = openBillsByLedgerFromFields(ledgerNames, records.bills, records.vouchers);
  const firstLedgerName = ledgerNames[0];
  const firstLedgerBucket = byLedger[firstLedgerName] || emptyOpenBillBucket(firstLedgerName);
  const settlementEvidence = await reminderSettlementEvidence(tallyUrl, commandPayload, companyName, ledgerNames, firstLedgerBucket);
  return {
    success: true,
    result: {
      ledgerName: firstLedgerName,
      settlementEvidence,
      ledgerNames,
      byLedger,
      openBills: firstLedgerBucket.openBills,
      existingAdvances: firstLedgerBucket.existingAdvances,
      rawCount: Object.values(byLedger).reduce((total, bucket) => total + bucket.rawCount, 0),
      queryDiagnostics: {
        requestedLedgerCount: ledgerNames.length,
        billBatchCount: 0,
        billQueryMode: "customer_dues_fields",
        billObjectCount: billCount,
        voucherFallbackUsed: true,
        voucherFallbackLedgerCount: ledgerNames.length,
        voucherEvidenceMode: "required",
        voucherBatchCount: 0,
        voucherQueryMode: "customer_dues_fields",
        voucherDateChunkCount: 0,
        voucherRetrySplitCount: 0,
        asOfDate: normalizeDateForCompare(commandPayload.asOfDate || commandPayload.dateTo) || null,
      },
    },
  };
}

async function fetchCustomerOpenBillsFromTally(config, commandPayload = {}, dependencies = {}) {
  const ledgerNames = uniquePayloadLedgerNames(commandPayload);
  if (ledgerNames.length === 0) {
    throw new Error("Party open bill fetch requires ledgerName.");
  }
  const requestedLedgerByKey = new Map(ledgerNames.map((ledgerName) => [normalizeLooseName(ledgerName), ledgerName]));

  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const asOfDate = normalizeDateForCompare(commandPayload.asOfDate || commandPayload.dateTo) || null;
  const requestedDateFrom = normalizeDateForCompare(commandPayload.dateFrom) || null;
  const forceTargeted =
    commandPayload.queryPurpose === "bank_statement_match";
  const exportCollection = dependencies.exportCollection || exportTallyCollection;
  // Tally's local HTTP listener processes reports serially. Concurrent large
  // collection exports can leave one request waiting indefinitely, which
  // previously locked the whole connector cycle and surfaced as a dashboard
  // refresh timeout.
  const billExport = dependencies.billExport || await exportTargetedOpenBillXml(
    tallyUrl,
    { companyName, ledgerNames, dateFrom: requestedDateFrom, asOfDate, forceTargeted },
    exportCollection
  );
  const billBlocks = extractBlocks(billExport.xml, "BILL").filter((block) =>
    requestedLedgerByKey.has(normalizeLooseName(billLedgerName(block)))
  );
  const fallbackBlocks = billBlocks.filter(openBillBlockRequiresVoucherFallback);
  const fallbackLedgerNames = Array.from(new Set(fallbackBlocks.flatMap((block) => {
    const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(billLedgerName(block)));
    return requestedLedgerName ? [requestedLedgerName] : [];
  })));
  // Cash Discount calculation always needs invoice narration and receipt
  // allocation evidence. For other consumers, retain the narrower structural
  // fallback behaviour.
  const evidenceLedgerNames = dependencies.forceVoucherEvidence && billBlocks.length > 0
    ? Array.from(new Set(billBlocks.map(billLedgerName)))
    : fallbackLedgerNames;
  const earliestDate = earliestBillDate(dependencies.forceVoucherEvidence ? billBlocks : fallbackBlocks);
  const evidenceDateFrom = dependencies.forceVoucherEvidence
    ? [requestedDateFrom, earliestDate].filter(Boolean).sort()[0] || null
    : requestedDateFrom || earliestDate;
  const voucherExport = dependencies.voucherExport || (evidenceLedgerNames.length > 0
    ? dependencies.forceVoucherEvidence
      ? await exportCompactCashDiscountEvidenceXml(
          tallyUrl,
          {
            companyName,
            ledgerNames: evidenceLedgerNames,
            dateFrom: evidenceDateFrom,
            dateTo: asOfDate,
          },
          exportCollection,
          dependencies.exportXml || exportTallyXml
        )
      : await exportTargetedBillEvidenceXml(
          tallyUrl,
          {
            companyName,
            ledgerNames: evidenceLedgerNames,
            dateFrom: evidenceDateFrom,
            dateTo: asOfDate,
          },
          exportCollection
        )
    : { xml: "", batchCount: 0 });
  const {
    narrationByBill,
    receiptEvidenceByBill,
    salesLedgerByBill,
    invoiceReferenceKeys,
    advanceReferenceKeys,
  } = indexInvoiceNarrations(voucherExport.xml, requestedLedgerByKey);
  const byLedger = Object.fromEntries(ledgerNames.map((ledgerName) => [ledgerName, emptyOpenBillBucket(ledgerName)]));

  for (const block of billBlocks) {
    const rowLedgerName = billLedgerName(block);
    const requestedLedgerName = requestedLedgerByKey.get(normalizeLooseName(rowLedgerName));
    if (!requestedLedgerName) continue;

    const referenceName = getAttribute(block, "NAME") || getTagText(block, "NAME") || getTagText(block, "BILLREF");
    const referenceKey = openBillNarrationKey(requestedLedgerName, referenceName);
    const entry = toOpenBill(block, requestedLedgerName, {
      knownInvoice: invoiceReferenceKeys.has(referenceKey),
      knownAdvance: advanceReferenceKeys.has(referenceKey),
    });
    if (!entry) continue;

    if (entry.kind === "bill") {
      entry.narration =
        narrationByBill.get(openBillNarrationKey(requestedLedgerName, entry.referenceName)) ||
        narrationByBill.get(openBillNarrationKey(requestedLedgerName, entry.voucherNumber)) ||
        null;
      entry.sourceSalesLedgerName =
        salesLedgerByBill.get(openBillNarrationKey(requestedLedgerName, entry.referenceName)) ||
        salesLedgerByBill.get(openBillNarrationKey(requestedLedgerName, entry.voucherNumber)) ||
        null;
      const receiptEvidence =
        receiptEvidenceByBill.get(openBillNarrationKey(requestedLedgerName, entry.referenceName)) ||
        receiptEvidenceByBill.get(openBillNarrationKey(requestedLedgerName, entry.voucherNumber)) ||
        null;
      entry.receiptDate = receiptEvidence?.lastReceiptDate || null;
      entry.matchedReceiptAmount = receiptEvidence?.matchedReceiptAmount || null;
      if (receiptEvidence && entry.originalAmount > 0) {
        const settledAmount = Math.min(entry.originalAmount, Math.max(0, receiptEvidence.matchedReceiptAmount));
        entry.settledAmount = settledAmount;
        // Some Tally releases expose a Bill collection's original balance even
        // after a receipt has been allocated. The allocation in the Receipt
        // voucher is definitive, so derive the remaining balance from it.
        entry.pendingAmount = Math.max(0, Number((entry.originalAmount - settledAmount).toFixed(2)));
      }
    }

    if (entry.kind === "bill" && entry.pendingAmount <= 0.01) continue;

    const { kind, ...openBillEntry } = entry;
    const bucket = byLedger[requestedLedgerName] || emptyOpenBillBucket(requestedLedgerName);
    bucket.rawCount += 1;
    if (kind === "advance") {
      bucket.existingAdvances.push(openBillEntry);
    } else {
      bucket.openBills.push(openBillEntry);
    }
    byLedger[requestedLedgerName] = bucket;
  }

  const firstLedgerName = ledgerNames[0];
  const firstLedgerBucket = byLedger[firstLedgerName] || emptyOpenBillBucket(firstLedgerName);
  const settlementEvidence = await reminderSettlementEvidence(tallyUrl, commandPayload, companyName, ledgerNames, firstLedgerBucket, exportCollection);

  return {
    success: true,
    result: {
      ledgerName: firstLedgerName,
      settlementEvidence,
      ledgerNames,
      byLedger,
      openBills: firstLedgerBucket.openBills,
      existingAdvances: firstLedgerBucket.existingAdvances,
      rawCount: Object.values(byLedger).reduce((total, bucket) => total + bucket.rawCount, 0),
      queryDiagnostics: {
        requestedLedgerCount: ledgerNames.length,
        billBatchCount: billExport.batchCount,
        billQueryMode: billExport.queryMode,
        billObjectCount: billBlocks.length,
        voucherFallbackUsed: evidenceLedgerNames.length > 0,
        voucherFallbackLedgerCount: evidenceLedgerNames.length,
        voucherEvidenceMode: dependencies.forceVoucherEvidence ? "required" : "fallback",
        voucherBatchCount: voucherExport.batchCount,
        voucherQueryMode: voucherExport.queryMode || "targeted_chunks",
        voucherDateChunkCount: voucherExport.dateChunkCount ?? 0,
        voucherRetrySplitCount: voucherExport.retrySplitCount ?? 0,
        asOfDate,
      },
    },
  };
}

function taxLedgerIdentity(master) {
  const name = master.name || "";
  const raw = master.raw || {};
  const dutyHead = String(raw.gstDutyHead || "");
  const taxType = String(raw.taxType || "");

  return `${name} ${dutyHead} ${taxType}`;
}

function isGstLedger(master) {
  return /\b(gst|cgst|sgst|igst|cess|central\s+tax|state\s+tax|integrated\s+tax)\b/i.test(
    taxLedgerIdentity(master)
  );
}

function isWithholdingTaxLedger(master) {
  return /\b(tds|tcs|tax\s+deducted|tax\s+collected)\b/i.test(
    taxLedgerIdentity(master)
  );
}

function classifyTaxLedgers(ledgers) {
  return {
    gstLedgers: dedupeMasters(ledgers.filter(isGstLedger)),
    taxLedgers: dedupeMasters(ledgers.filter(isWithholdingTaxLedger)),
  };
}

function gstStateCodeFromName(value) {
  const key = normalizeLooseName(value);
  if (!key) return null;
  const codes = new Map([
    ["jammu and kashmir", "01"], ["himachal pradesh", "02"], ["punjab", "03"],
    ["chandigarh", "04"], ["uttarakhand", "05"], ["haryana", "06"], ["delhi", "07"],
    ["rajasthan", "08"], ["uttar pradesh", "09"], ["bihar", "10"], ["sikkim", "11"],
    ["arunachal pradesh", "12"], ["nagaland", "13"], ["manipur", "14"], ["mizoram", "15"],
    ["tripura", "16"], ["meghalaya", "17"], ["assam", "18"], ["west bengal", "19"],
    ["jharkhand", "20"], ["odisha", "21"], ["chhattisgarh", "22"], ["madhya pradesh", "23"],
    ["gujarat", "24"], ["dadra and nagar haveli and daman and diu", "26"],
    ["maharashtra", "27"], ["karnataka", "29"], ["goa", "30"], ["lakshadweep", "31"],
    ["kerala", "32"], ["tamil nadu", "33"], ["puducherry", "34"],
    ["andaman and nicobar islands", "35"], ["telangana", "36"], ["andhra pradesh", "37"],
    ["ladakh", "38"], ["other territory", "97"],
  ].map(([name, code]) => [normalizeLooseName(name), code]));
  return codes.get(key) || null;
}

function toBankLedgerPayload(master) {
  return {
    name: master.name,
    parent: master.parent || "Bank Accounts",
    guid: master.guid || null,
    bankName: master.bankName || null,
    bankAccountNumber: master.bankAccountNumber || null,
    ifscCode: master.ifscCode || null,
    branchName: master.branchName || null,
    accountHolderName: master.accountHolderName || null,
    closingBalance: Number.isFinite(master.closingBalance) ? master.closingBalance : null,
    closingBalanceType: master.closingBalanceType || null,
  };
}

function findBankLedgersFromMasters(ledgers, groups) {
  const groupParentByName = new Map(
    groups
      .filter((group) => group?.name)
      .map((group) => [normalizeLooseName(group.name), group.parent || null])
  );

  const descendsFromBankAccounts = (parentName) => {
    const visited = new Set();
    let currentName = parentName;

    while (currentName) {
      const normalized = normalizeLooseName(currentName);
      if (!normalized || visited.has(normalized)) return false;
      if (normalized === normalizeLooseName("Bank Accounts")) return true;
      visited.add(normalized);
      currentName = groupParentByName.get(normalized) || null;
    }

    return false;
  };

  return ledgers.filter((ledger) => {
    const hasBankIdentity = Boolean(
      ledger.bankName ||
      ledger.bankAccountNumber ||
      ledger.ifscCode ||
      ledger.branchName ||
      ledger.accountHolderName
    );
    return hasBankIdentity || descendsFromBankAccounts(ledger.parent);
  });
}

function findPartyLedgersFromMasters(ledgers, groups, rootGroupName) {
  const rootKey = normalizeLooseName(rootGroupName);
  const groupParentByName = new Map(
    groups
      .filter((group) => group?.name)
      .map((group) => [normalizeLooseName(group.name), group.parent || null])
  );

  const descendsFromRoot = (parentName) => {
    const visited = new Set();
    let currentName = parentName;
    while (currentName) {
      const normalized = normalizeLooseName(currentName);
      if (!normalized || visited.has(normalized)) return false;
      if (normalized === rootKey) return true;
      visited.add(normalized);
      currentName = groupParentByName.get(normalized) || null;
    }
    return false;
  };

  return ledgers.filter((ledger) => descendsFromRoot(ledger.parent));
}

function normalizeCashDiscountCustomerScope(input) {
  const value = input && typeof input === "object" ? input : {};
  const mode = value.mode === "custom" || value.mode === "strict" ? value.mode : "automatic";
  const selectedGroupNames = uniquePayloadLedgerNames({
    ledgerNames: Array.isArray(value.selectedGroupNames) && value.selectedGroupNames.length > 0
      ? value.selectedGroupNames
      : ["Sundry Debtors"],
  });
  return {
    mode,
    selectedGroupNames,
    includeNestedGroups: value.includeNestedGroups !== false,
    detectSalesLinkedExceptions: mode !== "strict" && value.detectSalesLinkedExceptions !== false,
    excludedGroupNames: uniquePayloadLedgerNames({ ledgerNames: value.excludedGroupNames || [] }),
    excludedLedgerNames: uniquePayloadLedgerNames({ ledgerNames: value.excludedLedgerNames || [] }),
  };
}

function selectCashDiscountLedgers(ledgers, groups, input) {
  const scope = normalizeCashDiscountCustomerScope(input);
  const selectedKeys = new Set(scope.selectedGroupNames.map(normalizeLooseName));
  const excludedGroupKeys = new Set(scope.excludedGroupNames.map(normalizeLooseName));
  const excludedLedgerKeys = new Set(scope.excludedLedgerNames.map(normalizeLooseName));
  const parentByGroup = new Map(groups.filter((group) => group?.name).map((group) => [
    normalizeLooseName(group.name),
    group.parent || null,
  ]));

  const classification = (ledger) => {
    if (excludedLedgerKeys.has(normalizeLooseName(ledger.name))) return null;
    const visited = new Set();
    let groupName = ledger.parent || null;
    while (groupName) {
      const key = normalizeLooseName(groupName);
      if (!key || visited.has(key) || excludedGroupKeys.has(key)) return null;
      if (selectedKeys.has(key)) {
        const direct = normalizeLooseName(ledger.parent) === key;
        if (scope.includeNestedGroups || direct) {
          return { source: "selected_group", rootGroupName: groupName };
        }
        return null;
      }
      visited.add(key);
      groupName = parentByGroup.get(key) || null;
    }
    return scope.detectSalesLinkedExceptions
      ? { source: "sales_linked_exception", rootGroupName: null }
      : null;
  };

  return ledgers.flatMap((ledger) => {
    const match = classification(ledger);
    return match ? [{ ...ledger, cashDiscountCustomerScope: match }] : [];
  });
}

function cashDiscountLiveLedger(master) {
  return {
    name: master.name,
    parent: master.parent || null,
    gstin: master.gstin || null,
    raw: {
      ...(master.raw || {}),
      email: master.email || null,
      phone: master.phone || null,
      contactPerson: master.contactPerson || null,
      address: master.address || null,
      billWiseEnabled: master.raw?.billWiseEnabled ?? null,
      cashDiscountCustomerScope: master.cashDiscountCustomerScope || null,
    },
  };
}

async function exportCashDiscountGroups(config, companyName) {
  const xml = await exportTallyCollection(config.tallyUrl, {
    collectionName: "Kalika Cash Discount Groups",
    tallyType: "Group",
    fetchFields: "Name,Parent,GUID",
    companyName,
  });
  return parseMasterCollection(xml, "GROUP");
}

async function exportCashDiscountLedgers(config, companyName, ledgerNames) {
  return exportNamedCashDiscountMasters(config, companyName, ledgerNames, "Ledger");
}

async function exportNamedCashDiscountMasters(config, companyName, names, type, exportXml = exportTallyXml) {
  const requested = uniquePayloadLedgerNames({ ledgerNames: names });
  const result = [];
  for (const batch of chunkValues(requested, 50)) {
    checkReadBudget();
    const response = await exportXml(config.tallyUrl, buildTargetedMastersXml({ companyName, names: batch, type }),
      `Kalika Cash Discount Targeted ${type} Details`, CASH_DISCOUNT_READ_MS);
    for (const [index, name] of batch.entries()) {
      const tag = `KALIKAMASTERSEED${index + 1}`;
      const blocks = extractBlocks(response, tag);
      if (blocks.length !== 1) throw new Error(`Tally did not return the requested ${type.toLowerCase()} details. Scan is incomplete.`);
      const master = toMaster(blocks[0], type.toUpperCase());
      if (!master || normalizeLooseName(master.name) !== normalizeLooseName(name) || !master.guid) {
        throw new Error(`Tally could not verify a requested ${type.toLowerCase()}. Scan is incomplete.`);
      }
      result.push(master);
    }
  }
  return result;
}

async function exportCashDiscountAncestorGroups(config, companyName, ledgers, exportNamed = exportNamedCashDiscountMasters) {
  const groups = [];
  const seen = new Set([normalizeLooseName("Primary")]);
  let pending = uniquePayloadLedgerNames({ ledgerNames: ledgers.map(ledger => ledger.parent).filter(Boolean) });
  for (let depth = 0; pending.length && depth < 32; depth++) {
    const names = pending.filter(name => !seen.has(normalizeLooseName(name)));
    if (!names.length) return groups;
    names.forEach(name => seen.add(normalizeLooseName(name)));
    const found = await exportNamed(config, companyName, names, "Group");
    groups.push(...found);
    pending = uniquePayloadLedgerNames({ ledgerNames: found.map(group => group.parent).filter(Boolean) });
  }
  if (pending.some(name => !seen.has(normalizeLooseName(name)))) throw new Error("Customer group hierarchy exceeds the safe depth limit. Scan is incomplete.");
  return groups;
}

async function exportCashDiscountOpenBillsFirst(config, companyName, dateRange, onProgress, dependencies = {}) {
  // Names only: do not compute balances, fetch voucher history, or exclude
  // zero-net-balance ledgers (they can still have unsettled individual bills).
  const directory = await (dependencies.exportCollection || exportTallyCollection)(config.tallyUrl, {
    collectionName: 'Kalika Open Bill Ledger Names', tallyType: 'Ledger',
    fetchFields: 'Name', companyName,
  });
  const names = extractNamedCollectionNames(directory, 'LEDGER');
  const pendingFilterName = "KalikaCashDiscountPendingBill";
  const fields = 'Name,Parent,LedgerName,PartyLedgerName,IsAdvance,BillType,TypeOfRef,Date,BillDate,DueDate,VoucherNumber,VoucherTypeName,OpeningBalance,ClosingBalance,Balance,PendingAmount,Amount';
  return readScopedOpenBills({
    names, check: dependencies.check || checkReadBudget, freeMemory: dependencies.freeMemory || (() => os.freemem()),
    batchLimit: dependencies.batchLimit || cashDiscountNativeUnionBatchSize, progress: onProgress,
    read: async (batch, index) => {
      const label = `Kalika Cash Discount Scoped Open Bills ${index}`;
      const members = batch.map((name, i) => `<COLLECTION NAME="KalikaOpenBills${i}" ISMODIFY="No"><TYPE>Bills</TYPE><CHILDOF>${escapeXml(tallyFormulaString(name))}</CHILDOF><COMPUTE>LedgerName : ${escapeXml(tallyFormulaString(name))}</COMPUTE><FILTER>${pendingFilterName}</FILTER><FETCH>${fields}</FETCH></COLLECTION>`).join('');
      const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${label}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>${dateRange?.dateTo ? `<SVTODATE TYPE="Date">${escapeXml(dateRange.dateTo.replaceAll('-', ''))}</SVTODATE>` : ''}<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE>${members}<SYSTEM TYPE="Formulae" NAME="${pendingFilterName}" ISMODIFY="No">${escapeXml(openBillPendingFormula())}</SYSTEM><COLLECTION NAME="${label}" ISMODIFY="No"><COLLECTIONS>${batch.map((_, i) => `KalikaOpenBills${i}`).join(',')}</COLLECTIONS><FETCH>${fields}</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
      // No SVFROMDATE: preserve carry-forward bills. Same read deadline and lane.
      return (dependencies.exportXml || exportTallyXml)(config.tallyUrl, xml, label, CASH_DISCOUNT_READ_MS);
    },
  });
}

// "setup 0.2 s, duesUpdate 0.3 s, customers 2.9 s (reads 2.4 s + calculation 0.4 s in 9 batches), ..."
export function formatScanStepTimes(stepMs = {}) {
  const seconds = (ms) => `${(Number(ms || 0) / 1000).toFixed(1)} s`;
  const order = ["setup", "duesUpdate", "openBills", "ledgerDetails", "customers", "finalCheck"];
  return order.filter((name) => stepMs[name] !== undefined).map((name) => name === "customers" && stepMs.customerBatches
    ? `customers ${seconds(stepMs.customers)} (reads ${seconds(stepMs.customerReads)} + calculation ${seconds(stepMs.customerCalculation)} in ${stepMs.customerBatches} batches)`
    : `${name} ${seconds(stepMs[name])}`).join(", ");
}

async function collectCashDiscountLiveSnapshot(config, operation, companyName, proposal, onProgress, financialYear, customerScope, readOptions = {}) {
  if (!cashDiscountReadContext.getStore()) {
    return cashDiscountReadContext.run({ deadlineAt: Date.now() + CASH_DISCOUNT_SCAN_MS }, () =>
      collectCashDiscountLiveSnapshot(config, operation, companyName, proposal, onProgress, financialYear, customerScope, readOptions));
  }
  checkReadBudget();
  const workflowCacheScope = {
    companyName: String(companyName || "").trim(),
    financialYear: String(financialYear || proposal?.financialYear || "").trim(),
    customerScope: customerScope || null,
  };
  // Revalidation always reads Tally; browse scans may reuse a scoped snapshot.
  const scanStarted = performance.now();
  // Per-step durations for the scan log line (diagnostics only).
  const stepMs = {};
  let stepMark = scanStarted;
  const lap = (name) => {
    const now = performance.now();
    stepMs[name] = (stepMs[name] || 0) + Math.round(now - stepMark);
    stepMark = now;
  };
  const tallyKey = normalizeTallyUrl(config.tallyUrl);
  const recentReadiness = recentCompanyReadiness.get(tallyKey);
  const readiness = recentReadiness && Date.now() - recentReadiness.checkedAt <= CASH_DISCOUNT_READINESS_REUSE_MS
    ? recentReadiness.value
    : await testTally(config.tallyUrl);
  if (!readiness.tallyReachable || !readiness.companyLoaded) {
    throw new Error(readiness.error || "Tally Prime is not ready for Cash Discount analysis.");
  }
  const requestedCompany = String(companyName || "").trim();
  if (requestedCompany && normalizeLooseName(requestedCompany) !== normalizeLooseName(readiness.companyName)) {
    throw new Error(`Tally is currently open to ${readiness.companyName || "another company"}. Switch to ${requestedCompany} and refresh.`);
  }
  const resolvedCompany = requestedCompany || readiness.companyName || null;
  const asOfDate = new Date().toISOString().slice(0, 10);
  const dateRange = cashDiscountFinancialYearRange(financialYear || proposal?.financialYear, asOfDate);
  if (!readOptions.resume || operation !== "cash_discount_scan") cashDiscountResultCache.clear();
  // Never share financial scan caches across similarly named companies/PCs.
  const companies = await fetchAvailableCompanies(config.tallyUrl, resolvedCompany);
  const companyGuid = companies.find((company) => normalizeLooseName(company.companyName) === normalizeLooseName(resolvedCompany))?.guid;
  workflowCacheScope.companyGuid = companyGuid || '';
  lap("setup");
  // Customer dues prepared in the Local Agent (kept current from Tally's change
  // counters) replace the heavy live reads. Without them, read Tally live.
  const prepared = operation === "cash_discount_scan"
    ? await config.__agentRuntime?.preparedReceivablesFor?.({ companyName: resolvedCompany, financialYear: dateRange.financialYear })
      .catch((error) => { console.error(`Prepared customer dues unavailable: ${error.message}`); return null; })
    : null;
  lap("duesUpdate");
  if (!prepared && companyGuid && operation === 'cash_discount_scan' && !readOptions.forceRefresh && !readOptions.resume) {
    const saved = await config.__agentRuntime?.getWorkflowSnapshot('cash_discount', workflowCacheScope, Infinity);
    if (saved?.scanSummary?.complete === true) {
      return { ...saved, cache: { ...saved.cache, ...workflowCacheState(saved.cache.updatedAt) } };
    }
  }
  const cacheScope = companyGuid && operation === "cash_discount_scan" ? JSON.stringify([
    config.connectionId, config.bridgeMachineId, tallyKey, companyGuid, resolvedCompany, dateRange, customerScope,
  ]) : null;

  const requestedLedgerName = String(proposal?.partyLedgerName || "").trim();

  let billExport = null;
  let preparedBills = null;
  let candidateLedgerNames = [];
  if (operation === "cash_discount_revalidate") {
    candidateLedgerNames = requestedLedgerName ? [requestedLedgerName] : [];
    if (!requestedLedgerName || !proposal?.linkedInvoiceNumber) throw new Error("A customer and invoice are required for revalidation.");
    const xml = await exportTallyCollection(config.tallyUrl, {
      collectionName: "Kalika Cash Discount Customer Bills",
      tallyType: "Bills",
      childOf: tallyFormulaString(requestedLedgerName),
      fetchFields: "Name,Parent,LedgerName,IsAdvance,BillType,TypeOfRef,Date,BillDate,DueDate,VoucherNumber,VoucherTypeName,OpeningBalance,ClosingBalance",
      companyName: resolvedCompany,
      dateTo: dateRange.dateTo,
    });
    const reference = normalizeLooseName(proposal.linkedInvoiceNumber);
    billExport = { xml: extractBlocks(xml, "BILL").filter((block) =>
      [getAttribute(block, "NAME"), getTagText(block, "NAME"), getTagText(block, "VOUCHERNUMBER")]
        .some((value) => normalizeLooseName(value) === reference)).join("\n"), batchCount: 1, queryMode: "ledger_scoped" };
  } else {
    onProgress?.(prepared ? "Checking customer dues..." : "Reading open customer bills from Tally...");
    if (prepared) {
      // Customer dues are held as fields in memory: no XML to read.
      preparedBills = await prepared.allBills();
      candidateLedgerNames = Array.from(new Set(preparedBills
        .filter((bill) => Boolean(bill.ledger && openBillFromFields(bill, bill.ledger)))
        .map((bill) => bill.ledger)
        .filter(Boolean)));
    } else {
      billExport = await exportCashDiscountOpenBillsFirst(config, resolvedCompany, dateRange, onProgress);
      candidateLedgerNames = Array.from(new Set(
        extractBlocks(billExport.xml, "BILL")
          .filter((block) => {
            const ledgerName = billLedgerName(block);
            return Boolean(ledgerName && toOpenBill(block, ledgerName));
          })
          .map(billLedgerName)
          .filter(Boolean)
      ));
    }
    const benchmarkLedgerLimit = Number(process.env.KALIKA_CASH_DISCOUNT_BENCHMARK_LEDGER_LIMIT);
    if (Number.isInteger(benchmarkLedgerLimit) && benchmarkLedgerLimit > 0) {
      candidateLedgerNames = candidateLedgerNames.slice(0, benchmarkLedgerLimit);
    }
  }

  if (candidateLedgerNames.length === 0) {
    return {
      companyName: resolvedCompany,
      financialYear: dateRange.financialYear,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      ledgers: [],
      openBillsResult: { success: true, result: { ledgerNames: [], byLedger: {}, openBills: [], existingAdvances: [], rawCount: 0 } },
    };
  }

  lap("openBills");
  onProgress?.(`Reading ${candidateLedgerNames.length} customer ledger${candidateLedgerNames.length === 1 ? "" : "s"} represented by open bills...`);
  // The open-bill read above proves which parties are currently relevant. Use
  // the AlterID-maintained local catalogue for their master details and group
  // ancestry; fall back to targeted live reads if the first sync is not ready.
  const localCatalogue = await config.__agentRuntime?.localMasterCatalogue({
    companyName: resolvedCompany,
    companyGuid,
    financialYear: dateRange.financialYear,
    requestedTypes: ["ledger", "group"],
  }, { moduleName: readOptions.moduleName === "followups" ? "followups" : "cashDiscount" });
  const localLedgerByName = new Map((localCatalogue?.ledgers || []).map((ledger) => [normalizeLooseName(ledger.name), ledger]));
  const localCandidateLedgers = candidateLedgerNames.map((name) => localLedgerByName.get(normalizeLooseName(name))).filter(Boolean);
  // Ledgers missing from the saved list (e.g. created since the last sync)
  // are read from Tally on their own; the rest come from the saved list.
  const missingLedgerNames = candidateLedgerNames.filter((name) => !localLedgerByName.has(normalizeLooseName(name)));
  let candidateLedgers = localCandidateLedgers;
  if (!localLedgerByName.size) {
    candidateLedgers = await exportCashDiscountLedgers(config, resolvedCompany, candidateLedgerNames);
  } else if (missingLedgerNames.length) {
    const fetchedByName = new Map((await exportCashDiscountLedgers(config, resolvedCompany, missingLedgerNames))
      .map((ledger) => [normalizeLooseName(ledger.name), ledger]));
    candidateLedgers = candidateLedgerNames
      .map((name) => localLedgerByName.get(normalizeLooseName(name)) || fetchedByName.get(normalizeLooseName(name)))
      .filter(Boolean);
  }
  const groups = localCatalogue?.groups?.length
    ? localCatalogue.groups
    : await exportCashDiscountAncestorGroups(config, resolvedCompany, candidateLedgers);
  const scopedLedgers = selectCashDiscountLedgers(candidateLedgers, groups, customerScope);
  lap("ledgerDetails");
  const ledgersToScan = operation === "cash_discount_revalidate"
    ? scopedLedgers.filter((ledger) => normalizeLooseName(ledger.name) === normalizeLooseName(requestedLedgerName))
    : scopedLedgers;

  if (operation === "cash_discount_revalidate" && ledgersToScan.length !== 1) {
    throw new Error("The selected customer is outside the configured Cash Discount customer scope in Tally.");
  }

  if (ledgersToScan.length === 0) {
    return {
      companyName: resolvedCompany,
      financialYear: dateRange.financialYear,
      dateFrom: dateRange.dateFrom,
      dateTo: dateRange.dateTo,
      ledgers: scopedLedgers.map(cashDiscountLiveLedger),
      openBillsResult: { success: true, result: { ledgerNames: [], byLedger: {}, openBills: [], existingAdvances: [], rawCount: 0 } },
    };
  }

  const ledgerResults = prepared
    ? await collectPreparedCustomerEvidence(prepared, preparedBills, ledgersToScan, dateRange, stepMs)
    : await collectCashDiscountCustomerEvidence(config, {
      companyName: resolvedCompany, ledgers: ledgersToScan,
      billExport, dateRange, onProgress, cacheScope, resume: readOptions.resume === true,
    });
  lap("customers");
  if (operation === "cash_discount_revalidate" && !ledgerResults.complete) {
    throw new Error(ledgerResults.failures[0]?.error || "The invoice recheck is incomplete. No debit note was created.");
  }
  let openBillsResult = { success: true, result: ledgerResults };
  const verifiedLedgerKeys = new Set(ledgersToScan.flatMap((ledger) => {
    if (ledger.cashDiscountCustomerScope?.source !== "sales_linked_exception") {
      return [normalizeLooseName(ledger.name)];
    }
    const bucket = openBillsResult.result?.byLedger?.[ledger.name];
    const hasSalesEvidence = Array.isArray(bucket?.openBills) &&
      bucket.openBills.some((bill) => Boolean(String(bill?.sourceSalesLedgerName || "").trim()));
    return hasSalesEvidence ? [normalizeLooseName(ledger.name)] : [];
  }));
  const verifiedLedgers = ledgersToScan.filter((ledger) => verifiedLedgerKeys.has(normalizeLooseName(ledger.name)));
  if (verifiedLedgers.length !== ledgersToScan.length) {
    const byLedger = Object.fromEntries(Object.entries(openBillsResult.result?.byLedger || {}).filter(([name]) =>
      verifiedLedgerKeys.has(normalizeLooseName(name))
    ));
    const first = verifiedLedgers[0]?.name;
    const firstBucket = first ? byLedger[first] : null;
    openBillsResult = {
      ...openBillsResult,
      result: {
        ...openBillsResult.result,
        ledgerName: first || null,
        ledgerNames: verifiedLedgers.map((ledger) => ledger.name),
        byLedger,
        openBills: firstBucket?.openBills || [],
        existingAdvances: firstBucket?.existingAdvances || [],
        rawCount: Object.values(byLedger).reduce((total, bucket) => total + Number(bucket?.rawCount || 0), 0),
      },
    };
  }
  if (operation === "cash_discount_revalidate" && verifiedLedgers.length !== 1) {
    throw new Error("The selected non-standard customer no longer has verified Sales invoice evidence in Tally.");
  }
  // Never return a previous company's evidence after the user switches Tally.
  const finalState = await cashDiscountReadContext.run({ ...cashDiscountReadContext.getStore(), deadlineAt: Date.now() + 5_000 }, async () => {
    const active = await testTally(config.tallyUrl);
    const currentCompanies = companyGuid ? await fetchAvailableCompanies(config.tallyUrl, resolvedCompany) : [];
    return { active, guid: currentCompanies.find((company) => normalizeLooseName(company.companyName) === normalizeLooseName(resolvedCompany))?.guid };
  });
  lap("finalCheck");
  if (!finalState.active.companyLoaded || normalizeLooseName(finalState.active.companyName) !== normalizeLooseName(resolvedCompany) || (companyGuid && finalState.guid !== companyGuid)) {
    cashDiscountResultCache.clear();
    throw new Error("Tally company changed or could not be verified during the scan. Refresh and select the company again.");
  }
  const snapshot = {
    cache: prepared
      ? { source: 'prepared_customer_dues', updatedAt: prepared.state?.checkedAt || new Date().toISOString(), stale: false }
      : { source: 'live_tally', updatedAt: new Date().toISOString(), stale: false },
    companyName: resolvedCompany,
    financialYear: dateRange.financialYear,
    dateFrom: dateRange.dateFrom,
    dateTo: dateRange.dateTo,
    ledgers: verifiedLedgers.map(cashDiscountLiveLedger),
    openBillsResult,
    scanSummary: { complete: ledgerResults.complete, completed: ledgerResults.completedCount,
      total: ledgersToScan.length, failures: ledgerResults.failures, reused: ledgerResults.reusedCount,
      resumable: Boolean(cacheScope && !ledgerResults.complete), elapsedMs: Math.round(performance.now() - scanStarted),
      stepMs,
      // Where invoices, receipts and bills came from; written to the log.
      dataSource: prepared ? "customer_dues" : "live_tally",
      customerDuesCheckedAt: prepared?.state?.checkedAt || null },
  };
  if (operation === "cash_discount_scan" && snapshot.scanSummary.complete) {
    await config.__agentRuntime?.putWorkflowSnapshot("cash_discount", workflowCacheScope, snapshot);
  }
  return snapshot;
}

// Analysed Cash Discount / Payment Follow-ups dashboards held for paging:
// the latest one per company, year and kind, plus the one before it so a page
// still open on the previous result keeps working until it refreshes.
const collectionsDashboards = new Map();
const COLLECTIONS_DASHBOARDS_KEPT_PER_SCOPE = 2;

function storeCollectionsDashboard(config, { companyName, financialYear, followUps, dashboard }) {
  const scope = [config.connectionId, normalizeLooseName(companyName), financialYear || "", followUps ? "followups" : "discounts"].join("|");
  const shell = dashboardShell(dashboard);
  const dashboardId = `${scope}|${shell.summary.revision}`;
  collectionsDashboards.delete(dashboardId);
  collectionsDashboards.set(dashboardId, { scope, dashboard });
  const sameScope = [...collectionsDashboards.keys()].filter((key) => collectionsDashboards.get(key).scope === scope);
  for (const key of sameScope.slice(0, Math.max(0, sameScope.length - COLLECTIONS_DASHBOARDS_KEPT_PER_SCOPE))) collectionsDashboards.delete(key);
  return { ...shell, dashboardId };
}

function answerCollectionsRequest(config, operation, message) {
  const dashboardId = String(message.payload?.dashboardId || "");
  // Only this connection's dashboards; the id alone is never enough.
  if (!dashboardId.startsWith(`${config.connectionId}|`)) throw new Error("This dashboard belongs to another connection.");
  const held = collectionsDashboards.get(dashboardId);
  if (!held) throw new Error("These results have been replaced by a newer check. Refresh to continue.");
  if (operation === "collections_query") return queryCollections(held.dashboard, message.payload?.query || {});
  const view = String(message.payload?.view || "");
  if (!["followUps", "pending", "created"].includes(view)) throw new Error("Unknown collections list.");
  const rows = Array.isArray(message.payload?.invoiceKeys)
    ? collectionRowsByInvoice(held.dashboard, view, message.payload.invoiceKeys)
    : collectionRowsById(held.dashboard, view, Array.isArray(message.payload?.ids) ? message.payload.ids : []);
  return { view, rows };
}

// The same per-customer result as collectCashDiscountCustomerEvidence, from
// customer dues held as fields in memory: no Tally read and no XML parsing.
// Customers are calculated in batches of 250 with the invoices and receipts
// of that batch, exactly as the XML calculation grouped them.
async function collectPreparedCustomerEvidence(prepared, bills, ledgers, dateRange, stepMs) {
  const billsByLedger = new Map();
  for (const bill of bills) {
    const key = normalizeLooseName(bill.ledger);
    if (!billsByLedger.has(key)) billsByLedger.set(key, []);
    billsByLedger.get(key).push(bill);
  }
  const byLedger = {};
  const failures = [];
  let completedCount = 0;
  let batchCount = 0;
  for (let offset = 0; offset < ledgers.length; offset += 250) {
    const batch = ledgers.slice(offset, offset + 250);
    const readStarted = performance.now();
    const ledgerNames = uniquePayloadLedgerNames({ ledgerNames: batch.map((ledger) => ledger.name) });
    const records = await prepared.recordsFor(ledgerNames, { dateTo: dateRange.dateTo });
    const calculateStarted = performance.now();
    const batchBills = batch.flatMap((ledger) => billsByLedger.get(normalizeLooseName(ledger.name)) || []);
    const { byLedger: buckets } = openBillsByLedgerFromFields(ledgerNames, batchBills, records.vouchers);
    for (const ledger of batch) {
      const bucket = buckets[ledger.name];
      if (!bucket) {
        const error = `Customer dues returned no result for ${ledger.name}.`;
        failures.push({ ledgerName: ledger.name, error });
        byLedger[ledger.name] = { ...emptyOpenBillBucket(ledger.name), complete: false, error };
        continue;
      }
      byLedger[ledger.name] = { ...bucket, complete: true };
      completedCount += 1;
    }
    stepMs.customerReads = (stepMs.customerReads || 0) + Math.round(calculateStarted - readStarted);
    stepMs.customerCalculation = (stepMs.customerCalculation || 0) + Math.round(performance.now() - calculateStarted);
    stepMs.customerBatches = (stepMs.customerBatches || 0) + 1;
    batchCount += 1;
    // Keep the connector responsive between batches.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { byLedger, ledgerNames: ledgers.map((ledger) => ledger.name), completedCount, reusedCount: 0,
    complete: failures.length === 0, failures,
    rawCount: Object.values(byLedger).reduce((total, bucket) => total + bucket.rawCount, 0),
    queryDiagnostics: { voucherQueryMode: "customer_dues_fields", evidenceBatchSize: 250, evidenceBatchCount: batchCount,
      requestedLedgerCount: ledgers.length } };
}

async function collectCashDiscountCustomerEvidence(config, { companyName, ledgers, billExport, dateRange, onProgress, cacheScope, resume }, dependencies = {}) {
  const readCustomer = dependencies.readCustomer || fetchCustomerOpenBillsFromTally;
  const resultLimitBytes = Number(dependencies.resultLimitBytes) || CASH_DISCOUNT_RESULT_BYTES;
  const freeMemory = dependencies.freeMemory || os.freemem;
  const batchLimit = dependencies.batchLimit || cashDiscountNativeUnionBatchSize;
  const evidenceBatchSize = Math.max(1, Number(dependencies.evidenceBatchSize) || cashDiscountNativeUnionBatchSize());
  const blocksByLedger = new Map();
  for (const block of extractBlocks(billExport.xml, "BILL")) {
    const key = normalizeLooseName(billLedgerName(block));
    if (!blocksByLedger.has(key)) blocksByLedger.set(key, []);
    blocksByLedger.get(key).push(block);
  }
  const byLedger = {};
  const failures = [];
  let completedCount = 0;
  let reusedCount = 0;
  let resultBytes = 0;
  let stopReason = null;

  const pendingEntries = [];
  for (const ledger of ledgers) {
    const billXml = (blocksByLedger.get(normalizeLooseName(ledger.name)) || []).join("\n");
    const cacheKey = cacheScope ? createHash("sha256").update(JSON.stringify([cacheScope, ledger.guid, ledger.name, billXml])).digest("hex") : null;
    const cached = cacheKey && resume ? cashDiscountResultCache.get(cacheKey) : null;
    if (cached) {
      const bucketBytes = Buffer.byteLength(JSON.stringify(cached));
      if (resultBytes + bucketBytes > resultLimitBytes) {
        stopReason = "Cash Discount results reached the safe size limit.";
        break;
      }
      resultBytes += bucketBytes;
      byLedger[ledger.name] = { ...cached, complete: true };
      completedCount += 1;
      reusedCount += 1;
      continue;
    }
    pendingEntries.push({ ledger, billXml, cacheKey });
  }

  let nextBatchSize = evidenceBatchSize;
  let evidenceBatchCount = 0;
  for (let offset = 0; offset < pendingEntries.length;) {
    const batch = pendingEntries.slice(offset, offset + Math.min(nextBatchSize, batchLimit()));
    const batchIndex = evidenceBatchCount++;
    const started = performance.now();
    try {
      checkReadBudget();
      if (freeMemory() < LIVE_READ_MIN_FREE_BYTES) throw new Error("Scan paused: this computer is very low on memory (less than 256 MB free). Close other applications before resuming.");
      if (stopReason) throw new Error(stopReason);
      const ledgerNames = batch.map((entry) => entry.ledger.name);
      onProgress?.(`Reading customers ${completedCount + 1}-${Math.min(ledgers.length, completedCount + batch.length)}/${ledgers.length} in one Tally batch. ${completedCount} completed.`);
      const result = await readCustomer(config, {
        companyName, ledgerNames, dateFrom: dateRange.dateFrom, asOfDate: dateRange.dateTo,
      }, { forceVoucherEvidence: true, billExport: {
        ...billExport, xml: batch.map((entry) => entry.billXml).join("\n"),
      } });
      const batchBuckets = result.result?.byLedger || {};
      const resolved = [];
      for (const entry of batch) {
        const bucket = batchBuckets[entry.ledger.name];
        if (!bucket) throw new Error(`Tally returned no verifiable result for ${entry.ledger.name}.`);
        const bucketBytes = Buffer.byteLength(JSON.stringify(bucket));
        if (resultBytes + bucketBytes > resultLimitBytes) throw new Error("Cash Discount results reached the safe size limit.");
        resultBytes += bucketBytes;
        const completedBucket = { ...bucket, complete: true };
        resolved.push({ ...entry, bucket: completedBucket });
      }
      for (const entry of resolved) {
        byLedger[entry.ledger.name] = entry.bucket;
        if (entry.cacheKey) cashDiscountResultCache.set(entry.cacheKey, entry.bucket);
        completedCount += 1;
      }
      const elapsedMs = performance.now() - started;
      if (elapsedMs > 5_000) nextBatchSize = Math.max(1, Math.floor(batch.length / 2));
      offset += batch.length;
      onProgress?.(`Completed ${completedCount}/${ledgers.length} customers (${Math.round(elapsedMs)} ms for batch ${batchIndex + 1}).`);
    } catch (error) {
      // Do not enqueue more Tally work after a failure: HTTP cancellation does
      // not prove Tally stopped its internal calculation.
      cashDiscountReadContext.getStore()?.signal?.throwIfAborted();
      stopReason ||= error instanceof Error ? error.message : String(error);
      break;
    }
  }
  if (stopReason) {
    for (const ledger of ledgers) {
      if (byLedger[ledger.name]) continue;
      failures.push({ ledgerName: ledger.name, error: stopReason });
      byLedger[ledger.name] = { ...emptyOpenBillBucket(ledger.name), complete: false, error: stopReason };
    }
  }
  return { byLedger, ledgerNames: ledgers.map((ledger) => ledger.name), completedCount, reusedCount,
    complete: failures.length === 0, failures,
    rawCount: Object.values(byLedger).reduce((total, bucket) => total + bucket.rawCount, 0),
    queryDiagnostics: { voucherQueryMode: "native_ledger_union", evidenceBatchSize, evidenceBatchCount,
      resultBytes, requestedLedgerCount: ledgers.length } };
}

async function collectTallyCompanyCheck(config) {
  const startedAt = performance.now();
  const measure = async (work) => {
    const probeStartedAt = performance.now();
    const data = await work();
    return { data, durationMs: Number((performance.now() - probeStartedAt).toFixed(2)) };
  };
  const activeProbe = await measure(() => testTally(config.tallyUrl));
  const companiesProbe = await measure(() => fetchAvailableCompanies(config.tallyUrl));
  const readiness = activeProbe.data;
  if (!readiness.tallyReachable || !readiness.companyLoaded || !readiness.companyName) {
    throw new Error(readiness.error || "Tally Prime is not ready to identify the active company.");
  }
  recentCompanyReadiness.set(normalizeTallyUrl(config.tallyUrl), {
    checkedAt: Date.now(),
    value: readiness,
  });
  const activeKey = normalizeLooseName(readiness.companyName);
  const companies = companiesProbe.data.map((company) => ({
    ...company,
    isActive: normalizeLooseName(company.companyName) === activeKey,
  }));
  if (!companies.some((company) => company.isActive)) {
    companies.unshift({
      companyName: readiness.companyName,
      guid: null,
      financialYear: null,
      financialYearStart: null,
      booksFrom: null,
      currentPeriod: null,
      isActive: true,
    });
  }
  companies.sort((left, right) =>
    Number(right.isActive) - Number(left.isActive) || left.companyName.localeCompare(right.companyName)
  );
  return {
    activeCompany: readiness.companyName,
    selectedCompany: readiness.companyName,
    companies,
    timings: {
      activeCompanyMs: activeProbe.durationMs,
      companiesMs: companiesProbe.durationMs,
      totalMs: Number((performance.now() - startedAt).toFixed(2)),
    },
  };
}

async function executeCashDiscountDebitNote(config, payload) {
  cashDiscountResultCache.clear();
  const readiness = await testTally(config.tallyUrl);
  const requestedCompany = String(payload?.companyName || "").trim();
  if (!readiness.tallyReachable || !readiness.companyLoaded) {
    throw new Error(readiness.error || "Tally Prime is not ready to create the Debit Note.");
  }
  if (requestedCompany && normalizeLooseName(requestedCompany) !== normalizeLooseName(readiness.companyName)) {
    throw new Error(`Tally is currently open to ${readiness.companyName || "another company"}. Switch to ${requestedCompany} before creating the Debit Note.`);
  }

  let existingVoucher = null;
  try {
    existingVoucher = await resolveDebitNoteVoucher(config.tallyUrl, payload, requestedCompany || readiness.companyName);
  } catch (error) {
    if (!/did not return the expected Debit Note/i.test(String(error?.message || ""))) throw error;
  }
  if (existingVoucher) {
    return {
      success: true,
      result: {
        alreadyInTally: true,
        voucherId: existingVoucher.masterId,
        voucherGuid: existingVoucher.guid || null,
        voucherNumber: existingVoucher.voucherNumber,
        voucherDate: normalizeDateForCompare(existingVoucher.effectiveDate || existingVoucher.date),
        openReferenceName: existingVoucher.reference || null,
        voucherReference: existingVoucher.reference || null,
        voucherAlterId: existingVoucher.alterId || null,
        voucherType: existingVoucher.voucherType,
        partyLedgerName: existingVoucher.partyLedgerName || null,
      },
    };
  }

  const posted = await postDebitNote(config.tallyUrl, payload, requestedCompany || readiness.companyName);
  if (!posted.outcome.success) {
    throw new Error(posted.outcome.error || "Tally did not create the Debit Note.");
  }
  const voucher = await resolveDebitNoteVoucher(
    config.tallyUrl,
    { ...payload, tallyVoucherId: posted.outcome.result?.lastVchId },
    requestedCompany || readiness.companyName
  );
  return {
    success: true,
    result: {
      ...(posted.outcome.result || {}),
      voucherId: voucher.masterId,
      voucherGuid: voucher.guid || null,
      voucherNumber: voucher.voucherNumber,
      voucherDate: normalizeDateForCompare(voucher.effectiveDate || voucher.date),
      openReferenceName: voucher.reference || null,
      voucherReference: voucher.reference || null,
      voucherAlterId: voucher.alterId || null,
      voucherType: voucher.voucherType,
      partyLedgerName: voucher.partyLedgerName || null,
    },
  };
}

async function fetchBankLedgersFromTally(config, commandPayload = {}) {
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const companyNames = mergeCompanyNames([
    ...(Array.isArray(commandPayload.companyNames) ? commandPayload.companyNames : []),
    commandPayload.companyName,
  ]);
  const targets = companyNames.length > 0 ? companyNames : [null];
  const byCompany = {};
  const errors = [];

  for (const companyName of targets) {
    const key = companyName || "Current company";
    try {
      const [ledgerXml, groupXml] = await Promise.all([
        exportTallyCollection(tallyUrl, {
          collectionName: "Autodealer Bank Ledger Discovery",
          tallyType: "Ledger",
          fetchFields:
            "Name,Parent,GUID,ClosingBalance,BankName,Bank,BankerName,BankAccountNumber,AccountNumber,BankAccountNo,BankAcNo,AcNumber,IFSCCODE,IFSCODE,IFSC,BankIFSCCODE,BranchName,BankBranchName,Branch,BankAccHolderName,BankAccountName,BankAccountHolderName,AccountHolderName",
          companyName,
        }),
        exportTallyCollection(tallyUrl, {
          collectionName: "Autodealer Bank Group Discovery",
          tallyType: "Group",
          fetchFields: "Name,Parent,GUID",
          companyName,
        }),
      ]);
      const ledgers = parseMasterCollection(ledgerXml, "LEDGER");
      const groups = parseMasterCollection(groupXml, "GROUP");
      byCompany[key] = findBankLedgersFromMasters(ledgers, groups)
        .map(toBankLedgerPayload);
    } catch (error) {
      errors.push({
        companyName: key,
        error: error instanceof Error ? error.message : String(error ?? "Could not fetch bank ledgers."),
      });
      byCompany[key] = [];
    }
  }

  if (Object.values(byCompany).every((ledgers) => !Array.isArray(ledgers) || ledgers.length === 0) && errors.length === targets.length) {
    throw new Error(errors[0]?.error || "Could not fetch bank ledgers from Tally.");
  }

  const firstCompanyName = targets[0] || "Current company";

  return {
    success: true,
    result: {
      source: "tally_bank_accounts_group",
      companyName: firstCompanyName,
      companyNames: targets.filter(Boolean),
      bankLedgers: byCompany[firstCompanyName] || [],
      byCompany,
      errors,
    },
  };
}

export async function collectTallyMasters(config, commandPayload = {}) {
  const bankIdentity = commandPayload.bankDocumentIdentity;
  if (bankIdentity) assertBankDocumentScope(config, bankIdentity);
  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const requestedMasterTypes = new Set(
    Array.isArray(commandPayload.requestedMasterTypes)
      ? commandPayload.requestedMasterTypes.map((value) => String(value || "").trim())
      : []
  );
  const shouldFetch = (type) => {
    if (requestedMasterTypes.size === 0 || requestedMasterTypes.has(type)) return true;
    // GST/tax master rows are classified from Ledger exports, not a separate
    // Tally collection.
    return type === "ledger" && (requestedMasterTypes.has("gst_ledger") || requestedMasterTypes.has("tax_ledger"));
  };
  const fetches = [];
  const fetchMaster = (key, type, collectionName, fetchFields) => {
    if (!shouldFetch(type)) return;
    const request = () => exportTallyCollection(tallyUrl, {
      collectionName,
      tallyType: type === "stock_item" ? "StockItem" : type === "voucher_type" ? "VoucherType" : type[0].toUpperCase() + type.slice(1),
      fetchFields,
      companyName,
    });
    fetches.push([key, bankIdentity ? request : request()]);
  };
  fetchMaster("ledgerXml", "ledger", "Autodealer Ledgers Sync",
    "Name,Parent,GUID,ClosingBalance,PartyGSTIN,GSTIN,GSTRegistrationNumber,GSTRegNumber,GSTNo,GSTNumber,GSTIdentificationNumber,LedgerGSTIN,IsBillWiseOn,BankName,Bank,BankerName,BankAccountNumber,AccountNumber,BankAccountNo,BankAcNo,AcNumber,IFSCCODE,IFSCODE,IFSC,BankIFSCCODE,BranchName,BankBranchName,Branch,BankAccHolderName,BankAccountName,BankAccountHolderName,AccountHolderName,Email,EmailId,LedgerEmail,LedgerEmailId,LedgerMobile,Mobile,MobileNo,PhoneNumber,Phone,LedgerPhone,ContactPerson,Contact,AttentionTo,Address,Address1,Address2,Address3,Address4,Pincode,TaxType,GSTDutyHead,RateOfTaxCalculation,GSTDetails.*,GSTDetails.LIST.*,GSTRegistrationDetails.*,GSTRegistrationDetails.LIST.*,LedgerGSTRegistrationDetails.*,LedgerGSTRegistrationDetails.LIST.*,LedgerGSTRegDetails.*,LedgerGSTRegDetails.LIST.*,LedGSTRegDetails.*,LedGSTRegDetails.LIST.*");
  fetchMaster("groupXml", "group", "Autodealer Groups Sync", "Name,Parent,GUID");
  fetchMaster("stockItemXml", "stock_item", "Autodealer Stock Items Sync",
    "Name,Parent,GUID,BaseUnits,OriginalBaseUnits,GSTHSNCode,GSTHSNName,GSTHSNSACCode,GSTHSNSACName,HSNCode,HSNSACCode,HSNSACName,GSTOVRDNHSNCODE,HSNOVRDNCLASSIFICATION,HSN,HSNSAC,HSNCLASSIFICATION,HSNName,HSNDescription,GSTHSN,GSTTaxRate,RateOfTaxCalculation,GSTRATE,RateOfVAT,GSTDetails.*,GSTDetails.LIST.*,GSTHSNDetails.*,GSTHSNDetails.LIST.*,HSNDetails.*,HSNDetails.LIST.*,IsGSTApplicable");
  fetchMaster("unitXml", "unit", "Autodealer Units Sync", "Name,GUID,OriginalName,DecimalPlaces,IsSimpleUnit");
  fetchMaster("voucherTypeXml", "voucher_type", "Autodealer Voucher Types Sync", "Name,Parent,GUID");
  if (shouldFetch("ledger")) {
    const request = () => exportTallyCollection(tallyUrl, {
      collectionName: "Autodealer Company Profile Sync",
      tallyType: "Company",
      fetchFields: "Name,GUID,PartyGSTIN,GSTIN,GSTRegistrationNumber,GSTRegNumber,StateName,State,CountryName,Country,IsGSTOn,GSTRegistrationDetails.*" + (bankIdentity ? ',StartingFrom,FinancialYearFrom' : ''),
      companyName,
    });
    fetches.push(['companyXml', bankIdentity ? request : request().catch(() => '')]);
  }
  const resolved = {};
  if (bankIdentity) {
    // V2 has one Tally lane even within this logical read. Legacy behavior is
    // unchanged; the catalogue fields, ordering and parsing are identical.
    for (const [key, request] of fetches) resolved[key] = await request();
  } else Object.assign(resolved, Object.fromEntries(await Promise.all(fetches.map(async ([key, request]) => [key, await request]))));
  const ledgerXml = resolved.ledgerXml || "";
  const groupXml = resolved.groupXml || "";
  const stockItemXml = resolved.stockItemXml || "";
  const unitXml = resolved.unitXml || "";
  const voucherTypeXml = resolved.voucherTypeXml || "";
  const companyXml = resolved.companyXml || "";

  const ledgers = parseMasterCollection(ledgerXml, "LEDGER");
  const groups = parseMasterCollection(groupXml, "GROUP");
  const stockItems = parseMasterCollection(stockItemXml, "STOCKITEM");
  const units = parseMasterCollection(unitXml, "UNIT");
  const voucherTypes = parseMasterCollection(voucherTypeXml, "VOUCHERTYPE");
  const companies = parseMasterCollection(companyXml, "COMPANY");
  const activeCompany = companies.find(
    (company) => normalizeLooseName(company.name) === normalizeLooseName(companyName)
  ) || companies[0] || null;
  const companyGstin = activeCompany?.gstin || null;
  if (bankIdentity) {
    const block = extractBlocks(companyXml, 'COMPANY').find(value => (getTagText(value, 'NAME') || getAttribute(value, 'NAME')) === bankIdentity.companyName) || '';
    assertBankDocumentScope(config, bankIdentity, { name: activeCompany?.name, guid: activeCompany?.guid,
      financialYear: financialYearFromStartDate(normalizeTallyDate(getTagText(block, 'FINANCIALYEARFROM') || getTagText(block, 'STARTINGFROM'))) });
  }
  const companyStateCode =
    String(companyGstin || "").match(/^\d{2}/)?.[0] ||
    gstStateCodeFromName(activeCompany?.raw?.stateName) ||
    null;
  const { gstLedgers, taxLedgers } = classifyTaxLedgers(ledgers);

  return {
    // Keep the requested scope with the result. syncMastersFromTally uses this
    // to avoid sending omitted master types as empty arrays, which would retire
    // a previously-good snapshot for those types on the API.
    requestedMasterTypes: Array.from(requestedMasterTypes),
    ledgers,
    groups,
    stockItems,
    units,
    voucherTypes,
    gstLedgers,
    taxLedgers,
    companyProfile: activeCompany ? {
      name: activeCompany.name,
      guid: activeCompany.guid || null,
      gstin: companyGstin,
      stateCode: companyStateCode,
      stateName: activeCompany.raw?.stateName || null,
      countryName: activeCompany.raw?.countryName || null,
    } : {},
  };
}

async function fetchPurchaseMastersFromTally(
  config,
  commandPayload = {},
  logger = (_level, message) => console.log(message)
) {
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const readiness = await testTally(tallyUrl);
  if (!readiness.tallyReachable || !readiness.companyLoaded) {
    throw new Error(readiness.error || "Tally Prime is not ready to read Purchase masters.");
  }

  const requestedCompany = String(commandPayload.companyName || "").trim();
  const companyName = requestedCompany || readiness.companyName || null;
  if (
    requestedCompany &&
    normalizeLooseName(requestedCompany) !== normalizeLooseName(readiness.companyName)
  ) {
    throw new Error(
      `Tally is currently open to ${readiness.companyName || "another company"}. Switch to ${requestedCompany} before refreshing Purchase masters.`
    );
  }

  // Tally's local HTTP listener processes requests serially. Keep this small,
  // purpose-built set sequential so opening the review does not make Tally's
  // UI compete with several large collection exports at once.
  const ledgerXml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Live Purchase Ledgers",
    tallyType: "Ledger",
    fetchFields:
      "Name,Parent,GUID,PartyGSTIN,GSTIN,GSTRegistrationNumber,GSTRegNumber,GSTNo,GSTNumber,GSTIdentificationNumber,LedgerGSTIN,TaxType,GSTDutyHead,RateOfTaxCalculation,GSTDetails.*,GSTDetails.LIST.*,GSTRegistrationDetails.*,GSTRegistrationDetails.LIST.*,LedgerGSTRegistrationDetails.*,LedgerGSTRegistrationDetails.LIST.*,LedgerGSTRegDetails.*,LedgerGSTRegDetails.LIST.*,LedGSTRegDetails.*,LedGSTRegDetails.LIST.*",
    companyName,
  });
  const groupXml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Live Purchase Groups",
    tallyType: "Group",
    fetchFields: "Name,Parent,GUID",
    companyName,
  });
  const stockItemXml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Live Purchase Stock Items",
    tallyType: "StockItem",
    fetchFields:
      "Name,Parent,GUID,BaseUnits,OriginalBaseUnits,GSTHSNCode,GSTHSNName,GSTHSNSACCode,GSTHSNSACName,HSNCode,HSNSACCode,HSNSACName,GSTOVRDNHSNCODE,HSNOVRDNCLASSIFICATION,HSN,HSNSAC,HSNCLASSIFICATION,HSNName,HSNDescription,GSTHSN,GSTTaxRate,RateOfTaxCalculation,GSTRATE,RateOfVAT,GSTDetails.*,GSTDetails.LIST.*,GSTHSNDetails.*,GSTHSNDetails.LIST.*,HSNDetails.*,HSNDetails.LIST.*,IsGSTApplicable",
    companyName,
  });
  const unitXml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Live Purchase Units",
    tallyType: "Unit",
    fetchFields: "Name,GUID,OriginalName,DecimalPlaces,IsSimpleUnit",
    companyName,
  });
  const godownXml = commandPayload.includeInventoryLocations
    ? await exportTallyCollection(tallyUrl, {
        collectionName: "Kalika Live Purchase Godowns",
        tallyType: "Godown",
        fetchFields: "Name,Parent,GUID",
        companyName,
      })
    : "";
  const companyXml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Live Purchase Company",
    tallyType: "Company",
    fetchFields:
      "Name,GUID,PartyGSTIN,GSTIN,GSTRegistrationNumber,GSTRegNumber,StateName,State,CountryName,Country,IsGSTOn,GSTRegistrationDetails.*",
    companyName,
  }).catch(() => "");

  let ledgers = parseMasterCollection(ledgerXml, "LEDGER");
  const groups = parseMasterCollection(groupXml, "GROUP");
  const stockItems = parseMasterCollection(stockItemXml, "STOCKITEM");
  const units = parseMasterCollection(unitXml, "UNIT");
  const godowns = parseMasterCollection(godownXml, "GODOWN");
  const companies = parseMasterCollection(companyXml, "COMPANY");
  const activeCompany = companies.find(
    (company) => normalizeLooseName(company.name) === normalizeLooseName(companyName)
  ) || companies[0] || null;
  const companyGstin = activeCompany?.gstin || null;

  const requestedTargetedLedgerNames = Array.isArray(commandPayload.targetedLedgerNames)
    ? [...new Set(commandPayload.targetedLedgerNames
        .map((value) => String(value || "").trim())
        .filter(Boolean))].slice(0, 10)
    : [];
  const requestedTargetKeys = new Set(requestedTargetedLedgerNames.map(normalizeLooseName));
  const exactMissingGstinNames = ledgers
    .filter((ledger) => requestedTargetKeys.has(normalizeLooseName(ledger.name)) && !ledger.gstin)
    .map((ledger) => ledger.name);
  if (exactMissingGstinNames.length > 0) {
    try {
      const targetedDetails = await exportNamedCashDiscountMasters(
        { ...config, tallyUrl },
        companyName,
        exactMissingGstinNames,
        "Ledger"
      );
      ledgers = mergeTargetedPurchaseLedgerDetails(ledgers, targetedDetails);
      logger("info", `Purchase supplier detail read requested=${exactMissingGstinNames.length}, GSTIN recovered=${targetedDetails.filter((master) => master.gstin).length}.`);
    } catch (error) {
      logger("warn", `Purchase supplier detail read failed: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  const nativeMissingGstinNames = ledgers
    .filter((ledger) => requestedTargetKeys.has(normalizeLooseName(ledger.name)) && !ledger.gstin)
    .map((ledger) => ledger.name);
  if (nativeMissingGstinNames.length > 0) {
    try {
      const nativeDetails = await exportNativeLedgerGstRegistrations(tallyUrl, {
        companyName,
        ledgerNames: nativeMissingGstinNames,
      });
      ledgers = mergeTargetedPurchaseLedgerDetails(ledgers, nativeDetails);
      logger("info", `Purchase supplier native registration read requested=${nativeMissingGstinNames.length}, GSTIN recovered=${nativeDetails.filter((master) => master.gstin).length}.`);
    } catch (error) {
      logger("warn", `Purchase supplier native registration read failed: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  const diagnosticPayload = commandPayload.diagnostics && typeof commandPayload.diagnostics === "object"
    ? commandPayload.diagnostics
    : {};
  const diagnosticNames = Array.isArray(diagnosticPayload.masterNames)
    ? diagnosticPayload.masterNames
    : [];
  const diagnostics = diagnosticNames.length
    ? {
        company: {
          requestedName: companyName,
          returnedName: activeCompany?.name || null,
          guid: activeCompany?.guid || null,
          gstin: companyGstin,
          readinessCompany: readiness.companyName || null,
        },
        ledgerMasters: purchaseMasterDiagnostics(ledgerXml, "LEDGER", diagnosticNames),
        stockItemMasters: purchaseMasterDiagnostics(stockItemXml, "STOCKITEM", diagnosticNames),
      }
    : null;

  if (ledgers.length === 0) {
    throw new Error("Tally returned zero ledgers for the active company.");
  }

  return {
    success: true,
    result: {
      source: "live_tally",
      purpose: "purchase_posting_dropdowns",
      companyName: companyName || readiness.companyName || null,
      financialYear: commandPayload.financialYear || config.__agentRuntime?.activeIdentity?.financialYear || null,
      fetchedAt: new Date().toISOString(),
      bridgeVersion: BRIDGE_VERSION,
      companyProfile: {
        name: activeCompany?.name || companyName || readiness.companyName || null,
        guid: activeCompany?.guid || null,
        gstin: companyGstin,
        stateCode:
          String(companyGstin || "").match(/^\d{2}/)?.[0] ||
          gstStateCodeFromName(activeCompany?.raw?.stateName) ||
          null,
        stateName: activeCompany?.raw?.stateName || null,
      },
      diagnostics,
      masters: { ledgers, groups, stockItems, units, godowns },
      totals: {
        ledger: ledgers.length,
        group: groups.length,
        stock_item: stockItems.length,
        unit: units.length,
        godown: godowns.length,
      },
    },
  };
}

async function fetchPurchaseInventoryLocationsFromTally(config, commandPayload = {}) {
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const readiness = await testTally(tallyUrl);
  if (!readiness.tallyReachable || !readiness.companyLoaded) {
    throw new Error(readiness.error || "Tally Prime is not ready to read inventory locations.");
  }
  const requestedCompany = String(commandPayload.companyName || "").trim();
  const companyName = requestedCompany || readiness.companyName || null;
  if (requestedCompany && normalizeLooseName(requestedCompany) !== normalizeLooseName(readiness.companyName)) {
    throw new Error(`Tally is currently open to ${readiness.companyName || "another company"}. Switch to ${requestedCompany} before refreshing inventory locations.`);
  }
  const godownXml = await exportTallyCollection(tallyUrl, {
    collectionName: "Kalika Live Purchase Godowns",
    tallyType: "Godown",
    fetchFields: "Name,Parent,GUID",
    companyName,
  });
  return parseMasterCollection(godownXml, "GODOWN");
}

// Purchase review refreshes must bypass the AlterID-backed local catalogue.
// A master can gain GSTIN/HSN metadata without an AlterID delta that the
// incremental catalogue sees, so the review path needs the current Tally XML.
function shouldUseLivePurchaseMasterRead(isPurchaseRead, payload = {}) {
  return Boolean(isPurchaseRead && payload?.requireFresh === true);
}

async function postMastersToBackend(config, payload) {
  const response = await fetch(`${config.apiBase}/api/tally/bridge/masters`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.bridgeToken}`,
    },
    body: JSON.stringify(payload),
  });
  const result = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(result.error || `Master sync upload failed with HTTP ${response.status}.`);
  }

  return result;
}

async function syncMastersFromTally(config, commandPayload = {}, command = null) {
  const companyName = commandPayload.companyName || null;
  const tallyUrl = normalizeTallyUrl(commandPayload.tallyUrl || config.tallyUrl);
  const readiness = await testTally(tallyUrl);

  if (!readiness.tallyReachable) {
    throw new Error(readiness.error || "Tally Prime is not reachable.");
  }

  if (!readiness.companyLoaded) {
    throw new Error(readiness.error || "Tally Prime is reachable, but no company is loaded.");
  }

  const resolvedCompanyName = companyName || readiness.companyName || null;

  const requestedMasterTypes = new Set(
    Array.isArray(commandPayload.requestedMasterTypes)
      ? commandPayload.requestedMasterTypes.map((value) => String(value || "").trim())
      : []
  );
  const groupsOnly = requestedMasterTypes.size === 1 && requestedMasterTypes.has("group");

  if (groupsOnly) {
    const groups = await exportCashDiscountGroups(config, resolvedCompanyName);
    if (groups.length === 0) {
      throw new Error("Tally returned zero groups for the active company.");
    }
    const payload = {
      connectionId: config.connectionId,
      companyName: resolvedCompanyName,
      bridgeVersion: BRIDGE_VERSION,
      masters: { groups },
      companyProfile: {},
      commandId: command?.id,
      identity: command?.identity,
    };
    const syncResult = await postMastersToBackend(config, payload);
    return {
      success: true,
      result: {
        syncRunId: syncResult.syncRunId,
        totals: syncResult.totals,
        accepted: syncResult.accepted,
        companyName: payload.companyName,
        bridgeVersion: payload.bridgeVersion,
      },
    };
  }

  const masters = await collectTallyMasters(
    {
      ...config,
      tallyUrl,
      companyName: resolvedCompanyName,
    },
    {
      ...commandPayload,
      companyName: commandPayload.companyName || resolvedCompanyName,
    }
  );

  const isFullMasterSync = masters.requestedMasterTypes.length === 0;
  const requestedTypes = new Set(masters.requestedMasterTypes);
  if ((isFullMasterSync || requestedTypes.has("ledger")) && masters.ledgers.length === 0) {
    throw new Error("Tally returned zero ledgers. Open the correct company and try sync again.");
  }

  const masterPayload = {};
  if (isFullMasterSync || requestedTypes.has("ledger")) {
    masterPayload.ledgers = masters.ledgers;
  }
  if (isFullMasterSync || requestedTypes.has("group")) {
    masterPayload.groups = masters.groups;
  }
  if (isFullMasterSync || requestedTypes.has("stock_item")) {
    masterPayload.stockItems = masters.stockItems;
  }
  if (isFullMasterSync || requestedTypes.has("unit")) {
    masterPayload.units = masters.units;
  }
  if (isFullMasterSync || requestedTypes.has("voucher_type")) {
    masterPayload.voucherTypes = masters.voucherTypes;
  }
  // GST and tax ledgers are derived from the Ledger collection. They remain
  // opt-in so a Bank Statements refresh writes only its ledger/group scope.
  if (isFullMasterSync || requestedTypes.has("gst_ledger")) {
    masterPayload.gstLedgers = masters.gstLedgers;
  }
  if (isFullMasterSync || requestedTypes.has("tax_ledger")) {
    masterPayload.taxLedgers = masters.taxLedgers;
  }

  const payload = {
    connectionId: config.connectionId,
    companyName: resolvedCompanyName,
    bridgeVersion: BRIDGE_VERSION,
    masters: masterPayload,
    companyProfile: masters.companyProfile,
    commandId: command?.id,
    identity: command?.identity,
  };
  const syncResult = await postMastersToBackend(config, payload);

  return {
    success: true,
    result: {
      syncRunId: syncResult.syncRunId,
      totals: syncResult.totals,
      accepted: syncResult.accepted,
      companyName: payload.companyName,
      bridgeVersion: payload.bridgeVersion,
    },
  };
}

async function testTally(tallyUrl) {
  const readContext = cashDiscountReadContext.getStore();
  if (readContext?.schedule && !readContext.inTallyLane) {
    return readContext.schedule(() => cashDiscountReadContext.run({ ...readContext, inTallyLane: true },
      () => testTally(tallyUrl)), { signal: readContext.signal, deadlineAt: readContext.deadlineAt, priority: 50 });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), readContext
    ? Math.max(1, Math.min(TALLY_READINESS_TIMEOUT_MS, readContext.deadlineAt - Date.now())) : TALLY_READINESS_TIMEOUT_MS);
  try {
    const response = await fetch(tallyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
      },
      // A readiness check must stay lightweight. $$CurrentCompany both proves
      // that Tally's XML endpoint is responding and identifies the active UI
      // company without exporting the entire ledger catalogue.
      body: [
        "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>",
        "<TYPE>Function</TYPE><ID>$$CurrentCompany</ID></HEADER><BODY><DESC>",
        "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>",
        "</DESC></BODY></ENVELOPE>",
      ].join(""),
      signal: readContext?.signal ? AbortSignal.any([controller.signal, readContext.signal]) : controller.signal,
    });

    const text = await response.text();
    const looksLikeXml = /<\?xml|<ENVELOPE|<RESPONSE|<LISTOF/i.test(text);
    const lineError = text.match(/<LINEERROR[^>]*>([\s\S]*?)<\/LINEERROR>/i)?.[1]?.trim() ?? null;

    if (!response.ok) {
      return {
        tallyReachable: false,
        companyLoaded: false,
        companyName: null,
        error: `Tally returned HTTP ${response.status}.`,
      };
    }

    if (!looksLikeXml) {
      return {
        tallyReachable: true,
        companyLoaded: false,
        companyName: null,
        error: "Tally responded, but the response was not XML.",
      };
    }

    const activeCompanyName = !lineError
      ? getTagText(text, "RESULT") || extractCompanyName(text)
      : null;
    const companyLoaded = Boolean(activeCompanyName);

    return {
      tallyReachable: true,
      companyLoaded,
      companyName: companyLoaded ? activeCompanyName : null,
      error:
        lineError ?? (!activeCompanyName ? "Tally responded but no company is active." : null),
    };
  } catch (error) {
    return {
      tallyReachable: false,
      companyLoaded: false,
      companyName: null,
      error: formatTallyConnectivityError(tallyUrl, error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function receiveNextCommands(config, limit = MAX_COMMANDS_PER_CYCLE) {
  const url = new URL(`${config.apiBase}/api/tally/bridge/commands/next`);
  url.searchParams.set("connectionId", config.connectionId);
  url.searchParams.set("bridgeVersion", BRIDGE_VERSION);
  url.searchParams.set("limit", String(Math.max(1, Math.min(MAX_COMMANDS_PER_CYCLE, limit))));

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.bridgeToken}`,
    },
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(payload.error || `Command poll failed with HTTP ${response.status}.`);
  }

  return Array.isArray(payload.commands)
    ? payload.commands
    : payload.command
      ? [payload.command]
      : [];
}

async function sendCommandResult(config, command, outcome, existingOutboxItem = null) {
  const status = outcome.success ? "succeeded" : "failed";
  const error = outcome.error ?? null;
  console.log(`Reporting command ${command.id} as ${status}${error ? `: ${error}` : ""}`);

  const outboxItem = existingOutboxItem || (config.__agentRuntime
    ? await config.__agentRuntime.recordOutcome(command, outcome)
    : null);
  const response = await fetch(`${config.apiBase}/api/tally/bridge/commands/${command.id}/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.bridgeToken}`,
    },
    body: JSON.stringify({
      connectionId: config.connectionId,
      status,
      success: outcome.success,
      result: outcome.result ?? {},
      error,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentReceipt: outboxItem?.id ?? null,
      identity: command.identity ?? command.payload?.agentIdentity ?? null,
    }),
  });
  const payload = await readJsonResponse(response);

  // Only an accepted callback acknowledges durable delivery. A 404/409 can
  // indicate revoked routing or a conflicting result, not a successful replay.
  // Idempotent backend completion returns success for identical accepted results.
  if (!response.ok) {
    throw new Error(payload.error || `Command result failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (outboxItem && config.__agentRuntime) {
    await config.__agentRuntime.acknowledgeOutcome(outboxItem.id);
  }

  return payload;
}

function safeDocumentPathSegment(value, fallback) {
  const sanitized = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[.\s]+$/g, "")
    .slice(0, 100);
  return sanitized || fallback;
}

function downloadTrustedDocument(url, { timeoutMs = 60_000, redirectCount = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error("The source invoice download link is invalid."));
      return;
    }

    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.get(parsedUrl, {
      ...(parsedUrl.protocol === "https:" ? { ca: trustedCaCertificates() } : {}),
      headers: { Accept: "application/pdf,*/*;q=0.8" },
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error("The source invoice download redirected too many times."));
          return;
        }
        resolve(downloadTrustedDocument(new URL(location, parsedUrl).toString(), {
          timeoutMs,
          redirectCount: redirectCount + 1,
        }));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`The source invoice download returned HTTP ${status || "unknown"}.`));
        return;
      }

      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > MAX_PURCHASE_SOURCE_PDF_BYTES) {
        response.destroy();
        reject(new Error("The source invoice PDF is larger than the 25 MB connector limit."));
        return;
      }

      const chunks = [];
      let receivedBytes = 0;
      response.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_PURCHASE_SOURCE_PDF_BYTES) {
          response.destroy(new Error("The source invoice PDF is larger than the 25 MB connector limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("The source invoice download timed out after 60 seconds."));
    });
    request.on("error", (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      reject(new Error(`The connector could not download the source invoice PDF: ${detail}`));
    });
  });
}

// "<Supplier> <Invoice No>.pdf", safe for Windows (e.g. "/" in invoice
// numbers becomes "-"), as the client names purchase PDFs by hand.
export function sharedPurchaseDocumentFileName(payload) {
  const base = `${String(payload?.supplierLedgerName || "").trim()} ${String(payload?.supplierInvoiceNumber || "").trim()}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/g, "")
    .trim()
    .slice(0, 150);
  return `${base || "Purchase invoice"}.pdf`;
}

// Saves the source PDF directly in the company's shared purchase folder.
// Never overwrites a different file: an identical file is reused, otherwise
// " (2)", " (3)" … is appended.
async function saveToSharedPurchaseFolder(payload, folder, downloadUrl, documentId) {
  if (!/^https?:\/\//i.test(downloadUrl)) throw new Error("Purchase source document does not have a valid download URL.");
  const bytes = await downloadTrustedDocument(downloadUrl);
  if (bytes.length === 0 || bytes.length > MAX_PURCHASE_SOURCE_PDF_BYTES) {
    throw new Error("The source invoice PDF is empty or larger than the 25 MB connector limit.");
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The downloaded source invoice is not a valid PDF.");
  const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const preferred = sharedPurchaseDocumentFileName(payload);
  const stem = preferred.replace(/\.pdf$/i, "");
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const fileName = attempt === 1 ? preferred : `${stem} (${attempt}).pdf`;
    const documentPath = path.win32.join(folder, fileName);
    const existing = await fs.promises.readFile(documentPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw new Error(`Cannot read the purchase invoice folder (${error.code || error.message}). Check the LAN and share permissions before posting.`);
    });
    if (existing && createHash("sha256").update(existing).digest("hex").toUpperCase() !== sha256) continue;
    if (!existing) {
      const temporaryPath = `${documentPath}.${randomUUID()}.tmp`;
      try {
        await fs.promises.writeFile(temporaryPath, bytes, { flag: "wx" });
        await fs.promises.rename(temporaryPath, documentPath);
        const saved = await fs.promises.readFile(documentPath);
        if (createHash("sha256").update(saved).digest("hex").toUpperCase() !== sha256) {
          throw new Error("The saved invoice PDF did not match the downloaded file.");
        }
      } catch (error) {
        throw new Error(`Could not save the purchase PDF (${error.code || error.message}). Check the shared folder before posting.`);
      } finally {
        await fs.promises.unlink(temporaryPath).catch(() => {});
      }
    }
    return { ...payload, sourceDocumentPath: documentPath, sourceDocumentName: fileName, sourceDocumentSha256: sha256, sourceDocumentId: documentId };
  }
  throw new Error(`Too many different files are already named "${preferred}" in the shared purchase folder.`);
}

async function materializePurchaseSourceDocument(payload) {
  const source = payload?.sourceDocument;
  if (!source || typeof source !== "object") {
    return payload;
  }

  const downloadUrl = String(source.downloadUrl || "").trim();
  const documentId = safeDocumentPathSegment(source.id, "source-document");
  const companyName = safeDocumentPathSegment(payload?.companyName, "Tally company");
  const originalName = safeDocumentPathSegment(source.name, "source-invoice.pdf");
  const fileName = /\.pdf$/i.test(originalName) ? originalName : `${originalName}.pdf`;
  const configuredFolder = String(payload?.sourceDocumentFolder || '').trim();
  const documentRoot = configuredFolder ? validatePurchaseDocumentFolder(configuredFolder) : path.join(path.dirname(CONFIG_DIR), 'attachments');
  if (configuredFolder) {
    await testPurchaseDocumentFolder(configuredFolder);
    return saveToSharedPurchaseFolder(payload, documentRoot, downloadUrl, String(source.id || documentId).trim() || documentId);
  }
  const documentDir = path.join(
    documentRoot,
    companyName,
    "Purchase",
    documentId
  );
  const documentPath = path.join(documentDir, fileName);
  const existingBytes = await fs.promises.readFile(documentPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read the purchase invoice folder (${error.code || error.message}). Check the LAN and share permissions before posting.`);
  });
  if (existingBytes && !configuredFolder) {
    if (
      existingBytes.length > 0 &&
      existingBytes.length <= MAX_PURCHASE_SOURCE_PDF_BYTES &&
      existingBytes.subarray(0, 5).toString("ascii") === "%PDF-"
    ) {
      return {
        ...payload,
        sourceDocumentPath: documentPath,
        sourceDocumentName: fileName,
        sourceDocumentSha256: createHash("sha256").update(existingBytes).digest("hex").toUpperCase(),
        sourceDocumentId: String(source.id || documentId).trim() || documentId,
        sourceDocumentCacheHit: true,
      };
    }
  }
  if (!/^https?:\/\//i.test(downloadUrl)) {
    throw new Error("Purchase source document does not have a valid download URL.");
  }

  const bytes = await downloadTrustedDocument(downloadUrl);
  if (bytes.length === 0 || bytes.length > MAX_PURCHASE_SOURCE_PDF_BYTES) {
    throw new Error("The source invoice PDF is empty or larger than the 25 MB connector limit.");
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("The downloaded source invoice is not a valid PDF.");
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  await fs.promises.mkdir(documentDir, { recursive: true });

  const existingSha256 = existingBytes
    ? createHash("sha256").update(existingBytes).digest("hex").toUpperCase()
    : null;
  if (existingSha256 !== sha256) {
    const temporaryPath = `${documentPath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryPath, bytes, { flag: 'wx' });
      await fs.promises.rename(temporaryPath, documentPath);
      const saved = await fs.promises.readFile(documentPath);
      if (createHash('sha256').update(saved).digest('hex').toUpperCase() !== sha256) {
        throw new Error('The saved invoice PDF did not match the downloaded file.');
      }
    } catch (error) {
      throw new Error(`Could not save the purchase PDF (${error.code || error.message}). Check the shared folder before posting.`);
    } finally {
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }
  }

  return {
    ...payload,
    sourceDocumentPath: documentPath,
    sourceDocumentName: fileName,
    sourceDocumentSha256: sha256,
    sourceDocumentId: String(source.id || documentId).trim() || documentId,
  };
}

async function assertCommandTarget(config, command) {
  const runtime = config.__agentRuntime;
  if (runtime) {
    runtime.validateCommandIdentity(command);
    return;
  }
  const target = command?.payload?.target;
  if (!target) return;
  if (
    String(target.connectionId || "") !== String(config.connectionId || "") ||
    String(target.installationId || "") !== String(config.installationId || config.bridgeMachineId || "") ||
    Number(target.sessionGeneration || 0) !== Number(config.sessionGeneration || 0)
  ) {
    throw new Error("The command targets an old or different connector session. Review it before retrying.");
  }
}

async function prepareBankVoucherCommandForBatch(config, command) {
  const runtime = config.__agentRuntime;
  try {
    await assertCommandTarget(config, command);
    if (!runtime) return true;
    await runtime.invalidateWorkflowSnapshots("open_bills");
    const cached = await runtime.cachedWriteOutcome(command);
    if (cached) {
      await sendCommandResult(config, command, cached);
      return false;
    }
    const receipt = await runtime.writeReceipt(command);
    if (receipt?.status === "running") {
      const verification = await verifyBankTransactionInTally(config, command.payload);
      const status = verification?.result?.verificationStatus;
      if (["verified", "found"].includes(status)) {
        await sendCommandResult(config, command, verification);
        return false;
      }
      if (verification && status !== "missing") {
        await sendCommandResult(config, command, {
          success: false,
          result: verification.result || {},
          error: "Tally write outcome is uncertain and could not be retried safely.",
        });
        return false;
      }
    }
    await runtime.markWriteStarted(command);
    return true;
  } catch (error) {
    await sendCommandResult(config, command, {
      success: false,
      result: { beforeExecution: true },
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function runCommand(config, command, options = {}) {
  cashDiscountResultCache.clear();
  if (!command) return;

  const agentRuntime = config.__agentRuntime;
  if (agentRuntime) {
    try {
      agentRuntime.validateCommandIdentity(command);
      if (agentRuntime.supports(command.commandType)) {
        if (command.commandType === 'agent_parse_document' && command.payload?.pipelineVersion === 2) {
          startDetachedDocument(agentRuntime, command, outcome => sendCommandResult(config, command, outcome));
          return;
        }
        const outcome = await agentRuntime.execute(command);
        await sendCommandResult(config, command, outcome);
        return;
      }
      if (jobClassForCommand(command.commandType) === "tally_write") {
        // Any accepted or uncertain write can change party balances. Do not
        // serve a pre-write open-bill snapshot after this point.
        await agentRuntime.invalidateWorkflowSnapshots("open_bills");
        const cached = await agentRuntime.cachedWriteOutcome(command);
        if (cached) {
          await sendCommandResult(config, command, cached);
          return;
        }
        const receipt = await agentRuntime.writeReceipt(command);
        if (receipt?.status === "running") {
          let verification = null;
          if (command.commandType === "create_purchase_voucher") {
            verification = await verifyPurchaseVoucherInTally(config, command.payload, { searchFinancialYear: true });
          } else if (command.commandType === "post_bank_voucher") {
            verification = await verifyBankTransactionInTally(config, command.payload);
          } else if (command.commandType === "create_debit_note") {
            try {
              const voucher = await resolveDebitNoteVoucher(config.tallyUrl, command.payload, command.payload?.companyName);
              verification = { success: true, result: { verificationStatus: "found", voucherNumber: voucher.voucherNumber, masterId: voucher.masterId, guid: voucher.guid } };
            } catch (verificationError) {
              if (!/did not return the expected Debit Note/i.test(String(verificationError?.message || ""))) throw verificationError;
              verification = { success: true, result: { verificationStatus: "missing" } };
            }
          }
          const verificationStatus = verification?.result?.verificationStatus;
          if (["verified", "found"].includes(verificationStatus)) {
            await sendCommandResult(config, command, verification);
            return;
          }
          if (verification && verificationStatus !== "missing") {
            await sendCommandResult(config, command, { success: false, result: verification.result || {}, error: "Tally write outcome is uncertain and could not be retried safely." });
            return;
          }
        }
        await agentRuntime.markWriteStarted(command);
      }
    } catch (error) {
      await sendCommandResult(config, command, {
        success: false,
        result: {},
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  if (command.commandType === "sync_masters") {
    try {
      const outcome = await syncMastersFromTally(config, command.payload, command);
      await sendCommandResult(config, command, outcome);
      const totals = outcome.result?.totals || {};
      console.log(
        `Command ${command.id} completed: synced ledgers=${totals.ledger ?? 0}, gstLedgers=${totals.gst_ledger ?? 0}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Master sync failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {},
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "fetch_bank_ledgers") {
    try {
      const outcome = await fetchBankLedgersFromTally(config, command.payload);
      await sendCommandResult(config, command, outcome);
      const count = Object.values(outcome.result?.byCompany || {}).reduce(
        (total, ledgers) => total + (Array.isArray(ledgers) ? ledgers.length : 0),
        0
      );
      console.log(`Command ${command.id} completed: fetched ${count} bank ledger(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Bank ledger fetch failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {},
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "alter_ledger") {
    const xml = buildAlterLedgerXml(command.payload, command.payload?.companyName || null);
    const outcome = await invokeTallyXml(config.tallyUrl, xml);
    await sendCommandResult(config, command, outcome);
    console.log(
      outcome.success
        ? `Command ${command.id} completed: ledger altered.`
        : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
    );
    return;
  }

  if (command.commandType === "create_ledger") {
    const xml = buildCreateLedgerXml(command.payload, command.payload?.companyName || null);
    const outcome = await invokeTallyXml(config.tallyUrl, xml);
    await sendCommandResult(config, command, {
      ...outcome,
      result: {
        ...(outcome.result || {}),
        requestXml: previewXml(xml),
        ledgerName: command.payload?.name,
        parentName: command.payload?.parentName,
      },
    });
    console.log(
      outcome.success
        ? `Command ${command.id} completed: ledger created.`
        : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
    );
    return;
  }

  if (command.commandType === "fetch_customer_open_bills") {
    try {
      const isCashDiscountSnapshot = command.payload?.transport === "cash_discount_snapshot_v2";
      const outcome = isCashDiscountSnapshot
        ? {
            success: true,
            result: await collectCashDiscountLiveSnapshot(
              config,
              command.payload?.operation || "cash_discount_scan",
              command.payload?.companyName,
              command.payload?.proposal,
              (message) => console.log(message),
              command.payload?.financialYear,
              command.payload?.customerScope
            ),
          }
        : await fetchCustomerOpenBillsFromTally(config, command.payload);
      await sendCommandResult(config, command, outcome);
      if (isCashDiscountSnapshot) {
        console.log(`Command ${command.id} completed: Cash Discount snapshot refreshed.`);
        return;
      }
      const fetchedLedgerCount = Array.isArray(outcome.result?.ledgerNames) ? outcome.result.ledgerNames.length : 1;
      console.log(
        `Command ${command.id} completed: fetched open bills for ${fetchedLedgerCount} party ledger(s).`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Open bill fetch failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {},
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "verify_bank_transaction") {
    try {
      const outcome = await verifyBankTransactionInTally(config, command.payload);
      await sendCommandResult(config, command, {
        ...outcome,
        result: {
          ...(outcome.result || {}),
          transactionId: command.payload?.transactionId,
          sourceBankTransactionId: command.payload?.transactionId,
        },
      });
      console.log(
        outcome.result?.verificationStatus === "found"
          ? `Command ${command.id} completed: outgoing bank payment found in Tally.`
          : outcome.result?.verificationStatus === "ambiguous"
            ? `Command ${command.id} completed: outgoing bank payment needs review.`
            : `Command ${command.id} completed: outgoing bank payment missing in Tally.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Bank transaction verification failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {
          commandPayload: command.payload ?? {},
          transactionId: command.payload?.transactionId,
          sourceBankTransactionId: command.payload?.transactionId,
        },
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "fetch_purchase_masters") {
    try {
      const outcome = await fetchPurchaseMastersFromTally(config, command.payload);
      await sendCommandResult(config, command, outcome);
      const totals = outcome.result?.totals || {};
      console.log(
        `Command ${command.id} completed: read live Purchase masters ledgers=${totals.ledger ?? 0}, stockItems=${totals.stock_item ?? 0}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Live Purchase master read failed.");
      await sendCommandResult(config, command, {
        success: false,
        result: {},
        error: message,
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "create_purchase_voucher") {
    const commandStartedAt = Date.now();
    const commandTimings = {};
    let failureStage = "preparing_source";
    const commandMeasure = async (name, operation) => {
      const startedAt = Date.now();
      try {
        return await operation();
      } finally {
        commandTimings[`${name}Ms`] = Date.now() - startedAt;
      }
    };
    try {
      const reportStage = (phase, details = {}) => {
        failureStage = phase;
        void sendAgentProgress(config, {
          commandId: command.id,
          phase,
          processed: null,
          total: null,
          elapsedMs: Date.now() - commandStartedAt,
          ...details,
        }).catch(() => {});
      };
      // Tally readiness and the signed source-PDF download are independent.
      // Starting both together removes the remote document latency from the
      // otherwise fully sequential posting path.
      reportStage("preparing_source");
      const [live, purchasePayload] = await Promise.all([
        commandMeasure("tallyReadiness", () => testTally(config.tallyUrl)),
        commandMeasure("sourceDocument", () => withFolderTimeout(() => materializePurchaseSourceDocument(command.payload), 90000)),
      ]);
      failureStage = "checking_tally";
      const requestedCompany = String(command.payload?.companyName || "").trim();
      if (!live.tallyReachable || !live.companyLoaded) {
        throw new Error(live.error || "TallyPrime is not ready for Purchase voucher creation.");
      }
      if (
        requestedCompany &&
        normalizeLooseName(requestedCompany) !== normalizeLooseName(live.companyName)
      ) {
        throw new Error(`Tally is currently open to ${live.companyName || "another company"}. Switch to ${requestedCompany} before posting.`);
      }
      const posted = await postPurchaseVoucher(
        config.tallyUrl,
        purchasePayload,
        requestedCompany || live.companyName || config.companyName,
        { onStage: reportStage }
      );
      reportStage(posted.outcome.success ? "complete" : "verification_required");
      await sendCommandResult(config, command, {
        ...posted.outcome,
        result: {
          ...(posted.outcome.result || {}),
          postingId: command.payload?.postingId,
          caseId: command.payload?.caseId,
          revision: command.payload?.revision,
          idempotencyKey: command.payload?.idempotencyKey,
          sourceDocumentAttached: Boolean(
            purchasePayload.sourceDocumentPath &&
            posted.outcome.result?.sourceDocumentVerified
          ),
          sourceDocumentName: purchasePayload.sourceDocumentName || null,
          sourceDocumentSha256: purchasePayload.sourceDocumentSha256 || null,
          timings: {
            ...commandTimings,
            ...(posted.outcome.result?.timings || {}),
            commandTotalMs: Date.now() - commandStartedAt,
          },
        },
      });
      const timingSummary = {
        ...commandTimings,
        ...(posted.outcome.result?.timings || {}),
        commandTotalMs: Date.now() - commandStartedAt,
      };
      console.log(
        posted.outcome.success
          ? `Command ${command.id} completed: Purchase voucher verified in Tally. Timings ${JSON.stringify(timingSummary)}`
          : `Command ${command.id} needs correction: ${posted.outcome.error || "Purchase voucher verification failed."}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Purchase voucher creation failed.");
      const failedBeforeTallyWrite = [
        "preparing_source",
        "checking_tally",
        "checking_duplicates",
        "validating_masters",
      ].includes(failureStage);
      const userMessage = failedBeforeTallyWrite
        ? `${message} Nothing was sent to Tally; you can safely retry.`
        : `${message} Check whether the voucher exists in Tally before retrying.`;
      await sendCommandResult(config, command, {
        success: false,
        result: {
          postingId: command.payload?.postingId,
          caseId: command.payload?.caseId,
          revision: command.payload?.revision,
          idempotencyKey: command.payload?.idempotencyKey,
          failureStage,
          voucherCreated: failedBeforeTallyWrite ? false : null,
          uncertainWrite: !failedBeforeTallyWrite,
          timings: {
            ...commandTimings,
            commandTotalMs: Date.now() - commandStartedAt,
          },
        },
        error: userMessage,
      });
      console.log(`Command ${command.id} failed at ${failureStage}: ${userMessage}`);
    }
    return;
  }

  if (command.commandType === "post_bank_voucher") {
    let xml = null;
    try {
      const posted = await postBankVoucher(
        config.tallyUrl,
        command.payload,
        command.payload?.companyName || null
      );
      xml = posted.xml;
      const outcome = posted.outcome;
      await sendCommandResult(config, command, {
        ...outcome,
        result: {
          ...(outcome.result || {}),
          requestXml: xml ? previewXml(xml) : null,
          retriedWithLegacyHeader: posted.retriedWithLegacyHeader,
          transactionId: command.payload?.transactionId,
          voucherId: outcome.result?.voucherId || command.payload?.referenceNumber || command.id,
        },
      });
      console.log(
        outcome.success
          ? outcome.result?.alreadyInTally
            ? `Command ${command.id} completed: bank transaction already existed in Tally.`
            : `Command ${command.id} completed: bank voucher posted.`
          : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
      );
      if (!outcome.success) {
        console.log(`Command ${command.id} Tally request XML: ${previewXml(xml)}`);
      }
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "Tally did not respond within 30 seconds while posting the bank voucher."
          : error instanceof Error
            ? error.message
            : String(error ?? "Bank voucher posting failed.");
      await sendCommandResult(config, command, {
        success: false,
        error: message,
        result: {
          requestXml: xml ? previewXml(xml) : null,
          commandPayload: command.payload ?? {},
          transactionId: command.payload?.transactionId,
          voucherId: command.payload?.referenceNumber || command.id,
        },
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (
    command.commandType === "export_debit_note_pdf" ||
    (command.commandType === "create_debit_note" && command.payload?.operation === "export_native_pdf")
  ) {
    try {
      const companyName = command.payload?.companyName || null;
      if (!companyName) {
        throw new Error("The native PDF export command is missing the Tally company name.");
      }
      const voucher = voucherFromConfirmedDebitNotePayload(command.payload);
      const exportedPdf = await exportNativeDebitNotePdf(
        companyName,
        voucher,
        command.payload?.partyLedgerName,
        options.renderTallyPrintToPdf
      );
      await sendCommandResult(config, command, {
        success: true,
        result: {
          proposalId: command.payload?.proposalId,
          companyName,
          voucherId: voucher.masterId,
          voucherGuid: voucher.guid || null,
          voucherNumber: voucher.voucherNumber,
          voucherDate: normalizeDateForCompare(voucher.effectiveDate || voucher.date),
          openReferenceName: voucher.reference || null,
          voucherReference: voucher.reference || null,
          voucherAlterId: voucher.alterId || null,
          voucherType: voucher.voucherType,
          partyLedgerName: debitNotePartyName(voucher, command.payload?.partyLedgerName),
          amount: debitNoteVoucherAmount(voucher),
          ...exportedPdf,
        },
      });
      console.log(`Command ${command.id} completed: native Tally Debit Note PDF exported.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Native Tally PDF export failed.");
      await sendCommandResult(config, command, {
        success: false,
        error: message,
        result: {
          proposalId: command.payload?.proposalId,
          companyName: command.payload?.companyName || null,
        },
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "create_debit_note") {
    if (command.payload?.sourceProposal) {
      let outcome;
      try {
        outcome = await executeCashDiscountDebitNote(config, command.payload);
      } catch (error) {
        outcome = {success:false,result:{proposalId:command.payload.proposalId},
          error:`${error instanceof Error ? error.message : 'Debit note outcome is uncertain.'} Verify the voucher before retrying.`};
      }
      // A result-upload failure is not a Tally-write failure. The outbox owns retries.
      await sendCommandResult(config, command, outcome);
      return;
    }
    let xml = null;
    try {
      const posted = await postDebitNote(
        config.tallyUrl,
        command.payload,
        command.payload?.companyName || null
      );
      xml = posted.xml;
      const outcome = posted.outcome;
      const voucher = await resolveDebitNoteVoucher(
        config.tallyUrl,
        {
          ...command.payload,
          tallyVoucherId: outcome.result?.lastVchId,
          expectedReference: command.payload?.referenceNumber,
        },
        command.payload?.companyName || null
      );
      await sendCommandResult(config, command, {
        ...outcome,
        result: {
          ...(outcome.result || {}),
          requestXml: previewXml(xml),
          proposalId: command.payload?.proposalId,
          voucherId: voucher.masterId,
          voucherGuid: voucher.guid || null,
          voucherNumber: voucher.voucherNumber,
          openReferenceName: voucher.reference || null,
          voucherReference: voucher.reference || null,
          voucherAlterId: voucher.alterId || null,
          voucherType: voucher.voucherType,
          partyLedgerName: voucher.partyLedgerName || null,
          voucherDate: normalizeDateForCompare(voucher.effectiveDate || voucher.date),
        },
      });
      console.log(
        outcome.success
          ? `Command ${command.id} completed: debit note created.`
          : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
      );
      if (!outcome.success) {
        console.log(`Command ${command.id} Tally request XML: ${previewXml(xml)}`);
      }
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "Tally did not respond within 30 seconds while creating the debit note."
          : error instanceof Error
            ? error.message
            : String(error ?? "Debit note creation failed.");
      await sendCommandResult(config, command, {
        success: false,
        error: message,
        result: {
          requestXml: xml ? previewXml(xml) : null,
          commandPayload: command.payload ?? {},
          proposalId: command.payload?.proposalId,
          voucherId: command.payload?.referenceNumber || command.id,
        },
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  if (command.commandType === "adjust_customer_advance") {
    let xml = null;
    try {
      const posted = await postCustomerAdvanceAdjustment(
        config.tallyUrl,
        command.payload,
        command.payload?.companyName || null
      );
      xml = posted.xml;
      const outcome = posted.outcome;
      await sendCommandResult(config, command, {
        ...outcome,
        result: {
          ...(outcome.result || {}),
          requestXml: previewXml(xml),
          sourceBankTransactionId: command.payload?.sourceBankTransactionId,
          voucherId: command.payload?.referenceNumber || command.id,
        },
      });
      console.log(
        outcome.success
          ? `Command ${command.id} completed: customer advance adjusted.`
          : `Command ${command.id} failed: ${outcome.error || "Tally returned an error."}`
      );
      if (!outcome.success) {
        console.log(`Command ${command.id} Tally request XML: ${previewXml(xml)}`);
      }
    } catch (error) {
      const message =
        error?.name === "AbortError"
          ? "Tally did not respond within 30 seconds while adjusting the customer advance."
          : error instanceof Error
            ? error.message
            : String(error ?? "Customer advance adjustment failed.");
      await sendCommandResult(config, command, {
        success: false,
        error: message,
        result: {
          requestXml: xml ? previewXml(xml) : null,
          commandPayload: command.payload ?? {},
          sourceBankTransactionId: command.payload?.sourceBankTransactionId,
          voucherId: command.payload?.referenceNumber || command.id,
        },
      });
      console.log(`Command ${command.id} failed: ${message}`);
    }
    return;
  }

  await sendCommandResult(config, command, {
    success: false,
    result: {},
    error: `Unsupported command type: ${command.commandType}`,
  });
}

async function pairBridge(args) {
  const apiBase = normalizeBaseUrl(args["api-base"]);
  const connectionId = required(args["connection-id"], "connection-id");
  const pairingCode = required(args["pairing-code"], "pairing-code");
  const controlToken = required(args["control-token"], "control-token");
  const tallyUrl = normalizeTallyUrl(args["tally-url"]);
  const bridgeName = args["bridge-name"] || os.hostname() || "Tally Bridge";
  const bridgeMachineId = args["bridge-machine-id"] || createMachineId();
  const bridgeMachineName = os.hostname() || "This computer";
  const readiness = await testTally(tallyUrl);
  const detectedCompanyName = readiness.companyName;

  const response = await fetch(`${apiBase}/api/tally/connections/${connectionId}/pair`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pairingCode,
      controlToken,
      bridgeName,
      bridgeVersion: BRIDGE_VERSION,
      bridgeMachineId,
      bridgeMachineName,
      installationId: bridgeMachineId,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      agentCapabilities: AGENT_CAPABILITIES,
      companyName: detectedCompanyName,
      tallyReachable: readiness.tallyReachable,
      companyLoaded: readiness.companyLoaded,
    }),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok || !payload.bridgeToken) {
    throw new Error(payload.error || `Pairing failed with HTTP ${response.status}.`);
  }

  writeConfig({
    apiBase,
    connectionId,
    bridgeToken: payload.bridgeToken,
    tallyUrl,
    bridgeName,
    bridgeVersion: BRIDGE_VERSION,
    bridgeMachineId,
    bridgeMachineName,
    installationId: payload.connection?.installationId || bridgeMachineId,
    sessionGeneration: payload.connection?.sessionGeneration || payload.agentIdentity?.sessionGeneration || 1,
    organizationId: payload.agentIdentity?.organizationId || payload.connection?.organizationId || "default",
    ownerUserId: payload.agentIdentity?.ownerUserId || null,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentCapabilities: AGENT_CAPABILITIES,
  });

  console.log("Tally bridge paired successfully.");
  console.log(`Config saved to ${CONFIG_PATH}`);
}

async function sendHeartbeat(config, testResult, availableCompanies = [], livenessOnly = false) {
  const backendKey = `${config.apiBase}|${config.connectionId}`;
  // Old APIs interpret omitted Tally fields as "disconnected". Negotiate this
  // mode on a normal heartbeat before ever sending a liveness-only payload.
  if (livenessOnly && !livenessCapableBackends.has(backendKey)) return null;
  const agentStatus = !livenessOnly && config.__agentRuntime
    ? await config.__agentRuntime.status().catch(() => null)
    : null;
  const response = await fetch(`${config.apiBase}/api/tally/bridge/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.bridgeToken}`,
    },
    body: JSON.stringify({
      connectionId: config.connectionId,
      tallyUrl: config.tallyUrl,
      bridgeVersion: BRIDGE_VERSION,
      bridgeMachineId: config.bridgeMachineId,
      bridgeMachineName: config.bridgeMachineName || os.hostname() || "This computer",
      livenessOnly,
      ...testResult,
      companyName: testResult.companyName ?? null,
      companies: availableCompanies,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      agentCapabilities: AGENT_CAPABILITIES,
      installationId: config.installationId || config.bridgeMachineId,
      sessionGeneration: config.sessionGeneration || 1,
      agentStatus,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const error = new Error(payload.error || `Heartbeat failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  if (payload.livenessSupported === true) livenessCapableBackends.add(backendKey);
  else livenessCapableBackends.delete(backendKey);
  adoptHeartbeatIdentity(config, payload);
  return payload;
}

async function sendCommandResults(config, entries, concurrency = 10) {
  for (let index = 0; index < entries.length; index += concurrency) {
    await Promise.all(
      entries
        .slice(index, index + concurrency)
        .map(({ command, outcome }) => sendCommandResult(config, command, outcome))
    );
  }
}

function adoptHeartbeatIdentity(config, payload, persist = writeConfig) {
  const identity = payload?.agentIdentity;
  if (!identity || typeof identity !== "object") return false;
  const expected = {
    connectionId: String(config.connectionId || ""),
    installationId: String(config.installationId || config.bridgeMachineId || ""),
    sessionGeneration: Number(config.sessionGeneration || 0),
  };
  if (String(identity.connectionId || "") !== expected.connectionId ||
      String(identity.installationId || "") !== expected.installationId ||
      Number(identity.sessionGeneration || 0) !== expected.sessionGeneration) {
    throw Object.assign(new Error("The heartbeat returned a different connector identity. Reconnect this computer."), { status: 409 });
  }
  const organizationId = String(identity.organizationId || "").trim();
  const currentOrganizationId = String(config.organizationId || "").trim();
  if (!organizationId) throw Object.assign(new Error("The heartbeat did not return an organization identity."), { status: 409 });
  if (currentOrganizationId && currentOrganizationId !== "default" && currentOrganizationId !== organizationId) {
    throw Object.assign(new Error("This connector is paired to a different organization. Reconnect this computer."), { status: 409 });
  }
  const ownerUserId = String(identity.ownerUserId || "").trim();
  if (currentOrganizationId === organizationId && String(config.ownerUserId || "") === ownerUserId) return false;
  config.organizationId = organizationId;
  config.ownerUserId = ownerUserId || config.ownerUserId || null;
  persist(config);
  return true;
}

async function flushResultOutbox(config) {
  if (!config.__agentRuntime) return 0;
  const pending = await config.__agentRuntime.pendingOutcomes(20);
  let delivered = 0;
  for (const item of pending) {
    const stored = item.payload || {};
    const outcome = stored.outcome || stored;
    const command = { id: item.command_id, identity: stored.identity || null, payload: {} };
    try {
      await sendCommandResult(config, command, outcome, item);
      delivered += 1;
    } catch {
      await config.__agentRuntime.retryOutcome(item.id, item.attempts);
    }
  }
  return delivered;
}

async function sendAgentProgress(config, progress) {
  if (!progress?.commandId) return;
  const response = await fetch(`${config.apiBase}/api/tally/agent/jobs/${progress.commandId}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.bridgeToken}` },
    body: JSON.stringify({ connectionId: config.connectionId, progress }),
  });
  if (!response.ok) throw new Error(`Agent progress update failed with HTTP ${response.status}.`);
}

async function runOnce(config, options = {}) {
  // A verified Debit Note document needs the already-confirmed voucher fields
  // and the local PDF renderer, not a fresh Tally HTTP call. Claim and finish
  // it before a slow/unreachable Tally heartbeat can hold the customer send
  // flow hostage for a minute.
  let deferredCommand = null;
  try {
    const [command = null] = await receiveNextCommands(config, 1);
    const isVerifiedDebitNotePdf =
      command &&
      (command.commandType === "export_debit_note_pdf" ||
        (command.commandType === "create_debit_note" && command.payload?.operation === "export_native_pdf"));
    if (isVerifiedDebitNotePdf) {
      await runCommand(config, command, options);
    } else {
      deferredCommand = command;
    }
  } catch (commandError) {
    console.error(commandError instanceof Error ? commandError.message : commandError);
  }

  const result = await testTally(config.tallyUrl);
  const companyListCache = options.companyListCache;
  let availableCompanies = [];
  if (result.tallyReachable) {
    const now = Date.now();
    const cachedCompanies = Array.isArray(companyListCache?.availableCompanies)
      ? companyListCache.availableCompanies
      : [];
    const activeCompanyIsCached = !result.companyName || cachedCompanies.some(
      (company) => normalizeLooseName(company.companyName) === normalizeLooseName(result.companyName)
    );
    const refreshCompanyList =
      !companyListCache ||
      cachedCompanies.length === 0 ||
      !activeCompanyIsCached ||
      now >= Number(companyListCache.nextRefreshAt || 0);

    if (refreshCompanyList) {
      availableCompanies = await fetchAvailableCompanies(config.tallyUrl, result.companyName);
      if (companyListCache) {
        companyListCache.availableCompanies = availableCompanies;
        companyListCache.nextRefreshAt = now + DEFAULT_COMPANY_LIST_INTERVAL_MS;
      }
    } else {
      availableCompanies = cachedCompanies.map((company) => ({
        ...company,
        isActive: normalizeLooseName(company.companyName) === normalizeLooseName(result.companyName),
      }));
    }
  } else if (companyListCache) {
    companyListCache.nextRefreshAt = 0;
  }
  const heartbeat = await sendHeartbeat(config, result, availableCompanies);
  await config.__agentRuntime?.observeTallyCompanies(availableCompanies).catch((observeError) => {
    console.warn(`Local Agent watermark check skipped: ${observeError instanceof Error ? observeError.message : observeError}`);
  });
  const company = result.companyName ? ` Company: ${result.companyName}.` : "";
  const companyList =
    availableCompanies.length > 0
      ? ` Companies: ${availableCompanies.map((entry) => entry.companyName).join(", ")}.`
      : "";
  const error = result.error ? ` Error: ${result.error}` : "";
  console.log(
    `Heartbeat sent. Tally reachable: ${result.tallyReachable}. Company loaded: ${result.companyLoaded}.${company}${companyList}${error}`
  );

  try {
    if (deferredCommand) {
      await runCommand(config, deferredCommand, options);
    }
  } catch (commandError) {
    console.error(commandError instanceof Error ? commandError.message : commandError);
  }

  return {
    result,
    connection: heartbeat?.connection ?? null,
    timestamp: new Date().toISOString(),
    heartbeat,
  };
}

function cashDiscountGatewayUrl(config) {
  const configured = String(process.env.CASH_DISCOUNT_GATEWAY_URL || "").trim();
  if (configured) return configured;
  const url = new URL(config.apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (["localhost", "127.0.0.1"].includes(url.hostname)) {
    url.port = "3002";
    url.pathname = "/";
  } else {
    url.pathname = "/agent-live";
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

// Reconnect backoff for the live WebSocket channels: 3 s doubling up to 60 s,
// reset after a successful connection. Errors are logged once per outage so an
// unreachable server cannot flood the log (previously ~20 lines per minute).
const LIVE_RECONNECT_MIN_MS = 3_000;
const LIVE_RECONNECT_MAX_MS = 60_000;

export function createReconnectBackoff() {
  let failures = 0;
  let outageLogged = false;
  return {
    nextDelay() {
      const delay = Math.min(LIVE_RECONNECT_MAX_MS, LIVE_RECONNECT_MIN_MS * 2 ** failures);
      failures += 1;
      return delay;
    },
    // Returns true only for the first error of an outage.
    shouldLog() {
      if (outageLogged) return false;
      outageLogged = true;
      return true;
    },
    connected() {
      const recovered = outageLogged;
      failures = 0;
      outageLogged = false;
      return recovered;
    },
  };
}

function startCashDiscountLiveChannel(config, executeExclusive, options = {}) {
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;
  const backoff = createReconnectBackoff();
  const activeReads = new Map();
  const pendingPurchaseReads = new Map();
  let readInFlight = false;
  let readRecoveryUntil = 0;

  const log = (level, message) => emitLog(options, level, message);
  const send = (payload) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
  };
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff.nextDelay());
    reconnectTimer.unref?.();
  };

  const handleOperation = async (message) => {
    const requestId = String(message.requestId || "").trim();
    const operation = String(message.operation || "");
    if (!requestId) return;
    // Pages and rows of an analysed dashboard held here: answered from memory
    // at once, never queued behind Tally work.
    if (operation === "collections_query" || operation === "collections_rows") {
      try {
        send({ type: "operation_result", requestId, success: true, data: answerCollectionsRequest(config, operation, message) });
      } catch (error) {
        send({ type: "operation_result", requestId, success: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const isBankRead = ["ledger_masters", "verify_bank_transaction", "fetch_customer_open_bills"].includes(operation);
    const isPurchaseRead = operation === "ledger_masters" &&
      Array.isArray(message.payload?.requestedMasterTypes) &&
      message.payload.requestedMasterTypes.includes("stock_item");
    const purchaseReadKey = isPurchaseRead
      ? JSON.stringify([
          normalizeLooseName(message.companyName),
          message.financialYear || null,
          [...message.payload.requestedMasterTypes].sort(),
          Boolean(message.payload?.includeInventoryLocations),
          Boolean(message.payload?.forceRefresh),
          Boolean(message.payload?.requireFresh),
        ])
      : null;
    const isRead = isBankRead || isPurchaseRead || operation === "cash_discount_scan" || operation === "cash_discount_revalidate";
    if (isRead && Date.now() < readRecoveryUntil) {
      send({ type: "operation_result", requestId, success: false,
        error: "Tally read is paused briefly after an incomplete read. Please retry in 30 seconds." });
      return;
    }
    if (isRead && liveReadMemoryPressure()) {
      send({ type: "operation_result", requestId, success: false,
        error: "This computer is very low on memory. Close some programs and retry." });
      return;
    }
    const sharedPurchaseRead = purchaseReadKey ? pendingPurchaseReads.get(purchaseReadKey) : null;
    if (sharedPurchaseRead) {
      sharedPurchaseRead.requestIds.add(requestId);
      activeReads.set(requestId, sharedPurchaseRead.controller);
      send({ type: "progress", requestId, message: "Joining the Purchase catalogue refresh already in progress…" });
      return;
    }
    if (isRead && readInFlight) {
      send({ type: "operation_result", requestId, success: false, error: "A Tally read is already running. Wait for it to finish." });
      return;
    }
    const controller = new AbortController();
    const deadlineAt = Math.min(Number(message.deadlineAt) || Infinity, Date.now() + ((isBankRead || isPurchaseRead) ? 180_000 : CASH_DISCOUNT_SCAN_MS));
    const purchaseReadState = purchaseReadKey
      ? { controller, requestIds: new Set([requestId]) }
      : null;
    if (purchaseReadKey && purchaseReadState) pendingPurchaseReads.set(purchaseReadKey, purchaseReadState);
    if (isRead) { activeReads.set(requestId, controller); readInFlight = true; }
    const sendOperationResult = (payload) => {
      const targetIds = purchaseReadState ? Array.from(purchaseReadState.requestIds) : [requestId];
      for (const targetRequestId of targetIds) {
        send({ ...payload, requestId: targetRequestId });
      }
    };
    const startedAt = performance.now();
    const benchmark = createConnectorBenchmarkTrace({
      requestId,
      operation,
      companyName: message.companyName,
    });
    let benchmarkFinished = false;
    const deadlineTimer = isRead ? setTimeout(() => controller.abort(new Error("Cash Discount read deadline exceeded.")), Math.max(1, deadlineAt - Date.now())) : null;
    try {
      // Reads acquire the shared Tally lane per HTTP request, not for the entire scan.
      const runOperation = isRead || operation === 'test_purchase_document_folder' ? (task) => task() : executeExclusive;
      const data = await runOperation(async () => {
        markConnectorBenchmarkStage(benchmark, "queueWaitMs", performance.now() - startedAt);
        if (operation === 'test_purchase_document_folder') {
          return testPurchaseDocumentFolder(message.payload?.folderPath);
        }
        if (operation === "company_check") {
          return collectTallyCompanyCheck(config);
        }
        if (operation === "bank_ledgers") {
          const outcome = await fetchBankLedgersFromTally(config, {
            companyNames: message.companyNames,
            companyName: message.companyName,
          });
          return outcome.result || outcome;
        }
        if (operation === "ledger_masters") {
          const bankIdentity = message.payload?.bankDocumentIdentity;
          if (bankIdentity && (bankIdentity.companyName !== message.companyName || bankIdentity.financialYear !== message.financialYear)) {
            throw new Error('Bank ledger read scope does not match its document job.');
          }
          const requestedTypes = Array.isArray(message.payload?.requestedMasterTypes) && message.payload.requestedMasterTypes.length > 0
            ? message.payload.requestedMasterTypes
            : ["ledger", "group"];
          const purchaseScope = {
            companyName: message.companyName,
            companyGuid: config.__agentRuntime?.activeIdentity?.companyGuid || null,
            financialYear: message.financialYear || config.__agentRuntime?.activeIdentity?.financialYear || null,
            requestedTypes,
            includeInventoryLocations: Boolean(message.payload?.includeInventoryLocations),
          };
          // A case-page purchase refresh must read the masters from Tally now.
          // The incremental Local Agent catalogue is intentionally retained for
          // background reads, but it cannot discover a GSTIN/HSN that was added
          // to an unchanged master: its AlterID cursor quite correctly skips
          // that master. AutoDealer's purchase flow always uses the live master
          // export, so keep the same semantics here for requireFresh reads.
          const requireLivePurchaseRead = shouldUseLivePurchaseMasterRead(isPurchaseRead, message.payload);
          const localCatalogue = !message.payload?.forceRefresh && !requireLivePurchaseRead
            ? await config.__agentRuntime?.localMasterCatalogue(purchaseScope, { moduleName: isPurchaseRead ? "purchase" : "bank" })
            : null;
          if (localCatalogue) {
            send({ type: "progress", requestId, message: message.payload?.requireFresh === true
              ? "Local catalogue validated against Tally changes."
              : "Using the incrementally synced Local Agent catalogue…" });
            const godowns = message.payload?.includeInventoryLocations
              ? await cashDiscountReadContext.run({
                  signal: controller.signal,
                  deadlineAt,
                  benchmark,
                  schedule: executeExclusive,
                }, () => fetchPurchaseInventoryLocationsFromTally(config, { companyName: message.companyName }))
              : [];
            const catalogue = godowns.length || message.payload?.includeInventoryLocations
              ? {
                  ...localCatalogue,
                  masters: { ...localCatalogue.masters, godowns },
                  totals: { ...localCatalogue.totals, godown: godowns.length },
                }
              : localCatalogue;
            if (isPurchaseRead) {
              log("info", `Purchase master catalogue source=local ledgers=${catalogue.masters?.ledgers?.length ?? 0}, stockItems=${catalogue.masters?.stockItems?.length ?? 0}, units=${catalogue.masters?.units?.length ?? 0}, godowns=${catalogue.masters?.godowns?.length ?? 0}.`);
            }
            return bankIdentity ? { ...catalogue, bankDocumentIdentity: bankIdentity } : catalogue;
          }
          const masters = isPurchaseRead
            ? (await cashDiscountReadContext.run({
                signal: controller.signal,
                deadlineAt,
                benchmark,
                schedule: executeExclusive,
                onProgress: (text) => send({ type: "progress", requestId, message: text }),
              }, () => fetchPurchaseMastersFromTally(config, {
                companyName: message.companyName,
                financialYear: message.financialYear,
                includeInventoryLocations: Boolean(message.payload?.includeInventoryLocations),
                targetedLedgerNames: message.payload?.targetedLedgerNames,
                diagnostics: message.payload?.diagnostics,
              }, log))).result
            : await collectTallyMasters(config, {
                companyName: message.companyName,
                bankDocumentIdentity: bankIdentity,
                requestedMasterTypes: requestedTypes,
              });
          if (isPurchaseRead) {
            const validatedAt = new Date().toISOString();
            log("info", `Purchase master catalogue source=full_live ledgers=${masters.masters?.ledgers?.length ?? 0}, stockItems=${masters.masters?.stockItems?.length ?? 0}, units=${masters.masters?.units?.length ?? 0}, godowns=${masters.masters?.godowns?.length ?? 0}.`);
            return {
              ...masters,
              validatedAt,
              validation: {
                version: 1,
                mode: "full_live_read",
                validatedAt,
                dataUpdatedAt: masters.fetchedAt || validatedAt,
                companyGuid: masters.companyProfile?.guid || null,
                financialYear: masters.financialYear || message.financialYear || null,
                completeTypes: ["ledger", "group", "stock_item", "unit"],
                catalogueDigest: createHash("sha256").update(JSON.stringify({
                  companyGuid: masters.companyProfile?.guid || null,
                  financialYear: masters.financialYear || message.financialYear || null,
                  totals: masters.totals || {},
                })).digest("hex"),
              },
              cache: { source: "live_tally", updatedAt: masters.fetchedAt || validatedAt, validatedAt },
            };
          }
          const syncPayload = {
            connectionId: config.connectionId,
            companyName: message.companyName || config.companyName || null,
            bridgeVersion: BRIDGE_VERSION,
            masters: {
              ledgers: masters.ledgers,
              groups: masters.groups,
              stockItems: masters.stockItems,
              units: masters.units,
              voucherTypes: masters.voucherTypes,
              gstLedgers: masters.gstLedgers,
              taxLedgers: masters.taxLedgers,
            },
            companyProfile: masters.companyProfile,
            requestedMasterTypes: masters.requestedMasterTypes,
          };
          // Purchase review reads are intentionally ephemeral. The browser
          // asks for persist:false so the complete Tally catalogue is not
          // uploaded to Supabase and then downloaded again just to match it.
          // Other callers retain the previous persisted-sync behaviour.
          const persist = message.payload?.persist !== false;
          const syncResult = persist
            ? await postMastersToBackend(config, syncPayload)
            : null;
          const totals = {
            ledger: masters.ledgers.length,
            group: masters.groups.length,
            stock_item: masters.stockItems.length,
            unit: masters.units.length,
          };
          // Keep the flat fields used by existing live readers while also
          // exposing the same shape as the purchase-master sync response.
          return {
            source: "live_tally",
            ...(bankIdentity ? { bankDocumentIdentity: bankIdentity } : {}),
            companyName: message.companyName,
            fetchedAt: new Date().toISOString(),
            syncRunId: syncResult?.syncRunId ?? null,
            persisted: persist,
            totals,
            ledgers: masters.ledgers,
            groups: masters.groups,
            stockItems: masters.stockItems,
            units: masters.units,
            companyProfile: masters.companyProfile,
            masters: {
              ledgers: masters.ledgers,
              groups: masters.groups,
              stockItems: masters.stockItems,
              units: masters.units,
            },
          };
        }
        if (operation === "verify_bank_transaction") {
          const outcome = await cashDiscountReadContext.run({ signal: controller.signal, deadlineAt, benchmark, schedule: executeExclusive, onProgress: (text) => send({ type: "progress", requestId, message: text }) }, () => reconcileBankTransactionsInTally(config, message.payload || {}));
          return outcome.result || outcome;
        }
        if (operation === "fetch_customer_open_bills") {
          const openBillScope = {
            companyName: message.companyName,
            companyGuid: config.__agentRuntime?.activeIdentity?.companyGuid || null,
            financialYear: message.financialYear || config.__agentRuntime?.activeIdentity?.financialYear || null,
            ledgerNames: uniquePayloadLedgerNames(message.payload || {}).sort(),
            dateFrom: message.payload?.dateFrom || null,
            dateTo: message.payload?.dateTo || message.payload?.asOfDate || null,
            queryPurpose: message.payload?.queryPurpose || null,
          };
          const moduleName = message.payload?.moduleName || (message.payload?.queryPurpose === "bank_statement_match" ? "bank" : "cashDiscount");
          const isReminderCheck = message.payload?.queryPurpose === "payment_followup";
          const isBankBillCheck = message.payload?.queryPurpose === "bank_statement_match";
          // Payment reminder checks and bank bill allocation use the customer
          // dues kept current from Tally's change counters (latest changes
          // applied first): always current, and instant for any number of parties.
          const prepared = isReminderCheck || isBankBillCheck
            ? await config.__agentRuntime?.preparedReceivablesFor?.({ companyName: message.companyName, financialYear: message.financialYear }).catch(() => null)
            : null;
          if (prepared) {
            const asOfDate = new Date().toISOString().slice(0, 10);
            const names = uniquePayloadLedgerNames(message.payload || {});
            const records = await prepared.recordsFor(names, { dateTo: asOfDate });
            const outcome = await cashDiscountReadContext.run({ signal: controller.signal, deadlineAt, benchmark, schedule: executeExclusive },
              () => customerOpenBillsFromDues(config, { ...(message.payload || {}), companyName: message.companyName, asOfDate }, records));
            log("info", `${isBankBillCheck ? "Bank bill allocation" : "Payment reminder check"} ${requestId}: ${names.length} part${names.length === 1 ? "y" : "ies"} from customer dues (checked ${prepared.state?.checkedAt || "just now"}).`);
            return { ...(outcome.result || outcome), dataSource: "customer_dues" };
          }
          const maxAgeMs = moduleName === "bank" ? 60_000 : 120_000;
          // A reminder must never be decided on a result that may be minutes old.
          const cached = !message.payload?.forceRefresh && !isReminderCheck && await config.__agentRuntime?.getWorkflowSnapshot("open_bills", openBillScope, maxAgeMs);
          if (cached && await config.__agentRuntime?.moduleEnabled(moduleName)) return cached;
          const outcome = await cashDiscountReadContext.run({ signal: controller.signal, deadlineAt, benchmark, schedule: executeExclusive, onProgress: (text) => send({ type: "progress", requestId, message: text }) }, () => fetchCustomerOpenBillsFromTally(config, message.payload || {}));
          const result = outcome.result || outcome;
          if (await config.__agentRuntime?.moduleEnabled(moduleName)) await config.__agentRuntime?.putWorkflowSnapshot("open_bills", openBillScope, result);
          return result;
        }
        if (operation === "ledger_suggestions") {
          const moduleName = message.payload?.moduleName || "bank";
          if (!(await config.__agentRuntime?.moduleEnabled(moduleName))) {
            return { matches: {}, source: "encrypted_local_agent", localOnly: true, disabled: true };
          }
          const queries = Array.isArray(message.payload?.queries)
            ? message.payload.queries.slice(0, 100)
            : [{ id: message.payload?.id || "query", name: message.payload?.name || message.payload?.query, gstin: message.payload?.gstin }];
          const matches = await config.__agentRuntime?.suggestLedgerBatch(queries, {
            identity: config.__agentRuntime?.activeIdentity,
            savedMappings: message.payload?.savedMappings || [],
          }) || {};
          // Bank lines with an amount: parties with an open bill of exactly that
          // amount (from customer dues) are the strongest suggestion.
          if (moduleName === "bank" && queries.some((query) => Number(query?.amount) > 0)) {
            const prepared = await config.__agentRuntime?.preparedReceivablesFor?.({ companyName: message.companyName, financialYear: message.financialYear }).catch(() => null);
            if (prepared) {
              const byAmount = await openBillAmountIndex(prepared);
              let matched = 0;
              for (const query of queries) {
                const amountMatches = matchOpenBillsByAmount(byAmount, query);
                if (!amountMatches.length) continue;
                matched += 1;
                const id = String(query.id || query.name || "");
                const existing = matches[id]?.suggestions || [];
                const seen = new Set(amountMatches.map((entry) => normalizeLooseName(entry.ledger.name)));
                matches[id] = { ...(matches[id] || {}), suggestions: [...amountMatches, ...existing.filter((entry) => !seen.has(normalizeLooseName(entry?.ledger?.name)))].slice(0, 8) };
              }
              if (matched) log("info", `Bank ledger suggestions ${requestId}: ${matched} transaction${matched === 1 ? "" : "s"} matched an open bill amount in customer dues.`);
            }
          }
          return { matches, source: "encrypted_local_agent", localOnly: true };
        }
        if (operation === "cash_discount_scan" || operation === "cash_discount_revalidate") {
          // Reserve time for the final active-company check and result delivery.
          const snapshot = await cashDiscountReadContext.run({ signal: controller.signal, deadlineAt: deadlineAt - 5_000, benchmark, schedule: executeExclusive }, () => collectCashDiscountLiveSnapshot(
            config,
            operation,
            message.companyName,
            message.proposal,
            (progressMessage) => send({ type: "progress", requestId, message: progressMessage }),
            message.financialYear,
            message.customerScope,
            message.payload
          ));
          // With the analysis context (debit notes already created, connection
          // status) the connector builds the finished dashboard itself, with
          // the server's own code, and sends only that instead of every open bill.
          const context = message.analysisContext;
          if (operation !== "cash_discount_scan" || !context || !Array.isArray(context.proposalRows) || !snapshot?.openBillsResult) return snapshot;
          const analysisStarted = performance.now();
          const dashboard = buildLiveCashDiscountDashboard({
            connectionId: config.connectionId,
            companyName: message.companyName,
            financialYear: snapshot.financialYear || null,
            scan: snapshot,
            proposalRows: context.proposalRows,
            connectionStatus: context.connectionStatus ?? null,
            lastHeartbeatAt: context.lastHeartbeatAt ?? null,
            followUps: context.followUps === true,
          });
          log("info", `Cash Discount scan ${requestId}: analysed on this computer in ${Math.round(performance.now() - analysisStarted)} ms.`);
          // A page that pages its lists gets only the shell (KPIs, counts,
          // revision); the lists stay here and are read a page at a time.
          if (message.payload?.paged === true) {
            const shell = storeCollectionsDashboard(config, {
              companyName: message.companyName, financialYear: snapshot.financialYear, followUps: context.followUps === true, dashboard,
            });
            return { analysed: true, dashboard: shell, cache: snapshot.cache ?? null, scanSummary: snapshot.scanSummary ?? null };
          }
          return { analysed: true, dashboard, cache: snapshot.cache ?? null, scanSummary: snapshot.scanSummary ?? null };
        }
        if (operation === "cash_discount_execute_debit_note") {
          // Invalidate before a write: even an uncertain response can have changed Tally.
          await config.__agentRuntime?.invalidateWorkflowSnapshots('cash_discount');
          await config.__agentRuntime?.invalidateWorkflowSnapshots('open_bills');
          send({ type: "progress", requestId, message: "Creating and verifying the Debit Note in Tally..." });
          return executeCashDiscountDebitNote(config, message.commandPayload);
        }
        throw new Error("Unsupported live Cash Discount operation.");
      }, isRead ? { signal: controller.signal, deadlineAt, priority: 80 } : { priority: 100 });
      if (isRead) controller.signal.throwIfAborted();
      if (isRead && data?.scanSummary?.complete === false) readRecoveryUntil = Date.now() + 30_000;
      markConnectorBenchmarkStage(benchmark, "operationMs", performance.now() - startedAt);
      const benchmarkDiagnostics = finishConnectorBenchmarkTrace(benchmark, { success: true });
      benchmarkFinished = true;
      if (benchmarkDiagnostics && data && typeof data === "object" && !Array.isArray(data)) {
        data.benchmarkDiagnostics = benchmarkDiagnostics;
      }
      log("info", `Cash Discount ${operation} ${requestId} completed in ${Math.round(performance.now() - startedAt)} ms.`);
      const scanSummary = data && typeof data === "object" ? data.scanSummary : null;
      if (scanSummary?.dataSource) {
        const customers = `${Number(scanSummary.completed || 0).toLocaleString("en-IN")}/${Number(scanSummary.total || 0).toLocaleString("en-IN")} customers`;
        log("info", scanSummary.dataSource === "customer_dues"
          ? `Cash Discount scan ${requestId}: ${customers} from customer dues (checked ${scanSummary.customerDuesCheckedAt || "just now"}); 0 invoice/receipt reads from Tally.`
          : `Cash Discount scan ${requestId}: ${customers} read from Tally live (customer dues not ready for this company/year).`);
        if (scanSummary.stepMs) log("info", `Cash Discount scan ${requestId} timing: ${formatScanStepTimes(scanSummary.stepMs)}.`);
      }
      // Purchase catalogue results historically carried every master twice:
      // once under `masters` and again in flat top-level arrays. Large Tally
      // companies could consequently exceed the gateway WebSocket frame limit
      // and appear to the browser as a connector disconnect. Browser consumers
      // use the canonical nested shape, so keep one copy on this transport.
      const responseData = operation === "ledger_masters" && data?.masters
        ? (() => {
            const compactMaster = (value) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) return value;
              const raw = value.raw && typeof value.raw === "object" && !Array.isArray(value.raw)
                ? value.raw
                : {};
              const pick = (key) => value[key] ?? raw[key] ?? null;
              return Object.fromEntries(Object.entries({
                guid: pick("guid"),
                name: pick("name"),
                parent: pick("parent"),
                gstin: pick("gstin"),
                hsnCode: pick("hsnCode"),
                unitName: pick("unitName"),
                taxRate: pick("taxRate"),
                taxType: pick("taxType"),
                gstDutyHead: pick("gstDutyHead"),
                closingBalance: pick("closingBalance"),
                closingBalanceType: pick("closingBalanceType"),
                decimalPlaces: pick("decimalPlaces"),
              }).filter(([, fieldValue]) => fieldValue !== null && fieldValue !== undefined && fieldValue !== ""));
            };
            const compactMasters = {
              ...data.masters,
              ledgers: Array.isArray(data.masters.ledgers) ? data.masters.ledgers.map(compactMaster) : [],
              groups: Array.isArray(data.masters.groups) ? data.masters.groups.map(compactMaster) : [],
              stockItems: Array.isArray(data.masters.stockItems) ? data.masters.stockItems.map(compactMaster) : [],
              units: Array.isArray(data.masters.units) ? data.masters.units.map(compactMaster) : [],
              godowns: Array.isArray(data.masters.godowns) ? data.masters.godowns.map(compactMaster) : [],
            };
            const compact = { ...data, masters: compactMasters };
            delete compact.ledgers;
            delete compact.groups;
            delete compact.stockItems;
            delete compact.units;
            delete compact.godowns;
            return compact;
          })()
        : data;
      sendOperationResult({ type: "operation_result", success: true, companyName: message.companyName, data: responseData });
    } catch (error) {
      if (!benchmarkFinished) {
        if (isRead) readRecoveryUntil = Date.now() + 30_000;
        finishConnectorBenchmarkTrace(benchmark, { success: false, error });
        benchmarkFinished = true;
      }
      sendOperationResult({
        type: "operation_result",
        success: false,
        companyName: message.companyName,
        error: error instanceof Error ? error.message : String(error || "Live Cash Discount operation failed."),
      });
    } finally {
      if (!benchmarkFinished) finishConnectorBenchmarkTrace(benchmark, { success: false, error: "Operation ended before a result was produced." });
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (purchaseReadState) {
        for (const targetRequestId of purchaseReadState.requestIds) activeReads.delete(targetRequestId);
      } else {
        activeReads.delete(requestId);
      }
      if (purchaseReadKey) pendingPurchaseReads.delete(purchaseReadKey);
      if (isRead) readInFlight = false;
    }
  };

  let commandWakePending = false;
  const wakeCommands = () => {
    if (commandWakePending || stopped) return;
    commandWakePending = true;
    void executeExclusive(() => drainPendingCommands(config, options), { priority: 100 })
      .catch(error => log("error", `Command wake failed: ${error.message}`))
      .finally(() => { commandWakePending = false; });
  };

  const connect = () => {
    if (stopped) return;
    if (typeof WebSocket !== "function") {
      log("error", "This connector runtime does not support the live Cash Discount channel.");
      return;
    }
    try {
      // Compressed when the gateway allows it: a scan result shrinks about 13x.
      socket = new WebSocket(cashDiscountGatewayUrl(config), { perMessageDeflate: true });
      socket.addEventListener("open", () => {
        send({
          type: "authenticate",
          role: "connector",
          connectionId: config.connectionId,
          token: config.bridgeToken,
          bridgeVersion: BRIDGE_VERSION,
        });
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data || "{}"));
          if (message.type === "authenticated") {
            log("info", backoff.connected() ? "Cash Discount live channel reconnected." : "Cash Discount live channel connected.");
          } else if (message.type === "operation") {
            void handleOperation(message);
          } else if (message.type === "command_queued") {
            wakeCommands();
          } else if (message.type === "cancel") {
            activeReads.get(String(message.requestId || ""))?.abort(new Error("Cash Discount read cancelled."));
          } else if (message.type === "error") {
            log("error", `Cash Discount live channel: ${message.error || "unknown error"}`);
          }
        } catch (error) {
          log("error", error instanceof Error ? error.message : "Invalid Cash Discount live message.");
        }
      });
      socket.addEventListener("error", () => {
        if (backoff.shouldLog()) log("error", "Cash Discount live channel is unavailable; retrying with backoff.");
      });
      socket.addEventListener("close", () => {
        for (const controller of activeReads.values()) controller.abort(new Error("Live channel disconnected."));
        scheduleReconnect();
      });
    } catch (error) {
      if (backoff.shouldLog()) log("error", error instanceof Error ? error.message : "Could not start the Cash Discount live channel.");
      scheduleReconnect();
    }
  };

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}

async function fetchCommandRealtimeConfig(config) {
  const url = new URL(`${config.apiBase}/api/tally/bridge/realtime-config`);
  url.searchParams.set("connectionId", config.connectionId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.bridgeToken}` },
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error(payload.error || `Realtime configuration failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload.realtime ?? null;
}

async function processClaimedCommands(config, commands, options = {}) {
  const bankVoucherCommands = [];
  for (const command of commands) {
    if (command.commandType === "post_bank_voucher") {
      if (await prepareBankVoucherCommandForBatch(config, command)) {
        bankVoucherCommands.push(command);
      }
      continue;
    }
    try {
      await runCommand(config, command, options);
    } catch (error) {
      console.error(
        `Command ${command.id} failed without blocking the remaining queue: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  if (bankVoucherCommands.length > 0) {
    await runBankVoucherCommandBatch(config, bankVoucherCommands, options);
  }
}

async function drainPendingCommands(config, options = {}) {
  let processed = 0;
  while (processed < MAX_COMMANDS_PER_CYCLE) {
    const commands = await receiveNextCommands(
      config,
      Math.min(MAX_COMMANDS_PER_CYCLE - processed, MAX_COMMANDS_PER_CYCLE)
    );
    if (commands.length === 0) break;
    await processClaimedCommands(config, commands, options);
    processed += commands.length;
  }
  return processed;
}

function decodeRealtimeFrame(data) {
  if (typeof data === "string") return JSON.parse(data);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  // Supabase Realtime protocol v2 sends user broadcasts in its compact binary
  // envelope: kind, topic size, event size, metadata size, encoding.
  if (bytes.length >= 5 && bytes[0] === 4) {
    const topicSize = bytes[1];
    const eventSize = bytes[2];
    const metadataSize = bytes[3];
    const payloadEncoding = bytes[4];
    let offset = 5;
    const frameTopic = bytes.subarray(offset, offset + topicSize).toString("utf8");
    offset += topicSize;
    const userEvent = bytes.subarray(offset, offset + eventSize).toString("utf8");
    offset += eventSize + metadataSize;
    const rawPayload = bytes.subarray(offset);
    const broadcastPayload = payloadEncoding === 1
      ? JSON.parse(rawPayload.toString("utf8"))
      : rawPayload;
    return [null, null, frameTopic, "broadcast", { event: userEvent, payload: broadcastPayload }];
  }
  return JSON.parse(bytes.toString("utf8"));
}

function startCommandWakeChannel(config, executeExclusive, options = {}) {
  let socket = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let stopped = false;
  let messageRef = 1;
  let realtimeConfig = null;
  const backoff = createReconnectBackoff();

  const log = (level, message) => emitLog(options, level, message);
  const clearSocketTimers = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };
  const sendFrame = (topic, event, payload, joinRef = null) => {
    if (socket?.readyState !== 1) return;
    const ref = String(messageRef++);
    socket.send(JSON.stringify([joinRef, ref, topic, event, payload]));
    return ref;
  };
  const runWake = async (reason) => {
    try {
      const processed = await executeExclusive(() => drainPendingCommands(config, options), { priority: 90 });
      if (processed > 0) log("info", `Processed ${processed} queued Tally command${processed === 1 ? "" : "s"} after ${reason}.`);
    } catch (error) {
      log("error", error instanceof Error ? error.message : "Immediate Tally command check failed.");
    }
  };
  const scheduleReconnect = () => {
    clearSocketTimers();
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, backoff.nextDelay());
    reconnectTimer.unref?.();
  };

  const connect = async () => {
    if (stopped) return;
    if (typeof WebSocket !== "function") {
      log("error", "This connector runtime does not support immediate command notifications; polling fallback remains active.");
      return;
    }
    try {
      realtimeConfig = await fetchCommandRealtimeConfig(config);
      if (!realtimeConfig?.websocketUrl || !realtimeConfig?.publishableKey || !realtimeConfig?.topic) {
        throw new Error("Realtime command notifications are not configured.");
      }
      const url = new URL(realtimeConfig.websocketUrl);
      url.searchParams.set("apikey", realtimeConfig.publishableKey);
      url.searchParams.set("vsn", "2.0.0");
      const topic = `realtime:${realtimeConfig.topic}`;
      socket = new WebSocket(url.toString(), {
        // The packaged Electron runtime does not inherit Node's
        // --use-system-ca flag. Include Windows' trusted roots explicitly so
        // corporate SSL inspection certificates work exactly as they do for
        // the connector's normal HTTPS requests.
        ca: trustedCaCertificates(),
      });
      socket.addEventListener("open", () => {
        sendFrame(topic, "phx_join", {
          config: {
            broadcast: { ack: false, self: false },
            presence: { enabled: false },
            postgres_changes: [],
          },
        }, "1");
        heartbeatTimer = setInterval(() => sendFrame("phoenix", "heartbeat", {}), 25_000);
        heartbeatTimer.unref?.();
      });
      socket.addEventListener("message", (event) => {
        try {
          const frame = decodeRealtimeFrame(event.data);
          if (!Array.isArray(frame) || frame.length < 5) return;
          const [, , frameTopic, eventName, payload] = frame;
          if (frameTopic !== topic) return;
          if (eventName === "phx_reply" && payload?.status === "ok") {
            log("info", backoff.connected()
              ? "Immediate Tally command notifications reconnected."
              : "Immediate Tally command notifications connected; 15-second polling remains as fallback.");
            void runWake("notification-channel startup");
            return;
          }
          if (eventName === "broadcast" && payload?.event === (realtimeConfig.event || "command_queued")) {
            void runWake("realtime notification");
          }
        } catch (error) {
          log("error", error instanceof Error ? error.message : "Invalid realtime command notification.");
        }
      });
      socket.addEventListener("error", (event) => {
        const detail = event?.error?.message || event?.message || "WebSocket connection failed";
        if (backoff.shouldLog()) log("error", `Immediate command notifications are unavailable (${detail}); polling fallback remains active.`);
      });
      socket.addEventListener("close", scheduleReconnect);
    } catch (error) {
      if (backoff.shouldLog()) log("error", `${error instanceof Error ? error.message : "Could not connect command notifications"} Polling fallback remains active.`);
      scheduleReconnect();
    }
  };

  void connect();
  return () => {
    stopped = true;
    clearSocketTimers();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close();
  };
}

async function startBridge(args) {
  const config = readConfig();
  if (!config) {
    throw new Error(`Bridge is not paired. Run pair first. Expected config at ${CONFIG_PATH}`);
  }

  if (args["tally-url"]) {
    config.tallyUrl = normalizeTallyUrl(args["tally-url"]);
    writeConfig(config);
  }

  const intervalMs = Number(args.interval || DEFAULT_HEARTBEAT_INTERVAL_MS);
  const runtimeOptions = {
    companyListCache: { availableCompanies: [], nextRefreshAt: 0 },
  };
  console.log(`Starting Tally bridge for ${config.tallyUrl}`);
  console.log(`Sending heartbeat every ${intervalMs} ms.`);

  const scheduler = createTallyScheduler();
  const executeExclusive = (task, scheduling) => scheduler.run(task, scheduling);
  let heartbeatInFlight = false;
  const runSerially = async () => {
    if (scheduler.busy) {
      if (!heartbeatInFlight) {
        heartbeatInFlight = true;
        try { await sendHeartbeat(config, {}, [], true); }
        finally { heartbeatInFlight = false; }
      }
      return;
    }
    await executeExclusive(() => runOnce(config, runtimeOptions), { priority: 30 });
  };

  await runOnce(config, runtimeOptions);
  startCommandWakeChannel(config, executeExclusive);
  startCashDiscountLiveChannel(config, executeExclusive);
  setInterval(() => {
    runSerially().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
    });
  }, intervalMs);
}

async function testBridge(args) {
  const config = readConfig() ?? {
    tallyUrl: normalizeTallyUrl(args["tally-url"]),
  };
  const result = await testTally(normalizeTallyUrl(args["tally-url"] || config.tallyUrl));
  console.log(JSON.stringify(result, null, 2));
}

function emitLog(options, level, message) {
  if (typeof options?.onLog === "function") {
    options.onLog({
      level,
      message,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (level === "error") {
    console.error(message);
    return;
  }

  console.log(message);
}

function createBridgeRunner(options = {}) {
  const config = options.config ?? readConfig();
  if (!config) {
    throw new Error(`Bridge is not paired. Run pair first. Expected config at ${CONFIG_PATH}`);
  }

  const intervalMs = Number(options.intervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
  let timer = null;
  const scheduler = createTallyScheduler();
  const progressSentAt = new Map();
  const agentRuntime = createLocalAgentRuntime({
    config,
    safeStorage: options.safeStorage,
    tallyExecutor: (task, scheduling) => scheduler.run(task, scheduling),
    onProgress: (progress) => {
      options.onProgress?.(progress);
      if (!progress?.commandId) return;
      const now = Date.now();
      const previous = progressSentAt.get(progress.commandId) || 0;
      if (now - previous < 10_000 && progress.phase !== "complete") return;
      progressSentAt.set(progress.commandId, now);
      void sendAgentProgress(config, progress).catch((error) => emitLog(options, "error", error.message));
    },
    onLog: (level, message) => emitLog(options, level, message),
  });
  Object.defineProperty(config, "__agentRuntime", { value: agentRuntime, enumerable: false, configurable: true });
  let heartbeatInFlight = false;
  let lastCycleError = null;
  let stopped = false;
  let stopCommandWakeChannel = null;
  let stopCashDiscountLiveChannel = null;
  const runtimeOptions = {
    ...options,
    companyListCache: { availableCompanies: [], nextRefreshAt: 0 },
  };

  const executeExclusive = (task, scheduling) => scheduler.run(task, scheduling);

  let stopping = null;
  // Resolves once the storage worker, vector worker and loopback upload server
  // have released their files and port, so callers can safely re-pair or reset.
  const stop = (reason = "stopped", error = null) => {
    if (stopped) return stopping;
    stopped = true;
    scheduler.stop();
    stopping = agentRuntime.stop().catch((stopError) => emitLog(options, "error", stopError.message));
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    stopCommandWakeChannel?.();
    stopCommandWakeChannel = null;
    stopCashDiscountLiveChannel?.();
    stopCashDiscountLiveChannel = null;
    if (typeof options.onStop === "function") {
      options.onStop({ reason, error, timestamp: new Date().toISOString() });
    }
    return stopping;
  };

  const runSerially = async () => {
    if (stopped) return;
    try {
      if (scheduler.busy) {
        if (!heartbeatInFlight) {
          heartbeatInFlight = true;
          try { await sendHeartbeat(config, {}, [], true); }
          finally { heartbeatInFlight = false; }
        }
        return;
      }
      const cycle = await executeExclusive(() => runOnce(config, runtimeOptions), { priority: 30 });
      lastCycleError = null;
      if (typeof options.onStatus === "function") {
        options.onStatus(cycle);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "Bridge cycle failed.");
      // Log a repeating failure (e.g. server offline) once, not every 15 s.
      if (message !== lastCycleError) emitLog(options, "error", message);
      lastCycleError = message;
      if (
        error?.status === 401 ||
        error?.status === 409 ||
        error?.status === 426 ||
        /invalid bridge token|different connector installation|connector update required/i.test(
          String(error?.message ?? "")
        )
      ) {
        deleteConfig();
        stop(error?.status === 426 ? "update required" : "revoked", error);
      }
    }
  };

  return {
    config,
    get stopped() {
      return stopped;
    },
    get busy() {
      return scheduler.busy;
    },
    async start() {
      await agentRuntime.start();
      await flushResultOutbox(config).catch((error) => emitLog(options, "error", `Result outbox replay deferred: ${error.message}`));
      emitLog(options, "info", `Starting Bhuleshwar Local Agent ${AGENT_VERSION} for ${config.tallyUrl}`);
      emitLog(options, "info", `Sending heartbeat every ${intervalMs} ms.`);
      stopCommandWakeChannel = startCommandWakeChannel(config, executeExclusive, options);
      stopCashDiscountLiveChannel = startCashDiscountLiveChannel(config, executeExclusive, options);
      await runSerially();
      if (!stopped) {
        timer = setInterval(() => {
          runSerially().catch((error) => {
            emitLog(options, "error", error instanceof Error ? error.message : String(error));
          });
        }, intervalMs);
      }
    },
    stop,
    async runOnce() {
      await runSerially();
    },
    syncAgentDataset(options = {}) {
      return agentRuntime.syncActiveDataset(options);
    },
    rebuildAgentVectorIndex() {
      return agentRuntime.rebuildActiveVectorIndex();
    },
    prepareCustomerDues(options = {}) {
      return agentRuntime.prepareActiveReceivables({ full: options?.full === true });
    },
    getAgentStatus() {
      return agentRuntime.status();
    },
    getAgentSettings() {
      return agentRuntime.settings();
    },
    updateAgentSettings(settings) {
      return agentRuntime.updateSettings(settings);
    },
    clearAgentCache() {
      return agentRuntime.storage.call("clearRebuildableCache");
    },
    exportAgentDiagnostics() {
      return agentRuntime.storage.call("exportDiagnostics");
    },
  };
}

async function disconnectBridge(args = {}) {
  const config = readConfig();
  if (!config) {
    return {
      disconnected: false,
      localConfigDeleted: false,
      reason: "not_paired",
    };
  }

  const requestedConnectionId = String(args["connection-id"] || "").trim();
  if (requestedConnectionId && requestedConnectionId !== config.connectionId) {
    return {
      disconnected: false,
      localConfigDeleted: false,
      reason: "connection_mismatch",
      activeConnectionId: config.connectionId,
      requestedConnectionId,
    };
  }

  let remote = null;
  try {
    const response = await fetch(`${config.apiBase}/api/tally/bridge/disconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.bridgeToken}`,
      },
      body: JSON.stringify({
        connectionId: config.connectionId,
      }),
    });
    remote = await readJsonResponse(response);
  } catch (_error) {
    // Local disconnect should succeed even if the API is unavailable.
  } finally {
    if (String(args["keep-config"] || "").toLowerCase() !== "true") {
      deleteConfig();
    }
  }

  return {
    disconnected: true,
    localConfigDeleted: String(args["keep-config"] || "").toLowerCase() !== "true",
    remote,
  };
}

async function syncMastersCli(args) {
  const config = readConfig();
  if (!config) {
    throw new Error(`Bridge is not paired. Run pair first. Expected config at ${CONFIG_PATH}`);
  }

  const nextConfig = { ...config };
  if (args["tally-url"]) {
    nextConfig.tallyUrl = normalizeTallyUrl(args["tally-url"]);
  }
  if (args["company-name"]) {
    nextConfig.companyName = args["company-name"];
  }

  const outcome = await syncMastersFromTally(nextConfig, {
    companyName: args["company-name"] || nextConfig.companyName,
    tallyUrl: nextConfig.tallyUrl,
  });

  console.log(JSON.stringify(outcome.result, null, 2));
}

async function listBankLedgersCli(args) {
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const companyNames = args["company-names"]
    ? String(args["company-names"]).split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const outcome = await fetchBankLedgersFromTally(
    {
      ...(config || {}),
      tallyUrl: normalizeTallyUrl(args["tally-url"] || config?.tallyUrl),
      companyName: args["company-name"] || config?.companyName || null,
    },
    {
      companyName: args["company-name"] || config?.companyName || null,
      companyNames,
    }
  );

  console.log(JSON.stringify(outcome.result, null, 2));
}

function readJsonPayload(args) {
  if (args["payload-json"]) {
    return JSON.parse(args["payload-json"]);
  }

  if (args["payload-file"]) {
    return JSON.parse(fs.readFileSync(args["payload-file"], "utf8"));
  }

  throw new Error("Provide --payload-file <path> or --payload-json '<json>'.");
}

async function validateBankVoucherCli(args) {
  const payload = readJsonPayload(args);
  const config = readConfig();
  const companyName = args["company-name"] || config?.companyName || null;
  const xml = buildBankVoucherXml(payload, companyName);

  console.log(JSON.stringify(
    {
      ok: true,
      commandType: "post_bank_voucher",
      companyName: payload.companyName || companyName,
      voucherType: payload.voucherType || "Payment",
      voucherDate: toIsoLikeDate(payload.voucherDate),
      bankLedgerName: payload.bankLedgerName,
      counterpartyLedgerName: payload.counterpartyLedgerName,
      amount: toMoney(payload.amount),
      requestXml: previewXml(xml),
    },
    null,
    2
  ));
}

function shouldPostDiagnostics(args) {
  return String(args.post || "").toLowerCase() === "true" || String(args.post || "").toLowerCase() === "yes";
}

function writeDiagnosticArtifact(outputDir, variantName, extension, content) {
  if (!outputDir) return null;
  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = variantName.replace(/[^a-z0-9._-]/gi, "-");
  const filePath = path.join(outputDir, `${safeName}.${extension}`);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

async function diagnoseBankVoucherCli(args) {
  const payload = readJsonPayload(args);
  const config = readConfig();
  const post = shouldPostDiagnostics(args);
  if (post && !config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const companyName = args["company-name"] || payload.companyName || config?.companyName || null;
  const tallyUrl = post ? normalizeTallyUrl(args["tally-url"] || config?.tallyUrl) : null;
  const stopOnSuccess = String(args["stop-on-success"] ?? "true").toLowerCase() !== "false";
  const outputDir = args["output-dir"] || null;
  const variants = buildBankVoucherDiagnosticVariants(payload, companyName);
  const requestedVariantNames = String(args.variants || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const selectedVariants = requestedVariantNames.length
    ? variants.filter((variant) => requestedVariantNames.includes(variant.name))
    : variants;

  if (selectedVariants.length === 0) {
    throw new Error(`No diagnostic variants matched --variants. Available: ${variants.map((variant) => variant.name).join(", ")}`);
  }

  const results = [];
  for (const variant of selectedVariants) {
    const requestXmlPath = writeDiagnosticArtifact(outputDir, variant.name, "request.xml", variant.xml);
    const result = {
      name: variant.name,
      description: variant.description,
      requestXmlPath,
      requestXml: outputDir ? undefined : previewXml(variant.xml),
      posted: post,
      success: null,
      error: null,
      created: null,
      altered: null,
      errors: null,
      responsePath: null,
      responsePreview: null,
    };

    if (post) {
      const outcome = explainVoucherTallyError(
        await invokeTallyXml(tallyUrl, variant.xml),
        payload
      );
      const responseText = String(outcome.result?.response || "");
      result.success = outcome.success;
      result.error = outcome.error || null;
      result.created = outcome.result?.created ?? null;
      result.altered = outcome.result?.altered ?? null;
      result.errors = outcome.result?.errors ?? null;
      result.responsePath = writeDiagnosticArtifact(outputDir, variant.name, "response.xml", responseText);
      result.responsePreview = outputDir ? undefined : responseText;
      results.push(result);

      const created = Number(outcome.result?.created ?? 0) || 0;
      const altered = Number(outcome.result?.altered ?? 0) || 0;
      if (outcome.success && (created > 0 || altered > 0) && stopOnSuccess) {
        break;
      }
      continue;
    }

    results.push(result);
  }

  console.log(JSON.stringify(
    {
      ok: true,
      posted: post,
      tallyUrl: post ? tallyUrl : null,
      companyName,
      voucherType: payload.voucherType || "Payment",
      voucherDate: toIsoLikeDate(payload.voucherDate),
      referenceNumber: String(payload.referenceNumber || payload.transactionId || ""),
      outputDir,
      variants: results,
    },
    null,
    2
  ));
}

async function diagnoseBankVoucherDatesCli(args) {
  const payload = readJsonPayload(args);
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const companyName = args["company-name"] || payload.companyName || config?.companyName || null;
  const tallyUrl = normalizeTallyUrl(args["tally-url"] || config?.tallyUrl);
  const variantName = args.variant || "minimal-accounting";
  const outputDir = args["output-dir"] || null;
  const dateValues = String(args.dates || "2026-04-01,2026-06-03,2026-06-04")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (dateValues.length === 0) {
    throw new Error("Provide one or more dates with --dates YYYY-MM-DD,YYYY-MM-DD.");
  }

  const results = [];
  for (const dateValue of dateValues) {
    const voucherDate = toIsoLikeDate(dateValue);
    const datePayload = {
      ...payload,
      voucherDate: dateValue,
      referenceNumber: `DIAG-${payload.voucherType || "VCH"}-${voucherDate}`,
      narration: `${payload.narration || "Bank voucher diagnostic"} date probe ${dateValue}`,
    };
    const xml = getBankVoucherDiagnosticVariantXml(datePayload, companyName, variantName);
    const artifactName = `date-${voucherDate}`;
    const requestXmlPath = writeDiagnosticArtifact(outputDir, artifactName, "request.xml", xml);
    const outcome = explainVoucherTallyError(
      await invokeTallyXml(tallyUrl, xml),
      datePayload
    );
    const responseText = String(outcome.result?.response || "");
    const responsePath = writeDiagnosticArtifact(outputDir, artifactName, "response.xml", responseText);
    results.push({
      date: dateValue,
      voucherDate,
      referenceNumber: datePayload.referenceNumber,
      variant: variantName,
      success: outcome.success,
      error: outcome.error || null,
      created: outcome.result?.created ?? null,
      altered: outcome.result?.altered ?? null,
      errors: outcome.result?.errors ?? null,
      requestXmlPath,
      responsePath,
      responsePreview: outputDir ? undefined : responseText,
    });
  }

  console.log(JSON.stringify(
    {
      ok: true,
      posted: true,
      tallyUrl,
      companyName,
      voucherType: payload.voucherType || "Payment",
      variant: variantName,
      outputDir,
      results,
    },
    null,
    2
  ));
}

async function diagnoseTallyCompanyCli(args) {
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const tallyUrl = normalizeTallyUrl(args["tally-url"] || config?.tallyUrl);
  const companyName = args["company-name"] || config?.companyName || null;
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Autodealer Company Diagnostics",
    tallyType: "Company",
    fetchFields:
      "Name,Guid,StartingFrom,BooksFrom,FinancialYearFrom,CurrentPeriod,AlterID,MasterID",
    companyName,
  });
  const companies = parseMasterCollection(xml, "COMPANY");
  console.log(JSON.stringify(
    {
      ok: true,
      tallyUrl,
      companyName,
      companies,
      rawPreview: previewXml(xml),
    },
    null,
    2
  ));
}

async function findVouchersCli(args) {
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const tallyUrl = normalizeTallyUrl(args["tally-url"] || config.tallyUrl);
  const companyName = args["company-name"] || config?.companyName || null;
  const refs = String(args.refs || args.ref || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (refs.length === 0) {
    throw new Error("Provide --refs REF1,REF2 or --ref REF.");
  }

  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Autodealer Voucher Lookup",
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,IsCancelled,AllLedgerEntries.LedgerName",
    companyName,
    dateFrom: "2000-04-01",
    dateTo: "2099-03-31",
  });
  const vouchers = parseVoucherCollection(xml);
  const matches = vouchers.filter((voucher) => {
    const haystack = [
      voucher.voucherNumber,
      voucher.reference,
      voucher.narration,
      voucher.partyLedgerName,
      ...voucher.ledgerNames,
      voucher.rawPreview,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return refs.some((ref) => haystack.includes(ref.toLowerCase()));
  });

  console.log(JSON.stringify(
    {
      ok: true,
      companyName,
      searchedRefs: refs,
      scannedCount: vouchers.length,
      matchCount: matches.length,
      matches,
    },
    null,
    2
  ));
}

async function listVouchersCli(args) {
  const config = readConfig();
  if (!config && !args["tally-url"]) {
    throw new Error(`Bridge is not paired. Run pair first or pass --tally-url. Expected config at ${CONFIG_PATH}`);
  }

  const tallyUrl = normalizeTallyUrl(args["tally-url"] || config.tallyUrl);
  const companyName = args["company-name"] || config?.companyName || null;
  const limit = Math.max(1, Math.min(Number(args.limit || 20) || 20, 200));
  const includeAll = String(args.all || "").toLowerCase() === "true" || String(args.all || "").toLowerCase() === "yes";
  const xml = await exportTallyCollection(tallyUrl, {
    collectionName: "Autodealer Voucher List",
    tallyType: "Voucher",
    fetchFields:
      "Date,EffectiveDate,VoucherTypeName,VoucherNumber,Reference,Narration,PartyLedgerName,MasterID,AlterID,IsCancelled,AllLedgerEntries.LedgerName",
    companyName,
    dateFrom: "2000-04-01",
    dateTo: "2099-03-31",
  });
  const vouchers = parseVoucherCollection(xml);

  console.log(JSON.stringify(
    {
      ok: true,
      companyName,
      scannedCount: vouchers.length,
      vouchers: includeAll ? vouchers : vouchers.slice(-limit),
    },
    null,
    2
  ));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "pair") {
    await pairBridge(args);
    return;
  }

  if (command === "start") {
    await startBridge(args);
    return;
  }

  if (command === "test") {
    await testBridge(args);
    return;
  }

  if (command === "sync-masters") {
    await syncMastersCli(args);
    return;
  }

  if (command === "list-bank-ledgers") {
    await listBankLedgersCli(args);
    return;
  }

  if (command === "validate-bank-voucher") {
    await validateBankVoucherCli(args);
    return;
  }

  if (command === "diagnose-bank-voucher") {
    await diagnoseBankVoucherCli(args);
    return;
  }

  if (command === "diagnose-bank-voucher-dates") {
    await diagnoseBankVoucherDatesCli(args);
    return;
  }

  if (command === "diagnose-tally-company") {
    await diagnoseTallyCompanyCli(args);
    return;
  }

  if (command === "find-vouchers") {
    await findVouchersCli(args);
    return;
  }

  if (command === "list-vouchers") {
    await listVouchersCli(args);
    return;
  }

  console.log("Usage:");
  console.log("  node apps/tally-bridge/src/bridge.mjs pair --api-base <url> --connection-id <id> --pairing-code <code> --tally-url http://localhost:9000");
  console.log("  node apps/tally-bridge/src/bridge.mjs start");
  console.log("  node apps/tally-bridge/src/bridge.mjs sync-masters --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs list-bank-ledgers --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs validate-bank-voucher --payload-file <path>");
  console.log("  node apps/tally-bridge/src/bridge.mjs diagnose-bank-voucher --payload-file <path> --post true --output-dir ./tally-diagnostics");
  console.log("  node apps/tally-bridge/src/bridge.mjs diagnose-bank-voucher-dates --payload-file <path> --dates 2026-04-01,2026-06-03");
  console.log("  node apps/tally-bridge/src/bridge.mjs diagnose-tally-company --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs find-vouchers --refs REF1,REF2 --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs list-vouchers --company-name <name>");
  console.log("  node apps/tally-bridge/src/bridge.mjs test --tally-url http://localhost:9000");
}

export {
  storeCollectionsDashboard,
  answerCollectionsRequest,
  BRIDGE_VERSION,
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_COMPANY_LIST_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_TALLY_URL,
  createBridgeRunner,
  decodeRealtimeFrame,
  classifyOpenBillReferenceKind,
  classifyTaxLedgers,
  cashDiscountVoucherDateChunks,
  collectCashDiscountLiveSnapshot,
  collectCashDiscountCustomerEvidence,
  collectTallyCompanyCheck,
  buildCollectionExportXml,
  buildLedgerGstRegistrationExportXml,
  adoptHeartbeatIdentity,
  buildRequestedLedgerFormula,
  buildPurchaseVoucherXml,
  cashDiscountFinancialYearRange,
  deleteConfig,
  disconnectBridge,
  exportTallyCollection,
  exportNamedCashDiscountMasters,
  exportCashDiscountAncestorGroups,
  exportTargetedBillEvidenceXml,
  existingPurchaseVoucherAttachmentDifferences,
  fetchAvailableCompanies,
  fetchBankLedgersFromTally,
  findBankLedgersFromMasters,
  findPartyLedgersFromMasters,
  selectCashDiscountLedgers,
  fetchCustomerOpenBillsFromTally,
  normalizeTallyUrl,
  openBillPendingFormula,
  exportCashDiscountOpenBillsFirst,
  extractNamedCollectionNames,
  openBillBlockRequiresVoucherFallback,
  pairBridge,
  parseTallyImportResult,
  purchasePayloadMasterNames,
  purchaseVoucherFinancialYearRange,
  purchaseVoucherReadbackComparison,
  parseMasterCollection,
  parseNativeLedgerRegistrationXml,
  exportNativeLedgerGstRegistrations,
  mergeTargetedPurchaseLedgerDetails,
  purchaseMasterDiagnostics,
  shouldUseLivePurchaseMasterRead,
  readConfig,
  reconcileBankTransactionsInTally,
  strictBankTransactionCandidates,
  runOnce,
  startBridge,
  testBridge,
  testTally,
  verifyPurchaseVoucherInTally,
  writeConfig,
};

if (process.argv[1] && path.resolve(process.argv[1]) === CURRENT_FILE) {
  main().catch((error) => {
    console.error(formatCliError(error));
    process.exit(1);
  });
}

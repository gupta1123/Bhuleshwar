import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, Tray } from "electron";
import electronUpdater from "electron-updater";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { pairBridge, createBridgeRunner, disconnectBridge, readConfig } from "@autodealer/tally-bridge";
import { consumeSuccessfulUpdate, isNewerVersion, recordDownloadedUpdate } from "./update-state.mjs";

// electron-updater publishes CommonJS. Importing autoUpdater as an ESM named
// export works in some development environments but fails in the packaged
// Electron runtime before app startup.
const { autoUpdater } = electronUpdater;

const CONNECTOR_NAME = "Bhuleshwar Local Agent";
const PROTOCOL_NAME = "bhuleshwar-tally";
// The web app may still send the legacy scheme while a deployment catches up.
const CONNECTOR_URL_PATTERN = /^(?:bhuleshwar|kalika)-tally:\/\//;
const isConnectorUrl = (value) => typeof value === "string" && CONNECTOR_URL_PATTERN.test(value);
const APP_USER_MODEL_ID = "com.bhuleshwar.local-agent";
const HIDDEN_LAUNCH_ARG = "--hidden";
// The installer starts the agent with --quit to close a running copy cleanly.
const QUIT_LAUNCH_ARG = "--quit";

// The status window is plain HTML and does not benefit from GPU acceleration.
// Some Windows graphics drivers leave Electron's renderer alive but entirely
// black, so render this lightweight window in software.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
// Chromium still starts a small GPU subprocess in software mode. On affected
// Windows 10 hosts that subprocess repeatedly exits with EXCEPTION_BREAKPOINT
// and Chromium terminates the whole app. Keeping software GPU work in the
// browser process avoids that broken subprocess.
app.commandLine.appendSwitch("in-process-gpu");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localAgentRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Bhuleshwar",
  "LocalAgent",
);
const runtimeLogDir = path.join(localAgentRoot, "logs");
fs.mkdirSync(runtimeLogDir, { recursive: true });
const logPath = path.join(runtimeLogDir, "bridge.log");
const errPath = path.join(runtimeLogDir, "bridge.err.log");
const WINDOWS_CA_READY = "KALIKA_CONNECTOR_WINDOWS_CA_READY";
if (process.env.KALIKA_BENCHMARK_PDF) {
  fs.appendFileSync(path.resolve(process.cwd(), "kalika-benchmark-main.log"), `${new Date().toISOString()} benchmark-main-loaded\n`);
}

let mainWindow = null;
let runner = null;
let pendingProtocolUrl = null;
let safeQuitApproved = false;
let updateInstallTimer = null;
let updatedOnThisLaunch = false;
let acceptedUpdateVersion = null;
let updateState = {
  state: "idle",
  installedVersion: app.getVersion(),
  availableVersion: null,
  percent: 0,
  message: "Updates are checked automatically.",
};
let lastStatus = {
  title: "Waiting for connection",
  detail: "Open Bhuleshwar and click Connect.",
  state: "idle",
};

function hasWindowsCertificateBundle(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").includes("-----BEGIN CERTIFICATE-----");
  } catch {
    return false;
  }
}

function relaunchWithWindowsCertificateStore() {
  if (process.platform !== "win32" || process.env[WINDOWS_CA_READY] === "1") {
    return false;
  }

  try {
    const configDir = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Bhuleshwar", "LocalAgent", "config"
    );
    const certificatePath = path.join(configDir, "windows-ca-bundle.pem");
    const powershell = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    const windowsModulePath = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules"
    );
    const exporter = path.join(
      app.isPackaged ? process.resourcesPath : path.resolve(__dirname, ".."),
      "powershell",
      "export-windows-ca.ps1",
    );
    fs.mkdirSync(configDir, { recursive: true });
    // Reuse the previously exported Windows trust store. Importing the
    // certificate provider can take longer than ten seconds on some machines,
    // and making every launch wait for it caused the connector to fall back to
    // Electron's incomplete CA set even when a valid bundle already existed.
    if (!hasWindowsCertificateBundle(certificatePath)) {
      execFileSync(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          exporter,
          "-OutputPath",
          certificatePath,
        ],
        {
          windowsHide: true,
          timeout: 30_000,
          env: {
            ...process.env,
            PSModulePath: [windowsModulePath, process.env.PSModulePath].filter(Boolean).join(";"),
          },
        },
      );
    }
    if (!hasWindowsCertificateBundle(certificatePath)) {
      return false;
    }

    // Child workers (document parsing, vector search) inherit this.
    process.env.NODE_EXTRA_CA_CERTS = certificatePath;
    // Newer Node runtimes can extend the trusted roots in-process, which
    // avoids booting Electron a second time on every launch.
    if (typeof tls.setDefaultCACertificates === "function") {
      try {
        const extra = fs.readFileSync(certificatePath, "utf8")
          .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
        tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...extra])]);
        process.env[WINDOWS_CA_READY] = "1";
        return false;
      } catch (error) {
        // Fall back to the relaunch path below.
        appendLog(errPath, `In-process certificate load failed; relaunching: ${error instanceof Error ? error.message : error}`);
      }
    }

    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      windowsHide: false,
      stdio: "ignore",
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: certificatePath,
        [WINDOWS_CA_READY]: "1",
      },
    });
    child.unref();
    return true;
  } catch (error) {
    try {
      fs.appendFileSync(
        path.join(runtimeLogDir, "bridge.bootstrap.log"),
        `[${new Date().toISOString()}] ${error instanceof Error ? error.stack || error.message : String(error)}\n`
      );
    } catch {
      // The normal connector window remains the fallback error surface.
    }
    // Public certificate authorities remain available if Windows certificate
    // export is restricted. The connector UI will surface any network error.
    return false;
  }
}

// Keep at most two ~5 MB generations per log so a machine that runs the agent
// for months does not accumulate unbounded log files.
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const logSizes = new Map();

function appendLog(filePath, message) {
  // An error object must show its message, never "[object Object]".
  const text = typeof message === "string" ? message
    : message instanceof Error ? (message.stack || message.message)
    : message && typeof message === "object" ? (message.message || JSON.stringify(message))
    : String(message);
  const line = `[${new Date().toISOString()}] ${text}\n`;
  if (!logSizes.has(filePath)) {
    try { logSizes.set(filePath, fs.statSync(filePath).size); } catch { logSizes.set(filePath, 0); }
  }
  const size = logSizes.get(filePath) + Buffer.byteLength(line);
  if (size > MAX_LOG_BYTES) {
    try { fs.renameSync(filePath, `${filePath}.1`); } catch {}
    logSizes.set(filePath, Buffer.byteLength(line));
  } else {
    logSizes.set(filePath, size);
  }
  fs.appendFile(filePath, line, () => {});
}

function formatConnectorError(error) {
  return String(error instanceof Error ? error.stack || error.message : error)
    .replace(/'data:text\/html[^']*'/gi, "the embedded Local Agent status page")
    .slice(0, 2_000);
}

function isExistingLocalAgentError(error) {
  const message = String(error instanceof Error ? error.message : error);
  return error?.code === "EADDRINUSE" && Number(error?.port) === 17843
    || /EADDRINUSE[\s\S]*127\.0\.0\.1:17843/i.test(message);
}

function closeDuplicateLocalAgent(error) {
  appendLog(
    errPath,
    `A previously started Local Agent already owns the browser handoff port; closing this duplicate process. (${error instanceof Error ? error.message : error})`,
  );
  safeQuitApproved = true;
  setImmediate(() => app.quit());
}

function parseConnectUrl(value) {
  const url = new URL(value);
  return {
    "api-base": url.searchParams.get("apiBase") || url.searchParams.get("api-base") || "",
    "connection-id": url.searchParams.get("connectionId") || url.searchParams.get("connection-id") || "",
    "pairing-code": url.searchParams.get("pairingCode") || url.searchParams.get("pairing-code") || "",
    "control-token": url.searchParams.get("controlToken") || url.searchParams.get("control-token") || "",
    "tally-url": url.searchParams.get("tallyUrl") || url.searchParams.get("tally-url") || "http://localhost:9000",
    "bridge-name": "Bhuleshwar Tally Connector",
  };
}

function sendStatus(status) {
  lastStatus = { ...lastStatus, ...status };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("agent:status", lastStatus);
  }
}

function sendUpdateStatus(status) {
  updateState = { ...updateState, ...status };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("agent:update-status", updateState);
  }
}

function configureUpdateFeed() {
  const packagedUpdateConfig = path.join(process.resourcesPath, "app-update.yml");
  if (!fs.existsSync(packagedUpdateConfig)) {
    autoUpdater.setFeedURL({ provider: "github", owner: "gupta1123", repo: "Bhuleshwar" });
  }
}

const UPDATE_CHECK_DELAY_MS = 2 * 60_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

async function checkForUpdatesNow() {
  // Never restart a check while a download is in flight or an update is
  // already waiting to be installed.
  if (["checking", "available", "downloading", "ready", "waiting", "installing"].includes(updateState.state)) {
    return updateState;
  }
  configureUpdateFeed();
  sendUpdateStatus({ state: "checking", message: "Checking for a newer Local Agent…" });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // Never show raw updater/HTTP errors in the window.
    reportUpdateError(error);
  }
  return updateState;
}

// Turns updater failures into a short message for the user; the technical
// detail goes to the error log as a single line.
function reportUpdateError(error) {
  const detail = String(error instanceof Error ? error.message : error || "");
  appendLog(errPath, `Updater: ${detail.split("\n")[0].slice(0, 300)}`);
  const version = app.getVersion();
  if (/latest\.yml|no published versions|HttpError: 404|\b404\b/i.test(detail)) {
    sendUpdateStatus({ state: "current", availableVersion: null, percent: 0,
      message: `No update is available right now. You're on version ${version}.` });
  } else if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|network|socket hang up/i.test(detail)) {
    sendUpdateStatus({ state: "failed", message: "Couldn't reach the update server. Check the internet connection and try again." });
  } else {
    sendUpdateStatus({ state: "failed", message: "Couldn't check for updates right now. Please try again later." });
  }
}

let tray = null;

async function createTray() {
  if (tray) return;
  try {
    const icon = await app.getFileIcon(process.execPath, { size: "small" });
    tray = new Tray(icon);
    tray.setToolTip(CONNECTOR_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Open ${CONNECTOR_NAME}`, click: () => showWindow() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]));
    tray.on("click", () => showWindow());
  } catch (error) {
    appendLog(errPath, `Tray icon unavailable: ${error instanceof Error ? error.message : error}`);
  }
}

function installDownloadedUpdateWhenSafe() {
  if (!runner?.busy) {
    if (updateInstallTimer) clearInterval(updateInstallTimer);
    updateInstallTimer = null;
    sendUpdateStatus({ state: "installing", percent: 100, message: "Installing the update. Bhuleshwar Local Agent will reopen automatically…" });
    safeQuitApproved = true;
    // Windows must release the running executable before NSIS can replace it.
    // Use a silent install and force the updated app to relaunch so this feels
    // like one continuous in-app update rather than a second installer flow.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 350);
    return { installing: true };
  }
  sendUpdateStatus({ state: "waiting", message: "Waiting for the active Tally operation to finish safely." });
  if (!updateInstallTimer) {
    updateInstallTimer = setInterval(() => {
      if (!runner?.busy) installDownloadedUpdateWhenSafe();
    }, 500);
    updateInstallTimer.unref();
  }
  return { installing: false, waiting: true };
}

function showWindow() {
  // The status window is created on demand and destroyed when closed, so an
  // idle agent keeps no renderer process in memory.
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function printableTallyHtml(html) {
  const withoutReportCaption = String(html ?? "").replace(
    /<TABLE[^>]*bgcolor="#2a67b1"[^>]*>[\s\S]*?<\/TABLE>/i,
    ""
  );
  const printStyles = `
    <meta charset="utf-8">
    <style>
      @page { size: A4; margin: 12mm; }
      html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
      body { color: #000; font-family: Arial, sans-serif; }
      table { max-width: 100%; }
    </style>`;
  if (/<head[^>]*>/i.test(withoutReportCaption)) {
    return `<!doctype html>${withoutReportCaption.replace(/<head[^>]*>/i, (head) => `${head}${printStyles}`)}`;
  }
  return `<!doctype html><html><head>${printStyles}</head><body>${withoutReportCaption}</body></html>`;
}

async function renderTallyPrintToPdf({ html, fileName }) {
  const printWindow = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Electron's renderer sandbox crashes on some supported Windows hosts.
      // This hidden print surface loads only application-generated HTML and
      // still has Node integration disabled with context isolation enabled.
      sandbox: false,
    },
  });
  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(printableTallyHtml(html))}`);
    const pdf = await printWindow.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      landscape: false,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      margins: { marginType: "default" },
    });
    if (!pdf?.length) throw new Error(`Could not render ${fileName || "the Tally Debit Note"}.`);
    return pdf;
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

async function startRunner() {
  // Wait for the previous runner to release its database, vector index and
  // loopback upload port before a new runner opens them again.
  if (runner && !runner.stopped) {
    await runner.stop("restarting");
  }

  runner = createBridgeRunner({
    safeStorage,
    renderTallyPrintToPdf,
    onProgress(progress) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent:progress", progress);
    },
    onLog(entry) {
      appendLog(entry.level === "error" ? errPath : logPath, entry.message);
      if (entry.level === "error") {
        // Revoked sessions are reported through onStop; only an explicit
        // token rejection is treated as expiry here.
        const expired = /invalid bridge token/i.test(entry.message);
        sendStatus({
          title: expired ? "Reconnect required" : "Connector warning",
          detail: expired ? "Open Bhuleshwar and click Connect again." : entry.message,
          state: expired ? "expired" : "warning",
        });
        return;
      }
      // Routine info logs must not replace the "Connected to <company>" status.
      if (lastStatus.state !== "connected") {
        sendStatus({ title: "Connector running", detail: entry.message, state: "running" });
      }
    },
    onStatus(cycle) {
      const result = cycle?.result || {};
      if (result.companyName) {
        sendStatus({ title: `Connected to ${result.companyName}`, detail: "Keep this app open while using Tally.", state: "connected" });
      } else if (result.tallyReachable) {
        sendStatus({ title: "Tally reachable", detail: "Open a company in Tally Prime.", state: "warning" });
      }
    },
    onStop(event) {
      if (event.reason === "revoked") {
        sendStatus({ title: "Reconnect required", detail: "Open Bhuleshwar and click Connect again.", state: "expired" });
        return;
      }
      if (event.reason === "update required") {
        sendStatus({ title: "Update required", detail: "Open Connector updates from the ⋮ menu to install the latest version.", state: "expired" });
        return;
      }
      if (event.reason === "restarting") return;
      sendStatus({ title: "Connector stopped", detail: event.reason || "Stopped", state: "stopped" });
    },
  });

  await runner.start();
  await applyStartWithWindowsSetting();
  removeVerifiedLegacyRuntime();
}

async function applyStartWithWindowsSetting() {
  try {
    const settings = await runner?.getAgentSettings?.();
    app.setLoginItemSettings({ openAtLogin: settings?.startWithWindows !== false, openAsHidden: true, args: [HIDDEN_LAUNCH_ARG] });
  } catch (error) {
    appendLog(errPath, `Start with Windows setting: ${error instanceof Error ? error.message : error}`);
  }
}

// Once this install has started and is paired, the pre-1.0 connector program
// in C:\Autodealer\tally-bridge is no longer needed. Delete it rather than
// archiving a ~260 MB copy on the client's disk. Its data was already migrated
// into %LOCALAPPDATA%\Kalika\LocalAgent, which is kept.
function removeVerifiedLegacyRuntime() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  const legacy = path.resolve("C:\\Autodealer\\tally-bridge");
  const current = path.resolve(process.resourcesPath, "..");
  const migratedConfig = path.join(localAgentRoot, "config", "config.json");
  const legacyMarker = path.join(legacy, "resources", "app", "package.json");
  if (current.startsWith(legacy) || !fs.existsSync(migratedConfig) || !fs.existsSync(legacyMarker)) return;
  try {
    // Keep documents\: older builds saved purchase PDFs there and Tally
    // vouchers link to them by absolute path. Remove only the old program.
    for (const entry of fs.readdirSync(legacy)) {
      if (entry.toLowerCase() === "documents") continue;
      fs.rmSync(path.join(legacy, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  } catch (error) {
    appendLog(errPath, `Legacy runtime cleanup deferred: ${error instanceof Error ? error.message : error}`);
  }
}

// Removes storage left behind by earlier connector versions. Only rebuildable
// or obsolete items are touched; config, security, data and vectors are the
// client's live state and are never removed here.
function cleanUpObsoleteLocalStorage() {
  const remove = (target) => {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (error) { appendLog(errPath, `Storage cleanup deferred for ${path.basename(target)}: ${error instanceof Error ? error.message : error}`); }
  };
  // Archived old programs, manual backups and plain-text legacy configs.
  remove(path.join(localAgentRoot, "migration-backups"));
  // Leftover files from interrupted document parsing.
  const temporary = path.join(localAgentRoot, "tmp");
  try {
    for (const entry of fs.readdirSync(temporary)) remove(path.join(temporary, entry));
  } catch {}
  // Rotated logs written before log size limits existed can be hundreds of MB.
  try {
    for (const entry of fs.readdirSync(runtimeLogDir)) {
      const filePath = path.join(runtimeLogDir, entry);
      if (/\.log\.\d+$/.test(entry) && fs.statSync(filePath).size > MAX_LOG_BYTES) remove(filePath);
    }
  } catch {}
}

let connectInFlight = null;

async function handleConnectUrl(value) {
  // Browsers can deliver the same link twice; a pairing code is single-use, so
  // a repeat must never reach the API or disturb the live session.
  if (connectInFlight) return connectInFlight;
  connectInFlight = handleConnectUrlOnce(value).finally(() => { connectInFlight = null; });
  return connectInFlight;
}

async function handleConnectUrlOnce(value) {
  try {
    const args = parseConnectUrl(value);
    let current = null;
    try { current = readConfig(); } catch {}
    if (current?.connectionId && current.connectionId === args["connection-id"] && runner && !runner.stopped) {
      showWindow();
      return;
    }
    if (
      !args["api-base"] ||
      !args["connection-id"] ||
      !args["pairing-code"] ||
      !args["control-token"]
    ) {
      throw new Error("Connect link is missing pairing details.");
    }
    showWindow();
    sendStatus({ title: "Pairing connector", detail: "Checking Tally and connecting to Bhuleshwar.", state: "running" });
    appendLog(logPath, `Connect link received for ${args["connection-id"]}; pairing.`);
    await pairBridge(args);
    let saved = null;
    try { saved = readConfig(); } catch (error) { saved = { error: String(error?.message || error) }; }
    appendLog(logPath, `Pairing finished; saved config: ${saved ? JSON.stringify({ connectionId: saved.connectionId, error: saved.error }) : "MISSING"}.`);
    sendStatus({ title: "Connector paired", detail: "Starting live sync.", state: "running" });
    await startRunner();
    appendLog(logPath, "Runner started after pairing.");
  } catch (error) {
    appendLog(errPath, `Connect handling failed: ${error instanceof Error ? error.stack || error.message : error}`);
    // A build installed before the single-instance lock may still be running
    // during an upgrade. Its loopback listener proves that another Local Agent
    // owns the browser handoff channel, so never show a raw EADDRINUSE failure
    // or leave a second command consumer alive.
    if (isExistingLocalAgentError(error)) {
      closeDuplicateLocalAgent(error);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    appendLog(errPath, message);
    sendStatus({ title: "Connection failed", detail: message, state: "error" });
    showWindow();
  }
}

async function handleDisconnectUrl(value) {
  try {
    const url = new URL(value);
    if (runner && !runner.stopped) await runner.stop("disconnect");
    await disconnectBridge({ "connection-id": url.searchParams.get("connectionId") || "" });
    sendStatus({ title: "Disconnected", detail: "Connector stopped.", state: "stopped" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(errPath, message);
  }
}

function handleProtocolUrl(value) {
  if (!isConnectorUrl(value)) return;
  if (/^(?:bhuleshwar|kalika)-tally:\/\/connect/.test(value)) {
    void handleConnectUrl(value);
    return;
  }
  if (/^(?:bhuleshwar|kalika)-tally:\/\/disconnect/.test(value)) {
    void handleDisconnectUrl(value);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: CONNECTOR_NAME,
    width: 484,
    height: 372,
    minWidth: 424,
    minHeight: 344,
    show: false,
    resizable: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: "#00000000",
    webPreferences: {
      // Sandboxed preload scripts execute as plain CommonJS in Electron. Keep
      // this bridge in a .cjs file; an ESM import here silently leaves the
      // renderer without window.kalikaAgent.
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      // Keep the isolated preload bridge, but avoid the Windows renderer
      // sandbox failure that otherwise leaves this window entirely black.
      sandbox: false,
    },
  });

  const connectorPage = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><head><meta charset="utf-8"><title>${CONNECTOR_NAME}</title>
    <style>
      :root{font-family:"Segoe UI Variable Text","Segoe UI",Arial,sans-serif;color:#2d2d2d;background:transparent;font-size:13px}*{box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden}body{margin:0;background:transparent}.windowShell{position:absolute;inset:2px;border:1px solid rgba(45,45,45,.1);border-radius:16px;background:#f4f0e9;overflow:hidden}.titleBar{height:40px;display:flex;align-items:center;padding:0 8px 0 14px;background:#fbf8f3;border-bottom:1px solid #ddd2c2;-webkit-app-region:drag;user-select:none}.titleBrand{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:650}.titleMark{width:22px;height:22px;display:grid;place-items:center;border-radius:7px;background:linear-gradient(150deg,#f1c889,#d48700 45%,#4ca154);color:#fff;font-weight:800}.windowControls{display:flex;margin-left:auto;height:100%;-webkit-app-region:no-drag}.windowControl{width:32px;height:28px;border:0;border-radius:7px;background:transparent;color:#706156;font-size:13px}.windowControl:hover{background:#e6ddd1;color:#2d2d2d}.windowControl.close:hover{background:#f0d8d2;color:#c1543b}.shell{height:calc(100% - 40px);overflow:auto;padding:14px}.top{display:flex;align-items:center;gap:11px}.brand{display:none}.heading h1{font-size:16.5px}.heading p{font-size:11.5px}.menu-wrap{margin-left:auto}.icon-button{width:30px;height:30px;border:0;border-radius:8px;background:transparent;cursor:pointer;font-size:18px;color:#2d2d2d}.icon-button:hover{background:#e6ddd1}.menu{top:34px}.status{margin-top:10px;padding:14px;border-radius:13px}.data-panel{margin-top:10px;padding:12px;border-radius:13px}.note{margin-top:10px}.toast{margin-top:8px}
    </style><style>.data-panel{margin-top:12px;padding:15px;border:1px solid #ded4c7;border-radius:16px;background:#fff}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.eyebrow{font-size:9px;letter-spacing:.12em;color:#a08f80;font-weight:800}.panel-head h2{margin:3px 0 0;font-size:15px}.freshness{padding:4px 8px;border-radius:999px;background:#f1ebe2;color:#806b59;font-size:10px;font-weight:700}.data-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.data-card{display:flex;align-items:center;gap:9px;min-width:0;padding:10px;border:1px solid #eee6dc;border-radius:11px;background:#fbfaf8}.data-icon{width:27px;height:27px;display:grid;place-items:center;border-radius:8px;background:#f4e4cc;color:#684a2e;font-weight:800}.data-icon.violet{background:#ece7f7;color:#5a4b86}.data-card b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}.data-card span{display:block;margin-top:3px;color:#897b6e;font-size:10.5px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.actions button{min-height:34px;border-radius:9px;padding:7px 10px;font:700 11px inherit;cursor:pointer}.primary-action{border:0;background:#251810;color:#fff}.secondary-action{border:1px solid #d9cebf;background:#fff;color:#4b3b30}.data-toast{min-height:16px;margin-top:9px;color:#806b59;font-size:10.5px}.actions button:disabled{opacity:.58;cursor:default}</style></head><body><main class="shell">
      <header class="top"><div class="brand">B</div><div class="heading"><h1>Bhuleshwar Local Agent</h1><p>Secure local connection to Tally Prime</p></div>
        <div class="menu-wrap"><button id="menu-button" class="icon-button" aria-label="Open agent menu" aria-expanded="false">⋯</button>
          <div id="menu" class="menu" role="menu">
            <div class="menu-title">Preferences</div>
            <label class="setting"><span>Parse documents locally</span><input id="anydoc" type="checkbox"></label>
            <label class="setting"><span>Semantic ledger suggestions</span><input id="zvec" type="checkbox"></label>
            <label class="setting"><span>Start with Windows</span><input id="startup" type="checkbox"></label>
            <div class="divider"></div><div class="menu-title">Maintenance</div>
            <button id="updates" class="action" role="menuitem">Check for updates</button><button id="diagnostics" class="action" role="menuitem">Export diagnostics</button><button id="clear" class="action" role="menuitem">Clear rebuildable cache</button>
            <div class="divider"></div><button id="reset" class="action danger" role="menuitem">Factory reset…</button>
          </div>
        </div>
      </header>
      <section id="card" class="status"><div class="status-row"><span class="state-dot"></span><div><div id="title" class="status-title">Starting Local Agent…</div><div id="detail" class="status-detail">Checking the saved Kalika connection.</div></div></div>
        <div class="meta"><span id="version">Agent 1.1.0</span><strong id="metrics">Loading local cache…</strong></div>
      </section>
      <section class="data-panel" aria-label="Tally data status">
        <div class="panel-head"><div><div class="eyebrow">WORKSPACE READINESS</div><h2>Data and matching</h2></div><span id="freshness" class="freshness">Checking…</span></div>
        <div class="data-grid">
          <article class="data-card"><div class="data-icon">▦</div><div><b id="company">Tally company</b><span id="company-state">Waiting for Tally</span></div></article>
          <article class="data-card"><div class="data-icon violet">◇</div><div><b id="ledger-state">Ledger catalogue</b><span id="ledger-detail">Not synced yet</span></div></article>
        </div>
        <div class="actions"><button id="refresh-data" class="primary-action">Refresh Tally data</button><button id="rebuild-index" class="secondary-action">Update matching index</button></div>
        <div id="data-toast" class="data-toast" aria-live="polite"></div>
      </section>
      <section id="update-card" class="update"><span id="update-message"></span><button id="install-update" type="button">Restart &amp; update</button></section>
      <div class="note">Keep this app running while Bhuleshwar uses Tally.</div><div id="toast" class="toast" aria-live="polite"></div>
    </main><script>
      document.body.innerHTML=\`
        <div class="windowShell">
          <header id="titleBar" class="titleBar"><div class="titleBrand"><span class="titleMark">B</span><span>Bhuleshwar Local Agent</span></div><div class="windowControls"><button id="minimizeBtn" class="windowControl">−</button><button id="maximizeBtn" class="windowControl">□</button><button id="closeBtn" class="windowControl close">×</button></div></header>
          <main id="appContent">
            <div class="globalbar"><div class="health"><strong id="homeCompany">Tally not connected</strong><span id="homeConnectionBadge" class="connectionBadge warning"></span></div><div class="moreWrap"><button id="menu-button" class="moreButton">⋮</button><div id="menu" class="menu"><button id="menuLocalMatching">Ledger matching</button><button id="menuCustomerDues">Customer dues</button><button id="updates">Connector updates</button><button id="menuDiagnostics">Send diagnostics to support</button><div class="menuLabel">Advanced</div><button id="menuReset" class="menuDanger">Factory reset…</button></div></div></div>
            <section id="homeView" class="homeView"><div id="homeTask" class="homeTask" hidden><div><b id="homeTaskText">Working…</b><span id="homeTaskPercent">0%</span></div><div class="homeProgress"><i></i></div></div><h1 id="homeTitle">Finish ledger setup</h1><p id="homeCopy">Prepare the company once. The connector keeps both parts up to date after that.</p><div class="homeStatusGrid"><button id="homeLedgerCard" class="homeStatusCard"><div id="homeLedgerIcon" class="homeStatusIcon">▦</div><b>Ledger data</b><span id="homeLedgerState">Not available</span></button><button id="homeVectorCard" class="homeStatusCard"><div id="homeVectorIcon" class="homeStatusIcon">◇</div><b>Smart matching</b><span id="homeVectorState">Not available</span></button><button id="homeDuesCard" class="homeStatusCard duesCard"><div id="homeDuesIcon" class="homeStatusIcon">₹</div><b>Customer dues</b><span id="homeDuesState">Not checked yet</span></button></div><button id="connectionCheckBtn" class="homeAction connectionAction" hidden>Recheck connection</button><button id="homeSetupBtn" class="homeAction">Set up ledger matching</button></section>
          </main>
          <section id="localPanel" class="pagePanel"><div class="stickyHeader"><button id="backBtn" class="backButton">←</button><h1>Ledger matching</h1></div><div class="contextLine"><strong id="matchingCompany">Checking Tally…</strong><span>·</span><span id="matchingLedgerCount" hidden></span></div><section id="ledgerStep" class="step"><div class="stepHeader"><span class="stepNumber">1</span><b>Ledgers</b></div><div class="stepRow"><div><div id="syncState">Ready</div><small id="lastSync">Not updated yet</small></div><button id="refresh-data" class="primary-action">Refresh</button></div></section><section id="vectorStep" class="step"><div class="stepHeader"><span class="stepNumber">2</span><b>Smart matching</b></div><div class="stepRow"><div><div id="vectorState">Waiting for ledgers</div><small id="lastVector">Not prepared yet</small></div><button id="rebuild-index" class="secondary-action">Prepare</button></div></section><div id="matchingReady" class="steadyHero" hidden><div class="steadyIcon">✓</div><div><div><b id="steadyTitle">Ledgers matched</b> <span id="freshnessPill">Up to date</span></div><small id="steadySubtitle">Synced today</small></div></div><div id="data-toast" class="data-toast"></div></section>
          <section id="duesPanel" class="pagePanel"><div class="stickyHeader"><button id="duesBackBtn" class="backButton">←</button><h1>Customer dues</h1></div><p class="updateContext">For Payment Follow-ups and Cash Discounts</p><div class="updateHero"><div id="duesTile" class="updateTile">₹</div><div><p id="duesCompany">Checking Tally…</p><h2 id="duesTitle">Get customer dues ready</h2><p id="duesDetail">Makes Payment Follow-ups and Cash Discounts open instantly. The first check takes a few minutes.</p></div></div><div id="duesProgress" class="updateProgress"><i id="duesProgressBar"></i></div><p id="duesStep" class="duesStep"></p><button id="duesCheckBtn" class="updateAction">Check customer dues</button><p class="duesNote">After the first check, Bhuleshwar follows changes in Tally automatically. Tally stays usable while this runs.</p><button id="duesFullBtn" class="duesFullLink" hidden>Check everything again</button></section><section id="updatesPanel" class="pagePanel"><div class="stickyHeader"><button id="updatesBackBtn" class="backButton">←</button><h1>Connector updates</h1></div><p class="updateContext">Keep the connector secure and reliable</p><div class="updateHero"><div class="updateTile">✓</div><div><p id="updateVersion">Current version</p><h2 id="updateTitle">You're up to date</h2><p id="update-message">Last checked a few minutes ago.</p></div></div><button id="checkUpdatesBtn" class="updateAction">Check for updates</button><section id="update-card" class="update"><button id="install-update">Restart &amp; update</button></section></section>
          <div class="legacyControls" hidden><div id="card"><span id="title"></span><span id="detail"></span></div><span id="version"></span><span id="metrics"></span><span id="company"></span><span id="company-state"></span><span id="ledger-detail"></span><span id="freshness"></span><span id="toast"></span></div>
        </div>\`;
      const visualStyles=document.createElement('style'); visualStyles.textContent=\`
        html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;color:#2d2d2d;font-family:"Segoe UI Variable Text","Segoe UI",sans-serif}
        body{padding:2px}.titleBar{height:40px;border:1px solid rgba(45,45,45,.10);border-bottom:1px solid #ddd2c2;border-radius:16px 16px 0 0;background:#fbf8f3}
        .shell{height:calc(100% - 40px);padding:10px 14px 14px;overflow-y:auto;overflow-x:hidden;border:1px solid rgba(45,45,45,.10);border-top:0;border-radius:0 0 16px 16px;background:#f4f0e9;scrollbar-width:thin}
        .top{display:flex;align-items:center;min-height:38px;gap:8px}.brand{display:none}.heading{min-width:0;flex:1}.heading h1{margin:0;font-size:16.5px;line-height:1.2;font-weight:700;letter-spacing:-.02em}.heading p{margin:3px 0 0;color:#8b8171;font-size:11.5px}
        .menu-wrap{position:relative;margin-left:auto}.icon-button{width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:#2d2d2d;font-size:18px;cursor:pointer}.icon-button:hover{background:#e6ddd1}.menu{display:none;position:absolute;right:0;top:34px;z-index:30;width:220px;padding:6px;border:1px solid #ddd2c2;border-radius:12px;background:#fff;box-shadow:0 16px 36px rgba(45,45,45,.16)}.menu.open{display:block}.menu-title{padding:7px 9px 4px;color:#8b8171;font-size:10px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.setting{display:flex;align-items:center;justify-content:space-between;padding:7px 9px;border-radius:8px;font-size:12px}.setting:hover,.menu .action:hover{background:#fbf8f3}.divider{height:1px;margin:5px;background:#eee8df}.menu button.action{display:block;width:100%;padding:8px 9px;border:0;border-radius:8px;background:transparent;color:#2d2d2d;text-align:left;font-size:12px;cursor:pointer}.menu button.danger{color:#c1543b}
        .status{margin-top:8px;padding:12px 13px;border:1px solid #ddd2c2;border-radius:13px;background:#fff}.status-row{display:flex;align-items:flex-start;gap:10px}.state-dot{width:8px;height:8px;margin-top:5px;border-radius:50%;background:#8b8171;box-shadow:0 0 0 3px #e6ddd1}.status.connected{border-color:#b9dfca;background:linear-gradient(135deg,#fff 45%,#f1faf5)}.status.connected .state-dot{background:#4ca154;box-shadow:0 0 0 3px #e3f0e3}.status.error,.status.expired{border-color:#e5b7aa;background:#fff8f5}.status.error .state-dot,.status.expired .state-dot{background:#c1543b;box-shadow:0 0 0 3px #f0d8d2}.status.running .state-dot{background:#397ca8;box-shadow:0 0 0 3px #e2eff6}.status.warning .state-dot{background:#e3a64a;box-shadow:0 0 0 3px #fbeeda}.status-title{font-size:13px;font-weight:700}.status-detail{margin-top:2px;color:#595147;font-size:11.5px;line-height:1.35}.meta{display:flex;justify-content:space-between;gap:10px;margin-top:9px;padding-top:8px;border-top:1px solid #eee8df;color:#8b8171;font-size:10.5px}.meta strong{color:#595147}
        .data-panel{margin-top:8px!important;padding:11px 12px!important;border-color:#ddd2c2!important;border-radius:13px!important}.panel-head h2{font-size:13.5px!important}.eyebrow{color:#8b8171!important}.data-grid{margin-top:9px!important}.data-card{padding:8px!important;background:#fbf8f3!important}.actions{margin-top:9px!important}.actions button{min-height:30px!important}.primary-action{background:#2d2d2d!important}.freshness{background:#e3f0e3!important;color:#2e6b37!important}.data-toast{margin-top:6px!important;min-height:12px!important}
        .update{display:none;margin-top:9px}.update.show{display:flex}.windowShell{position:absolute;inset:2px;border:1px solid rgba(45,45,45,.1);border-radius:16px;background:#f4f0e9;overflow:hidden}.titleBar{padding:0 8px 0 14px}.titleBrand{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:650}.titleMark{width:22px;height:22px;display:grid;place-items:center;border-radius:7px;background:linear-gradient(150deg,#f1c889,#d99b2b 45%,#4ca154);color:#fff;font-weight:800}.windowControls{display:flex;margin-left:auto;-webkit-app-region:no-drag}.windowControl{width:32px;height:28px;border:0;border-radius:7px;background:transparent;color:#595147}.windowControl:hover{background:#e6ddd1}.windowControl.close:hover{background:#f0d8d2;color:#c1543b}#appContent{height:calc(100% - 40px);overflow:auto;background:#f4f0e9}.globalbar{display:flex;align-items:center;min-height:42px;padding:8px 14px 5px}.health{display:flex;align-items:center;gap:7px;font-size:12.5px}.connectionBadge{width:8px;height:8px;border-radius:50%;background:#4ca154;box-shadow:0 0 0 3px #e3f0e3}.connectionBadge.warning{background:#e3a64a;box-shadow:0 0 0 3px #fbeeda}.connectionBadge.error{background:#c1543b;box-shadow:0 0 0 3px #f0d8d2}.moreWrap{position:relative;margin-left:auto}.moreButton{width:30px;height:30px;border:0;border-radius:8px;background:transparent;font-size:18px}.moreButton:hover{background:#e6ddd1}.menu{top:34px;width:180px}.menu button{display:block;width:100%;padding:8px 9px;border:0;border-radius:8px;background:transparent;text-align:left;font-size:13px}.menu button:hover{background:#fbf8f3}.homeStatusCard b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.duesStep{min-height:16px;margin:8px 0 0;color:#595147;font-size:11.5px}.duesNote{margin:10px 2px 0;color:#8b8171;font-size:11px;line-height:1.45}.duesFullLink{margin:8px 2px 0;padding:0;border:0;background:none;color:#8b8171;font-size:11px;text-decoration:underline;cursor:pointer}.duesFullLink:disabled{opacity:.5;cursor:default}.menuLabel{margin:6px 9px 2px;padding-top:6px;border-top:1px solid #eee8df;color:#8b8171;font-size:10px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.menu button.menuDanger{color:#c1543b}.homeView{padding:3px 14px 16px}.homeView h1{margin:0;font-size:16.5px}.homeView>p{margin:4px 0 13px;color:#8b8171;font-size:12.5px;line-height:1.45}.homeStatusGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px}.homeStatusCard{padding:10px;border:1px solid #ddd2c2;border-radius:11px;background:#fff;text-align:left}.homeStatusIcon{width:28px;height:28px;display:grid;place-items:center;margin-bottom:8px;border-radius:8px;background:#e3f0e3;font-size:16px;font-weight:700}.homeStatusIcon.ready{background:linear-gradient(150deg,#f1c889,#d99b2b 45%,#4ca154);color:#fff}.homeStatusCard b,.homeStatusCard span{display:block}.homeStatusCard b{font-size:12.5px}.homeStatusCard span{margin-top:3px;color:#e3a64a;font-size:11px;font-weight:650}.homeStatusCard span.ready{color:#4ca154}.homeAction{width:100%;min-height:36px;padding:8px 14px;border:0;border-radius:10px;background:#2d2d2d;color:#fff;font-size:13px;font-weight:650}.connectionAction{margin-bottom:9px}.homeTask{margin-bottom:12px;padding:11px;border:1px solid #ddd2c2;border-radius:12px;background:#fbf8f3}.homeProgress{height:5px;margin-top:8px;border-radius:99px;background:#e6ddd1}.pagePanel{display:none;position:absolute;inset:42px 2px 2px;z-index:20;padding:0 14px 16px;overflow:auto;border-radius:0 0 16px 16px;background:#f4f0e9}.pagePanel.open{display:block}.stickyHeader{position:sticky;top:0;display:flex;align-items:center;gap:9px;padding:10px 0 6px;background:#f4f0e9}.stickyHeader h1{margin:0;font-size:16.5px}.backButton{width:30px;height:30px;border:0;border-radius:8px;background:transparent;font-size:17px}.backButton:hover{background:#e6ddd1}.contextLine{display:flex;gap:6px;margin:0 0 8px;padding-left:39px;color:#595147;font-size:12px}.step{margin-bottom:8px;padding:11px 13px;border:1px solid #ddd2c2;border-radius:13px;background:#fff}.stepHeader{display:flex;align-items:center;gap:8px;margin-bottom:7px}.stepNumber{width:21px;height:21px;display:grid;place-items:center;border-radius:7px;background:#eee8e3;font-size:11px;font-weight:750}.stepRow{display:flex;align-items:center;justify-content:space-between;gap:10px;color:#595147;font-size:12px}.stepRow small{color:#8b8171}.primary-action,.secondary-action{min-height:30px;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:650}.primary-action{border:1px solid #2d2d2d;background:#2d2d2d;color:#fff}.secondary-action{border:1px solid #ddd2c2;background:#fff;color:#2d2d2d}.steadyHero,.updateHero{display:flex;align-items:center;gap:12px;padding:13px;border:1px solid #ddd2c2;border-radius:12px;background:#fbf8f3}.steadyIcon,.updateTile{width:42px;height:42px;display:grid;place-items:center;flex:0 0 auto;border-radius:11px;background:linear-gradient(150deg,#f1c889,#d99b2b 45%,#4ca154);color:#fff;font-size:19px}.updateTile.checking,.updateTile.downloading{background:#2d2d2d}.updateTile.failed,.updateTile.unavailable{background:#c1543b}.steadyHero small,.updateHero p{color:#8b8171}.steadyHero span{padding:2px 8px;border-radius:999px;background:#e3f0e3;color:#2e6b37;font-size:10.5px}.updateContext{margin:0 0 11px;padding-left:39px;color:#8b8171;font-size:11.5px}.updateHero p,.updateHero h2{margin:2px 0}.updateHero h2{font-size:14.5px}.updateProgress{display:none;height:5px;margin-top:10px;border-radius:999px;background:#e6ddd1;overflow:hidden}.updateProgress.show{display:block}.updateProgress i{display:block;width:0;height:100%;border-radius:inherit;background:#4ca154;transition:width .2s ease}.updateAction{width:100%;min-height:34px;margin-top:11px;border:0;border-radius:9px;background:#2d2d2d;color:#fff;font-weight:650}.updateAction:disabled{opacity:.58;cursor:wait}.installAction{width:100%;min-height:34px;border:1px solid #2d2d2d;border-radius:9px;background:#fff;color:#2d2d2d;font-weight:650}.data-toast{font-size:11px;color:#7b5b2d}
      \`; document.head.appendChild(visualStyles);
      const matchingStyles=document.createElement('style');matchingStyles.textContent='.homeTask{display:none!important}.pagePanel{inset:82px 2px 2px}.pagePanel .contextLine{display:none}.steadyHero{margin-bottom:10px}.steadyCopy{min-width:0}.steadyHeroHead{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.steadyHeroHead b{font-size:14.5px}.steadyActions{display:flex;align-items:center;gap:9px;margin-bottom:8px}.steadyActions .secondary-action,.steadyActions .primary-action{background:transparent;color:#2d2d2d}.steadyMeta{display:flex;justify-content:space-between;padding:9px 1px 0;border-top:1px solid #ddd2c2;color:#595147;font-size:11.5px}.steadyMeta strong{color:#2d2d2d;font-weight:650}.data-toast{min-height:16px;margin-top:8px}';document.head.appendChild(matchingStyles);
      const titleBar=document.getElementById('titleBar');
      document.getElementById('minimizeBtn').onclick=()=>window.kalikaAgent.minimize(); document.getElementById('maximizeBtn').onclick=()=>window.kalikaAgent.maximize(); document.getElementById('closeBtn').onclick=()=>window.kalikaAgent.close();
      const card=document.getElementById('card'), menu=document.getElementById('menu'), menuButton=document.getElementById('menu-button'), toast=document.getElementById('toast');
      function renderConnection(data={}){document.getElementById('title').textContent=data.title||'Local Agent';document.getElementById('detail').textContent=data.detail||'';card.className='status '+(data.state||'idle');const state=data.state||'idle',company=data.companyName||String(data.title||'').replace(/^Connected to\s+/i,'')||'Tally not connected';document.getElementById('homeCompany').textContent=company;const badge=document.getElementById('homeConnectionBadge');badge.className='connectionBadge '+(state==='connected'?'':state==='error'?'error':'warning');document.getElementById('connectionCheckBtn').hidden=state==='connected';document.getElementById('homeSetupBtn').hidden=state!=='connected'}
      function closeMenu(){menu.classList.remove('open');menuButton.setAttribute('aria-expanded','false')}
      menuButton.onclick=(event)=>{event.stopPropagation();const open=menu.classList.toggle('open');menuButton.setAttribute('aria-expanded',String(open))};
      document.addEventListener('click',(event)=>{if(!menu.contains(event.target)&&event.target!==menuButton)closeMenu()});document.addEventListener('keydown',(event)=>{if(event.key==='Escape')closeMenu()});
      window.kalikaAgent.onStatus(renderConnection);
      const updateCard=document.getElementById('update-card'),updateMessage=document.getElementById('update-message'),installUpdate=document.getElementById('install-update'),updates=document.getElementById('updates');
      document.getElementById('checkUpdatesBtn').insertAdjacentHTML('beforebegin','<div id="updateProgress" class="updateProgress"><i id="updateProgressBar"></i></div>');installUpdate.className='installAction';
      function renderUpdate(data={}){const state=data.state||'idle',percent=Math.max(0,Math.min(100,Number(data.percent||0))),busy=['checking','available','downloading','waiting','installing'].includes(state),canInstall=['ready','waiting','installing'].includes(state),titles={idle:'Updates are automatic',checking:'Checking for updates…',current:"You're up to date",available:'Update found',downloading:'Downloading update…',ready:'Ready to install',waiting:'Finishing Tally work',installing:'Installing update…',failed:'Update check failed',unavailable:'Updates unavailable',installed:'Update installed'};document.getElementById('updateTitle').textContent=titles[state]||'Connector updates';updateMessage.textContent=data.message||'Updates are checked automatically.';document.getElementById('updateVersion').textContent='Current version '+(data.installedVersion||'${app.getVersion()}')+(data.availableVersion?' · Version '+data.availableVersion+' available':'');const tile=document.querySelector('.updateTile');tile.className='updateTile '+state;tile.textContent=state==='checking'||state==='installing'?'↻':state==='downloading'?'↓':state==='failed'||state==='unavailable'?'!':'✓';const progress=document.getElementById('updateProgress');progress.className='updateProgress'+(['downloading','installing'].includes(state)?' show':'');document.getElementById('updateProgressBar').style.width=(state==='installing'?100:percent)+'%';const check=document.getElementById('checkUpdatesBtn');check.disabled=busy;check.style.display=['ready','waiting','installing'].includes(state)?'none':'block';check.textContent=state==='checking'?'Checking…':state==='available'?'Preparing download…':state==='downloading'?'Downloading… '+percent+'%':state==='failed'?'Retry update check':'Check for updates';updateCard.className='update'+(canInstall?' show':'');installUpdate.style.display=canInstall?'block':'none';installUpdate.disabled=state!=='ready';installUpdate.textContent=state==='waiting'?'Waiting for Tally operation…':state==='installing'?'Installing and reopening…':'Restart & update';if(state==='installed')setTimeout(()=>showUpdatesPage(),0)}
      window.kalikaAgent.onUpdateStatus(renderUpdate);installUpdate.onclick=async()=>{installUpdate.disabled=true;renderUpdate({...await window.kalikaAgent.getUpdateStatus(),state:'installing',message:'Preparing the update. Bhuleshwar Local Agent will reopen automatically…'});try{const result=await window.kalikaAgent.installUpdate();if(result?.waiting)renderUpdate({...await window.kalikaAgent.getUpdateStatus(),state:'waiting'})}catch(error){renderUpdate({state:'failed',message:error?.message||'The update could not be installed.'})}};window.kalikaAgent.getUpdateStatus().then(renderUpdate).catch(()=>{});
      async function refreshConnection(){renderConnection(await window.kalikaAgent.getConnectionStatus())}
      async function loadAgent(){await refreshConnection();const [status,connection]=await Promise.all([window.kalikaAgent.getStatus(),window.kalikaAgent.getConnectionStatus()]);const storage=status.storage||{};document.getElementById('version').textContent='Agent '+(status.agentVersion||'Loading…');document.getElementById('metrics').textContent=Math.round((storage.sizeBytes||0)/1024)+' KB · '+(storage.queuedJobs||0)+' queued';const datasets=Array.isArray(status.datasets)?status.datasets:[];const ready=datasets.find((d)=>d.status==='ready'||d.state==='ready');const active=connection?.companyName||connection?.title||'Tally company';document.getElementById('company').textContent=active;document.getElementById('company-state').textContent=connection?.state==='connected'?'Connected':'Waiting for Tally';document.getElementById('ledger-detail').textContent=ready?.ledgerCount?Number(ready.ledgerCount).toLocaleString()+' ledgers synced':(datasets.length?'Syncing catalogue…':'Not synced yet');document.getElementById('freshness').textContent=ready?'Ready':'Needs refresh'}
      async function runAgentAction(button, message){button.disabled=true;button.classList.add('busy');document.getElementById('data-toast').textContent=message;try{await window.kalikaAgent.runOnce();await loadAgent();document.getElementById('data-toast').textContent='Refresh requested. The connector will continue in the background.'}catch(error){document.getElementById('data-toast').textContent=error?.message||'The refresh could not be started.'}finally{button.disabled=false;button.classList.remove('busy')}}
      function showError(error){toast.textContent=error?.message||'The action could not be completed.'}
      async function action(work,success){closeMenu();toast.textContent='Working…';try{await work();toast.textContent=success;await loadAgent()}catch(error){showError(error)}}
      document.getElementById('menuDiagnostics').onclick=()=>action(()=>window.kalikaAgent.exportDiagnostics(),'Diagnostics saved. Send the file to Bhuleshwar support.');document.getElementById('menuReset').onclick=()=>{closeMenu();window.kalikaAgent.factoryReset().catch(showError)};
      const duesPanel=document.getElementById('duesPanel'),localPanel=document.getElementById('localPanel'),updatesPanel=document.getElementById('updatesPanel'),matchingReady=document.getElementById('matchingReady');matchingReady.className='';matchingReady.innerHTML='<div class="steadyHero"><div class="steadyIcon">✓</div><div class="steadyCopy"><div class="steadyHeroHead"><b id="steadyTitle">Ledgers matched</b><span id="freshnessPill">Up to date</span></div><small id="steadySubtitle">Synced today</small></div></div><div class="steadyActions"><button id="steadySyncBtn" class="primary-action" hidden>Sync now</button><button id="steadyCheckBtn" class="secondary-action">Check for changes</button></div><div class="steadyMeta"><span>Smart matching</span><strong id="steadyVectorMeta">— ledgers indexed</strong></div>';function showHome(){localPanel.classList.remove('open');updatesPanel.classList.remove('open');duesPanel.classList.remove('open')}function showDues(){closeMenu();localPanel.classList.remove('open');updatesPanel.classList.remove('open');duesPanel.classList.add('open');refreshVisible().catch(showError)}function showMatching(){closeMenu();updatesPanel.classList.remove('open');duesPanel.classList.remove('open');localPanel.classList.add('open');refreshVisible().catch(showError)}function showUpdatesPage(){closeMenu();localPanel.classList.remove('open');duesPanel.classList.remove('open');updatesPanel.classList.add('open')}
      async function runMatchingAction(button,message,work){button.disabled=true;const original=button.textContent;button.textContent=message;document.getElementById('data-toast').textContent=message;try{const result=await work();await refreshVisible();document.getElementById('data-toast').textContent='Ledger data and smart matching are up to date.';return result}catch(error){document.getElementById('data-toast').textContent=error?.message||'The operation could not be completed.';throw error}finally{button.disabled=false;button.textContent=original}}
      document.getElementById('refresh-data').onclick=()=>runMatchingAction(document.getElementById('refresh-data'),'Updating…',()=>window.kalikaAgent.syncLedgers());document.getElementById('rebuild-index').onclick=()=>runMatchingAction(document.getElementById('rebuild-index'),'Indexing…',()=>window.kalikaAgent.rebuildVectorIndex());document.getElementById('steadyCheckBtn').onclick=()=>runMatchingAction(document.getElementById('steadyCheckBtn'),'Checking…',()=>window.kalikaAgent.syncLedgers());document.getElementById('steadySyncBtn').onclick=()=>runMatchingAction(document.getElementById('steadySyncBtn'),'Syncing…',()=>window.kalikaAgent.syncLedgers());
      document.getElementById('menuLocalMatching').onclick=showMatching;document.getElementById('menuCustomerDues').onclick=showDues;document.getElementById('homeDuesCard').onclick=showDues;document.getElementById('duesBackBtn').onclick=showHome;async function runDuesCheck(full){const quick=!full&&lastDues.status==='ready';duesBusy=true;renderDues(lastDues,{phase:quick?'checking_changes':'checking_company'});try{const result=await window.kalikaAgent.prepareCustomerDues({full});duesBusy=false;renderDues(result,null)}catch(error){duesBusy=false;renderDues({...lastDues,status:quick?lastDues.status:'failed',lastError:error?.message||'The check could not finish.'},null);if(quick)document.getElementById('duesStep').textContent=error?.message||'The check could not finish.'}}document.getElementById('duesCheckBtn').onclick=()=>runDuesCheck(false);document.getElementById('duesFullBtn').onclick=()=>runDuesCheck(true);updates.onclick=showUpdatesPage;document.getElementById('backBtn').onclick=showHome;document.getElementById('updatesBackBtn').onclick=showHome;document.getElementById('homeLedgerCard').onclick=showMatching;document.getElementById('homeVectorCard').onclick=showMatching;document.getElementById('homeSetupBtn').onclick=showMatching;document.getElementById('connectionCheckBtn').onclick=()=>refreshVisible().catch(showError);document.getElementById('checkUpdatesBtn').onclick=async()=>{renderUpdate({...await window.kalikaAgent.getUpdateStatus(),state:'checking',message:'Checking for a newer Bhuleshwar Local Agent…'});try{renderUpdate(await window.kalikaAgent.checkForUpdates())}catch(error){renderUpdate({state:'failed',message:error?.message||'The update check failed. Please try again.'})}};
      async function refreshVisible(){
        const [status,connection]=await Promise.all([window.kalikaAgent.getStatus(),window.kalikaAgent.getConnectionStatus()]);renderConnection(connection);
        const datasets=Array.isArray(status.datasets)?status.datasets:[],companyName=connection?.companyName||String(connection?.title||'').replace(/^Connected to\s+/i,''),dataset=datasets.find((d)=>String(d?.identity?.companyName||'').toLowerCase()===String(companyName||'').toLowerCase())||datasets.find((d)=>d.status==='ready')||datasets[0];
        const metrics=dataset?.metrics||{},ledgerCount=Number(metrics.ledgerCount||0),vectorCount=Number(metrics.vectorCount||0),hasData=ledgerCount>0,indexReady=hasData&&vectorCount>=ledgerCount,active=status.activeJob,progress=active?.progress||{},isWorking=Boolean(active);
        document.getElementById('matchingCompany').textContent=companyName||dataset?.identity?.companyName||'Open a company in Tally';document.getElementById('matchingLedgerCount').textContent=ledgerCount?ledgerCount.toLocaleString():'—';
        const vectorPercent=ledgerCount?Math.min(99,Math.round(vectorCount/ledgerCount*100)):0;document.getElementById('homeLedgerState').textContent=hasData?'Ready':'Not loaded';document.getElementById('homeVectorState').textContent=indexReady?'Ready':hasData?(vectorCount?'Preparing… '+vectorPercent+'%':'Needs preparation'):'Not available';
        document.getElementById('homeLedgerState').className=hasData?'ready':'';document.getElementById('homeVectorState').className=indexReady?'ready':'';document.getElementById('homeLedgerIcon').className='homeStatusIcon'+(hasData?' ready':'');document.getElementById('homeLedgerIcon').textContent=hasData?'✓':'▦';document.getElementById('homeVectorIcon').className='homeStatusIcon'+(indexReady?' ready':'');document.getElementById('homeVectorIcon').textContent=indexReady?'✓':'◇';
        document.getElementById('homeTitle').textContent=indexReady?'Ledger matching is ready':hasData?'Prepare ledger matching':'Finish ledger setup';document.getElementById('homeCopy').textContent=connection?.state!=='connected'?'Open Tally Prime with a company loaded, then click Recheck connection.':indexReady?'Your ledger list and matching index are ready for suggestions.':hasData?'Ledger data is ready. Complete the matching index once.':'Import ledgers from the company currently open in Tally.';document.getElementById('homeSetupBtn').textContent=hasData?'Open ledger status':'Set up ledger matching';document.getElementById('homeSetupBtn').hidden=indexReady||connection?.state!=='connected';
        document.getElementById('syncState').textContent=hasData?'Ledger list updated':'Not synced';document.getElementById('lastSync').textContent=dataset?.last_sync_at?'Updated '+new Date(dataset.last_sync_at).toLocaleString():'Not updated yet';document.getElementById('vectorState').textContent=indexReady?'Ready':hasData?(vectorCount?'Preparing… '+vectorPercent+'%':'Ready to prepare'):'Waiting for ledgers';document.getElementById('lastVector').textContent=metrics.vectorUpdatedAt?'Updated '+new Date(metrics.vectorUpdatedAt).toLocaleString():'Not prepared yet';
        document.getElementById('matchingReady').hidden=!indexReady;document.getElementById('ledgerStep').hidden=indexReady;document.getElementById('vectorStep').hidden=indexReady;document.getElementById('steadyTitle').textContent='Ledger matching is ready';document.getElementById('steadyVectorMeta').textContent='Ready';document.getElementById('steadySyncBtn').hidden=true;document.getElementById('steadyCheckBtn').hidden=false;
        document.getElementById('homeTask').hidden=!isWorking;if(isWorking){const processed=Number(progress.processed||0),total=Number(progress.total||0),percent=total?Math.round(processed/total*100):0;document.getElementById('homeTaskText').textContent=friendlyPhase(progress.phase);document.getElementById('homeTaskPercent').textContent=total?percent+'%':'Working';document.querySelector('#homeTask .homeProgress i').style.width=percent+'%'}document.getElementById('updateVersion').textContent='Current version '+(status.agentVersion||'');if(!duesBusy)renderDues(status.receivables||{});
      }
      function friendlyPhase(phase){const value=String(phase||'').toLowerCase();if(value==='checking_changes')return 'Checking Tally for changes';if(value==='checking_company')return 'Checking the Tally company';if(value==='checking_customer_bills')return 'Checking customer bills';if(value==='checking_invoices_and_receipts')return 'Checking invoices and receipts';if(value==='checking_older_invoices')return 'Checking earlier-year invoices';if(/vector|embed|index/.test(value))return 'Preparing smart matching';if(/ledger|master|catalog/.test(value))return 'Reading ledgers from Tally';if(/voucher|bill/.test(value))return 'Reading vouchers from Tally';if(/document|pars/.test(value))return 'Reading document';return 'Updating Tally data'}
      let duesBusy=false,lastDues={};function sinceText(value){if(!value)return '';const minutes=Math.round((Date.now()-Date.parse(value))/60000);return minutes<1?'just now':minutes<60?minutes+' min ago':new Date(value).toLocaleString()}function renderDues(data={},progress=null){lastDues=data||{};const st=lastDues.status||'loading',loading=st==='loading',busy=duesBusy||st==='preparing',counts=lastDues.counts||{};document.getElementById('duesCompany').textContent=lastDues.companyName?lastDues.companyName+(lastDues.financialYear?' · FY '+lastDues.financialYear:''):'Company open in Tally';document.getElementById('duesTitle').textContent=loading?'Loading customer dues…':busy?'Checking customer dues…':st==='ready'?'Customer dues are ready':st==='failed'?'The check did not finish':st==='no_company'?'Open a company in Tally':'Get customer dues ready';document.getElementById('duesDetail').textContent=loading?'Bhuleshwar Local Agent is starting.':busy?'You can keep working in Tally.':st==='ready'?(Number(counts.customersWithBills||0).toLocaleString()+' parties with open bills · checked '+sinceText(lastDues.checkedAt)):st==='failed'?(lastDues.lastError||'Please try again.'):st==='no_company'?'Open the company in Tally Prime, then come back here.':'Makes Payment Follow-ups and Cash Discounts open instantly. The first check takes a few minutes.';const tile=document.getElementById('duesTile');tile.className='updateTile'+(busy?' downloading':st==='failed'?' failed':'');tile.textContent=busy?'↻':st==='ready'?'✓':st==='failed'?'!':'₹';let percent=0,step='';if(progress){const total=Number(progress.total||0),done=Number(progress.processed||0);percent=Number.isFinite(progress.overall)?progress.overall:total?Math.round(done/total*100):5;step=(progress.waitingForMemory?'Waiting for free memory · ':'')+friendlyPhase(progress.phase)+(progress.phase==='checking_customer_bills'&&total?' · '+done.toLocaleString()+' of '+total.toLocaleString():'')+(progress.month?' · '+progress.month:'')}document.getElementById('duesProgress').className='updateProgress'+(busy?' show':'');document.getElementById('duesProgressBar').style.width=(busy?Math.max(5,percent):0)+'%';document.getElementById('duesStep').textContent=busy?step:'';const button=document.getElementById('duesCheckBtn');button.disabled=loading||busy||st==='no_company';button.textContent=busy?'Checking…':st==='ready'?'Check for changes':'Check customer dues';const fullLink=document.getElementById('duesFullBtn');fullLink.hidden=st!=='ready';fullLink.disabled=busy;const home=document.getElementById('homeDuesState');home.textContent=loading?'Loading…':busy?('Checking… '+(percent?percent+'%':'')):st==='ready'?'Ready':st==='failed'?'Needs another check':'Not checked yet';home.className=st==='ready'&&!busy?'ready':'';document.getElementById('homeDuesIcon').className='homeStatusIcon'+(st==='ready'&&!busy?' ready':'');document.getElementById('homeDuesIcon').textContent=st==='ready'&&!busy?'✓':'₹'}window.kalikaAgent.onProgress((progress={})=>{if(progress.operation==='receivables'){if(progress.phase==='complete'||progress.phase==='failed'){duesBusy=false;refreshVisible().catch(()=>{});return}duesBusy=true;renderDues({...lastDues,status:'preparing'},progress);return}const processed=Number(progress.processed||0),total=Number(progress.total||0),percent=total?Math.round(processed/total*100):0,label=friendlyPhase(progress.phase);document.getElementById('homeTask').hidden=false;document.getElementById('homeTaskText').textContent=label;document.getElementById('homeTaskPercent').textContent=total?percent+'%':'Working';document.querySelector('#homeTask .homeProgress i').style.width=(total?percent:8)+'%';document.getElementById('data-toast').textContent=total?label+' · '+percent+'%':label});
      // Poll only while the window is actually visible; the page is destroyed
      // when the window is closed, so a hidden agent does no UI work at all.
      refreshConnection().catch(showError);setInterval(()=>{if(!document.hidden)refreshVisible().catch(()=>{})},5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshVisible().catch(()=>{})});loadAgent().then(refreshVisible).catch(showError);
    </script></body></html>
  `)}`;

  let rendererRecoveryAttempts = 0;
  mainWindow.once("ready-to-show", () => showWindow());
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    appendLog(errPath, `Local Agent status page failed to load (${code}: ${description}).`);
    showWindow();
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appendLog(errPath, `Local Agent renderer stopped (${details.reason || "unknown"}).`);
    if (mainWindow?.isDestroyed() || rendererRecoveryAttempts >= 3) return;
    rendererRecoveryAttempts += 1;
    setTimeout(() => {
      if (!mainWindow?.isDestroyed()) {
        void mainWindow.loadURL(connectorPage).catch((error) => {
          appendLog(errPath, `Local Agent status page recovery failed: ${formatConnectorError(error)}`);
          showWindow();
        });
      }
    }, 250);
  });
  mainWindow.webContents.on("did-finish-load", () => {
    rendererRecoveryAttempts = 0;
    sendStatus(lastStatus);
    sendUpdateStatus(updateState);
  });
  void mainWindow.loadURL(connectorPage).catch((error) => {
    appendLog(errPath, `Local Agent status page could not be opened: ${formatConnectorError(error)}`);
    showWindow();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function startApplication() {
  app.setName(CONNECTOR_NAME);
  app.setAppUserModelId(APP_USER_MODEL_ID);

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock || process.argv.includes(QUIT_LAUNCH_ARG)) {
    // --quit with no running copy: nothing to close, and never start the agent.
    app.quit();
    return;
  }
  app.setAsDefaultProtocolClient(PROTOCOL_NAME);
  app.setAsDefaultProtocolClient("kalika-tally");
  // Login-item registration follows the saved "Start with Windows" preference
  // once the runner has loaded settings (see applyStartWithWindowsSetting).
  ipcMain.handle("agent:get-connection-status", () => lastStatus);
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("agent:get-status", async () => {
    const status = await runner?.getAgentStatus?.() ?? { connected: false };
    return { ...status, agentVersion: status.agentVersion || app.getVersion(), connectionStatus: lastStatus };
  });
  ipcMain.handle("agent:run-once", async () => {
    if (!runner?.runOnce) return { ran: false, reason: "agent_not_started" };
    await runner.runOnce();
    return { ran: true };
  });
  ipcMain.handle("agent:sync-ledgers", async (_event, options = {}) => {
    if (!runner?.syncAgentDataset) throw new Error("The Local Agent is not ready yet.");
    return runner.syncAgentDataset({ forceReconcile: options?.forceReconcile === true });
  });
  ipcMain.handle("agent:rebuild-vector-index", async () => {
    if (!runner?.rebuildAgentVectorIndex) throw new Error("The Local Agent is not ready yet.");
    return runner.rebuildAgentVectorIndex();
  });
  ipcMain.handle("agent:prepare-customer-dues", async (_event, options = {}) => {
    if (!runner?.prepareCustomerDues) throw new Error("The Local Agent is not ready yet.");
    return runner.prepareCustomerDues({ full: options?.full === true });
  });
  ipcMain.handle("agent:get-settings", () => runner?.getAgentSettings?.() ?? {});
  ipcMain.handle("agent:update-settings", async (_event, settings) => {
    const next = await runner?.updateAgentSettings?.(settings && typeof settings === "object" ? settings : {});
    if (typeof settings?.startWithWindows === "boolean") app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, openAsHidden: true });
    return next || {};
  });
  ipcMain.handle("agent:clear-cache", () => runner?.clearAgentCache?.() ?? { cleared: false });
  ipcMain.handle("agent:check-updates", async () => {
    if (!app.isPackaged) {
      sendUpdateStatus({ state: "unavailable", message: "Updates are disabled in development builds." });
      return updateState;
    }
    return checkForUpdatesNow();
  });
  ipcMain.handle("agent:get-update-status", () => updateState);
  ipcMain.handle("agent:install-update", () => {
    if (updateState.state !== "ready" && updateState.state !== "waiting") {
      throw new Error("The update has not finished downloading yet.");
    }
    return installDownloadedUpdateWhenSafe();
  });
  ipcMain.handle("agent:export-diagnostics", async () => {
    const diagnostics = await runner?.exportAgentDiagnostics?.() || [];
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export sanitized Local Agent diagnostics",
      defaultPath: `bhuleshwar-local-agent-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    fs.writeFileSync(result.filePath, JSON.stringify({ exportedAt: new Date().toISOString(), diagnostics }, null, 2), { mode: 0o600 });
    return { saved: true, path: result.filePath };
  });
  ipcMain.handle("agent:factory-reset", async () => {
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "warning", buttons: ["Cancel", "Factory reset"], defaultId: 0, cancelId: 0,
      title: "Factory reset Bhuleshwar Local Agent",
      message: "Remove pairing, cache, managed attachments and local secrets?",
      detail: "This cannot be undone. Tally vouchers are not deleted.",
    });
    if (answer.response !== 1) return { reset: false };
    const localBase = path.resolve(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"));
    const target = path.resolve(localBase, "Bhuleshwar", "LocalAgent");
    if (!target.startsWith(`${localBase}${path.sep}`) || path.basename(target) !== "LocalAgent") throw new Error("Factory reset target validation failed.");
    // The storage and vector workers hold file locks on Windows; wait for
    // them to exit before deleting their files.
    await runner?.stop("factory reset");
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    safeQuitApproved = true;
    app.relaunch();
    app.quit();
    return { reset: true };
  });
  app.on("second-instance", (_event, argv) => {
    if (argv.includes(QUIT_LAUNCH_ARG)) {
      app.quit();
      return;
    }
    const protocolArg = argv.find(isConnectorUrl);
    if (protocolArg) {
      handleProtocolUrl(protocolArg);
    }
    showWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (app.isReady()) handleProtocolUrl(url);
    else pendingProtocolUrl = url;
  });
  app.whenReady().then(() => {
    // Windows login starts the agent with --hidden: run in the tray only and
    // create the status window when the user opens it.
    if (!process.argv.includes(HIDDEN_LAUNCH_ARG)) createWindow();
    // Runs before the agent starts so nothing is using tmp\ yet.
    cleanUpObsoleteLocalStorage();
    const completedUpdate = consumeSuccessfulUpdate(localAgentRoot, app.getVersion());
    if (completedUpdate) {
      updatedOnThisLaunch = true;
      sendUpdateStatus({ state: "installed", percent: 100, availableVersion: app.getVersion(), message: completedUpdate.message });
    }
    const protocolArg = process.argv.find(isConnectorUrl) || pendingProtocolUrl;
    if (protocolArg) {
      handleProtocolUrl(protocolArg);
    } else {
      startRunner().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        appendLog(errPath, message);
        sendStatus({ title: "Waiting for connection", detail: "Open Bhuleshwar and click Connect.", state: "idle" });
      });
    }
    if (app.isPackaged) {
      // `electron-builder --dir` does not always emit app-update.yml. Keep the
      // unpacked QA build update-capable while installed builds continue to
      // use their generated publish configuration.
      configureUpdateFeed();
      runner?.getAgentSettings?.().then((settings) => {
        autoUpdater.channel = settings?.updateChannel === "beta" ? "beta" : "latest";
      }).catch((error) => appendLog(errPath, error.message));
      // Check metadata first. Starting an automatic download before comparing
      // versions allowed an older cached GitHub release to appear as an update
      // after a newer installer had been installed manually.
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on("checking-for-update", () => sendUpdateStatus({ state: "checking", message: "Checking for a newer Local Agent…" }));
      autoUpdater.on("update-available", (info) => {
        if (!isNewerVersion(info.version, app.getVersion())) {
          acceptedUpdateVersion = null;
          void autoUpdater.downloadedUpdateHelper?.clear?.().catch((error) => appendLog(errPath, `Stale updater cache: ${error.message}`));
          sendUpdateStatus({ state: "current", availableVersion: null, percent: 0, message: "Local Agent is up to date." });
          return;
        }
        acceptedUpdateVersion = info.version;
        sendUpdateStatus({ state: "available", availableVersion: info.version, message: `Version ${info.version} is available. Downloading automatically…` });
        void autoUpdater.downloadUpdate().catch((error) => {
          acceptedUpdateVersion = null;
          appendLog(errPath, `Updater download: ${error.message}`);
          sendUpdateStatus({ state: "failed", message: "The update download failed. You can retry from the menu." });
        });
      });
      autoUpdater.on("update-not-available", () => {
        acceptedUpdateVersion = null;
        void autoUpdater.downloadedUpdateHelper?.clear?.().catch((error) => appendLog(errPath, `Stale updater cache: ${error.message}`));
        sendUpdateStatus({ state: "current", availableVersion: null, percent: 0, message: "Local Agent is up to date." });
      });
      autoUpdater.on("download-progress", (progress) => {
        if (!acceptedUpdateVersion) return;
        sendUpdateStatus({ state: "downloading", percent: Math.round(progress.percent || 0), message: `Downloading update… ${Math.round(progress.percent || 0)}%` });
      });
      autoUpdater.on("update-downloaded", (info) => {
        if (!isNewerVersion(info.version, app.getVersion()) || (acceptedUpdateVersion && acceptedUpdateVersion !== info.version)) {
          acceptedUpdateVersion = null;
          void autoUpdater.downloadedUpdateHelper?.clear?.().catch((error) => appendLog(errPath, `Stale updater cache: ${error.message}`));
          sendUpdateStatus({ state: "current", availableVersion: null, percent: 0, message: "Local Agent is up to date." });
          return;
        }
        try {
          recordDownloadedUpdate(localAgentRoot, { fromVersion: app.getVersion(), toVersion: info.version });
        } catch (error) {
          appendLog(errPath, `Updater marker: ${error instanceof Error ? error.message : error}`);
        }
        sendUpdateStatus({ state: "ready", availableVersion: info.version, percent: 100, message: `Version ${info.version} is ready to install.` });
      });
      autoUpdater.on("error", (error) => reportUpdateError(error));
      // Check shortly after launch and then periodically. Downloads start
      // automatically, but installing still waits for the user (or a safe
      // boundary) so a Tally write is never interrupted.
      setTimeout(() => void checkForUpdatesNow().catch(() => {}), UPDATE_CHECK_DELAY_MS).unref();
      setInterval(() => void checkForUpdatesNow().catch(() => {}), UPDATE_CHECK_INTERVAL_MS).unref();
    }
    createTray();
  });
  app.on("window-all-closed", (event) => {
    event.preventDefault();
  });
  let quitPrepared = false;
  let quitInProgress = false;
  app.on("before-quit", (event) => {
    if (quitPrepared || !runner || runner.stopped) return;
    event.preventDefault();
    if (quitInProgress) return;
    quitInProgress = true;
    if (runner.busy && !safeQuitApproved) {
      sendStatus({ title: "Finishing Tally work", detail: "The agent will close after the active financial operation reaches a safe boundary.", state: "running" });
    }
    const waitForSafeExit = setInterval(async () => {
      if (runner?.busy && !safeQuitApproved) return;
      clearInterval(waitForSafeExit);
      // Close the local database cleanly so a quit, restart or installer
      // upgrade never cuts off a write.
      await Promise.race([
        Promise.resolve(runner?.stop("quit")).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      quitPrepared = true;
      app.quit();
    }, 250);
  });
}

if (process.env.KALIKA_BENCHMARK_PDF) {
  app.whenReady().then(async () => {
    try {
      await import("../../../apps/tally-bridge/src/agent/benchmark-pdf-suggestions.mjs");
    } catch (error) {
      const benchmarkErrorPath = path.resolve(process.cwd(), "output", "kalika-pdf-ledger-benchmark-error.log");
      fs.mkdirSync(path.dirname(benchmarkErrorPath), { recursive: true });
      fs.writeFileSync(benchmarkErrorPath, `${error?.stack || error}\n`);
      app.quit();
    }
  });
} else if (relaunchWithWindowsCertificateStore()) {
  app.exit(0);
} else {
  startApplication();
}

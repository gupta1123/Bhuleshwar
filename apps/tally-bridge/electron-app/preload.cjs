const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kalikaAgent", Object.freeze({
  onStatus(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("agent:status", listener);
    return () => ipcRenderer.removeListener("agent:status", listener);
  },
  onUpdateStatus(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("agent:update-status", listener);
    return () => ipcRenderer.removeListener("agent:update-status", listener);
  },
  onProgress(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("agent:progress", listener);
    return () => ipcRenderer.removeListener("agent:progress", listener);
  },
  getConnectionStatus: () => ipcRenderer.invoke("agent:get-connection-status"),
  getStatus: () => ipcRenderer.invoke("agent:get-status"),
  runOnce: () => ipcRenderer.invoke("agent:run-once"),
  syncLedgers: (options) => ipcRenderer.invoke("agent:sync-ledgers", options),
  rebuildVectorIndex: () => ipcRenderer.invoke("agent:rebuild-vector-index"),
  prepareCustomerDues: (options) => ipcRenderer.invoke("agent:prepare-customer-dues", options),
  getSettings: () => ipcRenderer.invoke("agent:get-settings"),
  updateSettings: (settings) => ipcRenderer.invoke("agent:update-settings", settings),
  clearCache: () => ipcRenderer.invoke("agent:clear-cache"),
  checkForUpdates: () => ipcRenderer.invoke("agent:check-updates"),
  getUpdateStatus: () => ipcRenderer.invoke("agent:get-update-status"),
  installUpdate: () => ipcRenderer.invoke("agent:install-update"),
  exportDiagnostics: () => ipcRenderer.invoke("agent:export-diagnostics"),
  factoryReset: () => ipcRenderer.invoke("agent:factory-reset"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
}));

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { LOCAL_SCHEMA_VERSION } from "./protocol.mjs";

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "storage-worker.mjs");

export function localAgentPaths(baseDirectory) {
  const root = path.resolve(baseDirectory);
  return {
    root,
    database: path.join(root, "data", "agent.db"),
    attachments: path.join(root, "attachments"),
    vectors: path.join(root, "vectors"),
    diagnostics: path.join(root, "diagnostics"),
    temporary: path.join(root, "tmp"),
  };
}

export function windowsAclHardeningCommands(root, userSid) {
  if (!/^S-1-(?:\d+-)+\d+$/i.test(String(userSid ?? "").trim())) {
    throw new Error("Unable to resolve the current Windows user SID.");
  }
  return [
    [root, "/inheritance:e", "/T", "/C"],
    [root, "/grant:r", `*${userSid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"],
    [root, "/inheritance:r"],
  ];
}

function currentWindowsUserSid() {
  const output = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 5_000,
  });
  return output.match(/S-1-(?:\d+-)+\d+/i)?.[0] || "";
}

export function prepareLocalAgentDirectoryAcl(baseDirectory) {
  const root = path.resolve(baseDirectory);
  const expectedAgentRoot = path.resolve(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
    "Kalika", "LocalAgent"
  );
  if (process.platform !== "win32" || root !== expectedAgentRoot) return;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    // Repair inheritance recursively before tightening the root. This recovers
    // files damaged by the original 1.0.0 ACL command without replacing data.
    // The verified user/SYSTEM grants are then inherited by all descendants.
    for (const command of windowsAclHardeningCommands(root, currentWindowsUserSid())) {
      execFileSync("icacls.exe", command, {
        windowsHide: true, stdio: "ignore", timeout: 15_000,
      });
    }
  } catch {
    // DPAPI and database encryption remain mandatory protections when a
    // managed Windows policy prevents ACL updates. Access is never removed
    // before repair and trustee grant operations have succeeded.
  }
}

export class LocalAgentStorage {
  #worker;
  #pending = new Map();
  #closed = false;

  constructor({ baseDirectory, keyHex, schemaVersion = LOCAL_SCHEMA_VERSION }) {
    this.paths = localAgentPaths(baseDirectory);
    for (const directory of [this.paths.root, path.dirname(this.paths.database), this.paths.attachments, this.paths.vectors, this.paths.diagnostics, this.paths.temporary]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    prepareLocalAgentDirectoryAcl(this.paths.root);
    this.#worker = new Worker(WORKER_PATH, {
      workerData: { databasePath: this.paths.database, keyHex, schemaVersion },
    });
    this.#worker.on("message", ({ id, result, error }) => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      if (error) {
        const failure = new Error(error.message);
        failure.code = error.code;
        pending.reject(failure);
      } else pending.resolve(result);
    });
    this.#worker.on("error", (error) => this.#rejectAll(error));
    this.#worker.on("exit", (code) => {
      if (!this.#closed && code !== 0) this.#rejectAll(new Error(`Local Agent storage worker exited with code ${code}.`));
    });
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  call(operation, payload = {}) {
    if (this.#closed) return Promise.reject(new Error("Local Agent storage is closed."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, operation, payload });
    });
  }

  async close() {
    if (this.#closed) return;
    await this.call("close").catch(() => {});
    this.#closed = true;
    await this.#worker.terminate();
  }
}

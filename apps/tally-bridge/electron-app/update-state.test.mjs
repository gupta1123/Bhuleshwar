import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareVersions, consumeSuccessfulUpdate, isNewerVersion, recordDownloadedUpdate } from "./update-state.mjs";

test("version comparison rejects stale downloaded installers", () => {
  assert.equal(compareVersions("1.1.2", "1.1.1"), 1);
  assert.equal(compareVersions("1.1.1", "1.1.2"), -1);
  assert.equal(compareVersions("1.1.2", "1.1.2"), 0);
  assert.equal(isNewerVersion("1.1.1", "1.1.2"), false);
  assert.equal(isNewerVersion("1.1.3", "1.1.2"), true);
});

test("download marker survives the old process and reports success only after the new version starts", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-updater-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  recordDownloadedUpdate(directory, { fromVersion: "1.0.0", toVersion: "1.1.0" });
  assert.equal(consumeSuccessfulUpdate(directory, "1.0.0"), null);
  assert.deepEqual(consumeSuccessfulUpdate(directory, "1.1.0"), {
    fromVersion: "1.0.0",
    installedVersion: "1.1.0",
    message: "Updated successfully to version 1.1.0.",
  });
  assert.equal(consumeSuccessfulUpdate(directory, "1.1.0"), null);
});

test("an obsolete downloaded marker is removed after a newer manual install", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-stale-updater-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  recordDownloadedUpdate(directory, { fromVersion: "1.1.0", toVersion: "1.1.1" });
  assert.equal(consumeSuccessfulUpdate(directory, "1.1.2"), null);
  assert.equal(fs.existsSync(path.join(directory, "config", "pending-update.json")), false);
});

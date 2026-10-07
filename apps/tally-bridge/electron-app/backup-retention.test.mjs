import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneLegacyRuntimeBackups } from "./backup-retention.mjs";

test("runtime backup retention keeps the newest verified rollback and leaves manual backups alone", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kalika-runtime-backups-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const timestamp of [100, 200, 300]) {
    const directory = path.join(root, `legacy-runtime-${timestamp}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "runtime.txt"), String(timestamp));
    fs.utimesSync(directory, timestamp, timestamp);
  }
  fs.mkdirSync(path.join(root, "manual-backup-250"));

  const result = pruneLegacyRuntimeBackups(root, 1);
  assert.deepEqual(result.retained, ["legacy-runtime-300"]);
  assert.deepEqual(result.removed, ["legacy-runtime-200", "legacy-runtime-100"]);
  assert.equal(fs.existsSync(path.join(root, "legacy-runtime-300")), true);
  assert.equal(fs.existsSync(path.join(root, "manual-backup-250")), true);
});

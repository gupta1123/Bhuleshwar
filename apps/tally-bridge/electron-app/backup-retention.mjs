import fs from "node:fs";
import path from "node:path";

export function pruneLegacyRuntimeBackups(backupRoot, keep = 1) {
  if (!fs.existsSync(backupRoot)) return { retained: [], removed: [] };
  const candidates = fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^legacy-runtime-\d+$/.test(entry.name))
    .map((entry) => {
      const entryPath = path.join(backupRoot, entry.name);
      return { path: entryPath, name: entry.name, modifiedAt: fs.statSync(entryPath).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const retained = candidates.slice(0, Math.max(0, keep));
  const removed = candidates.slice(Math.max(0, keep));
  for (const entry of removed) fs.rmSync(entry.path, { recursive: true, force: true });
  return { retained: retained.map((entry) => entry.name), removed: removed.map((entry) => entry.name) };
}

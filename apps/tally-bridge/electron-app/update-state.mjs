import fs from "node:fs";
import path from "node:path";

function markerPath(localAgentRoot) {
  return path.join(localAgentRoot, "config", "pending-update.json");
}

function parseVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return match ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || null } : null;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

export function isNewerVersion(candidate, installed) {
  return compareVersions(candidate, installed) === 1;
}

export function recordDownloadedUpdate(localAgentRoot, { fromVersion, toVersion }) {
  const target = markerPath(localAgentRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({
    fromVersion: String(fromVersion || ""),
    toVersion: String(toVersion || ""),
    downloadedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function consumeSuccessfulUpdate(localAgentRoot, currentVersion) {
  const target = markerPath(localAgentRoot);
  if (!fs.existsSync(target)) return null;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    fs.rmSync(target, { force: true });
    return null;
  }
  const installedVersion = String(currentVersion || "");
  const comparison = compareVersions(marker?.toVersion, installedVersion);
  if (comparison !== null && comparison < 0) {
    fs.rmSync(target, { force: true });
    return null;
  }
  if (!marker?.toVersion || marker.toVersion !== installedVersion || marker.fromVersion === installedVersion) {
    return null;
  }
  fs.rmSync(target, { force: true });
  return {
    fromVersion: String(marker.fromVersion || ""),
    installedVersion,
    message: `Updated successfully to version ${installedVersion}.`,
  };
}

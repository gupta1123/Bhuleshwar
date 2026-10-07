const DEFAULT_LATEST_AGENT_VERSION = "1.1.1";
const DEFAULT_MINIMUM_AGENT_VERSION = "1.0.0";
const DEFAULT_RELEASE_REPOSITORY = "https://github.com/gupta1123/autodealer-workflow";

function semverParts(value: string | null | undefined) {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function compareAgentVersions(left: string | null | undefined, right: string | null | undefined) {
  const a = semverParts(left);
  const b = semverParts(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function localAgentUpdateInfo(installedVersion: string | null | undefined) {
  const latestVersion = process.env.KALIKA_LOCAL_AGENT_LATEST_VERSION || DEFAULT_LATEST_AGENT_VERSION;
  const minimumVersion = process.env.KALIKA_LOCAL_AGENT_MIN_VERSION || DEFAULT_MINIMUM_AGENT_VERSION;
  const repository = (process.env.KALIKA_LOCAL_AGENT_RELEASE_REPOSITORY || DEFAULT_RELEASE_REPOSITORY).replace(/\/$/, "");
  const downloadUrl = process.env.KALIKA_LOCAL_AGENT_DOWNLOAD_URL ||
    `${repository}/releases/download/v${latestVersion}/KalikaLocalAgent-${latestVersion}-x64.exe`;
  return {
    installedVersion: installedVersion || null,
    latestVersion,
    minimumVersion,
    updateAvailable: compareAgentVersions(installedVersion, latestVersion) < 0,
    updateRequired: compareAgentVersions(installedVersion, minimumVersion) < 0,
    downloadUrl,
    releaseUrl: `${repository}/releases/tag/v${latestVersion}`,
  };
}

import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOG_PATH = path.resolve(process.cwd(), "packet-upload-ai.log");
const CASE_ID_PATTERN = /\bcase=([0-9a-f-]{36})\b/i;

let activeLogCaseId = "";

function getLogPaths() {
  const explicit = process.env.PACKET_UPLOAD_AI_LOG_FILE;
  const candidates = [
    explicit,
    DEFAULT_LOG_PATH,
    path.resolve(process.cwd(), "apps/api/packet-upload-ai.log"),
    path.resolve(process.cwd(), "../..", "packet-upload-ai.log"),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)].filter((filePath) => fs.existsSync(path.dirname(filePath)));
}

export function appendPacketUploadAiLog(message: string) {
  const timestamp = new Date().toISOString();
  const caseId = CASE_ID_PATTERN.exec(message)?.[1];
  const separator =
    caseId && caseId !== activeLogCaseId
      ? [
          "",
          `[${timestamp}] ==================== CASE ${caseId} ====================`,
        ]
      : [];

  if (caseId) {
    activeLogCaseId = caseId;
  }

  const line = `[${timestamp}] ${message}`;
  const output = [...separator, line].join("\n");
  console.warn(output);

  for (const filePath of getLogPaths()) {
    try {
      fs.appendFileSync(filePath, `${output}\n`, "utf8");
    } catch {
      // Try the next likely location.
    }
  }
}

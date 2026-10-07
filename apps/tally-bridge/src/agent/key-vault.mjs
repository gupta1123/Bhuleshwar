import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const KEY_BYTES = 32;

function atomicWrite(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function powershellProtectedData(mode, bytes) {
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const loadProtectedData = "Add-Type -AssemblyName System.Security;";
  const script = mode === "protect"
    ? `${loadProtectedData}$v=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($v);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))`
    : `${loadProtectedData}$v=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($v);$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))`;
  const result = execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: Buffer.from(bytes).toString("base64"),
    windowsHide: true,
    encoding: "utf8",
    timeout: 10_000,
  });
  return Buffer.from(result.trim(), "base64");
}

export function resolveLocalAgentKey({ baseDirectory, safeStorage = null }) {
  const keyPath = path.join(baseDirectory, "security", "database-key.dpapi");
  if (fs.existsSync(keyPath)) {
    const encrypted = fs.readFileSync(keyPath);
    const decrypted = safeStorage?.isEncryptionAvailable?.()
      ? Buffer.from(safeStorage.decryptString(encrypted), "hex")
      : powershellProtectedData("unprotect", encrypted);
    if (decrypted.length !== KEY_BYTES) throw new Error("The Local Agent database key could not be recovered.");
    return decrypted.toString("hex");
  }

  const key = randomBytes(KEY_BYTES);
  const encrypted = safeStorage?.isEncryptionAvailable?.()
    ? safeStorage.encryptString(key.toString("hex"))
    : powershellProtectedData("protect", key);
  atomicWrite(keyPath, encrypted);
  return key.toString("hex");
}


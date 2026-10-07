import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PdfSecurityErrorCode =
  | "BANK_STATEMENT_PASSWORD_REQUIRED"
  | "BANK_STATEMENT_PASSWORD_INCORRECT"
  | "BANK_STATEMENT_PASSWORD_UNSUPPORTED"
  | "BANK_STATEMENT_PDF_INVALID"
  | "BANK_STATEMENT_PDF_SERVICE_UNAVAILABLE";

export class PdfSecurityError extends Error {
  code: PdfSecurityErrorCode;

  constructor(code: PdfSecurityErrorCode, message: string) {
    super(message);
    this.name = "PdfSecurityError";
    this.code = code;
  }
}

type PdfProbeResult = {
  ok?: boolean;
  code?:
    | "password_required"
    | "incorrect_password"
    | "encryption_unsupported"
    | "invalid_pdf"
    | "service_unavailable";
  encrypted?: boolean;
  decrypted?: boolean;
};

type PythonCandidate = {
  command: string;
  prefixArgs: string[];
};

const PDF_PROBE_SCRIPT = String.raw`
import json
import sys
from pathlib import Path

def finish(payload):
    print(json.dumps(payload))
    sys.exit(0)

try:
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        from PyPDF2 import PdfReader, PdfWriter
except Exception:
    finish({"ok": False, "code": "service_unavailable"})

input_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
password = sys.stdin.read()

try:
    reader = PdfReader(str(input_path), strict=False)
except Exception:
    finish({"ok": False, "code": "invalid_pdf"})

try:
    encrypted = bool(reader.is_encrypted)
except Exception:
    finish({"ok": False, "code": "invalid_pdf"})

if encrypted:
    try:
        decrypt_result = reader.decrypt(password)
    except Exception as error:
        error_name = type(error).__name__.lower()
        if "dependency" in error_name or "notimplemented" in error_name:
            finish({"ok": False, "code": "encryption_unsupported"})
        finish({"ok": False, "code": "invalid_pdf"})

    if not decrypt_result:
        finish({
            "ok": False,
            "code": "incorrect_password" if password else "password_required"
        })

try:
    if len(reader.pages) < 1:
        finish({"ok": False, "code": "invalid_pdf"})

    # Encrypted PDFs are rewritten without encryption before downstream analysis.
    if encrypted:
        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)
        with output_path.open("wb") as output_file:
            writer.write(output_file)
except Exception as error:
    error_name = type(error).__name__.lower()
    if encrypted and ("dependency" in error_name or "notimplemented" in error_name):
        finish({"ok": False, "code": "encryption_unsupported"})
    finish({"ok": False, "code": "invalid_pdf"})

finish({"ok": True, "encrypted": encrypted, "decrypted": encrypted})
`;

function execFileWithInput(command: string, args: string[], input: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8", timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

function getPythonCandidates(): PythonCandidate[] {
  const configured = process.env.KALIKA_PDF_PYTHON_BIN?.trim();
  const candidates: PythonCandidate[] = [];
  if (configured) candidates.push({ command: configured, prefixArgs: [] });

  if (process.platform === "win32") {
    candidates.push(
      { command: "python", prefixArgs: [] },
      { command: "py", prefixArgs: ["-3"] },
      { command: "python3", prefixArgs: [] }
    );
  } else {
    candidates.push(
      { command: "python3", prefixArgs: [] },
      { command: "python", prefixArgs: [] }
    );
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\u0000${candidate.prefixArgs.join("\u0000")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseProbeResult(stdout: string): PdfProbeResult | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]) as PdfProbeResult;
    } catch {
      // Ignore launcher noise and continue looking for the structured result.
    }
  }
  return null;
}

async function runPdfProbe(inputPath: string, outputPath: string, password: string) {
  let missingDependencyResult: PdfProbeResult | null = null;

  for (const candidate of getPythonCandidates()) {
    try {
      const { stdout } = await execFileWithInput(
        candidate.command,
        [...candidate.prefixArgs, "-c", PDF_PROBE_SCRIPT, inputPath, outputPath],
        password
      );
      const result = parseProbeResult(stdout);
      if (!result) continue;
      if (result.code === "service_unavailable") {
        missingDependencyResult = result;
        continue;
      }
      return result;
    } catch {
      // Try the next platform-appropriate interpreter. Tool failures are never
      // interpreted as evidence that the document is password protected.
    }
  }

  return missingDependencyResult ?? { ok: false, code: "service_unavailable" as const };
}

function hasPdfHeader(bytes: Uint8Array) {
  if (bytes.byteLength < 5) return false;
  const headerWindow = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 1024)));
  return headerWindow.indexOf(Buffer.from("%PDF-", "ascii")) >= 0;
}

export async function unlockPdfIfNeeded(bytes: Uint8Array, password: string) {
  if (!hasPdfHeader(bytes)) {
    throw new PdfSecurityError(
      "BANK_STATEMENT_PDF_INVALID",
      "This file is not a valid PDF. Download the statement again and upload the original PDF."
    );
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-statement-unlock-"));
  const inputPath = path.join(tmpDir, "input.pdf");
  const outputPath = path.join(tmpDir, "unlocked.pdf");

  try {
    fs.writeFileSync(inputPath, Buffer.from(bytes));
    const result = await runPdfProbe(inputPath, outputPath, password);

    if (result.ok && result.decrypted) {
      if (!fs.existsSync(outputPath)) {
        throw new PdfSecurityError(
          "BANK_STATEMENT_PDF_INVALID",
          "Kalika unlocked the statement but could not create a readable PDF. Export the statement again and retry."
        );
      }
      const unlockedBytes = new Uint8Array(fs.readFileSync(outputPath));
      if (!hasPdfHeader(unlockedBytes)) {
        throw new PdfSecurityError(
          "BANK_STATEMENT_PDF_INVALID",
          "The unlocked statement is not a valid PDF. Export the statement again and retry."
        );
      }
      return unlockedBytes;
    }
    if (result.ok) return bytes;

    if (result.code === "password_required") {
      throw new PdfSecurityError(
        "BANK_STATEMENT_PASSWORD_REQUIRED",
        "This bank statement requires a password. Enter the statement password to continue."
      );
    }
    if (result.code === "incorrect_password") {
      throw new PdfSecurityError(
        "BANK_STATEMENT_PASSWORD_INCORRECT",
        "That password is incorrect. Check it and try again."
      );
    }
    if (result.code === "encryption_unsupported") {
      throw new PdfSecurityError(
        "BANK_STATEMENT_PASSWORD_UNSUPPORTED",
        "Kalika cannot open this PDF's encryption type. Remove its security in your PDF viewer, export a new PDF, and upload it again."
      );
    }
    if (result.code === "invalid_pdf") {
      throw new PdfSecurityError(
        "BANK_STATEMENT_PDF_INVALID",
        "This PDF appears damaged or invalid. Download or export the statement again, then retry."
      );
    }

    throw new PdfSecurityError(
      "BANK_STATEMENT_PDF_SERVICE_UNAVAILABLE",
      "PDF checking is temporarily unavailable on this server. Please try again shortly."
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

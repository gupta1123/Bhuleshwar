import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { PdfSecurityError, unlockPdfIfNeeded } from "./pdf-security.ts";

const execFileAsync = promisify(execFile);
let fixtureDir = "";
let pythonCommand = "";

async function findPython() {
  const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  for (const command of candidates) {
    try {
      const args = command === "py" ? ["-3", "-c", "import pypdf"] : ["-c", "import pypdf"];
      await execFileAsync(command, args);
      return command;
    } catch {
      try {
        const args = command === "py" ? ["-3", "-c", "import PyPDF2"] : ["-c", "import PyPDF2"];
        await execFileAsync(command, args);
        return command;
      } catch {
        // Continue to the next interpreter.
      }
    }
  }
  return "";
}

pythonCommand = await findPython();

before(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "kalika-pdf-security-test-"));
  await fs.writeFile(path.join(fixtureDir, "corrupt.pdf"), "%PDF-1.7\nthis is not a complete PDF\n");
  await fs.writeFile(path.join(fixtureDir, "renamed.pdf"), "not a PDF");
  if (!pythonCommand) return;

  const script = String.raw`
import sys
from pathlib import Path
try:
    from pypdf import PdfWriter
except ImportError:
    from PyPDF2 import PdfWriter

target = Path(sys.argv[1])

plain = PdfWriter()
plain.add_blank_page(width=612, height=792)
with (target / "plain.pdf").open("wb") as output:
    plain.write(output)

secured = PdfWriter()
secured.add_blank_page(width=612, height=792)
secured.encrypt("secret")
with (target / "secured.pdf").open("wb") as output:
    secured.write(output)

blank_password = PdfWriter()
blank_password.add_blank_page(width=612, height=792)
blank_password.encrypt("", "owner-secret")
with (target / "blank-password.pdf").open("wb") as output:
    blank_password.write(output)
`;
  const args = pythonCommand === "py" ? ["-3", "-c", script, fixtureDir] : ["-c", script, fixtureDir];
  await execFileAsync(pythonCommand, args);
});

after(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

async function fixture(name) {
  return new Uint8Array(await fs.readFile(path.join(fixtureDir, name)));
}

test("accepts a valid unencrypted PDF", { skip: !pythonCommand }, async () => {
  const bytes = await fixture("plain.pdf");
  assert.deepEqual(await unlockPdfIfNeeded(bytes, ""), bytes);
});

test("asks for a password only when one is actually required", { skip: !pythonCommand }, async () => {
  await assert.rejects(
    unlockPdfIfNeeded(await fixture("secured.pdf"), ""),
    (error) => error instanceof PdfSecurityError && error.code === "BANK_STATEMENT_PASSWORD_REQUIRED"
  );
});

test("distinguishes an incorrect password", { skip: !pythonCommand }, async () => {
  await assert.rejects(
    unlockPdfIfNeeded(await fixture("secured.pdf"), "wrong"),
    (error) => error instanceof PdfSecurityError && error.code === "BANK_STATEMENT_PASSWORD_INCORRECT"
  );
});

test("decrypts a PDF when the supplied password is correct", { skip: !pythonCommand }, async () => {
  const unlocked = await unlockPdfIfNeeded(await fixture("secured.pdf"), "secret");
  assert.equal(Buffer.from(unlocked.subarray(0, 5)).toString("ascii"), "%PDF-");
});

test("does not prompt for an encrypted PDF that opens with an empty password", { skip: !pythonCommand }, async () => {
  const unlocked = await unlockPdfIfNeeded(await fixture("blank-password.pdf"), "");
  assert.equal(Buffer.from(unlocked.subarray(0, 5)).toString("ascii"), "%PDF-");
});

test("reports malformed PDFs as invalid rather than password protected", { skip: !pythonCommand }, async () => {
  await assert.rejects(
    unlockPdfIfNeeded(await fixture("corrupt.pdf"), ""),
    (error) => error instanceof PdfSecurityError && error.code === "BANK_STATEMENT_PDF_INVALID"
  );
});

test("rejects a non-PDF renamed with a PDF extension", async () => {
  await assert.rejects(
    unlockPdfIfNeeded(await fixture("renamed.pdf"), ""),
    (error) => error instanceof PdfSecurityError && error.code === "BANK_STATEMENT_PDF_INVALID"
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("./bank-statement-extraction-state.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { isPreviewExtractionIncomplete } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

test("verified source coverage overrides a stale manual-extraction flag", () => {
  assert.equal(isPreviewExtractionIncomplete({
    requiresManualExtraction: true,
    transactions: Array.from({ length: 150 }),
    extractionDiagnostics: { coverageComplete: true },
  }), false);
});

test("zero rows and incomplete coverage remain blocked", () => {
  assert.equal(isPreviewExtractionIncomplete({ transactions: [], extractionDiagnostics: { coverageComplete: true } }), true);
  assert.equal(isPreviewExtractionIncomplete({ transactions: [{}], extractionDiagnostics: { coverageComplete: false } }), true);
});

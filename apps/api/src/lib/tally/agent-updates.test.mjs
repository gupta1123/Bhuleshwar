import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const exports = {};
const source = fs.readFileSync(new URL("./agent-updates.ts", import.meta.url), "utf8");
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, process: { env: {} } });

test("Local Agent update metadata compares semantic versions and builds a direct installer URL", () => {
  assert.equal(exports.compareAgentVersions("1.0.0", "1.1.1"), -1);
  assert.equal(exports.compareAgentVersions("1.1.1", "1.1.1"), 0);
  assert.equal(exports.compareAgentVersions("2.0.0", "1.1.1"), 1);
  const info = exports.localAgentUpdateInfo("1.0.0");
  assert.equal(info.updateAvailable, true);
  assert.equal(info.updateRequired, false);
  assert.match(info.downloadUrl, /releases\/download\/v1\.1\.1\/KalikaLocalAgent-1\.1\.1-x64\.exe$/);
});

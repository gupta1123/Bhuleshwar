import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const errorPath = path.resolve(process.cwd(), "output", "kalika-pdf-ledger-benchmark-error.log");
try {
  await import("../../../apps/tally-bridge/src/agent/benchmark-pdf-suggestions.mjs");
} catch (error) {
  fs.mkdirSync(path.dirname(errorPath), { recursive: true });
  fs.writeFileSync(errorPath, `${error?.stack || error}\n`);
  app.quit();
}

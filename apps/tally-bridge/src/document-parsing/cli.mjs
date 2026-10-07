#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseDocumentLocal } from "./parser.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) continue;
    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const filePath = args.input || args.file || argv.find((value) => !value.startsWith("--"));
  if (!filePath) {
    throw new Error(
      "Usage: npm run document:parse -- --input <document> [--output markdown|json] [--document-format csv] [--out <file>]"
    );
  }
  const result = await parseDocumentLocal({
    filePath,
    output: args.output || "markdown",
    format: args["document-format"] || null,
  });
  const rendered = result.outputFormat === "markdown" ? result.content : JSON.stringify(result, null, 2);
  if (args.out) {
    const outputPath = path.resolve(String(args.out));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${rendered}\n`, "utf8");
    process.stderr.write(`Parsed locally in ${result.metadata.durationMs} ms -> ${outputPath}\n`);
  } else {
    process.stdout.write(`${rendered}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Document parsing failed: ${error.message || String(error)}\n`);
  process.exitCode = 1;
});

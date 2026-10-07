import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AnydocParseResult = {
  success: boolean;
  markdownText: string;
  hasMarkdownTables: boolean;
  tableCount: number;
  executionTimeMs: number;
  format: string;
  error?: string | null;
};

type AnydocModule = {
  toMarkdown?: (inputPath: string) => Promise<string> | string;
  toMarkdownBytes?: (buffer: Uint8Array, extension: string) => Promise<string> | string;
};

let anydocModule: AnydocModule | null = null;

async function loadAnydocModule() {
  if (anydocModule) return anydocModule;
  try {
    anydocModule = (await import("@firecrawl/anydoc")) as AnydocModule;
    return anydocModule;
  } catch {
    const localModulePaths = [
      "C:/Users/Shubham/Desktop/Projects V2/Anydoc/node_modules/@firecrawl/anydoc/index.js",
      "../Anydoc/node_modules/@firecrawl/anydoc/index.js",
    ];
    for (const modPath of localModulePaths) {
      if (!fs.existsSync(modPath)) continue;
      try {
        anydocModule = (await import(/* @vite-ignore */ `file:///${path.resolve(modPath).replace(/\\/g, "/")}`)) as AnydocModule;
        return anydocModule;
      } catch {
        // Try the next location.
      }
    }
  }
  return null;
}

export function formatAsMarkdownTable(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { markdown: "", tableCount: 0 };
  const tableRows: string[][] = [];
  let inTable = false;
  let count = 0;
  for (const line of lines) {
    const cleanLine = line.replace(/\\t/g, "\t").replace(/\\n/g, "\n");
    const cells = cleanLine.includes("\t")
      ? cleanLine.split("\t").map((cell) => cell.trim())
      : cleanLine.includes(",")
        ? cleanLine.split(",").map((cell) => cell.trim())
        : cleanLine.split(/\s{2,}/).map((cell) => cell.trim());
    if (cells.length >= 3) {
      tableRows.push(cells);
      inTable = true;
    } else if (inTable) {
      inTable = false;
      count += 1;
    }
  }
  if (inTable) count += 1;
  if (!tableRows.length) return { markdown: text, tableCount: 0 };
  const maxCols = Math.max(...tableRows.map((row) => row.length));
  const headers = [...tableRows[0]];
  while (headers.length < maxCols) headers.push("");
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const dataLines = tableRows.slice(1).map((row) => {
    const cells = [...row];
    while (cells.length < maxCols) cells.push("");
    return `| ${cells.join(" | ")} |`;
  });
  return {
    markdown: [headerLine, separatorLine, ...dataLines].join("\n"),
    tableCount: Math.max(1, count),
  };
}

export async function parseWithAnydoc(buffer: Uint8Array, fileName: string): Promise<AnydocParseResult> {
  const startTime = Date.now();
  const ext = path.extname(fileName).toLowerCase().replace(".", "") || "txt";
  try {
    const anydoc = await loadAnydocModule();
    if (anydoc) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anydoc-parse-"));
      const inputPath = path.join(tmpDir, `input.${ext}`);
      fs.writeFileSync(inputPath, Buffer.from(buffer));
      try {
        let markdownText = "";
        if (typeof anydoc.toMarkdown === "function") markdownText = await anydoc.toMarkdown(inputPath);
        else if (typeof anydoc.toMarkdownBytes === "function") markdownText = await anydoc.toMarkdownBytes(buffer, ext);
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (markdownText?.trim()) {
          const { tableCount } = formatAsMarkdownTable(markdownText);
          return {
            success: true,
            markdownText: markdownText.trim(),
            hasMarkdownTables: markdownText.includes("|---") || markdownText.includes("| ---") || tableCount > 0,
            tableCount: Math.max(1, tableCount),
            executionTimeMs: Date.now() - startTime,
            format: ext,
          };
        }
      } catch {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    if (["pdf", "doc", "docx", "odt", "rtf", "epub"].includes(ext)) {
      return {
        success: false,
        markdownText: "",
        hasMarkdownTables: false,
        tableCount: 0,
        executionTimeMs: Date.now() - startTime,
        format: ext,
        error: "AnyDoc native module is unavailable for this document type",
      };
    }
    const { markdown, tableCount } = formatAsMarkdownTable(Buffer.from(buffer).toString("utf8"));
    return {
      success: true,
      markdownText: markdown,
      hasMarkdownTables: markdown.includes("|---") || markdown.includes("| ---") || tableCount > 0,
      tableCount,
      executionTimeMs: Date.now() - startTime,
      format: ext,
    };
  } catch (error) {
    return {
      success: false,
      markdownText: "",
      hasMarkdownTables: false,
      tableCount: 0,
      executionTimeMs: Date.now() - startTime,
      format: ext,
      error: error instanceof Error ? error.message : "AnyDoc extraction error",
    };
  }
}

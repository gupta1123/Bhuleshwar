import { jsonWithCors } from "@/lib/api/cors";
import { DEFAULT_COMPARISON_OPTIONS, readComparisonOptions } from "@/lib/comparison";
import { getPersistedPacketFieldConfiguration } from "@/lib/field-settings-service";
import { runWithAiTestOverrides, type AiTestOverrides } from "@/lib/processing/openrouter";
import {
  extractFileDocuments,
  finalizeExtractedDocuments,
  reviewAndCorrectExtractedDocuments,
  verifyProcessedDocuments,
} from "@/lib/processing/pipeline";
import type { CaseAnalysisMode, CaseDoc } from "@/types/pipeline";

// Test-only endpoint: runs uploaded files through the same extraction pipeline as a case,
// returns the results, and saves nothing. Used to compare prompts and models.
//
// POST multipart/form-data, header x-worker-secret: <WORKER_SECRET>
//   files           one or more PDF/image files (required)
//   analysisMode    "smart_split" (default, what cases use) or "standard"
//   review          "true" to also run the extraction review step
//   model           override the model for every AI call in this request
//   systemAppend    text appended to every system prompt
//   systemReplace   JSON array of {find, replace} applied to every system prompt
//   trace           "false" to leave out per-call prompts and raw responses
//
// The reply is newline-delimited JSON: {"event":"progress",...} lines, then one "result" or "error" line.

export const runtime = "nodejs";
export const maxDuration = 800;

const WORKER_SECRET = process.env.WORKER_SECRET || "";

function readText(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readReplacements(raw: string): AiTestOverrides["systemReplace"] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("systemReplace must be a JSON array of {find, replace}.");
  return parsed.map((entry) => ({ find: String(entry?.find ?? ""), replace: String(entry?.replace ?? "") }));
}

export async function POST(request: Request) {
  if (!WORKER_SECRET || request.headers.get("x-worker-secret") !== WORKER_SECRET) {
    return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonWithCors(request, { error: "Send the files as multipart/form-data." }, { status: 400 });
  }

  const files = form.getAll("files").filter((value): value is File => typeof value !== "string");
  if (!files.length) {
    return jsonWithCors(request, { error: "Attach at least one file in the 'files' field." }, { status: 400 });
  }

  let overrides: AiTestOverrides;
  try {
    overrides = {
      model: readText(form, "model") || undefined,
      systemAppend: readText(form, "systemAppend") || undefined,
      systemReplace: readReplacements(readText(form, "systemReplace")),
      trace: [],
    };
  } catch (error) {
    return jsonWithCors(request, { error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }

  const analysisMode: CaseAnalysisMode = readText(form, "analysisMode") === "standard" ? "standard" : "smart_split";
  const runReview = readText(form, "review") === "true";
  const includeTrace = readText(form, "trace") !== "false";
  const startedAt = Date.now();

  // The response is streamed as one JSON object per line: "progress" lines while working and a final
  // "result" or "error" line. Heroku closes requests that stay silent for 30 seconds, and a packet
  // takes minutes, so a progress line is sent at least every 15 seconds.
  const encoder = new TextEncoder();
  let stage = "Starting";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      const progress = () =>
        send({ event: "progress", stage, aiCalls: overrides.trace.length, elapsedMs: Date.now() - startedAt });
      progress();
      const heartbeat = setInterval(progress, 15_000);
      try {
        const body = await runExtraction((next) => {
          stage = next;
          progress();
        });
        send({ event: "result", ...body });
      } catch (error) {
        send({
          event: "error",
          error: error instanceof Error ? error.message : String(error),
          aiCalls: overrides.trace.length,
          trace: includeTrace ? overrides.trace : undefined,
        });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });

  async function runExtraction(onStage: (stage: string) => void) {
    const result = await runWithAiTestOverrides(overrides, async () => {
      const documents: CaseDoc[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        documents.push(
          ...(await extractFileDocuments({
            bytes: new Uint8Array(await file.arrayBuffer()),
            fileName: file.name,
            mimeType: file.type || null,
            analysisMode,
            position: `${index + 1} of ${files.length}`,
            onProgress: (_phase, next) => onStage(next),
          }))
        );
      }
      const extractionMs = Date.now() - startedAt;
      onStage(runReview ? "Comparing documents and running the review step" : "Comparing documents");

      const fieldConfiguration = await getPersistedPacketFieldConfiguration();
      const comparisonOptions = readComparisonOptions(DEFAULT_COMPARISON_OPTIONS);
      let processed = await finalizeExtractedDocuments({ documents, comparisonOptions, analysisMode, fieldConfiguration });

      let review: unknown = null;
      if (runReview) {
        const preliminary = verifyProcessedDocuments(processed.documents, comparisonOptions);
        const candidateDocumentIds = new Set(
          preliminary.mismatches.flatMap((mismatch) => mismatch.values.map((value) => value.docId))
        );
        const reviewed = await reviewAndCorrectExtractedDocuments(processed.documents, { candidateDocumentIds });
        review = reviewed.review;
        processed = await finalizeExtractedDocuments({
          documents: reviewed.documents,
          comparisonOptions,
          analysisMode,
          fieldConfiguration,
        });
      }

      return { processed, review, extractionMs };
    });

    return {
      settings: {
        analysisMode,
        review: runReview,
        model: overrides.model ?? null,
        systemAppend: overrides.systemAppend ?? null,
        systemReplace: overrides.systemReplace,
      },
      timing: { totalMs: Date.now() - startedAt, extractionMs: result.extractionMs },
      aiCalls: overrides.trace.length,
      documents: result.processed.documents,
      mismatches: result.processed.mismatches,
      summary: result.processed.summary,
      review: result.review,
      trace: includeTrace ? overrides.trace : undefined,
    };
  }
}

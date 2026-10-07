import type {
  CaseDoc,
  ComparisonOptions,
  DocType,
  Mismatch,
  PipelineStageId,
  QueuedUpload,
} from "@/types/pipeline";
import { fileToImagePages } from "@/services/pdf";
import { getQueuedUploadFiles } from "@/lib/upload-groups";
import {
  classifyDocumentFromImage,
  extractDataFromImages,
  generateMismatchAnalysis,
} from "@/services/ai";
import { verifyCaseDocuments } from "@/services/verification";
import { matchSampleByIndex } from "@/services/templates";
import { DEFAULT_COMPARISON_OPTIONS } from "@/lib/comparison";

export type StagePayload = {
  fileName?: string;
  documentType?: DocType;
  document?: CaseDoc;
  extractedDocuments?: Array<{ documentType: DocType; fields: Record<string, unknown> }>;
  pageCount?: number;
};

type StageUpdate = (uploadId: string, stage: PipelineStageId, payload?: StagePayload) => void;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PipelineResult {
  documents: CaseDoc[];
  mismatches: Mismatch[];
}

export async function orchestrateUploads(
  uploads: QueuedUpload[],
  onStageUpdate: StageUpdate,
  comparisonOptions: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS
): Promise<PipelineResult> {
  const documents: CaseDoc[] = [];

  for (let index = 0; index < uploads.length; index++) {
    const upload = uploads[index];
    const sourceFiles = getQueuedUploadFiles(upload);

    const fallbackTemplate = matchSampleByIndex(index);

    onStageUpdate(upload.id, "upload_received", { fileName: upload.name });
    await delay(200);

    let pageImages: string[] = [];
    if (sourceFiles.length) {
      for (const file of sourceFiles) {
        try {
          pageImages = [...pageImages, ...(await fileToImagePages(file))];
        } catch (error) {
          console.error("Failed to convert upload to images", error);
        }
      }
    }

    const documentType = await classifyDocumentFromImage(pageImages[0], upload.name);
    onStageUpdate(upload.id, "classifying", { documentType });

    onStageUpdate(upload.id, "ocr", { pageCount: pageImages.length });

    const { doc, extractedDocuments } = await extractDataFromImages({
      fileName: upload.name,
      pageImages,
      documentType,
    });

    const finalizedDoc: CaseDoc = {
      ...doc,
      sourceHint: upload.name,
      sourceFileName: sourceFiles[0]?.name ?? upload.name,
      pages: doc.pages || pageImages.length || fallbackTemplate.pages,
    };

    onStageUpdate(upload.id, "extracting", { document: finalizedDoc, extractedDocuments });
    await delay(200);

    documents.push(finalizedDoc);
    onStageUpdate(upload.id, "validating", { document: finalizedDoc });
    await delay(150);

    onStageUpdate(upload.id, "complete", { document: finalizedDoc });
  }

  const rawMismatches = verifyCaseDocuments(documents, comparisonOptions);
  const mismatches = rawMismatches.length
    ? await generateMismatchAnalysis(rawMismatches as Mismatch[], documents)
    : [];

  return { documents, mismatches };
}

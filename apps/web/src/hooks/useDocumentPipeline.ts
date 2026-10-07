import { useCallback, useMemo, useState } from "react";

import { persistProcessedCase, saveCaseAnalysis, type SavedCaseRecord } from "@/lib/case-persistence";
import type {
  CaseDoc,
  ComparisonOptions,
  Mismatch,
  PipelineStageId,
  PipelineStageProgress,
  QueuedUpload,
} from "@/types/pipeline";
import { orchestrateUploads, StagePayload } from "@/services/orchestration";
import { DEFAULT_COMPARISON_OPTIONS } from "@/lib/comparison";
import { getQueuedUploadFiles } from "@/lib/upload-groups";

type PipelineStatus = "idle" | "processing" | "ready" | "error";
type PersistenceStatus = "idle" | "saving" | "saved" | "error";
export type DuplicateUploadStrategy = "prompt" | "overwrite" | "duplicate";

export type DuplicateUploadConflict = {
  id: string;
  file: File;
  existingUpload: QueuedUpload;
};

export type QueueFilesResult = {
  conflicts: DuplicateUploadConflict[];
  acceptedUploads: QueuedUpload[];
};

const STAGE_SEQUENCE: PipelineStageId[] = [
  "upload_received",
  "classifying",
  "ocr",
  "extracting",
  "validating",
  "complete",
];

function buildInitialStages(): PipelineStageProgress[] {
  return STAGE_SEQUENCE.map((stage, index) => ({
    stage,
    status: index === 0 ? "active" : "pending",
    startedAt: index === 0 ? Date.now() : undefined,
  }));
}

function normalizeUploadName(name: string) {
  return name.trim().toLowerCase();
}

function buildQueuedUpload(file: File): QueuedUpload {
  return {
    id: `${file.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file.name,
    file,
    files: [file],
    source: "file",
    stages: buildInitialStages(),
  };
}

function buildQueuedUploadGroup(files: File[], name: string, source: QueuedUpload["source"] = "file"): QueuedUpload {
  const primaryFile = files[0];

  return {
    id: `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    file: primaryFile,
    files,
    source,
    stages: buildInitialStages(),
  };
}

function buildConflictId(file: File, index: number) {
  return `${normalizeUploadName(file.name)}-${file.size}-${file.lastModified}-${index}`;
}

function progressForStages(stages: PipelineStageProgress[]): number {
  const completed = stages.filter((stage) => stage.status === "done" || stage.status === "complete").length;
  return completed / stages.length;
}

function advanceStages(
  stages: PipelineStageProgress[],
  nextStage: PipelineStageId
): PipelineStageProgress[] {
  const timestamp = Date.now();
  return stages.map((entry) => {
    if (entry.stage === nextStage) {
      return {
        ...entry,
        status: entry.status === "done" ? "done" : "active",
        startedAt: entry.startedAt ?? timestamp,
      };
    }
    if (entry.status === "active" && entry.stage !== nextStage) {
      return { ...entry, status: "done", finishedAt: timestamp };
    }
    if (entry.stage === "complete" && nextStage === "complete") {
      return { ...entry, status: "done", finishedAt: timestamp };
    }
    return entry;
  });
}

export function useDocumentPipeline() {
  const [queuedUploads, setQueuedUploads] = useState<QueuedUpload[]>([]);
  const [documents, setDocuments] = useState<CaseDoc[]>([]);
  const [mismatches, setMismatches] = useState<Mismatch[]>([]);
  const [status, setStatus] = useState<PipelineStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeUploadId, setActiveUploadId] = useState<string | null>(null);
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>("idle");
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [savedCase, setSavedCase] = useState<SavedCaseRecord | null>(null);

  const queueFiles = useCallback((files?: FileList | File[] | null, strategy: DuplicateUploadStrategy = "prompt"): QueueFilesResult | undefined => {
    if (!files || files.length === 0) return;
    const sourceFiles = Array.from(files);
    const acceptedUploads: QueuedUpload[] = [];
    const conflicts: DuplicateUploadConflict[] = [];
    const knownUploads = new Map<string, QueuedUpload>();

    queuedUploads.forEach((upload) => {
      knownUploads.set(normalizeUploadName(upload.name), upload);
    });

    sourceFiles.forEach((file, index) => {
      const key = normalizeUploadName(file.name);
      const existingUpload = knownUploads.get(key);

      if (strategy === "prompt" && existingUpload) {
        conflicts.push({
          id: buildConflictId(file, index),
          file,
          existingUpload,
        });
        return;
      }

      const nextUpload = buildQueuedUpload(file);
      acceptedUploads.push(nextUpload);

      if (strategy !== "duplicate") {
        knownUploads.set(key, nextUpload);
      }
    });

    if (acceptedUploads.length > 0) {
      setQueuedUploads((prev) => {
        let nextUploads = [...prev];

        acceptedUploads.forEach((nextUpload) => {
          const existingIndex = nextUploads.findIndex(
            (upload) => normalizeUploadName(upload.name) === normalizeUploadName(nextUpload.name)
          );

          if (existingIndex >= 0 && strategy === "overwrite") {
            nextUploads = nextUploads.map((upload, index) => (index === existingIndex ? nextUpload : upload));
            return;
          }

          if (existingIndex >= 0 && strategy === "prompt") {
            return;
          }

          nextUploads = [...nextUploads, nextUpload];
        });

        return nextUploads;
      });
    }

    return { conflicts, acceptedUploads };
  }, [queuedUploads]);

  const queueUploadGroup = useCallback(
    (files?: File[] | null, options?: { name?: string; source?: QueuedUpload["source"] }): QueueFilesResult | undefined => {
      if (!files || files.length === 0) return;
      const name = options?.name?.trim() || files[0]?.name || "Camera document";
      const nextUpload = buildQueuedUploadGroup(files, name, options?.source ?? "file");

      setQueuedUploads((prev) => [...prev, nextUpload]);

      return {
        conflicts: [],
        acceptedUploads: [nextUpload],
      };
    },
    []
  );

  const removeUpload = useCallback((id: string) => {
    setQueuedUploads((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const reset = useCallback(() => {
    setQueuedUploads([]);
    setDocuments([]);
    setMismatches([]);
    setStatus("idle");
    setError(null);
    setActiveUploadId(null);
    setPersistenceStatus("idle");
    setPersistenceError(null);
    setSavedCase(null);
  }, []);

  const updateSavedCase = useCallback((caseRecord: SavedCaseRecord) => {
    setSavedCase(caseRecord);
  }, []);

  const startProcessing = useCallback(async (comparisonOptions: ComparisonOptions = DEFAULT_COMPARISON_OPTIONS) => {
    if (queuedUploads.length === 0) return;
    setStatus("processing");
    setDocuments([]);
    setMismatches([]);
    setError(null);
    setPersistenceStatus("idle");
    setPersistenceError(null);

    const uploadsSnapshot = queuedUploads.map((upload) => ({
      ...upload,
      files: getQueuedUploadFiles(upload),
    }));

    try {
      const result = await orchestrateUploads(
        uploadsSnapshot,
        (uploadId, stage, payload?: StagePayload) => {
          setActiveUploadId(uploadId);
          setQueuedUploads((prev) =>
            prev.map((upload) => {
              if (upload.id !== uploadId) return upload;
              const stages = advanceStages(upload.stages, stage);
              const updates: Partial<QueuedUpload> = { stages };
              if (stage === "classifying" && payload?.documentType) {
                updates.classifiedType = payload.documentType;
              }
              if (stage === "complete" && payload?.document) {
                updates.resultDoc = payload.document;
              }
              return { ...upload, ...updates };
            })
          );
        },
        comparisonOptions
      );

      setDocuments(result.documents);
      setMismatches(result.mismatches);
      setStatus("ready");
      setActiveUploadId(null);

      setPersistenceStatus("saving");
      try {
        const persisted = savedCase
          ? await saveCaseAnalysis(savedCase.id, {
              documents: result.documents,
              mismatches: result.mismatches,
              comparisonOptions,
            })
          : await persistProcessedCase({
              uploads: uploadsSnapshot,
              documents: result.documents,
              mismatches: result.mismatches,
              comparisonOptions,
            });
        setSavedCase(persisted.case);
        setPersistenceStatus("saved");
      } catch (persistError) {
        console.error("Failed to persist processed case", persistError);
        setPersistenceError(
          persistError instanceof Error ? persistError.message : "Unable to save case to Supabase."
        );
        setPersistenceStatus("error");
      }
    } catch (err) {
      console.error("Pipeline failed", err);
      setError(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
      setActiveUploadId(null);
    }
  }, [queuedUploads, savedCase]);

  const overallProgress = useMemo(() => {
    if (queuedUploads.length === 0) return 0;
    const progressSum = queuedUploads.reduce((acc, upload) => acc + progressForStages(upload.stages), 0);
    return progressSum / queuedUploads.length;
  }, [queuedUploads]);

  return {
    status,
    queuedUploads,
    documents,
    mismatches,
    error,
    activeUploadId,
    persistence: {
      status: persistenceStatus,
      error: persistenceError,
      savedCase,
    },
    progress: overallProgress,
    queueFiles,
    queueUploadGroup,
    removeUpload,
    startProcessing,
    updateSavedCase,
    reset,
  } as const;
}

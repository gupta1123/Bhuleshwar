"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, FileText, Files, FolderPlus, Loader2, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnalysisOptionsDialog } from "@/components/workspace/AnalysisOptionsDialog";
import {
  createDraftCase,
  enqueueCaseAnalysis,
  fetchCaseAnalysisProgress,
  fetchCaseDetail,
  getDuplicateCaseFromError,
  type DuplicateCaseReference,
} from "@/lib/case-persistence";
import { batchStateRank, planBatchCases, type BatchPlanAdjustments, type BatchRowState } from "@/lib/batch-cases";
import { getQueuedUploadPageCount } from "@/lib/upload-groups";

import type { ComparisonOptions, QueuedUpload } from "@/types/pipeline";

// Two uploads at a time keeps the browser responsive; the analysis worker has its own limit.
const UPLOAD_CONCURRENCY = 2;
const POLL_MS = 4000;

type BatchRow = {
  key: string;
  label: string;
  uploads: QueuedUpload[];
  state: BatchRowState;
  caseId: string | null;
  caseName: string | null;
  mismatchCount: number | null;
  progress: number;
  stage: string | null;
  queuePosition?: number | null;

  error: string | null;
  duplicate: DuplicateCaseReference | null;
};

type BatchCasesProps = {
  accessCompanyId: string;
  disabled: boolean;
  uploads: QueuedUpload[];
  onRemoveUpload: (id: string) => void;
  onStarted: () => void;
  onReset: () => void;
};

function caseLabel(uploads: QueuedUpload[]) {
  return (uploads[0]?.name ?? "Case").replace(/\.[a-z0-9]{2,5}$/i, "");
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

const STATE_STYLE: Record<BatchRowState, string> = {
  failed: "bg-[#c0392b]",
  duplicate: "bg-[#d4a017]",
  ready: "bg-[#2d6a4f]",
  running: "bg-[#2b1a10]",
  uploading: "bg-[#8a7f72]",
  queued: "bg-[#ded8d0]",
  waiting: "bg-[#ede6d9]",
};

export function BatchCases({ uploads, accessCompanyId, disabled, onRemoveUpload, onStarted, onReset }: BatchCasesProps) {
  const [adjustments, setAdjustments] = useState<BatchPlanAdjustments>({ undone: [], moves: {} });
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const rowsRef = useRef<BatchRow[] | null>(null);
  const optionsRef = useRef<ComparisonOptions | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const plans = useMemo(() => planBatchCases(uploads, adjustments), [uploads, adjustments]);
  const uploadById = useMemo(() => new Map(uploads.map((upload) => [upload.id, upload])), [uploads]);

  const patch = useCallback((key: string, next: Partial<BatchRow>) => {
    setRows((prev) => {
      const updated = prev?.map((row) => (row.key === key ? { ...row, ...next } : row)) ?? null;
      rowsRef.current = updated;
      return updated;
    });
  }, []);

  const queueAnalysis = useCallback(async (row: Pick<BatchRow, "key">, caseId: string) => {
    try {
      // Batch files are usually whole packets (invoice + e-way bill + weighment in one PDF),
      // so each case is split into its documents, as "Analyze multi-doc" does.
      await enqueueCaseAnalysis(caseId, { analysisMode: "smart_split", comparisonOptions: optionsRef.current ?? undefined });
      patch(row.key, { state: "queued", error: null, progress: 0, stage: "Queued for analysis" });
    } catch (error) {
      patch(row.key, { state: "failed", error: errorMessage(error, "Analysis could not be started.") });
    }
  }, [patch]);

  const createCase = useCallback(async (row: BatchRow, allowDuplicate = false) => {
    patch(row.key, { state: "uploading", error: null, duplicate: null });
    try {
      const created = await createDraftCase({ uploads: row.uploads, accessCompanyId, allowDuplicate });
      patch(row.key, { caseId: created.case.id, caseName: created.case.displayName });
      await queueAnalysis(row, created.case.id);
    } catch (error) {
      const duplicate = getDuplicateCaseFromError(error);
      if (duplicate) patch(row.key, { state: "duplicate", duplicate });
      else patch(row.key, { state: "failed", error: errorMessage(error, "The files could not be uploaded.") });
    }
  }, [patch, queueAnalysis, accessCompanyId]);

  const start = async (options: ComparisonOptions) => {
    optionsRef.current = options;
    setOptionsOpen(false);
    const initial: BatchRow[] = plans.map((plan) => {
      const caseUploads = plan.uploadIds.map((id) => uploadById.get(id)).filter((upload): upload is QueuedUpload => Boolean(upload));
      return {
        key: plan.key,
        label: caseLabel(caseUploads),
        uploads: caseUploads,
        state: "waiting",
        caseId: null,
        caseName: null,
        mismatchCount: null,
        progress: 0,
        stage: null,

        error: null,
        duplicate: null,
      };
    });
    rowsRef.current = initial;
    setRows(initial);
    onStarted();

    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, initial.length) }, async () => {
        while (next < initial.length) {
          const row = initial[next++];
          await createCase(row);
        }
      })
    );
  };

  const retry = (row: BatchRow) => {
    if (row.caseId) void queueAnalysis(row, row.caseId);
    else void createCase(row);
  };

  // Follow every queued or running case until the worker finishes it.
  const tracking = rows?.some((row) => row.state === "queued" || row.state === "running") ?? false;
  useEffect(() => {
    if (!tracking) return;
    let cancelled = false;
    const tick = async () => {
      const active = (rowsRef.current ?? []).filter(
        (row) => row.caseId && (row.state === "queued" || row.state === "running")
      );
      if (!active.length) return;
      for (let offset = 0; offset < active.length && !cancelled; offset += 50) {
        const chunk = active.slice(offset, offset + 50);
        const progress = await fetchCaseAnalysisProgress(chunk.map(row => row.caseId!)).catch(() => null);
        if (!progress || cancelled) continue;
        for (const row of chunk) {
          const live = progress[row.caseId!];
          if (!live) continue;
          if (live.status === "queued" || live.status === "running") {
            patch(row.key, { state: live.status, progress: live.progress, stage: live.stage, queuePosition: live.queuePosition });
          } else if (live.status === "failed" || live.status === "cancelled") {
            patch(row.key, { state: "failed", error: live.error || "Analysis failed." });
          } else if (live.status === "succeeded") {
            patch(row.key, { state: "ready", progress: 100 });
            void fetchCaseDetail(row.caseId!)
              .then((detail) => patch(row.key, { caseName: detail.case.displayName, mismatchCount: detail.case.mismatchCount }))
              .catch(() => undefined);
          }
        }
      }
    };
    let timer: number;
    const poll = async () => {
      await tick();
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tracking, patch]);

  // =========================================================================
  // Plan: which files go into which case
  // =========================================================================
  if (!rows) {
    const caseOptions = plans.map((plan, index) => ({
      anchor: plan.uploadIds[0],
      label: `Case ${index + 1}: ${caseLabel(plan.uploadIds.map((id) => uploadById.get(id)!).filter(Boolean))}`,
    }));
    const moveUpload = (uploadId: string, anchor: string) =>
      setAdjustments((prev) => ({ ...prev, moves: { ...prev.moves, [uploadId]: anchor } }));
    const undoGroup = (token: string) =>
      setAdjustments((prev) => ({ ...prev, undone: [...prev.undone, token] }));

    return (
      <div className="w-full space-y-3 text-left">
        <div className="flex flex-wrap items-baseline justify-between gap-2 pb-1">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded-md bg-[#2b1a10] text-white shadow-xs">
              <Files className="h-3 w-3" />
            </div>
            <span className="text-sm font-semibold text-[#2b1a10]">
              {uploads.length} files, {plans.length} case{plans.length === 1 ? "" : "s"}
            </span>
          </div>
          <span className="text-[11px] font-medium text-[#8a7f72]">
            Files with the same number in their name go into one case. Use Move to for the rest.
          </span>
        </div>

        <div className="divide-y divide-[#ede6d9] overflow-hidden rounded-xl border border-[#ded8d0] bg-[#fbfaf8]">
          {plans.map((plan, index) => (
            <div key={plan.key} className="px-3 py-2.5">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-[#111827]">Case {index + 1}</span>
                {plan.uploadIds.length > 1 && (
                  <span className="rounded-md bg-[#ebf5ee] px-1.5 py-0.5 text-[11px] font-medium text-[#1b4332]">
                    {plan.uploadIds.length} files
                    {plan.token ? `, same number ${plan.token}` : ""}
                    {plan.manual ? ", added by you" : ""}
                  </span>
                )}
                {plan.token && (
                  <button
                    type="button"
                    onClick={() => undoGroup(plan.token!)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#5b4b3d] underline underline-offset-2 hover:text-[#111827]"
                  >
                    <Undo2 className="h-3 w-3" /> Undo grouping
                  </button>
                )}
              </div>
              <div className="space-y-1">
                {plan.uploadIds.map((uploadId) => {
                  const upload = uploadById.get(uploadId);
                  if (!upload) return null;
                  const pages = getQueuedUploadPageCount(upload);
                  return (
                    <div key={uploadId} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-[#8a7f72]" />
                      <span className="min-w-0 flex-1 truncate text-xs text-[#3d3530]" title={upload.name}>
                        {upload.name}
                        {pages > 1 ? <span className="text-[#8a7f72]"> ({pages} pages)</span> : null}
                      </span>
                      {plans.length > 1 && (
                        <select
                          aria-label={`Move ${upload.name} to another case`}
                          value=""
                          onChange={(event) => event.target.value && moveUpload(uploadId, event.target.value)}
                          className="h-7 max-w-[180px] rounded-md border border-[#ded8d0] bg-[#fbfaf8] px-1.5 text-[11px] text-[#5b4b3d] focus:outline-none focus:ring-2 focus:ring-[#ede6d9]"
                        >
                          <option value="">Move to…</option>
                          {plan.uploadIds.length > 1 && <option value={uploadId}>Its own case</option>}
                          {caseOptions
                            .filter((option) => !plan.uploadIds.includes(option.anchor))
                            .map((option) => (
                              <option key={option.anchor} value={option.anchor}>{option.label}</option>
                            ))}
                        </select>
                      )}
                      <button
                        type="button"
                        onClick={() => onRemoveUpload(uploadId)}
                        className="rounded-md p-1 text-[#8a7f72] transition-colors hover:bg-rose-50 hover:text-rose-600"
                        title="Remove file"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end pt-1">
          <Button
            type="button"
            disabled={disabled || plans.length === 0}
            className="h-10 rounded-lg bg-[#2b1a10] px-5 text-xs font-semibold text-white shadow-xs hover:bg-[#3b271a]"
            onClick={() => setOptionsOpen(true)}
          >
            <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
            Create {plans.length} case{plans.length === 1 ? "" : "s"} and analyse
            <ArrowRight className="ml-1.5 h-3.5 w-3.5 text-white/70" />
          </Button>
        </div>
        <AnalysisOptionsDialog open={optionsOpen} onOpenChange={setOptionsOpen} onSelect={(options) => void start(options)} />
      </div>
    );
  }

  // =========================================================================
  // Track: every case of the batch until it is ready to review
  // =========================================================================
  const count = (states: BatchRowState[]) => rows.filter((row) => states.includes(row.state)).length;
  const ready = count(["ready"]);
  const needsYou = count(["failed", "duplicate"]);
  const stillUploading = count(["waiting", "uploading"]);
  const sections: Array<{ title: string; states: BatchRowState[] }> = [
    { title: "Needs you", states: ["failed", "duplicate"] },
    { title: "Ready to review", states: ["ready"] },
    { title: "Analysing", states: ["running", "uploading"] },
    { title: "Waiting", states: ["queued", "waiting"] },
  ];
  const ordered = [...rows].sort((a, b) => batchStateRank(a.state) - batchStateRank(b.state));

  return (
    <div className="w-full space-y-4 text-left">
      <div>
        <div className="text-sm font-semibold text-[#111827]">
          {ready} of {rows.length} ready to review
          {needsYou ? <span className="text-[#8c1d18]">, {needsYou} need{needsYou === 1 ? "s" : ""} you</span> : null}
        </div>
        <p className="mt-0.5 text-[11px] text-[#8a7f72]">
          {stillUploading
            ? "Keep this page open until every case is uploaded. Analysis then carries on even if you leave."
            : "Queued analyses continue if you leave. Open Case Register to follow them."}
        </p>
        <div className="mt-3 flex flex-wrap gap-1" role="list" aria-label="Cases in this batch">
          {rows.map((row) => (
            <button
              key={row.key}
              type="button"
              role="listitem"
              title={`${row.caseName ?? row.label}: ${row.state}`}
              onClick={() => rowRefs.current.get(row.key)?.scrollIntoView({ behavior: "smooth", block: "center" })}
              className={`h-3 w-6 rounded-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#2b1a10]/40 ${STATE_STYLE[row.state]}`}
            />
          ))}
        </div>
      </div>

      {sections.map((section) => {
        const sectionRows = ordered.filter((row) => section.states.includes(row.state));
        if (!sectionRows.length) return null;
        return (
          <div key={section.title}>
            <div className="mb-1.5 text-xs font-semibold text-[#5b4b3d]">
              {section.title} <span className="font-normal text-[#8a7f72]">({sectionRows.length})</span>
            </div>
            <div className="divide-y divide-[#ede6d9] overflow-hidden rounded-xl border border-[#ded8d0] bg-white">
              {sectionRows.map((row) => (
                <div
                  key={row.key}
                  ref={(node) => {
                    if (node) rowRefs.current.set(row.key, node);
                    else rowRefs.current.delete(row.key);
                  }}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_STYLE[row.state]}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-[#111827]">{row.caseName ?? row.label}</div>
                    <div className="truncate text-[11px] text-[#8a7f72]">
                      {row.uploads.length} file{row.uploads.length === 1 ? "" : "s"}
                      {row.state === "ready" && row.mismatchCount !== null
                        ? `, ${row.mismatchCount} mismatch${row.mismatchCount === 1 ? "" : "es"}`
                        : ""}
                      {row.state === "running" ? `, ${row.stage ?? "Analysing"} ${Math.round(row.progress)}%` : ""}
                      {row.state === "uploading" ? ", uploading files" : ""}
                      {row.state === "queued" ? (row.queuePosition ? `, number ${row.queuePosition} in queue` : ", queued") : ""}
                    </div>
                    {row.state === "failed" && row.error && (
                      <div className="mt-0.5 text-[11px] font-medium text-[#8c1d18]">{row.error}</div>
                    )}
                    {row.state === "duplicate" && row.duplicate && (
                      <div className="mt-0.5 text-[11px] font-medium text-[#7a5a00]">
                        Already a case: {row.duplicate.displayName}
                        
                      </div>
                    )}
                  </div>
                  {row.state === "running" && (
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[#ede6d9]">
                      <div className="h-full rounded-full bg-[#2b1a10] transition-[width]" style={{ width: `${Math.max(4, row.progress)}%` }} />
                    </div>
                  )}
                  {row.state === "uploading" && <Loader2 className="h-3.5 w-3.5 animate-spin text-[#8a7f72]" />}
                  {row.state === "failed" && (
                    <Button type="button" variant="outline" className="h-7 rounded-md border-[#ded8d0] px-2.5 text-[11px]" onClick={() => retry(row)}>
                      <RotateCcw className="mr-1 h-3 w-3" /> Retry
                    </Button>
                  )}
                  {row.state === "duplicate" && row.duplicate && (
                    <>
                      <Link href={`/cases/${row.duplicate.id}`} className="text-[11px] font-semibold text-[#2b1a10] underline underline-offset-2">
                        Open existing case
                      </Link>
                      <Button type="button" variant="outline" className="h-7 rounded-md border-[#ded8d0] px-2.5 text-[11px]" onClick={() => void createCase(row, true)}>
                        Create anyway
                      </Button>
                    </>
                  )}
                  {row.caseId && (row.state === "ready" || row.state === "failed") && (
                    <Link
                      href={`/cases/${row.caseId}`}
                      className={
                        row.state === "ready"
                          ? "rounded-md bg-[#2b1a10] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#3b271a]"
                          : "text-[11px] font-semibold text-[#2b1a10] underline underline-offset-2"
                      }
                    >
                      {row.state === "ready" ? "Review" : "Open case"}
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={stillUploading > 0}
          className="h-9 rounded-lg border-[#ded8d0] bg-white px-4 text-xs font-medium text-[#3d3530]"
          onClick={onReset}
        >
          Add another batch
        </Button>
      </div>
    </div>
  );
}

"use client";

import { CopyPlus, FileText, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DuplicateUploadConflict } from "@/hooks/useDocumentPipeline";

type DuplicateUploadDialogProps = {
  open: boolean;
  conflicts: DuplicateUploadConflict[];
  onOpenChange: (open: boolean) => void;
  onOverwrite: () => void;
  onDuplicate: () => void;
};

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function DuplicateUploadDialog({
  open,
  conflicts,
  onOpenChange,
  onOverwrite,
  onDuplicate,
}: DuplicateUploadDialogProps) {
  const hasMultipleConflicts = conflicts.length > 1;
  const title = hasMultipleConflicts
    ? "Some documents are already uploaded"
    : "This document is already uploaded";
  const description = hasMultipleConflicts
    ? "We found files with the same names already in this case. To keep the packet clean, overwrite the existing documents unless you intentionally need both copies for review."
    : "We found a file with the same name already in this case. Overwrite it to keep one clean version, or keep both only if they are intentionally different documents.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0">
        <div className="border-b border-slate-100 bg-gradient-to-r from-white to-[#f7f3ed] px-6 py-5">
          <DialogHeader>
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-700">
              <TriangleAlert className="h-5 w-5" />
            </div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
        </div>

        <div className="max-h-72 space-y-3 overflow-y-auto px-6 py-5">
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-slate-700 shadow-sm">
                  <FileText className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-slate-900">{conflict.file.name}</div>
                  <div className="mt-1 text-xs text-slate-500">
                    New upload: {formatBytes(conflict.file.size)}
                  </div>
                  <div className="mt-2 rounded-xl bg-white px-3 py-2 text-xs text-slate-600">
                    Existing queued file:{" "}
                    <span className="font-medium text-slate-800">{conflict.existingUpload.name}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <DialogFooter className="border-t border-slate-100 px-6 pb-6 pt-5">
          <Button
            type="button"
            variant="outline"
            className="border-slate-200 text-slate-700 hover:bg-slate-50"
            onClick={() => onOpenChange(false)}
          >
            Cancel upload
          </Button>
          <Button
            type="button"
            variant="outline"
            className="border-slate-200 text-slate-700 hover:bg-slate-50"
            onClick={onDuplicate}
          >
            <CopyPlus className="h-4 w-4" />
            Keep both copies
          </Button>
          <Button type="button" className="bg-slate-900 text-white hover:bg-slate-800" onClick={onOverwrite}>
            <RefreshCw className="h-4 w-4" />
            Overwrite existing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

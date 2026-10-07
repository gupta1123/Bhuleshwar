"use client";

import { CheckCircle2, ScanSearch, Type } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ComparisonOptions } from "@/types/pipeline";

type AnalysisOptionsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (options: ComparisonOptions) => void;
};

export function AnalysisOptionsDialog({
  open,
  onOpenChange,
  onSelect,
}: AnalysisOptionsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-0 overflow-hidden rounded-2xl border-zinc-200 p-0 shadow-xl">
        <div className="border-b border-zinc-100 px-5 py-4">
          <DialogHeader className="gap-1">
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <ScanSearch className="h-4 w-4 text-zinc-400" />
              Comparison mode
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed text-zinc-400">
              Should formatting (spaces, hyphens, slashes) count as mismatches?
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-2 px-4 py-3">
          <button
            type="button"
            className="group flex w-full items-start gap-3 rounded-xl border border-zinc-200 bg-white px-3.5 py-3 text-left transition-all hover:border-slate-300 hover:bg-slate-50"
            onClick={() => onSelect({ considerFormatting: true })}
          >
            <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-zinc-300 transition group-hover:border-slate-400">
              <Type className="h-2.5 w-2.5 text-zinc-400" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-slate-800">Strict — consider formatting</div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
                <span className="font-mono text-zinc-500">AB-123</span> ≠ <span className="font-mono text-zinc-500">AB123</span> — separators matter
              </p>
            </div>
          </button>

          <button
            type="button"
            className="group flex w-full items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/50 px-3.5 py-3 text-left transition-all hover:border-emerald-300 hover:bg-emerald-50"
            onClick={() => onSelect({ considerFormatting: false })}
          >
            <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-emerald-400 bg-emerald-500 transition">
              <CheckCircle2 className="h-2.5 w-2.5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-semibold text-slate-800">Lenient — ignore formatting</span>
                <span className="rounded-full bg-emerald-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-emerald-700">
                  Default
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
                Compare core values only — spaces & punctuation are stripped
              </p>
            </div>
          </button>
        </div>

        <DialogFooter className="border-t border-zinc-100 px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg px-3 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

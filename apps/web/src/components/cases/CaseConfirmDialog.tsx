"use client";

import { Loader2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type CaseConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  loading?: boolean;
  variant?: "danger" | "default";
  /** Overrides the case-specific footnote; pass null to hide it. */
  footnote?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function CaseConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  loading = false,
  variant = "danger",
  footnote,
  onOpenChange,
  onConfirm,
}: CaseConfirmDialogProps) {
  const isDanger = variant === "danger";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px] overflow-hidden rounded-2xl border border-[#e8e2db] bg-white p-0 shadow-[0_20px_60px_rgba(43,26,16,0.18)]">
        {/* Top accent line */}
        <div className={`h-1 w-full ${isDanger ? "bg-[#8c1d18]" : "bg-[#2b1a10]"}`} />
        <div className="px-6 pt-6 pb-5">
          <DialogHeader className="space-y-0">
            <div className="flex items-start gap-4">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-sm ${isDanger ? "border-[#f2c7c4] bg-[#fbf0ef] text-[#8c1d18]" : "border-[#e6ded2] bg-[#ede6d9] text-[#2b1a10]"}`}>
                <TriangleAlert className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <DialogTitle className="text-[15px] font-bold tracking-tight text-[#111827] leading-5">{title}</DialogTitle>
                <DialogDescription className="mt-1.5 text-[13px] font-normal leading-5 text-[#5b4b3d]">{description}</DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="border-t border-[#f0ece4] bg-[#fbfaf8] px-6 py-4">
          <DialogFooter className="flex flex-row justify-end gap-2 sm:gap-2.5">
            <Button
              type="button"
              variant="outline"
              className="h-9 flex-1 sm:flex-none rounded-xl border-[#ded8d0] bg-white px-5 text-xs font-medium text-[#3d3530] shadow-sm hover:bg-[#ede6d9] hover:text-[#111827] sm:w-auto"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={isDanger ? "destructive" : "default"}
              className={`h-9 flex-1 sm:flex-none rounded-xl px-5 text-xs font-semibold shadow-sm ${isDanger ? "bg-[#8c1d18] text-white hover:bg-[#7a1815] border border-[#8c1d18] shadow-[0_2px_8px_rgba(140,29,24,0.25)]" : "bg-[#2b1a10] text-white hover:bg-[#3b271a] shadow-[0_2px_8px_rgba(43,26,16,0.18)]"}`}
              onClick={onConfirm}
              disabled={loading}
            >
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
          {footnote === null ? null : (
            <p className="mt-3 text-center text-[11px] font-normal leading-4 text-[#8a7f72] sm:text-right">
              {footnote ?? (isDanger ? "This moves the case to Recycle Bin — you can restore it within 30 days." : "You can change this decision later from the case page.")}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

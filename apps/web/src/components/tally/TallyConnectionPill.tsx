"use client";

import Link from "next/link";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { CompanyAvatar } from "@/components/ui/company-avatar";

export type TallyConnectionPillStatus = "checking" | "verified" | "warning";

type TallyConnectionPillAction =
  | { label: string; onClick: () => void; href?: never }
  | { label: string; href: string; onClick?: never };

type TallyConnectionPillProps = {
  title: string;
  subtitle: string;
  status?: TallyConnectionPillStatus;
  avatarName?: string | null;
  refreshing?: boolean;
  onRefresh: () => void;
  secondaryAction?: TallyConnectionPillAction | null;
  className?: string;
};

/**
 * Shared Tally connection status pill used on Bank Statements and the
 * case mismatch tally header. Same layout, tones, and actions in both.
 */
export function TallyConnectionPill({
  title,
  subtitle,
  status = "warning",
  avatarName = null,
  refreshing = false,
  onRefresh,
  secondaryAction = null,
  className = "",
}: TallyConnectionPillProps) {
  return (
    <div className={`inline-flex min-w-0 items-center gap-3 ${className}`}>
      <div className="flex min-w-0 items-center gap-2">
        {status === "checking" ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#8a7f72]" />
        ) : status === "verified" ? (
          <CompanyAvatar name={avatarName ?? ""} verified />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
        )}
        <div className="min-w-0">
          <div className="text-xs font-bold text-[#1a1a1a]">{title}</div>
          <div className="mt-0.5 truncate text-[11px] font-semibold text-[#8a8177]">
            {subtitle}
          </div>
        </div>
      </div>
      <div className="flex gap-2 border-l border-[#ddd5c9] pl-3">
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-bold text-[#5a5046] hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
        {secondaryAction ? (
          secondaryAction.href ? (
            <Link
              className="inline-flex h-8 items-center rounded-xl bg-[#2d2d2d] px-3.5 text-xs font-bold text-white hover:bg-[#1a1a1a] shadow-sm transition-all"
              href={secondaryAction.href}
            >
              {secondaryAction.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="inline-flex h-8 items-center rounded-xl bg-[#2d2d2d] px-3.5 text-xs font-bold text-white hover:bg-[#1a1a1a] shadow-sm transition-all"
            >
              {secondaryAction.label}
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

import Link from "next/link";
import {
  AlertTriangle,
  CopyCheck,
  Fingerprint,
  GitBranch,
  Route,
  Split,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { PacketIntelligence, PacketIntelligenceCheck } from "@/lib/packet-intelligence";

type PacketIntelligencePanelProps = {
  packetIntelligence?: PacketIntelligence | null;
  className?: string;
  density?: "wide" | "sidebar";
};

const TONE_STYLES = {
  success: {
    shell: "border-emerald-200 bg-emerald-50/70",
    icon: "bg-emerald-100 text-emerald-700",
    label: "text-emerald-950",
    text: "text-emerald-800",
    action: "bg-white/75 text-emerald-900",
  },
  warning: {
    shell: "border-amber-200 bg-amber-50/70",
    icon: "bg-amber-100 text-amber-700",
    label: "text-amber-950",
    text: "text-amber-800",
    action: "bg-white/75 text-amber-900",
  },
  danger: {
    shell: "border-rose-200 bg-rose-50/70",
    icon: "bg-rose-100 text-rose-700",
    label: "text-rose-950",
    text: "text-rose-800",
    action: "bg-white/75 text-rose-900",
  },
  neutral: {
    shell: "border-slate-200 bg-white",
    icon: "bg-slate-100 text-slate-700",
    label: "text-slate-950",
    text: "text-slate-700",
    action: "bg-slate-50 text-slate-800",
  },
} as const;

const CHECK_STYLES: Record<PacketIntelligenceCheck["status"], string> = {
  clear: "border-emerald-100 bg-emerald-50 text-emerald-800",
  attention: "border-amber-100 bg-amber-50 text-amber-800",
  blocked: "border-rose-100 bg-rose-50 text-rose-800",
};

function getPacketIcon(kind: PacketIntelligence["kind"]): LucideIcon {
  if (kind === "duplicate_upload") return Fingerprint;
  if (kind === "duplicate_document_copies") return CopyCheck;
  if (kind === "seller_chain") return GitBranch;
  if (kind === "multi_shipment_same_company" || kind === "multi_shipment_different_companies") return Split;
  if (kind === "needs_review") return AlertTriangle;
  return Route;
}

function getVisibleChecks(checks: PacketIntelligenceCheck[], density: PacketIntelligencePanelProps["density"]) {
  const priority = checks.filter((check) => check.status !== "clear");
  const fallback = checks.filter((check) => check.status === "clear");
  const limit = density === "sidebar" ? 3 : 5;
  return [...priority, ...fallback].slice(0, limit);
}

function statusDotClassName(status: PacketIntelligenceCheck["status"]) {
  if (status === "blocked") return "bg-rose-500";
  if (status === "attention") return "bg-amber-500";
  return "bg-emerald-500";
}

export function PacketIntelligencePanel({
  packetIntelligence,
  className,
  density = "wide",
}: PacketIntelligencePanelProps) {
  if (!packetIntelligence) return null;

  // A confirmed single shipment does not change the reviewer workflow. Keep the
  // document list in view and reserve this panel for packet-structure exceptions.
  if (packetIntelligence.kind === "single_shipment") return null;

  const styles = TONE_STYLES[packetIntelligence.tone] ?? TONE_STYLES.neutral;
  const Icon = getPacketIcon(packetIntelligence.kind);
  const visibleChecks = getVisibleChecks(packetIntelligence.checks, density);
  const importantShipmentGroups = packetIntelligence.shipmentGroups.filter(
    (group) =>
      group.role !== "primary" ||
      packetIntelligence.kind === "seller_chain" ||
      packetIntelligence.kind === "multi_shipment_same_company" ||
      packetIntelligence.kind === "multi_shipment_different_companies"
  );
  const showShipments = importantShipmentGroups.length > 0;
  const showCopies = packetIntelligence.collapsedCopyGroups.length > 0;
  const showDuplicates = packetIntelligence.duplicateCases.length > 0;

  return (
    <section
      className={cn(
        "rounded-xl border p-3 shadow-sm",
        density === "wide" ? "sm:p-4" : "p-3",
        styles.shell,
        className
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", styles.icon)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={cn("truncate text-sm font-medium", styles.label)}>
              {packetIntelligence.label}
            </h2>
            <span className="rounded-full border border-white/70 bg-white/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
              {packetIntelligence.confidence} confidence
            </span>
          </div>
          <p className={cn("mt-1 text-xs leading-5", styles.text)}>
            {packetIntelligence.summary}
          </p>
        </div>
      </div>

      <div className={cn("mt-3 rounded-lg px-3 py-2 text-xs leading-5", styles.action)}>
        {packetIntelligence.recommendedAction}
      </div>

      <div
        className={cn(
          "mt-3 grid gap-2",
          density === "sidebar" ? "grid-cols-1" : "sm:grid-cols-2 xl:grid-cols-3"
        )}
      >
        {visibleChecks.map((check) => (
          <div
            key={check.key}
            className={cn("rounded-lg border px-3 py-2 text-xs", CHECK_STYLES[check.status])}
          >
            <div className="flex items-center gap-2">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClassName(check.status))} />
              <span className="truncate font-medium">{check.label}</span>
            </div>
            <p className="mt-1 line-clamp-2 leading-4 opacity-85">{check.detail}</p>
          </div>
        ))}
      </div>

      {(showShipments || showCopies || showDuplicates) && (
        <div className="mt-3 space-y-2 border-t border-white/70 pt-3">
          {showShipments && (
            <div className="space-y-1.5">
              {importantShipmentGroups.slice(0, density === "sidebar" ? 3 : 5).map((group) => (
                <div
                  key={group.key}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-white/70 px-3 py-2 text-xs text-slate-700"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-900">
                      {group.invoiceNumber || group.label}
                    </div>
                    <div className="truncate text-[11px] text-slate-500">
                      {group.company || group.reason}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                      group.role === "context"
                        ? "bg-slate-100 text-slate-600"
                        : group.role === "split_candidate"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-emerald-100 text-emerald-700"
                    )}
                  >
                    {group.role === "split_candidate" ? "Split" : group.role}
                  </span>
                </div>
              ))}
            </div>
          )}

          {showCopies && (
            <div className="rounded-lg bg-white/70 px-3 py-2 text-xs leading-5 text-slate-700">
              <span className="font-medium text-slate-900">Collapsed copies: </span>
              {packetIntelligence.collapsedCopyGroups
                .map((group) => `${group.label} (${group.documentIds.length})`)
                .join(", ")}
            </div>
          )}

          {showDuplicates && (
            <div className="rounded-lg bg-white/70 px-3 py-2 text-xs leading-5 text-slate-700">
              <span className="font-medium text-slate-900">Existing case: </span>
              {packetIntelligence.duplicateCases.map((duplicateCase, index) => (
                <span key={duplicateCase.id}>
                  {index > 0 ? ", " : ""}
                  <Link className="text-rose-700 underline-offset-2 hover:underline" href={`/cases/${duplicateCase.id}`}>
                    {duplicateCase.displayName}
                  </Link>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

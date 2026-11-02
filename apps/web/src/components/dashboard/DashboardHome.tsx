"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  FolderOpen,
  Plus,
  ArrowRight,
  Clock,
  Building2,
  AlertTriangle,
  ClipboardCheck,
  Send,
  CheckCircle2,
  ShieldAlert,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchCasePage, type SavedCaseRecord } from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";

type CounterKey = "review" | "toPost" | "posted" | "check";

// Each counter is the number of cases the Case Register shows for the same filter, so the
// dashboard and the register can never disagree. Counts come from the database (not from a
// loaded page of cases), so they stay correct however many cases exist.
const COUNTERS: Array<{
  key: CounterKey;
  label: string;
  hint: string;
  href: string;
  filters: { approvalFilter?: "approved" | "pending"; tallyFilter?: "posted" | "not_posted" | "check" };
  tone: "neutral" | "warn" | "good" | "bad";
  icon: typeof ClipboardCheck;
}> = [
  {
    key: "review",
    label: "To review",
    hint: "Waiting for approval",
    href: "/cases?approval=pending",
    filters: { approvalFilter: "pending" },
    tone: "warn",
    icon: ClipboardCheck,
  },
  {
    key: "toPost",
    label: "Ready to post",
    hint: "Approved, not in Tally yet",
    href: "/cases?approval=approved&tally=not_posted",
    filters: { approvalFilter: "approved", tallyFilter: "not_posted" },
    tone: "neutral",
    icon: Send,
  },
  {
    key: "posted",
    label: "Posted to Tally",
    hint: "Voucher created and verified",
    href: "/cases?tally=posted",
    filters: { tallyFilter: "posted" },
    tone: "good",
    icon: CheckCircle2,
  },
  {
    key: "check",
    label: "Tally check needed",
    hint: "Created, but the read-back check needs attention",
    href: "/cases?tally=check",
    filters: { tallyFilter: "check" },
    tone: "bad",
    icon: ShieldAlert,
  },
];

const TONE_CLASSES: Record<"neutral" | "warn" | "good" | "bad", { icon: string; value: string }> = {
  neutral: { icon: "bg-[#fbfaf8] text-[#5b4b3d] border-[#e6ded2]", value: "text-[#111827]" },
  warn: { icon: "bg-[#fef6e9] text-[#b45309] border-[#f9d8a7]", value: "text-[#111827]" },
  good: { icon: "bg-[#ebf5ee] text-[#2d6a4f] border-[#c3dfcb]", value: "text-[#111827]" },
  bad: { icon: "bg-[#fbf0ef] text-[#b91c1c] border-[#f2c7c4]", value: "text-[#8c1d18]" },
};

function approvalChip(status: string) {
  const s = (status || "").toLowerCase();
  if (s === "accepted" || s === "approved") {
    return { label: "Approved", cls: "bg-[#ebf5ee] text-[#1b4332] border-[#c3dfcb]", dot: "bg-[#2d6a4f]" };
  }
  if (s === "rejected") {
    return { label: "Rejected", cls: "bg-[#fbf0ef] text-[#8c1d18] border-[#f2c7c4]", dot: "bg-[#b91c1c]" };
  }
  return { label: "Pending approval", cls: "bg-[#fef6e9] text-[#78350f] border-[#f9d8a7]", dot: "bg-[#b45309]" };
}

function tallyText(item: SavedCaseRecord) {
  const posting = item.tallyPosting;
  if (posting?.voucherNumber) {
    return posting.verificationStatus === "verified"
      ? { text: "Posted · #" + posting.voucherNumber, cls: "font-medium text-[#2d6a4f]" }
      : { text: "Check · #" + posting.voucherNumber, cls: "font-semibold text-[#8c1d18]" };
  }
  return { text: "Not posted", cls: "text-[#a89d91]" };
}

function formatDate(dateStr: string) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function getRelativeTime(dateStr: string) {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (isNaN(diffMs) || diffMs < 0) return formatDate(dateStr);

    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;

    return formatDate(dateStr);
  } catch {
    return formatDate(dateStr);
  }
}

function toReadableCaseText(value: string) {
  return value
    .split(/(\/)/)
    .map((part) => {
      if (part === "/") return part;
      return part
        .split(/(\s+)/)
        .map((word) => {
          if (!word.trim()) return word;
          if (/[0-9]/.test(word)) return word;
          if (word.length <= 3 && word === word.toUpperCase()) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join("");
    })
    .join("")
    .replace(/\s+packet$/i, " packet");
}


function MetricValueSkeleton() {
  return <Skeleton className="h-8 w-16 rounded-lg bg-[#eee7dd]" />;
}

function RecentCasesSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className="flex flex-col rounded-xl border border-[#ded8d0] bg-white p-4 shadow-2xs"
        >
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="h-8 w-8 shrink-0 rounded-lg bg-[#f0ece6]" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-32 bg-[#eee7dd]" />
              <Skeleton className="h-3 w-20 bg-[#eee7dd]" />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            <Skeleton className="h-5 w-16 rounded-full bg-[#eee7dd]" />
            <Skeleton className="h-5 w-12 rounded bg-[#eee7dd]" />
          </div>
          <div className="mt-4 border-t border-[#ece6dc] pt-3">
            <Skeleton className="h-3.5 w-full bg-[#eee7dd]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DashboardHome() {
  const [recent, setRecent] = useState<SavedCaseRecord[]>([]);
  const [counts, setCounts] = useState<Partial<Record<CounterKey, number>>>({});
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // limit 1 + page 1: only the database's total for each filter is needed.
    const countRequests = COUNTERS.map((counter) =>
      fetchCasePage({ scope: "active", limit: 1, page: 1, ...counter.filters })
        .then((payload) => [counter.key, payload.totalCount ?? 0] as const)
        .catch(() => [counter.key, null] as const),
    );

    Promise.all([fetchCasePage({ scope: "active", limit: 8 }), Promise.all(countRequests)])
      .then(([recentPayload, results]) => {
        if (!active) return;
        setRecent(recentPayload.cases);
        const next: Partial<Record<CounterKey, number>> = {};
        for (const [key, value] of results) if (value !== null) next[key] = value;
        setCounts(next);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load the dashboard.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <AppShell>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-5 text-[#111827] sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-5">
          <PageHeader
            title="Dashboard"
            subtitle="Purchase verification at a glance"
            actions={
              <div className="flex items-center gap-2">
                <Link
                  href="/cases"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-1.5 text-xs font-medium text-[#3d3530] shadow-sm transition hover:bg-[#ede6d9]"
                >
                  <FolderOpen className="h-3.5 w-3.5 text-[#8a7f72]" />
                  <span>Case Register</span>
                </Link>
                <Link
                  href="/workspace"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#2b1a10] px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-[#3b271a]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Upload &amp; Verify</span>
                </Link>
              </div>
            }
          />

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs font-medium text-rose-700">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500" />
              <span>{error}</span>
            </div>
          )}

          {/* ── COUNTERS ── */}
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {COUNTERS.map((counter) => {
              const Icon = counter.icon;
              const tone = TONE_CLASSES[counter.tone];
              const value = counts[counter.key];
              return (
                <Link
                  key={counter.key}
                  href={counter.href}
                  className="group flex flex-col gap-3 rounded-xl border border-[#ded8d0] bg-white p-4 shadow-2xs transition hover:border-[#b9aa99] hover:shadow-xs"
                >
                  <div className="flex items-center justify-between">
                    <div className={"flex h-8 w-8 items-center justify-center rounded-lg border " + tone.icon}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 text-[#b5aaa0] transition group-hover:translate-x-0.5 group-hover:text-[#2b1a10]" />
                  </div>
                  <div>
                    <div className="text-xs font-medium text-[#5b4b3d]">{counter.label}</div>
                    <div className={"mt-1 text-2xl font-bold " + tone.value}>
                      {status === "loading" ? <MetricValueSkeleton /> : value ?? "—"}
                    </div>
                    <div className="mt-1 text-[11px] text-[#8a7f72]">{counter.hint}</div>
                  </div>
                </Link>
              );
            })}
          </section>

          {/* ── RECENT CASES ── */}
          <section className="space-y-3">
            <div className="flex items-center justify-between px-0.5">
              <h2 className="text-xs font-bold uppercase tracking-wider text-[#2b1a10]">Recent cases</h2>
              <Link
                href="/cases"
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#2b1a10] hover:underline"
              >
                <span>View all</span>
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            {status === "loading" ? (
              <RecentCasesSkeleton />
            ) : status === "ready" && recent.length === 0 ? (
              <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-[#ded8d0] bg-white p-6 text-center">
                <FolderOpen className="mb-2 h-8 w-8 text-[#8a7f72]" />
                <p className="text-xs font-semibold text-[#111827]">No cases yet</p>
                <Link
                  href="/workspace"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[#2b1a10] px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-[#3b271a]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Upload the first invoice
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {recent.map((item) => {
                  const approval = approvalChip(item.status);
                  const tally = tallyText(item);
                  const title = toReadableCaseText(item.receiverName || item.buyerName || item.displayName);
                  const reference = item.invoiceNumber || item.poNumber || item.category || "Document packet";

                  return (
                    <Link
                      href={"/cases/" + item.id}
                      key={item.id}
                      className="group flex flex-col justify-between rounded-xl border border-[#ded8d0] bg-white p-3.5 shadow-2xs transition-all hover:border-[#b9aa99] hover:shadow-xs"
                    >
                      <div>
                        <div className="flex items-start gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#ded8d0] bg-[#fbfaf8] text-[#5b4b3d] transition-colors group-hover:bg-[#ede6d9] group-hover:text-[#2b1a10]">
                            <Building2 className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h4 className="truncate text-xs font-semibold text-[#111827] group-hover:text-[#2b1a10]" title={title}>
                              {title}
                            </h4>
                            <span className="mt-0.5 block truncate text-[11px] font-normal text-[#8a7f72]">{reference}</span>
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          <span className={"inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium " + approval.cls}>
                            <span className={"h-1.5 w-1.5 rounded-full " + approval.dot} />
                            {approval.label}
                          </span>
                          {item.mismatchCount > 0 && (
                            <span className="rounded border border-[#f2c7c4] bg-[#fbf0ef] px-1.5 py-0.5 text-[10px] font-semibold text-[#8c1d18]">
                              {item.mismatchCount} {item.mismatchCount === 1 ? "issue" : "issues"}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="mt-3.5 flex items-center justify-between border-t border-[#ece6dc] pt-2.5 text-[11px] text-[#8a7f72]">
                        <span className={tally.cls}>{tally.text}</span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {getRelativeTime(item.createdAt)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

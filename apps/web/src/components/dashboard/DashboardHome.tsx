"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  FileText,
  Database,
  Activity,
  TrendingUp,
  FolderOpen,
  Plus,
  ArrowRight,
  Clock,
  Building2,
  AlertTriangle,
  Shield,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchRecentCases, type SavedCaseRecord } from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

function getStatusConfig(status: string) {
  const s = status?.toLowerCase() || "";
  if (s.includes("complete") || s === "success" || s === "ready" || s === "accepted") {
    return {
      bg: "bg-[#ebf5ee] text-[#1b4332] border-[#c3dfcb]",
      dot: "bg-[#2d6a4f]",
      label: "Completed",
    };
  }
  if (s.includes("review") || s === "in_review" || s === "processing" || s === "pending") {
    return {
      bg: "bg-[#fef6e9] text-[#78350f] border-[#f9d8a7]",
      dot: "bg-[#b45309]",
      label: "Ongoing",
    };
  }
  if (s.includes("fail") || s === "failed" || s === "error" || s === "rejected") {
    return {
      bg: "bg-[#fbf0ef] text-[#8c1d18] border-[#f2c7c4]",
      dot: "bg-[#b91c1c]",
      label: "Failed",
    };
  }
  return {
    bg: "bg-[#efeae2] text-[#574c43] border-[#ded5c8]",
    dot: "bg-[#8a7f72]",
    label: "Draft",
  };
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const points = useMemo(() => {
    if (!data || data.length <= 1) return "";
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;

    const width = 110;
    const height = 32;
    const padding = 2;

    return data
      .map((val, idx) => {
        const x = (idx / (data.length - 1)) * (width - padding * 2) + padding;
        const y = height - ((val - min) / range) * (height - padding * 2) - padding;
        return `${x},${y}`;
      })
      .join(" ");
  }, [data]);

  if (!points) return <div className="h-8 w-[110px] border-b border-dashed border-[#e6ded2]" />;

  return (
    <svg width="110" height="32" className="overflow-visible opacity-85">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}

function RadialProgress({ value, color }: { value: number; color: string }) {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (Math.min(value, 100) / 100) * circumference;

  return (
    <div className="relative flex items-center justify-center shrink-0">
      <svg className="w-12 h-12 transform -rotate-90">
        <circle
          className="text-[#ede6d9]"
          strokeWidth="3.5"
          stroke="currentColor"
          fill="transparent"
          r={radius}
          cx="24"
          cy="24"
        />
        <circle
          className="transition-all duration-700 ease-out"
          strokeWidth="3.5"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          stroke={color}
          fill="transparent"
          r={radius}
          cx="24"
          cy="24"
        />
      </svg>
      <span className="absolute text-[11px] font-bold text-[#111827]">{value}%</span>
    </div>
  );
}

function VolumeChart({ cases }: { cases: SavedCaseRecord[] }) {
  const volumeData = useMemo(() => {
    const days: Array<{
      date: Date;
      label: string;
      localString: string;
      count: number;
    }> = [];
    const now = new Date();

    for (let i = 14; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      days.push({
        date: d,
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        localString: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        count: 0,
      });
    }

    cases.forEach((c) => {
      if (!c.createdAt) return;
      try {
        const cDate = new Date(c.createdAt);
        const cLocalString = `${cDate.getFullYear()}-${String(cDate.getMonth() + 1).padStart(2, "0")}-${String(cDate.getDate()).padStart(2, "0")}`;
        const match = days.find((d) => d.localString === cLocalString);
        if (match) {
          match.count++;
        }
      } catch (e) {
        console.error(e);
      }
    });

    return days;
  }, [cases]);

  const maxCount = useMemo(() => {
    return Math.max(...volumeData.map((d) => d.count), 4);
  }, [volumeData]);

  const width = 800;
  const height = 170;
  const paddingLeft = 32;
  const paddingRight = 16;
  const paddingTop = 16;
  const paddingBottom = 26;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const barWidth = 24;
  const gap = (chartWidth - barWidth * 15) / 14;

  return (
    <div className="w-full overflow-x-auto">
      <div className="min-w-[680px] h-[170px] relative">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" className="overflow-visible">
          <defs>
            <linearGradient id="volume-bar-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2b1a10" />
              <stop offset="100%" stopColor="#5b4b3d" />
            </linearGradient>
          </defs>

          {/* Y Axis grid lines */}
          {Array.from({ length: 5 }).map((_, i) => {
            const val = Math.round((i / 4) * maxCount);
            const y = paddingTop + chartHeight - (val / maxCount) * chartHeight;
            return (
              <g key={i}>
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={width - paddingRight}
                  y2={y}
                  stroke="#ece6dc"
                  strokeWidth="1"
                />
                <text
                  x={paddingLeft - 8}
                  y={y + 3}
                  fill="#8a7f72"
                  fontSize="9"
                  fontWeight="600"
                  textAnchor="end"
                >
                  {val}
                </text>
              </g>
            );
          })}

          {/* Draw bars */}
          {volumeData.map((day, i) => {
            const x = paddingLeft + i * (barWidth + gap);
            const barHeight = (day.count / maxCount) * chartHeight;
            const y = paddingTop + chartHeight - barHeight;

            return (
              <g key={day.localString} className="group cursor-pointer">
                <rect
                  x={x - gap / 4}
                  y={paddingTop}
                  width={barWidth + gap / 2}
                  height={chartHeight}
                  fill="transparent"
                  className="hover:fill-[#ede6d9]/30 transition-colors"
                />

                {day.count > 0 ? (
                  <rect
                    x={x}
                    y={y}
                    width={barWidth}
                    height={barHeight}
                    rx="4"
                    fill="url(#volume-bar-grad)"
                    className="transition-all duration-300 hover:brightness-125"
                  />
                ) : (
                  <rect
                    x={x}
                    y={paddingTop + chartHeight - 2}
                    width={barWidth}
                    height="2"
                    rx="1"
                    fill="#ded8d0"
                  />
                )}

                {day.count > 0 && (
                  <text
                    x={x + barWidth / 2}
                    y={y - 5}
                    fill="#111827"
                    fontSize="9"
                    fontWeight="700"
                    textAnchor="middle"
                  >
                    {day.count}
                  </text>
                )}

                <text
                  x={x + barWidth / 2}
                  y={height - 6}
                  fill="#8a7f72"
                  fontSize="9"
                  fontWeight="500"
                  textAnchor="middle"
                >
                  {day.label}
                </text>

                <title>{`${day.label}: ${day.count} case${day.count === 1 ? "" : "s"}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
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
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    fetchRecentCases(100)
      .then((payload) => {
        if (!active) return;
        setCases(payload.cases);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard cases.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, []);

  const metrics = useMemo(() => {
    const days: Array<{
      localString: string;
      caseCount: number;
      docCount: number;
      issueCount: number;
    }> = [];
    const now = new Date();
    for (let i = 14; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      days.push({
        localString: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        caseCount: 0,
        docCount: 0,
        issueCount: 0,
      });
    }

    cases.forEach((c) => {
      if (!c.createdAt) return;
      try {
        const cDate = new Date(c.createdAt);
        const cLocalString = `${cDate.getFullYear()}-${String(cDate.getMonth() + 1).padStart(2, "0")}-${String(cDate.getDate()).padStart(2, "0")}`;
        const match = days.find((d) => d.localString === cLocalString);
        if (match) {
          match.caseCount++;
          match.docCount += c.documentCount;
          match.issueCount += c.mismatchCount;
        }
      } catch (e) {
        console.error(e);
      }
    });

    const docHistory = days.map((d) => d.docCount);
    const caseHistory = days.map((d) => d.caseCount);
    const issueHistory = days.map((d) => d.issueCount);

    const totalCases = cases.length;
    const totalDocuments = cases.reduce((sum, item) => sum + item.documentCount, 0);
    const totalMismatches = cases.reduce((sum, item) => sum + item.mismatchCount, 0);
    const averageRisk = Math.round(average(cases.map((item) => item.riskScore)));

    return {
      totalCases,
      totalDocuments,
      totalMismatches,
      averageRisk,
      recentList: cases.slice(0, 8),
      docHistory,
      caseHistory,
      issueHistory,
    };
  }, [cases]);

  return (
    <AppShell>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-5 text-[#111827] sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-5">

          {/* ── Fixed/Sticky Reusable PageHeader ── */}
          <PageHeader
            title="Dashboard"
            subtitle="Real-time case analytics and document health"
            badge={
              <div className="flex items-center gap-1.5 rounded-lg border border-[#e6ded2] bg-[#fbfaf8] px-2.5 py-1 text-xs font-medium text-[#5b4b3d] shadow-sm">
                <Shield className="h-3 w-3 text-[#8a7f72]" />
                <span>Admin view</span>
              </div>
            }
            actions={
              <div className="flex items-center gap-2">
                <Link
                  href="/cases"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-1.5 text-xs font-medium text-[#3d3530] shadow-sm transition hover:bg-[#ede6d9]"
                >
                  <FolderOpen className="h-3.5 w-3.5 text-[#8a7f72]" />
                  <span>All Cases</span>
                </Link>
                <Link
                  href="/workspace"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#2b1a10] px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-[#3b271a]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Case</span>
                </Link>
              </div>
            }
          />

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs font-medium text-rose-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-500 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* ── OVERVIEW METRICS CARDS ── */}
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">

            {/* Metric 1: Active Documents */}
            <div className="flex flex-col justify-between rounded-xl border border-[#ded8d0] bg-white p-4 shadow-2xs transition-all hover:border-[#b9aa99] hover:shadow-xs">
              <div className="flex items-start justify-between">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#ded8d0] bg-[#fbfaf8] text-[#2b1a10]">
                  <FileText className="h-4 w-4" />
                </div>
                {status === "ready" && (
                  <Sparkline data={metrics.docHistory} color="#2b1a10" />
                )}
              </div>
              <div className="mt-4">
                <span className="text-[11px] font-medium text-[#8a7f72]">
                  Active Documents
                </span>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-2xl font-bold tracking-tight text-[#111827]">
                      {metrics.totalDocuments}
                    </span>
                  )}
                  <span className="rounded bg-[#ede6d9] px-1.5 py-0.5 text-[10px] font-semibold text-[#5b4b3d]">
                    Live
                  </span>
                </div>
              </div>
            </div>

            {/* Metric 2: Total Cases */}
            <div className="flex flex-col justify-between rounded-xl border border-[#ded8d0] bg-white p-4 shadow-2xs transition-all hover:border-[#b9aa99] hover:shadow-xs">
              <div className="flex items-start justify-between">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#ded8d0] bg-[#fbfaf8] text-[#5b4b3d]">
                  <Database className="h-4 w-4" />
                </div>
                {status === "ready" && (
                  <Sparkline data={metrics.caseHistory} color="#5b4b3d" />
                )}
              </div>
              <div className="mt-4">
                <span className="text-[11px] font-medium text-[#8a7f72]">
                  Total Cases
                </span>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-2xl font-bold tracking-tight text-[#111827]">
                      {metrics.totalCases}
                    </span>
                  )}
                  <span className="text-[11px] text-[#8a7f72]">
                    tracked
                  </span>
                </div>
              </div>
            </div>

            {/* Metric 3: Discovered Issues */}
            <div className="flex flex-col justify-between rounded-xl border border-[#ded8d0] bg-white p-4 shadow-2xs transition-all hover:border-[#b9aa99] hover:shadow-xs">
              <div className="flex items-start justify-between">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#f2c7c4] bg-[#fbf0ef] text-[#8c1d18]">
                  <Activity className="h-4 w-4" />
                </div>
                {status === "ready" && (
                  <Sparkline data={metrics.issueHistory} color="#8c1d18" />
                )}
              </div>
              <div className="mt-4">
                <span className="text-[11px] font-medium text-[#8a7f72]">
                  Discovered Issues
                </span>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-2xl font-bold tracking-tight text-[#8c1d18]">
                      {metrics.totalMismatches}
                    </span>
                  )}
                  {metrics.totalMismatches > 0 && (
                    <span className="rounded bg-[#fbf0ef] px-1.5 py-0.5 text-[10px] font-semibold text-[#8c1d18] border border-[#f2c7c4]">
                      Action needed
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Metric 4: Average Risk Index */}
            <div className="flex flex-col justify-between rounded-xl border border-[#ded8d0] bg-white p-4 shadow-2xs transition-all hover:border-[#b9aa99] hover:shadow-xs">
              <div className="flex items-start justify-between">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#ded8d0] bg-[#fbfaf8] text-[#2b1a10]">
                  <TrendingUp className="h-4 w-4" />
                </div>
                {status === "ready" && (
                  <RadialProgress
                    value={metrics.averageRisk}
                    color={metrics.averageRisk > 50 ? "#8c1d18" : metrics.averageRisk > 25 ? "#b45309" : "#2d6a4f"}
                  />
                )}
              </div>
              <div className="mt-4">
                <span className="text-[11px] font-medium text-[#8a7f72]">
                  Average Risk Index
                </span>
                <div className="mt-1 flex items-baseline gap-2">
                  {status === "loading" ? (
                    <MetricValueSkeleton />
                  ) : (
                    <span className="text-2xl font-bold tracking-tight text-[#111827]">
                      {metrics.averageRisk}%
                    </span>
                  )}
                  <span className="text-[11px] text-[#8a7f72]">
                    {metrics.averageRisk < 30 ? "Low risk" : metrics.averageRisk < 70 ? "Moderate" : "High risk"}
                  </span>
                </div>
              </div>
            </div>

          </section>

          {/* ── CASE VOLUME CHART ── */}
          {status === "ready" && (
            <section className="rounded-xl border border-[#ded8d0] bg-white p-4 sm:p-5 shadow-2xs">
              <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#ece6dc] pb-3">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[#2b1a10]">
                    Case Volume by Day (Last 15 Days)
                  </h3>
                  <p className="text-[11px] font-normal text-[#8a7f72] mt-0.5">
                    Daily validation and audit workflows processed
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#c3dfcb] bg-[#ebf5ee] px-2.5 py-0.5 text-[11px] font-medium text-[#1b4332]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#2d6a4f]" />
                    Live Sync
                  </span>
                </div>
              </div>
              <div className="pt-1">
                <VolumeChart cases={cases} />
              </div>
            </section>
          )}

          {/* ── RECENT CASES SECTION ── */}
          <section className="space-y-3">
            <div className="flex items-center justify-between px-0.5">
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-[#2b1a10]">
                  Recent Cases
                </h2>
                <span className="rounded-full bg-[#ede6d9] px-2 py-0.5 text-[10px] font-semibold text-[#5b4b3d]">
                  {status === "ready" ? `${metrics.recentList.length} recent` : "..."}
                </span>
              </div>
              <Link
                href="/cases"
                className="inline-flex items-center gap-1 text-xs font-semibold text-[#2b1a10] hover:underline"
              >
                <span>View all directory</span>
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>

            {status === "loading" ? (
              <RecentCasesSkeleton />
            ) : status === "ready" && metrics.recentList.length === 0 ? (
              <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-[#ded8d0] bg-white p-6 text-center">
                <FolderOpen className="mb-2 h-8 w-8 text-[#8a7f72]" />
                <p className="text-xs font-semibold text-[#111827]">No cases processed yet</p>
                <Link
                  href="/workspace"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[#2b1a10] px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs hover:bg-[#3b271a]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add First Case
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {metrics.recentList.map((item) => {
                  const statusConf = getStatusConfig(item.status);
                  const title = item.receiverName
                    ? toReadableCaseText(item.receiverName)
                    : item.buyerName
                    ? toReadableCaseText(item.buyerName)
                    : toReadableCaseText(item.displayName);

                  return (
                    <Link
                      href={`/cases/${item.id}`}
                      key={item.id}
                      className="group flex flex-col justify-between rounded-xl border border-[#ded8d0] bg-white p-3.5 shadow-2xs transition-all hover:border-[#b9aa99] hover:shadow-xs"
                    >
                      <div>
                        {/* Header Row */}
                        <div className="flex items-start gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#ded8d0] bg-[#fbfaf8] text-[#5b4b3d] group-hover:bg-[#ede6d9] group-hover:text-[#2b1a10] transition-colors">
                            <Building2 className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h4 className="truncate text-xs font-semibold text-[#111827] group-hover:text-[#2b1a10]" title={title}>
                              {title}
                            </h4>
                            <span className="block truncate text-[11px] font-normal text-[#8a7f72] mt-0.5">
                              {item.category || "Document Packet"}
                            </span>
                          </div>
                        </div>

                        {/* Partner counterparty if available */}
                        {(item.buyerName || item.receiverName) && (
                          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[#5b4b3d] truncate">
                            <span className="rounded bg-[#ede6d9] px-1 py-0.2 text-[9px] font-bold text-[#5b4b3d]">
                              Entity
                            </span>
                            <span className="truncate max-w-[190px]">
                              {item.buyerName || item.receiverName}
                            </span>
                          </div>
                        )}

                        {/* Status & Issue tags */}
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusConf.bg}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${statusConf.dot}`} />
                            {statusConf.label}
                          </span>
                          <span className="rounded border border-[#e6ded2] bg-[#fbfaf8] px-1.5 py-0.5 text-[10px] font-medium text-[#5b4b3d]">
                            {item.documentCount} {item.documentCount === 1 ? "doc" : "docs"}
                          </span>
                          {item.mismatchCount > 0 && (
                            <span className="rounded border border-[#f2c7c4] bg-[#fbf0ef] px-1.5 py-0.5 text-[10px] font-semibold text-[#8c1d18]">
                              {item.mismatchCount} {item.mismatchCount === 1 ? "issue" : "issues"}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Footer relative date */}
                      <div className="mt-3.5 border-t border-[#ece6dc] pt-2.5 flex items-center justify-between text-[11px] text-[#8a7f72]">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {getRelativeTime(item.createdAt)}
                        </span>
                        <span className="font-semibold text-[#2b1a10] opacity-0 transition-opacity group-hover:opacity-100">
                          Open &rarr;
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

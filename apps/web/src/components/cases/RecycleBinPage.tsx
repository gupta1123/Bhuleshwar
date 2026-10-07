"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";

import { CaseConfirmDialog } from "@/components/cases/CaseConfirmDialog";
import { AppShell } from "@/components/dashboard/AppShell";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SelectDropdown } from "@/components/ui/select-dropdown";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  deleteCaseForever,
  fetchCasePage,
  restoreCase,
  type SavedCaseRecord,
} from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";
type PendingAction =
  | { type: "destroy"; item: SavedCaseRecord }
  | { type: "restore"; item: SavedCaseRecord }
  | null;

const ROWS_PER_PAGE_OPTIONS = [
  { value: "10", label: "10" },
  { value: "25", label: "25" },
  { value: "50", label: "50" },
];

function formatRelativeDate(dateString: string | null) {
  if (!dateString) return "—";
  const date = new Date(dateString);
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  if (isToday) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear();
  if (isYesterday) return "Yesterday";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function calculateDaysRemaining(deletedAt: string | null) {
  if (!deletedAt) return 30;
  const deletedDate = new Date(deletedAt);
  const expiryDate = new Date(deletedDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const now = new Date();
  const diffTime = Math.max(0, expiryDate.getTime() - now.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
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

function getCaseTitle(item: SavedCaseRecord) {
  if (item.receiverName) return toReadableCaseText(item.receiverName);
  if (item.buyerName) return toReadableCaseText(item.buyerName);
  return toReadableCaseText(item.displayName);
}

function getCaseSubtitle(item: SavedCaseRecord) {
  if (item.invoiceNumber) return `Inv: ${item.invoiceNumber}`;
  if (item.poNumber) return `PO: ${item.poNumber}`;
  return item.category || "Document Packet";
}

export function RecycleBinPage() {
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setCurrentPage(1);
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();

    setStatus("loading");
    setError(null);

    fetchCasePage({
      scope: "deleted",
      limit: pageSize,
      page: currentPage,
      query: debouncedQuery,
      signal: controller.signal,
    })
      .then((payload) => {
        setCases(payload.cases);
        setTotalCount(payload.totalCount ?? payload.cases.length);
        setTotalPages(payload.totalPages ?? 1);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setError(
          loadError instanceof Error ? loadError.message : "Failed to load recycle bin."
        );
        setStatus("error");
      });

    return () => {
      controller.abort();
    };
  }, [currentPage, debouncedQuery, pageSize]);

  async function handleConfirmAction() {
    if (!pendingAction) return;

    try {
      setIsMutating(true);
      setError(null);

      if (pendingAction.type === "restore") {
        await restoreCase(pendingAction.item.id);
      } else {
        await deleteCaseForever(pendingAction.item.id);
      }

      setCases((current) =>
        current.filter((item) => item.id !== pendingAction.item.id)
      );
      const nextTotalCount = Math.max(0, totalCount - 1);
      const nextTotalPages = Math.max(1, Math.ceil(nextTotalCount / pageSize));
      setTotalCount(nextTotalCount);
      setTotalPages(nextTotalPages);
      if (currentPage > nextTotalPages) {
        setCurrentPage(nextTotalPages);
      }
      setPendingAction(null);
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to update recycle bin."
      );
    } finally {
      setIsMutating(false);
    }
  }

  return (
    <AppShell>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-5 text-[#111827] sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-4">

          {/* ── Fixed/Sticky Reusable PageHeader (Matches CasesPage) ── */}
          <PageHeader
            title="Recycle Bin"
            subtitle="Manage and restore deleted cases"
            badge={
              <div className="flex items-center gap-1.5 rounded-lg border border-[#e6ded2] bg-[#fbfaf8] px-2.5 py-1 text-xs font-medium text-[#5b4b3d] shadow-sm">
                <Trash2 className="h-3 w-3 text-[#8a7f72]" />
                <span>Auto-cleans in 30 days</span>
              </div>
            }
            actions={
              <Link
                href="/cases"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-1.5 text-xs font-medium text-[#3d3530] shadow-sm transition hover:bg-[#ede6d9]"
              >
                <span>All Cases</span>
              </Link>
            }
          >
            {/* Search Input Filter */}
            <div className="flex h-9 max-w-md items-center gap-2 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 text-xs shadow-sm focus-within:border-[#b9aa99] focus-within:bg-white transition">
              <Search className="h-3.5 w-3.5 text-[#8a7f72]" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search deleted cases, buyers, or numbers..."
                className="w-full bg-transparent font-medium text-[#111827] outline-none placeholder:text-[#b5aaa0]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="text-[11px] font-semibold text-[#8a7f72] hover:text-[#111827]"
                >
                  Clear
                </button>
              )}
            </div>
          </PageHeader>

          {/* ── Cardless Table Area (Matches CasesPage) ── */}
          <div className="w-full pt-1">
            {status === "loading" && (
              <div className="space-y-3 py-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-4 py-3 border-b border-[#ece6dc]">
                    <Skeleton className="h-4 w-44 bg-[#eee7dd]" />
                    <Skeleton className="h-4 w-32 bg-[#eee7dd]" />
                    <Skeleton className="h-4 w-20 bg-[#eee7dd]" />
                    <Skeleton className="h-4 w-20 bg-[#eee7dd]" />
                    <Skeleton className="h-4 w-16 ml-auto bg-[#eee7dd]" />
                  </div>
                ))}
              </div>
            )}

            {status === "error" && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs font-medium text-rose-700">
                {error}
              </div>
            )}

            {status === "ready" && cases.length === 0 && (
              <div className="flex min-h-[300px] flex-col items-center justify-center py-12 text-center">
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-[#ded8d0] bg-[#fbfaf8] text-[#8a7f72]">
                  <Trash2 className="h-5 w-5" />
                </div>
                <p className="text-sm font-semibold text-[#111827]">
                  {debouncedQuery ? "No matching deleted cases found" : "Recycle bin is empty"}
                </p>
                <p className="mt-1 text-xs text-[#8a7f72]">
                  {debouncedQuery
                    ? "Try adjusting your search query."
                    : "Cases moved to the recycle bin will appear here."}
                </p>
                {debouncedQuery && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="mt-3 text-xs font-semibold text-[#2b1a10] hover:underline"
                  >
                    Clear search
                  </button>
                )}
              </div>
            )}

            {status === "ready" && cases.length > 0 && (
              <div className="w-full">
                <Table className="w-full">
                  <TableHeader>
                    <TableRow className="border-b border-[#e0d8cc] bg-transparent hover:bg-transparent">
                      <TableHead className="h-10 pl-0 pr-3 text-xs font-semibold text-[#3d3530]">
                        Case / Document
                      </TableHead>
                      <TableHead className="h-10 px-3 text-xs font-semibold text-[#3d3530]">
                        Category
                      </TableHead>
                      <TableHead className="h-10 px-3 text-xs font-semibold text-[#3d3530]">
                        Deleted On
                      </TableHead>
                      <TableHead className="h-10 px-3 text-xs font-semibold text-[#3d3530]">
                        Expires In
                      </TableHead>
                      <TableHead className="h-10 pl-3 pr-0 text-right text-xs font-semibold text-[#3d3530]">
                        Actions
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cases.map((item) => {
                      const daysRemaining = calculateDaysRemaining(item.deletedAt);
                      return (
                        <TableRow
                          key={item.id}
                          className="group h-[52px] border-b border-[#ece6dc] transition-colors hover:bg-[#ede6d9]/40"
                        >
                          {/* Title / Subtitle */}
                          <TableCell className="pl-0 pr-3 py-2 font-medium text-[#111827]">
                            <Link
                              href={`/cases/${item.id}`}
                              className="hover:underline hover:text-[#2b1a10] block max-w-[280px] truncate font-medium text-[13px]"
                            >
                              {getCaseTitle(item)}
                            </Link>
                            <span className="block text-[11px] font-normal text-[#8a7f72] truncate max-w-[260px]">
                              {getCaseSubtitle(item)}
                            </span>
                          </TableCell>

                          {/* Category */}
                          <TableCell className="px-3 py-2 text-xs text-[#5a5046] font-normal">
                            <span className="block max-w-[160px] truncate" title={item.category || ""}>
                              {item.category || "—"}
                            </span>
                          </TableCell>

                          {/* Deleted On Date */}
                          <TableCell className="px-3 py-2 text-xs text-[#5a5046] font-normal whitespace-nowrap">
                            {formatRelativeDate(item.deletedAt)}
                          </TableCell>

                          {/* Expires In */}
                          <TableCell className="px-3 py-2 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                                daysRemaining <= 5
                                  ? "bg-[#fbf0ef] text-[#8c1d18] border-[#f2c7c4]"
                                  : "bg-[#fef6e9] text-[#78350f] border-[#f9d8a7]"
                              }`}
                            >
                              <Clock className="h-3 w-3" />
                              <span>{daysRemaining} {daysRemaining === 1 ? "day" : "days"}</span>
                            </span>
                          </TableCell>

                          {/* Action Buttons */}
                          <TableCell className="pl-3 pr-0 py-2 text-right whitespace-nowrap">
                            <div className="flex items-center justify-end gap-2">
                              <Link
                                href={`/cases/${item.id}`}
                                className="text-xs font-semibold text-[#2b1a10] hover:text-black hover:underline"
                              >
                                View
                              </Link>
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50 transition-colors"
                                onClick={() => setPendingAction({ type: "restore", item })}
                                title="Restore case"
                              >
                                <RotateCcw className="h-3 w-3" />
                                <span>Restore</span>
                              </button>
                              <button
                                type="button"
                                className="rounded p-1 text-[#8a7f72] transition hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2"
                                aria-label="Delete permanently"
                                onClick={() => setPendingAction({ type: "destroy", item })}
                                title="Delete permanently"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* ── Seamless Pagination Footer (Matches CasesPage) ── */}
            {status === "ready" && totalCount > 0 && (
              <div className="flex flex-col gap-3 pt-4 text-xs text-[#8a7f72] sm:flex-row sm:items-center sm:justify-between">
                {/* Rows per page selector */}
                <div className="flex items-center gap-2">
                  <span>Rows per page:</span>
                  <SelectDropdown
                    size="sm"
                    value={String(pageSize)}
                    onChange={(val) => {
                      setPageSize(Number(val));
                      setCurrentPage(1);
                    }}
                    options={ROWS_PER_PAGE_OPTIONS}
                    className="w-16"
                  />
                </div>

                {/* Page Navigation */}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-1.5 text-xs font-medium text-[#3d3530] shadow-sm transition hover:bg-[#ede6d9] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>Previous</span>
                  </button>

                  <span className="text-xs font-medium text-[#8a7f72]">
                    Page {currentPage} of {totalPages}
                  </span>

                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    className="inline-flex items-center gap-1 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-1.5 text-xs font-medium text-[#3d3530] shadow-sm transition hover:bg-[#ede6d9] disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Confirmation Dialog remains unchanged functionally, but styled to fit if possible via its own component */}
        <CaseConfirmDialog
          open={Boolean(pendingAction)}
          onOpenChange={(open) => {
            if (!open && !isMutating) {
              setPendingAction(null);
            }
          }}
          title={
            pendingAction?.type === "restore"
              ? "Restore this case?"
              : "Delete this case permanently?"
          }
          description={
            pendingAction
              ? pendingAction.type === "restore"
                ? `"${pendingAction.item.displayName}" will be moved back into the active cases list.`
                : `"${pendingAction.item.displayName}" and its stored documents will be removed permanently. This cannot be undone.`
              : ""
          }
          confirmLabel={pendingAction?.type === "restore" ? "Restore case" : "Delete forever"}
          variant={pendingAction?.type === "restore" ? "default" : "danger"}
          loading={isMutating}
          onConfirm={handleConfirmAction}
        />
      </div>
    </AppShell>
  );
}

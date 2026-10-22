"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Filter,
  Plus,
  Search,
  Shield,
  Trash2,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { useAccess } from '@/components/access/AccessProvider';
import { accessCacheEpoch, registerAccessCache } from '@/lib/access-cache';
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SelectDropdown } from "@/components/ui/select-dropdown";
import { CaseConfirmDialog } from "@/components/cases/CaseConfirmDialog";
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
  fetchCasePage,
  recycleCase,
  type SavedCaseRecord,
} from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";
type CachedCaseList = {
  cases: SavedCaseRecord[];
  totalCount: number;
  totalPages: number;
};

const caseListCache = new Map<string, CachedCaseList>();
registerAccessCache('case-list',()=>caseListCache.clear());
function cacheCaseList(key:string,value:CachedCaseList){
  caseListCache.delete(key);caseListCache.set(key,value);
  while(caseListCache.size>20)caseListCache.delete(caseListCache.keys().next().value!);
}

function getCaseListCacheKey(query: string, approval: string, reconciliation: string, page: number, pageSize: number) {
  return `active:${query.trim().toLowerCase()}:approval:${approval}:reconciliation:${reconciliation}:page:${page}:limit:${pageSize}`;
}

function formatRelativeDate(value: string) {
  const date = new Date(value);
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

function getApprovalPill(status: string) {
  switch (status.toLowerCase()) {
    case "accepted":
      return {
        label: "Approved",
        className: "bg-[#ebf5ee] text-[#1b4332] border-[#c3dfcb]",
        dotColor: "bg-[#2d6a4f]",
      };
    case "rejected":
      return {
        label: "Rejected",
        className: "bg-[#fbf0ef] text-[#8c1d18] border-[#f2c7c4]",
        dotColor: "bg-[#b91c1c]",
      };
    default:
      return {
        label: "Pending approval",
        className: "bg-[#fef6e9] text-[#78350f] border-[#f9d8a7]",
        dotColor: "bg-[#b45309]",
      };
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

function getCaseTitle(item: SavedCaseRecord) {
  if (item.receiverName) return toReadableCaseText(item.receiverName);
  if (item.buyerName) return toReadableCaseText(item.buyerName);
  return toReadableCaseText(item.displayName);
}

const APPROVAL_OPTIONS = [
  { value: "all", label: "All Approval States" },
  { value: "approved", label: "Approved" },
  { value: "pending", label: "Pending Approval" },
  { value: "rejected", label: "Rejected" },
];

const RECONCILIATION_OPTIONS = [
  { value: "all", label: "All Reconciliation" },
  { value: "clean", label: "No Issues (Matched)" },
  { value: "issues", label: "Has Mismatches" },
];

const ROWS_PER_PAGE_OPTIONS = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "50", label: "50" },
];

export function CasesPage() {
  const router = useRouter();
  const {snapshot}=useAccess();
  const [cacheEpoch,setCacheEpoch]=useState(accessCacheEpoch);
  useEffect(()=>{const reset=()=>{setCacheEpoch(accessCacheEpoch());setCases([]);setTotalCount(0);setPendingCase(null);};window.addEventListener('kalika-access-invalidated',reset);return()=>window.removeEventListener('kalika-access-invalidated',reset);},[]);
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  // Relevant filters & controls
  const [showFilters, setShowFilters] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [selectedApproval, setSelectedApproval] = useState("all");
  const [selectedReconciliation, setSelectedReconciliation] = useState("all");

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [listRevision, setListRevision] = useState(0);

  // Deletion
  const [pendingCase, setPendingCase] = useState<SavedCaseRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const cacheKey = useMemo(
    () => `${cacheEpoch}:${listRevision}:${snapshot?.member.user_id||'legacy'}:${snapshot?.organizationId||''}:${snapshot?.revision||0}:`+getCaseListCacheKey(debouncedSearchQuery, selectedApproval, selectedReconciliation, currentPage, pageSize),
    [currentPage, debouncedSearchQuery, selectedApproval, selectedReconciliation, pageSize,cacheEpoch,listRevision,snapshot?.member.user_id,snapshot?.organizationId,snapshot?.revision]
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
      setCurrentPage(1);
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [searchQuery]);

  useEffect(() => {
    const cached = caseListCache.get(cacheKey);
    if (cached) {
      setCases(cached.cases);
      setTotalCount(cached.totalCount);
      setTotalPages(cached.totalPages);
      setStatus("ready");
      setError(null);
      return;
    }

    const controller = new AbortController();

    setCases([]);
    setTotalCount(0);
    setTotalPages(1);
    setStatus("loading");
    setError(null);

    fetchCasePage({
      scope: "active",
      limit: pageSize,
      page: currentPage,
      query: debouncedSearchQuery,
      approvalFilter: selectedApproval as "all" | "approved" | "pending" | "rejected",
      reconciliationFilter: selectedReconciliation as "all" | "clean" | "issues",
      signal: controller.signal,
    })
      .then((payload) => {
        if(controller.signal.aborted)return;
        const nextTotalCount = payload.totalCount ?? payload.cases.length;
        const nextTotalPages = Math.max(1, Math.ceil(nextTotalCount / pageSize));
        setCases(payload.cases);
        setTotalCount(nextTotalCount);
        setTotalPages(nextTotalPages);
        setStatus("ready");
        cacheCaseList(cacheKey, {
          cases: payload.cases,
          totalCount: nextTotalCount,
          totalPages: nextTotalPages,
        });
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load cases.");
        setStatus("error");
      });

    return () => controller.abort();
  }, [cacheKey, currentPage, debouncedSearchQuery, pageSize]);

  async function handleConfirmDelete() {
    if (!pendingCase) return;

    try {
      setIsDeleting(true);
      setError(null);
      await recycleCase(pendingCase.id);
      const nextTotalCount = Math.max(0, totalCount - 1);
      const nextTotalPages = Math.max(1, Math.ceil(nextTotalCount / pageSize));
      const nextPage = Math.min(currentPage, nextTotalPages);

      setCases((current) => current.filter((item) => item.id !== pendingCase.id));
      setTotalCount(nextTotalCount);
      setTotalPages(nextTotalPages);
      caseListCache.clear();
      setCurrentPage(nextPage);
      setListRevision((current) => current + 1);
      setPendingCase(null);
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to move case to the recycle bin."
      );
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <AppShell>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-5 text-[#111827] sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-4">

          {/* ── Fixed/Sticky Reusable PageHeader (Compact SaaS style) ── */}
          <PageHeader
            title="Cases"
            subtitle="Track and manage all cases"
            badge={
              <div className="flex items-center gap-1.5 rounded-lg border border-[#e6ded2] bg-[#fbfaf8] px-2.5 py-1 text-xs font-medium text-[#5b4b3d] shadow-sm">
                <Shield className="h-3 w-3 text-[#8a7f72]" />
                <span>Admin view</span>
              </div>
            }
            actions={
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowFilters(!showFilters)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-1.5 text-xs font-medium text-[#3d3530] shadow-sm transition hover:bg-[#ede6d9]"
                >
                  <Filter className="h-3.5 w-3.5 text-[#8a7f72]" />
                  <span>{showFilters ? "Hide Filters" : "Show Filters"}</span>
                </button>

                <Link
                  href="/workspace"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#2b1a10] px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-[#3b271a]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Case</span>
                </Link>
              </div>
            }
          >
            {showFilters && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {/* Customer / Case Search */}
                <div className="flex h-9 items-center gap-2 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 text-xs shadow-sm focus-within:border-[#b9aa99] focus-within:bg-white transition">
                  <Search className="h-3.5 w-3.5 text-[#8a7f72]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search case, buyer, invoice or PO..."
                    className="w-full bg-transparent font-medium text-[#111827] outline-none placeholder:text-[#b5aaa0]"
                  />
                </div>

                {/* Approval Filter */}
                <SelectDropdown
                  value={selectedApproval}
                  onChange={(value) => {
                    setSelectedApproval(value);
                    setCurrentPage(1);
                  }}
                  options={APPROVAL_OPTIONS}
                  placeholder="All Approval States"
                />

                {/* Reconciliation / Mismatch Filter */}
                <SelectDropdown
                  value={selectedReconciliation}
                  onChange={(value) => {
                    setSelectedReconciliation(value);
                    setCurrentPage(1);
                  }}
                  options={RECONCILIATION_OPTIONS}
                  placeholder="All Reconciliation"
                />
              </div>
            )}
          </PageHeader>

          {/* ── Seamless Cardless Table ── */}
          <div className="w-full pt-1">
            {status === "loading" && (
              <div className="space-y-3 py-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-4 py-3 border-b border-[#ece6dc]">
                    <Skeleton className="h-4 w-44 bg-[#eee7dd]" />
                    <Skeleton className="h-4 w-32 bg-[#eee7dd]" />
                    <Skeleton className="h-4 w-16 bg-[#eee7dd]" />
                    <Skeleton className="h-5 w-20 rounded-full bg-[#eee7dd]" />
                    <Skeleton className="h-4 w-24 bg-[#eee7dd]" />
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
                <p className="text-sm font-semibold text-[#111827]">
                  {debouncedSearchQuery ? "No matching cases found" : "No cases yet"}
                </p>
                <p className="mt-1 text-xs text-[#8a7f72]">
                  {debouncedSearchQuery
                    ? "Try adjusting your search query or filters."
                    : "Add your first case to see it in the list."}
                </p>
                {!debouncedSearchQuery && (
                  <Link
                    href="/workspace"
                    className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#2b1a10] px-3.5 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-[#3b271a]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Case
                  </Link>
                )}
              </div>
            )}

            {status === "ready" && cases.length > 0 && (
              <div className="w-full">
                <Table className="w-full">
                  <TableHeader>
                    <TableRow className="border-b border-[#e0d8cc] bg-transparent hover:bg-transparent">
                      <TableHead className="h-10 pl-0 pr-3 text-xs font-semibold text-[#3d3530]">
                        Customer Name
                      </TableHead>
                      <TableHead className="h-10 px-3 text-xs font-semibold text-[#3d3530]">
                        Invoice
                      </TableHead>
                      <TableHead className="h-10 px-3 text-xs font-semibold text-[#3d3530]">
                        Approval
                      </TableHead>
                      <TableHead className="h-10 px-3 text-xs font-semibold text-[#3d3530]">
                        Reconciliation
                      </TableHead>
                      <TableHead className="h-10 px-3 text-xs font-semibold text-[#3d3530]">
                        Tally
                      </TableHead>
                      <TableHead className="h-10 px-2.5 text-center text-xs font-semibold text-[#3d3530]">
                        Docs
                      </TableHead>
                      <TableHead className="h-10 px-3 text-xs font-semibold text-[#3d3530]">
                        Date
                      </TableHead>
                      <TableHead className="h-10 pl-3 pr-0 text-right text-xs font-semibold text-[#3d3530]">
                        Action
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cases.map((item) => {
                      const pill = getApprovalPill(item.status);
                      return (
                        <TableRow
                          key={item.id}
                          className="group h-[52px] border-b border-[#ece6dc] transition-colors hover:bg-[#ede6d9]/40"
                        >
                          {/* Customer Name */}
                          <TableCell className="pl-0 pr-3 py-2 font-medium text-[#111827]">
                            <Link
                              href={`/cases/${item.id}`}
                              className="hover:underline hover:text-[#2b1a10] block max-w-[260px] truncate font-medium text-[13px]"
                              onFocus={() => router.prefetch(`/cases/${item.id}`)}
                              onMouseEnter={() => router.prefetch(`/cases/${item.id}`)}
                            >
                              {getCaseTitle(item)}
                            </Link>
                          </TableCell>

                          {/* Invoice */}
                          <TableCell className="px-3 py-2 text-xs text-[#5a5046] font-normal">
                            <span className="block max-w-[180px] truncate" title={item.invoiceNumber || ""}>
                              {item.invoiceNumber || "—"}
                            </span>
                          </TableCell>

                          {/* Approval decision */}
                          <TableCell className="px-3 py-2 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.02)] ${pill.className}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${pill.dotColor}`} />
                              {pill.label}
                            </span>
                          </TableCell>

                          {/* Reconciliation */}
                          <TableCell className="px-3 py-2 text-xs font-normal whitespace-nowrap">
                            {item.mismatchCount > 0 ? (
                              <span className="font-semibold text-[#8c1d18]">
                                {item.mismatchCount} {item.mismatchCount === 1 ? "issue" : "issues"}
                              </span>
                            ) : item.status === "completed" || item.status === "accepted" ? (
                              <span className="font-medium text-[#2d6a4f]">No issues</span>
                            ) : (
                              <span className="text-[#a89d91]">—</span>
                            )}
                          </TableCell>

                          {/* Tally posting */}
                          <TableCell className="px-3 py-2 text-xs font-normal whitespace-nowrap">
                            {item.tallyPosting?.voucherNumber ? (
                              item.tallyPosting.verificationStatus === "verified" ? (
                                <span className="font-medium text-[#2d6a4f]">
                                  Posted · #{item.tallyPosting.voucherNumber}
                                </span>
                              ) : (
                                <span className="font-semibold text-[#8c1d18]" title="Created in Tally but the read-back check needs attention">
                                  Check · #{item.tallyPosting.voucherNumber}
                                </span>
                              )
                            ) : (
                              <span className="text-[#a89d91]">Not posted</span>
                            )}
                          </TableCell>

                          {/* Docs */}
                          <TableCell className="px-2.5 py-2 text-xs text-[#5a5046] font-normal text-center whitespace-nowrap">
                            {item.documentCount}
                          </TableCell>

                          {/* Date */}
                          <TableCell className="px-3 py-2 text-xs text-[#5a5046] font-normal whitespace-nowrap">
                            {formatRelativeDate(item.createdAt)}
                          </TableCell>

                          {/* Actions */}
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
                                className="rounded p-1 text-[#8a7f72] transition hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2"
                                aria-label="Move to recycle bin"
                                onClick={() => setPendingCase(item)}
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

            {/* ── Seamless Pagination Footer ── */}
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
      </div>

      <CaseConfirmDialog
        open={Boolean(pendingCase)}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setPendingCase(null);
          }
        }}
        title="Move case to recycle bin?"
        description={
          pendingCase
            ? `"${pendingCase.displayName}" will be moved to the recycle bin.`
            : ""
        }
        confirmLabel="Move to recycle bin"
        loading={isDeleting}
        onConfirm={handleConfirmDelete}
      />
    </AppShell>
  );
}

"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {Dialog,DialogContent,DialogTitle,DialogDescription,DialogFooter} from '@/components/ui/dialog';
import {runDebitNoteBatch} from '@/lib/bulk-debit-notes';
import { PageHeader } from '@/components/dashboard/PageHeader';
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Download,
  Loader2,
  MessageCircle,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { accessCacheEpoch, registerAccessCache } from '@/lib/access-cache';
import { collectionsAccessReady } from '@/lib/collections-access-ready';
import styles from './CollectionsDashboardPage.module.css';
import {companyOptionIdentity} from '@/lib/company-option-identity';
import {useActionAccess} from '@/components/access/useActionAccess';
import {FollowUpPipelines} from './FollowUpPipelines';
import {useReminderStatuses,invoiceKey,reminderLabel} from './useReminderStatuses';
import {useAccess} from '@/components/access/AccessProvider';
import {canAccess} from '@autodealer/shared/lib/access';
import { runCashDiscountLiveRequest } from "@/lib/cash-discount-live";
import { canCreateInTally as canCreateDebitNoteInTally, invoiceKey as proposalListInvoiceKey } from '@autodealer/shared/lib/collections-query';
import {
  collectionsRevision,
  collectionsSummary,
  fetchCollectionsRows,
  fetchCollectionsRowsByInvoice,
  useCollectionsList,
  type CollectionsRemote,
  type CollectionsSummary,
} from './collections-source';
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";

type CompanyOption = {
  accessCompanyId?: string;
  companyGuid?: string;
  id: string;
  connectionId: string;
  companyName: string;
  financialYear: string;
  status: string;
  bridgeConnected: boolean;
  tallyReachable: boolean;
  companyLoaded: boolean;
  bankAccountCount: number | null;
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
};

function uniqueCompanyOptions(options: CompanyOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = companyOptionIdentity(option);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatCompanyOptionLabel(company: CompanyOption) {
  return [company.companyName, company.financialYear].filter(Boolean).join(" - ");
}

type CashDiscountTerm = {
  ratePercent: number;
  eligibilityDays: number;
  periodSource: "explicit" | "default";
};

type CashDiscountReversalPlan = {
  initialDiscount: CashDiscountTerm & { discountDeadline: string; discountAmount: number };
  grossInvoiceAmount: number;
  activeDiscount: (CashDiscountTerm & { discountDeadline: string; discountAmount: number }) | null;
  currentPayableAmount: number;
  totalReversalRequired: number;
};

type CashDiscountAnalysis = {
  sourceNarration: string;
  matchedCashDiscountContext: string | null;
  terms: CashDiscountTerm[];
  termsLabel: string | null;
  finalEligibilityDays: number | null;
  discountDeadline: string | null;
  expectedDiscounts: Array<{ ratePercent: number; amount: number }>;
  receiptDate: string | null;
  matchedReceiptAmount: number | null;
  deterministicStatus: string;
  deterministicReason: string;
  reversalPlan: CashDiscountReversalPlan | null;
  calculationVersion: string;
};

type NarrationAnalysisRow = {
  partyLedgerName: string;
  linkedInvoiceNumber: string | null;
  linkedInvoiceDate: string | null;
  originalInvoiceAmount: number;
  pendingAmount: number;
  analysis: CashDiscountAnalysis;
};

type PaymentFollowUp = {
  id: string;
  kind: "discount_window_open" | "full_payment_due" | "payment_due" | "payment_review";
  followUpStatus: "needs_follow_up" | "escalate" | "needs_review";
  ageBasis: "due_date" | "invoice_date" | "missing_dates";
  ageDays: number | null;
  ageLabel: string;
  dueDate: string | null;
  title: string;
  nextAction: string;
  partyLedgerName: string;
  partyGstin: string | null;
  partyPhone: string | null;
  partyEmail: string | null;
  linkedInvoiceNumber: string | null;
  linkedInvoiceDate: string | null;
  originalInvoiceAmount: number;
  outstandingAmount: number;
  amountReceived: number;
  narration: string;
  matchedCashDiscountContext: string | null;
  terms: CashDiscountTerm[];
  termsLabel: string | null;
  discountDeadline: string | null;
  currentDiscount: {
    ratePercent: number;
    eligibilityDays: number;
    periodSource: "explicit" | "default";
    discountDeadline: string;
    discountAmount: number;
  } | null;
  paymentAmountIfPaidToday: number | null;
  reversalPlan: CashDiscountReversalPlan | null;
  deterministicStatus: string;
  deterministicReason: string;
  calculationVersion: string;
};

type DebitNoteProposal = {
  id: string;
  sourceKind?: "tally_open_bill" | "supabase_proposal" | null;
  issueType?: "discount_shortfall" | "unpaid_discount_tier_reversal" | "invoice_unpaid" | "partial_unpaid" | null;
  canCreateDebitNote?: boolean | null;
  expectedDiscount?: number | null;
  pendingAmount?: number | null;
  connectionId?: string | null;
  companyName?: string | null;
  financialYear?: string | null;
  partyLedgerName: string;
  partyGstin: string | null;
  partyEmail: string | null;
  partyPhone: string | null;
  partyContactPerson: string | null;
  partyAddress: string | null;
  sourceSalesLedgerName?: string | null;
  linkedInvoiceNumber: string | null;
  linkedInvoiceDate: string | null;
  originalInvoiceAmount: number | null;
  cashDiscountRuleId?: string | null;
  cashDiscountRuleName?: string | null;
  amountReceived: number | null;
  recoverableAmount: number;
  remainingRecoverableAmount: number | null;
  receiptDate: string | null;
  discountDeadline: string | null;
  debitNoteDate: string;
  status: string;
  tallyVoucherGuid: string | null;
  tallyVoucherId: string | null;
  tallyVoucherNumber: string | null;
  tallyVoucherDate: string | null;
  lastError: string | null;
  narration: string | null;
  tallyOpenReferenceName: string | null;
  createdInTallyAt: string | null;
  communicationStatus: string | null;
  nativeTallyPdf?: {
    source: "tally_voucher_render";
    status: "verified";
    voucherId: string;
    voucherNumber: string;
    reference: string | null;
    alterId: string | null;
    sha256: string;
    byteSize: number;
    exportedAt: string;
  } | null;
  nativeTallyPdfVerified?: boolean;
  communicationRecipient?: string | null;
  communicationSentAt?: string | null;
  reasonCode?: string | null;
  gstMode?: string | null;
  cashDiscountAnalysis?: CashDiscountAnalysis | null;
  referenceNumber?: string | null;
  adjustOriginalInvoice?: boolean | null;
};

type WhatsappSendResult = {
  verificationRequired?: boolean;
  error?: string;
  phoneSaveCommandId?: string | null;
  phoneSaveConnectionId?: string | null;
  phoneSaveQueueError?: string | null;
};

type TallyCommand = {
  id: string;
  connectionId?: string;
  status: "queued" | "claimed" | "succeeded" | "failed" | "canceled";
  error?: string | null;
  result?: Record<string, unknown> | null;
};

type LiveTallyConnection = {
  id: string;
  status: string;
  lastCompanyName?: string | null;
  companyLoaded?: boolean;
  tallyReachable?: boolean;
};

type TallyCompanyCheck = {
  activeCompany: string;
  selectedCompany: string;
  companies: Array<{
    companyName: string;
    companyGuid?: string;
    accessCompanyId?: string;
    financialYear?: string | null;
    isActive?: boolean;
  }>;
  timings?: {
    activeCompanyMs?: number;
    companiesMs?: number;
    totalMs?: number;
  };
};

function isLiveTallyCompanyMatch(
  connection: LiveTallyConnection | null,
  connectionId: string,
  company: CompanyOption | null
) {
  const activeCompanyName = connection?.lastCompanyName?.trim() ?? "";
  return Boolean(
    connection?.id === connectionId &&
      company?.companyName &&
      activeCompanyName &&
      connection.tallyReachable === true &&
      connection.companyLoaded === true &&
      normalizeCompanyName(company.companyName) === normalizeCompanyName(activeCompanyName)
  );
}

type DashboardPayload = {
  cache?: { source: string; updatedAt: string; stale: boolean; refreshError?: string };
  scanSummary?: { complete: boolean; completed: number; total: number; elapsedMs: number; resumable?: boolean; reused?: number; failures: Array<{ ledgerName: string; error: string }> };
  setupRequired?: boolean;
  preview?: boolean;
  error?: string;
  company?: {
    companyName: string;
    status: string;
    tallyReachable: boolean;
    companyLoaded: boolean;
    lastHeartbeatAt: string | null;
  };
  kpis?: Record<string, number | null>;
  tabs?: {
    overduePayments?: unknown[];
    paymentFollowUps?: PaymentFollowUp[];
    cashDiscountTracker?: DebitNoteProposal[];
    debitNoteQueue?: DebitNoteProposal[];
  };
  narrationAnalysis?: NarrationAnalysisRow[];
  notes?: string[];
  // A paged dashboard (Kalika Local Agent 1.2.25+): the lists stay on the
  // connector and are read a page at a time; only the summary arrives here.
  paged?: boolean;
  dashboardId?: string;
  summary?: CollectionsSummary;
};

type ActiveView = "needsAction" | "followUps" | "done";
type PaymentFollowUpSort = "priority" | "most_overdue" | "highest_outstanding" | "oldest_invoice" | "customer";
type PendingProposalFilter = "all" | "ready" | "in_progress" | "failed";
type PendingProposalSort = "deadline_oldest" | "highest_recovery" | "invoice_oldest" | "customer";
type CreatedProposalFilter = "all" | "sent" | "not_sent" | "failed";
type CreatedProposalSort = "created_newest" | "highest_amount" | "invoice_newest" | "customer";

const DEFAULT_PAGE_SIZE = 25;

type CachedDashboardView = {
  companies: CompanyOption[];
  selectedConnectionId: string;
  selectedCompanyId: string;
  dashboard: DashboardPayload;
  lastScan: { scope: string; at: string; complete: boolean };
};

// Keep the last completed view in memory while the user moves around the app.
// The access identity is part of the key, and access invalidation clears every
// entry, so data cannot cross users, organizations, or permission revisions.
const dashboardViewCache = new Map<string, CachedDashboardView>();
registerAccessCache('collections-dashboard-view', () => dashboardViewCache.clear());

type CollectionsDashboardPageProps = {
  initialView?: ActiveView;
  showWorkflowSummary?: boolean;
};

function formatMoney(value?: number | null) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    // Cash-discount reversals can have a real paise component (for example,
    // ₹10,000 recorded net of a 1% discount requires a ₹101.01 debit note).
    // Do not visually round the amount that will be posted to Tally.
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function sumRecoverable(values: DebitNoteProposal[]) {
  return values.reduce((total, item) => total + (Number(item.recoverableAmount) || 0), 0);
}

function statusClass(value?: string) {
  if (value === "created_in_tally") return "border-emerald-250 bg-emerald-50 text-emerald-800";
  if (value === "queued_in_tally" || value === "approved") return "border-amber-250 bg-amber-50 text-amber-800";
  if (value === "failed") return "border-red-250 bg-red-50 text-red-800";
  return "border-slate-200 bg-white text-slate-500";
}

function messageStatusClass(value?: string | null) {
  if (value === "sent") return "border-emerald-250 bg-emerald-50 text-emerald-800";
  if (value === "failed") return "border-red-255 bg-red-50 text-red-800";
  return "border-slate-200 bg-white text-slate-500";
}

function followUpStatusClass(status: PaymentFollowUp["followUpStatus"]) {
  if (status === "escalate") return "border-red-200 bg-red-50 text-red-700";
  if (status === "needs_review") return "border-violet-200 bg-violet-50 text-violet-800";
  return "border-sky-200 bg-sky-50 text-sky-800";
}

function followUpStatusLabel(status: PaymentFollowUp["followUpStatus"]) {
  if (status === "escalate") return "Escalate";
  if (status === "needs_review") return "Needs review";
  return "Needs follow-up";
}


// Unchanged results keep the current view (no reload, no flicker). The
// revision covers every list, so a paged dashboard needs no rows to compare.
function paymentFollowUpDataKey(payload: DashboardPayload | null) {
  return collectionsRevision(payload);
}

function isCreatedDebitNote(proposal: DebitNoteProposal) {
  return proposal.status === "created_in_tally";
}

function proposalInvoiceKey(proposal: DebitNoteProposal) {
  return `${normalizeCompanyName(proposal.partyLedgerName)}|${normalizeCompanyName(proposal.linkedInvoiceNumber)}`;
}

function shortText(value?: string | null, fallback = "-") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeCompanyName(value?: string | null) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function issueLabel(proposal: DebitNoteProposal) {
  if (proposal.lastError) return "Tally action failed";
  if (proposal.status === "queued_in_tally" || proposal.status === "approved") return "Creating debit note";
  if (proposal.issueType === "unpaid_discount_tier_reversal") return "Discount period ended";
  if (proposal.issueType === "invoice_unpaid") return "Payment still outstanding";
  if (proposal.issueType === "partial_unpaid") return "Payment still partly outstanding";
  return "Collect existing invoice balance";
}

function conciseTermsLabel(proposal: DebitNoteProposal) {
  const terms = proposal.cashDiscountAnalysis?.terms ?? [];
  if (terms.length > 0) {
    return terms.map((term) => `${term.ratePercent}% / ${term.eligibilityDays} days`).join(" → ");
  }
  return proposal.cashDiscountAnalysis?.termsLabel || proposal.cashDiscountRuleName || "Fixed cash-discount rule";
}

function canCreateInTally(proposal: DebitNoteProposal) {
  if (proposal.canCreateDebitNote === false) return false;
  return ["draft", "pending_approval", "failed"].includes(proposal.status);
}

function messageLabel(proposal: DebitNoteProposal) {
  if (needsUpdatedPdfDelivery(proposal)) return "Send updated PDF";
  if (proposal.communicationStatus === "sent") return "Submitted";
  if (proposal.communicationStatus === "drafted") return "Verify submission";
  if (proposal.communicationStatus === "failed") return "Retry";
  if (!proposal.partyPhone) return "Add number";
  return "Send PDF";
}

function needsUpdatedPdfDelivery(proposal: DebitNoteProposal) {
  const sentAt = proposal.communicationSentAt ? Date.parse(proposal.communicationSentAt) : Number.NaN;
  const exportedAt = proposal.nativeTallyPdf?.exportedAt ? Date.parse(proposal.nativeTallyPdf.exportedAt) : Number.NaN;
  return proposal.communicationStatus === "sent" && Number.isFinite(sentAt) && Number.isFinite(exportedAt) && exportedAt > sentAt;
}

function getTenDigitPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return null;
}

function ContactMeta({ proposal }: { proposal: DebitNoteProposal }) {
  const items = [proposal.partyEmail, proposal.partyPhone, proposal.partyGstin].filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="mt-1 max-w-[280px] truncate text-xs text-[#8a7f72]">
      {items.join(" / ")}
    </div>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#e5ddd0] bg-white shadow-[0_2px_8px_rgba(0,0,0,0.02)]">
      <div className="flex flex-col gap-2 border-b border-[#e5ddd0] bg-[#fcfbfa]/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between rounded-t-2xl">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#1a1a1a]">{title}</h3>
          {description ? <p className="mt-0.5 text-[11px] font-semibold text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function SummaryCard({ count, label }: { count: number | string; label: string }) {
  return (
    <div className="rounded-xl border border-[#e0d8cc] bg-white px-4 py-3">
      <div className="text-xs font-medium text-[#5a5046]">{label}</div>
      <div className="mt-2 text-xl font-semibold tabular-nums tracking-tight text-[#1a1a1a] sm:text-2xl">{count}</div>
    </div>
  );
}

function PaginationControls({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(total, safePage * pageSize);

  return (
    <div className="flex flex-col gap-2 border-t border-[#e5ddd0] bg-[#fcfbfa] px-3 py-2.5 text-[11px] font-semibold text-slate-500 sm:flex-row sm:items-center sm:justify-between">
      <span className="tabular-nums">Showing {start}–{end} of {total}</span>
      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <label className="flex items-center gap-2">
          <span className="hidden sm:inline">Rows</span>
          <select
            aria-label="Rows per page"
            className="h-8 rounded-lg border border-[#ddd3c5] bg-white px-2 text-[11px] font-bold text-[#5a5046] outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            value={pageSize}
          >
            {[25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <span className="min-w-[72px] text-center tabular-nums">Page {safePage} of {pageCount}</span>
        <button
          aria-label="Previous page"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#ddd3c5] bg-white text-[#5a5046] transition hover:bg-[#f7f4ee] disabled:cursor-not-allowed disabled:opacity-35"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
          type="button"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          aria-label="Next page"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#ddd3c5] bg-white text-[#5a5046] transition hover:bg-[#f7f4ee] disabled:cursor-not-allowed disabled:opacity-35"
          disabled={safePage >= pageCount}
          onClick={() => onPageChange(safePage + 1)}
          type="button"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ListControls({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  filterLabel,
  filterOptions,
  sort,
  onSortChange,
  sortOptions,
  action,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  filter: string;
  onFilterChange: (value: string) => void;
  filterLabel: string;
  filterOptions: Array<{ value: string; label: string }>;
  sort: string;
  onSortChange: (value: string) => void;
  sortOptions: Array<{ value: string; label: string }>;
  action?: ReactNode;
}) {
  const controlClass = "h-9 rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-medium text-[#5a5046] outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100";

  return (
    <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <label className="relative block w-full sm:max-w-[360px]">
        <span className="sr-only">Search customer or invoice</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          className="h-9 w-full rounded-xl border border-[#e5ddd0] bg-white pl-9 pr-3 text-xs font-semibold text-[#1a1a1a] outline-none transition placeholder:text-slate-400 focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search customer or invoice"
          type="search"
          value={query}
        />
      </label>
      <div className="flex min-w-0 flex-wrap justify-end gap-2">
        <select
          aria-label={filterLabel}
          className={`${controlClass} min-w-0 flex-1 sm:w-[150px] sm:flex-none`}
          onChange={(event) => onFilterChange(event.target.value)}
          value={filter}
        >
          {filterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <select
          aria-label="Sort rows"
          className={`${controlClass} min-w-0 flex-1 sm:w-[180px] sm:flex-none`}
          onChange={(event) => onSortChange(event.target.value)}
          value={sort}
        >
          {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {action}
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-[#e5ddd0] bg-white px-4 py-12 text-center text-xs font-semibold text-slate-400">
      {children}
    </div>
  );
}

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || `Request failed with status ${response.status}`;
}

function wait(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function CollectionsDashboardPage({
  initialView = "needsAction",
  showWorkflowSummary = true,
}: CollectionsDashboardPageProps = {}) {
  const {snapshot:accessSnapshot,enforcementRequired,loading:accessLoading,error:accessError}=useAccess();
  const accessReady = collectionsAccessReady({ loading: accessLoading, error: accessError, enforcementRequired, snapshot: accessSnapshot });
  const [accessEpoch, setAccessEpoch] = useState(accessCacheEpoch);
  const isDedicatedFollowUpsPage = initialView === "followUps" && !showWorkflowSummary;
  const dashboardCacheKey = `${accessSnapshot?.member.user_id ?? 'pending'}:${accessSnapshot?.organizationId ?? ''}:${accessSnapshot?.revision ?? 0}:${isDedicatedFollowUpsPage ? 'follow-ups' : 'discounts'}`;
  const initialCachedView = dashboardViewCache.get(dashboardCacheKey);
  const [companies, setCompanies] = useState<CompanyOption[]>(() => initialCachedView?.companies ?? []);
  const [selectedConnectionId, setSelectedConnectionId] = useState(() => initialCachedView?.selectedConnectionId ?? "");
  const [selectedCompanyId, setSelectedCompanyId] = useState(() => initialCachedView?.selectedCompanyId ?? "");
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(() => initialCachedView?.dashboard ?? null);
  const dashboardRef = useRef<DashboardPayload | null>(dashboard);
  dashboardRef.current = dashboard;
  const [liveTallyConnection, setLiveTallyConnection] = useState<LiveTallyConnection | null>(null);
  const [checkingLiveTallyCompany, setCheckingLiveTallyCompany] = useState(true);
  const [activeView, setActiveView] = useState<ActiveView>(initialView);
  const [paymentFollowUpSort, setPaymentFollowUpSort] = useState<PaymentFollowUpSort>("priority");
  const [pendingQuery, setPendingQuery] = useState("");
  const [pendingFilter, setPendingFilter] = useState<PendingProposalFilter>("all");
  const [pendingSort, setPendingSort] = useState<PendingProposalSort>("deadline_oldest");
  const [createdQuery, setCreatedQuery] = useState("");
  const [createdFilter, setCreatedFilter] = useState<CreatedProposalFilter>("all");
  const [createdSort, setCreatedSort] = useState<CreatedProposalSort>("created_newest");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pendingPage, setPendingPage] = useState(1);
  const [createdPage, setCreatedPage] = useState(1);
  const [followUpsPage, setFollowUpsPage] = useState(1);
  const [focusedReminder,setFocusedReminder]=useState('');
  const [remindersDue,setRemindersDue]=useState<number|null>(null);
  const [reminderToolbar,setReminderToolbar]=useState<HTMLDivElement|null>(null);
  const [reminderTab,setReminderTab]=useState<'outstanding'|'due'|'pipelines'|'history'>('due');
  const [reminderInvoice, setReminderInvoice] = useState<{partyLedgerName:string;linkedInvoiceNumber:string|null;linkedInvoiceDate:string|null;partyPhone:string|null}|null>(null);
  const [selectedFollowUpIds,setSelectedFollowUpIds]=useState<Set<string>>(()=>new Set());
  const [followUpBulkMode,setFollowUpBulkMode]=useState<'enroll'|'send_once'|null>(null);
  const [followUpBulkPhones,setFollowUpBulkPhones]=useState<Record<string,string>>({});
  // Selected rows are loaded by id when an action needs them (they may be on other pages).
  const [followUpBulkRows,setFollowUpBulkRows]=useState<PaymentFollowUp[]>([]);
  const [bulkMessageable,setBulkMessageable]=useState<DebitNoteProposal[]>([]);
  const [followUpBulkBusy,setFollowUpBulkBusy]=useState(false);
  const [followUpBulkSavePhones,setFollowUpBulkSavePhones]=useState(true);
  const [loading, setLoading] = useState(() => !initialCachedView);
  const [lastScan, setLastScan] = useState<{scope:string; at:string; complete:boolean} | null>(() => initialCachedView?.lastScan ?? null);
  const [approvingId, setApprovingId] = useState("");
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkReview,setBulkReview]=useState<DebitNoteProposal[]|null>(null);
  const [bulkPhase,setBulkPhase]=useState<'review'|'posting'|'results'>('review');
  const [bulkAcknowledged,setBulkAcknowledged]=useState(false);
  const [bulkStates,setBulkStates]=useState<Record<string,{status:'waiting'|'creating'|'created'|'uncertain';error?:string}>>({});
  const [bulkProgress,setBulkProgress]=useState<Record<string,string>>({});
  const [bulkResultMessage,setBulkResultMessage]=useState('');
  const bulkRunning=useRef(false);
  const bulkScope=useRef('');
  const currentBulkScope=useRef('');

  const [sendingWhatsappId, setSendingWhatsappId] = useState("");
  const [preparingNativePdfId, setPreparingNativePdfId] = useState("");
  const [bulkSendingWhatsapp, setBulkSendingWhatsapp] = useState(false);
  // Debit notes just submitted to WhatsApp stay locked (spinner, no resend)
  // until the refreshed list shows their new status, or for at most a minute.
  const [sentLocks, setSentLocks] = useState<Map<string, number>>(() => new Map());
  const lockSentProposal = (id: string) => setSentLocks((current) => new Map(current).set(id, Date.now()));
  const [selectedPendingIds, setSelectedPendingIds] = useState<Set<string>>(() => new Set());
  const [selectedCreatedIds, setSelectedCreatedIds] = useState<Set<string>>(() => new Set());
  const [reviewingProposal, setReviewingProposal] = useState<DebitNoteProposal | null>(null);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [whatsappDialogProposals, setWhatsappDialogProposals] = useState<DebitNoteProposal[]>([]);
  const [whatsappPhoneInputs, setWhatsappPhoneInputs] = useState<Record<string, string>>({});
  const [whatsappSaveToTally, setWhatsappSaveToTally] = useState(true);
  const [whatsappDialogSending, setWhatsappDialogSending] = useState(false);
  // "info" = work in progress (shown with a spinner); "notice" = finished, but
  // the user should read it (no spinner).
  const [message, setMessage] = useState<{ tone: "success" | "error" | "info" | "notice"; text: string } | null>(null);
  const initialLoadStartedRef = useRef(false);
  const activeScanRef = useRef<AbortController | null>(null);
  const [interactiveScan, setInteractiveScan] = useState(false);
  const followupRevisionRef = useRef<{ scope: string; revision: number | null }>({ scope: "", revision: null });
  useEffect(() => () => activeScanRef.current?.abort(new Error("Cash Discount page closed.")), []);
  const lastLoadedConnectionRef = useRef("");
  useEffect(() => {
    const reset = () => {
      activeScanRef.current?.abort(new DOMException('Access changed.', 'AbortError'));
      activeScanRef.current = null;
      initialLoadStartedRef.current = false;
      lastLoadedConnectionRef.current = '';
      setCompanies([]); setSelectedCompanyId(''); setSelectedConnectionId('');
      setLiveTallyConnection(null); setDashboard(null);
      setSelectedPendingIds(new Set()); setSelectedCreatedIds(new Set());
      setMessage(null); setCheckingLiveTallyCompany(true);
      setAccessEpoch(accessCacheEpoch());
    };
    window.addEventListener('kalika-access-invalidated', reset);
    return () => window.removeEventListener('kalika-access-invalidated', reset);
  }, []);

  const selectedCompany = useMemo(
    () =>
      companies.find((company) => company.id === selectedCompanyId) ??
      companies.find((company) => company.connectionId === selectedConnectionId) ??
      companies[0] ??
      null,
    [companies, selectedCompanyId, selectedConnectionId]
  );
  const allowed=useActionAccess(selectedCompany?.accessCompanyId);
  useEffect(()=>{setReminderInvoice(null);setRemindersDue(null);setReminderTab('due');},[selectedConnectionId,selectedCompanyId]);

  const loadCompanies = useCallback(async () => {
    const requestEpoch = accessCacheEpoch();
    const connectionId =
      readPreferredTallyConnectionId() || selectedConnectionId;
    if (!connectionId) {
      setCompanies([]);
      setSelectedCompanyId("");
      setSelectedConnectionId("");
      setLiveTallyConnection(null);
      setCheckingLiveTallyCompany(false);
      return { companies: [] as CompanyOption[], liveConnection: null as LiveTallyConnection | null };
    }
    setCheckingLiveTallyCompany(true);
    try {
      // Match Finora's fast path: ask the local Electron connector which
      // company is open and read the available companies directly from Tally.
      // No Supabase company/status request blocks this bootstrap.
      const payload = await runCashDiscountLiveRequest<TallyCompanyCheck>({
        connectionId,
        companyName: "",
        operation: "company_check",
      });
      if (requestEpoch !== accessCacheEpoch()) throw new DOMException('Access changed.', 'AbortError');
      const activeCompanyName = String(payload.activeCompany ?? "").trim();
      const nextCompanies = uniqueCompanyOptions((payload.companies ?? []).map((company) => ({
        id: `${connectionId}::${encodeURIComponent(company.companyGuid||company.companyName)}::${company.financialYear||''}`,
        accessCompanyId: company.accessCompanyId,
        companyGuid: company.companyGuid,
        connectionId,
        companyName: company.companyName,
        financialYear: company.financialYear ?? "",
        status: "company_loaded",
        bridgeConnected: true,
        tallyReachable: true,
        companyLoaded: true,
        bankAccountCount: null,
        lastSyncAt: null,
        lastHeartbeatAt: null,
        lastError: null,
      })));
      const activeCompany = nextCompanies.find(
        (company) => normalizeCompanyName(company.companyName) === normalizeCompanyName(activeCompanyName)
      ) ?? nextCompanies[0] ?? null;
      const nextConnection: LiveTallyConnection | null = activeCompanyName ? {
        id: connectionId,
        status: "company_loaded",
        lastCompanyName: activeCompanyName,
        companyLoaded: true,
        tallyReachable: true,
      } : null;
      setCompanies(nextCompanies);
      setLiveTallyConnection(nextConnection);
      setSelectedCompanyId(activeCompany?.id || "");
      setSelectedConnectionId(activeCompany?.connectionId || connectionId);
      return { companies: nextCompanies, liveConnection: nextConnection };
    } finally {
      setCheckingLiveTallyCompany(false);
    }
  }, [selectedConnectionId]);

  const pollCommand = useCallback(async (
    connectionId: string,
    commandId: string,
    options?: { timeoutSeconds?: number; pendingMessage?: string }
  ) => {
    // A native PDF is rendered by Tally after the command has been received.
    // Give that one bounded extra time instead of reporting a false timeout
    // while the bridge is still within its own 60-second safety limit.
    const timeoutSeconds = options?.timeoutSeconds ?? 45;
    const maximumAttempts = Math.max(1, timeoutSeconds * 2);
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      // The optimized connector usually finishes Tally work in under 250 ms.
      // Poll quickly at first, then settle at one request per second.
      await wait(Math.min(1000, 250 * (2 ** Math.min(attempt, 2))));
      const response = await apiFetch(
        `/api/tally/connections/${connectionId}/commands/${commandId}`,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as { command?: TallyCommand | null };
      const command = payload.command?.id === commandId ? payload.command : null;
      if (command?.status === "succeeded") return command;
      if (command?.status === "failed" || command?.status === "canceled") {
        throw new Error(command.error || "Tally command failed.");
      }
    }
    throw new Error(
      options?.pendingMessage ?? "The Tally command is still pending. Check the connector status, then refresh."
    );
  }, []);

  const refreshTallyOpenBills = useCallback(
    async (connectionId: string, companyName?: string | null, financialYear?: string | null, companyGuid?: string | null, resume = false, forceRefresh = false, quiet = false) => {
      const resolvedCompanyName = String(companyName ?? "").trim();
      if (!connectionId || !resolvedCompanyName) {
        throw new Error("Select the live Tally company before refreshing Cash Discounts.");
      }
      if(enforcementRequired&&(!accessSnapshot||!canAccess(accessSnapshot,isDedicatedFollowUpsPage?'followups.prepare':'discounts.prepare'))) {
        const response=await apiFetch(`/api/collections/${isDedicatedFollowUpsPage?'follow-ups':'dashboard'}?${new URLSearchParams({connectionId,companyName:resolvedCompanyName,financialYear:financialYear||''})}`,{cache:'no-store'});
        if(!response.ok)throw new Error(await readError(response));
        return await response.json() as DashboardPayload;
      }
      if (activeScanRef.current) throw new Error("A Cash Discount scan is already running. Wait or cancel it before refreshing.");
      const controller = new AbortController();
      activeScanRef.current = controller;
      if (!quiet) setInteractiveScan(true);
      if (!quiet) setMessage({ tone: "info", text: "Checking customer dues…" });
      const requestEpoch = accessCacheEpoch();
      try { let result = await runCashDiscountLiveRequest<DashboardPayload>({
        signal: controller.signal,
        connectionId,
        companyName: resolvedCompanyName,
        companyGuid,
        financialYear,
        operation: isDedicatedFollowUpsPage ? "followups_scan" : "scan",
        // paged: the connector keeps the lists and this page reads them a page at a time.
        payload: { resume, forceRefresh, paged: true, moduleName: isDedicatedFollowUpsPage ? "followups" : "cashDiscount" },
        onProgress: (progressMessage) => {
          if (!quiet) setMessage({ tone: "info", text: progressMessage });
        },
        onPreview: (preview) => {
          if (!quiet) {
            setDashboard(preview as DashboardPayload);
            setMessage({ tone: "info", text: "Live Cash Discount results are ready. Confirming debit-note history…" });
          }
        },
      });
        if (result.cache?.stale && !forceRefresh && requestEpoch === accessCacheEpoch()) {
          if (!quiet) setDashboard(result);
          if (!quiet) setMessage({ tone: 'info', text: 'Showing saved results · Updating from Tally…' });
          const saved = result;
          try {
            const fresh = await runCashDiscountLiveRequest<DashboardPayload>({
              signal: controller.signal, connectionId, companyName: resolvedCompanyName, companyGuid, financialYear,
              operation: isDedicatedFollowUpsPage ? 'followups_scan' : 'scan', payload: { forceRefresh: true, paged: true, moduleName: isDedicatedFollowUpsPage ? "followups" : "cashDiscount" },
              onProgress: text => { if (!quiet) setMessage({ tone: 'info', text: `Showing saved results · ${text}` }); },
            });
            if (fresh.scanSummary?.complete === false) throw new Error('The refresh was incomplete.');
            result = fresh;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            result = { ...saved, cache: { ...saved.cache!, refreshError: error instanceof Error ? error.message : 'Refresh failed.' } };
          }
        }
        if (!quiet) setLastScan({scope:`${connectionId}|${resolvedCompanyName}|${financialYear || ''}`,at:result.cache?.updatedAt ? new Date(result.cache.updatedAt).toLocaleString() : new Date().toLocaleTimeString(),complete:result.scanSummary?.complete !== false});
        return result;
      } finally {
        if (activeScanRef.current === controller) activeScanRef.current = null;
        if (!quiet) setInteractiveScan(false);
      }
    },
    [enforcementRequired,accessSnapshot,isDedicatedFollowUpsPage]
  );

  // Returns the refreshed dashboard (or null when there is none to refresh).
  const refreshCreatedDebitNotesFromStore = useCallback(async (connectionId: string): Promise<DashboardPayload | null> => {
    if (isDedicatedFollowUpsPage) return null;
    // A paged dashboard is re-analysed on the connector from its customer dues
    // with the latest debit-note history (no Tally scan); the lists reload.
    if (dashboardRef.current?.paged) {
      const next = await refreshTallyOpenBills(connectionId, selectedCompany?.companyName, selectedCompany?.financialYear, selectedCompany?.companyGuid, false, false, true);
      if (next.scanSummary?.complete === false) throw new Error('The refresh was incomplete.');
      setDashboard(next);
      return next;
    }
    const response = await apiFetch(
      `/api/collections/debit-note-proposals?${new URLSearchParams({
        connectionId,
        status: "created_in_tally",
        companyName: selectedCompany?.companyName||'',
        financialYear: selectedCompany?.financialYear||'',
      }).toString()}`,
      { cache: "no-store" }
    );
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as { proposals?: DebitNoteProposal[] };
    const created = payload.proposals ?? [];
    const createdKeys = new Set(created.map(proposalInvoiceKey));

    // A whole dashboard (older connector) is updated here, as before.
    const current = dashboardRef.current;
    if (!current) return null;
    const existing = current.tabs?.debitNoteQueue ?? [];
    const pending = existing.filter(
      (proposal) => !isCreatedDebitNote(proposal) && !createdKeys.has(proposalInvoiceKey(proposal))
    );
    const proposals = [...pending, ...created];
    const next: DashboardPayload = {
      ...current,
      kpis: {
        ...(current.kpis ?? {}),
        cdExpired: pending.length,
        debitNotesPendingApproval: pending.length,
        needsAttention: pending.length,
        totalOutstanding: sumRecoverable(pending),
        createdDebitNotes: created.length,
        createdDebitNoteAmount: sumRecoverable(created),
      },
      tabs: {
        ...(current.tabs ?? {}),
        cashDiscountTracker: proposals,
        debitNoteQueue: proposals,
      },
    };
    dashboardRef.current = next;
    setDashboard(next);
    return next;
  }, [selectedCompany?.companyName,selectedCompany?.financialYear,selectedCompany?.companyGuid,isDedicatedFollowUpsPage,refreshTallyOpenBills]);

  const refreshAll = useCallback(
    async (options?: { quiet?: boolean; refreshTally?: boolean }) => {
      if (!accessReady) return;
      const requestEpoch = accessCacheEpoch();
      if (activeScanRef.current) return;
      try {
        if (!options?.quiet) setLoading(true);
        if (!options?.quiet) setMessage(null);
        const bootstrap = await loadCompanies();
        const nextCompanies = bootstrap.companies;
        let company =
          nextCompanies.find((item) => item.id === selectedCompanyId) ??
          nextCompanies.find((item) => item.connectionId === selectedConnectionId) ??
          nextCompanies[0] ??
          null;
        let connectionId = company?.connectionId || selectedConnectionId || "";
        const liveConnection = bootstrap.liveConnection;

        // The live company in Tally is the source of truth. On every full
        // refresh, move the initial/stale Kalika selection to the company that
        // Tally is actually open to before issuing any read command.
        const activeCompanyName = liveConnection?.lastCompanyName?.trim() ?? "";
        const activeCompany = activeCompanyName
          ? nextCompanies.find(
              (item) =>
                item.connectionId === connectionId &&
                normalizeCompanyName(item.companyName) === normalizeCompanyName(activeCompanyName)
            ) ?? null
          : null;

        if (activeCompany) {
          company = activeCompany;
          connectionId = activeCompany.connectionId;
          setSelectedCompanyId(activeCompany.id);
          setSelectedConnectionId(activeCompany.connectionId);
        } else if (company) {
          setSelectedCompanyId(company.id);
          setSelectedConnectionId(connectionId);
        }

        // Never calculate from a dropdown value alone. A stale, unloaded, or
        // mismatched live context must leave the dashboard empty.
        if (!isLiveTallyCompanyMatch(liveConnection, connectionId, company)) {
          setDashboard(null);
          lastLoadedConnectionRef.current = "";
          return;
        }

        // Set this before the asynchronous Tally scan so the selection effect
        // does not start a second, overlapping scan for the same company.
        lastLoadedConnectionRef.current = `${connectionId}::${company?.companyName ?? ""}`;
        const nextDashboard = await refreshTallyOpenBills(connectionId, company?.companyName, company?.financialYear, company?.companyGuid, false, options?.refreshTally === true, options?.quiet === true);
        if (requestEpoch !== accessCacheEpoch()) return;
        if (nextDashboard.scanSummary?.complete === false) {
          if (!options?.quiet) setMessage({ tone: 'error', text: 'Refresh incomplete. Any previously displayed complete results have been kept.' });
          setDashboard(current => current?.scanSummary?.complete === true ? current : nextDashboard);
          return;
        }
        setDashboard((current) => options?.quiet && isDedicatedFollowUpsPage && paymentFollowUpDataKey(current) === paymentFollowUpDataKey(nextDashboard)
          ? current
          : nextDashboard);
        if (!options?.quiet) setMessage(null);
        lastLoadedConnectionRef.current = `${connectionId}::${company?.companyName ?? ""}`;
        const nextLastScan = {
          scope: `${connectionId}|${company?.companyName ?? ''}|${company?.financialYear ?? ''}`,
          at: nextDashboard.cache?.updatedAt
            ? new Date(nextDashboard.cache.updatedAt).toLocaleString()
            : new Date().toLocaleTimeString(),
          complete: true,
        };
        setLastScan(nextLastScan);
        dashboardViewCache.set(dashboardCacheKey, {
          companies: nextCompanies,
          selectedConnectionId: connectionId,
          selectedCompanyId: company?.id ?? '',
          dashboard: nextDashboard,
          lastScan: nextLastScan,
        });
      } catch (error) {
        if (requestEpoch !== accessCacheEpoch()) return;
        if (!options?.quiet) setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not load Cash Discounts data." });
      } finally {
        if (requestEpoch === accessCacheEpoch()) setLoading(false);
      }
    },
    [accessReady, dashboardCacheKey, isDedicatedFollowUpsPage, loadCompanies, refreshTallyOpenBills, selectedCompanyId, selectedConnectionId]
  );

  async function createDebitNoteForProposal(proposal: DebitNoteProposal) {
    if(!allowed('discounts.post'))throw new Error('Your role cannot create debit notes.');
    const companyName = selectedCompany?.companyName ?? proposal.companyName ?? "";
    if (!selectedConnectionId || !companyName) throw new Error("The live Tally company is not selected.");
    const proposalIdentity = {
      connectionId: proposal.connectionId,
      companyName,
      financialYear: selectedCompany?.financialYear ?? proposal.financialYear,
      partyLedgerName: proposal.partyLedgerName,
      linkedInvoiceNumber: proposal.linkedInvoiceNumber,
      recoverableAmount: proposal.recoverableAmount,
    };

    return runCashDiscountLiveRequest<{ proposal?: DebitNoteProposal }>({
      connectionId: selectedConnectionId,
      companyName,
      companyGuid: selectedCompany?.companyGuid,
      financialYear: selectedCompany?.financialYear ?? proposal.financialYear,
      operation: "create_debit_note",
      proposal: proposalIdentity,
      onProgress: (progressMessage) => {
        setBulkProgress(previous => ({...previous,[proposal.id]:progressMessage}));
        setMessage({ tone: "info", text: progressMessage });
      },
    });
  }

  async function approveProposal(proposal: DebitNoteProposal) {
    if (activeScanRef.current) {
      setMessage({ tone: "error", text: "Wait for the current scan to finish before creating a debit note." });
      return;
    }
    if (!tallyCompanyVerified) {
      setMessage({ tone: "error", text: `Tally is open to ${activeTallyCompanyName || "another company"}. Switch it to ${selectedCompany?.companyName || "the selected company"}, refresh, then create the debit note.` });
      return;
    }
    const id = proposal.id;
    try {
      setApprovingId(id);
      setReviewingProposal(null);
      setReviewAcknowledged(false);
      setMessage({ tone: "info", text: "Creating debit note in Tally..." });
      await createDebitNoteForProposal(proposal);
      if (selectedConnectionId) {
        try {
          await refreshCreatedDebitNotesFromStore(selectedConnectionId);
        } catch {
          setMessage({ tone: "notice", text: "Debit note created in Tally. Saved history could not be refreshed; do not create it again." });
          setActiveView("done");
          return;
        }
      }
      setActiveView("done");
      setMessage({ tone: "success", text: "Debit note created in Tally." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not approve proposal." });
    } finally {
      setApprovingId("");
    }
  }

  async function sendWhatsappForProposal(
    proposal: DebitNoteProposal,
    options?: { recipientPhone?: string; savePhoneToTally?: boolean; connectionId?: string }
  ) {
    if(!allowed('discounts.export'))throw new Error('Your role cannot send financial documents.');
    const response = await apiFetch(`/api/collections/debit-note-proposals/${proposal.id}/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options ?? {}),
    });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json().catch(() => ({}))) as WhatsappSendResult;
  }

  async function prepareNativeTallyPdf(proposal: DebitNoteProposal) {
    if (proposal.nativeTallyPdfVerified) return proposal;
    const response = await apiFetch(`/api/collections/debit-note-proposals/${proposal.id}/native-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: selectedConnectionId }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json().catch(() => ({}))) as {
      command?: TallyCommand;
      ready?: boolean;
      proposal?: DebitNoteProposal;
    };
    const command = payload.command;
    if (command?.id) {
      const commandConnectionId = command.connectionId ?? selectedConnectionId;
      if (!commandConnectionId) throw new Error("The Tally PDF export command has no connection.");
      await pollCommand(commandConnectionId, command.id);
    } else if (!payload.ready) {
      throw new Error("The native Tally PDF export could not be started.");
    }
    // A whole dashboard is patched from the store after each PDF, as before.
    // A paged one is re-analysed once, after all messages are sent.
    if (selectedConnectionId && !dashboardRef.current?.paged) await refreshCreatedDebitNotesFromStore(selectedConnectionId);
    return { ...(payload.proposal ?? proposal), nativeTallyPdfVerified: true };
  }

  async function openWhatsappDialog(proposalsToSend: DebitNoteProposal[]) {
    const sendable = proposalsToSend.filter(
      (proposal) => proposal.communicationStatus !== "sent" || needsUpdatedPdfDelivery(proposal)
    );
    if (sendable.length === 0) return;
    // Opening the dialog must be immediate. In particular, a user needs to
    // see and enter a missing phone number before we ask Tally for a PDF.
    const nextInputs: Record<string, string> = {};
    for (const proposal of sendable) {
      // Keep the number shown to the user in dialog state. PDF preparation
      // can return a raw proposal row before its contact field is persisted.
      nextInputs[proposal.id] = getTenDigitPhone(proposal.partyPhone ?? "") ?? "";
    }
    setWhatsappDialogProposals(sendable);
    setWhatsappPhoneInputs(nextInputs);
    setWhatsappSaveToTally(true);
    setMessage(null);
  }

  async function downloadNativeTallyPdf(proposal: DebitNoteProposal) {
    try {
      if(!allowed('discounts.export'))throw new Error('Your role cannot download financial documents.');
      const response = await apiFetch(`/api/collections/debit-note-proposals/${proposal.id}/native-pdf?download=1`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const pdf = await response.blob();
      if (pdf.size === 0) throw new Error("The verified Tally PDF was empty.");
      const objectUrl = URL.createObjectURL(pdf);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${proposal.tallyVoucherNumber || "debit-note"}.pdf`;
      link.rel = "noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not download the official Tally PDF." });
    }
  }

  async function sendWhatsappFromDialog() {
    if (whatsappDialogProposals.length === 0) return;
    let acceptedCount = 0;

    const requestedPhones = new Map<string, { phone: string; saveToTally: boolean }>();
    for (const proposal of whatsappDialogProposals) {
      const phone = getTenDigitPhone(whatsappPhoneInputs[proposal.id] ?? proposal.partyPhone ?? "");
      if (!phone) {
        setMessage({ tone: "error", text: "Enter valid 10-digit WhatsApp numbers for all selected debit notes." });
        return;
      }
      requestedPhones.set(proposal.id, {
        phone,
        // Existing dashboard contact data was recovered from the synced Tally
        // ledger, so it does not need an unnecessary alter-ledger command.
        saveToTally: whatsappSaveToTally && !getTenDigitPhone(proposal.partyPhone ?? ""),
      });
    }

    try {
      setWhatsappDialogSending(true);
      setBulkSendingWhatsapp(whatsappDialogProposals.length > 1);
      const preparedProposals: DebitNoteProposal[] = [];
      for (const proposal of whatsappDialogProposals) {
        if (!proposal.nativeTallyPdfVerified) {
          setPreparingNativePdfId(proposal.id);
          preparedProposals.push(await prepareNativeTallyPdf(proposal));
        } else {
          preparedProposals.push(proposal);
        }
      }
      const pendingTallyPhoneSaves: Array<{ ledgerName: string; phone: string; commandId: string; connectionId: string }> = [];
      let requestedTallyPhoneSaves = 0;
      let failedTallyPhoneQueues = 0;
      for (const proposal of preparedProposals) {
        setSendingWhatsappId(proposal.id);
        const requestedPhone = requestedPhones.get(proposal.id);
        if (!requestedPhone) throw new Error("The WhatsApp number was not available for this debit note.");
        const sendResult = await sendWhatsappForProposal(
          proposal,
          {
            recipientPhone: requestedPhone.phone,
            savePhoneToTally: requestedPhone.saveToTally,
            connectionId: selectedConnectionId,
          }
        );
        acceptedCount += 1;
        lockSentProposal(proposal.id);
        if (sendResult.verificationRequired) throw new Error(sendResult.error || 'Submission accepted; verify its saved status before resending.');
        if (requestedPhone.saveToTally && sendResult.phoneSaveCommandId && sendResult.phoneSaveConnectionId) {
          requestedTallyPhoneSaves += 1;
          pendingTallyPhoneSaves.push({
            ledgerName: proposal.partyLedgerName,
            phone: requestedPhone.phone,
            commandId: sendResult.phoneSaveCommandId,
            connectionId: sendResult.phoneSaveConnectionId,
          });
        } else if (requestedPhone.saveToTally) {
          requestedTallyPhoneSaves += 1;
          failedTallyPhoneQueues += 1;
        }
      }

      // WhatsApp has already been accepted at this point. Do not hold the
      // customer-facing dialog open while the optional Tally ledger update is
      // claimed, processed, re-synced, and re-read. That work is queued by the
      // API and the next refresh will show its final state.
      setMessage({
        tone: "success",
        text: `${
          preparedProposals.length === 1
            ? "WhatsApp message submitted to provider; delivery is not yet confirmed."
            : `${preparedProposals.length} WhatsApp messages submitted; delivery is not yet confirmed.`
        }${
          requestedTallyPhoneSaves === 0
            ? ""
            : failedTallyPhoneQueues === 0 && pendingTallyPhoneSaves.length === requestedTallyPhoneSaves
              ? ` ${requestedTallyPhoneSaves === 1 ? "Number save was" : "Number saves were"} queued for Tally.`
              : ` ${failedTallyPhoneQueues} number${failedTallyPhoneQueues === 1 ? " could" : "s could"} not be queued for Tally.`
        }`,
      });
      setWhatsappDialogProposals([]);
      setWhatsappPhoneInputs({});
      setSelectedCreatedIds(new Set());
      if (selectedConnectionId) {
        await refreshCreatedDebitNotesFromStore(selectedConnectionId).catch(() => {
          setMessage({ tone: "notice", text: "WhatsApp submission completed. Saved history could not be refreshed; do not resend automatically." });
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Submission stopped.";
      setMessage({ tone: "error", text: acceptedCount === 0
        ? `Nothing was sent. ${reason}`
        : `${acceptedCount} ${acceptedCount === 1 ? "message was" : "messages were"} submitted before this stopped. ${reason} Check their status before resending.` });
      if (selectedConnectionId) await refreshCreatedDebitNotesFromStore(selectedConnectionId).catch(() => undefined);
    } finally {
      setWhatsappDialogSending(false);
      setBulkSendingWhatsapp(false);
      setSendingWhatsappId("");
      setPreparingNativePdfId("");
    }
  }

  function chooseView(view: ActiveView) {
    setActiveView(view);
  }

  function changePageSize(nextPageSize: number) {
    setPageSize(nextPageSize);
    setPendingPage(1);
    setCreatedPage(1);
    setFollowUpsPage(1);
  }

  useEffect(() => {
    if (!accessReady) return;
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    void refreshAll({ quiet: Boolean(dashboardViewCache.get(dashboardCacheKey)) });
  }, [refreshAll, accessReady, accessEpoch, dashboardCacheKey]);

  useEffect(() => {
    if (!accessReady || !isDedicatedFollowUpsPage) return;
    let checking = false;
    const refreshIfChanged = async () => {
      if (document.visibilityState !== 'visible' || activeScanRef.current) return;
      const company = selectedCompany;
      if (!selectedConnectionId || !company || !isLiveTallyCompanyMatch(liveTallyConnection, selectedConnectionId, company)) return;
      if (checking) return;
      checking = true;
      try {
        const response = await apiFetch(`/api/tally/connections/${selectedConnectionId}/agent-status`, { cache: 'no-store' });
        if (!response.ok) return;
        const status = await response.json() as { datasets?: Array<{
          company_guid?: string; company_name?: string; financial_year?: string;
          cache_health?: { workflowRevisions?: { followups?: { revision?: number } | null } };
        }> };
        const dataset = (status.datasets ?? []).find((row) =>
          (!company.companyGuid || row.company_guid === company.companyGuid) &&
          (!company.financialYear || row.financial_year === company.financialYear) &&
          (!row.company_name || normalizeCompanyName(row.company_name) === normalizeCompanyName(company.companyName))
        );
        const revision = Number(dataset?.cache_health?.workflowRevisions?.followups?.revision);
        if (!Number.isFinite(revision) || revision <= 0) return;
        const scope = `${selectedConnectionId}|${company.companyGuid || company.companyName}|${company.financialYear || ''}`;
        const previous = followupRevisionRef.current;
        if (previous.scope !== scope || previous.revision === null) {
          followupRevisionRef.current = { scope, revision };
          return;
        }
        if (previous.revision === revision) return;
        const nextDashboard = await refreshTallyOpenBills(
          selectedConnectionId,
          company.companyName,
          company.financialYear,
          company.companyGuid,
          false,
          false,
          true,
        );
        // Record the revision even when the scan was incomplete: retrying the
        // same revision every 15 seconds kept Tally busy indefinitely. The next
        // Tally change (or a manual Refresh) tries again.
        followupRevisionRef.current = { scope, revision };
        if (nextDashboard.scanSummary?.complete === false) return;
        setDashboard((current) => paymentFollowUpDataKey(current) === paymentFollowUpDataKey(nextDashboard)
          ? current
          : nextDashboard);
        setLastScan({
          scope: `${selectedConnectionId}|${company.companyName}|${company.financialYear || ''}`,
          at: nextDashboard.cache?.updatedAt
            ? new Date(nextDashboard.cache.updatedAt).toLocaleString()
            : new Date().toLocaleTimeString(),
          complete: true,
        });
      } catch {
        // The current dashboard remains usable while a lightweight revision
        // check is unavailable. Manual Refresh remains the explicit fallback.
      } finally {
        checking = false;
      }
    };
    void refreshIfChanged();
    const timer = window.setInterval(() => void refreshIfChanged(), 15_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshIfChanged();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [accessReady, isDedicatedFollowUpsPage, liveTallyConnection, refreshTallyOpenBills, selectedCompany, selectedConnectionId]);

  useEffect(() => {
    setPendingPage(1);
    setCreatedPage(1);
    setFollowUpsPage(1);
  }, [selectedCompanyId]);

  useEffect(() => {
    setFollowUpsPage(1);
  }, [paymentFollowUpSort]);

  useEffect(() => {
    setPendingPage(1);
  }, [pendingFilter, pendingQuery, pendingSort]);

  useEffect(() => {
    setCreatedPage(1);
  }, [createdFilter, createdQuery, createdSort]);

  useEffect(() => {
    if (!accessReady) return;
    if (!selectedConnectionId) return;
    const company = selectedCompany;
    if (!isLiveTallyCompanyMatch(liveTallyConnection, selectedConnectionId, company)) {
      // A user can still choose another company to express their intent, but
      // no stale scan, cached result, or calculation may be shown for it.
      lastLoadedConnectionRef.current = "";
      setDashboard(null);
      setLoading(false);
      return;
    }
    const loadKey = `${selectedConnectionId}::${company?.companyName ?? ""}`;
    if (lastLoadedConnectionRef.current === loadKey) return;
    lastLoadedConnectionRef.current = loadKey;
    const requestEpoch = accessCacheEpoch();
    void (async () => {
      setLoading(true);
      setDashboard(null);
      try {
        // A company switch must read a new live snapshot. Loading the old saved
        // scan here can show bills belonging to the previously selected company.
        const nextDashboard = await refreshTallyOpenBills(selectedConnectionId, company?.companyName, company?.financialYear, company?.companyGuid);
        if (requestEpoch !== accessCacheEpoch()) return;
        setDashboard(nextDashboard);
        setMessage(null);
      } catch (error) {
        if (requestEpoch !== accessCacheEpoch()) return;
        setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not load Cash Discounts data." });
      } finally {
        if (requestEpoch === accessCacheEpoch()) setLoading(false);
      }
    })();
  }, [accessReady, liveTallyConnection, refreshTallyOpenBills, selectedCompany, selectedConnectionId]);

  // Lists are read a page at a time (from the connector for a paged dashboard,
  // from the dashboard itself otherwise); KPIs and counts come from its summary.
  const summary = useMemo(() => collectionsSummary(dashboard), [dashboard]);
  const collectionsRemote = useCallback<CollectionsRemote>((operation, payload) => runCashDiscountLiveRequest({
    connectionId: selectedConnectionId,
    companyName: selectedCompany?.companyName || '',
    companyGuid: selectedCompany?.companyGuid,
    financialYear: selectedCompany?.financialYear,
    operation,
    payload,
  }), [selectedConnectionId, selectedCompany?.companyName, selectedCompany?.companyGuid, selectedCompany?.financialYear]);
  // A held dashboard was replaced (newer check) or its access expired: re-check quietly.
  const onCollectionsExpired = useCallback(() => { void refreshAll({ quiet: true }); }, [refreshAll]);
  const followUpKpis = summary?.followUps ?? { total: 0, needsFollowUp: 0, escalated: 0, needsReview: 0, outstanding: 0 };
  const followUpsList = useCollectionsList<PaymentFollowUp>(dashboard,
    activeView === 'followUps' && reminderTab === 'outstanding' && !reminderInvoice
      ? { view: 'followUps', sort: paymentFollowUpSort, page: followUpsPage, pageSize } : null,
    collectionsRemote, onCollectionsExpired);
  const pendingList = useCollectionsList<DebitNoteProposal>(dashboard,
    activeView === 'needsAction' ? { view: 'pending', filter: pendingFilter, search: pendingQuery, sort: pendingSort, page: pendingPage, pageSize } : null,
    collectionsRemote, onCollectionsExpired);
  const createdList = useCollectionsList<DebitNoteProposal>(dashboard,
    activeView === 'done' ? { view: 'created', filter: createdFilter, search: createdQuery, sort: createdSort, page: createdPage, pageSize } : null,
    collectionsRemote, onCollectionsExpired);

  const activeTallyCompanyName = liveTallyConnection?.lastCompanyName?.trim() ?? "";
  const tallyCompanyVerified =
    !checkingLiveTallyCompany &&
    isLiveTallyCompanyMatch(liveTallyConnection, selectedConnectionId, selectedCompany);
  const tallyCompanyMismatch = Boolean(
    !checkingLiveTallyCompany &&
      selectedCompany?.companyName &&
      activeTallyCompanyName &&
      normalizeCompanyName(selectedCompany.companyName) !==
        normalizeCompanyName(activeTallyCompanyName)
  );
  const liveCompanyCheckPending = Boolean(
    selectedConnectionId &&
      (checkingLiveTallyCompany || liveTallyConnection?.id !== selectedConnectionId)
  );
  const companyContextBlocked = Boolean(selectedCompany && !liveCompanyCheckPending && !tallyCompanyVerified);
  const companyContextLocked = liveCompanyCheckPending || companyContextBlocked;
  const scanFailed = Boolean(!loading && !dashboard && message?.tone === "error" && !companyContextLocked);

  // Totals of the whole lists (not just the page) come from the summary.
  const pendingCount = summary?.pending.all ?? 0;
  const createdCount = summary?.created.all ?? 0;
  const pendingTotal = pendingList.page?.total ?? 0;
  const createdTotal = createdList.page?.total ?? 0;
  const followUpsTotal = followUpsList.page?.total ?? followUpKpis.total;
  const safePendingPage = pendingList.page?.page ?? pendingPage;
  const safeCreatedPage = createdList.page?.page ?? createdPage;
  const safeFollowUpsPage = followUpsList.page?.page ?? followUpsPage;
  const pagedPendingProposals = pendingList.page?.rows ?? [];
  const createdPageRows = createdList.page?.rows;
  const pagedCreatedProposals = useMemo(() => createdPageRows ?? [], [createdPageRows]);
  const pagedPaymentFollowUps = followUpsList.page?.rows ?? [];
  // Selected rows can be on any page: they are loaded by id when needed.
  const loadSelectedFollowUps = async () => {
    if (!dashboard || !selectedFollowUpIds.size) return [];
    return fetchCollectionsRows<PaymentFollowUp>(dashboard, 'followUps', [...selectedFollowUpIds], collectionsRemote);
  };
  const selectedFollowUps = followUpBulkRows;
  const openFollowUpBulk=async(mode:'enroll'|'send_once')=>{
    try{
      const rows=await loadSelectedFollowUps();
      setFollowUpBulkRows(rows);
      setFollowUpBulkPhones(Object.fromEntries(rows.map(row=>[row.id,row.partyPhone||''])));
      setFollowUpBulkMode(mode);
    }catch(error){setMessage({tone:'error',text:error instanceof Error?error.message:'Could not load the selected invoices.'});}
  };
  const submitFollowUpBulk=async()=>{
    if(!followUpBulkMode||!selectedCompany||!selectedFollowUps.length||followUpBulkBusy)return;
    setFollowUpBulkBusy(true);setMessage(null);
    try{
      const response=await apiFetch('/api/collections/follow-ups/pipelines',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:selectedConnectionId,companyId:selectedCompany.accessCompanyId,companyGuid:selectedCompany.companyGuid,companyName:selectedCompany.companyName,financialYear:selectedCompany.financialYear,action:followUpBulkMode==='enroll'?'bulk_enroll':'bulk_send_once',items:selectedFollowUps.map(row=>({key:row.id,requestId:crypto.randomUUID(),customer:row.partyLedgerName,invoice:row.linkedInvoiceNumber,invoiceDate:row.linkedInvoiceDate,recipient:followUpBulkPhones[row.id]||row.partyPhone,savePhoneToTally:followUpBulkSavePhones&&!row.partyPhone}))})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Bulk reminder action failed.');const rows=result.results||[];const completed=rows.filter((item:{status:string})=>!['skipped','rejected','uncertain'].includes(item.status)).length;const attention=rows.length-completed;setMessage({tone:attention?'info':'success',text:`${completed} completed${attention?` · ${attention} need attention`:''}.`});setFollowUpBulkMode(null);setSelectedFollowUpIds(new Set());setReminderTab(followUpBulkMode==='enroll'?'pipelines':'due');
    }catch(error){setMessage({tone:'error',text:error instanceof Error?error.message:'Bulk reminder action failed.'});}finally{setFollowUpBulkBusy(false);}
  };
  const exportSelectedFollowUps=async()=>{let rows:PaymentFollowUp[];try{rows=await loadSelectedFollowUps();}catch(error){setMessage({tone:'error',text:error instanceof Error?error.message:'Could not load the selected invoices.'});return;}if(!rows.length)return;const q=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;const csv=[['Customer','Invoice','Invoice date','Outstanding','Phone','Payment age'],...rows.map(row=>[row.partyLedgerName,row.linkedInvoiceNumber,row.linkedInvoiceDate,row.outstandingAmount,row.partyPhone||'',row.ageLabel])].map(line=>line.map(q).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='unpaid-invoices.csv';a.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const scheduleStatuses=useReminderStatuses({connectionId:selectedConnectionId,companyId:selectedCompany?.accessCompanyId,companyGuid:selectedCompany?.companyGuid,companyName:selectedCompany?.companyName||'',financialYear:selectedCompany?.financialYear||''},pagedPaymentFollowUps,activeView==='followUps'&&reminderTab==='outstanding'&&!reminderInvoice);
  const selectablePendingOnPage = tallyCompanyVerified ? pagedPendingProposals.filter(canCreateInTally) : [];
  const canMessageProposal = (proposal: DebitNoteProposal) =>
    !sentLocks.has(proposal.id) && (proposal.communicationStatus !== "sent" || needsUpdatedPdfDelivery(proposal));
  const selectableCreatedOnPage = pagedCreatedProposals.filter(canMessageProposal);
  // Release a sent lock once the list shows the note as submitted (or after a minute).
  useEffect(() => {
    if (!sentLocks.size) return;
    const shown = new Map(pagedCreatedProposals.map((proposal) => [proposal.id, proposal]));
    const release = [...sentLocks].filter(([id, lockedAt]) => {
      const row = shown.get(id);
      return Date.now() - lockedAt > 60_000 || Boolean(row && row.communicationStatus === 'sent' && !needsUpdatedPdfDelivery(row));
    }).map(([id]) => id);
    if (release.length) setSentLocks((current) => { const next = new Map(current); for (const id of release) next.delete(id); return next; });
    const timer = window.setTimeout(() => setSentLocks((current) => new Map([...current].filter(([, lockedAt]) => Date.now() - lockedAt <= 60_000))), 61_000);
    return () => window.clearTimeout(timer);
  }, [pagedCreatedProposals, sentLocks]);
  // Only ids of actionable rows are ever selected; the rows are loaded (and
  // re-checked) when the action runs.
  const selectedPendingCount = tallyCompanyVerified ? selectedPendingIds.size : 0;
  const selectedCreatedCount = selectedCreatedIds.size;
  const allPendingSelected =
    selectablePendingOnPage.length > 0 && selectablePendingOnPage.every((proposal) => selectedPendingIds.has(proposal.id));
  const allCreatedSelected =
    selectableCreatedOnPage.length > 0 && selectableCreatedOnPage.every((proposal) => selectedCreatedIds.has(proposal.id));
  const pendingRecoverableTotal = summary?.pending.recoverable ?? 0;
  const createdRecoverableTotal = summary?.created.recoverable ?? 0;
  const companyReady = tallyCompanyVerified;
  const whatsappDialogMissingCount = whatsappDialogProposals.filter((proposal) => !proposal.partyPhone).length;
  const allPhonesValid = whatsappDialogProposals.every((proposal) => {
    const phone = getTenDigitPhone(whatsappPhoneInputs[proposal.id] ?? proposal.partyPhone ?? "");
    return Boolean(phone);
  });

  function togglePendingSelection(id: string, checked: boolean) {
    setSelectedPendingIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllPending(checked: boolean) {
    setSelectedPendingIds((current) => {
      const next = new Set(current);
      for (const proposal of selectablePendingOnPage) {
        if (checked) next.add(proposal.id);
        else next.delete(proposal.id);
      }
      return next;
    });
  }

  function toggleCreatedSelection(id: string, checked: boolean) {
    setSelectedCreatedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllCreated(checked: boolean) {
    setSelectedCreatedIds((current) => {
      const next = new Set(current);
      for (const proposal of selectableCreatedOnPage) {
        if (checked) next.add(proposal.id);
        else next.delete(proposal.id);
      }
      return next;
    });
  }

  currentBulkScope.current=`${selectedConnectionId}|${selectedCompany?.companyName}|${selectedCompany?.financialYear}|${accessCacheEpoch()}`;
  async function approveSelectedProposals() {
    if(bulkRunning.current||activeScanRef.current){setMessage({tone:'error',text:'Wait for the current operation to finish.'});return;}
    if(!tallyCompanyVerified||!allowed('discounts.post')){setMessage({tone:'error',text:'Verify the selected Tally company and posting access first.'});return;}
    if(!selectedPendingIds.size||!dashboard)return;
    let rows:DebitNoteProposal[];
    try{rows=await fetchCollectionsRows<DebitNoteProposal>(dashboard,'pending',[...selectedPendingIds],collectionsRemote);}
    catch(error){setMessage({tone:'error',text:error instanceof Error?error.message:'Could not load the selected debit notes.'});return;}
    // Re-checked against the current results: a row may have changed since it was ticked.
    const creatable=rows.filter(proposal=>canCreateDebitNoteInTally(proposal as never));
    if(!creatable.length){setMessage({tone:'info',text:'The selected debit notes can no longer be created. Refresh to see their current status.'});return;}
    bulkScope.current=currentBulkScope.current;
    setBulkMessageable([]);
    setBulkReview(creatable);setBulkPhase('review');setBulkAcknowledged(false);setBulkStates({});setBulkProgress({});setBulkResultMessage('');
  }
  async function postReviewedBulk() {
    if(bulkRunning.current||!bulkAcknowledged||!bulkReview?.length)return;
    if(bulkScope.current!==currentBulkScope.current||!tallyCompanyVerified||!allowed('discounts.post')||activeScanRef.current){
      setBulkResultMessage('Company, access or scan state changed. Close this review and check the selection again.');return;
    }
    const batch=[...bulkReview];
    bulkRunning.current=true;setBulkCreating(true);setBulkPhase('posting');setBulkProgress({});setBulkResultMessage('');
    setBulkStates(Object.fromEntries(batch.map(p=>[p.id,{status:'waiting' as const}])));
    let confirmed=0,stopped=false;
    const confirmedIds=new Set<string>();
    try {
      const result=await runDebitNoteBatch(batch,{
        canContinue:()=>bulkScope.current===currentBulkScope.current,
        create:async proposal=>{
          setApprovingId(proposal.id);
          setBulkStates(current=>({...current,[proposal.id]:{status:'creating'}}));
          await createDebitNoteForProposal(proposal);
        },
        confirmed:proposal=>{
          confirmedIds.add(proposal.id);
          setBulkStates(current=>({...current,[proposal.id]:{status:'created'}}));
          setSelectedPendingIds(current=>{const next=new Set(current);next.delete(proposal.id);return next;});
        },
        uncertain:(proposal,error)=>{
          setBulkStates(current=>({...current,[proposal.id]:{status:'uncertain',error:error instanceof Error?error.message:'Creation could not be confirmed.'}}));
          setBulkResultMessage('Batch stopped. Check the interrupted note in Tally before retrying; it may already exist. Remaining notes were not attempted.');
        }
      });
      confirmed=result.confirmed;stopped=result.stopped;
      if(result.scopeChanged)setBulkResultMessage('Company or access changed. Remaining notes were not attempted.');
      if(bulkScope.current===currentBulkScope.current&&selectedConnectionId){
        try{
          const refreshed=await refreshCreatedDebitNotesFromStore(selectedConnectionId);
          // The debit notes just created (new ids), found by their invoices.
          const confirmedKeys=batch.filter(p=>confirmedIds.has(p.id)).map(p=>proposalListInvoiceKey(p as never));
          if(refreshed&&confirmedKeys.length){
            const created=await fetchCollectionsRowsByInvoice<DebitNoteProposal>(refreshed,'created',confirmedKeys,collectionsRemote);
            setBulkMessageable(created.filter(p=>isCreatedDebitNote(p)&&canMessageProposal(p)));
          }
        }
        catch{setBulkResultMessage(current=>[current,'Created history could not be refreshed. Do not recreate confirmed notes. Refresh Created before sending WhatsApp.'].filter(Boolean).join(' '));}
      }
      if(!stopped)setBulkResultMessage(current=>current||`All ${confirmed} debit notes were confirmed created in Tally.`);
    } finally {
      bulkRunning.current=false;setBulkCreating(false);setApprovingId('');setBulkPhase('results');
    }
  }

  async function sendSelectedWhatsappMessages() {
    if (selectedCreatedIds.size === 0 || !dashboard) return;
    let rows: DebitNoteProposal[];
    try { rows = await fetchCollectionsRows<DebitNoteProposal>(dashboard, 'created', [...selectedCreatedIds], collectionsRemote); }
    catch (error) { setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Could not load the selected debit notes.' }); return; }
    const messageable = rows.filter(canMessageProposal);
    if (messageable.length === 0) return;
    await openWhatsappDialog(messageable);
  }

  const bulkConfirmed=(bulkReview||[]).filter(p=>bulkStates[p.id]?.status==='created');
  const bulkAmount=sumRecoverable(bulkReview||[]);

  return (
    <div className={`${styles.cashDiscounts} flex flex-col bg-[#f7f4ef] px-4 text-[#1a1a1a] sm:px-6 lg:px-8`}>
      <Dialog open={bulkReview!==null} onOpenChange={open=>{if(!open&&!bulkRunning.current)setBulkReview(null);}}>
        <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col overflow-hidden rounded-xl border-[#ded8d0] p-0" showClose={!bulkCreating}>
          <div className="shrink-0 border-b border-[#e8e2db] px-5 py-4 pr-14">
            <DialogTitle className="text-base">{bulkPhase==='review'?'Review debit notes':bulkPhase==='posting'?'Creating debit notes':'Bulk creation results'}</DialogTitle>
            {bulkPhase!=='review'?<DialogDescription className="mt-1 text-xs">{bulkPhase==='posting'?'Keep this page open. Notes are processed one at a time.':'Messages are not sent automatically.'}</DialogDescription>:null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className={`mb-4 grid grid-cols-1 gap-3 rounded-lg bg-[#faf8f5] p-3 text-xs ${bulkPhase==='review'?'sm:grid-cols-2':'sm:grid-cols-3'}`}>
              {bulkPhase==='review'?<><div><p className="text-[#756b60]">Selected</p><p className="mt-1 font-semibold">{bulkReview?.length||0} debit note{bulkReview?.length===1?'':'s'}</p></div><div><p className="text-[#756b60]">Total</p><p className="mt-1 font-semibold">{formatMoney(bulkAmount)}</p></div></>:<><p><strong>{bulkConfirmed.length}</strong> confirmed</p><p><strong>{Object.values(bulkStates).filter(v=>v.status==='uncertain').length}</strong> need verification</p><p><strong>{Object.values(bulkStates).filter(v=>v.status==='waiting').length}</strong> {bulkPhase==='posting'?'waiting':'not attempted'}</p></>}
            </div>
            {bulkResultMessage?<p role="status" className="mb-3 rounded-lg border border-[#ded8d0] p-3 text-xs leading-5">{bulkResultMessage}</p>:null}
            <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="border-b border-[#ded8d0] text-[#756b60]"><th className="py-2 pr-3">Customer / invoice</th><th className="px-3 py-2 text-right">Debit note</th><th className="py-2 pl-3">{bulkPhase==='review'?'Selection':'Result'}</th></tr></thead><tbody>{bulkReview?.map(p=><tr key={p.id} className="border-b border-[#eee8e0]"><td className="py-3 pr-3"><p className="font-medium">{p.partyLedgerName}</p><p className="mt-1 text-[#756b60]">{p.linkedInvoiceNumber}</p></td><td className="whitespace-nowrap px-3 py-3 text-right">{formatMoney(p.recoverableAmount)}</td><td className="py-3 pl-3">{bulkPhase==='review'?<button type="button" className="text-[#756b60] underline" onClick={()=>{setBulkReview(rows=>rows?.filter(row=>row.id!==p.id)||[]);setBulkAcknowledged(false);}}>Remove</button>:<><span className={bulkStates[p.id]?.status==='created'?'text-emerald-700':bulkStates[p.id]?.status==='uncertain'?'text-amber-800':'text-[#756b60]'}>{bulkStates[p.id]?.status==='created'?'Created in Tally':bulkStates[p.id]?.status==='creating'?(bulkProgress[p.id] || 'Checking invoice…'):bulkStates[p.id]?.status==='uncertain'?'Needs verification':bulkPhase==='posting'?'Waiting':'Not attempted'}</span>{bulkStates[p.id]?.error?<p className="mt-1 max-w-xs break-words leading-5 text-[#756b60]">{bulkStates[p.id].error}</p>:null}</>}</td></tr>)}</tbody></table></div>
            {bulkPhase==='review'?<label className="mt-4 flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1 accent-[#332c26]" checked={bulkAcknowledged} onChange={e=>setBulkAcknowledged(e.target.checked)}/><span>These invoices were recorded net of the expired discount. <span className="text-[#756b60]">Tally will recheck each one.</span></span></label>:null}
          </div>
          <DialogFooter className="m-0 shrink-0 border-t border-[#e8e2db] px-5 py-4">
            {bulkPhase==='review'?<><button className={styles.messageAction} onClick={()=>setBulkReview(null)}>Cancel</button><button className="rounded-lg bg-[#2f2924] px-4 py-2 text-xs font-semibold text-white disabled:opacity-40" disabled={!bulkAcknowledged||!bulkReview?.length} onClick={()=>void postReviewedBulk()}>Create {bulkReview?.length||0} debit notes</button></>:bulkPhase==='posting'?<p role="status" className="flex items-center gap-2 text-xs"><Loader2 className="size-4 animate-spin"/>Processing · {bulkConfirmed.length} of {bulkReview?.length} confirmed</p>:<><button className={styles.messageAction} onClick={()=>setBulkReview(null)}>Close</button>{bulkConfirmed.length>0?<button className={styles.messageAction} onClick={()=>{setBulkReview(null);setActiveView('done');}}>View created notes</button>:null}{allowed('discounts.export')&&bulkMessageable.length>0?<button className="rounded-lg bg-[#2f2924] px-4 py-2 text-xs font-semibold text-white" onClick={()=>{const rows=[...bulkMessageable];setBulkReview(null);void openWhatsappDialog(rows);}}>Send WhatsApp ({bulkMessageable.length})</button>:null}</>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PageHeader
        sticky={false}
        className="mb-1"
        title={isDedicatedFollowUpsPage ? 'Payment Follow-ups' : 'Cash Discounts'}
        subtitle={isDedicatedFollowUpsPage ? 'Prioritize overdue payments' : 'Recover missed invoice discounts'}
        actions={
        <div className="flex min-w-0 flex-wrap items-center gap-2 lg:flex-nowrap lg:justify-end">
          <label className="w-full min-w-0 flex-1 sm:w-[250px] sm:flex-none">
            <span className="sr-only">Company to review from the currently active Tally company</span>
            <select
              title={selectedCompany ? formatCompanyOptionLabel(selectedCompany) : 'Select a Tally company'}
              className="h-8 w-full min-w-0 truncate rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 text-xs font-medium text-[#3d3530] shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
              onChange={(event) => {
                activeScanRef.current?.abort(new Error("Company selection changed. Refresh to scan the selected company."));
                lastLoadedConnectionRef.current = "";
                setDashboard(null);
                const company = companies.find((item) => item.id === event.target.value) ?? null;
                setSelectedCompanyId(event.target.value);
                setSelectedConnectionId(company?.connectionId || "");
              }}
              value={selectedCompany?.id || selectedCompanyId}
            >
              {companies.length === 0 ? <option value="">No Tally company found</option> : null}
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {formatCompanyOptionLabel(company)}
                </option>
              ))}
            </select>
          </label>

          <div
            className={`inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium shadow-sm transition-colors ${
            companyReady
              ? "border-emerald-200 bg-emerald-50/80 text-emerald-800"
              : tallyCompanyMismatch
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-[#e5ddd0] bg-white text-slate-500"
          }`}
            title={`Selected: ${selectedCompany?.companyName || "Not selected"} · Tally: ${activeTallyCompanyName || "Not detected"}`}
          >
              {liveCompanyCheckPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : companyReady ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <TriangleAlert className="h-3.5 w-3.5" />
              )}
              <span className="max-w-[180px] truncate">
                {liveCompanyCheckPending
                ? "Checking Tally…"
                : companyReady
                  ? 'Verified'
                  : tallyCompanyMismatch
                    ? "Switch company in Tally"
                    : "Tally not ready"}
              </span>
          </div>

          <button
            className="inline-flex h-8 w-fit items-center justify-center gap-1.5 rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 text-xs font-medium text-[#3d3530] hover:bg-[#ede6d9] shadow-sm transition-all"
            disabled={loading || Boolean(activeScanRef.current)}
            onClick={() => void refreshAll({ refreshTally: true })}
            type="button"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>
        }
      />

      {interactiveScan ? (
        <button type="button" className="mb-3 rounded-lg border px-3 py-1 text-xs" onClick={() =>
          activeScanRef.current?.abort(new Error("Scan cancelled. Tally may still be finishing its current read; wait before retrying."))}>
          Cancel scan
        </button>
      ) : null}
      <div className="mb-2 flex min-h-6 flex-wrap items-center justify-end gap-2 text-[10px] leading-4 text-[#756b60]">
        {selectedCompany?.financialYear ? <span title="Selected financial year">FY {selectedCompany.financialYear}</span> : null}
        {lastScan && lastScan.scope === `${selectedConnectionId}|${selectedCompany?.companyName}|${selectedCompany?.financialYear || ''}` ?
          <span>· {lastScan.complete ? 'Checked' : 'Partial check'} {lastScan.at}</span> : null}
        {dashboard?.cache?.source === 'prepared_customer_dues' ? <span title="Read from Kalika Local Agent, kept current from Tally">· From customer dues</span>
          : dashboard?.cache?.source === 'live_tally' ? <span title="Customer dues are not ready for this company. Open Kalika Local Agent → Customer dues to make this page faster.">· Read live from Tally</span> : null}
        {!isDedicatedFollowUpsPage && dashboard ? <details className="relative">
          <summary aria-label="About these figures" className="cursor-pointer rounded px-1 py-1 text-[#5a5046] focus-visible:outline focus-visible:outline-2">About</summary>
          <div className="absolute right-0 z-20 mt-2 w-72 max-w-[calc(100vw-3rem)] rounded-xl border border-[#e0d8cc] bg-white p-4 text-xs leading-relaxed shadow-lg">
            <p>{dashboard.cache?.source === 'prepared_customer_dues'
              ? 'Figures come from customer dues in Kalika Local Agent, which follows changes in Tally about every minute.'
              : 'Figures were read from Tally at the time shown. Refresh to check again.'}</p>
            <p className="mt-2">Configured policy: 1.5% for 7 calendar days; 1% for 15 calendar days. Narration supplies the rates, not the day counts. Posting always rechecks the invoice.</p>
          </div>
        </details> : null}
      </div>
      {dashboard?.cache?.stale && dashboard?.scanSummary?.complete !== false ? <div role="status" className="mb-2 text-xs text-amber-800">Showing saved results. {dashboard.cache.refreshError ? `Could not refresh: ${dashboard.cache.refreshError}` : 'Updating from Tally…'}</div> : null}
      {dashboard?.scanSummary?.complete === false ? (
        <div role="alert" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p>{dashboard.scanSummary.completed}/{dashboard.scanSummary.total} customers checked. Remaining customers need review; no missing evidence has been treated as zero.</p>
          {dashboard?.cache?.stale ? <p className="mt-1 text-xs">Showing saved results. {dashboard.cache.refreshError ? `Could not refresh: ${dashboard.cache.refreshError}` : 'Updating from Tally…'}</p> : null}
          {dashboard.scanSummary.resumable ? <button type="button" className="mt-2 rounded-lg border px-3 py-1" disabled={Boolean(activeScanRef.current)} onClick={() => {
            void refreshTallyOpenBills(selectedConnectionId, selectedCompany?.companyName, selectedCompany?.financialYear, selectedCompany?.companyGuid, true)
              .then((value) => { setDashboard(value); setMessage(null); })
              .catch((error) => setMessage({ tone: "error", text: error.message }));
          }}>Continue remaining customers</button> : null}
          <details className="mt-2"><summary>Customers not checked</summary>
            <ul>{dashboard.scanSummary.failures.map((failure) => <li key={failure.ledgerName}>{failure.ledgerName}: {failure.error}</li>)}</ul>
          </details>
        </div>
      ) : null}
      {Boolean(dashboard?.scanSummary?.reused) ? <p className="mb-3 text-xs text-slate-600">{dashboard?.scanSummary?.reused} completed customer results reused from this recent scan. Refresh checks everything again; posting always performs a fresh invoice check.</p> : null}

      {message?.tone === "info" ? (
        <div
          className="mb-4 inline-flex w-fit items-center gap-2 rounded-full bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>{message.text}</span>
        </div>
      ) : message && !companyContextLocked && !scanFailed ? (
        <div
          className={`mb-6 rounded-xl border px-4 py-3 text-sm font-medium ${message.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : message.tone === "notice"
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.text}
        </div>
      ) : null}

      {companyContextLocked ? (
        <section
          className={`mb-6 overflow-hidden rounded-2xl border shadow-[0_10px_30px_rgba(94,67,31,0.08)] ${
            companyContextBlocked ? "border-amber-200 bg-[#fffaf0]" : "border-sky-200 bg-[#f7fbff]"
          }`}
        >
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <div
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
                  companyContextBlocked ? "border-amber-200 bg-amber-50 text-amber-700" : "border-sky-200 bg-sky-50 text-sky-700"
                }`}
              >
                {liveCompanyCheckPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <TriangleAlert className="h-4 w-4" />}
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[#1a1a1a]">
                  {liveCompanyCheckPending ? "Verifying the live Tally company" : isDedicatedFollowUpsPage ? "Payment follow-up review is locked" : "Cash Discount review is locked"}
                </h2>
                <p className="mt-1 max-w-3xl text-xs font-medium leading-relaxed text-slate-600">
                  {liveCompanyCheckPending
                    ? "The page waits for Tally to confirm its active company before reading bills or calculating discounts."
                    : liveTallyConnection?.tallyReachable === false
                      ? "Tally is not responding to the connector. Reopen Tally with the required company, wait for it to finish loading, then check again. No bills were scanned and no cash-discount calculation is being shown."
                    : activeTallyCompanyName
                      ? <>Tally is open to <strong>{activeTallyCompanyName}</strong>, while the selected company is <strong>{selectedCompany?.companyName}</strong>. No bills were scanned and no cash-discount calculation is being shown. Switch Tally to the selected company, then refresh this page.</>
                      : "Open the required company in Tally, then refresh this page. Until Tally confirms the active company, no bills are scanned or calculated."}
                </p>
              </div>
            </div>
            <button
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-[#d9c8ac] bg-white px-3 text-xs font-medium text-[#5a5046] shadow-sm transition hover:bg-[#fffdf9]"
              onClick={() => void refreshAll()}
              type="button"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Check Tally again
            </button>
          </div>
        </section>
      ) : null}

      {dashboard?.setupRequired && !companyContextLocked ? (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800 shadow-sm">
          {isDedicatedFollowUpsPage ? "Payment follow-up tables are not ready. Run the database migration." : "Cash Discounts tables are not ready. Run the database migration."}
        </div>
      ) : null}

      {scanFailed ? (
        <section className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-5 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-red-900">{isDedicatedFollowUpsPage ? "Payment follow-up results are unavailable" : "Cash Discount results are unavailable"}</h2>
              <p className="mt-1 text-xs font-medium leading-relaxed text-red-800">
                The latest check did not complete, so this page is not showing zero open bills or zero recovery. Make sure Kalika Local Agent is running and Tally is open, then try again.
              </p>
              {message?.tone === "error" ? (
                <p className="mt-1 text-xs leading-relaxed text-red-700">{message.text}</p>
              ) : null}
            </div>
            <button
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-3 text-xs font-medium text-red-800 shadow-sm transition hover:bg-red-100"
              onClick={() => void refreshAll()}
              type="button"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Try again
            </button>
          </div>
        </section>
      ) : null}

      {!companyContextLocked && !scanFailed && isDedicatedFollowUpsPage ? (
        <section aria-label="Payment follow-up summary" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SummaryCard count={followUpKpis.needsFollowUp} label="To contact" />
          <SummaryCard count={formatMoney(followUpKpis.outstanding)} label="Outstanding" />
          <SummaryCard count={followUpKpis.escalated} label="Escalated" />
          <SummaryCard count={followUpKpis.needsReview} label="Needs review" />
        </section>
      ) : null}

      {!companyContextLocked && !scanFailed && showWorkflowSummary ? <>
        <section aria-label="Cash Discount totals" className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard count={pendingCount} label="Pending invoices" />
          <SummaryCard count={formatMoney(pendingRecoverableTotal)} label="Potential recovery" />
          <SummaryCard count={createdCount} label="Debit notes created" />
          <SummaryCard count={formatMoney(createdRecoverableTotal)} label="Amount posted" />
        </section>
        <div aria-label="Debit note views" className="mb-4 flex gap-5 border-b border-[#e0d8cc]">
          {([{value:'needsAction',label:'Pending',count:pendingCount},{value:'done',label:'Created',count:createdCount}] as const).map(tab => (
            <button key={tab.value} type="button" aria-pressed={activeView===tab.value}
              onClick={() => chooseView(tab.value)}
              className={`inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 ${activeView===tab.value ? 'border-[#2d2d2d] text-[#1a1a1a]' : 'border-transparent text-[#8a7f72] hover:text-[#3d3530]'}`}>
              {tab.label}<span className="rounded-md bg-[#ede6d9] px-1.5 py-0.5 text-[11px] tabular-nums">{tab.count}</span>
            </button>
          ))}
        </div>
      </> : null}



      {!companyContextLocked && !scanFailed && activeView === "needsAction" ? (
        <section className={styles.results} aria-label="Debit notes to create">
          {pendingCount > 0 ? (
            <ListControls
              filter={pendingFilter}
              filterLabel="Filter debit notes to create"
              filterOptions={[
                { value: "all", label: "All statuses" },
                { value: "ready", label: "Ready" },
                { value: "in_progress", label: "In progress" },
                { value: "failed", label: "Failed" },
              ]}
              onFilterChange={(value) => setPendingFilter(value as PendingProposalFilter)}
              onQueryChange={setPendingQuery}
              onSortChange={(value) => setPendingSort(value as PendingProposalSort)}
              query={pendingQuery}
              sort={pendingSort}
              sortOptions={[
                { value: "deadline_oldest", label: "Oldest deadline" },
                { value: "highest_recovery", label: "Highest recovery" },
                { value: "invoice_oldest", label: "Oldest invoice" },
                { value: "customer", label: "Customer name" },
              ]}
              action={allowed('discounts.post') && selectedPendingCount > 0 ? (
                <button
                  className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[#2d2d2d] px-4 text-xs font-medium text-white shadow-sm transition-all hover:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={bulkCreating}
                  onClick={() => void approveSelectedProposals()}
                  type="button"
                >
                  {bulkCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Create {selectedPendingCount} debit note{selectedPendingCount === 1 ? "" : "s"}
                </button>
              ) : null}
            />
          ) : null}
          {pendingCount === 0 ? (
            <EmptyState>
              Nothing needs action right now.
            </EmptyState>
          ) : pendingList.page?.total === 0 ? (
            <EmptyState>No debit notes match these filters.</EmptyState>
          ) : (
            <div className={styles.flatTable}>
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Pending invoices table">
                <table className="w-full min-w-[860px] border-collapse text-left text-xs">
                  <thead><tr className="h-10 border-b border-[#e0d8cc] text-[#3d3530]">
                    <th scope="col" className="w-10 px-3"><input aria-label="Select all debit notes on this page" type="checkbox"
                      checked={allPendingSelected} disabled={!allowed('discounts.post') || selectablePendingOnPage.length===0 || bulkCreating}
                      onChange={event=>toggleAllPending(event.target.checked)} className="h-4 w-4 accent-[#2d2d2d]" /></th>
                    <th scope="col" className="px-3 font-semibold">Customer</th>
                    <th scope="col" className="px-3 font-semibold">Invoice / date</th>
                    <th scope="col" className="px-3 text-right font-semibold">Outstanding</th>
                    <th scope="col" className="px-3 font-semibold">Status</th>
                    <th scope="col" className="px-3 text-right font-semibold">Recovery</th>
                    <th scope="col" className="px-3 text-right font-semibold">Action</th>
                  </tr></thead>
                  <tbody>
                    {pagedPendingProposals.map(proposal => {
                      const createEnabled = allowed('discounts.post') && !activeScanRef.current && dashboard?.preview!==true && tallyCompanyVerified && canCreateInTally(proposal);
                      return <tr key={proposal.id} className="h-[60px] border-b border-[#ece6dc] transition-colors last:border-0 hover:bg-[#ede6d9]/40">
                        <td className="px-3 py-2"><input type="checkbox" aria-label={`Select debit note for ${proposal.partyLedgerName}`}
                          checked={selectedPendingIds.has(proposal.id)} disabled={!createEnabled || bulkCreating}
                          onChange={event=>togglePendingSelection(proposal.id,event.target.checked)} className="h-4 w-4 accent-[#2d2d2d]" /></td>
                        <td className="px-3 py-2"><span className="block max-w-[240px] truncate text-[13px] font-medium text-[#111827]" title={proposal.partyLedgerName}>{proposal.partyLedgerName}</span>
                          {!proposal.partyPhone && !proposal.partyEmail ? <span className="text-[11px] font-normal text-[#8a7f72]">No contact</span> : null}</td>
                        <td className="px-3 py-2"><span className="block max-w-[180px] truncate text-[13px] font-medium" title={proposal.linkedInvoiceNumber || ''}>{shortText(proposal.linkedInvoiceNumber,'No invoice')}</span>
                          <span className="text-[11px] text-[#8a7f72]">{formatDate(proposal.linkedInvoiceDate)}</span></td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-[#5a5046]">{formatMoney(proposal.pendingAmount)}</td>
                        <td className="px-3 py-2"><span className="inline-flex whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900">
                          {proposal.status==='failed' ? 'Creation failed' : proposal.status==='approved' || proposal.status==='queued_in_tally' ? 'Creating' : issueLabel(proposal)}
                        </span></td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{formatMoney(proposal.recoverableAmount)}</td>
                        <td className="px-3 py-2 text-right"><button type="button"
                          className="rounded-lg border border-[#ded8d0] bg-[#fbfaf8] px-3 py-1.5 text-xs font-medium text-[#3d3530] hover:bg-[#ede6d9] focus-visible:outline focus-visible:outline-2"
                          aria-label={`Review ${proposal.linkedInvoiceNumber || 'invoice'} for ${proposal.partyLedgerName}`}
                          onClick={()=>{setReviewAcknowledged(false);setReviewingProposal(proposal);}}>Review</button></td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
              <PaginationControls
                onPageChange={setPendingPage}
                onPageSizeChange={changePageSize}
                page={safePendingPage}
                pageSize={pageSize}
                total={pendingTotal}
              />
            </div>
          )}
        </section>
      ) : null}

      {!companyContextLocked && activeView==='followUps'?<div className="flex shrink-0 flex-wrap items-center justify-between gap-x-5 border-b border-[#ded8d0]"><nav aria-label="Payment follow-up views" className="flex min-w-0 gap-5 overflow-x-auto text-sm">{([['due','Reminders due'],['outstanding','Unpaid invoices'],['pipelines','Reminder tracking'],['history','Sent messages']] as const).map(([key,label])=><button key={key} type="button" aria-current={reminderTab===key?'page':undefined} className={`whitespace-nowrap border-b-2 px-1 py-3 ${reminderTab===key?'border-[#2d2d2d] font-medium text-[#1a1a1a]':'border-transparent text-[#82776a]'}`} onClick={()=>{setReminderTab(key);setReminderInvoice(null);setFocusedReminder('');setSelectedFollowUpIds(new Set());}}>{label}{key==='due'&&remindersDue!==null&&remindersDue>0?<span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">{remindersDue}</span>:null}</button>)}</nav><div className="ml-auto flex items-center gap-2 py-1.5">          {reminderTab==='outstanding'&&!reminderInvoice&&followUpKpis.total > 0 ? (
            <div className="flex flex-wrap justify-end gap-2">{selectedFollowUpIds.size?<><span className="self-center text-xs font-semibold text-[#51483f]">{selectedFollowUpIds.size} selected</span><button className={styles.messageAction} onClick={()=>openFollowUpBulk('enroll')}>Start reminders</button><button className={styles.messageAction} onClick={()=>openFollowUpBulk('send_once')}>Send once</button><button className={styles.messageAction} onClick={exportSelectedFollowUps}>CSV</button><button className={styles.messageAction} onClick={()=>setSelectedFollowUpIds(new Set())}>Clear</button></>:null}
            <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Sort
              <select
                aria-label="Sort payment follow-ups"
                className="h-9 rounded-xl border border-[#e5ddd0] bg-white px-3 text-xs font-medium normal-case tracking-normal text-[#1a1a1a] outline-none transition focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                onChange={(event) => setPaymentFollowUpSort(event.target.value as PaymentFollowUpSort)}
                value={paymentFollowUpSort}
              >
                <option value="priority">Priority</option>
                <option value="most_overdue">Most overdue</option>
                <option value="highest_outstanding">Highest outstanding</option>
                <option value="oldest_invoice">Oldest invoice</option>
                <option value="customer">Customer name</option>
              </select>
            </label>
            </div>
          ) : null}
<div ref={setReminderToolbar} className="flex items-center gap-2"/></div></div>:null}
      {!companyContextLocked && activeView === 'followUps' && selectedCompany && (reminderTab!=='outstanding'||reminderInvoice) ? <FollowUpPipelines key={`${selectedConnectionId}|${selectedCompany.id}|${reminderTab}`} toolbarTarget={reminderToolbar} focusId={focusedReminder} view={reminderTab==='due'?'due':reminderTab==='history'?'history':'pipelines'} onShowSent={()=>{setReminderTab('history');setReminderInvoice(null);setFocusedReminder('');}} connectionId={selectedConnectionId} companyName={selectedCompany.companyName} companyGuid={selectedCompany.companyGuid} financialYear={selectedCompany.financialYear || ''} companyId={selectedCompany.accessCompanyId || undefined} invoice={reminderInvoice} onDueCount={setRemindersDue} onClearInvoice={()=>setReminderInvoice(null)} /> : null}
      {!companyContextLocked && !scanFailed && activeView === "followUps" && reminderTab==='outstanding' && !reminderInvoice ? (
        <section className={styles.results} aria-label="Payment follow-ups">
          {followUpKpis.total === 0 ? (
            <EmptyState>There are no payments to follow up from the latest Tally scan.</EmptyState>
          ) : (
            <div className={styles.flatTable}>
              <div tabIndex={0} role="region" aria-label="Payment follow-ups table">
                <table className={styles.createdTable}>
                  <thead><tr>
                    <th scope="col" className="w-9"><input type="checkbox" aria-label="Select unpaid invoices on this page" checked={pagedPaymentFollowUps.length>0&&pagedPaymentFollowUps.every(row=>selectedFollowUpIds.has(row.id))} onChange={event=>setSelectedFollowUpIds(current=>{const next=new Set(current);for(const row of pagedPaymentFollowUps)event.target.checked?next.add(row.id):next.delete(row.id);return next;})}/></th>
                    <th scope="col">Customer</th>
                    <th scope="col" style={{width:'23%'}}>Invoice</th>
                    <th scope="col" style={{width:140}} className="text-right">Outstanding</th>
                    <th scope="col" style={{width:'23%'}}>Payment age</th>
                    <th scope="col" style={{width:150}}>Reminders</th>
                  </tr></thead>
                  <tbody>{pagedPaymentFollowUps.map(followUp => (
                    <tr key={followUp.id}>
                      <td><input type="checkbox" aria-label={`Select ${followUp.linkedInvoiceNumber||followUp.partyLedgerName}`} disabled={!followUp.linkedInvoiceNumber||!followUp.linkedInvoiceDate} checked={selectedFollowUpIds.has(followUp.id)} onChange={event=>setSelectedFollowUpIds(current=>{const next=new Set(current);event.target.checked?next.add(followUp.id):next.delete(followUp.id);return next;})}/></td><td><span className={styles.customerName} title={followUp.partyLedgerName}>{followUp.partyLedgerName}</span>
                        <span className={styles.secondary}>{followUp.partyPhone || followUp.partyEmail || 'No contact'}</span></td>
                      <td><details className={styles.invoiceDetails}>
                        <summary title={followUp.linkedInvoiceNumber || 'No linked invoice'}>{shortText(followUp.linkedInvoiceNumber,'No linked invoice')}</summary>
                        <div className="py-2 text-[11px] leading-relaxed text-[#5a5046]">
                          <p>Invoice value {formatMoney(followUp.originalInvoiceAmount)}</p>
                          <p>Received {formatMoney(followUp.amountReceived)}</p>
                          {followUp.currentDiscount ? <p>Cash discount {followUp.currentDiscount.ratePercent}% until {formatDate(followUp.currentDiscount.discountDeadline)}</p> : null}
                        </div>
                      </details><span className={styles.secondary}>{formatDate(followUp.linkedInvoiceDate)}</span></td>
                      <td className="whitespace-nowrap text-right font-medium tabular-nums">{formatMoney(followUp.outstandingAmount)}</td>
                      <td><span className={styles.primary}>{followUp.ageLabel}</span>
                        <span className={styles.secondary}>{followUp.ageBasis === 'due_date'
                          ? `Due ${formatDate(followUp.dueDate)}`
                          : followUp.ageBasis === 'invoice_date' ? 'Invoice age · due date missing' : 'Confirm invoice and due dates'}</span></td>
                      <td>{(()=>{const row=scheduleStatuses?.rows[invoiceKey(followUp.partyLedgerName,followUp.linkedInvoiceNumber,followUp.linkedInvoiceDate)];const info=reminderLabel(row);const valid=Boolean(followUp.linkedInvoiceNumber&&followUp.linkedInvoiceDate);return <><span className={styles.followUpStatus}>{!valid?'Invoice details missing':!scheduleStatuses?'Checking reminders…':scheduleStatuses.error?'Status unavailable':info.label}</span>{valid&&scheduleStatuses&&!scheduleStatuses.error&&(row||allowed('followups.prepare'))?<button type="button" className="mt-2 block text-xs underline underline-offset-4" onClick={()=>{if(row){setFocusedReminder(row.id);setReminderTab(info.action==='Check & send'?'due':'pipelines');}else{setFocusedReminder('');setReminderInvoice({...followUp,partyPhone:followUp.partyPhone||null});}}}>{info.action}</button>:null}</>;})()}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <PaginationControls
                onPageChange={setFollowUpsPage}
                onPageSizeChange={changePageSize}
                page={safeFollowUpsPage}
                pageSize={pageSize}
                total={followUpsTotal}
              />
            </div>
          )}
        </section>
      ) : null}

      {!companyContextLocked && !scanFailed && activeView === "done" ? (
        <section className={styles.results} aria-label="Created debit notes">
          {allowed('discounts.export') && selectedCreatedCount > 0 ? (
            <div className="mb-2 flex justify-end">
              <button
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-[#e5ddd0] bg-white px-4 text-xs font-medium text-[#5a5046] shadow-sm transition-all hover:bg-[#faf8f4] hover:text-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={bulkSendingWhatsapp}
                onClick={() => void sendSelectedWhatsappMessages()}
                type="button"
              >
                {bulkSendingWhatsapp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
                Send WhatsApp ({selectedCreatedCount})
              </button>
            </div>
          ) : null}
          {createdCount > 0 ? (
            <ListControls
              filter={createdFilter}
              filterLabel="Filter created debit notes"
              filterOptions={[
                { value: "all", label: "All messages" },
                { value: "sent", label: "Submitted" },
                { value: "not_sent", label: "Not sent" },
                { value: "failed", label: "Failed" },
              ]}
              onFilterChange={(value) => setCreatedFilter(value as CreatedProposalFilter)}
              onQueryChange={setCreatedQuery}
              onSortChange={(value) => setCreatedSort(value as CreatedProposalSort)}
              query={createdQuery}
              sort={createdSort}
              sortOptions={[
                { value: "created_newest", label: "Newest first" },
                { value: "highest_amount", label: "Highest amount" },
                { value: "invoice_newest", label: "Newest invoice" },
                { value: "customer", label: "Customer name" },
              ]}
            />
          ) : null}
          {createdCount === 0 ? (
            <EmptyState>No debit notes created yet.</EmptyState>
          ) : createdList.page?.total === 0 ? (
            <EmptyState>No created debit notes match these filters.</EmptyState>
          ) : (
            <div className={styles.flatTable}>
              <div tabIndex={0} role="region" aria-label="Created debit notes table">
                <table className={styles.createdTable}>
                  <thead><tr>
                    <th scope="col" style={{width:32}}><input aria-label="Select this page for WhatsApp" type="checkbox"
                      checked={allCreatedSelected} disabled={selectableCreatedOnPage.length===0 || bulkSendingWhatsapp}
                      onChange={event=>toggleAllCreated(event.target.checked)} className="h-4 w-4 accent-[#2d2d2d]" /></th>
                    <th scope="col">Customer</th>
                    <th scope="col" style={{width:'13%'}}>Debit note</th>
                    <th scope="col" style={{width:'21%'}}>Invoice</th>
                    <th scope="col" style={{width:95}} className="text-right">Amount</th>
                    <th scope="col" style={{width:76}}>Tally</th>
                    <th scope="col" style={{width:150}}>WhatsApp</th>
                    <th scope="col" style={{width:40}}><span className="sr-only">PDF</span></th>
                  </tr></thead>
                  <tbody>{pagedCreatedProposals.map(proposal => {
                    const canMessage = allowed('discounts.export') && (proposal.communicationStatus !== 'sent' || needsUpdatedPdfDelivery(proposal));
                    const sending = sendingWhatsappId===proposal.id || sentLocks.has(proposal.id);
                    const preparing = preparingNativePdfId===proposal.id;
                    return <tr key={proposal.id}>
                      <td><input aria-label={`Select WhatsApp for ${proposal.partyLedgerName}`} type="checkbox"
                        checked={selectedCreatedIds.has(proposal.id)} disabled={!canMessage || sending || bulkSendingWhatsapp}
                        onChange={event=>toggleCreatedSelection(proposal.id,event.target.checked)} className="h-4 w-4 accent-[#2d2d2d]" /></td>
                      <td><span className={styles.customerName} title={proposal.partyLedgerName}>{proposal.partyLedgerName}</span>
                        <span className={styles.secondary}>{proposal.partyPhone || 'No phone number'}</span></td>
                      <td><span className={styles.primary}>{shortText(proposal.tallyVoucherNumber,'Posted')}</span>
                        <span className={styles.secondary}>{formatDate(proposal.createdInTallyAt ?? proposal.tallyVoucherDate)}</span></td>
                      <td><details className={styles.invoiceDetails}>
                        <summary title={proposal.linkedInvoiceNumber || 'No linked invoice'}>{shortText(proposal.linkedInvoiceNumber,'No linked invoice')}</summary>
                        <div className="py-2 text-[11px] leading-relaxed text-[#5a5046]">
                          <p>Invoice value {formatMoney(proposal.originalInvoiceAmount)}</p>
                          {typeof proposal.amountReceived==='number' ? <p>Received {formatMoney(proposal.amountReceived)}</p> : null}
                          <ContactMeta proposal={proposal} />
                        </div>
                      </details><span className={styles.secondary}>{formatDate(proposal.linkedInvoiceDate)}</span></td>
                      <td className="whitespace-nowrap text-right font-medium tabular-nums">{formatMoney(proposal.recoverableAmount)}</td>
                      <td><span className={styles.posted} title="Debit note created in Tally">Posted</span></td>
                      <td>
                        {canMessage ? <button type="button" className={styles.messageAction} disabled={sending || preparing}
                          onClick={()=>void openWhatsappDialog([proposal])}>
                          {sending || preparing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
                          {preparing ? 'Preparing…' : messageLabel(proposal)}
                        </button> : <span className={styles.secondary} title={proposal.communicationStatus==='sent' ? 'Accepted by the messaging provider. Delivery is not confirmed.' : undefined}>
                          {proposal.communicationStatus==='sent' ? 'Submitted' : proposal.communicationStatus==='failed' ? 'Failed' : proposal.communicationStatus==='drafted' ? 'Verify submission' : 'Not sent'}
                        </span>}
                      </td>
                      <td>{allowed('discounts.export') && proposal.nativeTallyPdfVerified ? <button type="button"
                        className={styles.downloadAction} aria-label={`Download debit note PDF for ${proposal.partyLedgerName}`}
                        title="Download PDF" onClick={()=>void downloadNativeTallyPdf(proposal)}><Download className="h-3.5 w-3.5" /></button> : null}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              <PaginationControls
                onPageChange={setCreatedPage}
                onPageSizeChange={changePageSize}
                page={safeCreatedPage}
                pageSize={pageSize}
                total={createdTotal}
              />
            </div>
          )}
        </section>
      ) : null}

      <Dialog open={followUpBulkMode!==null} onOpenChange={open=>{if(!open&&!followUpBulkBusy)setFollowUpBulkMode(null);}}>
        <DialogContent className="flex max-h-[88dvh] max-w-2xl flex-col overflow-hidden rounded-xl border-[#ded8d0] p-0" showClose={!followUpBulkBusy}>
          <div className="border-b border-[#e8e2db] px-5 py-4 pr-14"><DialogTitle className="text-base">{followUpBulkMode==='enroll'?'Start reminders':'Send once'}</DialogTitle><DialogDescription className="mt-1 text-xs">{selectedFollowUps.length} invoices selected. Tally will verify them together before anything is changed.</DialogDescription></div>
          <div className="min-h-0 overflow-y-auto p-5"><div className="overflow-hidden rounded-lg border border-[#e8e2db]"><table className="w-full text-left text-xs"><thead className="bg-[#faf8f5]"><tr><th className="p-3">Customer / invoice</th><th className="p-3">Outstanding</th><th className="p-3">WhatsApp number</th></tr></thead><tbody>{selectedFollowUps.map(row=><tr className="border-t border-[#e8e2db]" key={row.id}><td className="p-3"><strong>{row.partyLedgerName}</strong><span className="mt-1 block text-[#756b60]">{row.linkedInvoiceNumber}</span></td><td className="p-3 tabular-nums">{formatMoney(row.outstandingAmount)}</td><td className="p-3"><input className="h-9 w-full rounded-lg border border-[#ded8d0] px-3" inputMode="tel" aria-label={`WhatsApp number for ${row.partyLedgerName}`} value={followUpBulkPhones[row.id]||''} onChange={event=>setFollowUpBulkPhones(current=>({...current,[row.id]:event.target.value}))}/></td></tr>)}</tbody></table></div>{selectedFollowUps.some(row=>!row.partyPhone)&&allowed('connections.manage')?<label className="mt-4 flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={followUpBulkSavePhones} onChange={event=>setFollowUpBulkSavePhones(event.target.checked)}/><span>Save newly entered numbers in the corresponding Tally customer ledgers.</span></label>:null}</div>
          <DialogFooter className="m-0 border-t border-[#e8e2db] px-5 py-4"><button className={styles.messageAction} disabled={followUpBulkBusy} onClick={()=>setFollowUpBulkMode(null)}>Cancel</button><button className="rounded-lg bg-[#2f2924] px-4 py-2 text-xs font-semibold text-white disabled:opacity-40" disabled={followUpBulkBusy||selectedFollowUps.some(row=>!(followUpBulkPhones[row.id]||row.partyPhone||'').trim())} onClick={()=>void submitFollowUpBulk()}>{followUpBulkBusy?'Checking Tally…':followUpBulkMode==='enroll'?`Start ${selectedFollowUps.length} schedules`:`Send ${selectedFollowUps.length} messages`}</button></DialogFooter>
        </DialogContent>
      </Dialog>

      {reviewingProposal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 backdrop-blur-sm">
          <div
            aria-labelledby="debit-note-review-title"
            aria-modal="true"
            className="max-h-[calc(100vh-2rem)] w-full max-w-5xl overflow-y-auto rounded-xl border border-[#ded8d0] bg-white shadow-[0_24px_56px_-12px_rgba(0,0,0,0.24)] animate-in fade-in zoom-in-95 duration-200"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4 border-b border-[#e8e2db] bg-[#fcfbfa] px-5 py-4">
              <div className="flex gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-200 bg-amber-50 text-amber-700">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-[#1a1a1a]" id="debit-note-review-title">Review invoice</h3>
                  <p className="mt-1 text-xs text-[#756b60]">Check the amount and accounting details before posting.</p>
                </div>
              </div>
              <button
                aria-label="Close debit note review"
                className="rounded-lg p-2 text-slate-400 transition hover:bg-white hover:text-slate-700"
                disabled={approvingId === reviewingProposal.id}
                onClick={() => {
                  setReviewingProposal(null);
                  setReviewAcknowledged(false);
                }}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-5 py-4">
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,.8fr)]">
                <div className="min-w-0">
                  <div className="border-b border-[#eee7dc] pb-3">
                    <div className="truncate text-xs font-semibold text-[#51483f]">{reviewingProposal.partyLedgerName}</div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1"><strong className="text-lg text-[#1a1a1a]">{shortText(reviewingProposal.linkedInvoiceNumber, "No invoice reference")}</strong><span className="text-xs text-[#8a7f72]">{formatDate(reviewingProposal.linkedInvoiceDate)}</span></div>
                  </div>

                  <dl className="mt-4 grid overflow-hidden rounded-lg border border-[#ded8d0] sm:grid-cols-3">
                    <div className="border-b border-[#e8e2db] bg-[#fcfbfa] p-4 sm:border-b-0 sm:border-r"><dt className="text-[10px] font-semibold uppercase tracking-wide text-[#756b60]">Recorded invoice</dt><dd className="mt-1 tabular-nums text-base font-semibold">{formatMoney(reviewingProposal.originalInvoiceAmount)}</dd></div>
                    <div className="border-b border-amber-200 bg-amber-50 p-4 sm:border-b-0 sm:border-r"><dt className="text-[10px] font-semibold uppercase tracking-wide text-amber-800">Debit note</dt><dd className="mt-1 tabular-nums text-base font-semibold text-amber-950">+ {formatMoney(reviewingProposal.recoverableAmount)}</dd></div>
                    <div className="bg-[#2d2d2d] p-4 text-white"><dt className="text-[10px] font-semibold uppercase tracking-wide text-stone-300">New outstanding</dt><dd className="mt-1 tabular-nums text-base font-semibold">{formatMoney((Number(reviewingProposal.pendingAmount) || 0) + reviewingProposal.recoverableAmount)}</dd></div>
                  </dl>

                  {reviewingProposal.cashDiscountAnalysis?.reversalPlan ? <p className="mt-3 text-xs leading-5 text-[#756b60]"><span className="font-semibold text-[#332c26]">Calculation:</span> {formatMoney(reviewingProposal.cashDiscountAnalysis.reversalPlan.grossInvoiceAmount)} gross − {formatMoney(reviewingProposal.originalInvoiceAmount)} recorded = {formatMoney(reviewingProposal.recoverableAmount)}</p> : null}
                </div>

                <div className="rounded-lg border border-[#ded8d0] bg-[#fcfbfa] p-4 text-xs text-[#5f554b]">
                  <h4 className="font-semibold text-[#1a1a1a]">Posting details</h4>
                  <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5"><dt className="text-[#8a7f72]">Discount deadline</dt><dd className="font-medium text-[#332c26]">{formatDate(reviewingProposal.discountDeadline)}</dd><dt className="text-[#8a7f72]">Rule</dt><dd className="font-medium text-[#332c26]">{conciseTermsLabel(reviewingProposal).replace(/^Applied rule:\s*/i, "")}</dd><dt className="text-[#8a7f72]">Sales ledger</dt><dd className="truncate font-medium text-[#332c26]" title={reviewingProposal.sourceSalesLedgerName || undefined}>{shortText(reviewingProposal.sourceSalesLedgerName, "Not verified")}</dd>{Number(reviewingProposal.pendingAmount)!==Number(reviewingProposal.originalInvoiceAmount)?<><dt className="text-[#8a7f72]">Current outstanding</dt><dd className="font-medium text-[#332c26]">{formatMoney(reviewingProposal.pendingAmount)}</dd></>:null}{reviewingProposal.receiptDate || Number(reviewingProposal.amountReceived) > 0 ? <><dt className="text-[#8a7f72]">Payment received</dt><dd className="font-medium text-[#332c26]">{formatMoney(reviewingProposal.amountReceived)} · {formatDate(reviewingProposal.receiptDate)}</dd></> : null}</dl>
                  {reviewingProposal.cashDiscountAnalysis?.sourceNarration?<div className="mt-3 border-t border-[#e8e2db] pt-3"><div className="text-[#8a7f72]">Tally narration</div><p className="mt-1 line-clamp-2 leading-5 text-[#51483f]" title={reviewingProposal.cashDiscountAnalysis.sourceNarration}>{reviewingProposal.cashDiscountAnalysis.sourceNarration}</p></div>:null}
                </div>
              </div>

              {reviewingProposal.lastError ? <p role="alert" className="mt-3 text-xs text-red-700">{reviewingProposal.lastError}</p> : null}
              {!allowed('discounts.post') ? <p className="mt-3 text-xs text-[#5a5046]">You can review this invoice, but your role cannot post debit notes.</p> : !canCreateInTally(reviewingProposal) ? <p className="mt-3 text-xs text-[#5a5046]">Creation is not available for this invoice in its current state.</p> : null}
              <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-lg border border-[#ded8d0] bg-[#fcfbfa] px-4 py-3 text-xs font-medium text-[#332c26]">
                <input
                  checked={reviewAcknowledged}
                  disabled={!allowed('discounts.post') || !canCreateInTally(reviewingProposal)}
                  className="mt-0.5 h-5 w-5 shrink-0 rounded border-amber-400 text-[#2d2d2d] focus:ring-2 focus:ring-amber-500"
                  onChange={(event) => setReviewAcknowledged(event.target.checked)}
                  type="checkbox"
                />
                <span>I checked the invoice and debit note amount.</span>
              </label>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-[#e8e2db] bg-[#fcfbfa] px-5 py-3 sm:flex-row sm:justify-end">
              <button
                className="inline-flex h-10 items-center justify-center rounded-xl border border-[#e5ddd0] bg-white px-5 text-xs font-medium text-[#5a5046] transition hover:bg-[#faf8f4]"
                disabled={approvingId === reviewingProposal.id}
                onClick={() => {
                  setReviewingProposal(null);
                  setReviewAcknowledged(false);
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#2d2d2d] px-5 text-xs font-medium text-white shadow-sm transition hover:bg-[#1a1a1a] disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!allowed('discounts.post') || !canCreateInTally(reviewingProposal) || !tallyCompanyVerified || Boolean(activeScanRef.current) || dashboard?.preview === true || !reviewAcknowledged || approvingId === reviewingProposal.id}
                onClick={() => void approveProposal(reviewingProposal)}
                type="button"
              >
                {approvingId === reviewingProposal.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Create debit note in Tally
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {whatsappDialogProposals.length > 0 ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
          <div className="w-full max-w-4xl rounded-2xl border border-[#e5ddd0] bg-white p-6 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.18)] animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-start justify-between gap-4 pb-4 border-b border-[#e5ddd0]/60">
              <div className="flex gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100/50">
                  <MessageCircle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-[#1a1a1a]">Send WhatsApp</h3>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {whatsappDialogProposals.length} debit note{whatsappDialogProposals.length === 1 ? "" : "s"} selected.
                    {whatsappDialogMissingCount > 0 ? (
                      <span className="text-amber-600"> Add {whatsappDialogMissingCount} missing number{whatsappDialogMissingCount === 1 ? "" : "s"} before sending.</span>
                    ) : (
                      <span className="text-emerald-600"> Ready to prepare PDFs and send.</span>
                    )}
                  </p>
                </div>
              </div>
              <button
                className="rounded-lg p-1.5 text-slate-400 hover:bg-[#faf8f4] hover:text-slate-700 transition duration-150"
                disabled={whatsappDialogSending}
                onClick={() => setWhatsappDialogProposals([])}
                type="button"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 max-h-[450px] overflow-auto rounded-xl border border-[#e5ddd0]/80">
              <table className="w-full min-w-[620px] table-fixed border-collapse text-left">
                <thead className="sticky top-0 z-10 bg-[#fcfbfa]">
                  <tr className="border-b border-[#e5ddd0] text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    <th className="w-[32%] px-4 py-3 bg-[#fcfbfa]">Customer</th>
                    <th className="w-[20%] px-4 py-3 bg-[#fcfbfa]">Debit note</th>
                    <th className="w-[18%] px-4 py-3 text-right bg-[#fcfbfa]">Amount</th>
                    <th className="w-[30%] px-4 py-3 bg-[#fcfbfa]">WhatsApp number</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e5ddd0] text-xs font-semibold text-slate-600">
                  {whatsappDialogProposals.map((proposal) => {
                    const inputValue = whatsappPhoneInputs[proposal.id] ?? "";
                    const inputInvalid = Boolean(inputValue) && !getTenDigitPhone(inputValue);

                    return (
                      <tr className="align-middle hover:bg-[#fcfbfa]/40 transition-colors" key={proposal.id}>
                        <td className="px-4 py-3">
                          <div className="break-words text-sm font-semibold text-[#1a1a1a]" title={proposal.partyLedgerName}>
                            {proposal.partyLedgerName}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="break-words text-xs font-semibold text-slate-500" title={proposal.tallyVoucherNumber ?? ""}>
                            {shortText(proposal.tallyVoucherNumber, "Debit note")}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-sm font-semibold text-[#1a1a1a]">
                          {formatMoney(proposal.recoverableAmount)}
                        </td>
                        <td className="px-4 py-2.5">
                          {proposal.partyPhone ? (() => {
                            const tenDigit = getTenDigitPhone(proposal.partyPhone ?? "");
                            const displayPhone = tenDigit ? `+91 ${tenDigit}` : proposal.partyPhone;
                            return (
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-250 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                {displayPhone}
                              </span>
                            );
                          })() : (
                            <div>
                              <input
                                className={`h-9 w-full rounded-xl border bg-white px-3 text-sm font-semibold text-[#1a1a1a] outline-none transition duration-150 ${
                                  inputInvalid
                                    ? "border-red-300 focus:border-red-500 focus:ring-2 focus:ring-red-100"
                                    : "border-[#e5ddd0] focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                                }`}
                                inputMode="tel"
                                maxLength={14}
                                onChange={(event) =>
                                  setWhatsappPhoneInputs((current) => ({
                                    ...current,
                                    [proposal.id]: event.target.value,
                                  }))
                                }
                                placeholder="9765723830"
                                value={inputValue}
                              />
                              {inputInvalid ? (
                                <span className="mt-1 flex items-center gap-1 text-[11px] font-medium text-red-600">
                                  <TriangleAlert className="h-3 w-3" /> Enter a valid 10-digit number.
                                </span>
                              ) : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {whatsappDialogMissingCount > 0 ? (
              <label className="mt-4 flex items-start gap-3 rounded-xl border border-amber-200/50 bg-amber-50/30 p-3.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-50/50 cursor-pointer">
                <input
                  checked={whatsappSaveToTally}
                  className="mt-0.5 h-4.5 w-4.5 rounded border-[#d6cabb] text-amber-600 focus:ring-amber-500"
                  onChange={(event) => setWhatsappSaveToTally(event.target.checked)}
                  type="checkbox"
                />
                <div className="flex-1 leading-relaxed">
                  <div className="font-bold text-amber-950">Update Tally Customer Ledgers</div>
                  <div className="mt-0.5 text-slate-500 text-[11px]">Also save entered numbers back to Tally. We will verify each save before confirming it.</div>
                </div>
              </label>
            ) : null}

            <div className="mt-6 flex justify-end gap-3 border-t border-[#e5ddd0]/60 pt-4">
              <button
                className="inline-flex h-10 items-center justify-center rounded-xl border border-[#e5ddd0] bg-white px-5 text-xs font-medium text-[#5a5046] hover:bg-[#faf8f4] transition duration-150"
                disabled={whatsappDialogSending}
                onClick={() => setWhatsappDialogProposals([])}
                type="button"
              >
                Cancel
              </button>
              <button
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#2d2d2d] hover:bg-[#1a1a1a] px-6 text-xs font-medium text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50 transition duration-150"
                disabled={whatsappDialogSending || !allPhonesValid}
                onClick={() => void sendWhatsappFromDialog()}
                type="button"
              >
                {whatsappDialogSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageCircle className="h-3.5 w-3.5" />}
                Prepare PDF & send
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

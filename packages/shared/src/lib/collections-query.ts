// Paged access to a Cash Discount / Payment Follow-ups dashboard.
//
// A dashboard can hold hundreds of thousands of rows, so the page never
// receives it whole. Whoever holds it (the connector, or the page itself for
// an older connector) answers these small queries: one page of one list,
// counts and KPIs, a few rows by id. The rules here are exactly the page's
// own filtering, search and sort rules, in one place for both.
//
// Used by apps/web directly and, generated into plain JavaScript by
// scripts/build-connector-collections-analysis.mjs, by the connector.
// Pure and dependency-free.

export type CollectionsView = "followUps" | "pending" | "created";

export type CollectionsQuery = {
  view: CollectionsView;
  filter?: string;
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
};

type Row = Record<string, unknown>;
type Dashboard = { kpis?: Record<string, unknown>; tabs?: { paymentFollowUps?: unknown[]; debitNoteQueue?: unknown[] } } & Record<string, unknown>;

export const MAX_PAGE_SIZE = 200;
export const MAX_ROWS_BY_ID = 1000;

// The follow-up fields the page shows or acts on (table, bulk reminders,
// CSV export, reminder schedule). The rest are fetched for one row on demand.
export const FOLLOW_UP_LIST_FIELDS = [
  "id", "followUpStatus", "ageBasis", "ageDays", "ageLabel", "dueDate", "partyLedgerName", "partyPhone", "partyEmail",
  "linkedInvoiceNumber", "linkedInvoiceDate", "originalInvoiceAmount", "outstandingAmount", "amountReceived", "currentDiscount",
] as const;

const text = (value: unknown) => String(value ?? "");
const number = (value: unknown) => Number(value) || 0;
const collator = new Intl.Collator("en");

export function isPendingDebitNote(proposal: Row) {
  return ["draft", "pending_approval", "approved", "queued_in_tally", "failed"].includes(text(proposal.status));
}
export function isCreatedDebitNote(proposal: Row) {
  return proposal.status === "created_in_tally";
}
export function canCreateInTally(proposal: Row) {
  if (proposal.canCreateDebitNote === false) return false;
  return ["draft", "pending_approval", "failed"].includes(text(proposal.status));
}

function followUps(dashboard: Dashboard | null | undefined) {
  return (dashboard?.tabs?.paymentFollowUps ?? []) as Row[];
}
function proposals(dashboard: Dashboard | null | undefined) {
  return (dashboard?.tabs?.debitNoteQueue ?? []) as Row[];
}

function sortFollowUps(rows: Row[], sort: string) {
  const basisRank: Record<string, number> = { due_date: 1, invoice_date: 2, missing_dates: 3 };
  const compareName = (left: Row, right: Row) => collator.compare(text(left.partyLedgerName), text(right.partyLedgerName));
  const compareAmount = (left: Row, right: Row) => number(right.outstandingAmount) - number(left.outstandingAmount);
  const compareAge = (left: Row, right: Row) => {
    const basisDifference = (basisRank[text(left.ageBasis)] ?? 4) - (basisRank[text(right.ageBasis)] ?? 4);
    if (basisDifference !== 0) return basisDifference;
    return (right.ageDays == null ? -1 : number(right.ageDays)) - (left.ageDays == null ? -1 : number(left.ageDays));
  };
  const invoiceTime = (row: Row) => Date.parse(`${text(row.linkedInvoiceDate)}T00:00:00.000Z`) || Number.MAX_SAFE_INTEGER;
  return [...rows].sort((left, right) => {
    if (sort === "customer") return compareName(left, right);
    if (sort === "highest_outstanding") return compareAmount(left, right) || compareAge(left, right) || compareName(left, right);
    if (sort === "oldest_invoice") return invoiceTime(left) - invoiceTime(right) || compareAmount(left, right) || compareName(left, right);
    if (sort === "most_overdue") return compareAge(left, right) || compareAmount(left, right) || compareName(left, right);
    const priority = (basisRank[text(left.ageBasis)] ?? 4) - (basisRank[text(right.ageBasis)] ?? 4);
    return priority || compareAge(left, right) || compareAmount(left, right) || compareName(left, right);
  });
}

function matchesSearch(values: unknown[], query: string) {
  return !query || values.some((value) => text(value).toLowerCase().includes(query));
}

function pendingRows(dashboard: Dashboard | null | undefined, filter: string, search: string, sort: string) {
  const query = search.trim().toLowerCase();
  const rows = proposals(dashboard).filter(isPendingDebitNote).filter((proposal) => {
    if (filter === "ready" && !["draft", "pending_approval"].includes(text(proposal.status))) return false;
    if (filter === "in_progress" && !["approved", "queued_in_tally"].includes(text(proposal.status))) return false;
    if (filter === "failed" && proposal.status !== "failed") return false;
    const analysis = (proposal.cashDiscountAnalysis ?? {}) as Row;
    return matchesSearch([proposal.partyLedgerName, proposal.linkedInvoiceNumber, proposal.cashDiscountRuleName, analysis.sourceNarration, proposal.lastError], query);
  });
  const dateValue = (value: unknown) => Date.parse(text(value)) || Number.MAX_SAFE_INTEGER;
  return rows.sort((left, right) => {
    if (sort === "highest_recovery") return number(right.recoverableAmount) - number(left.recoverableAmount);
    if (sort === "invoice_oldest") return dateValue(left.linkedInvoiceDate) - dateValue(right.linkedInvoiceDate);
    if (sort === "customer") return collator.compare(text(left.partyLedgerName), text(right.partyLedgerName));
    return dateValue(left.discountDeadline) - dateValue(right.discountDeadline);
  });
}

function createdRows(dashboard: Dashboard | null | undefined, filter: string, search: string, sort: string) {
  const query = search.trim().toLowerCase();
  const rows = proposals(dashboard).filter(isCreatedDebitNote).filter((proposal) => {
    if (filter === "sent" && proposal.communicationStatus !== "sent") return false;
    if (filter === "not_sent" && proposal.communicationStatus === "sent") return false;
    if (filter === "failed" && proposal.communicationStatus !== "failed") return false;
    return matchesSearch([proposal.partyLedgerName, proposal.linkedInvoiceNumber, proposal.tallyVoucherNumber, proposal.narration], query);
  });
  const dateValue = (value: unknown) => Date.parse(text(value)) || 0;
  return rows.sort((left, right) => {
    if (sort === "highest_amount") return number(right.recoverableAmount) - number(left.recoverableAmount);
    if (sort === "invoice_newest") return dateValue(right.linkedInvoiceDate) - dateValue(left.linkedInvoiceDate);
    if (sort === "customer") return collator.compare(text(left.partyLedgerName), text(right.partyLedgerName));
    return dateValue(right.createdInTallyAt ?? right.tallyVoucherDate) - dateValue(left.createdInTallyAt ?? left.tallyVoucherDate);
  });
}

function followUpRows(dashboard: Dashboard | null | undefined, filter: string, search: string, sort: string) {
  const query = search.trim().toLowerCase();
  const rows = followUps(dashboard).filter((row) =>
    (!filter || filter === "all" || row.followUpStatus === filter) &&
    matchesSearch([row.partyLedgerName, row.linkedInvoiceNumber], query));
  return sortFollowUps(rows, sort || "priority");
}

function listRow(view: CollectionsView, row: Row) {
  return view === "followUps" ? Object.fromEntries(FOLLOW_UP_LIST_FIELDS.map((field) => [field, row[field] ?? null])) : row;
}

// Filtered, sorted lists are remembered per dashboard (a few per dashboard),
// so moving through pages does not sort a large list again each time.
const matchingCache = new WeakMap<object, Map<string, Row[]>>();
const MATCHING_CACHE_ENTRIES = 8;

function matching(dashboard: Dashboard | null | undefined, query: CollectionsQuery) {
  const filter = text(query.filter || "all"), search = text(query.search), sort = text(query.sort);
  if (!["followUps", "pending", "created"].includes(query.view)) throw new Error(`Unknown collections list ${String(query.view)}.`);
  const key = JSON.stringify([query.view, filter, search.trim().toLowerCase(), sort]);
  const cache = dashboard ? matchingCache.get(dashboard) ?? new Map<string, Row[]>() : null;
  const cached = cache?.get(key);
  if (cached) return cached;
  const rows = query.view === "followUps" ? followUpRows(dashboard, filter, search, sort)
    : query.view === "pending" ? pendingRows(dashboard, filter, search, sort)
    : createdRows(dashboard, filter, search, sort);
  if (dashboard && cache) {
    if (cache.size >= MATCHING_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, rows);
    matchingCache.set(dashboard, cache);
  }
  return rows;
}

/** One page of one list. Follow-up rows carry only their list fields. */
export function queryCollections(dashboard: Dashboard | null | undefined, query: CollectionsQuery) {
  const rows = matching(dashboard, query);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(number(query.pageSize) || 25)));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(number(query.page) || 1)));
  return {
    view: query.view,
    total: rows.length,
    page,
    pageSize,
    pageCount,
    rows: rows.slice((page - 1) * pageSize, page * pageSize).map((row) => listRow(query.view, row)),
    // Ids of every matching row that can be acted on, for "select all".
    selectableIds: query.view === "pending" ? rows.filter(canCreateInTally).map((row) => text(row.id)) : undefined,
  };
}

/** Full rows by id (a review dialog, bulk actions, CSV export). */
export function collectionRowsById(dashboard: Dashboard | null | undefined, view: CollectionsView, ids: string[]) {
  const wanted = new Set(ids.slice(0, MAX_ROWS_BY_ID).map(text));
  const source = view === "followUps" ? followUps(dashboard) : proposals(dashboard);
  return source.filter((row) => wanted.has(text(row.id)));
}

/** Same key as the page's proposalInvoiceKey: customer and invoice number. */
export function invoiceKey(row: Row) {
  const normalize = (value: unknown) => text(value).trim().toLowerCase().replace(/\s+/g, " ");
  return `${normalize(row.partyLedgerName)}|${normalize(row.linkedInvoiceNumber)}`;
}

/** Full rows for given invoices (e.g. the debit notes just created for them). */
export function collectionRowsByInvoice(dashboard: Dashboard | null | undefined, view: CollectionsView, keys: string[]) {
  const wanted = new Set(keys.slice(0, MAX_ROWS_BY_ID).map(text));
  const source = view === "followUps" ? followUps(dashboard)
    : view === "created" ? proposals(dashboard).filter(isCreatedDebitNote)
    : proposals(dashboard).filter(isPendingDebitNote);
  return source.filter((row) => wanted.has(invoiceKey(row)));
}

/** KPIs and counts for tabs and filters, without any rows. */
export function summarizeCollections(dashboard: Dashboard | null | undefined) {
  const followUpList = followUps(dashboard);
  const proposalList = proposals(dashboard);
  const pending = proposalList.filter(isPendingDebitNote);
  const created = proposalList.filter(isCreatedDebitNote);
  const count = (rows: Row[], test: (row: Row) => boolean) => rows.reduce((total, row) => total + (test(row) ? 1 : 0), 0);
  return {
    followUps: {
      total: followUpList.length,
      needsFollowUp: count(followUpList, (row) => row.followUpStatus === "needs_follow_up"),
      escalated: count(followUpList, (row) => row.followUpStatus === "escalate"),
      needsReview: count(followUpList, (row) => row.followUpStatus === "needs_review"),
      outstanding: followUpList.reduce((total, row) => total + number(row.outstandingAmount), 0),
    },
    pending: {
      all: pending.length,
      ready: count(pending, (row) => ["draft", "pending_approval"].includes(text(row.status))),
      in_progress: count(pending, (row) => ["approved", "queued_in_tally"].includes(text(row.status))),
      failed: count(pending, (row) => row.status === "failed"),
      selectable: count(pending, canCreateInTally),
      recoverable: pending.reduce((total, row) => total + number(row.recoverableAmount), 0),
    },
    created: {
      all: created.length,
      sent: count(created, (row) => row.communicationStatus === "sent"),
      not_sent: count(created, (row) => row.communicationStatus !== "sent"),
      failed: count(created, (row) => row.communicationStatus === "failed"),
      recoverable: created.reduce((total, row) => total + number(row.recoverableAmount), 0),
    },
    revision: dashboardRevision(dashboard),
  };
}

// The fields whose change must make an open page reload: identity, status,
// amounts and ages. (Other fields only change together with one of these.)
const FOLLOW_UP_REVISION_FIELDS = ["id", "followUpStatus", "outstandingAmount", "amountReceived", "ageDays", "ageBasis", "dueDate", "partyPhone"];
// Includes what drives the Download PDF and "Send updated PDF" actions (PDF
// verified, when it was sent, when the PDF was exported) and a saved phone.
const PROPOSAL_REVISION_FIELDS = ["id", "status", "communicationStatus", "communicationSentAt", "nativeTallyPdfVerified", "partyPhone",
  "recoverableAmount", "lastError", "tallyVoucherNumber", "canCreateDebitNote"];

/** Changes whenever anything the lists show changes (FNV-1a over key fields). */
export function dashboardRevision(dashboard: Dashboard | null | undefined) {
  let hash = 0x811c9dc5, length = 0;
  const add = (value: unknown) => {
    const source = value === null || value === undefined ? "\u0000" : String(value);
    length += source.length + 1;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  add(JSON.stringify(dashboard?.kpis ?? null));
  for (const row of followUps(dashboard)) for (const field of FOLLOW_UP_REVISION_FIELDS) add(row[field]);
  add("|");
  for (const row of proposals(dashboard)) {
    for (const field of PROPOSAL_REVISION_FIELDS) add(row[field]);
    add(((row.nativeTallyPdf ?? null) as Row | null)?.exportedAt);
  }
  return `${length.toString(36)}-${hash.toString(36)}`;
}

/** What the page receives instead of the dashboard: everything but the lists. */
export function dashboardShell(dashboard: Dashboard) {
  const { tabs: _tabs, narrationAnalysis: _narration, ...rest } = dashboard;
  return { ...rest, paged: true as const, summary: summarizeCollections(dashboard) };
}

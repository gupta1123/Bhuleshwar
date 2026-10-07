import test from "node:test";
import assert from "node:assert/strict";
import { queryCollections, collectionRowsById, summarizeCollections, dashboardShell, FOLLOW_UP_LIST_FIELDS } from "./collections-analysis/collections-query.mjs";
import { storeCollectionsDashboard, answerCollectionsRequest } from "./bridge.mjs";

// ---- Reference: the Collections page's own list logic, copied verbatim from
// apps/web/src/components/collections/CollectionsDashboardPage.tsx (before
// paging), with types removed. The paged engine must return the same rows in
// the same order. (Names use Intl.Collator("en"), as the engine does, so the
// result does not depend on the machine's locale.)
const collator = new Intl.Collator("en");
function sortPaymentFollowUpRows(rows, sort) {
  const basisRank = { due_date: 1, invoice_date: 2, missing_dates: 3 };
  const compareName = (left, right) => collator.compare(left.partyLedgerName, right.partyLedgerName);
  const compareAmount = (left, right) => right.outstandingAmount - left.outstandingAmount;
  const compareAge = (left, right) => {
    const basisDifference = basisRank[left.ageBasis] - basisRank[right.ageBasis];
    if (basisDifference !== 0) return basisDifference;
    return (right.ageDays ?? -1) - (left.ageDays ?? -1);
  };
  return [...rows].sort((left, right) => {
    if (sort === "customer") return compareName(left, right);
    if (sort === "highest_outstanding") return compareAmount(left, right) || compareAge(left, right) || compareName(left, right);
    if (sort === "oldest_invoice") {
      const leftDate = Date.parse(`${left.linkedInvoiceDate ?? ""}T00:00:00.000Z`) || Number.MAX_SAFE_INTEGER;
      const rightDate = Date.parse(`${right.linkedInvoiceDate ?? ""}T00:00:00.000Z`) || Number.MAX_SAFE_INTEGER;
      return leftDate - rightDate || compareAmount(left, right) || compareName(left, right);
    }
    if (sort === "most_overdue") return compareAge(left, right) || compareAmount(left, right) || compareName(left, right);
    const leftPriority = basisRank[left.ageBasis];
    const rightPriority = basisRank[right.ageBasis];
    return leftPriority - rightPriority || compareAge(left, right) || compareAmount(left, right) || compareName(left, right);
  });
}
const isPendingDebitNote = (proposal) => ["draft", "pending_approval", "approved", "queued_in_tally", "failed"].includes(proposal.status);
const isCreatedDebitNote = (proposal) => proposal.status === "created_in_tally";
function visiblePendingProposals(proposals, pendingFilter, pendingQuery, pendingSort) {
  const query = pendingQuery.trim().toLowerCase();
  const rows = proposals.filter(isPendingDebitNote).filter((proposal) => {
    if (pendingFilter === "ready" && !["draft", "pending_approval"].includes(proposal.status)) return false;
    if (pendingFilter === "in_progress" && !["approved", "queued_in_tally"].includes(proposal.status)) return false;
    if (pendingFilter === "failed" && proposal.status !== "failed") return false;
    if (!query) return true;
    return [proposal.partyLedgerName, proposal.linkedInvoiceNumber, proposal.cashDiscountRuleName, proposal.cashDiscountAnalysis?.sourceNarration, proposal.lastError]
      .some((value) => String(value ?? "").toLowerCase().includes(query));
  });
  const dateValue = (value) => Date.parse(value ?? "") || Number.MAX_SAFE_INTEGER;
  return [...rows].sort((left, right) => {
    if (pendingSort === "highest_recovery") return (right.recoverableAmount || 0) - (left.recoverableAmount || 0);
    if (pendingSort === "invoice_oldest") return dateValue(left.linkedInvoiceDate) - dateValue(right.linkedInvoiceDate);
    if (pendingSort === "customer") return collator.compare(left.partyLedgerName, right.partyLedgerName);
    return dateValue(left.discountDeadline) - dateValue(right.discountDeadline);
  });
}
function visibleCreatedProposals(proposals, createdFilter, createdQuery, createdSort) {
  const query = createdQuery.trim().toLowerCase();
  const rows = proposals.filter(isCreatedDebitNote).filter((proposal) => {
    if (createdFilter === "sent" && proposal.communicationStatus !== "sent") return false;
    if (createdFilter === "not_sent" && proposal.communicationStatus === "sent") return false;
    if (createdFilter === "failed" && proposal.communicationStatus !== "failed") return false;
    if (!query) return true;
    return [proposal.partyLedgerName, proposal.linkedInvoiceNumber, proposal.tallyVoucherNumber, proposal.narration]
      .some((value) => String(value ?? "").toLowerCase().includes(query));
  });
  const dateValue = (value) => Date.parse(value ?? "") || 0;
  return [...rows].sort((left, right) => {
    if (createdSort === "highest_amount") return (right.recoverableAmount || 0) - (left.recoverableAmount || 0);
    if (createdSort === "invoice_newest") return dateValue(right.linkedInvoiceDate) - dateValue(left.linkedInvoiceDate);
    if (createdSort === "customer") return collator.compare(left.partyLedgerName, right.partyLedgerName);
    return dateValue(right.createdInTallyAt ?? right.tallyVoucherDate) - dateValue(left.createdInTallyAt ?? left.tallyVoucherDate);
  });
}

// ---- A varied dashboard, including ties, missing values and odd dates.
function dashboard(seed = 11) {
  let state = seed;
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const pick = (list) => list[Math.floor(random() * list.length)];
  const date = () => (random() < 0.1 ? null : `2026-${pick(["04", "05", "06"])}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`);
  const names = ["Apex Traders", "apex traders", "Balaji Stores", "Ćelik Steel", "Zenith Works", "Äbc Metals", "10 Star Co"];
  const paymentFollowUps = Array.from({ length: 700 }, (_, index) => ({
    id: `fu-${index}`, kind: "payment_due", followUpStatus: pick(["needs_follow_up", "escalate", "needs_review"]),
    ageBasis: pick(["due_date", "invoice_date", "missing_dates"]), ageDays: random() < 0.2 ? null : Math.floor(random() * 90), ageLabel: "x days",
    dueDate: date(), partyLedgerName: pick(names), partyPhone: random() < 0.5 ? "9876543210" : null, partyEmail: null, partyGstin: "27AAA",
    linkedInvoiceNumber: `INV-${Math.floor(random() * 50)}`, linkedInvoiceDate: date(), originalInvoiceAmount: 1000,
    outstandingAmount: pick([100, 250.5, 1000, 1000, 99999]), amountReceived: 0, narration: "long narration ".repeat(10),
    currentDiscount: random() < 0.3 ? { ratePercent: 1.5, discountDeadline: date() } : null, terms: [], reversalPlan: null,
  }));
  const debitNoteQueue = Array.from({ length: 400 }, (_, index) => ({
    id: `dn-${index}`, status: pick(["draft", "pending_approval", "approved", "queued_in_tally", "failed", "created_in_tally", "created_in_tally"]),
    canCreateDebitNote: random() < 0.9, partyLedgerName: pick(names), linkedInvoiceNumber: `INV-${Math.floor(random() * 50)}`,
    linkedInvoiceDate: date(), discountDeadline: date(), recoverableAmount: pick([10, 55.5, 55.5, 1200]),
    cashDiscountRuleName: pick(["1.5% in 7 days", "2% in 10 days", null]), cashDiscountAnalysis: { sourceNarration: pick(["cd 2%", "Special TERMS", null]) },
    lastError: random() < 0.1 ? "Tally busy" : null, communicationStatus: pick(["sent", "failed", null]), tallyVoucherNumber: `DN/${index}`,
    narration: pick(["Recovery", "cd reversal"]), createdInTallyAt: random() < 0.5 ? date() : null, tallyVoucherDate: date(),
  }));
  return { setupRequired: false, kpis: { cdExpired: 3 }, company: { name: "Demo" }, tabs: { paymentFollowUps, debitNoteQueue, cashDiscountTracker: debitNoteQueue }, narrationAnalysis: [{ big: true }] };
}

const all = (view, filter, search, sort, source) => {
  const rows = [];
  for (let page = 1; ; page += 1) {
    const result = queryCollections(source, { view, filter, search, sort, page, pageSize: 37 });
    rows.push(...result.rows);
    if (page >= result.pageCount) return { rows, total: result.total };
  }
};

test("follow-up pages, in every sort, equal the page's own sorted list", () => {
  const source = dashboard();
  for (const sort of ["priority", "most_overdue", "highest_outstanding", "oldest_invoice", "customer"]) {
    const expected = sortPaymentFollowUpRows(source.tabs.paymentFollowUps, sort).map((row) => row.id);
    const { rows, total } = all("followUps", "all", "", sort, source);
    assert.equal(total, 700);
    assert.deepEqual(rows.map((row) => row.id), expected, `sort ${sort}`);
  }
});

test("follow-up rows carry only their list fields", () => {
  const { rows } = queryCollections(dashboard(), { view: "followUps", page: 1, pageSize: 5 });
  assert.deepEqual(Object.keys(rows[0]).sort(), [...FOLLOW_UP_LIST_FIELDS].sort());
  assert.equal("narration" in rows[0], false);
});

test("pending and created debit-note pages equal the page's filters, search and sorts", () => {
  const source = dashboard(29);
  const proposals = source.tabs.debitNoteQueue;
  for (const search of ["", "apex", "TERMS", "tally busy", "inv-1", "no such"]) {
    for (const filter of ["all", "ready", "in_progress", "failed"]) {
      for (const sort of ["deadline_oldest", "highest_recovery", "invoice_oldest", "customer"]) {
        const expected = visiblePendingProposals(proposals, filter, search, sort).map((row) => row.id);
        assert.deepEqual(all("pending", filter, search, sort, source).rows.map((row) => row.id), expected, `pending ${filter}/${search}/${sort}`);
      }
    }
    for (const filter of ["all", "sent", "not_sent", "failed"]) {
      for (const sort of ["created_newest", "highest_amount", "invoice_newest", "customer"]) {
        const expected = visibleCreatedProposals(proposals, filter, search, sort).map((row) => row.id);
        assert.deepEqual(all("created", filter, search, sort, source).rows.map((row) => row.id), expected, `created ${filter}/${search}/${sort}`);
      }
    }
  }
});

test("KPIs and counts equal what the page calculated from the full lists", () => {
  const source = dashboard(5);
  const summary = summarizeCollections(source);
  const followUps = source.tabs.paymentFollowUps;
  assert.deepEqual(summary.followUps, {
    total: followUps.length,
    needsFollowUp: followUps.filter((item) => item.followUpStatus === "needs_follow_up").length,
    escalated: followUps.filter((item) => item.followUpStatus === "escalate").length,
    needsReview: followUps.filter((item) => item.followUpStatus === "needs_review").length,
    outstanding: followUps.reduce((total, item) => total + (Number(item.outstandingAmount) || 0), 0),
  });
  const pending = source.tabs.debitNoteQueue.filter(isPendingDebitNote);
  assert.equal(summary.pending.all, pending.length);
  assert.equal(summary.pending.ready, visiblePendingProposals(source.tabs.debitNoteQueue, "ready", "", "customer").length);
  assert.equal(summary.created.not_sent, visibleCreatedProposals(source.tabs.debitNoteQueue, "not_sent", "", "customer").length);
});

test("pages clamp safely, and select-all lists every actionable pending row", () => {
  const source = dashboard(3);
  assert.equal(queryCollections(source, { view: "followUps", page: 999, pageSize: 50 }).page, 14);
  assert.equal(queryCollections(source, { view: "followUps", page: 1, pageSize: 10_000 }).pageSize, 200);
  const pending = queryCollections(source, { view: "pending", filter: "all", page: 1, pageSize: 10 });
  assert.equal(pending.selectableIds.length, source.tabs.debitNoteQueue.filter((row) => isPendingDebitNote(row) && row.canCreateDebitNote !== false && ["draft", "pending_approval", "failed"].includes(row.status)).length);
  assert.throws(() => queryCollections(source, { view: "everything" }), /Unknown collections list/);
});

test("the shell has KPIs and counts but no lists", () => {
  const shell = dashboardShell(dashboard());
  assert.equal(shell.paged, true);
  assert.equal("tabs" in shell || "narrationAnalysis" in shell, false);
  assert.deepEqual(shell.kpis, { cdExpired: 3 });
  assert.equal(shell.summary.followUps.total, 700);
  assert.ok(JSON.stringify(shell).length < 2_000);
});

test("the connector keeps each dashboard for its own connection and the one before it", () => {
  const config = { connectionId: "conn-1" };
  const first = storeCollectionsDashboard(config, { companyName: "Demo", financialYear: "2026-27", followUps: false, dashboard: dashboard(1) });
  const page = answerCollectionsRequest(config, "collections_query", { payload: { dashboardId: first.dashboardId, query: { view: "pending", page: 1, pageSize: 5 } } });
  assert.equal(page.rows.length, 5);
  const rows = answerCollectionsRequest(config, "collections_rows", { payload: { dashboardId: first.dashboardId, view: "followUps", ids: ["fu-1", "fu-2"] } });
  assert.deepEqual(rows.rows.map((row) => row.id), ["fu-1", "fu-2"]);
  assert.ok("narration" in rows.rows[0], "rows by id are complete");
  assert.throws(() => answerCollectionsRequest({ connectionId: "conn-2" }, "collections_query", { payload: { dashboardId: first.dashboardId, query: { view: "pending" } } }), /another connection/);
  storeCollectionsDashboard(config, { companyName: "Demo", financialYear: "2026-27", followUps: false, dashboard: dashboard(2) });
  assert.ok(answerCollectionsRequest(config, "collections_query", { payload: { dashboardId: first.dashboardId, query: { view: "pending" } } }), "previous still answers");
  storeCollectionsDashboard(config, { companyName: "Demo", financialYear: "2026-27", followUps: false, dashboard: dashboard(3) });
  assert.throws(() => answerCollectionsRequest(config, "collections_query", { payload: { dashboardId: first.dashboardId, query: { view: "pending" } } }), /replaced by a newer check/);
});

test("the revision changes when a WhatsApp or PDF state changes, so the page reloads that row", () => {
  const base = dashboard(8);
  const revision = (change) => {
    const copy = structuredClone(base);
    change(copy.tabs.debitNoteQueue[0]);
    return summarizeCollections(copy).revision;
  };
  const original = summarizeCollections(base).revision;
  assert.equal(revision(() => {}), original, "no change, same revision");
  for (const [label, change] of [
    ["message status", (row) => { row.communicationStatus = "sent"; }],
    ["sent time", (row) => { row.communicationSentAt = "2026-09-30T10:00:00Z"; }],
    ["PDF verified", (row) => { row.nativeTallyPdfVerified = true; }],
    ["PDF exported", (row) => { row.nativeTallyPdf = { exportedAt: "2026-09-30T10:05:00Z" }; }],
    ["phone saved", (row) => { row.partyPhone = "9876500000"; }],
  ]) assert.notEqual(revision(change), original, label);
});

test("rows by id are capped", () => {
  assert.equal(collectionRowsById(dashboard(), "followUps", Array.from({ length: 5000 }, (_, index) => `fu-${index % 700}`)).length, 700);
});

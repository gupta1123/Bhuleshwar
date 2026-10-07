import assert from "node:assert/strict";
import test from "node:test";

import {
  derivePaymentFollowUpTiming,
  isCollectionOnlyPaymentFollowUp,
  sortPaymentFollowUpsByPriority,
} from "./payment-follow-up.ts";

test("requires seven days past the Tally due date", () => {
  assert.equal(
    derivePaymentFollowUpTiming({ dueDate: "2026-08-03", invoiceDate: "2026-07-01" }, "2026-08-10").eligible,
    true
  );
  assert.equal(
    derivePaymentFollowUpTiming({ dueDate: "2026-08-04", invoiceDate: "2026-07-01" }, "2026-08-10").eligible,
    false
  );
});

test("uses invoice age only when the due date is missing or invalid", () => {
  const timing = derivePaymentFollowUpTiming({ dueDate: null, invoiceDate: "2026-08-03" }, "2026-08-10");
  assert.deepEqual(timing, {
    eligible: true,
    ageBasis: "invoice_date",
    ageDays: 7,
    ageLabel: "7 days since invoice",
    dueDate: null,
    invoiceDate: "2026-08-03",
  });
});

test("keeps bills with no usable dates in review", () => {
  const timing = derivePaymentFollowUpTiming({}, "2026-08-10");
  assert.equal(timing.eligible, true);
  assert.equal(timing.ageBasis, "missing_dates");
  assert.equal(timing.ageDays, null);
});

test("collection-only filtering removes bills that still require a Debit Note", () => {
  const rows = [
    { partyLedgerName: "Debit note", followUpStatus: "debit_note_required", ageBasis: "invoice_date", ageDays: 10, outstandingAmount: 500 },
    { partyLedgerName: "Payment", followUpStatus: "needs_follow_up", ageBasis: "due_date", ageDays: 10, outstandingAmount: 500 },
  ].filter(isCollectionOnlyPaymentFollowUp);

  assert.deepEqual(rows.map((row) => row.partyLedgerName), ["Payment"]);
});

test("priority sorting orders overdue, invoice fallback, then missing-date review", () => {
  const rows = sortPaymentFollowUpsByPriority([
    { partyLedgerName: "Missing", followUpStatus: "needs_review", ageBasis: "missing_dates", ageDays: null, outstandingAmount: 500 },
    { partyLedgerName: "Invoice fallback", followUpStatus: "needs_follow_up", ageBasis: "invoice_date", ageDays: 60, outstandingAmount: 500 },
    { partyLedgerName: "Overdue", followUpStatus: "needs_follow_up", ageBasis: "due_date", ageDays: 20, outstandingAmount: 500 },
  ]);

  assert.deepEqual(rows.map((row) => row.partyLedgerName), [
    "Overdue",
    "Invoice fallback",
    "Missing",
  ]);
});

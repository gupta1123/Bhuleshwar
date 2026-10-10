import assert from "node:assert/strict";
import test from "node:test";

import {
  analyseCashDiscountNarration,
  parseCashDiscountNarration,
  parseCashDiscountTerms,
} from "./cash-discount-narration.ts";

test("defaults 1.5% to 7 days and 1% to 15 days", () => {
  assert.deepEqual(parseCashDiscountTerms("Cash discount 1.5% and 1%"), [
    { ratePercent: 1.5, eligibilityDays: 7, periodSource: "default" },
    { ratePercent: 1, eligibilityDays: 15, periodSource: "default" },
  ]);
});

test("recognizes CD and C.D. markers without explicit periods", () => {
  assert.deepEqual(parseCashDiscountTerms("CD 1%"), [
    { ratePercent: 1, eligibilityDays: 15, periodSource: "default" },
  ]);
  assert.deepEqual(parseCashDiscountTerms("C.D. 1.5%"), [
    { ratePercent: 1.5, eligibilityDays: 7, periodSource: "default" },
  ]);
});

test("written periods never override the fixed client windows", () => {
  assert.deepEqual(
    parseCashDiscountTerms("Cash discount 1.5% within 10 days and 1% within 20 days"),
    [
      { ratePercent: 1.5, eligibilityDays: 7, periodSource: "default" },
      { ratePercent: 1, eligibilityDays: 15, periodSource: "default" },
    ]
  );
});

test("ignores working-day wording and applies the fixed window for the detected rate", () => {
  assert.deepEqual(
    parseCashDiscountTerms("Cash Discount 1% within 4 working days"),
    [{ ratePercent: 1, eligibilityDays: 15, periodSource: "default" }]
  );
});

test("normalizes supported rate and period wording variants", () => {
  assert.deepEqual(
    parseCashDiscountTerms("C.D. @ 1.00 % if paid in four business days"),
    [{ ratePercent: 1, eligibilityDays: 15, periodSource: "default" }]
  );
  assert.deepEqual(
    parseCashDiscountTerms("One and a half percent cash discount within seven calendar days"),
    [{ ratePercent: 1.5, eligibilityDays: 7, periodSource: "default" }]
  );
  assert.deepEqual(
    parseCashDiscountTerms("Cash disc: 1.50 percent"),
    [{ ratePercent: 1.5, eligibilityDays: 7, periodSource: "default" }]
  );
  assert.deepEqual(
    parseCashDiscountTerms("CD 1½%"),
    [{ ratePercent: 1.5, eligibilityDays: 7, periodSource: "default" }]
  );
});

test("recognizes compact paired cash-discount tiers", () => {
  assert.deepEqual(
    parseCashDiscountTerms("Cash discount 1.5/1% for 7/15 days"),
    [
      { ratePercent: 1.5, eligibilityDays: 7, periodSource: "default" },
      { ratePercent: 1, eligibilityDays: 15, periodSource: "default" },
    ]
  );
});

test("uses the fixed 15-day window even when narration says four working days", () => {
  const analysis = analyseCashDiscountNarration({
    narration: "Cash Discount 1% within 4 working days",
    invoiceDate: "2026-08-07",
    originalAmount: 80_000,
    pendingAmount: 80_000,
    today: "2026-08-16",
  });
  assert.equal(analysis.discountDeadline, "2026-08-22");
  assert.equal(analysis.deterministicStatus, "within_eligibility_window");
  assert.equal(analysis.reversalPlan?.totalReversalRequired, 0);
});

test("does not treat unrelated percentages as cash discounts", () => {
  assert.deepEqual(parseCashDiscountTerms("GST 1% and interest 1.5%"), []);
  const analysis = analyseCashDiscountNarration({
    narration: "GST 1% and interest 1.5%",
    invoiceDate: "2026-06-01",
    originalAmount: 100_000,
    pendingAmount: 1_500,
    receiptDate: "2026-06-25",
    matchedReceiptAmount: 98_500,
    today: "2026-07-01",
  });
  assert.equal(analysis.deterministicStatus, "no_cash_discount_context");
});

test("does not match 1% inside 1.5% or 11%", () => {
  const parsed = parseCashDiscountNarration("CD 11% and 1.5%");
  assert.deepEqual(parsed.supportedRates, [1.5]);
  assert.deepEqual(parsed.unsupportedRates, [11]);
  assert.deepEqual(parsed.terms, [
    { ratePercent: 1.5, eligibilityDays: 7, periodSource: "default" },
  ]);
});

test("marks a cash-discount narration with only an unsupported rate for review", () => {
  const analysis = analyseCashDiscountNarration({
    narration: "Cash discount 2%",
    invoiceDate: "2026-06-01",
    originalAmount: 100_000,
    pendingAmount: 2_000,
    today: "2026-07-01",
  });
  assert.equal(analysis.deterministicStatus, "unsupported_cash_discount_rate");
});

test("routes a late short payment to collection when the balance is already open", () => {
  const analysis = analyseCashDiscountNarration({
    narration: "Cash discount 1.5%",
    invoiceDate: "2026-06-01",
    originalAmount: 100_000,
    pendingAmount: 1_500,
    receiptDate: "2026-06-25",
    matchedReceiptAmount: 98_500,
    today: "2026-07-01",
  });
  assert.equal(analysis.discountDeadline, "2026-06-08");
  assert.equal(analysis.deterministicStatus, "existing_balance_due");
  assert.equal(analysis.matchedDiscount?.amount, 1_500);
  assert.match(analysis.deterministicReason, /without creating another debit note/);
});

test("keeps the deadline date eligible", () => {
  const analysis = analyseCashDiscountNarration({
    narration: "CD 1.5%",
    invoiceDate: "2026-06-01",
    originalAmount: 100_000,
    pendingAmount: 1_500,
    receiptDate: "2026-06-08",
    matchedReceiptAmount: 98_500,
    today: "2026-07-01",
  });
  assert.equal(analysis.deterministicStatus, "discount_taken_within_window");
});

test("blocks a late short payment when receipt evidence does not reconcile", () => {
  const analysis = analyseCashDiscountNarration({
    narration: "CD 1%",
    invoiceDate: "2026-06-01",
    originalAmount: 80_000,
    pendingAmount: 800,
    receiptDate: "2026-06-25",
    matchedReceiptAmount: 70_000,
    today: "2026-07-01",
  });
  assert.equal(analysis.deterministicStatus, "receipt_amount_unverified");
});

test("grosses up a fully unpaid net invoice after all default tiers expire", () => {
  const analysis = analyseCashDiscountNarration({
    narration: "Cash discount 1.5% and 1%",
    invoiceDate: "2026-06-01",
    originalAmount: 50_000,
    pendingAmount: 50_000,
    today: "2026-06-25",
  });
  assert.equal(analysis.deterministicStatus, "unpaid_discount_tier_expired");
  assert.equal(analysis.reversalPlan?.grossInvoiceAmount, 50_761.42);
  assert.equal(analysis.reversalPlan?.totalReversalRequired, 761.42);
});

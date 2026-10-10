export type CashDiscountTerm = {
  ratePercent: 1 | 1.5;
  eligibilityDays: number;
  periodSource: "explicit" | "default";
};

export type CurrentCashDiscountEligibility = {
  ratePercent: number;
  eligibilityDays: number;
  periodSource: "explicit" | "default";
  discountDeadline: string;
  discountAmount: number;
};

export type CashDiscountDeterministicStatus =
  | "no_cash_discount_context"
  | "cash_discount_rate_missing"
  | "unsupported_cash_discount_rate"
  | "missing_invoice_date"
  | "within_eligibility_window"
  | "unpaid_discount_tier_expired"
  | "invoice_unpaid"
  | "receipt_date_not_found"
  | "discount_taken_within_window"
  | "receipt_amount_unverified"
  | "balance_does_not_match_narrated_discount"
  | "existing_balance_due"
  | "late_short_payment";

export type CashDiscountReversalPlan = {
  /** The Tally invoice is treated as the amount after this best narrated discount. */
  initialDiscount: CurrentCashDiscountEligibility;
  grossInvoiceAmount: number;
  activeDiscount: CurrentCashDiscountEligibility | null;
  currentPayableAmount: number;
  totalReversalRequired: number;
};

export type CashDiscountNarrationAnalysis = {
  sourceNarration: string;
  matchedCashDiscountContext: string | null;
  terms: CashDiscountTerm[];
  termsLabel: string | null;
  finalEligibilityDays: number | null;
  discountDeadline: string | null;
  receiptDate: string | null;
  matchedReceiptAmount: number | null;
  expectedDiscounts: Array<{ ratePercent: number; amount: number }>;
  matchedDiscount: { ratePercent: number; amount: number } | null;
  reversalPlan: CashDiscountReversalPlan | null;
  deterministicStatus: CashDiscountDeterministicStatus;
  deterministicReason: string;
};

export const DEFAULT_CASH_DISCOUNT_DAYS = {
  1.5: 7,
  1: 15,
} as const;

const SUPPORTED_CASH_DISCOUNT_RATES = [1.5, 1] as const;
const EXPLICIT_CASH_DISCOUNT_CONTEXT = /(?:\bcash\s*disc(?:ount)?\b|\bc\.?\s*d\.?(?=\W|$))/i;
const GENERIC_DISCOUNT_CONTEXT = /\bdiscount\b/i;
const PAYMENT_CONTEXT = /\b(?:pay(?:ment|able|ing|s|ed)?|within|before|upto|up\s*to|days?|business|working)\b/i;
const PAIRED_RATES = /(\d{1,2}(?:\.\d{1,2})?)\s*%?\s*\/\s*(\d{1,2}(?:\.\d{1,2})?)\s*%/gi;
const PERCENTAGE_TOKEN = /(?:^|[^\d.])(\d{1,2}(?:\.\d{1,2})?)\s*%/gi;

type ParsedCashDiscountNarration = {
  matchedCashDiscountContext: string | null;
  hasCashDiscountContext: boolean;
  supportedRates: Array<1 | 1.5>;
  unsupportedRates: number[];
  terms: CashDiscountTerm[];
};

function asMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function moneyClose(left: number, right: number) {
  return Math.abs(left - right) <= 1;
}

function normalizeNarrationText(value: string) {
  return value
    .replace(/\b1\s*(?:1\s*\/\s*2|½)\s*%/gi, "1.5%")
    .replace(/\bone[\s-]+(?:and[\s-]+)?a?[\s-]*half\s+(?:per\s*cent|percent)\b/gi, "1.5%")
    .replace(/\bone[\s-]+point[\s-]+five\s+(?:per\s*cent|percent)\b/gi, "1.5%")
    .replace(/\bone\s+(?:per\s*cent|percent)\b/gi, "1%")
    .replace(/\b(\d{1,2}(?:\.\d{1,2})?)\s*(?:per\s*cent|percent|pct\.?)\b/gi, "$1%");
}

function addDays(dateText: string, days: number) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isAfterDate(left: string, right: string) {
  return Date.parse(`${left}T00:00:00.000Z`) > Date.parse(`${right}T00:00:00.000Z`);
}

function normalizeTerms(terms: CashDiscountTerm[]) {
  const byRate = new Map<number, CashDiscountTerm>();
  for (const term of terms) {
    const ratePercent = Number(term.ratePercent);
    const eligibilityDays = Math.trunc(Number(term.eligibilityDays));
    if (!Number.isFinite(ratePercent) || !Number.isFinite(eligibilityDays)) continue;
    if (!isSupportedCashDiscountRate(ratePercent) || eligibilityDays < 0 || eligibilityDays > 365) continue;
    const existing = byRate.get(ratePercent);
    if (!existing || (existing.periodSource === "default" && term.periodSource === "explicit")) {
      byRate.set(ratePercent, {
        ratePercent,
        eligibilityDays,
        periodSource: term.periodSource,
      });
    }
  }
  return Array.from(byRate.values()).sort(
    (left, right) => left.eligibilityDays - right.eligibilityDays || right.ratePercent - left.ratePercent
  );
}

function isSupportedCashDiscountRate(value: number): value is 1 | 1.5 {
  return SUPPORTED_CASH_DISCOUNT_RATES.some((rate) => Math.abs(rate - value) < 0.0001);
}

function uniqueNumbers(values: number[]) {
  return Array.from(new Set(values.map((value) => Number(value.toFixed(4)))));
}

function matchedContextLabel(narration: string) {
  const explicitMatch = narration.match(EXPLICIT_CASH_DISCOUNT_CONTEXT)?.[0] ?? null;
  if (explicitMatch) return explicitMatch;
  if (GENERIC_DISCOUNT_CONTEXT.test(narration) && PAYMENT_CONTEXT.test(narration)) return "discount payment terms";
  if (narration.includes("%") && PAYMENT_CONTEXT.test(narration)) return "payment terms";
  return null;
}

export function formatCashDiscountTerms(terms: CashDiscountTerm[]) {
  return terms
    .map((term) => `${Number(term.ratePercent).toLocaleString("en-IN", { maximumFractionDigits: 2 })}% within ${term.eligibilityDays} days`)
    .join("; ");
}

/**
 * Returns the best narrated discount that is still available today. This is
 * used for collection follow-ups only; it never authorizes a debit note.
 */
export function currentCashDiscountEligibility(input: {
  terms: CashDiscountTerm[];
  invoiceDate: string | null | undefined;
  originalAmount: number;
  today: string;
}): CurrentCashDiscountEligibility | null {
  const invoiceDate = String(input.invoiceDate ?? "").slice(0, 10);
  if (!invoiceDate || !Number.isFinite(input.originalAmount) || input.originalAmount <= 0) return null;

  const eligible = normalizeTerms(input.terms)
    .map((term) => ({
      term,
      discountDeadline: addDays(invoiceDate, term.eligibilityDays),
    }))
    .filter((entry): entry is { term: CashDiscountTerm; discountDeadline: string } => Boolean(entry.discountDeadline))
    .filter((entry) => !isAfterDate(input.today, entry.discountDeadline));
  if (eligible.length === 0) return null;

  const best = eligible.reduce((current, entry) =>
    entry.term.ratePercent > current.term.ratePercent ||
    (entry.term.ratePercent === current.term.ratePercent && entry.term.eligibilityDays < current.term.eligibilityDays)
      ? entry
      : current
  );
  return {
    ratePercent: best.term.ratePercent,
    eligibilityDays: best.term.eligibilityDays,
    periodSource: best.term.periodSource,
    discountDeadline: best.discountDeadline,
    discountAmount: asMoney((input.originalAmount * best.term.ratePercent) / 100),
  };
}

function initialCashDiscountEligibility(input: {
  terms: CashDiscountTerm[];
  invoiceDate: string | null | undefined;
  grossInvoiceAmount: number;
}): CurrentCashDiscountEligibility | null {
  const invoiceDate = String(input.invoiceDate ?? "").slice(0, 10);
  if (!invoiceDate || !Number.isFinite(input.grossInvoiceAmount) || input.grossInvoiceAmount <= 0) return null;
  const terms = normalizeTerms(input.terms);
  if (terms.length === 0) return null;
  const best = terms.reduce((current, term) =>
    term.ratePercent > current.ratePercent ||
    (term.ratePercent === current.ratePercent && term.eligibilityDays < current.eligibilityDays)
      ? term
      : current
  );
  const discountDeadline = addDays(invoiceDate, best.eligibilityDays);
  if (!discountDeadline) return null;
  return {
    ratePercent: best.ratePercent,
    eligibilityDays: best.eligibilityDays,
    periodSource: best.periodSource,
    discountDeadline,
    discountAmount: asMoney((input.grossInvoiceAmount * best.ratePercent) / 100),
  };
}

function createUnpaidReversalPlan(input: {
  terms: CashDiscountTerm[];
  invoiceDate: string | null | undefined;
  invoiceNetAmount: number;
  today: string;
}): CashDiscountReversalPlan | null {
  const terms = normalizeTerms(input.terms);
  const highestRate = terms.reduce((maximum, term) => Math.max(maximum, term.ratePercent), 0);
  if (!Number.isFinite(input.invoiceNetAmount) || input.invoiceNetAmount <= 0 || highestRate <= 0 || highestRate >= 100) {
    return null;
  }
  const grossInvoiceAmount = asMoney(input.invoiceNetAmount / (1 - highestRate / 100));
  const initialDiscount = initialCashDiscountEligibility({
    terms,
    invoiceDate: input.invoiceDate,
    grossInvoiceAmount,
  });
  if (!initialDiscount) return null;
  const activeDiscount = currentCashDiscountEligibility({
    terms,
    invoiceDate: input.invoiceDate,
    originalAmount: grossInvoiceAmount,
    today: input.today,
  });
  const currentPayableAmount = asMoney(grossInvoiceAmount - (activeDiscount?.discountAmount ?? 0));
  return {
    initialDiscount,
    grossInvoiceAmount,
    activeDiscount,
    currentPayableAmount,
    totalReversalRequired: asMoney(Math.max(currentPayableAmount - input.invoiceNetAmount, 0)),
  };
}

/**
 * Detect only the supported 1% and 1.5% rates from the narration. Written day
 * counts are intentionally ignored: this client's fixed windows are always
 * 7 calendar days for 1.5% and 15 calendar days for 1%.
 */
export function parseCashDiscountNarration(sourceNarration: string | null | undefined): ParsedCashDiscountNarration {
  const narration = normalizeNarrationText(String(sourceNarration ?? "")).replace(/\s+/g, " ").trim();
  const matchedCashDiscountContext = matchedContextLabel(narration);
  const hasCashDiscountContext = Boolean(matchedCashDiscountContext);
  if (!narration || !hasCashDiscountContext) {
    return {
      matchedCashDiscountContext,
      hasCashDiscountContext,
      supportedRates: [],
      unsupportedRates: [],
      terms: [],
    };
  }

  const pairedMatches = Array.from(narration.matchAll(PAIRED_RATES));
  const percentages = uniqueNumbers([
    ...Array.from(narration.matchAll(PERCENTAGE_TOKEN), (match) => Number(match[1])),
    ...pairedMatches.flatMap((match) => [Number(match[1]), Number(match[2])]),
  ]);
  const supportedRates = percentages.filter(isSupportedCashDiscountRate);
  const unsupportedRates = percentages.filter((rate) => !isSupportedCashDiscountRate(rate));
  const defaultedTerms = supportedRates
    .map((ratePercent) => ({
      ratePercent,
      eligibilityDays: DEFAULT_CASH_DISCOUNT_DAYS[ratePercent],
      periodSource: "default" as const,
    }));

  return {
    matchedCashDiscountContext,
    hasCashDiscountContext,
    supportedRates,
    unsupportedRates,
    terms: normalizeTerms(defaultedTerms),
  };
}

export function parseCashDiscountTerms(sourceNarration: string | null | undefined) {
  return parseCashDiscountNarration(sourceNarration).terms;
}

export function analyseCashDiscountNarration(input: {
  narration: string | null | undefined;
  invoiceDate: string | null | undefined;
  originalAmount: number;
  pendingAmount: number;
  receiptDate?: string | null | undefined;
  matchedReceiptAmount?: number | null | undefined;
  today: string;
}): CashDiscountNarrationAnalysis {
  const sourceNarration = String(input.narration ?? "").trim();
  const parsedNarration = parseCashDiscountNarration(sourceNarration);
  const terms = parsedNarration.terms;
  const termsLabel = terms.length > 0 ? formatCashDiscountTerms(terms) : null;
  const finalEligibilityDays = terms.length > 0 ? Math.max(...terms.map((term) => term.eligibilityDays)) : null;
  const invoiceDate = String(input.invoiceDate ?? "").slice(0, 10);
  const receiptDate = String(input.receiptDate ?? "").slice(0, 10) || null;
  const matchedReceiptAmount = Number.isFinite(Number(input.matchedReceiptAmount))
    ? asMoney(Number(input.matchedReceiptAmount))
    : null;
  const discountDeadlines = invoiceDate
    ? terms
        .map((term) => addDays(invoiceDate, term.eligibilityDays))
        .filter((value): value is string => Boolean(value))
    : [];
  const discountDeadline = discountDeadlines.length > 0
    ? discountDeadlines.sort((left, right) => left.localeCompare(right)).at(-1) ?? null
    : null;
  const expectedDiscounts = terms.map((term) => ({
    ratePercent: term.ratePercent,
    amount: asMoney((input.originalAmount * term.ratePercent) / 100),
  }));
  const matchedDiscount = expectedDiscounts.find((term) => moneyClose(input.pendingAmount, term.amount)) ?? null;
  const reversalPlan = createUnpaidReversalPlan({
    terms,
    invoiceDate,
    invoiceNetAmount: input.originalAmount,
    today: input.today,
  });
  const amountReceived = asMoney(Math.max(input.originalAmount - input.pendingAmount, 0));
  const discountAtReceipt = receiptDate
    ? currentCashDiscountEligibility({
        terms,
        invoiceDate,
        originalAmount: input.originalAmount,
        today: receiptDate,
      })
    : null;
  const receiptSettlesValidNarratedDiscount = Boolean(
    receiptDate &&
      discountAtReceipt &&
      matchedReceiptAmount !== null &&
      moneyClose(matchedReceiptAmount, amountReceived) &&
      moneyClose(input.pendingAmount, discountAtReceipt.discountAmount)
  );
  const base = {
    sourceNarration,
    matchedCashDiscountContext: parsedNarration.matchedCashDiscountContext,
    terms,
    termsLabel,
    finalEligibilityDays,
    discountDeadline,
    receiptDate,
    matchedReceiptAmount,
    expectedDiscounts,
    matchedDiscount,
    reversalPlan,
  };

  if (!parsedNarration.hasCashDiscountContext) {
    return {
      ...base,
      deterministicStatus: "no_cash_discount_context",
      deterministicReason: "No cash-discount or discount-payment context was found in the invoice narration.",
    };
  }
  if (parsedNarration.supportedRates.length === 0 && parsedNarration.unsupportedRates.length > 0) {
    return {
      ...base,
      deterministicStatus: "unsupported_cash_discount_rate",
      deterministicReason: `The narration contains unsupported cash-discount rate${parsedNarration.unsupportedRates.length === 1 ? "" : "s"}: ${parsedNarration.unsupportedRates.map((rate) => `${rate}%`).join(", ")}. Only 1% and 1.5% are evaluated automatically.`,
    };
  }
  if (terms.length === 0) {
    return {
      ...base,
      deterministicStatus: "cash_discount_rate_missing",
      deterministicReason: "Cash discount is mentioned, but neither 1% nor 1.5% was found in the narration.",
    };
  }
  if (!discountDeadline) {
    return {
      ...base,
      deterministicStatus: "missing_invoice_date",
      deterministicReason: "The invoice date is required to determine whether the narrated cash-discount window has expired.",
    };
  }
  if (moneyClose(input.pendingAmount, input.originalAmount) && reversalPlan && reversalPlan.totalReversalRequired > 0.01) {
    const activeDiscount = reversalPlan.activeDiscount;
    return {
      ...base,
      deterministicStatus: "unpaid_discount_tier_expired",
      deterministicReason: activeDiscount
        ? `The ${reversalPlan.initialDiscount.ratePercent}% tier ended on ${reversalPlan.initialDiscount.discountDeadline}. The invoice is fully unpaid; ${activeDiscount.ratePercent}% remains available until ${activeDiscount.discountDeadline}, so the payable amount must be raised to ₹${reversalPlan.currentPayableAmount.toLocaleString("en-IN")}.`
        : `All narrated discount tiers have expired and the invoice is fully unpaid. The payable amount must be raised to ₹${reversalPlan.currentPayableAmount.toLocaleString("en-IN")}.`,
    };
  }
  if (receiptSettlesValidNarratedDiscount && receiptDate && discountAtReceipt) {
    return {
      ...base,
      deterministicStatus: "discount_taken_within_window",
      deterministicReason: `The matched receipt is dated ${receiptDate}, within the ${discountAtReceipt.ratePercent}% narrated discount window ending ${discountAtReceipt.discountDeadline}.`,
    };
  }
  if (!isAfterDate(input.today, discountDeadline)) {
    return {
      ...base,
      deterministicStatus: "within_eligibility_window",
      deterministicReason: `The final narrated discount window ends on ${discountDeadline}.`,
    };
  }
  if (moneyClose(input.pendingAmount, input.originalAmount)) {
    return {
      ...base,
      deterministicStatus: "invoice_unpaid",
      deterministicReason: "The invoice is still fully unpaid, so it is a collection follow-up rather than a debit note.",
    };
  }
  if (!receiptDate) {
    return {
      ...base,
      deterministicStatus: "receipt_date_not_found",
      deterministicReason: "No receipt dated against this invoice could be evidenced from Tally, so a debit note is blocked for review.",
    };
  }
  if (matchedReceiptAmount === null || !moneyClose(matchedReceiptAmount, amountReceived)) {
    return {
      ...base,
      deterministicStatus: "receipt_amount_unverified",
      deterministicReason: "The matched receipt total does not prove the amount settled against this invoice, so a debit note is blocked for review.",
    };
  }
  if (!matchedDiscount) {
    return {
      ...base,
      deterministicStatus: "balance_does_not_match_narrated_discount",
      deterministicReason: "The outstanding balance does not equal any discount amount explicitly stated in the narration.",
    };
  }

  return {
    ...base,
    deterministicStatus: "existing_balance_due",
    deterministicReason: `The final narrated discount window expired on ${discountDeadline}. The ${matchedDiscount.ratePercent}% amount is already outstanding on the original invoice, so it should be collected without creating another debit note.`,
  };
}

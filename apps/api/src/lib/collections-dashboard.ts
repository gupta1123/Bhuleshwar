import { businessDateText } from "@/lib/business-date";
import {
  currentCashDiscountEligibility,
  type CashDiscountNarrationAnalysis,
} from "@/lib/cash-discount-narration";
import {
  toNumber,
  toText,
  type DebitNoteProposalRow,
} from "@/lib/collections";
import {
  derivePaymentFollowUpTiming,
  type PaymentFollowUpStatus,
} from "@/lib/payment-follow-up";

export type TallyLedgerRow = {
  tally_name: string;
  parent_name: string | null;
  gstin: string | null;
  raw_payload: Record<string, unknown> | null;
};

export type OpenBillRow = {
  kind?: string | null;
  ledgerName?: string | null;
  referenceName?: string | null;
  voucherNumber?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  originalAmount?: number | string | null;
  pendingAmount?: number | string | null;
  sourceVoucherType?: string | null;
  narration?: string | null;
  receiptDate?: string | null;
  matchedReceiptAmount?: number | string | null;
  sourceSalesLedgerName?: string | null;
  status?: string | null;
};

export type OpenBillBucket = {
  ledgerName?: string | null;
  openBills?: OpenBillRow[];
};

export function normalizeLedgerName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function readRawText(raw: Record<string, unknown> | null | undefined, key: string, maxLength = 500) {
  return toText(raw?.[key], maxLength) || null;
}

export function proposalWithLedgerSnapshot(proposal: DebitNoteProposalRow, ledger?: TallyLedgerRow) {
  if (!ledger) return proposal;
  const raw = ledger.raw_payload && typeof ledger.raw_payload === "object" ? ledger.raw_payload : {};
  const partyEmail = proposal.party_email ?? readRawText(raw, "email", 320);
  const partyPhone = proposal.party_phone ?? readRawText(raw, "phone", 80);
  const partyContactPerson = proposal.party_contact_person ?? readRawText(raw, "contactPerson", 240);
  const partyAddress = proposal.party_address ?? readRawText(raw, "address", 1000);
  const partyGstin = proposal.party_gstin ?? ledger.gstin;

  return {
    ...proposal,
    party_gstin: partyGstin,
    party_email: partyEmail,
    party_phone: partyPhone,
    party_contact_person: partyContactPerson,
    party_address: partyAddress,
    customer_snapshot: {
      ...(proposal.customer_snapshot ?? {}),
      ledgerName: ledger.tally_name,
      parentName: ledger.parent_name,
      gstin: partyGstin,
      email: partyEmail,
      phone: partyPhone,
      contactPerson: partyContactPerson,
      address: partyAddress,
    },
  };
}

function proposalIdentityKey(proposal: DebitNoteProposalRow) {
  return [
    normalizeLedgerName(proposal.company_name),
    normalizeLedgerName(proposal.party_ledger_name),
    normalizeLedgerName(proposal.linked_invoice_number),
    toNumber(proposal.recoverable_amount).toFixed(2),
  ].join("|");
}

function proposalRank(proposal: DebitNoteProposalRow) {
  const statusRank: Record<string, number> = {
    created_in_tally: 60,
    queued_in_tally: 50,
    approved: 40,
    pending_approval: 30,
    draft: 20,
    failed: 10,
  };

  const statusScore = statusRank[proposal.status] ?? 0;
  const updatedScore = Date.parse(String(proposal.updated_at ?? proposal.created_at ?? "")) || 0;
  return statusScore * 10_000_000_000_000 + updatedScore;
}

export function dedupeDebitNoteProposals(proposals: DebitNoteProposalRow[]) {
  const bestByKey = new Map<string, DebitNoteProposalRow>();

  for (const proposal of proposals) {
    const key = proposalIdentityKey(proposal);
    const existing = bestByKey.get(key);
    if (!existing || proposalRank(proposal) > proposalRank(existing)) {
      bestByKey.set(key, proposal);
    }
  }

  return Array.from(bestByKey.values()).sort((left, right) => proposalRank(right) - proposalRank(left));
}

export function todayText() {
  return businessDateText();
}

export function serializeTallyCandidate(params: {
  bill: OpenBillRow;
  ledgerName: string;
  ledger?: TallyLedgerRow;
  companyName: string | null;
  connectionId: string;
  financialYear: string | null;
  today: string;
  analysis: CashDiscountNarrationAnalysis;
  stagedReversalAmount?: number;
  alreadyCreatedReversalAmount?: number;
}) {
  const originalAmount = toNumber(params.bill.originalAmount);
  const pendingAmount = toNumber(params.bill.pendingAmount);
  const invoiceDate = String(params.bill.invoiceDate ?? "").slice(0, 10);
  const referenceName = toText(params.bill.referenceName ?? params.bill.voucherNumber, 240);
  const raw = params.ledger?.raw_payload && typeof params.ledger.raw_payload === "object" ? params.ledger.raw_payload : {};
  const partyEmail = readRawText(raw, "email", 320);
  const partyPhone = readRawText(raw, "phone", 80);
  const partyContactPerson = readRawText(raw, "contactPerson", 240);
  const partyAddress = readRawText(raw, "address", 1000);
  const amountReceived = originalAmount > 0 ? Math.max(originalAmount - pendingAmount, 0) : null;
  const isUnpaidTierReversal = params.analysis.deterministicStatus === "unpaid_discount_tier_expired";
  const stagedReversalAmount = Math.max(
    0,
    toNumber(
      params.stagedReversalAmount ??
        params.analysis.reversalPlan?.totalReversalRequired
    )
  );
  const sourceSalesLedgerName = toText(params.bill.sourceSalesLedgerName, 500) || null;
  // The source invoice is recorded net of the best narrated discount. A
  // debit note therefore raises only the calculated reversal, never the
  // original invoice's currently-unpaid balance.
  // A partial receipt is reconciled against the invoice amount recorded in
  // Tally, so the recoverable debit note is the actual remaining shortfall.
  // Gross-up is only used for a fully unpaid invoice that was recorded net of
  // its best narrated discount.
  const expectedDiscount = params.analysis.reversalPlan?.totalReversalRequired ?? stagedReversalAmount;
  const recoverableAmount = stagedReversalAmount;
  const canCreateDebitNote =
    params.analysis.deterministicStatus === "unpaid_discount_tier_expired" &&
    recoverableAmount > 0 &&
    Boolean(sourceSalesLedgerName);
  const termsLabel = params.analysis.termsLabel ?? "Narrated cash discount";
  const sourceNarration = params.analysis.sourceNarration;
  const reversalPlan = params.analysis.reversalPlan;
  const referenceSuffix = isUnpaidTierReversal
    ? `T${reversalPlan?.activeDiscount?.eligibilityDays ?? "FINAL"}`
    : "SHORT";
  const referenceNumber = `DN-CD-${referenceName || "INVOICE"}-${referenceSuffix}`.slice(0, 120);
  const stagedNarration = reversalPlan
    ? ` Tally invoice is treated as net after ${reversalPlan.initialDiscount.ratePercent}%: gross basis ₹${reversalPlan.grossInvoiceAmount.toLocaleString("en-IN")}; payable now ₹${reversalPlan.currentPayableAmount.toLocaleString("en-IN")}; cumulative reversal ₹${reversalPlan.totalReversalRequired.toLocaleString("en-IN")}; already created ₹${toNumber(params.alreadyCreatedReversalAmount).toLocaleString("en-IN")}.`
    : "";

  return {
    id: `tally:${Buffer.from(`${params.ledgerName}|${referenceName}|${recoverableAmount.toFixed(2)}|${referenceSuffix}`).toString("base64url")}`,
    connectionId: params.connectionId,
    companyName: params.companyName,
    financialYear: params.financialYear,
    sourceTransactionId: null,
    sourceKind: "tally_open_bill",
    issueType: isUnpaidTierReversal ? "unpaid_discount_tier_reversal" : "discount_shortfall",
    expectedDiscount,
    canCreateDebitNote,
    partyLedgerName: params.ledgerName,
    partyGstin: params.ledger?.gstin ?? null,
    partyEmail,
    partyPhone,
    partyContactPerson,
    partyAddress,
    sourceSalesLedgerName,
    linkedInvoiceNumber: referenceName || params.bill.voucherNumber || null,
    linkedInvoiceDate: invoiceDate || null,
    originalInvoiceAmount: originalAmount || null,
    cashDiscountRuleId: null,
    cashDiscountRuleName: termsLabel,
    discountDeadline: params.analysis.discountDeadline,
    receiptDate: params.analysis.receiptDate,
    amountReceived,
    recoverableAmount,
    pendingAmount,
    reasonCode: isUnpaidTierReversal ? "cash_discount_unpaid_tier_reversal" : "cash_discount_narration_expired",
    referenceNumber,
    adjustOriginalInvoice: false,
    narration: `Cash discount recovery against invoice ${referenceName || "-"}. Terms: ${termsLabel}.${stagedNarration} Source narration: ${sourceNarration}`,
    gstMode: "finance_review",
    debitNoteDate: params.today,
    status: "pending_approval",
    approvalBy: null,
    approvedAt: null,
    tallyCommandId: null,
    tallyVoucherGuid: null,
    tallyVoucherId: null,
    tallyVoucherNumber: null,
    tallyVoucherDate: null,
    tallyOpenReferenceName: referenceName || null,
    remainingRecoverableAmount: recoverableAmount,
    cashDiscountAnalysis: {
      sourceNarration,
      matchedCashDiscountContext: params.analysis.matchedCashDiscountContext,
      terms: params.analysis.terms,
      termsLabel,
      finalEligibilityDays: params.analysis.finalEligibilityDays,
      expectedDiscounts: params.analysis.expectedDiscounts,
      reversalPlan,
      receiptDate: params.analysis.receiptDate,
      matchedReceiptAmount: params.analysis.matchedReceiptAmount,
      deterministicStatus: params.analysis.deterministicStatus,
      deterministicReason: params.analysis.deterministicReason,
      calculationVersion: "cash_discount_v2",
    },
    createdInTallyAt: null,
    lastSyncedFromTallyAt: null,
    communicationStatus: "not_sent",
    communicationChannel: null,
    communicationRecipient: null,
    communicationSentAt: null,
    customerSnapshot: {
      ledgerName: params.ledger?.tally_name ?? params.ledgerName,
      parentName: params.ledger?.parent_name ?? null,
      gstin: params.ledger?.gstin ?? null,
      email: partyEmail,
      phone: partyPhone,
      contactPerson: partyContactPerson,
      address: partyAddress,
      sourceSalesLedgerName,
    },
    tallyPdfReference: null,
    lastError: null,
    createdAt: params.today,
    updatedAt: params.today,
  };
}

type PaymentFollowUpKind =
  | "discount_window_open"
  | "full_payment_due"
  | "payment_due"
  | "payment_review";

export function isPaymentFollowUpStatus(status: CashDiscountNarrationAnalysis["deterministicStatus"]) {
  return [
    "no_cash_discount_context",
    "cash_discount_rate_missing",
    "unsupported_cash_discount_rate",
    "missing_invoice_date",
    "within_eligibility_window",
    "unpaid_discount_tier_expired",
    "invoice_unpaid",
    "receipt_date_not_found",
    "receipt_amount_unverified",
    "balance_does_not_match_narrated_discount",
    "existing_balance_due",
    "late_short_payment",
  ].includes(status);
}

export function serializePaymentFollowUp(params: {
  bill: OpenBillRow;
  ledgerName: string;
  ledger?: TallyLedgerRow;
  analysis: CashDiscountNarrationAnalysis;
  today: string;
  createdTierReversalAmount?: number;
}) {
  const originalInvoiceAmount = toNumber(params.bill.originalAmount);
  const outstandingAmount = toNumber(params.bill.pendingAmount);
  const amountReceived = Math.max(originalInvoiceAmount - outstandingAmount, 0);
  const invoiceDate = String(params.bill.invoiceDate ?? "").slice(0, 10) || null;
  const invoiceNumber = toText(params.bill.referenceName ?? params.bill.voucherNumber, 240) || null;
  const timing = derivePaymentFollowUpTiming(params.bill, params.today);
  const raw = params.ledger?.raw_payload && typeof params.ledger.raw_payload === "object" ? params.ledger.raw_payload : {};
  const currentDiscount = params.analysis.reversalPlan?.activeDiscount ?? currentCashDiscountEligibility({
    terms: params.analysis.terms,
    invoiceDate,
    originalAmount: originalInvoiceAmount,
    today: params.today,
  });
  const invoiceIsUnpaid = Math.abs(outstandingAmount - originalInvoiceAmount) <= 1;
  const createdTierReversalAmount = Math.max(0, toNumber(params.createdTierReversalAmount));
  const totalReversalRequired = params.analysis.deterministicStatus === "unpaid_discount_tier_expired"
    ? params.analysis.reversalPlan?.totalReversalRequired ?? 0
    : 0;
  const pendingTierReversalAmount = Math.max(0, Math.round((totalReversalRequired - createdTierReversalAmount) * 100) / 100);

  let followUpStatus: PaymentFollowUpStatus = "needs_follow_up";
  if (timing.ageBasis === "missing_dates") followUpStatus = "needs_review";
  else if (pendingTierReversalAmount > 0.01) followUpStatus = "debit_note_required";
  else if (timing.ageBasis === "due_date" && (timing.ageDays ?? 0) > 30) followUpStatus = "escalate";

  let kind: PaymentFollowUpKind = "payment_review";
  let title = "Payment pending";
  let nextAction = `Follow up for ₹${outstandingAmount.toLocaleString("en-IN")}. ${timing.ageLabel}.`;

  if (timing.ageBasis === "missing_dates") {
    kind = "payment_review";
    title = "Payment dates need review";
    nextAction = "Confirm the invoice or due date before scheduling collection follow-up.";
  } else if (pendingTierReversalAmount > 0.01) {
    kind = "full_payment_due";
    title = "Debit Note required first";
    nextAction = `Create the pending Debit Note of ₹${pendingTierReversalAmount.toLocaleString("en-IN")}, then follow up for payment.`;
  } else if (params.analysis.deterministicStatus === "within_eligibility_window" && currentDiscount) {
    kind = "discount_window_open";
    title = "Payment pending";
    nextAction = `Follow up for payment. ${timing.ageLabel}; ${currentDiscount.ratePercent}% cash discount remains available until ${currentDiscount.discountDeadline}.`;
  } else if (["existing_balance_due", "late_short_payment"].includes(params.analysis.deterministicStatus)) {
    kind = "payment_due";
    title = "Collect existing balance";
    nextAction = `Collect the existing Tally outstanding of â‚¹${outstandingAmount.toLocaleString("en-IN")}. Do not create another debit note for the same amount.`;
  } else if (params.analysis.deterministicStatus === "invoice_unpaid") {
    kind = "full_payment_due";
    title = "Payment pending";
    nextAction = `Follow up for the full outstanding amount. ${timing.ageLabel}.`;
  } else if (params.analysis.deterministicStatus === "no_cash_discount_context") {
    kind = "payment_due";
    title = "Payment pending";
    nextAction = `Follow up for ₹${outstandingAmount.toLocaleString("en-IN")}. ${timing.ageLabel}.`;
  } else if (
    params.analysis.deterministicStatus === "cash_discount_rate_missing" ||
    params.analysis.deterministicStatus === "unsupported_cash_discount_rate"
  ) {
    kind = "payment_review";
    title = "Payment pending";
    nextAction = `Follow up for payment and review the cash-discount terms. ${params.analysis.deterministicReason}`;
  } else if (params.analysis.deterministicStatus === "unpaid_discount_tier_expired" && params.analysis.reversalPlan) {
    kind = "full_payment_due";
    title = pendingTierReversalAmount > 0 ? "Debit note required, then collect" : "Payment pending after debit note";
    nextAction = pendingTierReversalAmount > 0
      ? `Create the incremental debit note of ₹${pendingTierReversalAmount.toLocaleString("en-IN")}, then collect ₹${params.analysis.reversalPlan.currentPayableAmount.toLocaleString("en-IN")}.`
      : `Collect ₹${params.analysis.reversalPlan.currentPayableAmount.toLocaleString("en-IN")}; the required tier reversal has already been created in Tally.`;
  } else if (params.analysis.deterministicStatus === "missing_invoice_date") {
    kind = "payment_review";
    title = "Payment pending";
    nextAction = "Follow up for payment and confirm the invoice date before evaluating the narrated discount terms.";
  }

  return {
    id: `follow-up:${Buffer.from(`${params.ledgerName}|${invoiceNumber ?? "-"}|${outstandingAmount.toFixed(2)}`).toString("base64url")}`,
    kind,
    followUpStatus,
    ageBasis: timing.ageBasis,
    ageDays: timing.ageDays,
    ageLabel: timing.ageLabel,
    dueDate: timing.dueDate,
    title,
    nextAction,
    partyLedgerName: params.ledgerName,
    partyGstin: params.ledger?.gstin ?? null,
    partyPhone: readRawText(raw, "phone", 80),
    partyEmail: readRawText(raw, "email", 320),
    linkedInvoiceNumber: invoiceNumber,
    linkedInvoiceDate: invoiceDate,
    originalInvoiceAmount,
    outstandingAmount,
    amountReceived,
    narration: params.analysis.sourceNarration,
    matchedCashDiscountContext: params.analysis.matchedCashDiscountContext,
    terms: params.analysis.terms,
    termsLabel: params.analysis.termsLabel,
    discountDeadline: params.analysis.discountDeadline,
    currentDiscount,
    paymentAmountIfPaidToday:
      params.analysis.reversalPlan?.currentPayableAmount ?? (invoiceIsUnpaid && currentDiscount ? Math.max(originalInvoiceAmount - currentDiscount.discountAmount, 0) : null),
    totalPayableAmount: params.analysis.reversalPlan?.currentPayableAmount ?? outstandingAmount,
    createdTierReversalAmount,
    pendingTierReversalAmount,
    reversalPlan: params.analysis.reversalPlan,
    deterministicStatus: params.analysis.deterministicStatus,
    deterministicReason: params.analysis.deterministicReason,
    calculationVersion: "cash_discount_v2",
  };
}

export function readTallyOpenBills(commandResult: Record<string, unknown> | null | undefined) {
  const result = commandResult?.result && typeof commandResult.result === "object"
    ? (commandResult.result as Record<string, unknown>)
    : commandResult;
  const byLedger = result?.byLedger && typeof result.byLedger === "object"
    ? (result.byLedger as Record<string, OpenBillBucket>)
    : {};

  return Object.entries(byLedger).flatMap(([ledgerName, bucket]) => {
    const openBills = Array.isArray(bucket?.openBills) ? bucket.openBills : [];
    return openBills.map((bill) => ({
      ledgerName: toText(bill.ledgerName ?? bucket?.ledgerName ?? ledgerName, 500),
      bill,
    }));
  });
}

export function invoiceIdentityKey(partyLedgerName: string | null | undefined, linkedInvoiceNumber: string | null | undefined) {
  return [normalizeLedgerName(partyLedgerName), normalizeLedgerName(linkedInvoiceNumber)].join("|");
}

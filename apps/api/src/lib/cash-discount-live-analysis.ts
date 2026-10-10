import {
  invoiceIdentityKey,
  normalizeLedgerName,
  serializePaymentFollowUp,
  serializeTallyCandidate,
  todayText,
  type OpenBillRow,
  type TallyLedgerRow,
} from "@/lib/collections-dashboard";
import {
  derivePaymentFollowUpTiming,
  isCollectionOnlyPaymentFollowUp,
  sortPaymentFollowUpsByPriority,
} from "@/lib/payment-follow-up";
import {
  analyseCashDiscountNarration,
  type CashDiscountNarrationAnalysis,
} from "@/lib/cash-discount-narration";
import { serializeDebitNoteProposal, toNumber, toText, type DebitNoteProposalRow } from "@/lib/collections";

export type LiveCashDiscountLedger = {
  name?: string | null;
  parent?: string | null;
  gstin?: string | null;
  raw?: Record<string, unknown> | null;
};

export function liveCashDiscountLedgerRow(value: LiveCashDiscountLedger): TallyLedgerRow | null {
  const name = toText(value.name, 500);
  if (!name) return null;
  return {
    tally_name: name,
    parent_name: toText(value.parent, 500) || null,
    gstin: toText(value.gstin, 32) || null,
    raw_payload: value.raw && typeof value.raw === "object" ? value.raw : {},
  };
}

export function analyseLiveCashDiscountSnapshot(params: {
  connectionId: string;
  companyName: string;
  financialYear: string | null;
  openBillsResult: Record<string, unknown>;
  ledgers: TallyLedgerRow[];
  createdProposals?: DebitNoteProposalRow[];
  connectionStatus?: string | null;
  lastHeartbeatAt?: string | null;
  preview?: boolean;
}) {
  const ledgerByName = new Map(params.ledgers.map((ledger) => [normalizeLedgerName(ledger.tally_name), ledger]));
  const createdProposals = params.createdProposals ?? [];
  const createdReversalByInvoice = new Map<string, number>();
  for (const proposal of createdProposals) {
    if (!String(proposal.reason_code || "").startsWith("cash_discount_")) continue;
    const key = invoiceIdentityKey(proposal.party_ledger_name, proposal.linked_invoice_number);
    createdReversalByInvoice.set(key, (createdReversalByInvoice.get(key) ?? 0) + toNumber(proposal.recoverable_amount));
  }

  const today = todayText();
  const seenBillKeys = new Set<string>();
  const narrationReviewRows: Array<{
    ledgerName: string;
    bill: OpenBillRow;
    analysis: CashDiscountNarrationAnalysis;
  }> = [];
  const result = params.openBillsResult?.result && typeof params.openBillsResult.result === "object"
    ? params.openBillsResult.result as Record<string, unknown>
    : params.openBillsResult;
  const byLedger = result?.byLedger && typeof result.byLedger === "object"
    ? result.byLedger as Record<string, { ledgerName?: string | null; openBills?: OpenBillRow[]; complete?: boolean }>
    : {};

  for (const [bucketLedgerName, bucket] of Object.entries(byLedger)) {
    if (bucket.complete === false) continue;
    for (const bill of Array.isArray(bucket?.openBills) ? bucket.openBills : []) {
      const ledgerName = toText(bill.ledgerName ?? bucket?.ledgerName ?? bucketLedgerName, 500);
      const billKey = `${normalizeLedgerName(ledgerName)}|${normalizeLedgerName(bill.referenceName)}|${normalizeLedgerName(bill.voucherNumber)}`;
      if (seenBillKeys.has(billKey)) continue;
      seenBillKeys.add(billKey);
      const originalAmount = toNumber(bill.originalAmount);
      const pendingAmount = toNumber(bill.pendingAmount);
      const invoiceDate = String(bill.invoiceDate ?? "").slice(0, 10);
      if (!ledgerName || bill.kind === "advance" || originalAmount <= 0 || pendingAmount <= 0) continue;
      narrationReviewRows.push({
        ledgerName,
        bill,
        analysis: analyseCashDiscountNarration({
          narration: bill.narration,
          invoiceDate,
          originalAmount,
          pendingAmount,
          receiptDate: bill.receiptDate,
          matchedReceiptAmount: toNumber(bill.matchedReceiptAmount, Number.NaN),
          today,
        }),
      });
    }
  }

  const narratedDiscountRows = narrationReviewRows.filter((row) => row.analysis.terms.length > 0);
  const narrationAnalysis = narrationReviewRows.map((row) => ({
    partyLedgerName: row.ledgerName,
    linkedInvoiceNumber: toText(row.bill.referenceName ?? row.bill.voucherNumber, 240) || null,
    linkedInvoiceDate: String(row.bill.invoiceDate ?? "").slice(0, 10) || null,
    originalInvoiceAmount: toNumber(row.bill.originalAmount),
    pendingAmount: toNumber(row.bill.pendingAmount),
    analysis: {
      sourceNarration: row.analysis.sourceNarration,
      matchedCashDiscountContext: row.analysis.matchedCashDiscountContext,
      terms: row.analysis.terms,
      termsLabel: row.analysis.termsLabel,
      finalEligibilityDays: row.analysis.finalEligibilityDays,
      discountDeadline: row.analysis.discountDeadline,
      receiptDate: row.analysis.receiptDate,
      matchedReceiptAmount: row.analysis.matchedReceiptAmount,
      expectedDiscounts: row.analysis.expectedDiscounts,
      reversalPlan: row.analysis.reversalPlan,
      deterministicStatus: row.analysis.deterministicStatus,
      deterministicReason: row.analysis.deterministicReason,
      calculationVersion: "cash_discount_v2",
    },
  }));

  const paymentFollowUps = sortPaymentFollowUpsByPriority(narrationReviewRows
    .filter((row) => row.analysis.deterministicStatus !== "discount_taken_within_window")
    .filter((row) => derivePaymentFollowUpTiming(row.bill, today).eligible)
    .map((row) => serializePaymentFollowUp({
      bill: row.bill,
      ledgerName: row.ledgerName,
      ledger: ledgerByName.get(normalizeLedgerName(row.ledgerName)),
      analysis: row.analysis,
      today,
      createdTierReversalAmount: createdReversalByInvoice.get(
        invoiceIdentityKey(row.ledgerName, toText(row.bill.referenceName ?? row.bill.voucherNumber, 240) || null)
      ),
    }))
    .filter(isCollectionOnlyPaymentFollowUp));

  const tallyCandidates = narratedDiscountRows
    .filter((row) => row.analysis.deterministicStatus === "unpaid_discount_tier_expired")
    .map((row) => {
      const invoiceNumber = toText(row.bill.referenceName ?? row.bill.voucherNumber, 240) || null;
      const alreadyCreatedReversalAmount = createdReversalByInvoice.get(invoiceIdentityKey(row.ledgerName, invoiceNumber)) ?? 0;
      const requiredReversalAmount = toNumber(row.analysis.reversalPlan?.totalReversalRequired);
      const stagedReversalAmount = Math.max(0, Math.round((requiredReversalAmount - alreadyCreatedReversalAmount) * 100) / 100);
      if (stagedReversalAmount <= 0.01) return null;
      return serializeTallyCandidate({
        bill: row.bill,
        ledgerName: row.ledgerName,
        ledger: ledgerByName.get(normalizeLedgerName(row.ledgerName)),
        companyName: params.companyName,
        connectionId: params.connectionId,
        financialYear: params.financialYear,
        today,
        analysis: row.analysis,
        stagedReversalAmount,
        alreadyCreatedReversalAmount,
      });
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((left, right) => {
      const leftDate = Date.parse(`${left.linkedInvoiceDate ?? ""}T00:00:00.000Z`) || 0;
      const rightDate = Date.parse(`${right.linkedInvoiceDate ?? ""}T00:00:00.000Z`) || 0;
      return leftDate !== rightDate ? leftDate - rightDate : String(left.partyLedgerName).localeCompare(String(right.partyLedgerName));
    });

  const serializedCreated = createdProposals.map(serializeDebitNoteProposal);
  const proposals = [...tallyCandidates, ...serializedCreated];
  const recoverableAmount = tallyCandidates.reduce((sum, row) => sum + row.recoverableAmount, 0);
  const createdAmount = createdProposals.reduce((sum, row) => sum + toNumber(row.recoverable_amount), 0);
  const paymentFollowUpAmount = paymentFollowUps.reduce((sum, row) => sum + row.outstandingAmount, 0);

  return {
    setupRequired: false,
    preview: params.preview === true,
    company: {
      connectionId: params.connectionId,
      companyName: params.companyName,
      status: params.connectionStatus || "company_loaded",
      lastHeartbeatAt: params.lastHeartbeatAt ?? null,
      tallyReachable: true,
      companyLoaded: true,
    },
    filters: { connectionId: params.connectionId, compatibleConnectionIds: [params.connectionId] },
    kpis: {
      totalOutstanding: recoverableAmount,
      overdueOutstanding: null,
      dueThisWeek: null,
      cdAtRisk: null,
      cdExpired: tallyCandidates.length,
      lateShortPayments: narrationReviewRows.filter((row) => ["existing_balance_due", "late_short_payment"].includes(row.analysis.deterministicStatus)).length,
      debitNotesPendingApproval: tallyCandidates.length,
      narratedDiscountInvoices: narratedDiscountRows.length,
      unpaidInvoices: paymentFollowUps.filter((row) => Math.abs(row.outstandingAmount - row.originalInvoiceAmount) <= 1).length,
      partialUnpaidInvoices: paymentFollowUps.filter((row) => row.outstandingAmount < row.originalInvoiceAmount - 1).length,
      paymentFollowUps: paymentFollowUps.length,
      paymentFollowUpAmount,
      needsAttention: tallyCandidates.length,
      createdDebitNotes: createdProposals.length,
      createdDebitNoteAmount: createdAmount,
    },
    tabs: {
      overduePayments: [],
      paymentFollowUps,
      cashDiscountTracker: proposals,
      debitNoteQueue: proposals,
    },
    narrationAnalysis,
    notes: params.preview
      ? ["Live Tally results are ready; confirmed debit-note history is being reconciled in the background."]
      : [
          "Cash-discount terms are calculated from a live Tally response held only in memory.",
          "Debit notes are never created automatically; an eligible result requires a user action and a fresh Tally recheck.",
          "Only confirmed debit notes are saved as the audit trail.",
        ],
  };
}

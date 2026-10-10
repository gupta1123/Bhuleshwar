import { withTeamAccess } from '@/lib/access/route-boundary';
import { followUpsDashboard } from '@/lib/access/followups-dashboard';
import {requireMasterDataset,datasetSelection} from '@/lib/access/master-store';
import {accessFailureResponse} from '@/lib/access/failures';
import { jsonWithCors, optionsWithCors } from "@/lib/api/cors";
import { requireRequestUser } from "@/lib/api/request-auth";
import {
  serializeDebitNoteProposal,
  toNumber,
  toText,
  type DebitNoteProposalRow,
} from "@/lib/collections";
import {
  analyseCashDiscountNarration,
  currentCashDiscountEligibility,
  type CashDiscountNarrationAnalysis,
} from "@/lib/cash-discount-narration";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { businessDateText } from "@/lib/business-date";

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

type TallyCommandRow = {
  id: string;
  connection_id: string;
  owner_user_id: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  completed_at: string | null;
  created_at: string;
};

export function nullableText(value: unknown, maxLength = 500) {
  const text = toText(value, maxLength);
  return text || null;
}

function isMissingCollectionsTable(error: unknown) {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  return /cash_discount_rules|debit_note_proposals|relation .* does not exist|schema cache/i.test(message);
}

export function normalizeLedgerName(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function commandCompanyName(command: TallyCommandRow) {
  return nullableText(command.payload?.companyName, 240);
}

function commandScanId(command: TallyCommandRow) {
  return nullableText(command.payload?.scanId, 120);
}

function belongsToCompany(command: TallyCommandRow, companyName: string | null) {
  return normalizeLedgerName(commandCompanyName(command)) === normalizeLedgerName(companyName);
}

function isGenericTallyLabel(value: string | null | undefined) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  return (
    !normalized ||
    normalized === "tally" ||
    normalized === "tally prime" ||
    /^tally(?: prime)?\s*[-–]\s*(?:current year|\d{4}[-–]\d{2})$/.test(normalized)
  );
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
  const raw = params.ledger?.raw_payload && typeof params.ledger.raw_payload === "object" ? params.ledger.raw_payload : {};
  const currentDiscount = params.analysis.reversalPlan?.activeDiscount ?? currentCashDiscountEligibility({
    terms: params.analysis.terms,
    invoiceDate,
    originalAmount: originalInvoiceAmount,
    today: params.today,
  });
  const invoiceIsUnpaid = Math.abs(outstandingAmount - originalInvoiceAmount) <= 1;
  const createdTierReversalAmount = Math.max(0, toNumber(params.createdTierReversalAmount));
  const totalReversalRequired = params.analysis.reversalPlan?.totalReversalRequired ?? 0;
  const pendingTierReversalAmount = Math.max(0, Math.round((totalReversalRequired - createdTierReversalAmount) * 100) / 100);

  let kind: PaymentFollowUpKind = "payment_review";
  let title = "Payment balance needs review";
  let nextAction = params.analysis.deterministicReason;

  if (params.analysis.deterministicStatus === "within_eligibility_window" && currentDiscount) {
    kind = "discount_window_open";
    title = invoiceIsUnpaid ? "Payment pending" : "Balance pending";
    nextAction = invoiceIsUnpaid
      ? `${currentDiscount.ratePercent}% cash discount (₹${currentDiscount.discountAmount.toLocaleString("en-IN")}) remains available until ${currentDiscount.discountDeadline}.`
      : `Review the remaining balance before payment: ${currentDiscount.ratePercent}% cash discount remains available until ${currentDiscount.discountDeadline}.`;
  } else if (params.analysis.deterministicStatus === "invoice_unpaid") {
    kind = "full_payment_due";
    title = "Full payment pending";
    nextAction = `Collect the full outstanding amount. All narrated cash-discount windows ended on ${params.analysis.discountDeadline}.`;
  } else if (params.analysis.deterministicStatus === "no_cash_discount_context") {
    kind = "payment_due";
    title = invoiceIsUnpaid ? "Payment pending" : "Balance pending";
    nextAction = "Collect the outstanding amount. The invoice narration contains no cash-discount terms.";
  } else if (
    params.analysis.deterministicStatus === "cash_discount_rate_missing" ||
    params.analysis.deterministicStatus === "unsupported_cash_discount_rate"
  ) {
    kind = "payment_review";
    title = "Cash discount terms need review";
    nextAction = params.analysis.deterministicReason;
  } else if (params.analysis.deterministicStatus === "unpaid_discount_tier_expired" && params.analysis.reversalPlan) {
    kind = "full_payment_due";
    title = pendingTierReversalAmount > 0 ? "Debit note required, then collect" : "Payment pending after debit note";
    nextAction = pendingTierReversalAmount > 0
      ? `Create the incremental debit note of ₹${pendingTierReversalAmount.toLocaleString("en-IN")}, then collect ₹${params.analysis.reversalPlan.currentPayableAmount.toLocaleString("en-IN")}.`
      : `Collect ₹${params.analysis.reversalPlan.currentPayableAmount.toLocaleString("en-IN")}; the required tier reversal has already been created in Tally.`;
  } else if (params.analysis.deterministicStatus === "missing_invoice_date") {
    kind = "payment_review";
    title = "Invoice date needed";
    nextAction = "Confirm the invoice date before evaluating the narrated payment terms.";
  }

  return {
    id: `follow-up:${Buffer.from(`${params.ledgerName}|${invoiceNumber ?? "-"}|${outstandingAmount.toFixed(2)}`).toString("base64url")}`,
    kind,
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

function debitNoteRowFromSucceededCommand(command: TallyCommandRow, connection: { last_company_name: string | null }) {
  const payload = command.payload ?? {};
  const result = command.result ?? {};
  const sourceProposal = payload.sourceProposal && typeof payload.sourceProposal === "object"
    ? (payload.sourceProposal as Record<string, unknown>)
    : {};
  const amount = toNumber(payload.amount);
  const voucherDate = nullableText(result.voucherDate, 20) ?? nullableText(payload.voucherDate, 20);
  const voucherNumber =
    nullableText(result.voucherNumber, 500) ??
    nullableText(payload.referenceNumber, 500) ??
    nullableText(result.voucherId, 500);

  if (!nullableText(payload.partyLedgerName, 500) || amount <= 0 || !voucherNumber) return null;

  return {
    owner_user_id: command.owner_user_id,
    connection_id: command.connection_id,
    company_name: nullableText(payload.companyName, 240) ?? connection.last_company_name,
    financial_year: nullableText(sourceProposal.financialYear, 20),
    source_transaction_id: null,
    party_ledger_name: nullableText(payload.partyLedgerName, 500) ?? "Unknown party",
    party_gstin: nullableText(payload.partyGstin, 32),
    party_email: nullableText(sourceProposal.partyEmail, 320),
    party_phone: nullableText(sourceProposal.partyPhone, 80),
    party_contact_person: nullableText(sourceProposal.partyContactPerson, 240),
    party_address: nullableText(sourceProposal.partyAddress, 1000),
    linked_invoice_number: nullableText(payload.linkedInvoiceNumber, 120) ?? nullableText(sourceProposal.linkedInvoiceNumber, 120),
    linked_invoice_date: nullableText(payload.linkedInvoiceDate, 20) ?? nullableText(sourceProposal.linkedInvoiceDate, 20),
    original_invoice_amount: toNumber(sourceProposal.originalInvoiceAmount) || null,
    cash_discount_rule_id: nullableText(sourceProposal.cashDiscountRuleId, 80),
    cash_discount_rule_name: nullableText(sourceProposal.cashDiscountRuleName, 160),
    discount_deadline: nullableText(sourceProposal.discountDeadline, 20),
    receipt_date: nullableText(sourceProposal.receiptDate, 20),
    amount_received: sourceProposal.amountReceived === null || sourceProposal.amountReceived === undefined
      ? null
      : toNumber(sourceProposal.amountReceived),
    recoverable_amount: amount,
    reason_code: nullableText(payload.reasonCode, 80) ?? "cash_discount_expired",
    narration: nullableText(payload.narration, 1000),
    gst_mode: nullableText(payload.gstMode, 80) ?? "finance_review",
    debit_note_date: voucherDate ?? businessDateText(),
    status: "created_in_tally",
    approval_by: command.owner_user_id,
    approved_at: command.created_at,
    tally_command_id: command.id,
    tally_voucher_guid: nullableText(result.voucherGuid, 500) ?? nullableText(result.guid, 500),
    tally_voucher_id: nullableText(result.voucherId, 500) ?? command.id,
    tally_voucher_number: voucherNumber,
    tally_voucher_date: voucherDate,
    tally_open_reference_name: nullableText(result.openReferenceName, 500) ?? nullableText(payload.referenceNumber, 500),
    remaining_recoverable_amount: amount,
    created_in_tally_at: command.completed_at ?? new Date().toISOString(),
    last_synced_from_tally_at: new Date().toISOString(),
    communication_status: "not_sent",
    customer_snapshot: sourceProposal.customerSnapshot && typeof sourceProposal.customerSnapshot === "object"
      ? sourceProposal.customerSnapshot
      : {},
    last_error: null,
  };
}

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

async function GETHandler(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const followUps = url.pathname === '/api/collections/follow-ups';
    const connectionId = url.searchParams.get("connectionId")?.trim();
    const requestedCompanyName = nullableText(url.searchParams.get("companyName"), 240);

    if (!connectionId) {
      return jsonWithCors(request, { error: "Tally company/connection is required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const team=process.env.TEAM_ACCESS_ENFORCEMENT==='true'?await requireMasterDataset(request,connectionId,datasetSelection(url),followUps?'followups.view':'discounts.view'):null;
    const { data: connection, error: connectionError } = team?{data:team.connection,error:null}:await supabase
      .from("tally_connections")
      .select("id, owner_user_id, display_name, last_company_name, status, last_heartbeat_at, last_tally_reachable, last_company_loaded")
      .eq("id", connectionId)
      .eq("owner_user_id", user.id)
      .is("revoked_at", null)
      .maybeSingle();

    if (connectionError) throw connectionError;
    if (!connection) {
      return jsonWithCors(request, { error: "Tally connection not found." }, { status: 404 });
    }

    const activeCompanyName = !isGenericTallyLabel(connection.last_company_name)
      ? connection.last_company_name
      : null;
    if (
      connection.last_tally_reachable !== true ||
      connection.last_company_loaded !== true ||
      !activeCompanyName
    ) {
      return jsonWithCors(
        request,
        { error: "Tally must be connected with an active company before Cash Discounts can be calculated." },
        { status: 409 }
      );
    }

    const companyName = requestedCompanyName ?? activeCompanyName;
    if (normalizeLedgerName(companyName) !== normalizeLedgerName(activeCompanyName)) {
      return jsonWithCors(
        request,
        {
          error: `Tally is currently open to ${activeCompanyName}. Switch Tally to ${companyName} before calculating Cash Discounts.`,
        },
        { status: 409 }
      );
    }
    // A connector ID is a pairing instance, not a company identity. The same
    // Tally company can be paired again many times, so collect every connector
    // that has ever synced the selected company rather than trusting the latest
    // heartbeat from the currently paired connector.
    const compatibleConnectionIds = new Set([connectionId]);
    const [
      { data: companyConnectionRows, error: companyConnectionError },
      { data: companySyncRows, error: companySyncError },
    ] = await Promise.all([
      team?Promise.resolve({data:[],error:null}):supabase
        .from("tally_connections")
        .select("id")
        .eq("owner_user_id", user.id)
        .eq("last_company_name", companyName)
        .limit(200),
      team?Promise.resolve({data:[],error:null}):supabase
        .from("tally_master_sync_runs")
        .select("connection_id")
        .eq("owner_user_id", user.id)
        .eq("company_name", companyName)
        .limit(500),
    ]);

    if (companyConnectionError) throw companyConnectionError;
    if (companySyncError) throw companySyncError;
    for (const row of companyConnectionRows ?? []) {
      if (row.id) compatibleConnectionIds.add(String(row.id));
    }
    for (const row of companySyncRows ?? []) {
      if (row.connection_id) compatibleConnectionIds.add(String(row.connection_id));
    }

    const connectionIds = Array.from(compatibleConnectionIds);
    const proposalQuery=supabase.from('debit_note_proposals').select('*');
    const masterQuery=supabase.from(team?'access_dataset_masters':'tally_masters').select('tally_name, parent_name, gstin, raw_payload');
    const commands=()=>{
      const query=supabase.from(team?'access_visible_commands':'tally_bridge_commands').select('id, connection_id, owner_user_id, payload, result, completed_at, created_at');
      return team?query.eq('organization_id',team.access.organizationId).eq('access_company_id',team.link.company_id)
       .eq('company_guid',team.link.company_guid).eq('financial_year',team.link.financial_year).eq('installation_id',team.link.installation_id)
       .eq('visibility_permission',followUps?'followups.view':'discounts.view'):query.eq('owner_user_id',user.id);
    };
    const [
      { data: proposalRows, error: proposalError },
      { data: ledgerRows, error: ledgerError },
      { data: openBillCommandRows, error: openBillCommandError },
      { data: debitNoteCommandRows, error: debitNoteCommandError },
    ] = await Promise.all([
      followUps ? Promise.resolve({data: [], error: null}) : (team?proposalQuery.eq('access_organization_id',team.access.organizationId).eq('access_company_id',team.link.company_id).eq('financial_year',team.link.financial_year):proposalQuery.eq('owner_user_id',user.id))
        .eq("company_name", companyName)
        .eq("status", "created_in_tally")
        .order("created_at", { ascending: false })
        .limit(100),
      (team?masterQuery.eq('dataset_id',team.dataset?.id||'00000000-0000-0000-0000-000000000000'):masterQuery.eq('owner_user_id',user.id).eq('connection_id',connectionId).eq('company_name',companyName))
        .eq("master_type", "ledger")
        .eq("is_active", true)
        .limit(5000),
      commands()
        .eq("connection_id", connectionId)
        .eq("command_type", "fetch_customer_open_bills")
        .eq("status", "succeeded")
        .order("completed_at", { ascending: false })
        .limit(100),
      followUps ? Promise.resolve({data: [], error: null}) : commands()
        .in("connection_id", connectionIds)
        .eq("command_type", "create_debit_note")
        .eq("status", "succeeded")
        .order("completed_at", { ascending: false })
        .limit(50),
    ]);

    if (proposalError) throw proposalError;
    if (ledgerError) throw ledgerError;
    if (openBillCommandError) throw openBillCommandError;
    if (debitNoteCommandError) throw debitNoteCommandError;

    const companyProposalRows = ((proposalRows ?? []) as unknown as DebitNoteProposalRow[]).filter(
      (proposal) => normalizeLedgerName(proposal.company_name) === normalizeLedgerName(companyName)
    );
    let allProposalRows = companyProposalRows;
    const proposalCommandIds = new Set(allProposalRows.map((row) => row.tally_command_id).filter(Boolean));
    const missingCreatedRows = ((debitNoteCommandRows ?? []) as unknown as TallyCommandRow[])
      .filter((command) => belongsToCompany(command, companyName))
      .filter((command) => !proposalCommandIds.has(command.id))
      .map((command) => debitNoteRowFromSucceededCommand(command, { last_company_name: connection.last_company_name }))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    if (!team && missingCreatedRows.length > 0) {
      const { data: insertedRows, error: insertMissingError } = await supabase
        .from("debit_note_proposals")
        .insert(missingCreatedRows)
        .select("*");
      if (insertMissingError) throw insertMissingError;
      allProposalRows = [...(insertedRows as unknown as DebitNoteProposalRow[]), ...allProposalRows];
    }

    const ledgerByName = new Map(
      ((ledgerRows ?? []) as unknown as TallyLedgerRow[]).map((ledger) => [normalizeLedgerName(ledger.tally_name), ledger])
    );
    const createdProposals = dedupeDebitNoteProposals(
      allProposalRows.map((proposal) =>
        proposalWithLedgerSnapshot(proposal, ledgerByName.get(normalizeLedgerName(proposal.party_ledger_name)))
      )
    );
    const today = todayText();
    const createdReversalByInvoice = new Map<string, number>();
    for (const proposal of createdProposals) {
      if (!String(proposal.reason_code || "").startsWith("cash_discount_")) continue;
      const key = invoiceIdentityKey(proposal.party_ledger_name, proposal.linked_invoice_number);
      createdReversalByInvoice.set(key, (createdReversalByInvoice.get(key) ?? 0) + toNumber(proposal.recoverable_amount));
    }
    const companyOpenBillCommands = ((openBillCommandRows ?? []) as unknown as TallyCommandRow[]).filter((command) =>
      belongsToCompany(command, companyName)
    );
    // A refresh can be split into chunks, all marked with the same scanId. Use
    // only the newest complete refresh; never merge its results with a prior
    // scan or a different Tally company.
    const newestOpenBillCommand = companyOpenBillCommands[0] ?? null;
    const newestScanId = newestOpenBillCommand ? commandScanId(newestOpenBillCommand) : null;
    const latestOpenBillCommands = newestOpenBillCommand
      ? newestScanId
        ? companyOpenBillCommands.filter((command) => commandScanId(command) === newestScanId)
        : [newestOpenBillCommand]
      : [];
    const tallyOpenBills = latestOpenBillCommands.flatMap((row) =>
      readTallyOpenBills(row.result)
    );
    const seenBillKeys = new Set<string>();
    const narrationReviewRows: Array<{
      ledgerName: string;
      bill: OpenBillRow;
      analysis: CashDiscountNarrationAnalysis;
    }> = [];

    for (const { ledgerName, bill } of tallyOpenBills) {
        const billKey = `${normalizeLedgerName(ledgerName)}|${normalizeLedgerName(bill.referenceName)}|${normalizeLedgerName(bill.voucherNumber)}`;
        if (seenBillKeys.has(billKey)) continue;
        seenBillKeys.add(billKey);
        const originalAmount = toNumber(bill.originalAmount);
        const pendingAmount = toNumber(bill.pendingAmount);
        const invoiceDate = String(bill.invoiceDate ?? "").slice(0, 10);
        if (!ledgerName || bill.kind === "advance" || originalAmount <= 0 || pendingAmount <= 0) continue;
        const analysis = analyseCashDiscountNarration({
          narration: bill.narration,
          invoiceDate,
          originalAmount,
          pendingAmount,
          receiptDate: bill.receiptDate,
          matchedReceiptAmount: toNumber(bill.matchedReceiptAmount, Number.NaN),
          today,
        });
        narrationReviewRows.push({
          ledgerName,
          bill,
          analysis,
        });
    }

    const narratedDiscountRows = narrationReviewRows.filter((row) => row.analysis.terms.length > 0);
    const structuredNarrationAnalysis = narrationReviewRows.map((row) => ({
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
    const paymentFollowUps = narrationReviewRows
      .filter((row) => isPaymentFollowUpStatus(row.analysis.deterministicStatus))
      .map((row) =>
        serializePaymentFollowUp({
          bill: row.bill,
          ledgerName: row.ledgerName,
          ledger: ledgerByName.get(normalizeLedgerName(row.ledgerName)),
          analysis: row.analysis,
          today,
          createdTierReversalAmount: createdReversalByInvoice.get(
            invoiceIdentityKey(row.ledgerName, toText(row.bill.referenceName ?? row.bill.voucherNumber, 240) || null)
          ),
        })
      )
      .sort((left, right) => {
        const leftDeadline = Date.parse(`${left.currentDiscount?.discountDeadline ?? left.discountDeadline ?? ""}T00:00:00.000Z`) || Number.MAX_SAFE_INTEGER;
        const rightDeadline = Date.parse(`${right.currentDiscount?.discountDeadline ?? right.discountDeadline ?? ""}T00:00:00.000Z`) || Number.MAX_SAFE_INTEGER;
        if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
        return String(left.partyLedgerName).localeCompare(String(right.partyLedgerName));
      });
    const tallyCandidates = narratedDiscountRows
      .filter((row) => row.analysis.deterministicStatus === "unpaid_discount_tier_expired")
      .map((row) => {
        const invoiceNumber = toText(row.bill.referenceName ?? row.bill.voucherNumber, 240) || null;
        const alreadyCreatedReversalAmount = createdReversalByInvoice.get(invoiceIdentityKey(row.ledgerName, invoiceNumber)) ?? 0;
        const requiredReversalAmount = toNumber(row.analysis.reversalPlan?.totalReversalRequired);
        const stagedReversalAmount = Math.max(
          0,
          Math.round((requiredReversalAmount - alreadyCreatedReversalAmount) * 100) / 100
        );
        if (stagedReversalAmount <= 0.01) {
          return null;
        }
        const candidate = serializeTallyCandidate({
          bill: row.bill,
          ledgerName: row.ledgerName,
          ledger: ledgerByName.get(normalizeLedgerName(row.ledgerName)),
          companyName,
          connectionId,
          financialYear: null,
          today,
          analysis: row.analysis,
          stagedReversalAmount,
          alreadyCreatedReversalAmount,
        });
        return candidate;
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

    const sortedTallyCandidates = [...tallyCandidates].sort((left, right) => {
      const leftDate = Date.parse(`${left.linkedInvoiceDate ?? ""}T00:00:00.000Z`) || 0;
      const rightDate = Date.parse(`${right.linkedInvoiceDate ?? ""}T00:00:00.000Z`) || 0;
      if (leftDate !== rightDate) return leftDate - rightDate;
      return String(left.partyLedgerName).localeCompare(String(right.partyLedgerName));
    });

    const proposals = [...sortedTallyCandidates, ...createdProposals.map(serializeDebitNoteProposal)];
    const debitNoteCandidates = sortedTallyCandidates;
    const recoverableAmount = debitNoteCandidates.reduce((sum, row) => sum + row.recoverableAmount, 0);
    const createdAmount = createdProposals.reduce((sum, row) => sum + toNumber(row.recoverable_amount), 0);
    const paymentFollowUpAmount = paymentFollowUps.reduce((sum, row) => sum + row.totalPayableAmount, 0);

    if (followUps) return jsonWithCors(request, followUpsDashboard({
      company: {connectionId, companyName, status: connection.status, lastHeartbeatAt: connection.last_heartbeat_at},
      kpis: {paymentFollowUps: paymentFollowUps.length, paymentFollowUpAmount,
        unpaidInvoices: paymentFollowUps.filter(row => Math.abs(row.outstandingAmount-row.originalInvoiceAmount)<=1).length,
        partialUnpaidInvoices: paymentFollowUps.filter(row => row.outstandingAmount<row.originalInvoiceAmount-1).length},
      tabs: {paymentFollowUps},
    }));

    return jsonWithCors(request, {
      setupRequired: false,
      company: {
        connectionId,
        companyName,
        status: connection.status,
        lastHeartbeatAt: connection.last_heartbeat_at,
        tallyReachable: connection.last_tally_reachable === true,
        companyLoaded: connection.last_company_loaded === true,
      },
      filters: {
        connectionId,
        compatibleConnectionIds: connectionIds,
      },
      kpis: {
        totalOutstanding: recoverableAmount,
        overdueOutstanding: null,
        dueThisWeek: null,
        cdAtRisk: null,
        cdExpired: debitNoteCandidates.length,
        lateShortPayments: debitNoteCandidates.length,
        debitNotesPendingApproval: debitNoteCandidates.length,
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
      narrationAnalysis: structuredNarrationAnalysis,
      notes: [
        "Cash-discount terms are read deterministically from each invoice's Tally narration; saved company-wide rules are not used.",
        "Only 1% and 1.5% are supported. Missing periods default to 15 days and 7 days respectively.",
        "Debit notes are never created automatically; an eligible deterministic result still requires a user action.",
        "Created debit notes are kept as the Supabase audit trail after Tally confirms the action.",
      ],
    });
  } catch (error) {
    const failure=accessFailureResponse(request,error);if(failure)return failure;
    if (isMissingCollectionsTable(error)) {
      return jsonWithCors(request, {
        setupRequired: true,
        error: "Run the collections cash discount migration before opening this dashboard.",
        kpis: {},
        tabs: {
          overduePayments: [],
          paymentFollowUps: [],
          cashDiscountTracker: [],
          debitNoteQueue: [],
        },
      });
    }

    console.error("Error in GET /api/collections/dashboard:", error);
    return jsonWithCors(request, { error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withTeamAccess(GETHandler);

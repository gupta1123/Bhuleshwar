export type CashDiscountRuleRow = {
  id: string;
  owner_user_id: string;
  connection_id: string | null;
  rule_name: string;
  scope_type: string;
  scope_key: string | null;
  scope_label: string | null;
  discount_type: string;
  discount_value: number | string;
  calculation_base: string;
  eligibility_days: number | string;
  grace_days: number | string;
  payment_condition: string;
  accounting_treatment: string;
  missed_cd_treatment: string;
  approval_required: boolean;
  label: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type DebitNoteProposalRow = {
  id: string;
  owner_user_id: string;
  connection_id: string | null;
  company_name: string | null;
  financial_year: string | null;
  source_transaction_id: string | null;
  party_ledger_name: string;
  party_gstin: string | null;
  party_email?: string | null;
  party_phone?: string | null;
  party_contact_person?: string | null;
  party_address?: string | null;
  linked_invoice_number: string | null;
  linked_invoice_date: string | null;
  original_invoice_amount: number | string | null;
  cash_discount_rule_id: string | null;
  cash_discount_rule_name: string | null;
  discount_deadline: string | null;
  receipt_date: string | null;
  amount_received: number | string | null;
  recoverable_amount: number | string;
  reason_code: string;
  narration: string | null;
  gst_mode: string;
  debit_note_date: string;
  status: string;
  approval_by: string | null;
  approved_at: string | null;
  tally_command_id: string | null;
  tally_voucher_guid: string | null;
  tally_voucher_id?: string | null;
  tally_voucher_number: string | null;
  tally_voucher_date: string | null;
  tally_open_reference_name?: string | null;
  remaining_recoverable_amount?: number | string | null;
  created_in_tally_at?: string | null;
  last_synced_from_tally_at?: string | null;
  communication_status?: string | null;
  communication_channel?: string | null;
  communication_recipient?: string | null;
  communication_sent_at?: string | null;
  customer_snapshot?: Record<string, unknown> | null;
  tally_pdf_reference: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type NativeTallyPdfEvidence = {
  source: "tally_voucher_render";
  status: "verified";
  voucherId: string;
  voucherNumber: string;
  reference: string | null;
  alterId: string | null;
  sha256: string;
  byteSize: number;
  exportedAt: string;
};

export function toText(value: unknown, maxLength = 500) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, maxLength);
}

export function toNullableText(value: unknown, maxLength = 500) {
  const text = toText(value, maxLength);
  return text || null;
}

export function toNumber(value: unknown, fallback = 0) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  if (!normalized) return fallback;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toDateText(value: unknown) {
  const text = toText(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function getNativeTallyPdfEvidence(snapshot: Record<string, unknown> | null | undefined) {
  const candidate = snapshot?.nativeTallyPdf;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  const source = toText(value.source, 40);
  const status = toText(value.status, 40);
  const voucherId = toText(value.voucherId, 500);
  const voucherNumber = toText(value.voucherNumber, 500);
  const sha256 = toText(value.sha256, 128);
  // The previous `tally_native` source was a blank, unbound VCH Print form.
  // It is deliberately not trusted: a send is allowed only for the rendered
  // document whose voucher fields were resolved and verified live from Tally.
  if (source !== "tally_voucher_render" || status !== "verified" || !voucherId || !voucherNumber || !sha256) return null;
  return {
    source: "tally_voucher_render" as const,
    status: "verified" as const,
    voucherId,
    voucherNumber,
    reference: toNullableText(value.reference, 500),
    alterId: toNullableText(value.alterId, 500),
    sha256,
    byteSize: toNumber(value.byteSize),
    exportedAt: toText(value.exportedAt, 80),
  } satisfies NativeTallyPdfEvidence;
}

export function serializeCashDiscountRule(row: CashDiscountRuleRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    ruleName: row.rule_name,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    scopeLabel: row.scope_label,
    discountType: row.discount_type,
    discountValue: toNumber(row.discount_value),
    calculationBase: row.calculation_base,
    eligibilityDays: Math.trunc(toNumber(row.eligibility_days)),
    graceDays: Math.trunc(toNumber(row.grace_days)),
    paymentCondition: row.payment_condition,
    accountingTreatment: row.accounting_treatment,
    missedCdTreatment: row.missed_cd_treatment,
    approvalRequired: row.approval_required,
    label: row.label,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeDebitNoteProposal(row: DebitNoteProposalRow) {
  const nativeTallyPdf = getNativeTallyPdfEvidence(row.customer_snapshot);
  return {
    id: row.id,
    connectionId: row.connection_id,
    companyName: row.company_name,
    financialYear: row.financial_year,
    sourceTransactionId: row.source_transaction_id,
    partyLedgerName: row.party_ledger_name,
    partyGstin: row.party_gstin,
    partyEmail: row.party_email ?? null,
    partyPhone: row.party_phone ?? null,
    partyContactPerson: row.party_contact_person ?? null,
    partyAddress: row.party_address ?? null,
    sourceSalesLedgerName: toNullableText(row.customer_snapshot?.sourceSalesLedgerName, 500),
    linkedInvoiceNumber: row.linked_invoice_number,
    linkedInvoiceDate: row.linked_invoice_date,
    originalInvoiceAmount: row.original_invoice_amount === null ? null : toNumber(row.original_invoice_amount),
    cashDiscountRuleId: row.cash_discount_rule_id,
    cashDiscountRuleName: row.cash_discount_rule_name,
    discountDeadline: row.discount_deadline,
    receiptDate: row.receipt_date,
    amountReceived: row.amount_received === null ? null : toNumber(row.amount_received),
    recoverableAmount: toNumber(row.recoverable_amount),
    reasonCode: row.reason_code,
    narration: row.narration,
    gstMode: row.gst_mode,
    debitNoteDate: row.debit_note_date,
    status: row.status,
    approvalBy: row.approval_by,
    approvedAt: row.approved_at,
    tallyCommandId: row.tally_command_id,
    tallyVoucherGuid: row.tally_voucher_guid,
    tallyVoucherId: row.tally_voucher_id ?? null,
    tallyVoucherNumber: row.tally_voucher_number,
    tallyVoucherDate: row.tally_voucher_date,
    tallyOpenReferenceName: row.tally_open_reference_name ?? null,
    remainingRecoverableAmount:
      row.remaining_recoverable_amount === null || row.remaining_recoverable_amount === undefined
        ? null
        : toNumber(row.remaining_recoverable_amount),
    createdInTallyAt: row.created_in_tally_at ?? null,
    lastSyncedFromTallyAt: row.last_synced_from_tally_at ?? null,
    communicationStatus: row.communication_status ?? "not_sent",
    communicationChannel: row.communication_channel ?? null,
    communicationRecipient: row.communication_recipient ?? null,
    communicationSentAt: row.communication_sent_at ?? null,
    customerSnapshot: row.customer_snapshot ?? {},
    tallyPdfReference: row.tally_pdf_reference,
    nativeTallyPdf,
    nativeTallyPdfVerified: Boolean(nativeTallyPdf && row.tally_pdf_reference),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

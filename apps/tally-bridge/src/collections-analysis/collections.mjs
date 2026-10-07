// GENERATED from apps/api/src/lib/collections.ts by scripts/build-connector-collections-analysis.mjs.
// Do not edit: change the source and run the script.
export function toText(value, maxLength = 500) {
    if (value === null || value === undefined)
        return "";
    return String(value).trim().slice(0, maxLength);
}
export function toNullableText(value, maxLength = 500) {
    const text = toText(value, maxLength);
    return text || null;
}
export function toNumber(value, fallback = 0) {
    const normalized = String(value ?? "").replace(/,/g, "").trim();
    if (!normalized)
        return fallback;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
}
export function toDateText(value) {
    const text = toText(value, 20);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
export function getNativeTallyPdfEvidence(snapshot) {
    const candidate = snapshot?.nativeTallyPdf;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
        return null;
    const value = candidate;
    const source = toText(value.source, 40);
    const status = toText(value.status, 40);
    const voucherId = toText(value.voucherId, 500);
    const voucherNumber = toText(value.voucherNumber, 500);
    const sha256 = toText(value.sha256, 128);
    // The previous `tally_native` source was a blank, unbound VCH Print form.
    // It is deliberately not trusted: a send is allowed only for the rendered
    // document whose voucher fields were resolved and verified live from Tally.
    if (source !== "tally_voucher_render" || status !== "verified" || !voucherId || !voucherNumber || !sha256)
        return null;
    return {
        source: "tally_voucher_render",
        status: "verified",
        voucherId,
        voucherNumber,
        reference: toNullableText(value.reference, 500),
        alterId: toNullableText(value.alterId, 500),
        sha256,
        byteSize: toNumber(value.byteSize),
        exportedAt: toText(value.exportedAt, 80),
    };
}
export function serializeCashDiscountRule(row) {
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
export function serializeDebitNoteProposal(row) {
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
        remainingRecoverableAmount: row.remaining_recoverable_amount === null || row.remaining_recoverable_amount === undefined
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

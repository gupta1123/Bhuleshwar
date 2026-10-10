/** Permission gates for the shared Tally live-session endpoint. */
export const LIVE_OPERATION_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  test_purchase_document_folder: ['settings.manage'],
  company_check: ['connections.manage', 'purchases.view', 'bank.view', 'discounts.view', 'followups.view'],
  ledger_masters: ['bank.prepare', 'purchases.prepare'],
  ledger_suggestions: ['bank.prepare', 'purchases.prepare', 'discounts.prepare', 'followups.prepare'],
  verify_bank_transaction: ['bank.prepare'],
  fetch_customer_open_bills: ['bank.prepare', 'discounts.prepare', 'followups.prepare'],
  cash_discount_scan: ['discounts.prepare'],
  cash_discount_revalidate: ['discounts.prepare'],
  cash_discount_execute_debit_note: ['discounts.post'],
  collections_query: ['discounts.view', 'followups.view'],
  collections_rows: ['discounts.view', 'followups.view'],
  scan: ['discounts.prepare'],
  followups_scan: ['followups.prepare'],
  create_debit_note: ['discounts.post'],
};

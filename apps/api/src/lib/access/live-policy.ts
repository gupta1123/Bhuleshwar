/** Permission gates for the shared Tally live-session endpoint. */
export const LIVE_OPERATION_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  test_purchase_document_folder: ['settings.manage'],
  company_check: ['connections.manage', 'purchases.view', 'bank.view', 'discounts.view', 'followups.view'],
  ledger_masters: ['bank.prepare', 'purchases.prepare'],
  ledger_suggestions: ['bank.prepare', 'purchases.prepare', 'discounts.prepare', 'followups.prepare'],
};

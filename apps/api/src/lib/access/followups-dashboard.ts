/** Explicit projection: follow-up access must not expose debit-note history. */
export function followUpsDashboard(input: {
  setupRequired?: boolean;
  company?: unknown;
  kpis?: Record<string, unknown>;
  tabs?: { paymentFollowUps?: unknown[] };
}) {
  return {
    setupRequired: input.setupRequired ?? false,
    company: input.company,
    kpis: Object.fromEntries(['unpaidInvoices', 'partialUnpaidInvoices', 'paymentFollowUps', 'paymentFollowUpAmount']
      .map(key => [key, input.kpis?.[key] ?? 0])),
    tabs: { overduePayments: [], paymentFollowUps: input.tabs?.paymentFollowUps ?? [], cashDiscountTracker: [], debitNoteQueue: [] },
    notes: [],
  };
}

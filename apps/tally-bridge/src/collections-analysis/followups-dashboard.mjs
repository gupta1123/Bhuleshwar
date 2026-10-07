// GENERATED from apps/api/src/lib/access/followups-dashboard.ts by scripts/build-connector-collections-analysis.mjs.
// Do not edit: change the source and run the script.
/** Explicit projection: follow-up access must not expose debit-note history. */
export function followUpsDashboard(input) {
    return {
        setupRequired: input.setupRequired ?? false,
        company: input.company,
        kpis: Object.fromEntries(['unpaidInvoices', 'partialUnpaidInvoices', 'paymentFollowUps', 'paymentFollowUpAmount']
            .map(key => [key, input.kpis?.[key] ?? 0])),
        tabs: { overduePayments: [], paymentFollowUps: input.tabs?.paymentFollowUps ?? [], cashDiscountTracker: [], debitNoteQueue: [] },
        notes: [],
    };
}

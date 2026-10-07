// GENERATED from apps/api/src/lib/cash-discount-live-dashboard.ts by scripts/build-connector-collections-analysis.mjs.
// Do not edit: change the source and run the script.
// Builds the Cash Discount / Payment Follow-ups dashboard from a connector
// scan. Used by /api/collections/live/analyse and, generated into plain
// JavaScript (scripts/build-connector-collections-analysis.mjs), by the
// connector itself, so both always calculate the same dashboard.
// Pure: no database or network access.
import { followUpsDashboard } from "./followups-dashboard.mjs";
import { dedupeDebitNoteProposals, normalizeLedgerName, proposalWithLedgerSnapshot } from "./collections-dashboard.mjs";
import { analyseLiveCashDiscountSnapshot, liveCashDiscountLedgerRow, } from "./cash-discount-live-analysis.mjs";
export function buildLiveCashDiscountDashboard(params) {
    const { scan, financialYear } = params;
    const openBillsResult = scan.openBillsResult && typeof scan.openBillsResult === "object"
        ? scan.openBillsResult
        : null;
    const ledgers = Array.isArray(scan.ledgers)
        ? scan.ledgers.map(liveCashDiscountLedgerRow).filter((row) => Boolean(row))
        : [];
    const ledgerByName = new Map(ledgers.map((ledger) => [normalizeLedgerName(ledger.tally_name), ledger]));
    const createdProposals = dedupeDebitNoteProposals((params.proposalRows ?? [])
        .filter(proposal => !financialYear || !proposal.financial_year || proposal.financial_year === financialYear)
        .map((proposal) => proposalWithLedgerSnapshot(proposal, ledgerByName.get(normalizeLedgerName(proposal.party_ledger_name)))));
    const dashboard = analyseLiveCashDiscountSnapshot({
        connectionId: params.connectionId,
        companyName: params.companyName,
        financialYear,
        openBillsResult: openBillsResult ?? {},
        ledgers,
        createdProposals,
        connectionStatus: params.connectionStatus,
        lastHeartbeatAt: params.lastHeartbeatAt,
    });
    // Follow-up access must not expose debit-note history.
    return params.followUps ? followUpsDashboard(dashboard) : { ...dashboard, scanSummary: scan.scanSummary ?? null };
}

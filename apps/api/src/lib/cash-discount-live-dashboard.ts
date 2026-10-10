// Builds the Cash Discount / Payment Follow-ups dashboard from a connector
// scan. Used by /api/collections/live/analyse and, generated into plain
// JavaScript (scripts/build-connector-collections-analysis.mjs), by the
// connector itself, so both always calculate the same dashboard.
// Pure: no database or network access.
import { followUpsDashboard } from "@/lib/access/followups-dashboard";
import { dedupeDebitNoteProposals, normalizeLedgerName, proposalWithLedgerSnapshot } from "@/lib/collections-dashboard";
import {
  analyseLiveCashDiscountSnapshot,
  liveCashDiscountLedgerRow,
  type LiveCashDiscountLedger,
} from "@/lib/cash-discount-live-analysis";
import type { DebitNoteProposalRow } from "@/lib/collections";

export function buildLiveCashDiscountDashboard(params: {
  connectionId: string;
  companyName: string;
  financialYear: string | null;
  scan: Record<string, unknown>;
  proposalRows: unknown[];
  connectionStatus: string | null;
  lastHeartbeatAt: string | null;
  followUps: boolean;
}) {
  const { scan, financialYear } = params;
  const openBillsResult = scan.openBillsResult && typeof scan.openBillsResult === "object"
    ? scan.openBillsResult as Record<string, unknown>
    : null;
  const ledgers = Array.isArray(scan.ledgers)
    ? (scan.ledgers as LiveCashDiscountLedger[]).map(liveCashDiscountLedgerRow).filter((row): row is NonNullable<typeof row> => Boolean(row))
    : [];
  const ledgerByName = new Map(ledgers.map((ledger) => [normalizeLedgerName(ledger.tally_name), ledger]));
  const createdProposals = dedupeDebitNoteProposals(
    ((params.proposalRows ?? []) as unknown as DebitNoteProposalRow[])
      .filter(proposal => !financialYear || !proposal.financial_year || proposal.financial_year === financialYear)
      .map((proposal) => proposalWithLedgerSnapshot(proposal, ledgerByName.get(normalizeLedgerName(proposal.party_ledger_name))))
  );
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

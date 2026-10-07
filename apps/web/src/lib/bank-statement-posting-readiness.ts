type PostingReadiness = {
  ledgerName: string;
  ledgerNeedsReview: boolean;
  presence?: { status: string; duplicateInTally?: boolean };
  billRequired: boolean;
  amount: number;
  directPosting?: boolean;
  allocation?: {
    status: string;
    requiresUserReview: boolean;
    isEligibleForPosting: boolean;
    unallocatedAmount: number;
    allocations: Array<{ referenceName: string; allocatedAmount: number }>;
  };
};

// Shared by the displayed counts and the rows sent to confirmation/queueing.
// Direct posting relies on the connector's live duplicate preflight and sends no
// bill allocations. It must not bypass a failed/ambiguous check or become Advance.
export function isReadyForTallyPosting(row: PostingReadiness): boolean {
  if (!row.ledgerName.trim() || row.ledgerNeedsReview) return false;
  if (row.presence?.duplicateInTally) return false;
  if (row.directPosting) {
    if (row.presence && !["missing", "not_checked"].includes(row.presence.status)) return false;
    if (row.allocation) return false;
  } else if (row.presence?.status !== "missing") return false;
  if (!Number.isFinite(row.amount) || row.amount <= 0) return false;
  if (row.directPosting) return true;
  if (!row.billRequired) return true;
  const draft = row.allocation;
  if (!draft || draft.status !== "ready_to_post" || draft.requiresUserReview || !draft.isEligibleForPosting) return false;
  if (!Number.isFinite(draft.unallocatedAmount) || Math.abs(draft.unallocatedAmount) >= 0.005) return false;
  if (!draft.allocations.length || draft.allocations.some((line) =>
    !line.referenceName.trim() || !Number.isFinite(line.allocatedAmount) || line.allocatedAmount <= 0
  )) return false;
  const total = draft.allocations.reduce((sum, line) => sum + line.allocatedAmount, 0);
  return Math.abs(total - row.amount) < 0.005;
}

export type PostingBalanceProof = {
  available?: boolean;
  statementSequenceValid?: boolean;
  statementOpeningBalance?: number | null;
  statementClosingBalance?: number | null;
  tallyOpeningBalance?: number | null;
  tallyClosingBalance?: number | null;
  balancesMatch?: boolean | null;
};

export type PostingPresenceRow = {
  debitAmount?: number | null;
  creditAmount?: number | null;
  presenceStatus?: string | null;
};

export type PostingBalanceSafetyResult = {
  safe: boolean;
  reason: string;
  explainedDifference?: number;
};

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyMatches(left: number, right: number) {
  return Math.abs(left - right) <= 0.01;
}

export function validatePostingBalanceProof(
  proof: PostingBalanceProof | null | undefined,
  rows: PostingPresenceRow[]
): PostingBalanceSafetyResult {
  if (!proof?.available) {
    return { safe: true, reason: "Live balance proof is not available." };
  }

  if (proof.statementSequenceValid === false) {
    return {
      safe: false,
      reason: "The statement running-balance sequence is invalid. Correct the extracted debit, credit, or balance values first.",
    };
  }

  const statementOpening = finiteNumber(proof.statementOpeningBalance);
  const tallyOpening = finiteNumber(proof.tallyOpeningBalance);
  if (
    statementOpening !== null &&
    tallyOpening !== null &&
    !moneyMatches(statementOpening, tallyOpening)
  ) {
    return {
      safe: false,
      reason: "The statement opening balance does not match Tally for the selected bank ledger.",
    };
  }

  if (proof.balancesMatch === true) {
    return { safe: true, reason: "Statement and Tally balances match." };
  }

  const statementClosing = finiteNumber(proof.statementClosingBalance);
  const tallyClosing = finiteNumber(proof.tallyClosingBalance);
  if (proof.balancesMatch === false && statementClosing !== null && tallyClosing !== null) {
    const missingTransactionEffect = Number(
      rows
        .filter((row) => row.presenceStatus === "missing")
        .reduce(
          (total, row) =>
            total + (finiteNumber(row.creditAmount) ?? 0) - (finiteNumber(row.debitAmount) ?? 0),
          0
        )
        .toFixed(2)
    );
    const liveDifference = Number((statementClosing - tallyClosing).toFixed(2));
    if (moneyMatches(liveDifference, missingTransactionEffect)) {
      return {
        safe: true,
        reason: "The closing-balance difference is fully explained by statement rows missing from Tally.",
        explainedDifference: missingTransactionEffect,
      };
    }
    return {
      safe: false,
      reason: "The Tally closing-balance difference is not explained by the statement rows marked missing.",
      explainedDifference: missingTransactionEffect,
    };
  }

  return { safe: true, reason: "Live closing balances could not be compared." };
}

function money(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validateInOrder(transactions, openingBalance) {
  let previousBalance = money(openingBalance);
  const breaks = [];

  for (const transaction of transactions) {
    const balance = money(transaction?.balance_amount);
    const debit = money(transaction?.debit_amount) ?? 0;
    const credit = money(transaction?.credit_amount) ?? 0;
    if (previousBalance !== null && balance !== null) {
      const expectedBalance = Number((previousBalance - debit + credit).toFixed(2));
      if (Math.abs(expectedBalance - balance) >= 0.01) {
        const provenance = transaction?.raw_payload?.extractionProvenance ?? {};
        breaks.push({
          page: Number(provenance.startPage) || null,
          sourceIndex: Number(provenance.sourceIndex) || 0,
          previousBalance,
          expectedBalance,
          actualBalance: balance,
          referenceNumber: transaction.reference_number ?? null,
        });
      }
    }
    if (balance !== null) previousBalance = balance;
  }

  return breaks;
}

/**
 * Bank PDFs are commonly printed newest-first. Validate in the supplied
 * order first, then retry in reverse order when that is the consistent
 * chronological direction. The rows themselves are not reordered; this is
 * validation-only so the UI keeps the statement's original order.
 */
export function validateRunningBalanceContinuity(transactions, openingBalance = null) {
  const rows = Array.isArray(transactions) ? transactions : [];
  const forwardBreaks = validateInOrder(rows, openingBalance);
  if (forwardBreaks.length === 0) {
    return {
      valid: true,
      orientation: "forward",
      checkedTransitions: Math.max(0, rows.length - 1),
      breaks: [],
      forwardBreakCount: 0,
      reverseBreakCount: rows.length > 1 ? validateInOrder([...rows].reverse(), openingBalance).length : 0,
    };
  }

  const reverseBreaks = rows.length > 1
    ? validateInOrder([...rows].reverse(), openingBalance)
    : forwardBreaks;
  if (reverseBreaks.length === 0) {
    return {
      valid: true,
      orientation: "reverse",
      checkedTransitions: Math.max(0, rows.length - 1),
      breaks: [],
      forwardBreakCount: forwardBreaks.length,
      reverseBreakCount: 0,
    };
  }

  // Preserve the more useful diagnostics when neither direction is valid.
  const breaks = reverseBreaks.length < forwardBreaks.length ? reverseBreaks : forwardBreaks;
  return {
    valid: false,
    orientation: reverseBreaks.length < forwardBreaks.length ? "reverse" : "forward",
    checkedTransitions: Math.max(0, rows.length - 1),
    breaks,
    forwardBreakCount: forwardBreaks.length,
    reverseBreakCount: reverseBreaks.length,
  };
}

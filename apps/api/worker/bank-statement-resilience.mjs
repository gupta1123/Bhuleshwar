function pageText(page) {
  return String(typeof page === "string" ? page : page?.text || "");
}

export function shouldAttemptBankStatementSingleShot({
  isPdf,
  pageCount,
  pages = [],
  maxPages,
  maxInputChars = 36_000,
  maxLikelyRows = 70,
}) {
  if (!isPdf) return true;
  if (!Number.isFinite(pageCount) || pageCount <= 0 || pageCount > maxPages) return false;
  // A non-empty multi-page response does not prove that every page was read.
  // Multi-page PDFs must use the page-audited batch pipeline.
  if (pageCount > 1) return false;

  const text = pages.map(pageText).join("\n");
  if (text.length > maxInputChars) return false;

  const likelyRows = text
    .split(/\r?\n/)
    .filter((line) => {
      const hasDate = /\b(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})\b/.test(line);
      const hasAmount = /(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}\b/.test(line);
      return hasDate && hasAmount;
    }).length;

  return likelyRows <= maxLikelyRows;
}

function positivePageNumber(value) {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : null;
}

function transactionSourcePage(transaction) {
  const payload = transaction?.raw_payload;
  const rawRow = payload?.row && typeof payload.row === "object" ? payload.row : {};
  return positivePageNumber(
    rawRow.sourcePage ??
    rawRow.source_page ??
    rawRow.pageNumber ??
    rawRow.page_number ??
    rawRow.page
  );
}

function pageResultStatus(result) {
  const rawStatus = String(result?.status ?? result?.pageStatus ?? result?.page_status ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]+/g, "_");
  if (
    result?.hasTransactions === true ||
    result?.has_transactions === true ||
    ["transactions", "transaction_rows", "succeeded", "has_transactions"].includes(rawStatus)
  ) {
    return "transactions";
  }
  if (
    result?.hasTransactions === false ||
    result?.has_transactions === false ||
    ["no_transactions", "non_transaction", "empty_non_transaction", "summary", "blank"].includes(rawStatus)
  ) {
    return "no_transactions";
  }
  return "unknown";
}

export function validateBankStatementPageCoverage({
  transactions = [],
  pageResults = [],
  pages = [],
  method = "batch",
}) {
  const expectedPages = pages
    .map((page) => ({
      pageNumber: positivePageNumber(page?.pageNumber ?? page?.page),
      likelyHasRows: page?.likelyHasRows === true,
      canConfirmNoTransactions: page?.canConfirmNoTransactions !== false,
      expectedMinimumRowCount:
        Number.isInteger(Number(page?.expectedMinimumRowCount)) && Number(page.expectedMinimumRowCount) > 0
          ? Number(page.expectedMinimumRowCount)
          : null,
    }))
    .filter((page) => page.pageNumber !== null);
  const expectedSet = new Set(expectedPages.map((page) => page.pageNumber));
  const manifest = new Map();
  for (const result of Array.isArray(pageResults) ? pageResults : []) {
    const pageNumber = positivePageNumber(
      result?.pageNumber ?? result?.page_number ?? result?.sourcePage ?? result?.source_page ?? result?.page
    );
    if (!pageNumber || !expectedSet.has(pageNumber)) continue;
    const transactionCount = Number(result?.transactionCount ?? result?.transaction_count ?? result?.rowCount);
    manifest.set(pageNumber, {
      status: pageResultStatus(result),
      transactionCount: Number.isInteger(transactionCount) && transactionCount >= 0 ? transactionCount : null,
    });
  }

  const rowsByPage = new Map(expectedPages.map((page) => [page.pageNumber, []]));
  let droppedUnassignedRowCount = 0;
  for (const transaction of Array.isArray(transactions) ? transactions : []) {
    let pageNumber = transactionSourcePage(transaction);
    if ((!pageNumber || !expectedSet.has(pageNumber)) && expectedPages.length === 1) {
      pageNumber = expectedPages[0].pageNumber;
    }
    if (!pageNumber || !expectedSet.has(pageNumber)) {
      droppedUnassignedRowCount += 1;
      continue;
    }
    rowsByPage.get(pageNumber).push(transaction);
  }

  const verifiedTransactions = [];
  const pageOutcomes = expectedPages.map((page) => {
    const rows = rowsByPage.get(page.pageNumber) ?? [];
    const declared = manifest.get(page.pageNumber);
    const declaredMoreRowsThanUsable =
      declared?.status === "transactions" &&
      declared.transactionCount !== null &&
      declared.transactionCount > rows.length;
    const visibleRowsMissing =
      page.expectedMinimumRowCount !== null && rows.length < page.expectedMinimumRowCount;
    if (rows.length > 0 && !declaredMoreRowsThanUsable && !visibleRowsMissing) {
      verifiedTransactions.push(...addBankStatementPageProvenance(rows, {
        startPage: page.pageNumber,
        endPage: page.pageNumber,
        method,
      }));
      return { page: page.pageNumber, status: "succeeded", rowCount: rows.length };
    }
    if (
      declared?.status === "no_transactions" &&
      page.canConfirmNoTransactions &&
      !page.likelyHasRows
    ) {
      return { page: page.pageNumber, status: "confirmed_non_transaction", rowCount: 0 };
    }
    return {
      page: page.pageNumber,
      status: declaredMoreRowsThanUsable || visibleRowsMissing ? "incomplete" : "unverified",
      rowCount: rows.length,
      expectedMinimumRowCount: page.expectedMinimumRowCount,
    };
  });

  return {
    transactions: verifiedTransactions,
    pageOutcomes,
    unresolvedPages: pageOutcomes
      .filter((outcome) => !["succeeded", "confirmed_non_transaction"].includes(outcome.status))
      .map((outcome) => outcome.page),
    droppedUnassignedRowCount,
  };
}

export function classifyBankStatementBatchOutcome({ rowCount, likelyHasRows }) {
  if (rowCount > 0) return { status: "succeeded", requiresRecovery: false };
  if (likelyHasRows) return { status: "empty_transaction_page", requiresRecovery: true };
  return { status: "empty_non_transaction", requiresRecovery: false };
}

export function addBankStatementPageProvenance(transactions, {
  startPage,
  endPage,
  method,
}) {
  return transactions.map((transaction, sourceIndex) => ({
    ...transaction,
    raw_payload: {
      ...(transaction.raw_payload ?? {}),
      extractionProvenance: {
        startPage,
        endPage,
        sourceIndex,
        method,
      },
    },
  }));
}

function provenance(transaction) {
  const value = transaction?.raw_payload?.extractionProvenance;
  return value && typeof value === "object" ? value : {};
}

export function sortBankStatementTransactionsByProvenance(transactions) {
  return transactions
    .map((transaction, mergeIndex) => ({ transaction, mergeIndex }))
    .sort((left, right) => {
      const leftProvenance = provenance(left.transaction);
      const rightProvenance = provenance(right.transaction);
      return (
        Number(leftProvenance.startPage ?? Number.MAX_SAFE_INTEGER) -
          Number(rightProvenance.startPage ?? Number.MAX_SAFE_INTEGER) ||
        Number(leftProvenance.sourceIndex ?? Number.MAX_SAFE_INTEGER) -
          Number(rightProvenance.sourceIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.mergeIndex - right.mergeIndex
      );
    })
    .map(({ transaction }) => transaction);
}

export function unresolvedBankStatementRecoveryPages(diagnostics, expectedPages = []) {
  const unresolved = new Set(
    expectedPages
      .map(Number)
      .filter((page) => Number.isFinite(page) && page > 0)
  );
  for (const entry of diagnostics) {
    const page = Number(entry?.page);
    if (!Number.isFinite(page) || page <= 0) continue;
    if (entry?.status === "succeeded" || entry?.status === "confirmed_non_transaction") {
      unresolved.delete(page);
    } else if (entry?.status === "failed" || entry?.status === "empty") {
      unresolved.add(page);
    }
  }
  return [...unresolved].sort((left, right) => left - right);
}

function cleanMarkdownCell(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_`]/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedHeader(value) {
  return cleanMarkdownCell(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedReference(value) {
  return cleanMarkdownCell(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizedNarration(value) {
  return cleanMarkdownCell(value).toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizedDate(value) {
  const text = cleanMarkdownCell(value);
  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  let year; let month; let day;
  if (match) [, year, month, day] = match;
  else {
    match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
    if (!match) return null;
    [, day, month, year] = match;
    if (year.length === 2) year = `20${year}`;
  }
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return date.toISOString().slice(0, 10);
}

function markdownCells(line) {
  const text = String(line ?? "").trim();
  if (!text.includes("|")) return null;
  const body = text.replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => cleanMarkdownCell(cell.replace(/\\\|/g, "|")));
}

function isSeparatorRow(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function columnIndex(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
}

export function parseBankStatementMoney(value) {
  const raw = cleanMarkdownCell(value);
  if (!raw || /^(?:-|--|—|–|nil|n\/a)$/i.test(raw)) return null;
  const match = raw.match(/\(?\s*-?\s*(?:INR|Rs\.?|₹|\$|€|£)?\s*\d[\d,]*(?:\.\d+)?\s*(?:DR|CR)?\s*\)?/i);
  if (!match) return null;
  const token = match[0];
  const isNegative = /^\s*\(/.test(token) || /-\s*(?:INR|Rs\.?|₹|\$|€|£)?\s*\d/i.test(token) || /\bDR\s*\)?$/i.test(token);
  const digits = token
    .replace(/\b(?:INR|Rs|DR|CR)\.?\b/gi, "")
    .replace(/[₹$€£,()\s-]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return null;
  const amount = Number(digits);
  return Number.isFinite(amount) ? (isNegative ? -amount : amount) : null;
}

function extractOpeningBalance(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  for (const line of lines) {
    const cells = markdownCells(line);
    if (cells) {
      for (let index = 0; index < cells.length; index += 1) {
        if (!/\b(?:opening balance|balance brought forward|balance b\/?f|brought forward balance)\b/i.test(cells[index])) continue;
        const sameCell = cells[index].replace(/^.*?\b(?:opening balance|balance brought forward|balance b\/?f|brought forward balance)\b\s*[:=-]?/i, "");
        const amount = parseBankStatementMoney(sameCell) ?? parseBankStatementMoney(cells[index + 1]);
        if (amount !== null) return amount;
      }
    }
    const label = line.match(/\b(?:opening balance|balance brought forward|balance b\/?f|brought forward balance)\b/i);
    if (label) {
      const amount = parseBankStatementMoney(line.slice((label.index ?? 0) + label[0].length));
      if (amount !== null) return amount;
    }
  }
  return null;
}

export function extractBankStatementMarkdownAmounts(markdown, { includeSourceDetails = false } = {}) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const rows = [];

  for (let lineIndex = 0; lineIndex < lines.length - 1; lineIndex += 1) {
    const headerCells = markdownCells(lines[lineIndex]);
    const separatorCells = markdownCells(lines[lineIndex + 1]);
    if (!headerCells || !isSeparatorRow(separatorCells) || separatorCells.length !== headerCells.length) continue;

    const headers = headerCells.map(normalizedHeader);
    const referenceIndex = columnIndex(headers, [/^reference(?: no| number)?$/, /^ref(?: no| number)?$/, /^txn no$/, /\butr\b/, /cheque|check|chq/]);
    // Merged headings are not reliable amount columns (e.g. Cheque No. Dr Amount).
    const debitIndex = columnIndex(headers, [/^dr amount$/, /\bdebit\b/, /withdrawal/, /paid out/]);
    const creditIndex = columnIndex(headers, [/^cr amount$/, /\bcredit\b/, /deposit/, /paid in/]);
    const balanceIndex = columnIndex(headers, [/\bbalance\b/]);
    const dateIndex = columnIndex(headers, [/^transaction date$/, /^txn date$/, /^date$/, /^posting date$/]);
    const narrationIndex = columnIndex(headers, [
      /^description$/,
      /^transaction description$/,
      /^particulars?$/,
      /^narration$/,
      /^details?$/,
      /^remarks?$/,
    ]);
    // Parsing amounts is useful even for layouts that expose only a stable
    // reference. Source-coverage verification applies the stricter
    // date+narration requirements before any extracted statement can post.
    if ((dateIndex < 0 && referenceIndex < 0) || (debitIndex < 0 && creditIndex < 0)) continue;

    for (let rowIndex = lineIndex + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = markdownCells(lines[rowIndex]);
      if (!cells || isSeparatorRow(cells)) break;
      if (cells.length < headerCells.length) break;
      const reference = referenceIndex >= 0 ? normalizedReference(cells[referenceIndex]) : "";
      const sourceDate = dateIndex >= 0 ? cells[dateIndex] : null;
      const sourceNarration = narrationIndex >= 0 ? cells[narrationIndex] : null;
      if (!reference && !(sourceDate && sourceNarration)) continue;
      const debitAmount = debitIndex >= 0 ? parseBankStatementMoney(cells[debitIndex]) : null;
      const creditAmount = creditIndex >= 0 ? parseBankStatementMoney(cells[creditIndex]) : null;
      const balanceAmount = balanceIndex >= 0 ? parseBankStatementMoney(cells[balanceIndex]) : null;
      if (balanceAmount === null && debitAmount === null && creditAmount === null) continue;
      rows.push({
        reference,
        sourceDate,
        narration: sourceNarration,
        debitAmount: debitAmount === null ? null : Math.abs(debitAmount),
        creditAmount: creditAmount === null ? null : Math.abs(creditAmount),
        balanceAmount,
        ...(includeSourceDetails ? {
          sourceLine: lines[rowIndex],
          sourceHeader: `${lines[lineIndex]}\n${lines[lineIndex + 1]}`,
        } : {}),
      });
    }
  }

  return { openingBalance: extractOpeningBalance(markdown), rows };
}

function sameNullableMoney(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return Math.abs(Number(left) - Number(right)) < 0.01;
}

export function reconcileBankStatementMarkdownAmounts(parsed, markdown, physicalSource = null) {
  const deterministic = physicalSource ?? extractBankStatementMarkdownAmounts(markdown);
  const rowsByReference = new Map();
  for (const row of deterministic.rows) {
    const values = rowsByReference.get(row.reference) ?? [];
    values.push(row);
    rowsByReference.set(row.reference, values);
  }

  let correctedRowCount = 0;
  const parsedTransactions = parsed?.transactions ?? [];
  const matchByOrder = physicalSource?.matchByOrder === true && deterministic.rows.length === parsedTransactions.length;
  const transactions = parsedTransactions.map((transaction, transactionIndex) => {
    const reference = normalizedReference(transaction.reference_number);
    const candidates = rowsByReference.get(reference) ?? [];
    const identityCandidates = deterministic.rows.filter((row) =>
      normalizedDate(row.sourceDate) === normalizedDate(transaction.transaction_date) &&
      normalizedNarration(row.narration) === normalizedNarration(transaction.description)
    );
    const source = matchByOrder
      ? deterministic.rows[transactionIndex]
      : reference && candidates.length === 1
        ? candidates[0]
        : identityCandidates.length === 1
          ? identityCandidates[0]
        : null;
    if (!source) return transaction;
    const hasOneAmount = Number(source.debitAmount > 0) + Number(source.creditAmount > 0) === 1;
    const nextDebit = hasOneAmount ? source.debitAmount : transaction.debit_amount;
    const nextCredit = hasOneAmount ? source.creditAmount : transaction.credit_amount;
    const nextBalance = source.balanceAmount ?? transaction.balance_amount;
    const changed =
      !sameNullableMoney(nextDebit, transaction.debit_amount) ||
      !sameNullableMoney(nextCredit, transaction.credit_amount) ||
      !sameNullableMoney(nextBalance, transaction.balance_amount);
    if (!changed) return transaction;
    correctedRowCount += 1;
    return {
      ...transaction,
      debit_amount: nextDebit,
      credit_amount: nextCredit,
      balance_amount: nextBalance,
      ...(hasOneAmount && (Number(nextDebit)>0)!==(Number(transaction.debit_amount)>0)
        ? {category:Number(nextDebit)>0?'payment':'receipt'} : {}),
      raw_payload: {
        ...(transaction.raw_payload ?? {}),
        deterministicMarkdownAmounts: {
          reference: transaction.reference_number ?? null,
          originalDebitAmount: transaction.debit_amount ?? null,
          originalCreditAmount: transaction.credit_amount ?? null,
          originalBalanceAmount: transaction.balance_amount ?? null,
          correctedDebitAmount: nextDebit ?? null,
          correctedCreditAmount: nextCredit ?? null,
          correctedBalanceAmount: nextBalance ?? null,
          ...(physicalSource ? {source:'pdf_columns',layout:physicalSource.layout??null,page:source.page??null}:{}),
        },
      },
    };
  });

  return {
    ...parsed,
    openingBalance: deterministic.openingBalance ?? parsed?.openingBalance ?? null,
    transactions,
    markdownAmountDiagnostics: {
      sourceRowCount: deterministic.rows.length,
      correctedRowCount,
      openingBalanceRecovered: deterministic.openingBalance !== null,
    },
  };
}


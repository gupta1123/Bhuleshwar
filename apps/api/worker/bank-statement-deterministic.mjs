export function parseAllTables(md) {
  const lines = md.split("\n");
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1] || "";
    const isHeader = line.includes("|") && line.split("|").filter(Boolean).length >= 2;
    const isSep = /\|\s*:?-{2,}:?\s*\|/.test(next) || /^\s*\|?(\s*:?-+:?\s*\|)+\s*$/.test(next);
    if (isHeader && isSep) {
      const rawHeaders = line.split("|").slice(1, -1).map((c) => c.trim());
      const rawRows = [];
      const startLine = i;
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        const row = lines[i].split("|").slice(1, -1).map((c) => c.trim());
        if (row.every((c) => /^:?-+:?$/.test(c))) { i++; continue; }
        rawRows.push(row);
        i++;
      }
      if (rawHeaders.length >= 2 && rawRows.length > 0) {
        const keepIdx = rawHeaders.map((h, idx) => ({ h, idx })).filter((x) => x.h !== "").map((x) => x.idx);
        let headers = keepIdx.map((idx) => rawHeaders[idx]);
        let rows = rawRows.map((r) => keepIdx.map((idx) => r[idx] ?? ""));
        // PNB fused header fix
        const hasFused = headers.some((h) => h.toLowerCase().includes("cheque") && h.toLowerCase().includes("dr amount"));
        if (hasFused) {
          const idx = headers.findIndex((h) => h.toLowerCase().includes("cheque") && h.toLowerCase().includes("dr amount"));
          if (idx !== -1) {
            headers = [...headers.slice(0, idx), "Cheque No.", "Dr Amount", ...headers.slice(idx + 1)];
            rows = rows.map((r) => {
              const cell = r[idx] || "";
              const isAmount = /[\d,]+\.\d{2}/.test(cell) && cell !== "-";
              return [...r.slice(0, idx), "", isAmount ? cell : "", ...r.slice(idx + 1)];
            });
          }
        }
        tables.push({ headers, rows, rawHeaders, rawRows, startLine });
      }
    } else {
      i++;
    }
  }
  return tables;
}

export function isTransactionTable(t) {
  const h = t.headers.map((x) => x.toLowerCase());
  const hasDate = h.some((x) => x.includes("date"));
  const hasDesc = h.some((x) => x.includes("description") || x.includes("narration") || x.includes("particular") || x.includes("details") || x.includes("remarks"));
  const hasAmount = h.some((x) => x.includes("debit") || x.includes("credit") || x.includes("withdrawal") || x.includes("deposit") || x.includes("amount") || x.includes("balance") || x === "dr" || x === "cr");
  return hasDate && hasDesc && hasAmount;
}

export function extractBrokenTransactions(md) {
  const afterPage1 = md.split(/Page No\s*1/i)[1] || "";
  if (!afterPage1) return [];
  const re = /(?:NRTGS|NEFT|RTGS|IMPS)[\s\S]*?\d{1,2}[-/]\d{1,2}[-/]\d{2,4}[\s\S]*?Dr\./g;
  const matches = [...afterPage1.matchAll(re)];
  return matches.map((m) => {
    const txt = m[0].replace(/\s+/g, " ").trim();
    const date = (txt.match(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/) || [""])[0];
    const amounts = [...txt.matchAll(/\d{1,3}(?:,\d{2,3})+\.\d{2}/g)].map((x) => x[0]);
    const txn = (txt.match(/\b[US]\d{5,}\b/) || [""])[0];
    const bal = amounts.length >= 2 ? amounts[amounts.length - 1] : "";
    const amt = amounts.length >= 1 ? amounts[0] : "";
    const desc = txt.slice(0, 140);
    return [txn, date, desc, "-", "", amt, "", bal, ""];
  });
}

function parseDateValue(v, fallbackYear = null) {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d)) return `${y.padStart(4,"0")}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }
  const indian = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (indian) {
    const [, d, m, yRaw] = indian;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d)) return `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }
  // PDF converters sometimes append a repeated bank heading/footer to the date
  // cell (for example "02-Sep-2026 19:47:45 HDFC BANK LIMITED"). The leading
  // date is still authoritative, so accept trailing time or converter noise.
  const shortMonth = raw.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})(?:[\s-]+(\d{2,4}))?\b/);
  if (shortMonth) {
    const year = shortMonth[3]
      ? (shortMonth[3].length === 2 ? `20${shortMonth[3]}` : shortMonth[3])
      : fallbackYear;
    if (year) {
      const parsed = new Date(`${shortMonth[1]} ${shortMonth[2]} ${year} UTC`);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    }
  }
  const p = new Date(raw);
  if (!isNaN(p.getTime())) return p.toISOString().slice(0,10);
  return null;
}

function parseAmountValue(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const raw = String(v).trim();
  if (!raw) return null;
  const isDR = /\bDR\.?\s*$/i.test(raw);
  const neg = /^\(.*\)$/.test(raw) || /^-/.test(raw) || isDR;
  const cleaned = raw.replace(/\b(?:DR|CR)\.?\s*$/i,"").replace(/[(),₹$€£\s]/g,"").replace(/^-/,"");
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return isFinite(n) ? (neg ? -n : n) : null;
}

const HEADER_PATTERNS = [
  ["transaction date", "date"], ["txn date", "date"], ["post date", "date"], ["posting date", "date"], ["value date", "value_date"], ["date", "date"],
  ["transaction description", "description"], ["description / particulars", "description"], ["transaction details", "description"], ["narration / description", "description"], ["narration", "description"], ["description", "description"], ["particulars", "description"],
  ["reference / utr", "reference"], ["reference no.", "reference"], ["reference no", "reference"], ["reference", "reference"], ["cheque number", "reference"], ["cheque no.", "reference"], ["cheque no", "reference"],
  ["txn no.", "txn_no"], ["txn no", "txn_no"], ["transaction no.", "txn_no"], ["transaction no", "txn_no"],
  ["debit amount", "debit"], ["dr amount", "debit"], ["debit (inr)", "debit"], ["withdrawal", "debit"], ["paid out", "debit"], ["debit", "debit"],
  ["credit amount", "credit"], ["cr amount", "credit"], ["credit (inr)", "credit"], ["deposit", "credit"], ["paid in", "credit"], ["credit", "credit"],
  ["closing balance", "balance"], ["balance (inr)", "balance"], ["balance", "balance"],
];

function headerPart(value) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();
  // Some PDF converters collapse adjacent withdrawal/deposit columns into one
  // generic amount column. Preserve that ambiguity here and infer direction
  // from the narration instead of incorrectly treating every row as a debit.
  if (lower.includes("withdrawal") && lower.includes("deposit")) return { kind: "amount", label: raw, remainder: "" };
  // AnyDoc occasionally fuses the empty cheque-number heading with the debit
  // heading. The cells below it contain the debit, so the useful semantic is
  // the amount column rather than the empty reference column.
  if (/cheque\s+no\.?\s+dr\s+amount/.test(lower)) return { kind: "debit", label: raw, remainder: "" };
  for (const [label, kind] of HEADER_PATTERNS) {
    if (lower === label) return { kind, label: raw, remainder: "" };
    if (lower.startsWith(`${label} `)) return { kind, label: raw.slice(0, label.length), remainder: raw.slice(label.length).trim() };
  }
  return { kind: null, label: raw, remainder: "" };
}

function headerScore(row) {
  const kinds = new Set(row.map((cell) => headerPart(cell).kind).filter(Boolean));
  return Number(kinds.has("date") || kinds.has("value_date")) + Number(kinds.has("description")) +
    Number(kinds.has("debit") || kinds.has("credit")) + Number(kinds.has("balance"));
}

function inferStatementYear(markdown) {
  const explicit = String(markdown).match(/(?:statement\s+(?:date|period)|page\s+period)[^\n|]*?\b(20\d{2})\b/i);
  if (explicit) return explicit[1];
  const dated = String(markdown).match(/\b\d{1,2}[\s/-]+(?:[A-Za-z]{3,9}|\d{1,2})[\s/-]+(20\d{2})\b/);
  return dated?.[1] || null;
}

function strictAmount(value) {
  const raw = String(value ?? "").replace(/\.\s+(?=\d)/g, ".").replace(/(?<=\d)\s+(?=\d)/g, "").trim();
  if (!raw || raw === "-") return null;
  const matches = raw.match(/(?:\(?-?[₹$€£]?\s*\d[\d,]*(?:\.\d+)?\)?\s*(?:DR|CR)?\.?)/gi) || [];
  if (matches.length !== 1) return null;
  return parseAmountValue(matches[0]);
}

function cellAmounts(value) {
  const raw = String(value ?? "").replace(/\.\s+(?=\d)/g, ".").replace(/(?<=\d)\s+(?=\d)/g, "").trim();
  if (!raw || raw === "-") return [];
  return (raw.match(/\(?-?[₹$€£]?\s*\d[\d,]*(?:\.\d+)?\)?\s*(?:DR|CR)?\.?/gi) || [])
    .map(parseAmountValue)
    .filter((amount) => amount !== null);
}

function transactionAmount(value) {
  return cellAmounts(value).find((amount) => Math.abs(amount) > 0) ?? null;
}

function directionFromDescription(description) {
  const text = String(description || "").toUpperCase();
  if (/\b(?:CR|CREDIT|DEPOSIT|REFUND)\b/.test(text) || /\bFROM\b/.test(text) || /(?:NEFT|RTGS|IMPS)_IN\b/.test(text)) return "credit";
  if (/\b(?:DR|DEBIT|WITHDRAWAL|CHARGES?|COMMISSION)\b/.test(text) || /\bTO\b/.test(text) || /(?:NEFT|RTGS|IMPS)_OUT\b/.test(text)) return "debit";
  return null;
}

function normalizedTableSource(table) {
  const rawHeaders = Array.isArray(table.rawHeaders) ? [...table.rawHeaders] : [...table.headers];
  const rawRows = Array.isArray(table.rawRows) ? table.rawRows.map((row) => [...row]) : table.rows.map((row) => [...row]);
  const embeddedHeaderIndex = rawRows.findIndex((row) => headerScore(row) >= 3);
  if (headerScore(rawHeaders) < 3 && embeddedHeaderIndex >= 0) {
    return { headers: rawRows[embeddedHeaderIndex], rows: rawRows.slice(embeddedHeaderIndex + 1), recoveredHeaderRow: null };
  }
  const parts = rawHeaders.map(headerPart);
  const recoveredHeaderRow = parts.some((part) => part.remainder)
    ? parts.map((part) => part.remainder)
    : null;
  return { headers: parts.map((part) => part.kind || part.label), rows: rawRows, recoveredHeaderRow };
}

function semanticIndexes(headers) {
  const kinds = headers.map((header) => {
    const text = String(header || "").toLowerCase().trim();
    return ["date", "value_date", "description", "reference", "txn_no", "debit", "credit", "amount", "balance"].includes(text)
      ? text
      : headerPart(header).kind;
  });
  const first = (kind) => kinds.indexOf(kind);
  return { kinds, date: first("date") >= 0 ? first("date") : first("value_date"), valueDate: first("value_date"), description: first("description"), reference: first("reference"), txnNo: first("txn_no"), debit: first("debit"), credit: first("credit"), balance: first("balance") };
}

function nearestAmount(row, index, excluded) {
  if (index < 0) return null;
  for (const distance of [0, 1, -1, 2, -2]) {
    const candidate = index + distance;
    if (candidate < 0 || candidate >= row.length || excluded.has(candidate)) continue;
    const amount = strictAmount(row[candidate]);
    if (amount !== null) return { amount: Math.abs(amount), index: candidate };
  }
  return null;
}

function normalizeTableTransactions(table, fallbackYear, startIndex) {
  const source = normalizedTableSource(table);
  const indexes = semanticIndexes(source.headers);
  if (indexes.date < 0 || indexes.description < 0) return [];
  const rows = source.recoveredHeaderRow ? [source.recoveredHeaderRow, ...source.rows] : source.rows;
  const output = [];
  for (const row of rows) {
    const transactionDate = parseDateValue(row[indexes.date], fallbackYear);
    const description = String(row[indexes.description] || "").replace(/\s+/g, " ").trim();
    if (!transactionDate || !description || headerScore(row) >= 3) continue;
    const txnNo = indexes.txnNo >= 0 ? String(row[indexes.txnNo] || "").trim() : "";
    const reference = indexes.reference >= 0 ? String(row[indexes.reference] || "").trim() : txnNo;
    const balanceCandidates = [];
    if (indexes.balance >= 0) {
      const exactBalance = cellAmounts(row[indexes.balance]).at(-1);
      if (exactBalance !== undefined) balanceCandidates.push({ amount: exactBalance, index: indexes.balance, distance: -1 });
      for (const distance of [0, 1, -1, 2, -2]) {
        const candidate = indexes.balance + distance;
        if (candidate >= 0 && candidate < row.length) {
          const amount = strictAmount(row[candidate]);
          if (amount !== null) balanceCandidates.push({ amount, index: candidate, distance: Math.abs(distance) });
        }
      }
    }
    const balanceMatch = indexes.balance >= 0
      ? balanceCandidates.sort((a, b) => a.distance - b.distance || b.index - a.index)[0] ||
        [...row].map((cell, index) => ({ amount: cellAmounts(cell).at(-1) ?? null, index })).filter((item) => item.amount !== null).at(-1) || null
      : null;
    const excluded = new Set([indexes.date, indexes.valueDate, indexes.description, indexes.reference, indexes.txnNo, balanceMatch?.index].filter((value) => value >= 0));
    const exactDebit = indexes.debit >= 0 ? transactionAmount(row[indexes.debit]) : null;
    const exactCredit = indexes.credit >= 0 ? transactionAmount(row[indexes.credit]) : null;
    let debitMatch = exactDebit !== null ? { amount: Math.abs(exactDebit), index: indexes.debit } : null;
    let creditMatch = exactCredit !== null ? { amount: Math.abs(exactCredit), index: indexes.credit } : null;
    const available = row.map((cell, index) => ({ amount: transactionAmount(cell), index }))
      .filter((item) => item.amount !== null && !excluded.has(item.index));
    const direction = directionFromDescription(description);
    if (!debitMatch && !creditMatch && available.length > 0) {
      if (direction) {
        const candidate = available[0];
        if (direction === "debit") debitMatch = { ...candidate, amount: Math.abs(candidate.amount) };
        else creditMatch = { ...candidate, amount: Math.abs(candidate.amount) };
      } else if (available.length === 1) {
        const candidate = available[0];
        const debitDistance = indexes.debit >= 0 ? Math.abs(candidate.index - indexes.debit) : Number.POSITIVE_INFINITY;
        const creditDistance = indexes.credit >= 0 ? Math.abs(candidate.index - indexes.credit) : Number.POSITIVE_INFINITY;
        if (creditDistance < debitDistance) creditMatch = { ...candidate, amount: Math.abs(candidate.amount) };
        else debitMatch = { ...candidate, amount: Math.abs(candidate.amount) };
      } else {
        debitMatch = nearestAmount(row, indexes.debit, excluded);
        creditMatch = nearestAmount(row, indexes.credit, new Set([...excluded, debitMatch?.index].filter((value) => value !== undefined)));
      }
    }
    const debitAmount = debitMatch?.amount > 0 ? debitMatch.amount : null;
    const creditAmount = creditMatch?.amount > 0 ? creditMatch.amount : null;
    const amountIssue = Boolean(debitAmount) === Boolean(creditAmount)
      ? (debitAmount ? "both_debit_and_credit" : "missing_debit_and_credit")
      : null;
    output.push({
      row_index: startIndex + output.length + 1,
      transaction_date: transactionDate,
      value_date: indexes.valueDate >= 0 ? parseDateValue(row[indexes.valueDate], fallbackYear) || transactionDate : transactionDate,
      description,
      reference_number: reference || txnNo || null,
      debit_amount: debitAmount,
      credit_amount: creditAmount,
      balance_amount: balanceMatch?.amount ?? null,
      transaction_type: "unknown",
      category: amountIssue ? "unknown" : (creditAmount ? "receipt" : "payment"),
      counterparty_name: null,
      suggested_ledger_name: null,
      suggestion_confidence: null,
      suggestion_reason: null,
      confirmed_ledger_name: null,
      additional_charges: [],
      confidence: amountIssue ? 0.6 : 0.9,
      raw_payload: { rowNumber: startIndex + output.length + 1, source: "deterministic_anydoc_normalized", ...(amountIssue ? { amountValidationIssue: amountIssue } : {}) },
    });
  }
  return output;
}

export function deterministicTransactionsFromAnydoc(markdown) {
  const all = parseAllTables(markdown);
  const rawTx = all.filter((table) => isTransactionTable(table) || table.rawRows?.some((row) => headerScore(row) >= 3));
  const broken = extractBrokenTransactions(markdown);
  // A prose-like continuation after a page break has lost its column
  // boundaries. Do not publish a partial deterministic result: the caller can
  // recover those pages with the existing page-recovery path.
  if (broken.length) return null;
  const year = inferStatementYear(markdown);
  const transactions = [];
  for (const table of rawTx) transactions.push(...normalizeTableTransactions(table, year, transactions.length));

  if (transactions.length === 0) return null;
  return { headers: rawTx.flatMap((table) => table.headers), transactions };
}


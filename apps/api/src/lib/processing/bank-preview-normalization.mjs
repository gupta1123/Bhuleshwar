import { correctRowsFromRunningBalance } from "../../../worker/bank-statement-running-balance.mjs";

export function parseDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const [, year, month, day] = iso;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const indian = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (indian) {
    const [, day, month, yearRaw] = indian;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw) || /^-/.test(raw);
  const cleaned = raw.replace(/[(),₹$€£\s]/g, "").replace(/^-/, "");
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

export function textCell(value) {
  return String(value ?? "").trim();
}

export function firstTextCell(...values) {
  for (const value of values) {
    const text = textCell(value);
    if (text) return text;
  }
  return "";
}

export function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleCaseName(value) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join(" ");
}

export function cleanCounterpartyCandidate(value) {
  let cleaned = String(value ?? "")
    .replace(/\b(?:utr|ref|reference|invoice|bill|chq|cheque|txn|transaction)\b[\s:#/-]*[a-z0-9-]+.*$/i, "")
    .replace(/[^a-zA-Z0-9 .&'/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (let index = 0; index < 5; index += 1) {
    const match = cleaned.match(/^([a-z0-9]+)(?:\s+|[-:/._]+)(.+)$/i);
    if (!match) break;
    const prefix = match[1].toLowerCase();
    if (!COUNTERPARTY_PREFIXES.has(prefix) && !/^\d{4,}$/.test(prefix)) break;
    cleaned = match[2].trim();
  }

  return cleaned
    .split(/\s*[/|]\s*/)[0]
    .replace(/[-:/._\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractCounterpartyName(description) {
  const raw = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const patterns = [
    /\b(?:neft|rtgs|imps)\s+(?:receipt\s+)?from\s+(.+?)(?:\s+(?:utr|ref|reference|a\/c|ac|account|ifsc|on)\b|$)/i,
    /\b(?:neft|rtgs|imps)\s+(?:payment\s+)?to\s+(.+?)(?:\s+(?:utr|ref|reference|a\/c|ac|account|ifsc|on)\b|$)/i,
    /\b(?:neft|rtgs|imps)\s+(.+?)(?:\s+(?:utr|ref|reference|a\/c|ac|account|ifsc|on)\b|$)/i,
    /\bupi\s+(?:payment\s+)?to\s+(.+?)(?:\s+(?:upi|ref|reference|txn|transaction|on)\b|$)/i,
    /\bupi\s+(?:receipt\s+)?from\s+(.+?)(?:\s+(?:upi|ref|reference|txn|transaction|on)\b|$)/i,
    /\bupi\s+(.+?)(?:\s+(?:upi|ref|reference|txn|transaction|on)\b|$)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const candidate = cleanCounterpartyCandidate(match?.[1]);
    if (candidate && normalizeName(candidate).length >= 3) return titleCaseName(candidate);
  }
  return null;
}

export function detectTransactionType(description) {
  const text = String(description || "").toLowerCase();
  if (/\bupi\b/.test(text)) return "upi";
  if (/\bneft\b/.test(text)) return "neft";
  if (/\brtgs\b/.test(text)) return "rtgs";
  if (/\bimps\b/.test(text)) return "imps";
  if (/\bcheque|chq\b/.test(text)) return "cheque";
  if (/\bcash\b/.test(text)) return "cash";
  if (/\bcharge|charges|fee|gst\b/.test(text)) return "bank_charge";
  if (/\binterest\b/.test(text)) return "interest";
  return "unknown";
}

export function detectCategory(description, debitAmount, creditAmount) {
  const text = String(description || "").toLowerCase();
  if (/\bcharge|charges|fee|gst\b/.test(text)) return "bank_charges";
  if (/\btax|tds|gst\b/.test(text)) return "tax";
  if (/\bsalary|wages\b/.test(text)) return "salary";
  if (/\bloan|emi\b/.test(text)) return "loan_or_emi";
  if (/\bself|own account|internal transfer|transfer to own\b/.test(text)) return "internal_transfer";
  if ((creditAmount ?? 0) > 0) return "receipt";
  if ((debitAmount ?? 0) > 0) return "payment";
  return "unknown";
}

export function correctPreviewRowsFromRunningBalance(transactions, openingBalance = null) {
  return correctRowsFromRunningBalance(transactions, { openingBalance, detectCategory });
}

export function normalizeIfscCode(value) {
  const normalized = String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return normalized.slice(0, 16);
}

export function normalizeAccountNumber(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function maskAccountNumber(value) {
  const normalized = normalizeAccountNumber(value);
  if (!normalized) return "";
  if (normalized.length <= 4) return normalized;
  return `${"*".repeat(Math.max(0, normalized.length - 4))}${normalized.slice(-4)}`;
}

export function normalizeAiTransaction(value, rowNumber) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value;
  const transactionDate = parseDate(row.transactionDate ?? row.date ?? row.txnDate ?? row.postingDate);
  const description = firstTextCell(
    row.fullNarration,
    row["full narration"],
    row.bankNarration,
    row["bank narration"],
    row.transactionNarration,
    row["transaction narration"],
    row.description,
    row.narration,
    row.particulars,
    row.remarks,
    row.details,
    row.transactionDetails,
    row["transaction details"],
    row.transactionDescription,
    row["transaction description"],
    row.rawLine,
    row["raw line"]
  );
  if (!transactionDate || !description) return null;

  const debitAmount = parseAmount(row.debitAmount ?? row.debit ?? row.withdrawal ?? row.paidOut);
  const creditAmount = parseAmount(row.creditAmount ?? row.credit ?? row.deposit ?? row.paidIn);
  const balanceAmount = parseAmount(row.balanceAmount ?? row.balance ?? row.runningBalance ?? row.closingBalance);
  const hasDebit = typeof debitAmount === "number" && debitAmount > 0;
  const hasCredit = typeof creditAmount === "number" && creditAmount > 0;
  if (hasDebit === hasCredit) return null;
  const transactionType = detectTransactionType(description);
  const category = detectCategory(description, debitAmount, creditAmount);
  const counterpartyName = extractCounterpartyName(description);

  return {
    row_index: rowNumber,
    transaction_date: transactionDate,
    value_date: parseDate(row.valueDate) ?? transactionDate,
    description,
    reference_number: textCell(row.referenceNumber ?? row.reference ?? row.utr ?? row.chequeNumber) || null,
    debit_amount: debitAmount,
    credit_amount: creditAmount,
    balance_amount: balanceAmount,
    transaction_type: transactionType,
    category,
    counterparty_name: counterpartyName,
    suggested_ledger_name: textCell(row.suggestedLedgerName) || null,
    suggestion_confidence:
      typeof row.suggestionConfidence === "number" && Number.isFinite(row.suggestionConfidence)
        ? Math.max(0, Math.min(1, row.suggestionConfidence))
        : null,
    suggestion_reason: textCell(row.suggestionReason) || null,
    confirmed_ledger_name: textCell(row.confirmedLedgerName) || null,
    additional_charges: transactionType === "bank_charge" ? [{ type: "bank_charge", amount: debitAmount }] : [],
    confidence: 0.9,
    raw_payload: { rowNumber, source: "openrouter_bank_statement_v1", row },
  };
}

export function normalizeAiBankStatement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      account: { bankName: null, accountNumber: null, accountHolderName: null, ifscCode: null },
      statementPeriodStart: null,
      statementPeriodEnd: null,
      openingBalance: null,
      transactions: [],
      pageResults: [],
    };
  }
  const parsed = value;
  const account = parsed.account && typeof parsed.account === "object" && !Array.isArray(parsed.account)
    ? parsed.account
    : parsed;
  const transactions = Array.isArray(parsed.transactions)
    ? parsed.transactions.flatMap((row, index) => {
        const transaction = normalizeAiTransaction(row, index + 1);
        return transaction ? [transaction] : [];
      })
    : [];

  const openingBalance = parseAmount(
    parsed.openingBalance ??
      parsed.opening_balance ??
      parsed.balanceForward ??
      parsed.balance_forward ??
      parsed.broughtForwardBalance
  );
  const rawPageResults = Array.isArray(parsed.pageResults)
    ? parsed.pageResults
    : Array.isArray(parsed.page_results)
      ? parsed.page_results
      : [];
  const pageResults = rawPageResults.filter((result) =>
    result && typeof result === "object" && !Array.isArray(result)
  );

  return {
    account: {
      bankName: textCell(account.bankName ?? parsed.bankName) || null,
      accountNumber: textCell(account.accountNumber ?? parsed.accountNumber) || null,
      accountHolderName: textCell(account.accountHolderName ?? account.accountName ?? parsed.accountHolderName) || null,
      ifscCode: normalizeIfscCode(textCell(account.ifscCode ?? parsed.ifscCode)) || null,
    },
    statementPeriodStart: parseDate(parsed.statementPeriodStart) ?? parseDate(parsed.periodStart),
    statementPeriodEnd: parseDate(parsed.statementPeriodEnd) ?? parseDate(parsed.periodEnd),
    openingBalance,
    transactions: correctPreviewRowsFromRunningBalance(transactions, openingBalance),
    pageResults,
  };
}

const COUNTERPARTY_PREFIXES = new Set([
  "neft",
  "rtgs",
  "imps",
  "upi",
  "ach",
  "ecs",
  "nach",
  "cr",
  "dr",
  "credit",
  "debit",
  "from",
  "to",
  "by",
  "hdfc",
  "icici",
  "sbi",
  "axis",
  "kotak",
  "idfc",
  "indusind",
  "canara",
  "federal",
  "yes",
]);



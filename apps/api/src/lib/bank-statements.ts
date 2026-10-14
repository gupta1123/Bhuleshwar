import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";

import {
  callOpenRouter,
  getQualityExtractionModel,
  getQualityExtractionReasoning,
} from "./processing/openrouter.ts";

export const BANK_STATEMENT_BUCKET = "bank-statement-files";
const execFileAsync = promisify(execFile);
const BANK_STATEMENT_AI_MAX_PAGES = Number(process.env.BANK_STATEMENT_AI_MAX_PAGES ?? 8);
const BANK_STATEMENT_PDF_RENDER_DPI = Number(process.env.BANK_STATEMENT_PDF_RENDER_DPI ?? 170);
const BANK_STATEMENT_PROVIDER_IMAGE_TARGET_BYTES = Number(
  process.env.BANK_STATEMENT_PROVIDER_IMAGE_TARGET_BYTES ?? 8 * 1024 * 1024
);
const BANK_STATEMENT_PROVIDER_IMAGE_HARD_LIMIT_BYTES = Number(
  process.env.BANK_STATEMENT_PROVIDER_IMAGE_HARD_LIMIT_BYTES ?? 20 * 1024 * 1024
);
const BANK_STATEMENT_PROVIDER_IMAGE_MAX_DIMENSION = Number(
  process.env.BANK_STATEMENT_PROVIDER_IMAGE_MAX_DIMENSION ?? 3200
);

export type BankAccountInput = {
  bankName?: string | null;
  accountNumber?: string | null;
  accountHolderName?: string | null;
  ifscCode?: string | null;
  tallyLedgerName?: string | null;
};

export type ParsedBankTransaction = {
  transactionDate: string;
  valueDate?: string | null;
  description: string;
  referenceNumber?: string | null;
  debitAmount?: number | null;
  creditAmount?: number | null;
  balanceAmount?: number | null;
  transactionType?: string;
  category?: string;
  counterpartyName?: string | null;
  suggestedLedgerName?: string | null;
  suggestionConfidence?: number | null;
  suggestionReason?: string | null;
  confirmedLedgerName?: string | null;
  additionalCharges?: Array<Record<string, unknown>>;
  confidence?: number | null;
  rawPayload?: Record<string, unknown>;
};

export type BankTransactionLedgerRecommendationAction =
  | "use_existing_ledger"
  | "create_new_ledger"
  | "use_standard_ledger"
  | "use_suspense"
  | "needs_review";

export type BankTransactionLedgerRecommendation = {
  action: BankTransactionLedgerRecommendationAction;
  ledgerName: string | null;
  ledgerGroup: string | null;
  confidence: number;
  requiresUserConfirmation: boolean;
  reason: string | null;
};

export type ParsedBankStatement = {
  account: {
    bankName: string | null;
    accountNumber: string | null;
    accountHolderName: string | null;
    ifscCode: string | null;
  };
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  transactions: ParsedBankTransaction[];
};

export type BankStatementExtractionResult = ParsedBankStatement & {
  extractionSource: "csv_text_v1" | "openrouter_bank_statement_v1" | "manual_review_required_v1";
  extractionError?: string | null;
  extractionDiagnostics?: {
    rawAiTransactionCount?: number;
    normalizedAiTransactionCount?: number;
    rejectedAiTransactionCount?: number;
    fallbackParser?: string | null;
  };
};

export type BankAccountRow = {
  id: string;
  bank_name: string | null;
  account_number_normalized: string;
  account_number_masked: string;
  account_holder_name: string | null;
  ifsc_code: string | null;
  tally_ledger_name: string | null;
  last_imported_transaction_at: string | null;
  last_imported_transaction_marker: Record<string, unknown> | null;
  last_tally_posted_transaction_at: string | null;
  created_at: string;
  updated_at: string;
};

export function normalizeAccountNumber(value?: string | null) {
  return String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

export function maskAccountNumber(value?: string | null) {
  const normalized = normalizeAccountNumber(value);
  if (!normalized) return "";
  if (normalized.length <= 4) return normalized;
  return `${"*".repeat(Math.max(0, normalized.length - 4))}${normalized.slice(-4)}`;
}

export function normalizeName(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeIfscCode(value?: string | null) {
  const normalized = String(value ?? "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return normalized.slice(0, 16);
}

function titleCaseName(value: string) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => (part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join(" ");
}

export function normalizeNarrationPattern(value?: string | null) {
  return normalizeName(value)
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/\b[a-z]{2,}\d+[a-z0-9]*\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function cleanCounterpartyCandidate(value?: string | null) {
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

export function extractCounterpartyName(description?: string | null) {
  const raw = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  const patterns = [
    /\b(?:neft|rtgs|imps)\s+(?:receipt\s+)?from\s+(.+?)(?:\s+(?:utr|ref|reference|a\/c|ac|account|ifsc|on)\b|$)/i,
    /\b(?:neft|rtgs|imps)\s+(?:payment\s+)?to\s+(.+?)(?:\s+(?:utr|ref|reference|a\/c|ac|account|ifsc|on)\b|$)/i,
    /\b(?:neft|rtgs|imps)\s+(.+?)(?:\s+(?:utr|ref|reference|a\/c|ac|account|ifsc|on)\b|$)/i,
    /\bupi\s+(?:payment\s+)?to\s+(.+?)(?:\s+(?:upi|ref|reference|txn|transaction|on)\b|$)/i,
    /\bupi\s+(?:receipt\s+)?from\s+(.+?)(?:\s+(?:upi|ref|reference|txn|transaction|on)\b|$)/i,
    /\bupi\s+(.+?)(?:\s+(?:upi|ref|reference|txn|transaction|on)\b|$)/i,
    /\bby\s+transfer\s+from\s+(.+?)(?:\s+(?:ref|reference|on)\b|$)/i,
    /\bto\s+transfer\s+to\s+(.+?)(?:\s+(?:ref|reference|on)\b|$)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const candidate = cleanCounterpartyCandidate(match?.[1]);
    if (candidate && normalizeName(candidate).length >= 3) return titleCaseName(candidate);
  }

  return null;
}

export function parseAmount(value: unknown) {
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

export function parseDate(value: unknown) {
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

  const monthName = raw.match(/^(\d{1,2})[\s-]+([a-zA-Z]{3,9})[\s,-]+(\d{2,4})/);
  if (monthName) {
    const [, day, monthRaw, yearRaw] = monthName;
    const monthIndex = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].findIndex((month) => monthRaw.toLowerCase().startsWith(month));
    if (monthIndex >= 0) {
      const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
      return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function textCell(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function splitCsvLine(line: string, delimiter = ",") {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function splitDelimitedLine(line: string) {
  return splitCsvLine(line, line.includes("|") ? "|" : ",");
}

function detectTransactionType(description: string) {
  const text = description.toLowerCase();
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

function detectCategory(description: string, debitAmount: number | null, creditAmount: number | null) {
  const text = description.toLowerCase();
  if (/\bcharge|charges|fee|gst\b/.test(text)) return "bank_charges";
  if (/\btax|tds|gst\b/.test(text)) return "tax";
  if (/\bsalary|wages\b/.test(text)) return "salary";
  if (/\bloan|emi\b/.test(text)) return "loan_or_emi";
  if (/\bself|own account|internal transfer|transfer to own\b/.test(text)) return "internal_transfer";
  if ((creditAmount ?? 0) > 0) return "receipt";
  if ((debitAmount ?? 0) > 0) return "payment";
  return "unknown";
}

function toMoneyNumber(value?: number | null) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function sameMoney(left: number, right: number) {
  return Math.abs(left - right) < 0.01;
}

function correctTransactionsFromRunningBalance(transactions: ParsedBankTransaction[]) {
  let previousBalance: number | null = null;

  return transactions.map((transaction) => {
    const balance = toMoneyNumber(transaction.balanceAmount);
    const debit = toMoneyNumber(transaction.debitAmount);
    const credit = toMoneyNumber(transaction.creditAmount);
    const amount = Math.max(debit && debit > 0 ? debit : 0, credit && credit > 0 ? credit : 0);
    let next = transaction;

    if (previousBalance !== null && balance !== null && amount > 0) {
      const delta = roundMoney(balance - previousBalance);
      const expectedAmount = roundMoney(Math.abs(delta));
      const hasDirectionMismatch =
        (delta > 0 && (!credit || !sameMoney(credit, expectedAmount) || (debit ?? 0) > 0)) ||
        (delta < 0 && (!debit || !sameMoney(debit, expectedAmount) || (credit ?? 0) > 0));

      if (!sameMoney(delta, 0) && sameMoney(expectedAmount, amount) && hasDirectionMismatch) {
        const correctedDebit = delta < 0 ? expectedAmount : null;
        const correctedCredit = delta > 0 ? expectedAmount : null;
        next = {
          ...transaction,
          debitAmount: correctedDebit,
          creditAmount: correctedCredit,
          category: detectCategory(transaction.description, correctedDebit, correctedCredit),
          confidence: Math.max(transaction.confidence ?? 0, 0.9),
          rawPayload: {
            ...(transaction.rawPayload ?? {}),
            balanceCorrection: {
              previousBalance,
              balanceAmount: balance,
              delta,
              originalDebitAmount: debit,
              originalCreditAmount: credit,
            },
          },
        };
      }
    }

    if (balance !== null) previousBalance = balance;
    return next;
  });
}

function detectDebitCreditMarker(row: Record<string, string>) {
  const marker = readColumn(row, [
    "dr cr",
    "dr/cr",
    "debit credit",
    "debit/credit",
    "transaction type",
    "type",
  ]).toLowerCase();
  if (/\bdr\b|debit|withdrawal|paid\s*out/.test(marker)) return "debit";
  if (/\bcr\b|credit|deposit|paid\s*in/.test(marker)) return "credit";
  return "";
}

function splitSignedAmount(row: Record<string, string>) {
  const amount = parseAmount(readColumn(row, ["amount", "transaction amount", "txn amount"]));
  if (amount === null) return { debitAmount: null, creditAmount: null };

  const marker = detectDebitCreditMarker(row);
  if (marker === "debit") return { debitAmount: Math.abs(amount), creditAmount: null };
  if (marker === "credit") return { debitAmount: null, creditAmount: Math.abs(amount) };
  if (amount < 0) return { debitAmount: Math.abs(amount), creditAmount: null };
  return { debitAmount: null, creditAmount: amount };
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    const trimmed = raw.trim();
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    const useArray =
      arrayStart >= 0 &&
      arrayEnd > arrayStart &&
      (objectStart < 0 || arrayStart < objectStart);
    const jsonString = useArray
      ? trimmed.slice(arrayStart, arrayEnd + 1)
      : objectStart >= 0 && objectEnd > objectStart
        ? trimmed.slice(objectStart, objectEnd + 1)
        : trimmed;
    return JSON.parse(jsonString) as T;
  } catch {
    return fallback;
  }
}

function compactPromptJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function clampConfidence(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function readAiRecommendationAction(value: unknown): BankTransactionLedgerRecommendationAction {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "use_existing_ledger" ||
    normalized === "create_new_ledger" ||
    normalized === "use_standard_ledger" ||
    normalized === "use_suspense" ||
    normalized === "needs_review"
  ) {
    return normalized;
  }
  return "needs_review";
}

function titleCaseLedgerName(value: string) {
  return titleCaseName(value.replace(/\s+/g, " ").trim());
}

function normalizeLedgerKey(value?: string | null) {
  return normalizeName(value).replace(/[^a-z0-9]/g, "");
}

function findProvidedLedger(ledgerNames: string[], value?: string | null) {
  const normalized = normalizeLedgerKey(value);
  if (!normalized) return null;
  return ledgerNames.find((ledgerName) => normalizeLedgerKey(ledgerName) === normalized) ?? null;
}

function normalizeLedgerRecommendation(
  value: unknown,
  transaction: ParsedBankTransaction,
  ledgerNames: string[]
): BankTransactionLedgerRecommendation {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  let action = readAiRecommendationAction(row.recommendedAction ?? row.action);
  const rawLedgerName = readLooseText(row, ["recommendedLedgerName", "ledgerName", "targetLedgerName"]);
  const rawLedgerGroup = readLooseText(row, ["recommendedLedgerGroup", "ledgerGroup", "parentGroup"]);
  const reason = readLooseText(row, ["reason", "explanation"]) || null;
  const confidence = clampConfidence(row.confidence);
  const existingLedger = findProvidedLedger(ledgerNames, rawLedgerName);
  const suspenseLedger = findProvidedLedger(ledgerNames, "Suspense");

  if (action === "use_existing_ledger" || action === "use_standard_ledger") {
    if (existingLedger) {
      return {
        action,
        ledgerName: existingLedger,
        ledgerGroup: null,
        confidence: Math.max(confidence, 0.75),
        requiresUserConfirmation: confidence < 0.85,
        reason,
      };
    }
    action = "needs_review";
  }

  if (action === "use_suspense") {
    return {
      action: suspenseLedger ? "use_suspense" : "needs_review",
      ledgerName: suspenseLedger,
      ledgerGroup: null,
      confidence,
      requiresUserConfirmation: true,
      reason: reason || (suspenseLedger ? "AI recommended suspense for an unclear transaction." : "Suspense ledger is not synced."),
    };
  }

  if (action === "create_new_ledger") {
    const fallbackName = transaction.counterpartyName || rawLedgerName || extractCounterpartyName(transaction.description);
    const ledgerName = titleCaseLedgerName(rawLedgerName || fallbackName || "");
    const debit = Number(transaction.debitAmount ?? 0) || 0;
    const credit = Number(transaction.creditAmount ?? 0) || 0;
    const fallbackGroup = credit > 0 && debit <= 0 ? "Sundry Debtors" : "Sundry Creditors";

    if (ledgerName) {
      return {
        action: "create_new_ledger",
        ledgerName,
        ledgerGroup: rawLedgerGroup || fallbackGroup,
        confidence,
        requiresUserConfirmation: true,
        reason,
      };
    }
  }

  return {
    action: "needs_review",
    ledgerName: rawLedgerName || transaction.counterpartyName || null,
    ledgerGroup: rawLedgerGroup || null,
    confidence,
    requiresUserConfirmation: true,
    reason: reason || "AI could not safely choose an accounting action.",
  };
}

export async function classifyBankTransactionsForTallyWithAI(params: {
  account: ParsedBankStatement["account"];
  transactions: ParsedBankTransaction[];
  tallyLedgerNames: string[];
  businessName?: string | null;
}) {
  if (params.transactions.length === 0) return params.transactions;

  const ledgerNames = Array.from(new Set(params.tallyLedgerNames.filter(Boolean))).slice(0, 1000);
  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content:
          "You are classifying Indian business bank statement transactions for Tally Prime accounting. Return only valid JSON. " +
          "Do not invent existing ledgers. You may use an existing ledger only if it appears in the provided tallyLedgerNames list, matching case-insensitively. " +
          "Before recommending suspense, compare the counterpartyName and description against tallyLedgerNames for normal Indian bank narration variations: spelling mistakes, missing spaces, joined words, singular/plural, legal suffixes (Pvt, Private, Ltd, Limited, LLP), generic suffixes (Enterprise, Enterprises, Company, Co, Traders, Trading), trailing initials, and abbreviations such as Co/Company, Ind/Industries, Engrs/Engg/Engineers/Engineering, Mech/Mechanical, Supply/Supplies/Supplier. " +
          "Examples: 'Quali Mech Engrs' should match a provided ledger named 'QUALIMECH ENGINEERS'; 'Maharaj Industires' should match 'Maharaj Industries'; 'Office Supply CO' should match 'Office Supplies'; 'Pushpak Steels IND' should match 'Pushpak Steel Industries'; 'Raja Guru Enterprises' should match 'RAJAGURU R' when that is the only clear Rajaguru ledger. " +
          "If exactly one provided Tally ledger is the clear party match, recommend use_existing_ledger with that exact ledger name and confidence at least 0.90. " +
          "If two or more provided ledgers are plausible party matches, recommend use_suspense when a Suspense ledger exists. " +
          "For a named customer/vendor/business party with no clear existing ledger, recommend use_suspense when a Suspense ledger exists; do not recommend creating a new party ledger during import. " +
          "For bank charges, fees, GST on bank charges, interest, cash withdrawal/deposit, tax, TDS, GST, salary, or other standard categories, prefer an existing standard ledger from tallyLedgerNames when present. " +
          "Do not create a party ledger for bank charges, tax, GST, TDS, interest, cash, salary, or internal bank transfers. " +
          "Use needs_review when the data is insufficient or risky and no safe Suspense ledger is available. " +
          "Using suspense or any confidence below 0.85 must set requiresUserConfirmation true. " +
          "Allowed recommendedAction values: use_existing_ledger, create_new_ledger, use_standard_ledger, use_suspense, needs_review. " +
          "Allowed create_new_ledger groups: Sundry Debtors, Sundry Creditors, Indirect Expenses, Indirect Incomes, Duties & Taxes, Cash-in-Hand. " +
          "Return JSON shape: {\"recommendations\":[{\"index\":0,\"counterpartyName\":\"...\",\"transactionNature\":\"customer_receipt|vendor_payment|bank_charge|interest|tax|cash|transfer|unknown\",\"recommendedAction\":\"...\",\"recommendedLedgerName\":\"...\",\"recommendedLedgerGroup\":\"...\",\"confidence\":0.0,\"requiresUserConfirmation\":true,\"reason\":\"short reason\"}]}.",
      },
      {
        role: "user",
        content:
          "Classify these transactions for Tally posting.\n" +
          compactPromptJson({
            businessName: params.businessName ?? params.account.accountHolderName ?? null,
            statementAccount: params.account,
            tallyLedgerNames: ledgerNames,
            transactions: params.transactions.map((transaction, index) => ({
              index,
              transactionDate: transaction.transactionDate,
              description: transaction.description,
              referenceNumber: transaction.referenceNumber,
              debitAmount: transaction.debitAmount,
              creditAmount: transaction.creditAmount,
              transactionType: transaction.transactionType,
              category: transaction.category,
              counterpartyName: transaction.counterpartyName,
            })),
          }),
      },
    ],
    {
      expectJson: true,
      jsonMode: true,
      model: getQualityExtractionModel(),
      reasoning: getQualityExtractionReasoning(),
      maxTokens: 8192,
    }
  );

  const parsed = safeJsonParse<{ recommendations?: unknown }>(raw, {});
  const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  const byIndex = new Map<number, unknown>();
  for (const recommendation of recommendations) {
    if (!recommendation || typeof recommendation !== "object" || Array.isArray(recommendation)) continue;
    const index = Number((recommendation as Record<string, unknown>).index);
    if (Number.isInteger(index)) byIndex.set(index, recommendation);
  }

  return params.transactions.map((transaction, index) => {
    const recommendation = normalizeLedgerRecommendation(byIndex.get(index), transaction, ledgerNames);
    return {
      ...transaction,
      counterpartyName: transaction.counterpartyName || extractCounterpartyName(transaction.description),
      suggestedLedgerName: recommendation.ledgerName,
      suggestionConfidence: recommendation.confidence,
      suggestionReason: recommendation.reason,
      rawPayload: {
        ...(transaction.rawPayload ?? {}),
        aiLedgerRecommendation: recommendation,
      },
    };
  });
}

function readColumn(row: Record<string, string>, aliases: string[]) {
  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const match = Object.entries(row).find(([key]) => normalizeHeader(key) === normalizedAlias);
    if (match) return match[1];
  }
  return "";
}

function parseCsvTransactions(text: string): ParsedBankTransaction[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) => {
    const normalized = splitDelimitedLine(line).map(normalizeHeader);
    return (
      normalized.some((value) => ["date", "transactiondate", "txndate", "postingdate", "valuedate"].includes(value)) &&
      normalized.some((value) => ["description", "narration", "particulars", "remarks"].includes(value))
    );
  });

  if (headerIndex < 0) return [];

  const headers = splitDelimitedLine(lines[headerIndex]);
  return lines.slice(headerIndex + 1).flatMap((line, index) => {
    const cells = splitDelimitedLine(line);
    const row = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] ?? ""]));
    const transactionDate = parseDate(
      readColumn(row, ["transactionDate", "date", "txn date", "posting date"])
    );
    const description = textCell(
      readColumn(row, ["description", "narration", "particulars", "remarks", "transaction remarks"])
    );
    if (!transactionDate || !description) return [];

    const splitAmount = splitSignedAmount(row);
    const debitAmount =
      parseAmount(readColumn(row, ["debit", "withdrawal", "withdrawals", "paid out", "dr"])) ??
      splitAmount.debitAmount;
    const creditAmount =
      parseAmount(readColumn(row, ["credit", "deposit", "deposits", "paid in", "cr"])) ??
      splitAmount.creditAmount;
    const balanceAmount = parseAmount(readColumn(row, ["balance", "closing balance", "running balance"]));
    const transactionType = detectTransactionType(description);
    const category = detectCategory(description, debitAmount, creditAmount);
    const counterpartyName = extractCounterpartyName(description);

    return [
      {
        transactionDate,
        valueDate: parseDate(readColumn(row, ["valueDate", "value date"])) ?? transactionDate,
        description,
        referenceNumber: textCell(readColumn(row, ["reference", "ref", "utr", "cheque no", "instrument no"])) || null,
        debitAmount,
        creditAmount,
        balanceAmount,
        transactionType,
        category,
        counterpartyName,
        additionalCharges: transactionType === "bank_charge" ? [{ type: "bank_charge", amount: debitAmount }] : [],
        confidence: 0.72,
        rawPayload: { rowNumber: headerIndex + index + 2, row },
      },
    ];
  });
}

function extractLabeledValue(text: string, labels: string[]) {
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?:^|\\|)\\s*(?:${escapedLabels})\\s*:\\s*([^|\\n\\r]*)`, "i");
  return text.match(pattern)?.[1]?.trim() ?? "";
}

function parseLabeledTransactionBlocks(text: string): ParsedBankTransaction[] {
  const blocks = text
    .split(/\bTransaction\s+\d+\b/i)
    .slice(1)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.flatMap((block, index) => {
    const transactionDate = parseDate(extractLabeledValue(block, ["Date", "Txn Date", "Transaction Date", "Posting Date"]));
    const description = textCell(extractLabeledValue(block, ["Description", "Narration", "Particulars", "Remarks"]));
    if (!transactionDate || !description) return [];

    const debitAmount = parseAmount(extractLabeledValue(block, ["Debit", "Withdrawal", "Withdrawals", "Paid Out", "Dr"]));
    const creditAmount = parseAmount(extractLabeledValue(block, ["Credit", "Deposit", "Deposits", "Paid In", "Cr"]));
    const balanceAmount = parseAmount(extractLabeledValue(block, ["Balance", "Running Balance", "Closing Balance"]));
    const transactionType = detectTransactionType(description);
    const category = detectCategory(description, debitAmount, creditAmount);
    const counterpartyName = extractCounterpartyName(description);

    return [
      {
        transactionDate,
        valueDate: parseDate(extractLabeledValue(block, ["Value Date"])) ?? transactionDate,
        description,
        referenceNumber: textCell(
          extractLabeledValue(block, ["Reference", "Ref", "Ref No", "UTR", "Cheque No", "Instrument No"])
        ) || null,
        debitAmount,
        creditAmount,
        balanceAmount,
        transactionType,
        category,
        counterpartyName,
        additionalCharges: transactionType === "bank_charge" ? [{ type: "bank_charge", amount: debitAmount }] : [],
        confidence: 0.82,
        rawPayload: { rowNumber: index + 1, source: "labeled_text_block_v1", block },
      },
    ];
  });
}

function normalizeStatementLineDescription(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/\bPage\s+\d+\s+of\s+\d+\b.*$/i, "")
    .trim();
}

function parseFixedWidthPdfTransactions(text: string): ParsedBankTransaction[] {
  const rawLines = text.split(/\r?\n/);
  const headerLine = rawLines.find((line) => /\bDeposit\b/i.test(line) && /\bWithdrawal\b/i.test(line) && /\bBalance\b/i.test(line));
  const depositColumn = headerLine?.search(/\bDeposit\b/i) ?? -1;
  const withdrawalColumn = headerLine?.search(/\bWithdrawal\b/i) ?? -1;
  const amountPattern = /\b\d{1,3}(?:,\d{3})*\.\d{2}\b|\b\d+\.\d{2}\b/g;
  const transactions: ParsedBankTransaction[] = [];
  let currentTransaction: ParsedBankTransaction | null = null;
  let currentDate: string | null = null;
  let currentValueDate: string | null = null;

  function finishCurrent() {
    if (!currentTransaction) return;
    currentTransaction.description = normalizeStatementLineDescription(currentTransaction.description);
    if (
      currentTransaction.description &&
      !/\bbalance\s+forward\b/i.test(currentTransaction.description) &&
      !/\btotal\b/i.test(currentTransaction.description)
    ) {
      transactions.push(currentTransaction);
    }
    currentTransaction = null;
  }

  for (const rawLine of rawLines) {
    if (!rawLine.trim()) continue;
    if (/\b(?:Date|Value\s+Date|Description|Cheque|Deposit|Withdrawal|Balance)\b/i.test(rawLine) && !/\d{1,3}(?:,\d{3})*\.\d{2}/.test(rawLine)) {
      continue;
    }
    if (/\b(?:reward points statement|scheme|opening balance|points accrued|points redeemed|closing balance)\b/i.test(rawLine)) {
      finishCurrent();
      continue;
    }
    if (/^\s*Page\s+\d+\s+of\s+\d+\b/i.test(rawLine)) {
      finishCurrent();
      continue;
    }

    let line = rawLine;
    const dated = line.match(/^\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})(?:\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}))?\s*(.*)$/);
    if (dated) {
      const parsedDate = parseDate(dated[1]);
      const parsedValueDate = parseDate(dated[2]) ?? parsedDate;
      if (parsedDate) currentDate = parsedDate;
      if (parsedValueDate) currentValueDate = parsedValueDate;
      line = dated[3] ?? "";
    }

    const amountMatches = [...line.matchAll(amountPattern)].map((match) => ({
      value: match[0],
      index: match.index ?? 0,
    }));
    const hasRunningBalance = amountMatches.length >= 2;
    if (hasRunningBalance && currentDate) {
      finishCurrent();
      const balanceMatch = amountMatches[amountMatches.length - 1];
      const amountMatch = amountMatches[amountMatches.length - 2];
      const amount = parseAmount(amountMatch.value);
      const balanceAmount = parseAmount(balanceMatch.value);
      if (amount === null) continue;

      const description = normalizeStatementLineDescription(line.slice(0, amountMatch.index));
      const isCredit =
        depositColumn >= 0 &&
        withdrawalColumn >= 0 &&
        amountMatch.index < withdrawalColumn - 2;
      const debitAmount = isCredit ? null : amount;
      const creditAmount = isCredit ? amount : null;
      const transactionType = detectTransactionType(description);
      const category = detectCategory(description, debitAmount, creditAmount);

      currentTransaction = {
        transactionDate: currentDate,
        valueDate: currentValueDate ?? currentDate,
        description,
        referenceNumber: null,
        debitAmount,
        creditAmount,
        balanceAmount,
        transactionType,
        category,
        counterpartyName: extractCounterpartyName(description),
        additionalCharges: transactionType === "bank_charge" ? [{ type: "bank_charge", amount: debitAmount }] : [],
        confidence: 0.7,
        rawPayload: {
          source: "fixed_width_pdf_text_v1",
          line: rawLine,
        },
      };
      continue;
    }

    const continuation = normalizeStatementLineDescription(line);
    if (currentTransaction && continuation && !/\bBank deposits are covered\b/i.test(continuation)) {
      currentTransaction.description = `${currentTransaction.description} ${continuation}`;
      currentTransaction.transactionType = detectTransactionType(currentTransaction.description);
      currentTransaction.category = detectCategory(
        currentTransaction.description,
        currentTransaction.debitAmount ?? null,
        currentTransaction.creditAmount ?? null
      );
      currentTransaction.counterpartyName = extractCounterpartyName(currentTransaction.description);
    }
  }

  finishCurrent();
  return transactions;
}

function extractFirst(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractAccountNumber(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const statementAccountMatch = line.match(
      /\baccount\s*:\s*[a-z][a-z .&'-]{1,80}?\s*[-:]\s*([a-z0-9x* -]{6,32})\b/i
    );
    const statementAccountCandidate = normalizeAccountNumber(statementAccountMatch?.[1]);
    if (statementAccountCandidate) return statementAccountCandidate;

    const match = line.match(/\b(?:account\s*(?:no\.?|number)|a\/c\s*(?:no\.?|number)?)\s*[:\-]?\s*([A-Z0-9X* -]{6,32})\b/i);
    const candidate = normalizeAccountNumber(match?.[1]);
    if (candidate) return candidate;
  }

  const compact = text.replace(/\s+/g, " ").trim();
  const labeled = extractFirst(compact, [
    /account\s*(?:no\.?|number)\s*[:\-]?\s*([A-Z0-9X* -]{6,32})(?=\s+(?:account\s+type|branch|currency|customer|ifsc|micr|nominee|statement|phone)\b|$)/i,
    /a\/c\s*(?:no\.?|number)?\s*[:\-]?\s*([A-Z0-9X* -]{6,32})(?=\s+(?:account\s+type|branch|currency|customer|ifsc|micr|nominee|statement|phone)\b|$)/i,
  ]);
  return normalizeAccountNumber(labeled) || "";
}

export function parseBankStatementText(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  const accountNumber = extractAccountNumber(text);
  const accountHolderName = extractFirst(compact, [
    /account\s*(?:holder|name)\s*[:\-]?\s*([A-Z][A-Z0-9 .&'-]{2,80})/i,
    /customer\s*name\s*[:\-]?\s*([A-Z][A-Z0-9 .&'-]{2,80})/i,
  ]);
  const bankName = extractFirst(compact, [
    /\b([A-Z][A-Z &]{2,40}\s+BANK)\b/i,
    /bank\s*name\s*[:\-]?\s*([A-Z][A-Z0-9 .&'-]{2,80})/i,
  ]);
  const ifscCode = extractFirst(compact, [
    /\bifsc\s*(?:code)?\s*[:\-]?\s*([A-Z]{4}0[A-Z0-9]{6})\b/i,
    /\b([A-Z]{4}0[A-Z0-9]{6})\b/i,
  ]);
  const period = compact.match(/(?:statement\s*)?period\s*[:\-]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s*(?:to|-)\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
  const tableTransactions = parseCsvTransactions(text);
  const labeledTransactions = tableTransactions.length > 0 ? [] : parseLabeledTransactionBlocks(text);
  const fixedWidthTransactions =
    tableTransactions.length > 0 || labeledTransactions.length > 0
      ? []
      : parseFixedWidthPdfTransactions(text);

  return {
    account: {
      bankName: bankName || null,
      accountNumber: accountNumber || null,
      accountHolderName: accountHolderName || null,
      ifscCode: normalizeIfscCode(ifscCode) || null,
    },
    statementPeriodStart: parseDate(period?.[1]) ?? null,
    statementPeriodEnd: parseDate(period?.[2]) ?? null,
    transactions: correctTransactionsFromRunningBalance(
      tableTransactions.concat(labeledTransactions).concat(fixedWidthTransactions)
    ),
  };
}

function emptyParsedBankStatement(): ParsedBankStatement {
  return {
    account: { bankName: null, accountNumber: null, accountHolderName: null, ifscCode: null },
    statementPeriodStart: null,
    statementPeriodEnd: null,
    transactions: [],
  };
}

function mergeBankStatementMetadata(
  primary: ParsedBankStatement,
  fallback: ParsedBankStatement
): ParsedBankStatement {
  return {
    ...primary,
    account: {
      bankName: primary.account.bankName || fallback.account.bankName,
      accountNumber: primary.account.accountNumber || fallback.account.accountNumber,
      accountHolderName: primary.account.accountHolderName || fallback.account.accountHolderName,
      ifscCode: primary.account.ifscCode || fallback.account.ifscCode,
    },
    statementPeriodStart: primary.statementPeriodStart || fallback.statementPeriodStart,
    statementPeriodEnd: primary.statementPeriodEnd || fallback.statementPeriodEnd,
  };
}

function normalizeImageMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  if (lower.startsWith("image/")) return lower;
  return "image/jpeg";
}

function isProviderSafeImageMimeType(mimeType: string) {
  return ["image/jpeg", "image/png", "image/webp"].includes(normalizeImageMimeType(mimeType));
}

function bufferToDataUrl(buffer: Buffer, mimeType: string) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function renderedPageNumber(fileName: string) {
  const match = fileName.match(/-(\d+)\.png$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function imageBytesToProviderDataUrl(data: Uint8Array, mimeType: string, label: string) {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  const input = Buffer.from(data);
  if (input.byteLength <= BANK_STATEMENT_PROVIDER_IMAGE_TARGET_BYTES && isProviderSafeImageMimeType(normalizedMimeType)) {
    return bufferToDataUrl(input, normalizedMimeType);
  }

  let smallest: Buffer | null = null;
  let lastError: unknown = null;
  for (const dimension of [BANK_STATEMENT_PROVIDER_IMAGE_MAX_DIMENSION, 2800, 2400, 2000, 1600, 1200]) {
    for (const quality of [86, 80, 74, 68, 62, 56]) {
      try {
        const output = await sharp(input, { failOn: "none" })
          .rotate()
          .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality, progressive: true, force: true })
          .toBuffer();
        if (!smallest || output.byteLength < smallest.byteLength) smallest = output;
        if (output.byteLength <= BANK_STATEMENT_PROVIDER_IMAGE_TARGET_BYTES) {
          return bufferToDataUrl(output, "image/jpeg");
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (smallest && smallest.byteLength <= BANK_STATEMENT_PROVIDER_IMAGE_HARD_LIMIT_BYTES) {
    return bufferToDataUrl(smallest, "image/jpeg");
  }
  if (input.byteLength <= BANK_STATEMENT_PROVIDER_IMAGE_HARD_LIMIT_BYTES && isProviderSafeImageMimeType(normalizedMimeType)) {
    return bufferToDataUrl(input, normalizedMimeType);
  }

  const reason = lastError instanceof Error ? lastError.message : "image remained above provider limit";
  throw new Error(`Unable to prepare "${label}" for bank statement extraction: ${reason}`);
}

async function renderBankStatementPdfToImages(data: Uint8Array, sourceName: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-statement-pdf-"));
  const inputPath = path.join(tmpDir, "input.pdf");
  const outputPrefix = path.join(tmpDir, "page");

  try {
    fs.writeFileSync(inputPath, Buffer.from(data));
    await execFileAsync("pdftoppm", [
      "-r",
      String(BANK_STATEMENT_PDF_RENDER_DPI),
      "-png",
      "-f",
      "1",
      "-l",
      String(BANK_STATEMENT_AI_MAX_PAGES),
      inputPath,
      outputPrefix,
    ]);

    const pageFileNames = fs
      .readdirSync(tmpDir)
      .filter((fileName) => fileName.startsWith("page-") && fileName.endsWith(".png"))
      .sort((left, right) => renderedPageNumber(left) - renderedPageNumber(right));

    const images: string[] = [];
    for (const fileName of pageFileNames) {
      const bytes = fs.readFileSync(path.join(tmpDir, fileName));
      images.push(await imageBytesToProviderDataUrl(bytes, "image/png", `${sourceName} ${fileName}`));
    }
    return images;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function extractBankStatementPdfText(data: Uint8Array) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-statement-pdf-text-"));
  const inputPath = path.join(tmpDir, "input.pdf");

  try {
    fs.writeFileSync(inputPath, Buffer.from(data));
    const { stdout } = await execFileAsync("pdftotext", ["-layout", inputPath, "-"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return "";
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readLooseField(row: Record<string, unknown>, aliases: string[]) {
  const aliasSet = new Set(aliases.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (aliasSet.has(normalizeHeader(key))) {
      return value;
    }
  }
  return undefined;
}

function readLooseText(row: Record<string, unknown>, aliases: string[]) {
  return textCell(readLooseField(row, aliases));
}

function readLooseNarration(row: Record<string, unknown>) {
  return readLooseText(row, [
    "fullNarration",
    "full narration",
    "bankNarration",
    "bank narration",
    "transactionNarration",
    "transaction narration",
    "description",
    "narration",
    "particulars",
    "remarks",
    "details",
    "transactionDetails",
    "transaction details",
    "transactionDescription",
    "transaction description",
    "rawLine",
    "raw line",
  ]);
}

function readLooseAmount(row: Record<string, unknown>, aliases: string[]) {
  return parseAmount(readLooseField(row, aliases));
}

function readLooseDate(row: Record<string, unknown>, aliases: string[]) {
  return parseDate(readLooseField(row, aliases));
}

function splitLooseSignedAmount(row: Record<string, unknown>) {
  const amount = readLooseAmount(row, [
    "amount",
    "transactionAmount",
    "transaction amount",
    "txn amount",
    "value",
  ]);
  if (amount === null) return { debitAmount: null, creditAmount: null };

  const marker = readLooseText(row, [
    "dr cr",
    "dr/cr",
    "debit credit",
    "debit/credit",
    "transaction type",
    "type",
    "amount type",
  ]).toLowerCase();
  if (/\bdr\b|debit|withdrawal|paid\s*out/.test(marker)) {
    return { debitAmount: Math.abs(amount), creditAmount: null };
  }
  if (/\bcr\b|credit|deposit|paid\s*in/.test(marker)) {
    return { debitAmount: null, creditAmount: Math.abs(amount) };
  }
  if (amount < 0) return { debitAmount: Math.abs(amount), creditAmount: null };
  return { debitAmount: null, creditAmount: amount };
}

function normalizeAiTransaction(value: unknown, rowNumber: number): ParsedBankTransaction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const transactionDate = readLooseDate(row, [
    "transactionDate",
    "transaction date",
    "date",
    "txnDate",
    "txn date",
    "postingDate",
    "posting date",
    "post date",
  ]);
  const description = readLooseNarration(row) || `Transaction ${rowNumber}`;
  const splitAmount = splitLooseSignedAmount(row);
  const debitAmount =
    readLooseAmount(row, [
      "debitAmount",
      "debit amount",
      "debit",
      "withdrawal",
      "withdrawals",
      "withdrawalAmount",
      "withdrawal amount",
      "paidOut",
      "paid out",
      "amountDebited",
      "amount debited",
      "dr",
    ]) ?? splitAmount.debitAmount;
  const creditAmount =
    readLooseAmount(row, [
      "creditAmount",
      "credit amount",
      "credit",
      "deposit",
      "deposits",
      "depositAmount",
      "deposit amount",
      "paidIn",
      "paid in",
      "amountCredited",
      "amount credited",
      "cr",
    ]) ?? splitAmount.creditAmount;
  const balanceAmount = readLooseAmount(row, [
    "balanceAmount",
    "balance amount",
    "balance",
    "runningBalance",
    "running balance",
    "closingBalance",
    "closing balance",
  ]);
  const hasAmount = debitAmount !== null || creditAmount !== null || balanceAmount !== null;
  if (!transactionDate || !hasAmount) return null;

  const transactionType = readLooseText(row, ["transactionType", "transaction type", "type"]) || detectTransactionType(description);
  const category = readLooseText(row, ["category"]) || detectCategory(description, debitAmount, creditAmount);
  const rawCounterpartyName = readLooseText(row, ["counterpartyName", "counterparty name", "counterparty", "party"]);
  const cleanedCounterpartyName = cleanCounterpartyCandidate(rawCounterpartyName);
  const counterpartyName =
    (cleanedCounterpartyName && normalizeName(cleanedCounterpartyName).length >= 3
      ? titleCaseName(cleanedCounterpartyName)
      : null) || extractCounterpartyName(description);

  return {
    transactionDate,
    valueDate: readLooseDate(row, ["valueDate", "value date"]) ?? transactionDate,
    description,
    referenceNumber:
      readLooseText(row, [
        "referenceNumber",
        "reference number",
        "reference",
        "ref",
        "utr",
        "chequeNumber",
        "cheque number",
        "chequeNo",
        "cheque no",
        "instrumentNo",
        "instrument no",
      ]) || null,
    debitAmount,
    creditAmount,
    balanceAmount,
    transactionType,
    category,
    counterpartyName,
    additionalCharges: transactionType === "bank_charge" ? [{ type: "bank_charge", amount: debitAmount }] : [],
    confidence:
      typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? Math.max(0, Math.min(1, row.confidence))
        : 0.78,
    rawPayload: { rowNumber, source: "openrouter_bank_statement_v1", row },
  };
}

function collectAiTransactions(parsed: Record<string, unknown>) {
  for (const key of ["transactions", "transactionRows", "transaction rows", "rows", "entries", "statementRows"]) {
    const value = readLooseField(parsed, [key]);
    if (Array.isArray(value)) return value;
  }
  const table = readLooseField(parsed, ["table", "statementTable", "statement table"]);
  if (table && typeof table === "object" && !Array.isArray(table)) {
    const rows = readLooseField(table as Record<string, unknown>, ["rows", "transactions", "entries"]);
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

function normalizeAiBankStatement(value: unknown): ParsedBankStatement & {
  diagnostics: NonNullable<BankStatementExtractionResult["extractionDiagnostics"]>;
} {
  if (Array.isArray(value)) {
    const transactions = correctTransactionsFromRunningBalance(value.flatMap((row, index) => {
      const transaction = normalizeAiTransaction(row, index + 1);
      return transaction ? [transaction] : [];
    }));
    return {
      ...emptyParsedBankStatement(),
      transactions,
      diagnostics: {
        rawAiTransactionCount: value.length,
        normalizedAiTransactionCount: transactions.length,
        rejectedAiTransactionCount: Math.max(0, value.length - transactions.length),
      },
    };
  }
  if (!value || typeof value !== "object") {
    return { ...emptyParsedBankStatement(), diagnostics: { rawAiTransactionCount: 0, normalizedAiTransactionCount: 0, rejectedAiTransactionCount: 0 } };
  }
  const parsed = value as Record<string, unknown>;
  const account = parsed.account && typeof parsed.account === "object" && !Array.isArray(parsed.account)
    ? (parsed.account as Record<string, unknown>)
    : parsed;
  const rawTransactions = collectAiTransactions(parsed);
  const transactions = correctTransactionsFromRunningBalance(rawTransactions.flatMap((row, index) => {
        const transaction = normalizeAiTransaction(row, index + 1);
        return transaction ? [transaction] : [];
      }));

  return {
    account: {
      bankName: readLooseText(account, ["bankName", "bank name", "bank"]) || readLooseText(parsed, ["bankName", "bank name", "bank"]) || null,
      accountNumber: readLooseText(account, ["accountNumber", "account number", "accountNo", "account no", "account no."]) || readLooseText(parsed, ["accountNumber", "account number", "accountNo", "account no", "account no."]) || null,
      accountHolderName:
        readLooseText(account, ["accountHolderName", "account holder name", "accountName", "account name", "customerName", "customer name", "holder"]) ||
        readLooseText(parsed, ["accountHolderName", "account holder name", "accountName", "account name", "customerName", "customer name", "holder"]) ||
        null,
      ifscCode: normalizeIfscCode(readLooseText(account, ["ifscCode", "ifsc code", "ifsc"]) || readLooseText(parsed, ["ifscCode", "ifsc code", "ifsc"])) || null,
    },
    statementPeriodStart: readLooseDate(parsed, ["statementPeriodStart", "statement period start", "periodStart", "period start", "fromDate", "from date"]),
    statementPeriodEnd: readLooseDate(parsed, ["statementPeriodEnd", "statement period end", "periodEnd", "period end", "toDate", "to date"]),
    transactions,
    diagnostics: {
      rawAiTransactionCount: rawTransactions.length,
      normalizedAiTransactionCount: transactions.length,
      rejectedAiTransactionCount: Math.max(0, rawTransactions.length - transactions.length),
    },
  };
}

async function extractBankStatementFromImages(params: {
  fileName: string;
  images: string[];
  textHint?: string;
  repairMode?: boolean;
}): Promise<ParsedBankStatement & {
  diagnostics: NonNullable<BankStatementExtractionResult["extractionDiagnostics"]>;
}> {
  if (params.images.length === 0) {
    return {
      ...emptyParsedBankStatement(),
      diagnostics: {
        rawAiTransactionCount: 0,
        normalizedAiTransactionCount: 0,
        rejectedAiTransactionCount: 0,
      },
    };
  }

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content:
          "Extract bank statement account details and transaction rows. Return only JSON with keys account, statementPeriodStart, statementPeriodEnd, and transactions. " +
          "account must include bankName, accountNumber, accountHolderName, and ifscCode when visible. Dates must be ISO YYYY-MM-DD. " +
          "Each transaction must include transactionDate, valueDate when visible, description, referenceNumber when visible, debitAmount, creditAmount, balanceAmount, transactionType, category, counterpartyName, confidence, and rawLine. " +
          "description must be the complete bank narration/description exactly as printed for that transaction, including payment mode, party name, UTR/reference text, and continuation lines. Do not shorten description to only the party name, and do not include date/value-date/debit/credit/balance columns in description. " +
          "counterpartyName must be only the real party/vendor/customer name, separate from the full description. Remove payment modes, bank/channel prefixes, CR/DR markers, account numbers, UTR/ref/invoice/bill text, and bank names from counterpartyName. For example, description NEFT CR-HDFC-BHARAT LTD / INVOICE BL-801 should produce counterpartyName BHARAT LTD; UPI/9188201001/ORION TOOLING CENTRE should produce ORION TOOLING CENTRE. Use numbers for amounts, with debit and credit as positive values in their own columns. Do not invent rows. Preserve narration text exactly enough for audit matching. " +
          "Merge wrapped narration lines into the preceding transaction row. Ignore balance-forward, subtotal, total, reward-points, and footer rows. If a page contains only summary information and no ledger rows, extract account/period only and leave transactions empty. " +
          (params.repairMode
            ? "Repair mode: a previous pass found no usable rows. Treat the visible fixed-width or tabular bank statement as authoritative and extract every ledger transaction row you can see."
            : ""),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Extract bank statement data from ${params.fileName}. ` +
              (params.textHint ? `Embedded text hint:\n${params.textHint.slice(0, 12000)}` : ""),
          },
          ...params.images.map((image) => ({ type: "image_url" as const, image_url: { url: image } })),
        ],
      },
    ],
    {
      expectJson: true,
      jsonMode: true,
      model: getQualityExtractionModel(),
      reasoning: getQualityExtractionReasoning(),
    }
  );

  return normalizeAiBankStatement(safeJsonParse(raw, {}));
}

export async function extractBankStatementFile(params: {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string | null;
}): Promise<BankStatementExtractionResult> {
  const mimeType = params.mimeType ?? "";
  const canReadAsText =
    mimeType.includes("csv") ||
    mimeType.startsWith("text/") ||
    /\.(csv|txt)$/i.test(params.fileName || "");

  if (canReadAsText) {
    const parsed = parseBankStatementText(new TextDecoder("utf-8", { fatal: false }).decode(params.bytes));
    return { ...parsed, extractionSource: "csv_text_v1", extractionError: null };
  }

  const isPdf = mimeType.includes("pdf") || /\.pdf$/i.test(params.fileName);
  const isImage = mimeType.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(params.fileName);

  try {
    const textHint = isPdf
      ? await extractBankStatementPdfText(params.bytes)
      : "";
    const textParsed = textHint ? parseBankStatementText(textHint) : emptyParsedBankStatement();

    const images = isPdf
      ? await renderBankStatementPdfToImages(params.bytes, params.fileName)
      : isImage
        ? [await imageBytesToProviderDataUrl(params.bytes, mimeType || "image/jpeg", params.fileName)]
        : [];
    let aiParsed = await extractBankStatementFromImages({ fileName: params.fileName, images, textHint });
    if (aiParsed.transactions.length === 0 && images.length > 0) {
      try {
        const repaired = await extractBankStatementFromImages({
          fileName: params.fileName,
          images,
          textHint,
          repairMode: true,
        });
        aiParsed = {
          ...repaired,
          diagnostics: {
            ...repaired.diagnostics,
            rawAiTransactionCount:
              repaired.diagnostics.rawAiTransactionCount ?? aiParsed.diagnostics.rawAiTransactionCount,
            normalizedAiTransactionCount: repaired.transactions.length,
            rejectedAiTransactionCount: repaired.diagnostics.rejectedAiTransactionCount,
          },
        };
      } catch {
        // Keep the first AI result and continue to the PDF text fallback.
      }
    }
    if (aiParsed.transactions.length > 0) {
      const mergedParsed = mergeBankStatementMetadata(aiParsed, textParsed);
      return {
        ...mergedParsed,
        extractionSource: "openrouter_bank_statement_v1",
        extractionError: null,
        extractionDiagnostics: {
          ...aiParsed.diagnostics,
          fallbackParser:
            textParsed.account.accountNumber ||
            textParsed.account.bankName ||
            textParsed.account.accountHolderName ||
            textParsed.account.ifscCode ||
            textParsed.statementPeriodStart ||
            textParsed.statementPeriodEnd
              ? "pdf_text_metadata_v1"
              : null,
        },
      };
    }

    return {
      ...(textParsed.transactions.length > 0
        ? mergeBankStatementMetadata(textParsed, aiParsed)
        : aiParsed),
      extractionSource: textParsed.transactions.length > 0 ? "csv_text_v1" : "openrouter_bank_statement_v1",
      extractionError:
        textParsed.transactions.length > 0
          ? "AI returned no normalized rows; imported rows from PDF text fallback."
          : "AI returned no normalized transaction rows.",
      extractionDiagnostics: {
        ...aiParsed.diagnostics,
        fallbackParser: textParsed.transactions.length > 0 ? "pdf_text_v1" : null,
      },
    };
  } catch (error) {
    return {
      ...emptyParsedBankStatement(),
      extractionSource: "manual_review_required_v1",
      extractionError: error instanceof Error ? error.message : String(error ?? "Bank statement extraction failed"),
    };
  }
}

export function buildTransactionFingerprint(accountId: string, transaction: ParsedBankTransaction) {
  const parts = [
    accountId,
    transaction.transactionDate,
    transaction.valueDate ?? "",
    transaction.referenceNumber ?? "",
    transaction.description.toLowerCase().replace(/\s+/g, " ").trim(),
    transaction.debitAmount ?? "",
    transaction.creditAmount ?? "",
    transaction.balanceAmount ?? "",
  ];

  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function serializeAccount(row: BankAccountRow) {
  return {
    id: row.id,
    bankName: row.bank_name,
    accountNumber: row.account_number_normalized,
    accountNumberMasked: row.account_number_masked,
    accountHolderName: row.account_holder_name,
    ifscCode: row.ifsc_code,
    tallyLedgerName: row.tally_ledger_name,
    lastImportedTransactionAt: row.last_imported_transaction_at,
    lastTallyPostedTransactionAt: row.last_tally_posted_transaction_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findBankAccountCandidates(
  supabase: SupabaseClient,
  ownerUserId: string,
  account: BankAccountInput,
  scope?:{organizationId:string;companyId:string}
) {
  const predicate=scope?`and(access_organization_id.eq.${JSON.stringify(scope.organizationId)},access_company_id.eq.${JSON.stringify(scope.companyId)})`:`owner_user_id.eq.${JSON.stringify(ownerUserId)}`;
  const normalizedAccountNumber = normalizeAccountNumber(account.accountNumber);
  if (normalizedAccountNumber) {
    const { data, error } = await supabase
      .from("bank_accounts")
      .select("*")
      .or(predicate)
      .eq("account_number_normalized", normalizedAccountNumber)
      .limit(5);
    if (error) throw error;
    if ((data ?? []).length > 0) return data as BankAccountRow[];
  }

  const normalizedHolder = normalizeName(account.accountHolderName);
  if (!normalizedHolder) return [];

  const { data, error } = await supabase
    .from("bank_accounts")
    .select("*")
    .or(predicate)
    .ilike("account_holder_name", `%${normalizedHolder.split(" ").join("%")}%`)
    .limit(10);

  if (error) throw error;
  return (data ?? []) as BankAccountRow[];
}

export function resolveImportStatus(candidateCount: number) {
  if (candidateCount > 1) return "needs_account_selection";
  return "ready_to_confirm";
}

export function buildStoragePath(ownerUserId: string, fileName: string) {
  const cleanName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "bank-statement";
  return `${ownerUserId}/bank-statements/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${cleanName}`;
}



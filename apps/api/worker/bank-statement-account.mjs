const DEFAULT_COMBINED_LEDGER_LIMIT = 1_000;
const DEFAULT_COMBINED_LEDGER_PAYLOAD_LIMIT = 80_000;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function markdownCells(line) {
  const text = String(line ?? "").trim();
  if (!text.includes("|")) return [];
  return text
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cleanText);
}

function isMarkdownSeparator(line) {
  const cells = markdownCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function normalizeHeader(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanAccountNumber(value) {
  const compact = cleanText(value).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return /\d/.test(compact) && compact.length >= 6 && compact.length <= 34 ? compact : "";
}

function parseStatementAccount(value) {
  const text = cleanText(value);
  if (!text) return { bankName: "", accountNumber: "" };

  const accountMatch = text.match(/([0-9*Xx][0-9*Xx .-]{4,33})$/);
  const accountNumber = cleanAccountNumber(accountMatch?.[1]);
  if (!accountNumber) return { bankName: "", accountNumber: "" };

  const prefix = text.slice(0, Math.max(0, text.length - (accountMatch?.[1]?.length ?? 0)));
  const bankName = cleanText(prefix.replace(/(?:account|a\/?c|number|no\.?|#)?\s*[-:–—]*\s*$/i, ""));
  return { bankName, accountNumber };
}

/**
 * Recover visible account identity from AnyDoc Markdown before relying on AI.
 * Bank statement headers are usually simple key/value tables and are safer to
 * parse deterministically than to ask a ledger-matching prompt to repeat them.
 */
export function extractAccountFromBankStatementMarkdown(markdown) {
  const result = { bankName: "", accountNumber: "", accountHolderName: "", ifscCode: "" };
  const lines = String(markdown ?? "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const headers = markdownCells(lines[index]);
    if (headers.length === 0 || isMarkdownSeparator(lines[index])) continue;

    let valueIndex = index + 1;
    while (valueIndex < lines.length && (!lines[valueIndex].trim() || isMarkdownSeparator(lines[valueIndex]))) {
      valueIndex += 1;
    }
    const values = markdownCells(lines[valueIndex]);
    if (values.length !== headers.length) continue;

    headers.forEach((header, cellIndex) => {
      const normalized = normalizeHeader(header);
      const value = values[cellIndex];
      if (!value) return;

      if (/^(account holder|account holder name|customer name|account name)$/.test(normalized)) {
        result.accountHolderName ||= cleanText(value);
      } else if (/^(bank name|bank)$/.test(normalized)) {
        result.bankName ||= cleanText(value);
      } else if (/^(account number|account no|a c number|a c no)$/.test(normalized)) {
        result.accountNumber ||= cleanAccountNumber(value);
      } else if (/^(ifsc|ifsc code)$/.test(normalized)) {
        result.ifscCode ||= cleanText(value).toUpperCase().replace(/\s+/g, "");
      } else if (/^(statement account|bank account|account)$/.test(normalized)) {
        const statementAccount = parseStatementAccount(value);
        result.bankName ||= statementAccount.bankName;
        result.accountNumber ||= statementAccount.accountNumber;
      }
    });
  }

  const fullText = cleanText(markdown);
  result.accountNumber ||= cleanAccountNumber(
    fullText.match(/(?:account|a\/?c)\s*(?:number|no\.?|#)\s*[:\-]?\s*([0-9*Xx][0-9*Xx .-]{5,33})/i)?.[1]
  );
  result.ifscCode ||= cleanText(fullText.match(/\bIFSC(?:\s+CODE)?\s*[:\-]?\s*([A-Z]{4}0[A-Z0-9]{6})\b/i)?.[1]).toUpperCase();

  return result;
}

export function mergeBankStatementAccount(primary, fallback) {
  return {
    bankName: cleanText(primary?.bankName) || cleanText(fallback?.bankName) || null,
    accountNumber: cleanText(primary?.accountNumber) || cleanText(fallback?.accountNumber) || null,
    accountHolderName: cleanText(primary?.accountHolderName) || cleanText(fallback?.accountHolderName) || null,
    ifscCode: cleanText(primary?.ifscCode) || cleanText(fallback?.ifscCode) || null,
  };
}

export function bankStatementAccountDiagnostics(account, deterministicAccount = null) {
  const fields = {
    bankName: Boolean(cleanText(account?.bankName)),
    accountNumber: Boolean(cleanText(account?.accountNumber)),
    accountHolderName: Boolean(cleanText(account?.accountHolderName)),
    ifscCode: Boolean(cleanText(account?.ifscCode)),
  };
  return {
    fields,
    hasIdentity: fields.bankName || fields.accountNumber,
    hasAccountNumber: fields.accountNumber,
    recoveredFromMarkdown: Boolean(
      deterministicAccount &&
      Object.values(deterministicAccount).some((value) => Boolean(cleanText(value)))
    ),
  };
}

export function combinedLedgerCatalogueDecision(
  ledgerNames,
  {
    maxLedgerCount = DEFAULT_COMBINED_LEDGER_LIMIT,
    maxPayloadCharacters = DEFAULT_COMBINED_LEDGER_PAYLOAD_LIMIT,
  } = {}
) {
  const names = Array.isArray(ledgerNames)
    ? Array.from(new Set(ledgerNames.map(cleanText).filter(Boolean)))
    : [];
  const payloadCharacters = JSON.stringify(names).length;
  const useCombined = names.length <= maxLedgerCount && payloadCharacters <= maxPayloadCharacters;
  return {
    useCombined,
    ledgerCount: names.length,
    payloadCharacters,
    reason: useCombined ? "within_combined_prompt_limit" : "ledger_catalogue_too_large",
  };
}


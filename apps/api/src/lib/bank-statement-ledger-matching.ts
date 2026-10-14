import type { SupabaseClient } from "@supabase/supabase-js";

import {
  extractCounterpartyName,
  normalizeName,
  normalizeNarrationPattern,
  type ParsedBankTransaction,
} from "./bank-statements.ts";
import {
  callOpenRouter,
  getBankLedgerMatchingMaxTokens,
  getBankLedgerMatchingModel,
  getBankLedgerMatchingReasoning,
  getBankLedgerMatchingTimeoutMs,
} from "./processing/openrouter.ts";
import { isSuspenseLedgerIdentity } from "./bank-statement-ledger-safety.ts";
import { normalizeMasterKey, type TallyMappingRow, type TallyMasterRow } from "./tally/masters.ts";

export type BankLedgerSuggestion = {
  counterpartyName: string | null;
  ledgerName: string | null;
  confidence: number;
  reason: string | null;
  mappingSource: "saved_narration" | "category" | "ledger_name" | "close_match" | "ai_match" | "vector_ai_match" | "none";
  matchType?: "direct_match" | "close_match" | "suspense";
  candidateLedgerNames?: string[];
};

type MatchableTransaction = Pick<ParsedBankTransaction, "description" | "category" | "counterpartyName"> &
  Partial<ParsedBankTransaction>;

export type BankLedgerSuggestionTransaction = {
  accountId: string;
  transaction: MatchableTransaction;
};

export type VectorLedgerCandidate = {
  ledgerName: string;
  tallyGuid?: string | null;
  parentGroup?: string | null;
  vectorScore?: number | null;
  confidence?: number | null;
  rank?: number | null;
};

type AiLedgerMatch = {
  index: number;
  matchType: "direct_match" | "close_match" | "suspense";
  action: "use_existing_ledger" | "use_suspense";
  ledgerName: string | null;
  candidateLedgerNames: string[];
  confidence: number;
  reason: string;
};

type ValidatedAiLedgerMatch = Omit<BankLedgerSuggestion, "counterpartyName" | "mappingSource">;

const BANK_LEDGER_AI_BATCH_SIZE = Math.min(
  25,
  Math.max(1, Number(process.env.OPENROUTER_BANK_LEDGER_BATCH_SIZE ?? 10) || 10)
);
const BANK_LEDGER_AI_BATCH_CONCURRENCY = Math.min(
  10,
  Math.max(1, Number(process.env.OPENROUTER_BANK_LEDGER_BATCH_CONCURRENCY ?? 10) || 10)
);

const BANK_LEDGER_MATCHING_SYSTEM_PROMPT = `You match Indian bank statement transactions to synced Tally ledgers.
Your task is to identify an existing Tally ledger only when the transaction evidence uniquely identifies it.
This is ledger assignment only. Do not attempt invoice matching, voucher matching, invoice settlement, split allocation, or full bank reconciliation.
Return only valid JSON. Do not return markdown, explanations outside JSON, or code fences.

Allowed ledgers:
Choose only from the provided tallyLedgers list. Copy every selected ledger name exactly as provided.
The tallyLedgers list is shared by every transaction in the request.
When a transaction includes allowedLedgerNames, that transaction may choose and may return candidates only from its own allowedLedgerNames list.
Never invent, modify, shorten, merge, or create a ledger.
Never create a new party, expense, tax, bank, transfer, or suspense ledger.
If no existing ledger is uniquely supported, use suspense.
Every transaction must produce exactly one result using its original index.

Output format:
{
  "matches": [
    {
      "index": 0,
      "matchType": "direct_match",
      "action": "use_existing_ledger",
      "ledgerName": "Exact Ledger Name From tallyLedgers",
      "candidateLedgerNames": [],
      "confidence": 0.95,
      "reason": "Short reason"
    }
  ]
}

Allowed matchType values: direct_match, close_match, suspense.

Direct match:
Use direct_match only when the transaction evidence uniquely identifies exactly one existing ledger. The closest or highest-scoring name is not enough when another ledger remains plausible.
For direct_match, action must be "use_existing_ledger", ledgerName must be one exact name from tallyLedgers, candidateLedgerNames must be [], and confidence must be at least 0.90.

Close match:
Use close_match when two or more existing ledgers are genuinely plausible and no single ledger can be selected safely.
For close_match, action must be "use_suspense", ledgerName must be null, candidateLedgerNames must contain at least two exact competing ledger names from tallyLedgers ordered from most to least plausible, and confidence must be 0.0.
close_match still means the selected posting ledger is Suspense. candidateLedgerNames are advisory choices for a human reviewer only. Never preselect the first candidate and never treat candidate ordering as a ledger decision.

Suspense:
Use suspense when there is no clear existing ledger, the narration is too generic, or matching would require guessing.
For suspense, action must be "use_suspense", ledgerName must be null, candidateLedgerNames must be [], and confidence must be 0.0.

Core rule:
A shortened, OCR-damaged, misspelled, or incomplete party name can still be a direct match only when it uniquely identifies one existing ledger after considering every plausible collision.
Do not call something a close match only because the bank narration does not exactly equal the ledger name.
Use close_match only when there is a real collision.
If the narration contains only a shared party root and multiple ledgers extend or vary that root, return close_match and keep the posting ledger in Suspense, even when one candidate has a somewhat stronger textual similarity.

Company-context rule:
The supplied companyName is the owner of the bank statement. When the raw
narration contains both an external party and companyName (or a clear legal,
spacing, or abbreviation variant of companyName), treat the company occurrence
as account-owner context, not as a competing counterparty. Do not add the
company's own ledger to candidateLedgerNames unless the narration explicitly
describes a self-transfer, own-account transfer, inter-company transfer, or
company loan. Match the external party named before or alongside that context.

Exact complete-name precedence:
After removing bank-system noise and normalizing only case, spacing, and punctuation, if the narrated party identity exactly equals one complete allowed ledger name, treat that ledger as a direct_match.
A merely misspelled, phonetic, OCR, singular/plural, or legal-suffix variant of the same complete name does not veto this exact complete-name match.
This precedence does not apply when another ledger begins with the same exact complete token sequence and adds a meaningful product, division, location, service, supplier, trader, or other identity descriptor. That is a shorter-name/extended-name collision and must remain close_match.
It also does not override a genuine conflict between the raw description and a derived counterpartyName.

Evidence hierarchy and derived-field safety:
The raw description is the primary evidence. counterpartyName, category, and transactionType are machine-derived hints that may have been extracted from that same description.
Never treat agreement between derived fields as independent confirmation.
If the raw description contains no identifiable party or purpose after removing bank noise, use suspense even when counterpartyName contains an exact ledger name.
If an identifiable party in the raw description conflicts with counterpartyName and both point to existing ledgers, use close_match with both ledgers. Never choose one side of the conflict. This is a hard veto against direct_match even when the raw description exactly names one ledger.
Category, amount, debit/credit direction, and Tally parent group may eliminate an impossible ledger, but must never break a name collision or manufacture identity evidence.

Derived-field conflict examples:
- Description SHREE BALAJI ROADLINES with counterpartyName Shree Balaji Steels Pvt Ltd must return close_match with both ledgers, never direct_match to Roadlines.
- Description SHAKTI SCRAP TRADERS with counterpartyName Shakti Sponge Iron Suppliers must return close_match with both ledgers, never direct_match to Scrap Traders.

Mandatory collision veto before every direct_match:
Before returning direct_match, scan every ledger allowed for that transaction for a plausible collision.
A collision exists when two or more ledgers share the narrated party root; one ledger name is the narrated root while another extends it with a meaningful descriptor, product, division, or location; or two ledger names are plausible spelling, OCR, phonetic, singular/plural, or legal-suffix variants.
Apply the exact complete-name precedence before treating spelling, OCR, phonetic, singular/plural, or legal-suffix variants as collisions.
An exact complete-name match overrides those same-length variants, but it never overrides a conflict with counterpartyName or a shorter-name/extended-name collision.

Shorter exact-name collision — hard veto:
If the narrated party name exactly equals one allowed ledger, but another allowed ledger begins with that same complete party identity and adds further party, business, product, division, location, service, supplier, trader, or legal-entity words, the narration does not uniquely identify the shorter ledger.
In this situation, return close_match, keep ledgerName null, use action use_suspense, set confidence to 0.0, and include the exact shorter ledger plus every genuinely plausible extended ledger in candidateLedgerNames.
This rule applies even when the shorter ledger is a character-for-character match and even when the shorter ledger has a more plausible group or transaction direction.
The longer ledger may be a direct_match only when the raw narration itself contains its additional distinguishing words and no spelling, entity, or further-extension collision remains.
For example, with ledgers Orchid Foundry and Orchid Foundry Supplies, narration ORCHID FOUNDRY must return close_match with both candidates; narration ORCHID FOUNDRY SUPPLIES may directly match the longer ledger only if no other collision exists.

Do not use ledger group, customer/supplier role, debit/credit direction, amount, or category to choose between colliding names.
When a real collision exists, return close_match and include every plausible colliding ledger, not only the closest one. A candidate list is never permission to select a candidate.
Use token boundaries when identifying roots: OM may match ledgers beginning with the separate token OM, but OM must not match OMKAR merely because the letters are a prefix.

Collision examples:
- JSW STEEL collides with JSW Steel Limited and JSW Steel Coated Products Limited, but the complete name JSW STEEL LIMITED directly matches JSW Steel Limited.
- TATA STEEL collides with Tata Steel Limited and Tata Steel Downstream Products Limited, but TATA STEEL DOWNSTREAM PRODUCTS LIMITED directly matches the downstream-products ledger.
- BALAJI alone collides with every ledger containing the Balaji party root; BALAJI STEEL also collides with ledgers that extend that root with Traders, Transport, or another meaningful descriptor.
- With ledgers Zenith Metal Corporation and Zenit Metal Corporation, narration ZENITH METAL CORPORATION directly matches the exact complete ledger; the phonetic spelling variant does not veto it.
- With ledgers Pioneer Alloy and Pioneer Alloy Scrap, narration PIONEER ALLOY must return close_match with both candidates because the second ledger extends the exact narrated identity with a meaningful product word.

Remove bank-system noise before comparing names:
Ignore NEFT, RTGS, IMPS, UPI, UPIREF, NACH, ACH, ECS, CMS, CR, DR, transfer, fund transfer, payment, receipt, UTR, RRN, TXN, REF, beneficiary, to, from, by, account words, IFSC, bank, branch, mobile/account/reference numbers, M/S, MS, M S, dates, and similar bank references.
Do not treat these words or numbers as party names.
Use transaction direction, amount, and date only as supporting context. Do not use them alone to guess a ledger.

Normalize carefully:
Ignore case, extra spaces, missing spaces, punctuation, dots, commas, brackets, hyphens, slashes, separators, and legal-form suffixes such as Pvt Ltd, Private Limited, Ltd, Limited, LLP, Co, Company, Inc.
Treat spelling variants as possible normal variants only when the full party root remains clearly the same.
Examples: Bharat/Bharath/Bharth, Shree/Shri/Sri, Steel/Steels, Enterprise/Enterprises, Engg/Engineering, Transport/Transports, Logistics/Logistic, Roadline/Roadlines, Electrical/Electricals, Fabrication/Fabricators.
Do not use phonetic similarity alone as proof. It can support a direct match only when one ledger remains clearly unique after collision checking.

Preserve meaningful business descriptors:
Do not remove descriptors such as Steel, Metals, Alloys, Traders, Transport, Logistics, Roadlines, Engineering, Fabrication, Electricals, Chemicals, Hardware, Fuel, Power, Construction, Enterprises, Industries, Agencies, Services, Works.
These may differentiate different parties. Prefer the ledger with the closest matching full root and descriptor.
A named party ledger is preferred over a generic expense-category ledger when both are available.
Never confuse different party roots based only on one shared word, partial string, or loose phonetic resemblance.

Transaction types to consider:
The statement may include customer receipts, supplier payments, raw-material purchases, transport/freight/logistics, contractor/fabrication/repair/machinery/electrical payments, fuel/toll/travel/hotel/food/staff welfare, salaries/wages/incentives/advances/reimbursements, utilities, GST/TDS/PF/ESIC/professional tax/income tax/customs duty, bank charges/interest/cheque return/loan interest/OD interest, insurance/loan/EMI/fixed deposit, cash deposits/withdrawals, payment-gateway/card settlements, reversals, and transfers between company accounts.
Do not assume every transaction is a customer or vendor payment.

Category and expense-ledger matching:
You may select an expense, statutory, payroll, or bank-related ledger only when the narration explicitly supports that category and exactly one existing ledger clearly fits.
Do not infer an expense category from a merchant name alone.
If a merchant/category could belong to multiple expense ledgers, use suspense.
Generic FUEL without an explicit diesel, furnace-oil, petrol, LPG, CNG, merchant, or other distinguishing term must use suspense, with no candidates.

Statutory and bank-account ambiguity:
Generic GST PAYMENT does not identify GST Payable versus CGST Payable, SGST Payable, or IGST Payable. Return close_match with every available GST payable candidate.
Generic TDS PAYMENT or CHALLAN 281 does not identify a TDS section. Return close_match with every available section-specific TDS payable candidate; do not infer 194C, 194Q, or another section.
A bank name without an account number or explicit account type cannot identify one of multiple accounts at that bank. Return close_match with every plausible account ledger for that bank.

Employee, salary, and reimbursement transactions:
Match an employee-name ledger only when one existing employee ledger clearly matches the person.
Do not map a person's name to Salary Expenses, Travelling Expenses, Staff Welfare Expenses, or Wages Expenses merely because the transaction may be related to that category.
When an ordinary payment narration explicitly says both SALARY and WAGES and both Salary Payable and Wages Payable exist, return close_match with those two ledgers. Do not downgrade this identifiable two-ledger collision to suspense.

Transfers, reversals, and company-own transactions:
Do not select the company's own ledger merely because the company name appears in narration.
Use suspense unless one existing transfer, loan, bank, or finance ledger is explicitly and uniquely supported by the narration.
Reversal and cheque-return narrations do not prove which original party ledger should be posted. If the named root is ambiguous, return suspense with no candidates rather than close_match. For example, CHEQUE RETURN GANESH STEEL with Ganesh Steel Pune and Ganesh Steel Nashik must return suspense with no candidates.

Cases that must go to suspense:
No identifiable party/category; only UTR/RRN/account/bank code/reference; multiple possible expense categories; merchant name does not reveal purpose; self-transfer/reversal without explicit matching ledger; best possible match below 0.90; selecting requires guessing; transaction may need split allocation or voucher-level reconciliation.

Reference and memory safety:
referenceNumber is normally a bank UTR/RRN/reference and does not identify a Tally ledger by itself. A visible invoice or bill reference may support a direct match only when the supplied evidence explicitly connects that reference to one ledger; do not invent that connection. Saved narration mappings are validated before this AI request and are therefore not represented by a guessed AI match.

Final decision rules:
First verify that the raw description contains identity or purpose evidence. Then check for an exact complete-name match, apply the exact complete-name precedence and its exceptions, and finally run the remaining collision veto. Use direct_match only when exactly one ledger remains possible after these checks; "more likely than the others" is not unique identification.
A unique shortened party name is a direct match when no competing ledger shares that root.
A character-for-character match to a shorter ledger is still close_match when another ledger extends that complete name with additional identity words.
A character-for-character match to one complete ledger is direct_match when the only alternatives are spelling, phonetic, OCR, singular/plural, or legal-suffix variants of that same complete name and no extension or derived-field conflict exists.
A typo, OCR issue, joined word, missing space, or phonetic variation can still be a direct match when one ledger clearly fits.
Use close_match only when two or more existing ledgers are genuinely plausible.
Use suspense when no clear ledger exists or matching requires guessing.
An exact derived counterpartyName, a preferred ledger group, or a plausible transaction direction never raises an ambiguous result to direct_match.
Never select a ledger when confidence is below 0.90.
Never invent, alter, or create a ledger.
When returning close_match, remember that its posting selection remains Suspense until a human explicitly chooses one candidate.
Never guess between similar ledgers.`;

function ledgerNameTokens(value?: string | null) {
  return normalizeName(value)
    .split(/\s+/)
    .map((token) => {
      if (!token) return "";
      if (["pvt", "private", "ltd", "limited", "llp", "inc"].includes(token)) return "";
      if (token === "shri") return "shree";
      if (["ind", "industry", "industries", "industires", "indutries", "indstries"].includes(token)) return "industry";
      if (token === "supply" || token === "supplies" || token === "supplier" || token === "suppliers") return "supply";
      if (token === "enterprise" || token === "enterprises") return "enterprise";
      if (["engr", "engrs", "engg", "engineer", "engineers", "engineering"].includes(token)) return "engineer";
      if (["mech", "mechanical"].includes(token)) return "mech";
      if (token === "co" || token === "company") return "company";
      return token;
    })
    .filter(Boolean);
}

function compactLedgerName(value?: string | null) {
  return ledgerNameTokens(value).join("");
}

const GENERIC_PARTY_SUFFIX_TOKENS = new Set([
  "company",
  "enterprise",
  "firm",
  "group",
  "trader",
  "traders",
  "trading",
]);

function coreLedgerNameTokens(value?: string | null) {
  return ledgerNameTokens(value).filter(
    (token) => token.length > 1 && !GENERIC_PARTY_SUFFIX_TOKENS.has(token)
  );
}

function compactCoreLedgerName(value?: string | null) {
  return coreLedgerNameTokens(value).join("");
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
}

function ledgerNameSimilarity(left: string, right: string) {
  const leftCompact = compactLedgerName(left);
  const rightCompact = compactLedgerName(right);
  if (!leftCompact || !rightCompact) return 0;
  if (leftCompact === rightCompact) return 1;

  const maxLength = Math.max(leftCompact.length, rightCompact.length);
  if (maxLength < 5) return 0;

  const editScore = 1 - levenshteinDistance(leftCompact, rightCompact) / maxLength;
  const substringScore =
    leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact)
      ? 0.82 + (Math.min(leftCompact.length, rightCompact.length) / maxLength) * 0.1
      : 0;
  const leftCoreCompact = compactCoreLedgerName(left);
  const rightCoreCompact = compactCoreLedgerName(right);
  const coreMaxLength = Math.max(leftCoreCompact.length, rightCoreCompact.length);
  const coreScore =
    coreMaxLength >= 5 && leftCoreCompact && rightCoreCompact
      ? leftCoreCompact === rightCoreCompact
        ? 0.96
        : leftCoreCompact.includes(rightCoreCompact) || rightCoreCompact.includes(leftCoreCompact)
          ? 0.88 + (Math.min(leftCoreCompact.length, rightCoreCompact.length) / coreMaxLength) * 0.08
          : 1 - levenshteinDistance(leftCoreCompact, rightCoreCompact) / coreMaxLength
      : 0;

  const leftTokens = new Set(ledgerNameTokens(left));
  const rightTokens = new Set(ledgerNameTokens(right));
  const sharedTokenCount = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  const totalTokenCount = new Set([...leftTokens, ...rightTokens]).size;
  const tokenScore = totalTokenCount > 0 ? sharedTokenCount / totalTokenCount : 0;

  return Math.max(editScore, substringScore, coreScore, tokenScore);
}

function findCloseLedgerMatches(ledgers: TallyMasterRow[], candidateName?: string | null) {
  const normalizedCandidate = normalizeName(candidateName);
  if (!normalizedCandidate || compactLedgerName(normalizedCandidate).length < 5) return [];

  const matches: Array<{ ledgerName: string; score: number }> = [];
  for (const ledger of ledgers) {
    const score = ledgerNameSimilarity(normalizedCandidate, ledger.tally_name);
    if (score < 0.84) continue;
    matches.push({ ledgerName: ledger.tally_name, score });
  }

  return matches.sort((left, right) => right.score - left.score || left.ledgerName.localeCompare(right.ledgerName));
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return fallback;
    }
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

function findLedgerByNormalizedName(ledgers: TallyMasterRow[], ledgerName?: string | null) {
  const normalized = normalizeName(ledgerName);
  if (!normalized) return null;
  return ledgers.find((ledger) => normalizeName(ledger.tally_name) === normalized) ?? null;
}

function validateAiLedgerMatch(
  match: Partial<AiLedgerMatch> | undefined,
  candidateLedgers: TallyMasterRow[]
): ValidatedAiLedgerMatch | null {
  if (!match) return null;

  const reason = String(match.reason ?? "").trim() || "AI ledger matching completed.";
  const candidateLedgerNames = Array.isArray(match.candidateLedgerNames)
    ? match.candidateLedgerNames
        .map((name) => String(name ?? "").trim())
        .filter((name) => Boolean(findLedgerByNormalizedName(candidateLedgers, name)))
    : [];

  if (match.matchType === "direct_match" && match.action === "use_existing_ledger") {
    const matchedLedger = findLedgerByNormalizedName(candidateLedgers, String(match.ledgerName ?? ""));
    const confidence = clampConfidence(match.confidence);
    if (!matchedLedger || confidence < 0.9) {
      return {
        ledgerName: null,
        confidence: 0,
        reason: "AI returned an unsafe ledger match, so the row was kept in suspense.",
        matchType: "suspense",
        candidateLedgerNames: [],
      };
    }

    return {
      ledgerName: matchedLedger.tally_name,
      confidence,
      reason,
      matchType: "direct_match",
      candidateLedgerNames: [],
    };
  }

  if (match.matchType === "close_match" && candidateLedgerNames.length >= 2) {
    return {
      ledgerName: null,
      confidence: 0,
      reason,
      matchType: "close_match",
      candidateLedgerNames,
    };
  }

  return {
    ledgerName: null,
    confidence: 0,
    reason,
    matchType: "suspense",
    candidateLedgerNames: [],
  };
}

async function aiMatchLedgersForTransactions(input: {
  ledgers: TallyMasterRow[];
  companyName?: string | null;
  transactions: Array<{
    transaction: MatchableTransaction;
    counterpartyName: string | null;
    vectorCandidates?: VectorLedgerCandidate[];
  }>;
}) {
  if (input.transactions.length === 0) return [];

  const ledgerByName = new Map(input.ledgers.map((ledger) => [normalizeName(ledger.tally_name), ledger]));
  const allowedLedgersByIndex = input.transactions.map(({ vectorCandidates }) => {
    const shortlisted = (vectorCandidates || []).map(candidate => ledgerByName.get(normalizeName(candidate.ledgerName)))
      .filter((ledger): ledger is TallyMasterRow => Boolean(ledger));
    return shortlisted.length ? Array.from(new Map(shortlisted.map(ledger => [normalizeName(ledger.tally_name), ledger])).values()) : input.ledgers;
  });
  const candidateLedgerByKey = new Map<string, TallyMasterRow>();
  for (const rows of allowedLedgersByIndex) for (const ledger of rows) {
    const key = normalizeName(ledger.tally_name); if (key && !candidateLedgerByKey.has(key)) candidateLedgerByKey.set(key, ledger);
  }
  const candidateLedgers = Array.from(candidateLedgerByKey.values());
  if (candidateLedgers.length === 0) return input.transactions.map(() => null);

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content: BANK_LEDGER_MATCHING_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: compactPromptJson({
          companyName: input.companyName ?? null,
          transactions: input.transactions.map(({ transaction, counterpartyName }, index) => ({
            index,
            transactionDate: transaction.transactionDate ?? null,
            description: transaction.description,
            referenceNumber: transaction.referenceNumber ?? null,
            debitAmount: transaction.debitAmount ?? null,
            creditAmount: transaction.creditAmount ?? null,
            transactionType: transaction.transactionType ?? null,
            category: transaction.category,
            counterpartyName: counterpartyName ?? transaction.counterpartyName ?? null,
            allowedLedgerNames: allowedLedgersByIndex[index].map(ledger => ledger.tally_name),
            vectorCandidates: (input.transactions[index].vectorCandidates || []).map(candidate => ({ ledgerName: candidate.ledgerName,
              score: candidate.vectorScore ?? candidate.confidence ?? null, rank: candidate.rank ?? null })),
          })),
          tallyLedgers: candidateLedgers.map((ledger) => ({
            name: ledger.tally_name,
            group: ledger.parent_name ?? null,
          })),
        }),
      },
    ],
    {
      expectJson: true,
      jsonMode: true,
      model: getBankLedgerMatchingModel(),
      reasoning: getBankLedgerMatchingReasoning(),
      maxTokens: getBankLedgerMatchingMaxTokens(),
      timeoutMs: getBankLedgerMatchingTimeoutMs(),
      maxRetries: Math.max(0, Number(process.env.OPENROUTER_BANK_LEDGER_MAX_RETRIES ?? 0)),
    }
  );

  const parsed = safeJsonParse<{
    matches?: Array<Partial<AiLedgerMatch>>;
  }>(raw, {});
  if (process.env.OPENROUTER_DEBUG_LOG === "true") {
    console.log(
      JSON.stringify({
        scope: "bank_ledger_parser",
        event: "parsed_response",
        transactionCount: input.transactions.length,
        rawLength: raw.length,
        matchesIsArray: Array.isArray(parsed.matches),
        matchCount: Array.isArray(parsed.matches) ? parsed.matches.length : 0,
        returnedIndexes: Array.isArray(parsed.matches)
          ? parsed.matches.map((entry) => entry?.index ?? null)
          : [],
      })
    );
  }
  return input.transactions.map((_, index) =>
    validateAiLedgerMatch(
      parsed.matches?.find((entry) => Number(entry?.index) === index),
      allowedLedgersByIndex[index]
    )
  );
}

function sourceKeyForNarration(accountId: string, description: string) {
  return `${accountId}:${normalizeNarrationPattern(description)}`.slice(0, 240);
}

function validateSavedNarrationLedger(
  ledgers: TallyMasterRow[],
  mappedLedger: TallyMasterRow | null | undefined,
  item: BankLedgerSuggestionTransaction
) {
  if (!mappedLedger || !item.accountId.trim() || !normalizeNarrationPattern(item.transaction.description)) {
    return null;
  }
  if (isSuspenseLedgerIdentity({ name: mappedLedger.tally_name, parent: mappedLedger.parent_name })) {
    return null;
  }

  // Saved narration memory is deliberately keyed and validated from raw bank
  // narration. A derived counterparty field is not independent evidence.
  const rawCounterparty = extractCounterpartyName(item.transaction.description);
  if (!rawCounterparty) return null;
  const rawMatches = findCloseLedgerMatches(ledgers, rawCounterparty);
  if (
    rawMatches.length !== 1 ||
    normalizeName(rawMatches[0].ledgerName) !== normalizeName(mappedLedger.tally_name)
  ) {
    return null;
  }

  // A conflict between the raw narration identity and a supplied derived hint
  // invalidates memory and sends the transaction through normal matching.
  const derivedCounterparty = String(item.transaction.counterpartyName ?? "").trim();
  if (derivedCounterparty && normalizeName(derivedCounterparty) !== normalizeName(rawCounterparty)) {
    const derivedMatches = findCloseLedgerMatches(ledgers, derivedCounterparty);
    if (
      derivedMatches.some(
        (match) => normalizeName(match.ledgerName) !== normalizeName(mappedLedger.tally_name)
      )
    ) {
      return null;
    }
  }

  return mappedLedger;
}

export function buildBankAccountLedgerSourceKey(accountId: string) {
  return `bank_account:${accountId}`.slice(0, 240);
}

export function buildBankNarrationLedgerSourceKey(accountId: string, description: string) {
  return sourceKeyForNarration(accountId, description);
}

function deterministicLedgerSuggestion(counterpartyName: string | null): BankLedgerSuggestion {
  return {
    counterpartyName,
    ledgerName: null,
    confidence: 0,
    reason: "AI ledger matching was unavailable, so the row was kept in Suspense.",
    mappingSource: "none",
    matchType: "suspense",
    candidateLedgerNames: [],
  };
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function fetchAllActiveTallyLedgers(input: {
  supabase: SupabaseClient;
  ownerUserId: string;
  connectionId?: string | null;
  datasetId?: string | null;
  companyName?: string | null;
}) {
  if (!input.connectionId) return [] as TallyMasterRow[];

  const ledgers: TallyMasterRow[] = [];
  const pageSize = 1000;
  for (let from = 0; from < 20000; from += pageSize) {
    let query = input.supabase.from(input.datasetId ? 'access_dataset_masters' : 'tally_masters').select('*');
    query = input.datasetId ? query.eq('dataset_id',input.datasetId) : query.eq('owner_user_id',input.ownerUserId).eq('connection_id',input.connectionId);
    if (!input.datasetId && input.companyName) query = query.eq('company_name',input.companyName);
    const { data, error } = await query
      .eq("master_type", "ledger")
      .eq("is_active", true)
      .order("tally_name", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as TallyMasterRow[];
    ledgers.push(...page);
    if (page.length < pageSize) return ledgers;
  }

  throw new Error("Tally ledger sync exceeds the supported 20,000-ledger safety limit.");
}

export async function suggestBankLedgersForTransactions(input: {
  supabase: SupabaseClient;
  ownerUserId: string;
  connectionId?: string | null;
  companyName?: string | null;
  datasetId?: string | null;
  vectorCandidates?: Array<VectorLedgerCandidate[] | undefined>;
  transactions: BankLedgerSuggestionTransaction[];
}): Promise<BankLedgerSuggestion[]> {
  if (input.transactions.length === 0) return [];

  const preparedTransactions = input.transactions.map((item, index) => ({
    ...item,
    index,
    counterpartyName:
      item.transaction.counterpartyName ?? extractCounterpartyName(item.transaction.description),
    sourceKey: sourceKeyForNarration(item.accountId, item.transaction.description),
    vectorCandidates: input.vectorCandidates?.[index] ?? [],
  }));
  const suggestions: Array<BankLedgerSuggestion | undefined> = input.transactions.map(() => undefined);
  const hasCompleteVectorShortlists = preparedTransactions.every(item => item.vectorCandidates.length > 0);
  const vectorCatalogue = Array.from(new Map(preparedTransactions.flatMap(item => item.vectorCandidates)
    .filter(candidate => candidate.ledgerName.trim()).map((candidate, index) => {
      const name = candidate.ledgerName.trim();
      return [normalizeName(name), {
        id: candidate.tallyGuid || `vector-ledger-${index + 1}`, connection_id: input.connectionId ?? 'connector-vector-index',
        owner_user_id: input.ownerUserId, company_name: input.companyName ?? '', sync_run_id: null,
        master_type: 'ledger' as const, master_key: normalizeMasterKey({ masterType: 'ledger', name }),
        tally_guid: candidate.tallyGuid ?? null, tally_name: name, parent_name: candidate.parentGroup?.trim() || null,
        gstin: null, hsn_code: null, unit_name: null, tax_rate: null,
        raw_payload: { source: 'connector_vector_candidate' }, is_active: true,
        last_synced_at: '', created_at: '', updated_at: '',
      } satisfies TallyMasterRow] as const;
    })).values());
  const ledgers = hasCompleteVectorShortlists ? vectorCatalogue : await fetchAllActiveTallyLedgers(input);
  const activeLedgerByName = new Map(
    ledgers.map((ledger) => [normalizeName(ledger.tally_name), ledger])
  );

  if (input.connectionId && !hasCompleteVectorShortlists) {
    const sourceKeys = Array.from(
      new Set(
        preparedTransactions
          .filter(
            (item) =>
              item.accountId.trim() && normalizeNarrationPattern(item.transaction.description)
          )
          .map((item) => item.sourceKey)
      )
    );
    const mappingChunks = await Promise.all(
      chunkValues(sourceKeys, 40).map(async (sourceKeyChunk) => {
        let query = input.supabase.from(input.datasetId ? 'access_dataset_mappings' : 'tally_mapping_settings').select('*');
        query = input.datasetId ? query.eq('dataset_id',input.datasetId) : query.eq('owner_user_id',input.ownerUserId).eq('connection_id',input.connectionId);
        if (!input.datasetId && input.companyName) query = query.eq('company_name',input.companyName);
        const { data, error } = await query
          .eq("mapping_type", "bank_narration_ledger")
          .in("source_key", sourceKeyChunk)
          .eq("status", "active")
          .limit(5000);
        if (error) throw error;
        return data ?? [];
      })
    );

    const savedMappingBySourceKey = new Map<string, TallyMappingRow>();
    for (const mapping of mappingChunks.flat() as unknown as TallyMappingRow[]) {
      if (mapping.source_key && !savedMappingBySourceKey.has(mapping.source_key)) {
        savedMappingBySourceKey.set(mapping.source_key, mapping);
      }
    }
    for (const item of preparedTransactions) {
      const savedMapping = savedMappingBySourceKey.get(item.sourceKey);
      const activeMappedLedger = savedMapping?.target_master_name
        ? activeLedgerByName.get(normalizeName(savedMapping.target_master_name))
        : null;
      const validatedMappedLedger = validateSavedNarrationLedger(
        ledgers,
        activeMappedLedger,
        item
      );
      if (validatedMappedLedger) {
        suggestions[item.index] = {
          counterpartyName: item.counterpartyName,
          ledgerName: validatedMappedLedger.tally_name,
          confidence: 0.99,
          reason: "Saved narration mapping validated against the active Tally ledger list",
          mappingSource: "saved_narration",
          matchType: "direct_match",
          candidateLedgerNames: [],
        };
      }
    }
  }

  const unresolvedTransactions = preparedTransactions.filter((item) => !suggestions[item.index]);
  if (unresolvedTransactions.length === 0) {
    return suggestions as BankLedgerSuggestion[];
  }

  if (ledgers.length > 0) {
    const chunks = chunkValues(unresolvedTransactions, BANK_LEDGER_AI_BATCH_SIZE);
    let nextChunkIndex = 0;
    const matchChunk = async (chunk: typeof unresolvedTransactions): Promise<void> => {
      try {
        const aiMatches = await aiMatchLedgersForTransactions({
          ledgers,
          companyName: input.companyName,
          transactions: chunk.map((item) => ({
            transaction: item.transaction,
            counterpartyName: item.counterpartyName,
            vectorCandidates: item.vectorCandidates,
          })),
        });
        chunk.forEach((item, index) => {
          const aiLedger = aiMatches[index];
          if (!aiLedger) return;
          suggestions[item.index] = {
            counterpartyName: item.counterpartyName,
            ledgerName: aiLedger.ledgerName,
            confidence: aiLedger.confidence,
            reason: aiLedger.reason,
            // A valid AI suspense/close-match decision is still a completed
            // AI result even though it deliberately has no selected ledger.
            mappingSource: item.vectorCandidates.length > 0 ? "vector_ai_match" : "ai_match",
            matchType: aiLedger.matchType,
            candidateLedgerNames: aiLedger.candidateLedgerNames,
          };
        });
      } catch (error) {
        console.warn(
          `AI ledger batch match failed for ${chunk.length} transaction(s); keeping the batch in Suspense:`,
          error
        );
      }
    };

    const runWorker = async () => {
      while (nextChunkIndex < chunks.length) {
        const chunk = chunks[nextChunkIndex];
        nextChunkIndex += 1;
        await matchChunk(chunk);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(BANK_LEDGER_AI_BATCH_CONCURRENCY, chunks.length) },
        () => runWorker()
      )
    );
  }

  for (const item of unresolvedTransactions) {
    if (!suggestions[item.index]) {
      suggestions[item.index] = deterministicLedgerSuggestion(item.counterpartyName);
    }
  }

  return suggestions as BankLedgerSuggestion[];
}

export async function suggestBankLedgerForTransaction(input: {
  supabase: SupabaseClient;
  ownerUserId: string;
  connectionId?: string | null;
  accountId: string;
  transaction: MatchableTransaction;
}): Promise<BankLedgerSuggestion> {
  const [suggestion] = await suggestBankLedgersForTransactions({
    supabase: input.supabase,
    ownerUserId: input.ownerUserId,
    connectionId: input.connectionId,
    transactions: [{ accountId: input.accountId, transaction: input.transaction }],
  });
  return suggestion;
}

export async function suggestLedgerFromTallyCatalogue(input: {
  ledgers: Array<{
    id: string;
    name: string;
    parent?: string | null;
  }>;
  transaction: MatchableTransaction;
}): Promise<BankLedgerSuggestion> {
  const ledgers = input.ledgers.map((ledger) => ({
    id: ledger.id,
    connection_id: "provided-catalogue",
    owner_user_id: "provided-catalogue",
    company_name: "provided-catalogue",
    sync_run_id: null,
    master_type: "ledger" as const,
    master_key: normalizeName(ledger.name),
    tally_guid: null,
    tally_name: ledger.name,
    parent_name: ledger.parent ?? null,
    gstin: null,
    hsn_code: null,
    unit_name: null,
    tax_rate: null,
    raw_payload: {},
    is_active: true,
    last_synced_at: "",
    created_at: "",
    updated_at: "",
  }));
  const counterpartyName =
    input.transaction.counterpartyName?.trim() ||
    extractCounterpartyName(input.transaction.description) ||
    null;
  const [aiMatch] = await aiMatchLedgersForTransactions({
    ledgers,
    transactions: [{ transaction: input.transaction, counterpartyName }],
  });

  if (!aiMatch) return deterministicLedgerSuggestion(counterpartyName);
  return {
    counterpartyName,
    ledgerName: aiMatch.ledgerName,
    confidence: aiMatch.confidence,
    reason: aiMatch.reason,
    mappingSource:
      aiMatch.matchType === "close_match"
        ? "close_match"
        : aiMatch.matchType === "direct_match"
          ? "ai_match"
          : "none",
    matchType: aiMatch.matchType,
    candidateLedgerNames: aiMatch.candidateLedgerNames,
  };
}

export function buildLedgerMappingTarget(ledgerName: string) {
  return {
    target_master_type: "ledger",
    target_master_key: normalizeMasterKey({ masterType: "ledger", name: ledgerName }),
    target_master_name: ledgerName,
  };
}



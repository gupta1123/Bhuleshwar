import type { TallyMasterOption, TallyPostingReview } from "./tally-purchase-posting";

export type PurchaseLedgerRole =
  | "purchase"
  | "cgst"
  | "sgst"
  | "igst"
  | "freight"
  | "tds_194q"
  | "transport_tds"
  | "cgst_tds"
  | "sgst_tds"
  | "igst_tds"
  | "tcs"
  | "round_off";

type SearchIndex = {
  byName: Map<string, TallyMasterOption>;
  rows: Array<{ option: TallyMasterOption; searchText: string }>;
};

const searchIndexes = new WeakMap<TallyMasterOption[], SearchIndex>();

function optionIdentity(option: TallyMasterOption) {
  return [option.name, option.parent, option.groupPath, option.taxType, option.gstDutyHead]
    .filter(Boolean)
    .join(" ");
}

export type PurchaseWithholdingRole = "194q" | "transport" | "cgst_tds" | "sgst_tds" | "igst_tds" | "tcs";

// Mirrors the server's check (isWithholdingLedger in purchase-posting.ts): a
// ledger only passes for a withholding role when its name/group says so.
export function isPurchaseWithholdingOption(option: TallyMasterOption, role: PurchaseWithholdingRole) {
  const identity = optionIdentity(option);
  if (!/\b(tds|tcs)\b|withholding|tax\s+(?:deducted|collected)/i.test(identity)) return false;
  if (role === "194q") return /194q|0[.]?10/i.test(identity);
  if (role === "transport") return /transport|freight|goods\s+carriage/i.test(identity);
  if (role === "cgst_tds") return /cgst|central\s+tax/i.test(identity);
  if (role === "sgst_tds") return /sgst|state\s+tax/i.test(identity);
  if (role === "igst_tds") return /igst|integrated\s+tax/i.test(identity);
  return /\btcs\b|tax\s+collected/i.test(identity);
}

function normalizeUnitFamily(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (["mt", "mts", "metricton", "metrictons", "tonne", "tonnes"].includes(normalized)) {
    return "metricton";
  }
  return normalized;
}

function topScoredOptions(
  scored: Array<{ option: TallyMasterOption; score: number }>,
  minimumScore = 100,
  limit = 8
) {
  const top: Array<{ option: TallyMasterOption; score: number }> = [];
  for (const entry of scored) {
    if (entry.score < minimumScore) continue;
    const index = top.findIndex((current) =>
      entry.score > current.score ||
      (entry.score === current.score && entry.option.name.localeCompare(current.option.name) < 0)
    );
    if (index < 0) top.push(entry);
    else top.splice(index, 0, entry);
    if (top.length > limit) top.pop();
  }
  return top;
}

function searchIndex(options: TallyMasterOption[]) {
  const cached = searchIndexes.get(options);
  if (cached) return cached;
  const rows = options.map((option) => ({
    option,
    searchText: [
      option.name,
      option.parent,
      option.groupPath,
      option.gstin,
      option.hsnCode,
      option.unitName,
      option.taxRate,
      option.closingBalance,
      option.closingBalanceType,
    ]
      .filter((item) => item !== null && item !== undefined)
      .join(" ")
      .toLowerCase(),
  }));
  const index = {
    byName: new Map(options.map((option) => [option.name.trim().toLowerCase(), option])),
    rows,
  };
  searchIndexes.set(options, index);
  return index;
}

export function selectedMasterOption(options: TallyMasterOption[], value: string) {
  return searchIndex(options).byName.get(value.trim().toLowerCase()) ?? null;
}

export function searchPurchaseMasterOptions(
  options: TallyMasterOption[],
  suggestedNames: string[],
  search: string,
  limit = 80
) {
  const index = searchIndex(options);
  const query = search.trim().toLowerCase();
  const result: TallyMasterOption[] = [];
  const seen = new Set<string>();
  if (!query) {
    for (const name of suggestedNames) {
      const option = index.byName.get(name.trim().toLowerCase());
      if (option && !seen.has(option.id)) {
        seen.add(option.id);
        result.push(option);
      }
    }
  }
  for (const row of index.rows) {
    if (query && !row.searchText.includes(query)) continue;
    if (seen.has(row.option.id)) continue;
    seen.add(row.option.id);
    result.push(row.option);
    if (result.length > limit) break;
  }
  return { visibleOptions: result.slice(0, limit), hasMore: result.length > limit };
}

export function rankPurchaseLedgerRole(
  options: TallyMasterOption[],
  role: PurchaseLedgerRole,
  expectedRate = 0,
  aiCandidates: string[] = []
) {
  const aiNames = new Set(aiCandidates.map((name) => name.trim().toLowerCase()));
  const scored: Array<{ option: TallyMasterOption; score: number }> = [];
  for (const option of options) {
    const identity = optionIdentity(option);
    let value = aiNames.has(option.name.trim().toLowerCase()) ? 300 : 0;
    if (role === "purchase") {
      if (/purchase\s+accounts?/i.test(identity)) value += 120;
      else if (/\bpurchase\b/i.test(identity)) value += 80;
      if (/direct\s+expenses?/i.test(identity)) value += 25;
      if (/\b(sales|output|bank|cash|sundry\s+(?:debtors?|creditors?))\b/i.test(identity)) value -= 120;
    } else if (["cgst", "sgst", "igst"].includes(role)) {
      const component = role === "cgst"
        ? /\bcgst\b|central\s+tax/i
        : role === "sgst"
          ? /\bsgst\b|state\s+tax/i
          : /\bigst\b|integrated\s+tax/i;
      if (component.test(identity)) value += 120;
      if (/\b(input|itc|purchase)\b/i.test(identity)) value += 50;
      if (/\b(output|sales)\b/i.test(identity)) value -= 150;
      if (option.taxRate !== null && expectedRate > 0 && Math.abs(option.taxRate - expectedRate) < 0.001) value += 30;
    } else if (role === "freight") {
      if (/freight|transportation\s+inward/i.test(identity)) value += 130;
      if (/direct\s+expenses?|purchase/i.test(identity)) value += 25;
    } else if (role === "tds_194q") {
      if (/\btds\b|withholding|tax\s+deducted/i.test(identity)) value += 80;
      if (/194q|0[.]?10/i.test(identity)) value += 100;
    } else if (role === "transport_tds") {
      if (/\btds\b|withholding|tax\s+deducted/i.test(identity)) value += 80;
      if (/transport|freight|goods\s+carriage/i.test(identity)) value += 100;
    } else if (["cgst_tds", "sgst_tds", "igst_tds"].includes(role)) {
      if (/\btds\b|withholding|tax\s+deducted/i.test(identity)) value += 80;
      const component = role === "cgst_tds"
        ? /\bcgst\b|central\s+tax/i
        : role === "sgst_tds"
          ? /\bsgst\b|state\s+tax/i
          : /\bigst\b|integrated\s+tax/i;
      if (component.test(identity)) value += 100;
    } else if (role === "tcs") {
      if (/\btcs\b|tax\s+collected/i.test(identity)) value += 150;
      if (/receivable/i.test(identity)) value += 25;
    } else if (role === "round_off" && /round[\s-]*off/i.test(identity)) {
      value += 150;
    }
    scored.push({ option, score: value });
  }
  const suggested = topScoredOptions(scored);
  return { options, suggestedNames: suggested.map((entry) => entry.option.name) };
}

export function rankPurchaseStockItems(
  options: TallyMasterOption[],
  line: TallyPostingReview["lines"][number],
  aiCandidates: string[]
) {
  const aiNames = new Set(aiCandidates.map((name) => name.trim().toLowerCase()));
  const normalizedHsn = line.hsn.replace(/\D/g, "");
  const descriptionTokens = line.description.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const scored: Array<{ option: TallyMasterOption; score: number }> = [];
  for (const option of options) {
    let score = aiNames.has(option.name.trim().toLowerCase()) ? 300 : 0;
    if (normalizedHsn && option.hsnCode?.replace(/\D/g, "") === normalizedHsn) score += 140;
    const identity = optionIdentity(option).toLowerCase();
    for (const token of descriptionTokens) if (identity.includes(token)) score += 15;
    if (line.unit && option.unitName && normalizeUnitFamily(line.unit) === normalizeUnitFamily(option.unitName)) score += 20;
    scored.push({ option, score });
  }
  const suggested = topScoredOptions(scored);
  return { options, suggestedNames: suggested.map((entry) => entry.option.name) };
}

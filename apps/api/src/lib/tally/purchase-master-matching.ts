import type { PurchasePostingMasterInput } from "@/lib/tally/purchase-posting";

export type PurchaseMasterSuggestion = {
  matchType: "direct_match" | "close_match" | "unresolved";
  masterName: string | null;
  candidateMasterNames: string[];
  confidence: number;
  reason: string;
};

export type PurchaseLineMasterSuggestion = {
  lineId: string;
  stockItem: PurchaseMasterSuggestion;
  purchaseLedger: PurchaseMasterSuggestion;
};

export type SupplierLedgerSuggestion = {
  matchType: "direct_match" | "close_match" | "unresolved";
  ledgerName: string | null;
  candidateLedgerNames: string[];
  confidence: number;
  reason: string;
};

const LEGAL_SUFFIXES = new Set([
  "co", "company", "inc", "incorporated", "limited", "llp", "ltd", "private", "pvt",
]);
const PURCHASE_EXCLUSIONS = /\b(sales?|bank|cash|creditors?|debtors?|gst|tds|tcs|tax|dut(?:y|ies)|round[ -]?off)\b/i;
const PURCHASE_SIGNAL = /\b(purchase|purchases|direct expenses?|raw materials?|scrap|sponge)\b/i;

function words(value: unknown, dropLegalSuffixes = false) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bm[\s.]+s\b/g, "ms")
    .replace(/\bo[\s.]+m[\s.]+s\b/g, "oms")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (["purchases", "purch"].includes(token)) return "purchase";
      if (["mts", "mt", "metricton", "metrictons"].includes(token)) return "mt";
      return token;
    })
    .filter((token) => !dropLegalSuffixes || !LEGAL_SUFFIXES.has(token));
}

function compact(value: unknown, dropLegalSuffixes = false) {
  return words(value, dropLegalSuffixes).join("");
}

function normalizeGstin(value: unknown) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function tokenSimilarity(left: unknown, right: unknown, dropLegalSuffixes = false) {
  const leftTokens = new Set(words(left, dropLegalSuffixes));
  const rightTokens = new Set(words(right, dropLegalSuffixes));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let common = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) common += 1;
  return (2 * common) / (leftTokens.size + rightTokens.size);
}

function editSimilarity(left: unknown, right: unknown, dropLegalSuffixes = false) {
  const a = compact(left, dropLegalSuffixes);
  const b = compact(right, dropLegalSuffixes);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function nameSimilarity(left: unknown, right: unknown, dropLegalSuffixes = false) {
  const leftCompact = compact(left, dropLegalSuffixes);
  const rightCompact = compact(right, dropLegalSuffixes);
  if (!leftCompact || !rightCompact) return 0;
  if (leftCompact === rightCompact) return 1;
  const containment = leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact) ? 0.88 : 0;
  return Math.max(
    containment,
    tokenSimilarity(left, right, dropLegalSuffixes),
    editSimilarity(left, right, dropLegalSuffixes)
  );
}

function uniqueMasters(masters: PurchasePostingMasterInput[]) {
  return Array.from(new Map(masters.map((master) => [compact(master.tally_name), master])).values());
}

function unresolved(reason: string, candidates: string[] = []): PurchaseMasterSuggestion {
  return {
    matchType: candidates.length >= 2 ? "close_match" : "unresolved",
    masterName: null,
    candidateMasterNames: candidates.slice(0, 8),
    confidence: 0,
    reason,
  };
}

function direct(master: PurchasePostingMasterInput, confidence: number, reason: string): PurchaseMasterSuggestion {
  return {
    matchType: "direct_match",
    masterName: master.tally_name,
    candidateMasterNames: [],
    confidence,
    reason,
  };
}

function rankNames<T extends { master: PurchasePostingMasterInput; score: number }>(rows: T[]) {
  return rows
    .filter((row) => row.score >= 0.42)
    .sort((left, right) => right.score - left.score || left.master.tally_name.localeCompare(right.master.tally_name));
}

function stockItemSuggestion(
  line: { description: string; hsn: string; unit: string },
  stockItems: PurchasePostingMasterInput[]
): PurchaseMasterSuggestion {
  const candidates = uniqueMasters(stockItems);
  const lineHsn = compact(line.hsn);
  const lineUnit = compact(line.unit);
  const exactNames = candidates.filter((master) => compact(master.tally_name) === compact(line.description));
  if (exactNames.length === 1) return direct(exactNames[0], 1, "Unique exact stock-item name in live Tally.");
  const exactHsn = lineHsn
    ? candidates.filter((master) => compact(master.hsn_code) === lineHsn)
    : [];
  const exactHsnAndUnit = lineUnit
    ? exactHsn.filter((master) => compact(master.unit_name) === lineUnit)
    : exactHsn;
  if (
    exactHsnAndUnit.length === 1 &&
    nameSimilarity(line.description, exactHsnAndUnit[0].tally_name) >= 0.35
  ) {
    return direct(exactHsnAndUnit[0], 0.97, "Unique HSN, unit and compatible item-name match in live Tally.");
  }

  const ranked = rankNames(candidates.map((master) => {
    const hsn = compact(master.hsn_code);
    const unit = compact(master.unit_name);
    const nameScore = nameSimilarity(line.description, master.tally_name);
    const hsnScore = lineHsn && hsn ? (lineHsn === hsn ? 1 : lineHsn.startsWith(hsn) || hsn.startsWith(lineHsn) ? 0.65 : 0) : 0;
    const unitScore = lineUnit && unit ? (lineUnit === unit ? 1 : 0) : 0;
    return {
      master,
      score: nameScore * 0.55 + hsnScore * 0.35 + unitScore * 0.1,
      nameScore,
      hsnScore,
      unitScore,
    };
  }));
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (
    best &&
    best.score >= 0.9 &&
    best.score - (runnerUp?.score ?? 0) >= 0.1 &&
    (best.nameScore >= 0.92 || (best.hsnScore === 1 && best.unitScore === 1 && best.nameScore >= 0.45))
  ) {
    return direct(best.master, best.score, "Unique HSN, unit and name match in live Tally.");
  }
  return unresolved(
    ranked.length ? "Live Tally has multiple plausible stock items; select one." : "No live Tally stock item is sufficiently supported.",
    ranked.slice(0, 6).map((row) => row.master.tally_name)
  );
}

function purchaseLedgerSuggestion(
  line: { description: string; supplierStateCode: string | null; buyerStateCode: string | null },
  ledgers: PurchasePostingMasterInput[]
): PurchaseMasterSuggestion {
  const candidates = uniqueMasters(ledgers).filter((master) => {
    const identity = `${master.tally_name} ${master.group_path ?? ""} ${master.parent_name ?? ""}`;
    return PURCHASE_SIGNAL.test(identity) && !PURCHASE_EXCLUSIONS.test(identity);
  });
  const local = Boolean(line.supplierStateCode && line.buyerStateCode && line.supplierStateCode === line.buyerStateCode);
  const ranked = rankNames(candidates.map((master) => {
    const identity = `${master.tally_name} ${master.group_path ?? ""} ${master.parent_name ?? ""}`;
    let score = nameSimilarity(line.description, identity) * 0.76;
    if (/\bpurchase\b/i.test(identity)) score += 0.14;
    const interstate = /\b(interstate|outside|o\.?m\.?s\.?)\b/i.test(identity);
    const localSignal = /\b(local|indigenous|m\.?s\.?)\b/i.test(identity);
    if (local && localSignal) score += 0.1;
    if (!local && interstate) score += 0.1;
    if (local && interstate) score -= 0.18;
    if (!local && localSignal && !interstate) score -= 0.08;
    return { master, score };
  }));
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best && best.score >= 0.82 && best.score - (runnerUp?.score ?? 0) >= 0.12) {
    return direct(best.master, Math.min(1, best.score), "Unique item, purchase-group and tax-territory match in live Tally.");
  }
  return unresolved(
    ranked.length ? "Live Tally has multiple plausible purchase ledgers; select one." : "No eligible live Purchase ledger is sufficiently supported.",
    ranked.slice(0, 6).map((row) => row.master.tally_name)
  );
}

export function suggestSupplierLedger(input: {
  supplierName: string;
  supplierGstin: string;
  ledgers: PurchasePostingMasterInput[];
}): SupplierLedgerSuggestion {
  const supplierGstin = normalizeGstin(input.supplierGstin);
  const ledgers = uniqueMasters(input.ledgers);
  const exactGstin = supplierGstin
    ? ledgers.filter((master) => normalizeGstin(master.gstin) === supplierGstin)
    : [];
  if (exactGstin.length === 1) {
    return { matchType: "direct_match", ledgerName: exactGstin[0].tally_name, candidateLedgerNames: [], confidence: 1, reason: "Unique GSTIN match in live Tally." };
  }

  const eligible = ledgers.filter((master) => {
    const candidateGstin = normalizeGstin(master.gstin);
    if (supplierGstin && candidateGstin && candidateGstin !== supplierGstin) return false;
    const group = `${master.group_path ?? ""} ${master.parent_name ?? ""}`;
    return !/\b(bank|cash|sales|purchase|tax|tds|tcs|gst|round[ -]?off)\b/i.test(group);
  });
  const exactNames = eligible.filter((master) => compact(master.tally_name, true) === compact(input.supplierName, true));
  if (exactNames.length === 1) {
    return { matchType: "direct_match", ledgerName: exactNames[0].tally_name, candidateLedgerNames: [], confidence: 0.99, reason: "Unique normalized supplier-name match in live Tally." };
  }

  const ranked = rankNames(eligible.map((master) => ({
    master,
    score: nameSimilarity(input.supplierName, master.tally_name, true),
  })));
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best && best.score >= 0.94 && best.score - (runnerUp?.score ?? 0) >= 0.08) {
    return { matchType: "direct_match", ledgerName: best.master.tally_name, candidateLedgerNames: [], confidence: best.score, reason: "Unique high-confidence supplier-name match in live Tally." };
  }
  const candidateLedgerNames = ranked.slice(0, 6).map((row) => row.master.tally_name);
  return {
    matchType: candidateLedgerNames.length >= 2 ? "close_match" : "unresolved",
    ledgerName: null,
    candidateLedgerNames,
    confidence: 0,
    reason: candidateLedgerNames.length ? "Live Tally has multiple plausible supplier ledgers; select one." : "No live supplier ledger is sufficiently supported.",
  };
}

export async function suggestPurchaseLineMasters(input: {
  lines: Array<{
    lineId: string;
    description: string;
    hsn: string;
    unit: string;
    supplierStateCode: string | null;
    buyerStateCode: string | null;
    needsStockItem: boolean;
    needsPurchaseLedger: boolean;
  }>;
  stockItems: PurchasePostingMasterInput[];
  ledgers: PurchasePostingMasterInput[];
}): Promise<PurchaseLineMasterSuggestion[]> {
  const stockItems = uniqueMasters(input.stockItems);
  const ledgers = uniqueMasters(input.ledgers);
  return input.lines.map((line) => ({
    lineId: line.lineId,
    stockItem: line.needsStockItem
      ? stockItemSuggestion(line, stockItems)
      : unresolved("A stock item is already selected."),
    purchaseLedger: line.needsPurchaseLedger
      ? purchaseLedgerSuggestion(line, ledgers)
      : unresolved("A purchase ledger is already selected."),
  }));
}

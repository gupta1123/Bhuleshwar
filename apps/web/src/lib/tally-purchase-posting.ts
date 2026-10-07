import { apiFetch } from "@/lib/api-client";
import { liveValidationMasterRow, liveValidationMetadata } from "@/lib/tally-purchase-live-envelope";
import { readPreferredTallyConnectionId } from "@/lib/tally-company-selection";

export type TallyPostingIssue = {
  code: string;
  label: string;
  message: string;
  scope: "case" | "company" | "invoice" | "line" | "tax" | "source";
  lineId?: string;
  requiresAcknowledgement?: boolean;
  policyRule?: string;
  suggestion?: string;
};

export type TallyPostingLine = {
  lineId: string;
  description: string;
  hsn: string;
  quantity: string;
  unit: string;
  rate: string;
  taxableAmount: string;
  taxRate: string;
  stockItemName: string;
  purchaseLedgerName: string;
  godownName: string;
  batchName: string;
};

export type TallyPostingEwayBill = {
  record: boolean;
  number: string;
  date: string;
  fromAddress: string;
  fromPlace: string;
  fromPincode: string;
  fromState: string;
  toPlace: string;
  toPincode: string;
  toState: string;
  transportMode: string;
  vehicleNumber: string;
  distanceKm: string;
};

export type TallyPostingReview = {
  selectedInvoiceDocumentId: string;
  invoiceNumber: string;
  invoiceDate: string;
  voucherDate: string;
  supplierName: string;
  supplierGstin: string;
  buyerName: string;
  buyerGstin: string;
  vehicleNumber: string;
  invoiceTotal: string;
  gstRate: string;
  supplierLedgerName: string;
  cgstLedgerName: string;
  sgstLedgerName: string;
  igstLedgerName: string;
  freightAmount: string;
  freightGstRate: string;
  freightLedgerName: string;
  tds194qLedgerName: string;
  tds194qRate: string;
  applyTds194q: boolean;
  tds194qBasisAmount: string;
  tds194qRounding: "paise" | "nearest_rupee";
  applyTransportTds: boolean;
  applyGstTds: boolean;
  transportTdsLedgerName: string;
  transportTdsRate: string;
  cgstTdsLedgerName: string;
  sgstTdsLedgerName: string;
  igstTdsLedgerName: string;
  gstTdsRate: string;
  tdsLedgerName?: string;
  tdsRate?: string;
  tcsReceivable: boolean;
  tcsLedgerName: string;
  tcsAmount: string;
  roundOffLedgerName: string;
  roundOffAmount: string;
  sourceReferenceApproved: boolean;
  narration: string;
  // Supplier's e-way bill, recorded in Tally as reference (applicability No).
  ewayBill?: TallyPostingEwayBill | null;
  lines: TallyPostingLine[];
};

export type TallyPostingResponse = {
  liveMatchingComplete?: boolean;
  supplierLedgerMatch?: SupplierLedgerMatch;
  lineMasterMatches?: PurchaseLineMasterSuggestion[];
  caseStatus: string;
  hasSavedReview: boolean;
  accountingSettings: {
    purchaseGoodsTdsEnabled: boolean;
    transporterTdsEnabled: boolean;
    gstTdsEnabled: boolean;
    validationPolicy: Record<string, "block" | "warn" | "off">;
  };
  selectedConnectionId: string | null;
  selectedCompanyName: string | null;
  connectionOptions: Array<{
    id: string;
    connectionId: string;
    displayName: string;
    machineName: string | null;
    status: string;
    companyName: string | null;
    isActive: boolean;
    bridgeConnected: boolean;
    tallyReachable: boolean;
    companyLoaded: boolean;
    heartbeatStale: boolean;
    connectorUpdateRequired: boolean;
    lastHeartbeatAt: string | null;
    lastError: string | null;
  }>;
  posting: null | {
    id: string;
    caseId: string;
    connectionId: string | null;
    commandId: string | null;
    status: string;
    revision: number;
    companyName: string | null;
    companyGstin: string | null;
    invoiceNumber: string | null;
    supplierGstin: string | null;
    approvedAt: string | null;
    queuedAt: string | null;
    tallyVoucherNumber: string | null;
    tallyMasterId: string | null;
    tallyGuid: string | null;
    tallyCreatedAt: string | null;
    verifiedAt: string | null;
    verificationResult: Record<string, unknown>;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  };
  eligibility: {
    eligible: boolean;
    canonicalInvoiceCount: number;
    invoiceCandidates: Array<{
      documentId: string;
      invoiceNumber: string;
      invoiceDate: string;
      supplierName: string;
      supplierGstin: string;
      buyerName: string;
      buyerGstin: string;
      sourceFileName: string | null;
      role: "kalika_facing" | "mother_bill" | "other";
      recommended: boolean;
      reason: string;
    }>;
  };
  connection: null | {
    id: string;
    displayName: string;
    machineName: string | null;
    status: string;
    companyName: string | null;
    activeCompanyName: string | null;
    bridgeConnected: boolean;
    tallyReachable: boolean | null;
    companyLoaded: boolean | null;
    heartbeatStale: boolean;
    connectorUpdateRequired: boolean;
    lastError: string | null;
    lastHeartbeatAt: string | null;
    masterSyncRunId: string | null;
    masterSyncedAt: string | null;
    masterValidatedAt: string | null;
    masterSnapshotFresh: boolean;
    masterSnapshotComplete: boolean;
    masterTotals: Record<string, unknown>;
    masterSource: "live_purchase" | "synced_fallback" | null;
    companyGstin: string | null;
    companyStateCode: string | null;
  };
  sourceFileId: string | null;
  sourceDocumentReference: string | null;
  source: null | {
    documentId: string;
    documentType: string;
    lineSourceDocumentId: string;
    lineSourceDocumentType: string;
    lineRecovery: "invoice" | "linked_document";
    sourceFileName: string | null;
    sourceHint: string | null;
    invoiceNumber: string;
    invoiceDate: string;
    supplierName: string;
    supplierGstin: string;
    buyerName: string;
    buyerGstin: string;
    vehicleNumber: string;
    invoiceTaxableAmount: string;
    invoiceTaxRate: string;
    invoiceTaxAmount: string;
    invoiceTotal: string;
    invoiceTdsAmount: string;
    invoiceTdsRate: string;
    invoiceFreightAmount: string;
    invoiceFreightGstRate: string;
    invoiceTds194qAmount: string;
    invoiceTds194qRate: string;
    invoiceTransportTdsAmount: string;
    invoiceTransportTdsRate: string;
    invoiceCgstTdsAmount: string;
    invoiceSgstTdsAmount: string;
    invoiceIgstTdsAmount: string;
    invoiceGstTdsRate: string;
    invoiceTcsAmount: string;
    invoiceRoundOffAmount: string;
    godownName: string;
    batchName: string;
    lines: Array<TallyPostingLine & {
      material: "ms_scrap" | "sponge_iron" | "unknown";
      materialLabel: string;
      invoiceCgstAmount: string;
      invoiceSgstAmount: string;
      invoiceIgstAmount: string;
      invoiceTaxAmount: string;
      sourcePage: number | null;
    }>;
  };
  review: TallyPostingReview | null;
  calculation: null | {
    calculationVersion: number;
    taxMode: "cgst_sgst" | "igst" | "unknown";
    gstRate: string;
    supplierStateCode: string | null;
    buyerStateCode: string | null;
    basicAmount: string;
    freightAmount: string;
    gstTaxableAmount: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
    gstAmount: string;
    taxBuckets: Array<{ kind: "cgst" | "sgst" | "igst"; rate: string; taxableBasis: string; amount: string }>;
    invoiceGstAmount: string;
    gstDifference: string;
    tdsAmount: string;
    tds194qAmount: string;
    tds194qBasisAmount: string;
    tds194qRounding: "paise" | "nearest_rupee";
    transportTdsAmount: string;
    transportTdsCalculatedAmount: string;
    transportTdsDifference: string;
    cgstTdsAmount: string;
    sgstTdsAmount: string;
    igstTdsAmount: string;
    gstTdsBasisAmount: string;
    gstTdsRate: string;
    gstTdsAutomatic: boolean;
    scrapGstTdsEligible: boolean;
    totalWithholdingAmount: string;
    tcsAmount: string;
    roundOffAmount: string;
    calculatedInvoiceTotal: string;
    calculatedPayable: string;
    invoiceTotal: string;
    totalDifference: string;
  };
  blockers: TallyPostingIssue[];
  warnings: TallyPostingIssue[];
  tallyPayload: Record<string, unknown> | null;
  readyForApproval: boolean;
  masterOptions: {
    ledgers: TallyMasterOption[];
    stockItems: TallyMasterOption[];
    units: TallyMasterOption[];
    godowns: TallyMasterOption[];
  };
  events: Array<Record<string, unknown>>;
};

export type TallyMasterOption = {
  id: string;
  type: string;
  key: string;
  name: string;
  parent: string | null;
  gstin: string | null;
  hsnCode: string | null;
  unitName: string | null;
  taxRate: number | null;
  groupPath: string | null;
  taxType: string | null;
  gstDutyHead: string | null;
  closingBalance: number | null;
  closingBalanceType: "Dr" | "Cr" | null;
  decimalPlaces: number | null;
};

export type SupplierLedgerMatch = {
  matchType: "direct_match" | "close_match" | "suspense";
  ledgerName: string | null;
  candidateLedgerNames: string[];
  confidence: number;
  reason: string | null;
};

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

function liveRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function liveText(value: unknown) {
  if (typeof value !== "string") return null;
  let decoded = value;
  // Older connector catalogues can contain Tally's encoded hierarchy control
  // marker, sometimes escaped more than once before it reaches the browser.
  for (let index = 0; index < 5; index += 1) {
    const next = decoded
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
        const parsed = Number.parseInt(code, 16);
        return Number.isFinite(parsed) && parsed >= 32 ? String.fromCodePoint(parsed) : " ";
      })
      .replace(/&#(\d+);/g, (_, code: string) => {
        const parsed = Number.parseInt(code, 10);
        return Number.isFinite(parsed) && parsed >= 32 ? String.fromCodePoint(parsed) : " ";
      })
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">");
    if (next === decoded) break;
    decoded = next;
  }
  const cleaned = decoded
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s*_\s*>\s*/g, " > ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function liveNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function liveKey(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function liveWords(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bm[\s.]+s\b/g, "ms")
    .replace(/\bo[\s.]+m[\s.]+s\b/g, "oms")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !["and", "the", "for", "from"].includes(token));
}

function liveTokenAffinity(left: unknown, right: unknown) {
  const leftTokens = new Set(liveWords(left));
  const rightTokens = new Set(liveWords(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let common = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) common += 1;
  return (2 * common) / (leftTokens.size + rightTokens.size);
}

/**
 * Keeps the complete live catalogue in browser memory for dropdown search,
 * while producing a small accounting-only subset for server validation.
 */
export function prepareLiveTallyCatalogue(
  resultValue: unknown,
  review?: TallyPostingReview | null
): { compactResult: unknown; masterOptions: TallyPostingResponse["masterOptions"] } {
  const result = liveRecord(resultValue);
  const masters = liveRecord(result?.masters);
  if (!result || result.source !== "live_tally" || !masters) {
    throw new Error("The connector returned an invalid live Tally catalogue.");
  }
  const groups = Array.isArray(masters.groups) ? masters.groups : [];
  const groupParentByName = new Map<string, string | null>();
  for (const value of groups) {
    const row = liveRecord(value);
    const name = liveText(row?.name);
    if (name) groupParentByName.set(liveKey(name), liveText(row?.parent));
  }
  const groupPath = (parentValue: unknown) => {
    const values: string[] = [];
    const seen = new Set<string>();
    let current = liveText(parentValue);
    while (current && values.length < 20) {
      const key = liveKey(current);
      if (!key || seen.has(key)) break;
      seen.add(key);
      values.unshift(current);
      current = groupParentByName.get(key) ?? null;
    }
    return values.join(" > ") || null;
  };
  const convert = (values: unknown, type: "ledger" | "stock_item" | "unit" | "godown") =>
    (Array.isArray(values) ? values : []).flatMap((value, index) => {
      const row = liveRecord(value);
      const name = liveText(row?.name);
      if (!row || !name) return [];
      const raw = liveRecord(row.raw) ?? {};
      const balance = liveNumber(row.closingBalance ?? raw.closingBalance);
      const balanceType = liveText(row.closingBalanceType ?? raw.closingBalanceType);
      return [{
        id: liveText(row.guid) ?? `live:${type}:${index}:${liveKey(name)}`,
        type,
        key: liveText(row.guid) ?? liveKey(name),
        name,
        parent: liveText(row.parent),
        gstin: liveText(row.gstin),
        hsnCode: liveText(row.hsnCode),
        unitName: liveText(row.unitName),
        taxRate: liveNumber(row.taxRate),
        groupPath: groupPath(row.parent),
        taxType: liveText(row.taxType ?? raw.taxType),
        gstDutyHead: liveText(row.gstDutyHead ?? raw.gstDutyHead),
        closingBalance: balance,
        closingBalanceType: balanceType === "Dr" || balanceType === "Cr" ? balanceType : null,
        decimalPlaces: liveNumber(row.decimalPlaces ?? raw.decimalPlaces),
      } satisfies TallyMasterOption];
    });
  const ledgerRows = Array.isArray(masters.ledgers) ? masters.ledgers : [];
  const ledgerOptions = convert(ledgerRows, "ledger");
  const stockItemOptions = convert(masters.stockItems, "stock_item");
  const unitOptions = convert(masters.units, "unit");
  const godownOptions = convert(masters.godowns, "godown");

  const selectedNames = new Set([
    review?.supplierLedgerName,
    review?.cgstLedgerName,
    review?.sgstLedgerName,
    review?.igstLedgerName,
    review?.freightLedgerName,
    review?.tds194qLedgerName,
    review?.transportTdsLedgerName,
    review?.cgstTdsLedgerName,
    review?.sgstTdsLedgerName,
    review?.igstTdsLedgerName,
    review?.tcsLedgerName,
    review?.roundOffLedgerName,
    ...(review?.lines ?? []).map((line) => line.purchaseLedgerName),
  ].filter((value): value is string => Boolean(value?.trim())).map(liveKey));
  const supplierName = liveKey(review?.supplierName);
  const supplierGstin = String(review?.supplierGstin ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const rankedSupplier = ledgerRows
    .map((value, index) => {
      const row = liveRecord(value);
      const name = liveText(row?.name) ?? "";
      const gstin = String(row?.gstin ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const nameKey = liveKey(name);
      const score = supplierGstin && gstin === supplierGstin
        ? 100
        : supplierName && nameKey === supplierName
          ? 90
          : supplierName && (nameKey.includes(supplierName) || supplierName.includes(nameKey))
            ? 70
            : 0;
      return { value, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
  type CompactLedgerCandidate = {
    value: unknown;
    index: number;
    key: string;
    name: string;
    identity: string;
  };
  const ledgerCandidates: CompactLedgerCandidate[] = ledgerRows.flatMap((value, index) => {
    const row = liveRecord(value);
    const name = liveText(row?.name);
    if (!row || !name) return [];
    const raw = liveRecord(row.raw) ?? {};
    const path = groupPath(row.parent);
    return [{
      value,
      index,
      key: liveKey(name),
      name,
      identity: [
        name,
        liveText(row.parent),
        path,
        liveText(row.taxType ?? raw.taxType),
        liveText(row.gstDutyHead ?? raw.gstDutyHead),
      ].filter(Boolean).join(" "),
    }];
  });
  const ledgerCandidateByIndex = new Map(
    ledgerCandidates.map((candidate) => [candidate.index, candidate])
  );
  const compactByName = new Map<string, unknown>();
  const addCandidates = (
    values: CompactLedgerCandidate[],
    limit: number,
    score: (candidate: CompactLedgerCandidate) => number = () => 0
  ) => {
    values
      .map((candidate) => ({ candidate, score: score(candidate) }))
      .sort((left, right) =>
        right.score - left.score ||
        left.candidate.name.localeCompare(right.candidate.name) ||
        left.candidate.index - right.candidate.index
      )
      .slice(0, limit)
      .forEach(({ candidate }) => compactByName.set(candidate.key, candidate.value));
  };
  const matching = (pattern: RegExp) =>
    ledgerCandidates.filter((candidate) => pattern.test(candidate.identity));
  const inputTaxScore = (candidate: CompactLedgerCandidate) =>
    Number(/\b(input|itc|purchase)\b/i.test(candidate.identity)) * 4 +
    Number(!/\b(output|sales)\b/i.test(candidate.identity)) * 2 +
    Number(/\b9\s*%?|9%\b/i.test(candidate.identity));
  const lineIdentity = (review?.lines ?? [])
    .map((line) => `${line.description} ${line.hsn}`)
    .join(" ");
  const purchaseScore = (candidate: CompactLedgerCandidate) =>
    liveTokenAffinity(lineIdentity, candidate.identity) * 10 +
    Number(/\bpurchase\b/i.test(candidate.name)) * 3 +
    Number(/\b(scrap|sponge|raw materials?)\b/i.test(candidate.identity)) * 2 +
    Number(/\b(indigenous|local|m\.?\s*s\.?)\b/i.test(candidate.identity));

  // Never let Tally's alphabetical/master order decide which accounting roles
  // reach server validation. Selected and supplier masters are guaranteed,
  // then each required voucher role receives a small independent allowance.
  addCandidates(
    ledgerCandidates.filter((candidate) => selectedNames.has(candidate.key)),
    Math.max(selectedNames.size, 1)
  );
  addCandidates(
    rankedSupplier.flatMap((entry) => {
      const candidate = ledgerCandidateByIndex.get(entry.index);
      return candidate ? [candidate] : [];
    }),
    12,
    (candidate) => rankedSupplier.find((entry) => entry.index === candidate.index)?.score ?? 0
  );
  addCandidates(
    ledgerCandidates.filter((candidate) =>
      /\b(purchase|purchases|direct expenses?|raw materials?|scrap|sponge)\b/i.test(candidate.identity) &&
      !/\b(sales?|bank|cash|gst|tds|tcs|tax|dut(?:y|ies)|round[ -]?off)\b/i.test(candidate.identity)
    ),
    32,
    purchaseScore
  );
  addCandidates(matching(/\b(cgst|central\s+tax)\b/i), 16, inputTaxScore);
  addCandidates(matching(/\b(sgst|state\s+tax)\b/i), 16, inputTaxScore);
  addCandidates(matching(/\b(igst|integrated\s+tax)\b/i), 16, inputTaxScore);
  addCandidates(matching(/\b194q\b|0[.]?10\s*%/i), 12);
  addCandidates(matching(/\b(cgst|central\s+tax)\b.*\btds\b|\btds\b.*\b(cgst|central\s+tax)\b/i), 12);
  addCandidates(matching(/\b(sgst|state\s+tax)\b.*\btds\b|\btds\b.*\b(sgst|state\s+tax)\b/i), 12);
  addCandidates(matching(/\b(igst|integrated\s+tax)\b.*\btds\b|\btds\b.*\b(igst|integrated\s+tax)\b/i), 12);
  addCandidates(matching(/\b(freight|transport|goods\s+carriage)\b/i), 16);
  addCandidates(matching(/\b(tcs|tax\s+collected)\b/i), 12);
  addCandidates(matching(/\bround[ -]?off\b|\broundoff\b/i), 12);
  addCandidates(
    matching(/\b(input|purchase|gst|tds|tcs|tax|dut(?:y|ies)|freight|transport|round[ -]?off|roundoff)\b/i),
    20
  );
  const ledgerOptionByName = new Map(ledgerOptions.map((option) => [liveKey(option.name), option]));
  const compactLedgers = Array.from(compactByName.keys()).flatMap((key) => {
    const option = ledgerOptionByName.get(key);
    return option ? [liveValidationMasterRow(option)] : [];
  });
  const selectedStockNames = new Set((review?.lines ?? [])
    .map((line) => liveKey(line.stockItemName))
    .filter(Boolean));
  const compactStockByName = new Map<string, TallyMasterOption>();
  for (const option of stockItemOptions) {
    if (selectedStockNames.has(liveKey(option.name))) compactStockByName.set(liveKey(option.name), option);
  }
  for (const line of review?.lines ?? []) {
    const identity = `${line.description} ${line.hsn} ${line.unit}`;
    stockItemOptions
      .map((option) => ({
        option,
        score:
          liveTokenAffinity(identity, `${option.name} ${option.parent || ""}`) * 10 +
          Number(Boolean(line.hsn) && String(option.hsnCode || "").replace(/\D/g, "") === String(line.hsn).replace(/\D/g, "")) * 8 +
          Number(Boolean(line.unit) && liveKey(option.unitName) === liveKey(line.unit)) * 3,
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.option.name.localeCompare(right.option.name))
      .slice(0, 12)
      .forEach(({ option }) => compactStockByName.set(liveKey(option.name), option));
  }
  const compactStockItems = Array.from(compactStockByName.values()).map(liveValidationMasterRow);
  const relevantUnits = new Set([
    ...(review?.lines ?? []).map((line) => liveKey(line.unit)),
    ...Array.from(compactStockByName.values()).map((option) => liveKey(option.unitName)),
  ].filter(Boolean));

  return {
    compactResult: {
      ...liveValidationMetadata(result),
      persisted: false,
      masters: {
        ledgers: compactLedgers,
        groups: [],
        stockItems: compactStockItems,
        units: unitOptions.filter((option) => relevantUnits.has(liveKey(option.name))).map(liveValidationMasterRow),
        // Godown lists are short. Send all of them: this envelope is built when
        // the catalogue loads, before the reviewer picks a godown, and the
        // server drops any godown it cannot find here.
        godowns: godownOptions.map(liveValidationMasterRow),
      },
    },
    masterOptions: {
      ledgers: ledgerOptions,
      stockItems: stockItemOptions,
      units: unitOptions,
      godowns: godownOptions,
    },
  };
}

/**
 * Approval only needs proof for the masters selected on this voucher. Keep the
 * full searchable catalogue in browser memory, but send a small validation
 * envelope through the hosted API proxy.
 */
export function prepareLiveTallyApprovalContext(
  resultValue: unknown,
  review: TallyPostingReview,
  masterOptions: TallyPostingResponse["masterOptions"]
) {
  const result = liveRecord(resultValue);
  const masters = liveRecord(result?.masters);
  if (!result || result.source !== "live_tally" || !masters) {
    throw new Error("Refresh the live Tally data before approving this voucher.");
  }

  const selectedLedgerNames = new Set([
    review.supplierLedgerName,
    review.cgstLedgerName,
    review.sgstLedgerName,
    review.igstLedgerName,
    review.freightLedgerName,
    review.tds194qLedgerName,
    review.transportTdsLedgerName,
    review.cgstTdsLedgerName,
    review.sgstTdsLedgerName,
    review.igstTdsLedgerName,
    review.tcsLedgerName,
    review.roundOffLedgerName,
    ...review.lines.map((line) => line.purchaseLedgerName),
  ].filter(Boolean).map(liveKey));
  const selectedStockItemNames = new Set(
    review.lines.map((line) => line.stockItemName).filter(Boolean).map(liveKey)
  );
  const selectedUnitNames = new Set(
    review.lines.map((line) => line.unit).filter(Boolean).map(liveKey)
  );
  const selectedGodownNames = new Set(
    review.lines.map((line) => line.godownName).filter(Boolean).map(liveKey)
  );

  const selectedRows = (
    options: TallyMasterOption[],
    selectedNames: Set<string>
  ) => {
    const rows = new Map<string, Record<string, unknown>>();
    for (const option of options) {
      const key = liveKey(option.name);
      if (!selectedNames.has(key)) continue;
      rows.set(key, liveValidationMasterRow(option));
    }
    return Array.from(rows.values());
  };

  const approvalContext = {
    ...liveValidationMetadata(result),
    persisted: false,
    masters: {
      ledgers: selectedRows(masterOptions.ledgers, selectedLedgerNames),
      groups: [],
      stockItems: selectedRows(
        masterOptions.stockItems,
        selectedStockItemNames
      ),
      units: selectedRows(masterOptions.units, selectedUnitNames),
      godowns: selectedRows(masterOptions.godowns, selectedGodownNames),
    },
  };

  if (JSON.stringify(approvalContext).length > 256 * 1024) {
    throw new Error("The selected Tally validation data is unexpectedly large. Refresh and try again.");
  }
  return approvalContext;
}

/**
 * The compact validation subset is built when the catalogue loads. Anything the
 * reviewer picks later must be added before each save, or the server cannot
 * find it and falls back to its own default for that field.
 */
export function withSelectedLiveMasters(
  compactValue: unknown,
  review: TallyPostingReview,
  masterOptions: TallyPostingResponse["masterOptions"] | null
) {
  const compact = liveRecord(compactValue);
  const masters = liveRecord(compact?.masters);
  if (!compact || !masters || !masterOptions) return compactValue;
  const selected = liveRecord(liveRecord(prepareLiveTallyApprovalContext(compact, review, masterOptions))?.masters) ?? {};
  const merge = (key: "ledgers" | "stockItems" | "units" | "godowns") => {
    const rows = new Map<string, unknown>();
    for (const value of [
      ...(Array.isArray(masters[key]) ? masters[key] as unknown[] : []),
      ...(Array.isArray(selected[key]) ? selected[key] as unknown[] : []),
    ]) {
      const name = liveKey(liveRecord(value)?.name);
      if (name) rows.set(name, value);
    }
    return Array.from(rows.values());
  };
  return {
    ...compact,
    masters: {
      ...masters,
      ledgers: merge("ledgers"),
      stockItems: merge("stockItems"),
      units: merge("units"),
      godowns: merge("godowns"),
    },
  };
}

async function readResponse(response: Response, fallback: string) {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : raw || fallback);
  }
  return payload as unknown as TallyPostingResponse;
}

export async function fetchTallyPurchasePosting(
  caseId: string,
  connectionId?: string | null,
  companyName?: string | null
) {
  const preferredConnectionId =
    connectionId || readPreferredTallyConnectionId();
  const params = new URLSearchParams();
  if (preferredConnectionId) params.set("connectionId", preferredConnectionId);
  if (companyName) params.set("companyName", companyName);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await apiFetch(`/api/cases/${caseId}/tally-posting${query}`, { cache: "no-store" });
  return readResponse(response, "Failed to load Tally posting review.");
}

export async function saveTallyPurchasePosting(
  caseId: string,
  review: TallyPostingReview,
  connectionId: string,
  companyName: string,
  liveMasters?: unknown
) {
  const response = await apiFetch(`/api/cases/${caseId}/tally-posting`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ review, connectionId, companyName, liveMasters, compactResponse: true }),
  });
  return readResponse(response, "Failed to save Tally posting review.");
}

export async function selectTallyPurchaseInvoice(
  caseId: string,
  selectedInvoiceDocumentId: string,
  connectionId: string,
  companyName: string,
  liveMasters?: unknown
) {
  const response = await apiFetch(`/api/cases/${caseId}/tally-posting`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      review: { selectedInvoiceDocumentId },
      connectionId,
      companyName,
      liveMasters,
      compactResponse: true,
    }),
  });
  return readResponse(response, "Failed to select the purchase invoice.");
}

export async function approveAndQueueTallyPurchasePosting(
  caseId: string,
  acknowledgedWarningCodes: string[] = [],
  allowedBlockerKeys: string[] = [],
  connectionId?: string | null,
  companyName?: string | null,
  liveMasters?: unknown,
  workflowRevision?: number
) {
  const response = await apiFetch(`/api/cases/${caseId}/tally-posting`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "approve_and_queue",
      workflowRevision,
      acknowledgedWarningCodes,
      allowedBlockerKeys,
      connectionId,
      companyName,
      liveMasters,
      compactResponse: true,
    }),
  });
  return readResponse(response, "Failed to queue the Purchase voucher.");
}

export async function verifyExistingTallyPurchaseVoucher(
  caseId: string,
  connectionId?: string | null,
  companyName?: string | null
) {
  const response = await apiFetch(`/api/cases/${caseId}/tally-posting`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "verify_existing",
      connectionId,
      companyName,
      compactResponse: true,
    }),
  });
  return readResponse(response, "Failed to verify the existing Purchase voucher.");
}

export async function prepareTallyPurchasePostingFromLive(
  caseId: string,
  connectionId: string,
  companyName: string,
  liveMasters: unknown,
  allowStalePreview = false
) {
  const response = await apiFetch(`/api/cases/${caseId}/tally-posting`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "prepare_live_context",
      connectionId,
      companyName,
      liveMasters,
      allowStalePreview,
      compactResponse: true,
    }),
  });
  return readResponse(response, "Failed to prepare the live Tally review.");
}

export async function matchTallyPurchaseSupplierLedger(
  caseId: string,
  input: {
    connectionId: string;
    companyName: string;
    supplierName: string;
    supplierGstin: string;
    liveMasters: unknown;
  }
) {
  const response = await apiFetch(`/api/cases/${caseId}/tally-posting`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "match_supplier_ledger", ...input }),
  });
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : raw || "Failed to match the supplier ledger.");
  }
  return (payload as { supplierLedgerMatch: SupplierLedgerMatch }).supplierLedgerMatch;
}

export async function matchTallyPurchaseLineMasters(
  caseId: string,
  input: {
    connectionId: string;
    companyName: string;
    review: TallyPostingReview;
    liveMasters: unknown;
  }
) {
  const response = await apiFetch(`/api/cases/${caseId}/tally-posting`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "match_purchase_masters", ...input }),
  });
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { payload = {}; }
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : raw || "Failed to match Purchase masters.");
  }
  return ((payload as { lineMasterMatches?: PurchaseLineMasterSuggestion[] }).lineMasterMatches ?? []);
}

export async function queueTallyMasterRefresh(connectionId: string, companyName: string) {
  const response = await apiFetch(`/api/tally/connections/${connectionId}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commandType: "fetch_purchase_masters",
      payload: {
        companyName,
      },
    }),
  });
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { payload = {}; }
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : raw || "Failed to refresh Tally masters.");
  }
  return payload;
}

export async function waitForTallyCommand(
  connectionId: string,
  commandId: string,
  options?: { attempts?: number; intervalMs?: number; onProgress?: (phase: string) => void }
) {
  const attempts = options?.attempts ?? 45;
  const intervalMs = options?.intervalMs ?? 2000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
    const response = await apiFetch(
      `/api/tally/connections/${connectionId}/commands/${commandId}`,
      { cache: "no-store" }
    );
    const raw = await response.text();
    let payload: {
      command?: {
        id: string;
        status: string;
        result?: Record<string, unknown> | null;
        error?: string | null;
        completedAt?: string | null;
        updatedAt?: string | null;
        compactProgress?: { phase?: string | null } | null;
      } | null;
    } = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      throw new Error(raw || "Failed to read Tally command status.");
    }
    const command = payload.command;
    if (!command) continue;
    if (command.compactProgress?.phase) options?.onProgress?.(command.compactProgress.phase);
    if (["succeeded", "failed", "canceled"].includes(command.status)) return command;
  }
  return null;
}

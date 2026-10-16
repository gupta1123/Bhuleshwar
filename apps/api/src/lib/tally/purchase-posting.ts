import { readStoredLineItems } from "@/lib/line-items";
import { extractInvoiceCommercialFieldsFromText } from "@/lib/invoice-commercial-fields";
import type {
  PurchaseAccountingSettings,
  PurchaseValidationPolicy,
  PurchaseValidationRuleKey,
} from "@/lib/purchase-accounting-settings";
import type { CommercialLineItem } from "@/types/pipeline";
import {
  calculatePurchaseVoucher,
  PURCHASE_CALCULATION_VERSION,
} from "@autodealer/shared/lib/purchase-voucher";

export type PurchasePostingStatus =
  | "draft"
  | "correction_required"
  | "ready_for_approval"
  | "approved"
  | "queued"
  | "creating"
  | "created"
  | "verification_required"
  | "failed";

export type PurchasePostingIssue = {
  code: string;
  label: string;
  message: string;
  scope: "case" | "company" | "invoice" | "line" | "tax" | "source";
  lineId?: string;
  requiresAcknowledgement?: boolean;
  policyRule?: PurchaseValidationRuleKey;
  // A live Tally master that would resolve this issue (offered as one click).
  suggestion?: string;
};

export type PurchasePostingDocumentInput = {
  id: string;
  document_type: string;
  source_file_name: string | null;
  source_hint: string | null;
  title: string;
  extracted_fields: unknown;
  markdown?: string | null;
};

export type PurchasePostingMasterInput = {
  id: string;
  master_type: string;
  master_key: string;
  tally_guid?: string | null;
  tally_name: string;
  parent_name: string | null;
  gstin: string | null;
  hsn_code: string | null;
  unit_name: string | null;
  tax_rate: number | null;
  group_path?: string | null;
  raw_payload?: Record<string, unknown>;
  is_active: boolean;
};

export type PurchasePostingMappingInput = {
  mapping_type: string;
  source_key: string;
  target_master_type?: string | null;
  target_master_key?: string | null;
  target_master_name: string;
  status: string;
};

export type PurchasePostingReviewLine = {
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

export type PurchasePostingReview = {
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
  // Supplier's e-way bill, recorded on the voucher as reference only
  // (Tally's e-way bill applicability stays No). Null when the case has none.
  ewayBill: PurchaseEwayBill | null;
  lines: PurchasePostingReviewLine[];
};

export type PurchaseEwayBill = {
  record: boolean;
  number: string;
  date: string;
  fromAddress: string;
  fromPlace: string;
  fromPincode: string;
  fromState: string;
  // Fallbacks from the e-way bill's Ship To; the connector prefers the
  // company's own address and PIN from Tally.
  toPlace: string;
  toPincode: string;
  toState: string;
  transportMode: string;
  vehicleNumber: string;
  distanceKm: string;
};

type PurchasePostingSourceLine = PurchasePostingReviewLine & {
  material: "ms_scrap" | "sponge_iron" | "unknown";
  materialLabel: string;
  invoiceCgstAmount: string;
  invoiceSgstAmount: string;
  invoiceIgstAmount: string;
  invoiceTaxAmount: string;
  sourcePage: number | null;
};

export type PurchasePostingSource = {
  ewayBill: PurchaseEwayBill | null;
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
  lines: PurchasePostingSourceLine[];
};

export type PurchasePostingCalculation = {
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

export type PurchaseInvoiceCandidate = {
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
};

export type PurchasePostingPrepared = {
  eligible: boolean;
  canonicalInvoiceCount: number;
  invoiceCandidates: PurchaseInvoiceCandidate[];
  source: PurchasePostingSource | null;
  review: PurchasePostingReview | null;
  calculation: PurchasePostingCalculation | null;
  blockers: PurchasePostingIssue[];
  warnings: PurchasePostingIssue[];
  tallyPayload: Record<string, unknown> | null;
  suggestedStatus: "draft" | "correction_required" | "ready_for_approval";
};

type PurchasePostingReviewPatch = Omit<Partial<PurchasePostingReview>, "lines"> & {
  lines?: Array<Partial<PurchasePostingReviewLine> & Pick<PurchasePostingReviewLine, "lineId">>;
};

const TAX_TOLERANCE_PAISE = 0;
const TOTAL_TOLERANCE_PAISE = 0;
const MAX_ROUND_OFF_PAISE = 100;
const SCRAP_GST_TDS_EFFECTIVE_DATE = "2024-10-10";
const GST_TDS_CONTRACT_THRESHOLD_PAISE = 250_000 * 100;
const DEFAULT_PURCHASE_VALIDATION_POLICY: PurchaseValidationPolicy = {
  companyGstinMissing: "warn",
  companyGstinInvalid: "warn",
  buyerGstinMissing: "warn",
  supplierGstinMissing: "warn",
  buyerCompanyGstinMismatch: "block",
  supplierLedgerGstinMismatch: "block",
  hsnMissing: "warn",
  stockItemHsnMismatch: "warn",
  stockItemUnitMismatch: "warn",
  sourceDocumentMissing: "warn",
  caseNotAccepted: "block",
  staleTallyMasters: "warn",
  possibleDuplicate: "block",
};

function text(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function fieldsOf(document: PurchasePostingDocumentInput) {
  return document.extracted_fields &&
    typeof document.extracted_fields === "object" &&
    !Array.isArray(document.extracted_fields)
    ? (document.extracted_fields as Record<string, unknown>)
    : {};
}

function normalizeKey(value: unknown) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeGstin(value: unknown) {
  return text(value).toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function normalizeHsn(value: unknown) {
  const digits = text(value).replace(/\D/g, "");
  return digits.slice(0, 8);
}

function stateCodeFromGstin(value: unknown) {
  const gstin = normalizeGstin(value);
  return /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null;
}

export function normalizePurchasePostingDate(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/);
  if (iso) return iso[1];
  // E-Way Bills commonly expose their document date together with a time,
  // for example "11/08/2026 08:57 PM". Keep the visible calendar date while
  // discarding only the time suffix.
  const parts = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:$|[T\s].*)/);
  if (parts) {
    const year = parts[3].length === 2 ? `20${parts[3]}` : parts[3];
    return `${year}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  }
  const named = raw.match(
    /^(\d{1,2})[\s./-]+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s,./-]+(\d{2,4})(?:$|[T\s].*)/i
  );
  if (!named) return raw;
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = monthNames.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
  const year = named[3].length === 2 ? `20${named[3]}` : named[3];
  return `${year}-${String(month).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
}

const parseDate = normalizePurchasePostingDate;

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function parseScaled(value: unknown, scale: number) {
  const normalized = text(value).replace(/,/g, "").replace(/[^0-9.+-]/g, "");
  const match = normalized.match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
  if (!match || (!match[2] && !match[3])) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const whole = Number(match[2] || "0");
  if (!Number.isSafeInteger(whole)) return null;
  const decimals = Math.max(0, Math.round(Math.log10(scale)));
  const fractionSource = (match[3] || "").padEnd(decimals + 1, "0");
  const fraction = Number(fractionSource.slice(0, decimals) || "0");
  const roundDigit = Number(fractionSource[decimals] || "0");
  const result = whole * scale + fraction + (roundDigit >= 5 ? 1 : 0);
  return Number.isSafeInteger(result) ? sign * result : null;
}

function moneyPaise(value: unknown) {
  return parseScaled(value, 100);
}

function quantityMillis(value: unknown) {
  return parseScaled(value, 1000);
}

function rateBasisPoints(value: unknown) {
  return parseScaled(value, 100);
}

function formatPaise(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(value));
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function sum(values: Array<number | null>) {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function calculateLineTaxable(line: PurchasePostingReviewLine) {
  const explicit = moneyPaise(line.taxableAmount);
  if (explicit !== null) return explicit;
  const quantity = quantityMillis(line.quantity);
  const rate = moneyPaise(line.rate);
  if (quantity === null || rate === null) return null;
  return Math.round((quantity * rate) / 1000);
}

function normalizeUnit(value: unknown) {
  const normalized = normalizeKey(value);
  if (["mt", "mts", "metricton", "metrictons", "tonne", "tonnes"].includes(normalized)) {
    return "metricton";
  }
  return normalized;
}

function materialFromHsn(hsnValue: string) {
  const hsn = normalizeHsn(hsnValue);
  if (hsn.startsWith("7204")) {
    return { material: "ms_scrap" as const, label: "MS Scrap", suggestedStockItem: "M S Scrap & Sponge Iron" };
  }
  if (hsn === "72031000") {
    return { material: "sponge_iron" as const, label: "Sponge Iron", suggestedStockItem: "M S Scrap & Sponge Iron" };
  }
  return { material: "unknown" as const, label: "Manual selection required", suggestedStockItem: "" };
}

function invoiceIdentity(document: PurchasePostingDocumentInput) {
  const fields = fieldsOf(document);
  const invoiceNumber = normalizeKey(fields.invoiceNumber || fields.referenceInvoiceNumber);
  const supplier = normalizeGstin(fields.supplierGstin) || normalizeKey(fields.vendorName);
  const buyer = normalizeGstin(fields.buyerGstin) || normalizeKey(fields.buyerName);
  return invoiceNumber && (supplier || buyer)
    ? `${invoiceNumber}:${supplier}:${buyer}`
    : `document:${document.id}`;
}

function invoiceCompleteness(document: PurchasePostingDocumentInput) {
  const fields = fieldsOf(document);
  return Object.values(fields).filter((value) => text(value)).length +
    readStoredLineItems(document.extracted_fields).length * 10 +
    Math.min(10, Math.floor(text(document.markdown).length / 500));
}

export function getCanonicalInvoiceDocuments(documents: PurchasePostingDocumentInput[]) {
  const invoiceDocuments = documents.filter((document) => /invoice/i.test(document.document_type));
  const byIdentity = new Map<string, PurchasePostingDocumentInput>();
  for (const document of invoiceDocuments) {
    const key = invoiceIdentity(document);
    const current = byIdentity.get(key);
    if (!current || invoiceCompleteness(document) > invoiceCompleteness(current)) {
      byIdentity.set(key, document);
    }
  }
  return Array.from(byIdentity.values());
}

export function getPurchaseInvoiceCandidates(
  documents: PurchasePostingDocumentInput[],
  companyGstin?: string | null
): PurchaseInvoiceCandidate[] {
  const canonicalInvoices = getCanonicalInvoiceDocuments(documents);
  const activeCompanyGstin = normalizeGstin(companyGstin);

  return canonicalInvoices.map((document) => {
    const fields = fieldsOf(document);
    const supplierGstin = normalizeGstin(fields.supplierGstin);
    const buyerGstin = normalizeGstin(fields.buyerGstin);
    const isKalikaFacing = Boolean(activeCompanyGstin && buyerGstin === activeCompanyGstin);
    const isMotherBill = !isKalikaFacing && Boolean(
      buyerGstin && canonicalInvoices.some((candidate) => {
        if (candidate.id === document.id) return false;
        const candidateFields = fieldsOf(candidate);
        return normalizeGstin(candidateFields.supplierGstin) === buyerGstin &&
          normalizeGstin(candidateFields.buyerGstin) === activeCompanyGstin;
      })
    );
    const role: PurchaseInvoiceCandidate["role"] = isKalikaFacing
      ? "kalika_facing"
      : isMotherBill
        ? "mother_bill"
        : "other";

    return {
      documentId: document.id,
      invoiceNumber: text(fields.invoiceNumber || fields.referenceInvoiceNumber),
      invoiceDate: parseDate(fields.invoiceDate || fields.documentDate),
      supplierName: text(fields.vendorName || fields.supplierName),
      supplierGstin,
      buyerName: text(fields.buyerName),
      buyerGstin,
      sourceFileName: document.source_file_name,
      role,
      recommended: isKalikaFacing,
      reason: isKalikaFacing
        ? "Billed to the active Tally company"
        : isMotherBill
          ? "Upstream mother bill; its buyer becomes the seller on another invoice"
          : "Buyer does not match the active Tally company",
    };
  });
}

function supportingInvoiceReference(document: PurchasePostingDocumentInput) {
  const fields = fieldsOf(document);
  return text(fields.referenceInvoiceNumber || fields.invoiceNumber);
}

function documentTaxablePaise(document: PurchasePostingDocumentInput) {
  const fields = fieldsOf(document);
  const lines = readStoredLineItems(document.extracted_fields);
  const fromLines = sum(lines.map((line) => moneyPaise(line.taxableAmount)));
  const declaredCandidates = [
    moneyPaise(fields.totalTaxableAmount),
    moneyPaise(fields.subtotal),
  ].filter((value): value is number => value !== null && value > 0);
  const declared = declaredCandidates.length > 0
    ? Math.max(...declaredCandidates)
    : null;

  // OCR/AI occasionally reads a quantity or another table value into
  // totalTaxableAmount (for example 20,300 instead of 8,61,100). When the
  // stored commercial rows add up to a larger positive amount, the rows are
  // the stronger accounting signal and are also what the voucher will use.
  if (fromLines > 0 && (declared === null || fromLines > declared)) return fromLines;
  return declared ?? (fromLines > 0 ? fromLines : null);
}

function findLinkedLineSource(
  invoice: PurchasePostingDocumentInput,
  documents: PurchasePostingDocumentInput[]
) {
  if (readStoredLineItems(invoice.extracted_fields).length > 0) return null;
  const invoiceFields = fieldsOf(invoice);
  const invoiceNumber = normalizeKey(invoiceFields.invoiceNumber || invoiceFields.referenceInvoiceNumber);
  const invoiceSupplierGstin = normalizeGstin(invoiceFields.supplierGstin);
  const invoiceBuyerGstin = normalizeGstin(invoiceFields.buyerGstin);
  const invoiceTaxable = documentTaxablePaise(invoice);
  if (!invoiceNumber || !invoiceSupplierGstin || invoiceTaxable === null) return null;

  const candidates = documents.filter((document) => {
    if (document.id === invoice.id || !/(e-?way\s*bill|delivery\s*(challan|note))/i.test(document.document_type)) {
      return false;
    }
    const lines = readStoredLineItems(document.extracted_fields);
    if (lines.length === 0) return false;
    const fields = fieldsOf(document);
    const referenceMatches = normalizeKey(supportingInvoiceReference(document)) === invoiceNumber;
    const supplierMatches = normalizeGstin(fields.supplierGstin) === invoiceSupplierGstin;
    const candidateBuyerGstin = normalizeGstin(fields.buyerGstin);
    const buyerMatches = !invoiceBuyerGstin || !candidateBuyerGstin || candidateBuyerGstin === invoiceBuyerGstin;
    const candidateTaxable = documentTaxablePaise(document);
    const taxableMatches =
      candidateTaxable !== null &&
      Math.abs(candidateTaxable - invoiceTaxable) <= TOTAL_TOLERANCE_PAISE;
    return referenceMatches && supplierMatches && buyerMatches && taxableMatches;
  });

  return candidates.length === 1 ? candidates[0] : null;
}

function linkedInvoiceDate(
  invoice: PurchasePostingDocumentInput,
  documents: PurchasePostingDocumentInput[]
) {
  const invoiceFields = fieldsOf(invoice);
  const invoiceNumber = normalizeKey(
    invoiceFields.invoiceNumber || invoiceFields.referenceInvoiceNumber
  );
  if (!invoiceNumber) return "";

  const linked = documents.filter((document) => {
    if (document.id === invoice.id) return false;
    return normalizeKey(supportingInvoiceReference(document)) === invoiceNumber;
  });

  const datesFrom = (documentType: RegExp) => Array.from(new Set(
    linked
      .filter((document) => documentType.test(document.document_type))
      .map((document) => {
        const fields = fieldsOf(document);
        return parseDate(
          fields.referenceInvoiceDate ||
          fields.invoiceDate ||
          fields.documentDate
        );
      })
      .filter(isValidIsoDate)
  ));

  const ewayDates = datesFrom(/e-?way\s*bill/i);
  if (ewayDates.length === 1) return ewayDates[0];

  const corroboratingDates = datesFrom(
    /delivery\s*(challan|note)|weighment\s*slip/i
  );
  return corroboratingDates.length === 1 ? corroboratingDates[0] : "";
}

function packetVehicleNumber(
  invoice: PurchasePostingDocumentInput,
  documents: PurchasePostingDocumentInput[]
) {
  const candidates = documents.flatMap((document) => {
    const fields = fieldsOf(document);
    const commercialFields = extractInvoiceCommercialFieldsFromText(document.markdown);
    const value = text(
      fields.vehicleNumber ||
      fields.registrationNumber ||
      commercialFields.vehicleNumber
    ).toUpperCase().replace(/[^A-Z0-9]/g, "");
    return /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4}$/.test(value) ? [value] : [];
  });
  const unique = Array.from(new Set(candidates));
  if (unique.length === 1) return unique[0];

  const invoiceFields = fieldsOf(invoice);
  const invoiceCommercialFields = extractInvoiceCommercialFieldsFromText(invoice.markdown);
  return text(
    invoiceFields.vehicleNumber ||
    invoiceFields.registrationNumber ||
    invoiceCommercialFields.vehicleNumber
  ).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function packetSupplierName(
  invoice: PurchasePostingDocumentInput,
  documents: PurchasePostingDocumentInput[]
) {
  const invoiceFields = fieldsOf(invoice);
  const invoiceSupplierGstin = normalizeGstin(invoiceFields.supplierGstin);
  const supplierNameFrom = (document: PurchasePostingDocumentInput) => {
    const fields = fieldsOf(document);
    const commercialFields = extractInvoiceCommercialFieldsFromText(document.markdown);
    const buyerName = normalizeKey(fields.buyerName || commercialFields.buyerName);
    // OCR may take the buyer's masthead as vendorName even when the invoice
    // explicitly identifies a different supplier in its labelled ledger row.
    const direct = [fields.vendorName, fields.supplierName, fields.supplier, commercialFields.vendorName]
      .map(text)
      .find((candidate) => candidate && normalizeKey(candidate) !== buyerName) || "";
    if (direct) return direct;
    // E-Way Bills can identify the supplier in dispatchFrom when invoice OCR
    // did not expose a vendor-name field.
    const dispatchFrom = text(fields.dispatchFrom);
    return dispatchFrom.split(",")[0]?.trim() || "";
  };

  const ordered = [invoice, ...documents.filter((document) => document.id !== invoice.id)];
  const matching = ordered.filter((document) => {
    if (!invoiceSupplierGstin) return true;
    return normalizeGstin(fieldsOf(document).supplierGstin) === invoiceSupplierGstin;
  });
  return matching.map(supplierNameFrom).find(Boolean) || ordered.map(supplierNameFrom).find(Boolean) || "";
}

function sourceLine(documentId: string, item: CommercialLineItem, index: number): PurchasePostingSourceLine {
  const hsn = normalizeHsn(item.hsnSac);
  const material = materialFromHsn(hsn);
  const quantity = text(item.quantity);
  const rate = text(item.netRate || item.rate);
  const taxable = text(item.taxableAmount) || formatPaise(calculateLineTaxable({
    lineId: `${documentId}:${index + 1}`,
    description: text(item.description),
    hsn,
    quantity,
    unit: text(item.unit),
    rate,
    taxableAmount: "",
    taxRate: text(item.taxRate),
    stockItemName: "",
    purchaseLedgerName: "",
    godownName: "",
    batchName: "",
  }));
  return {
    lineId: `${documentId}:${index + 1}`,
    description: text(item.description),
    hsn,
    quantity,
    unit: text(item.unit),
    rate,
    taxableAmount: taxable,
    taxRate: text(item.taxRate),
    stockItemName: material.suggestedStockItem,
    purchaseLedgerName: "",
    godownName: "",
    batchName: "",
    material: material.material,
    materialLabel: material.label,
    invoiceCgstAmount: text(item.cgstAmount),
    invoiceSgstAmount: text(item.sgstAmount),
    invoiceIgstAmount: text(item.igstAmount),
    invoiceTaxAmount: text(item.taxAmount),
    sourcePage: typeof item.sourcePage === "number" ? item.sourcePage : null,
  };
}

function packetInventoryText(
  invoice: PurchasePostingDocumentInput,
  documents: PurchasePostingDocumentInput[],
  kind: "godown" | "batch"
) {
  const usableValue = (value: unknown) => {
    const candidate = text(value);
    return /^(?:not\s+(?:stated|applicable|available)|none|n\/?a|nil|-+)$/i.test(candidate)
      ? ""
      : candidate;
  };
  const fieldNames = kind === "godown"
    ? ["godownName", "godown", "warehouseName", "warehouse", "storageLocation"]
    : ["batchName", "batchNumber", "batchNo", "lotNumber"];
  const label = kind === "godown"
    ? "(?:godown|warehouse|storage(?:\\s*\\/\\s*delivery)?\\s+location|delivery\\s+destination)"
    : "(?:batch(?:\\s+(?:name|number|no\\.?))?|lot(?:\\s+(?:number|no\\.?))?)";
  const candidates = documents.flatMap((document) => {
    const fields = fieldsOf(document);
    for (const fieldName of fieldNames) {
      const value = usableValue(fields[fieldName]);
      if (value) return [value];
    }
    const searchableText = [
      text(fields.termsAndConditions),
      String(document.markdown ?? ""),
    ].filter(Boolean).join("\n");
    const match = searchableText.match(new RegExp(
      `\\b${label}\\s*(?:name\\s*)?(?:[:\\-]\\s*|\\s+)([a-z0-9][a-z0-9 ._()/&-]{1,79}?)(?=\\s*(?:;|\\n|\\||\\*\\*|supplier\\s+batch|commercial\\s+classification|delivery\\s+mode|inspection|document\\s+value|$))`,
      "i"
    ));
    const value = usableValue(match?.[1]);
    return value ? [value] : [];
  });
  const unique = Array.from(new Set(candidates.map((value) => normalizeKey(value))));
  if (unique.length !== 1) return "";
  return candidates.find((value) => normalizeKey(value) === unique[0]) ?? "";
}

export function purchaseVoucherNumber(invoiceNumber: unknown, invoiceDate: unknown) {
  const invoice = text(invoiceNumber);
  const normalizedDate = normalizePurchasePostingDate(invoiceDate);
  if (!invoice || !/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return invoice;
  const [year, month, day] = normalizedDate.split("-");
  const monthName = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][Number(month) - 1];
  if (!monthName) return invoice;
  return `${invoice} / ${day}-${monthName}-${year.slice(-2)}`;
}

function invoiceRoundOffAmount(
  fields: Record<string, unknown>,
  commercialFields: ReturnType<typeof extractInvoiceCommercialFieldsFromText>,
  lines: PurchasePostingSourceLine[]
) {
  const total = moneyPaise(fields.totalAmount);
  const explicitCandidates = [fields.roundOffAmount, commercialFields.roundOffAmount];
  for (const candidate of explicitCandidates) {
    const amount = moneyPaise(candidate);
    if (
      amount !== null &&
      Math.abs(amount) <= MAX_ROUND_OFF_PAISE &&
      (total === null || Math.abs(amount - total) > TOTAL_TOLERANCE_PAISE)
    ) {
      return formatPaise(amount);
    }
  }

  // OCR/AI commonly reads "invoice total after round-off" as the round-off
  // amount itself. Recover only a genuine sub-rupee balancing difference from
  // complete printed arithmetic; never invent a larger adjustment.
  const lineTaxable = sum(lines.map((line) => moneyPaise(line.taxableAmount)));
  const taxable = moneyPaise(fields.totalTaxableAmount ?? fields.subtotal) ?? lineTaxable;
  const tax = moneyPaise(fields.taxAmount) ?? moneyPaise(commercialFields.taxAmount);
  if (total === null || taxable === null || tax === null) return "";

  const freight = moneyPaise(fields.freightAmount) ?? moneyPaise(commercialFields.freightAmount) ?? 0;
  const tcs = moneyPaise(fields.tcsAmount) ?? moneyPaise(commercialFields.tcsAmount) ?? 0;
  const typedWithholding = sum([
    moneyPaise(fields.tds194qAmount) ?? moneyPaise(commercialFields.tds194qAmount),
    moneyPaise(fields.transportTdsAmount) ?? moneyPaise(commercialFields.transportTdsAmount),
    moneyPaise(fields.cgstTdsAmount) ?? moneyPaise(commercialFields.cgstTdsAmount),
    moneyPaise(fields.sgstTdsAmount) ?? moneyPaise(commercialFields.sgstTdsAmount),
    moneyPaise(fields.igstTdsAmount) ?? moneyPaise(commercialFields.igstTdsAmount),
  ]);
  const genericWithholding = typedWithholding === 0
    ? moneyPaise(fields.tdsAmount) ?? moneyPaise(commercialFields.tdsAmount) ?? 0
    : 0;
  const derived = total - taxable - freight - tax - tcs + typedWithholding + genericWithholding;
  return Math.abs(derived) <= MAX_ROUND_OFF_PAISE ? formatPaise(derived) : "";
}

// Section 194C: 1% for an individual or HUF payee, 2% for anyone else. The
// payee type is the 4th character of the PAN inside the GSTIN (P or H). An
// unreadable GSTIN keeps 1%, the rate the client books for its suppliers.
export function transportTdsRateForPayee(gstin: unknown) {
  const pan = normalizeGstin(gstin).slice(2, 12);
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return "1";
  return pan[3] === "P" || pan[3] === "H" ? "1" : "2";
}

const FREIGHT_ROW_PATTERN = /\b(?:freight|cartage|carriage|lorry\s+hire|transport(?:ation)?)\b/i;

// A charge row, not goods: named as freight/transport and either without a
// stock quantity or carrying a transport service code (SAC 9965 / 9967).
function isFreightChargeRow(item: CommercialLineItem, line: PurchasePostingSourceLine) {
  if (!FREIGHT_ROW_PATTERN.test(`${text(item.description)} ${text(item.rawText)}`)) return false;
  if (!((moneyPaise(line.taxableAmount) ?? 0) > 0)) return false;
  const quantity = Number(String(line.quantity).replace(/,/g, ""));
  return !(quantity > 0) || /^996[57]/.test(line.hsn);
}

function buildSource(
  document: PurchasePostingDocumentInput,
  lineSource: PurchasePostingDocumentInput = document,
  documents: PurchasePostingDocumentInput[] = [document]
): PurchasePostingSource {
  const fields = fieldsOf(document);
  const commercialFields = extractInvoiceCommercialFieldsFromText(document.markdown);
  // Freight printed as an invoice row ("Transportation Charges") is booked on
  // the freight ledger, never as a stock line. Keeping it in both places
  // counted it twice and inflated GST, 194Q and the total.
  const itemRows = readStoredLineItems(lineSource.extracted_fields).map((item, index) => ({
    item,
    line: sourceLine(lineSource.id, item, index),
  }));
  const freightRows = itemRows.filter(({ item, line }) => isFreightChargeRow(item, line));
  const lines = itemRows.filter((row) => !freightRows.includes(row)).map(({ line }) => line);
  const freightFromRows = sum(freightRows.map(({ line }) => moneyPaise(line.taxableAmount)));
  const printedFreight = text(fields.freightAmount) || commercialFields.freightAmount;
  return {
    documentId: document.id,
    documentType: document.document_type,
    lineSourceDocumentId: lineSource.id,
    lineSourceDocumentType: lineSource.document_type,
    lineRecovery: lineSource.id === document.id ? "invoice" : "linked_document",
    sourceFileName: document.source_file_name,
    sourceHint: document.source_hint,
    invoiceNumber: text(fields.invoiceNumber || fields.referenceInvoiceNumber),
    invoiceDate:
      parseDate(fields.documentDate || fields.invoiceDate) ||
      parseDate(commercialFields.documentDate),
    supplierName: packetSupplierName(document, documents),
    supplierGstin: normalizeGstin(fields.supplierGstin),
    buyerName: text(fields.buyerName),
    buyerGstin: normalizeGstin(fields.buyerGstin),
    vehicleNumber: packetVehicleNumber(document, documents),
    invoiceTaxableAmount: text(fields.totalTaxableAmount || fields.subtotal),
    invoiceTaxRate: text(fields.taxRate),
    invoiceTaxAmount: text(fields.taxAmount) || commercialFields.taxAmount,
    invoiceTotal: text(fields.totalAmount),
    invoiceTdsAmount: text(fields.tdsAmount) || commercialFields.tdsAmount,
    invoiceTdsRate: text(fields.tdsRate) || commercialFields.tdsRate,
    invoiceFreightAmount:
      printedFreight || (freightFromRows > 0 ? formatPaise(freightFromRows) : ""),
    invoiceFreightGstRate:
      text(fields.freightGstRate) || commercialFields.freightGstRate ||
      (printedFreight ? "" : freightRows.map(({ line }) => line.taxRate).find(Boolean) || ""),
    invoiceTds194qAmount:
      text(fields.tds194qAmount) || commercialFields.tds194qAmount,
    invoiceTds194qRate:
      text(fields.tds194qRate) || commercialFields.tds194qRate,
    invoiceTransportTdsAmount:
      text(fields.transportTdsAmount) || commercialFields.transportTdsAmount,
    invoiceTransportTdsRate:
      text(fields.transportTdsRate) || commercialFields.transportTdsRate,
    invoiceCgstTdsAmount:
      text(fields.cgstTdsAmount) || commercialFields.cgstTdsAmount,
    invoiceSgstTdsAmount:
      text(fields.sgstTdsAmount) || commercialFields.sgstTdsAmount,
    invoiceIgstTdsAmount:
      text(fields.igstTdsAmount) || commercialFields.igstTdsAmount,
    invoiceGstTdsRate:
      text(fields.gstTdsRate) || commercialFields.gstTdsRate,
    invoiceTcsAmount: text(fields.tcsAmount) || commercialFields.tcsAmount,
    invoiceRoundOffAmount: invoiceRoundOffAmount(fields, commercialFields, lines),
    godownName: packetInventoryText(document, documents, "godown"),
    batchName: packetInventoryText(document, documents, "batch"),
    ewayBill: packetEwayBill(fields, documents),
    lines,
  };
}

const STATE_NAMES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh",
  "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry",
  "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
  "West Bengal",
];

function stateInText(value: string) {
  const compact = value.toLowerCase().replace(/[^a-z]/g, "");
  return STATE_NAMES.find((state) => compact.includes(state.toLowerCase().replace(/[^a-z]/g, ""))) ?? "";
}

// "PLOT NO 22, MIDC AREA HINGNA ROAD, NAGPUR, NAGPUR,MAHARASHTRA-440016"
// -> place NAGPUR, PIN 440016, state Maharashtra.
function splitEwayAddress(address: string) {
  const pincode = address.match(/\b(\d{6})\b(?!.*\b\d{6}\b)/)?.[1] ?? "";
  const state = stateInText(address);
  const parts = address.split(",").map((part) => part.replace(/-?\s*\d{6}\s*$/, "").trim()).filter(Boolean);
  const place = [...parts].reverse().find((part) => !stateInText(part) && /^[A-Za-z .]{3,40}$/.test(part)) ?? "";
  return { pincode, state, place: place.replace(/\s+/g, " ") };
}

function emptyEwayBill(): PurchaseEwayBill {
  return { record: false, number: "", date: "", fromAddress: "", fromPlace: "", fromPincode: "", fromState: "",
    toPlace: "", toPincode: "", toState: "", transportMode: "1 - Road", vehicleNumber: "", distanceKm: "" };
}

// The supplier's e-way bill page for this invoice: its number, date, dispatch
// place and transport details, recorded on the purchase voucher as reference.
function packetEwayBill(invoiceFields: Record<string, unknown>, documents: PurchasePostingDocumentInput[]): PurchaseEwayBill | null {
  const invoiceNumber = normalizeKey(invoiceFields.invoiceNumber || invoiceFields.referenceInvoiceNumber);
  const candidates = documents.filter((document) => /e-?way\s*bill/i.test(document.document_type));
  const document = candidates.find((candidate) =>
    invoiceNumber && normalizeKey(fieldsOf(candidate).referenceInvoiceNumber) === invoiceNumber
  ) ?? (candidates.length === 1 ? candidates[0] : null);
  if (!document) return null;
  const fields = fieldsOf(document);
  const pageText = text(document.markdown);
  const number = text(fields.eWayBillNumber || fields.ewayBillNumber).replace(/\D/g, "") ||
    (pageText.match(/e-?way\s*bill\s*no\.?\s*:?\s*([\d ]{12,16})/i)?.[1] ?? "").replace(/\D/g, "");
  if (!number) return null;
  const from = splitEwayAddress(text(fields.dispatchFrom));
  const to = splitEwayAddress(text(fields.shipTo));
  const distance = pageText.match(/approx\.?\s*distance\s*:?\s*(\d{1,4})\s*km/i)?.[1] ?? "";
  const mode = pageText.match(/\bmode\s*:?\s*(road|rail|air|ship)\b/i)?.[1]?.toLowerCase() ?? "road";
  const modeCode = { road: "1 - Road", rail: "2 - Rail", air: "3 - Air", ship: "4 - Ship" }[mode] ?? "1 - Road";
  return {
    record: true,
    number,
    date: parseDate(text(fields.documentDate).split(/\s+/)[0]) || "",
    fromAddress: text(fields.dispatchFrom),
    fromPlace: from.place,
    fromPincode: from.pincode,
    fromState: from.state || stateInText(text(fields.dispatchFrom)),
    toPlace: to.place,
    toPincode: to.pincode,
    toState: to.state || stateInText(text(fields.shipTo)),
    transportMode: modeCode,
    vehicleNumber: text(fields.vehicleNumber).replace(/\s+/g, "").toUpperCase(),
    distanceKm: distance,
  };
}

function activeMasters(masters: PurchasePostingMasterInput[]) {
  return masters.filter((master) => master.is_active);
}

const LEDGER_MASTER_TYPES = new Set(["ledger", "gst_ledger", "tax_ledger"]);

function ledgerMasterPriority(master: PurchasePostingMasterInput) {
  if (master.master_type === "ledger") return 0;
  if (master.master_type === "gst_ledger") return 1;
  if (master.master_type === "tax_ledger") return 2;
  return 3;
}

export function dedupeLedgerMasters(masters: PurchasePostingMasterInput[]) {
  const byName = new Map<string, PurchasePostingMasterInput>();

  for (const master of masters) {
    if (!LEDGER_MASTER_TYPES.has(master.master_type)) continue;
    const key = normalizeKey(master.tally_name);
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing || ledgerMasterPriority(master) < ledgerMasterPriority(existing)) {
      byName.set(key, master);
    }
  }

  return [...byName.values()];
}

function exactMasterName(
  masters: PurchasePostingMasterInput[],
  name: string,
  allowedTypes?: string[]
) {
  const normalized = normalizeKey(name);
  if (!normalized) return "";
  return activeMasters(masters).find((master) =>
    (!allowedTypes || allowedTypes.includes(master.master_type)) &&
    normalizeKey(master.tally_name) === normalized
  )?.tally_name ?? "";
}

function mappingTargetIsLive(
  mapping: PurchasePostingMappingInput,
  masters: PurchasePostingMasterInput[],
  allowedTypes?: string[]
) {
  const targetKey = normalizeKey(mapping.target_master_key ?? "");
  const targetName = normalizeKey(mapping.target_master_name);
  const candidates = activeMasters(masters).filter((master) =>
    (!allowedTypes || allowedTypes.includes(master.master_type)) &&
    (!mapping.target_master_type || master.master_type === mapping.target_master_type)
  );
  if (!targetKey) return candidates.filter((master) => normalizeKey(master.tally_name) === targetName).length === 1;
  const exactIdentityMatches = candidates.filter((master) => {
    const identities = [master.master_key, master.tally_guid]
      .filter(Boolean)
      .map((value) => normalizeKey(value));
    const keySuffix = targetKey.includes(":") ? targetKey.slice(targetKey.indexOf(":") + 1) : targetKey;
    return identities.includes(targetKey) || identities.includes(keySuffix);
  });
  if (exactIdentityMatches.length > 0) return exactIdentityMatches.length === 1;
  // Legacy name-only mappings are safe only when the name is unique in the
  // current company and master type. Never guess between duplicate ledgers.
  return targetKey === targetName && candidates.filter((master) => normalizeKey(master.tally_name) === targetName).length === 1;
}

function mappedName(
  masters: PurchasePostingMasterInput[],
  mappings: PurchasePostingMappingInput[],
  type: string,
  source: string,
  allowedTypes?: string[]
) {
  const normalized = normalizeKey(source);
  const mapping = mappings.find((candidate) =>
    candidate.status === "active" &&
    candidate.mapping_type === type &&
    normalizeKey(candidate.source_key) === normalized &&
    mappingTargetIsLive(candidate, masters, allowedTypes)
  );
  return mapping?.target_master_name ?? "";
}

function mappedItemHsnName(masters: PurchasePostingMasterInput[], mappings: PurchasePostingMappingInput[], hsnValue: string) {
  const hsn = normalizeHsn(hsnValue);
  return mappings
    .filter((mapping) =>
      mapping.status === "active" &&
      mapping.mapping_type === "item_hsn" &&
      hsn.startsWith(normalizeHsn(mapping.source_key))
    )
    .sort((left, right) => normalizeHsn(right.source_key).length - normalizeHsn(left.source_key).length)
    .find((mapping) => mappingTargetIsLive(mapping, masters, ["stock_item"]))
    ?.target_master_name ?? "";
}

function findLedger(masters: PurchasePostingMasterInput[], patterns: RegExp[]) {
  const matches = dedupeLedgerMasters(
    activeMasters(masters).filter((master) =>
      patterns.every((pattern) => pattern.test(`${master.tally_name} ${master.parent_name ?? ""}`))
    )
  );
  return matches.length === 1 ? matches[0].tally_name : "";
}

function masterIdentity(master: PurchasePostingMasterInput) {
  const raw = master.raw_payload ?? {};
  return [
    master.tally_name,
    master.parent_name,
    master.group_path,
    typeof raw.taxType === "string" ? raw.taxType : "",
    typeof raw.gstDutyHead === "string" ? raw.gstDutyHead : "",
  ].filter(Boolean).join(" ");
}

function mappedRoleName(
  masters: PurchasePostingMasterInput[],
  mappings: PurchasePostingMappingInput[],
  type: string,
  sourceKeys: string[],
  allowedTypes?: string[]
) {
  for (const sourceKey of sourceKeys) {
    const mapped = mappedName(masters, mappings, type, sourceKey, allowedTypes);
    if (mapped) return mapped;
  }
  return "";
}

function uniqueRankedLedger(
  masters: PurchasePostingMasterInput[],
  score: (master: PurchasePostingMasterInput) => number,
  minimumScore = 50
) {
  const ranked = dedupeLedgerMasters(activeMasters(masters))
    .map((master) => ({ master, score: score(master) }))
    .filter((entry) => entry.score >= minimumScore)
    .sort((left, right) => right.score - left.score || left.master.tally_name.localeCompare(right.master.tally_name));
  if (ranked.length === 0) return "";
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return "";
  return ranked[0].master.tally_name;
}

function taxRoleLedger(
  masters: PurchasePostingMasterInput[],
  dutyHead: "cgst" | "sgst" | "igst",
  expectedRate: number
) {
  return uniqueRankedLedger(masters, (master) => {
    const identity = masterIdentity(master);
    if (!new RegExp(`\\b${dutyHead}\\b|${dutyHead === "cgst" ? "central\\s+tax" : dutyHead === "sgst" ? "state\\s+tax" : "integrated\\s+tax"}`, "i").test(identity)) return 0;
    if (/\b(output|sales|payable)\b/i.test(identity) && !/\binput\b|\bitc\b|purchase/i.test(identity)) return 0;
    let score = 70;
    if (/\b(input|itc|purchase)\b/i.test(identity)) score += 25;
    if (/duties\s*(?:&|and)\s*taxes|gst/i.test(identity)) score += 10;
    if (master.tax_rate !== null && Math.abs(master.tax_rate - expectedRate) < 0.001) score += 20;
    else if (new RegExp(`(?:@|\\b)\\s*${String(expectedRate).replace(".", "[.]")}\\s*%`, "i").test(identity)) score += 15;
    return score;
  });
}

function namedRoleLedger(
  masters: PurchasePostingMasterInput[],
  patterns: RegExp[],
  preferredGroups: RegExp[] = []
) {
  return uniqueRankedLedger(masters, (master) => {
    const identity = masterIdentity(master);
    if (!patterns.every((pattern) => pattern.test(identity))) return 0;
    return 55 + patterns.length * 20 + preferredGroups.filter((pattern) => pattern.test(identity)).length * 10;
  });
}

function purchaseLedgerForLine(
  masters: PurchasePostingMasterInput[],
  mappings: PurchasePostingMappingInput[],
  material: ReturnType<typeof materialFromHsn>["material"],
  localPurchase: boolean
) {
  const geography = localPurchase ? "local" : "interstate";
  const mapped = mappedRoleName(masters, mappings, "purchase_ledger", [
    `${material}:${geography}`,
    `any:${geography}`,
    geography,
  ]);
  if (mapped) return exactMasterName(masters, mapped, ["ledger"]);

  const legacyName = material === "unknown"
    ? ""
    : localPurchase ? "M.S. Scrap Purchase" : "O.M.S. Scrap Purchase";
  const legacy = exactMasterName(masters, legacyName, ["ledger"]);
  if (legacy) return legacy;

  // Small/test companies often have only one purchase ledger for the
  // material, and its name may use the interstate prefix even when the
  // current invoice is intrastate. Auto-select that unique material ledger;
  // the tax mode is still determined independently from the two GST states.
  const materialLedgers = dedupeLedgerMasters(activeMasters(masters)).filter((master) => {
    if (!/purchase/i.test(masterIdentity(master))) return false;
    const identity = masterIdentity(master);
    return material === "ms_scrap"
      ? /scrap/i.test(identity)
      : material === "sponge_iron"
        ? /sponge|iron/i.test(identity)
        : false;
  });
  if (materialLedgers.length === 1) return materialLedgers[0].tally_name;

  return uniqueRankedLedger(masters, (master) => {
    const identity = masterIdentity(master);
    if (!/purchase/i.test(identity)) return 0;
    let score = /purchase\s+accounts?/i.test(identity) ? 85 : 60;
    if (/direct\s+expenses?/i.test(identity)) score += 10;
    if (material === "ms_scrap" && /scrap/i.test(identity)) score += 20;
    if (material === "sponge_iron" && /sponge|iron/i.test(identity)) score += 20;
    if (localPurchase && /local|intra|m[.]?s[.]?\s*scrap/i.test(identity)) score += 10;
    if (!localPurchase && /interstate|outside|o[.]?m[.]?s[.]?/i.test(identity)) score += 10;
    return score;
  }, 70);
}

function supplierLedgerSuggestion(
  source: PurchasePostingSource,
  masters: PurchasePostingMasterInput[],
  mappings: PurchasePostingMappingInput[]
) {
  const mapped = mappedName(masters, mappings, "supplier_gstin", source.supplierGstin || source.supplierName, ["ledger"]);
  if (mapped) return mapped;
  const gstin = normalizeGstin(source.supplierGstin);
  const byGstin = activeMasters(masters).filter((master) =>
    master.master_type === "ledger" && gstin && normalizeGstin(master.gstin) === gstin
  );
  if (byGstin.length === 1) return byGstin[0].tally_name;
  return exactMasterName(masters, source.supplierName, ["ledger"]);
}

function buildDefaultReview(
  source: PurchasePostingSource,
  masters: PurchasePostingMasterInput[],
  mappings: PurchasePostingMappingInput[],
  buyerGstin: string,
  saved?: Partial<PurchasePostingReview> | null
): PurchasePostingReview {
  const supplierState = stateCodeFromGstin(source.supplierGstin);
  const buyerState = stateCodeFromGstin(buyerGstin || source.buyerGstin);
  const localPurchase = Boolean(supplierState && buyerState && supplierState === buyerState);
  const savedLineValues = Array.isArray(saved?.lines) ? saved.lines : [];
  const savedLines = new Map(savedLineValues.map((line) => [line.lineId, line]));
  const lines = source.lines.map((line) => {
    const prior = savedLines.get(line.lineId);
    const material = materialFromHsn(prior?.hsn || line.hsn);
    const stockItem =
      exactMasterName(masters, prior?.stockItemName || "", ["stock_item"]) ||
      mappedItemHsnName(masters, mappings, prior?.hsn || line.hsn) ||
      exactMasterName(masters, material.suggestedStockItem, ["stock_item"]) ||
      (() => {
        const hsn = normalizeHsn(prior?.hsn || line.hsn);
        const matches = activeMasters(masters).filter((master) =>
          master.master_type === "stock_item" && hsn && normalizeHsn(master.hsn_code) === hsn
        );
        return matches.length === 1 ? matches[0].tally_name : "";
      })();
    const savedUnit = prior?.unit ?? "";
    const invoiceUnit =
      line.unit ||
      savedUnit;
    const reviewedUnit =
      savedUnit &&
      line.unit &&
      normalizeUnit(savedUnit) !== normalizeUnit(line.unit)
        ? savedUnit
        : invoiceUnit;
    return {
      lineId: line.lineId,
      description: prior?.description ?? line.description,
      hsn: normalizeHsn(prior?.hsn ?? line.hsn),
      quantity: prior?.quantity ?? line.quantity,
      unit: reviewedUnit,
      rate: prior?.rate ?? line.rate,
      taxableAmount: prior?.taxableAmount ?? line.taxableAmount,
      taxRate: prior?.taxRate ?? line.taxRate ?? source.invoiceTaxRate,
      stockItemName: stockItem,
      purchaseLedgerName:
        exactMasterName(masters, prior?.purchaseLedgerName || "", ["ledger"]) ||
        purchaseLedgerForLine(masters, mappings, material.material, localPurchase),
      godownName:
        exactMasterName(masters, prior?.godownName || "", ["godown"]) ||
        exactMasterName(masters, source.godownName, ["godown"]) ||
        source.godownName,
      batchName: prior?.batchName ?? source.batchName,
    };
  });

  const narrationHsns = Array.from(new Set(
    lines
      .map((line) => normalizeHsn(line.hsn))
      .filter(Boolean)
  ));
  const defaultNarration = [
    source.vehicleNumber,
    narrationHsns.length > 0 ? `HSN: ${narrationHsns.join(", ")}` : null,
  ].filter(Boolean).join(" ") || "Purchase invoice details";
  const hasPositiveInvoiceAmount = (value: string) => (moneyPaise(value) ?? 0) > 0;
  const invoiceHasTds194q = hasPositiveInvoiceAmount(source.invoiceTds194qAmount);
  const invoiceHasTransportTds = hasPositiveInvoiceAmount(source.invoiceTransportTdsAmount);
  const invoiceHasGstTds = [
    source.invoiceCgstTdsAmount,
    source.invoiceSgstTdsAmount,
    source.invoiceIgstTdsAmount,
  ].some(hasPositiveInvoiceAmount);
  const invoiceHasTcs = hasPositiveInvoiceAmount(source.invoiceTcsAmount);
  const scrapGstTdsBasis = sum(lines.map((line) =>
    materialFromHsn(line.hsn).material === "ms_scrap"
      ? calculateLineTaxable(line)
      : null
  ));
  const qualifiesForAutomaticScrapGstTds =
    isValidIsoDate(source.invoiceDate) &&
    source.invoiceDate >= SCRAP_GST_TDS_EFFECTIVE_DATE &&
    validGstin(source.supplierGstin) &&
    validGstin(buyerGstin || source.buyerGstin) &&
    Boolean(supplierState && buyerState) &&
    scrapGstTdsBasis > GST_TDS_CONTRACT_THRESHOLD_PAISE;

  const baseReview: PurchasePostingReview = {
    selectedInvoiceDocumentId: source.documentId,
    invoiceNumber: source.invoiceNumber,
    invoiceDate: source.invoiceDate,
    voucherDate: new Date().toISOString().slice(0, 10),
    supplierName: source.supplierName,
    supplierGstin: source.supplierGstin,
    buyerName: source.buyerName,
    buyerGstin: buyerGstin || source.buyerGstin,
    vehicleNumber: source.vehicleNumber,
    invoiceTotal: source.invoiceTotal,
    gstRate: source.invoiceTaxRate,
    supplierLedgerName: supplierLedgerSuggestion(source, masters, mappings),
    cgstLedgerName:
      mappedRoleName(masters, mappings, "gst_rate", [`cgst:${Number(source.invoiceTaxRate || 0) / 2}`, "cgst"], ["ledger", "gst_ledger", "tax_ledger"]) ||
      exactMasterName(masters, "Input ITC CGST 9%", ["ledger", "gst_ledger", "tax_ledger"]) ||
      taxRoleLedger(masters, "cgst", Number(source.invoiceTaxRate || 0) / 2),
    sgstLedgerName:
      mappedRoleName(masters, mappings, "gst_rate", [`sgst:${Number(source.invoiceTaxRate || 0) / 2}`, "sgst"], ["ledger", "gst_ledger", "tax_ledger"]) ||
      exactMasterName(masters, "Input ITC SGST 9%", ["ledger", "gst_ledger", "tax_ledger"]) ||
      taxRoleLedger(masters, "sgst", Number(source.invoiceTaxRate || 0) / 2),
    igstLedgerName:
      mappedRoleName(masters, mappings, "gst_rate", [`igst:${Number(source.invoiceTaxRate || 0)}`, "igst"], ["ledger", "gst_ledger", "tax_ledger"]) ||
      exactMasterName(masters, "Input ITC IGST 18%", ["ledger", "gst_ledger", "tax_ledger"]) ||
      taxRoleLedger(masters, "igst", Number(source.invoiceTaxRate || 0)),
    freightAmount: source.invoiceFreightAmount,
    freightGstRate: source.invoiceFreightGstRate || (moneyPaise(source.invoiceFreightAmount) ? "18" : ""),
    freightLedgerName:
      mappedName(masters, mappings, "freight_ledger", "purchase", ["ledger"]) ||
      exactMasterName(masters, "Transportation Inward @ 18.00%", ["ledger"]) ||
      namedRoleLedger(
        masters,
        [/freight|transport(?:ation)?\s+(?:inward|charges?|handling)|handling\s+charges?/i],
        [/direct\s+expenses?|purchase/i]
      ),
    tds194qLedgerName:
      mappedRoleName(masters, mappings, "tds_ledger", ["194q", "purchase_goods"], ["ledger", "tax_ledger"]) ||
      exactMasterName(masters, "TDS Payable @ 0.10% (194Q)", ["ledger", "tax_ledger"]) ||
      namedRoleLedger(masters, [/tds|withholding|tax\s+deducted/i, /194q|0[.]?10/i]),
    tds194qRate: source.invoiceTds194qRate || "0.1",
    applyTds194q: invoiceHasTds194q,
    tds194qBasisAmount: "",
    tds194qRounding: "nearest_rupee",
    // Pre-ticked when the invoice has freight; the reviewer can untick it.
    applyTransportTds: invoiceHasTransportTds || hasPositiveInvoiceAmount(source.invoiceFreightAmount),
    applyGstTds: invoiceHasGstTds || qualifiesForAutomaticScrapGstTds,
    transportTdsLedgerName:
      mappedRoleName(masters, mappings, "tds_ledger", ["transport", "goods_transport"], ["ledger", "tax_ledger"]) ||
      exactMasterName(masters, "Tds on Goods Transport", ["ledger", "tax_ledger"]) ||
      namedRoleLedger(masters, [/tds|withholding|tax\s+deducted/i, /transport|freight/i]),
    transportTdsRate: source.invoiceTransportTdsRate || transportTdsRateForPayee(source.supplierGstin),
    cgstTdsLedgerName:
      mappedRoleName(masters, mappings, "tds_ledger", ["cgst_tds", "gst_tds_cgst"], ["ledger", "tax_ledger"]) ||
      exactMasterName(masters, "CGST TDS PAYABLE 1%", ["ledger", "tax_ledger"]) ||
      namedRoleLedger(masters, [/tds|withholding|tax\s+deducted/i, /cgst|central\s+tax/i]),
    sgstTdsLedgerName:
      mappedRoleName(masters, mappings, "tds_ledger", ["sgst_tds", "gst_tds_sgst"], ["ledger", "tax_ledger"]) ||
      exactMasterName(masters, "SGST TDS PAYABLE 1%", ["ledger", "tax_ledger"]) ||
      namedRoleLedger(masters, [/tds|withholding|tax\s+deducted/i, /sgst|state\s+tax/i]),
    igstTdsLedgerName:
      mappedRoleName(masters, mappings, "tds_ledger", ["igst_tds", "gst_tds_igst"], ["ledger", "tax_ledger"]) ||
      exactMasterName(masters, "IGST TDS PAYABLE 2%", ["ledger", "tax_ledger"]) ||
      namedRoleLedger(masters, [/tds|withholding|tax\s+deducted/i, /igst|integrated\s+tax/i]),
    gstTdsRate: source.invoiceGstTdsRate || (localPurchase ? "1" : "2"),
    tcsReceivable: invoiceHasTcs,
    tcsLedgerName: mappedName(masters, mappings, "tcs_ledger", "receivable", ["ledger", "tax_ledger"]) || findLedger(masters, [/tcs/i]),
    tcsAmount: source.invoiceTcsAmount,
    roundOffLedgerName: mappedName(masters, mappings, "round_off_ledger", "purchase", ["ledger"]) || findLedger(masters, [/round\s*off/i]),
    roundOffAmount: source.invoiceRoundOffAmount,
    sourceReferenceApproved: true,
    narration: defaultNarration,
    ewayBill: source.ewayBill,
    lines,
  };

  return {
    ...baseReview,
    ...(saved ?? {}),
    // Reviewer edits override the extracted e-way bill field by field.
    ewayBill: baseReview.ewayBill || saved?.ewayBill
      ? { ...(baseReview.ewayBill ?? emptyEwayBill()), ...(saved?.ewayBill ?? {}) }
      : null,
    lines,
    invoiceDate: parseDate(saved?.invoiceDate) || baseReview.invoiceDate,
    voucherDate: parseDate(saved?.voucherDate) || baseReview.voucherDate,
    supplierLedgerName: exactMasterName(masters, saved?.supplierLedgerName || "", ["ledger"]) || baseReview.supplierLedgerName,
    cgstLedgerName: exactMasterName(masters, saved?.cgstLedgerName || "", ["ledger", "gst_ledger", "tax_ledger"]) || baseReview.cgstLedgerName,
    sgstLedgerName: exactMasterName(masters, saved?.sgstLedgerName || "", ["ledger", "gst_ledger", "tax_ledger"]) || baseReview.sgstLedgerName,
    igstLedgerName: exactMasterName(masters, saved?.igstLedgerName || "", ["ledger", "gst_ledger", "tax_ledger"]) || baseReview.igstLedgerName,
    freightAmount: moneyPaise(source.invoiceFreightAmount)
      ? saved?.freightAmount ?? baseReview.freightAmount
      : "",
    freightGstRate: moneyPaise(source.invoiceFreightAmount)
      ? saved?.freightGstRate ?? baseReview.freightGstRate
      : "",
    freightLedgerName: exactMasterName(masters, saved?.freightLedgerName || "", ["ledger"]) || baseReview.freightLedgerName,
    tds194qLedgerName:
      exactMasterName(masters, saved?.tds194qLedgerName || saved?.tdsLedgerName || "", ["ledger", "tax_ledger"]) || baseReview.tds194qLedgerName,
    transportTdsLedgerName:
      exactMasterName(masters, saved?.transportTdsLedgerName || "", ["ledger", "tax_ledger"]) || baseReview.transportTdsLedgerName,
    cgstTdsLedgerName: exactMasterName(masters, saved?.cgstTdsLedgerName || "", ["ledger", "tax_ledger"]) || baseReview.cgstTdsLedgerName,
    sgstTdsLedgerName: exactMasterName(masters, saved?.sgstTdsLedgerName || "", ["ledger", "tax_ledger"]) || baseReview.sgstTdsLedgerName,
    igstTdsLedgerName: exactMasterName(masters, saved?.igstTdsLedgerName || "", ["ledger", "tax_ledger"]) || baseReview.igstTdsLedgerName,
    tds194qRate: saved?.tds194qRate || saved?.tdsRate || baseReview.tds194qRate,
    applyTds194q:
      typeof saved?.applyTds194q === "boolean"
        ? saved.applyTds194q
        : baseReview.applyTds194q,
    tds194qBasisAmount: saved?.tds194qBasisAmount ?? baseReview.tds194qBasisAmount,
    tds194qRounding:
      saved?.tds194qRounding === "paise" ? "paise" : "nearest_rupee",
    applyTransportTds:
      typeof saved?.applyTransportTds === "boolean"
        ? saved.applyTransportTds
        : baseReview.applyTransportTds,
    applyGstTds:
      typeof saved?.applyGstTds === "boolean"
        ? saved.applyGstTds
        : baseReview.applyGstTds,
    tcsLedgerName: exactMasterName(masters, saved?.tcsLedgerName || "", ["ledger", "tax_ledger"]) || baseReview.tcsLedgerName,
    roundOffLedgerName: exactMasterName(masters, saved?.roundOffLedgerName || "", ["ledger"]) || baseReview.roundOffLedgerName,
    roundOffAmount: moneyPaise(source.invoiceRoundOffAmount)
      ? saved?.roundOffAmount ?? baseReview.roundOffAmount
      : "",
    tcsReceivable:
      typeof saved?.tcsReceivable === "boolean"
        ? saved.tcsReceivable
        : baseReview.tcsReceivable,
    // The connector attaches and verifies the source PDF. Preserve the legacy
    // review field for compatibility without requiring manual fallback approval.
    sourceReferenceApproved: true,
    narration:
      saved?.narration &&
      !/^Purchase invoice .+ imported from the packet-matching case\.$/i.test(saved.narration.trim()) &&
      !/^Purchase invoice .+ dated .*\.$/i.test(saved.narration.trim())
        ? saved.narration
        : baseReview.narration,
  };
}

function hasMaster(
  masters: PurchasePostingMasterInput[],
  name: string,
  types: string[]
) {
  return Boolean(exactMasterName(masters, name, types));
}

function selectedMaster(
  masters: PurchasePostingMasterInput[],
  name: string,
  types?: string[]
) {
  const normalized = normalizeKey(name);
  return activeMasters(masters).find((master) =>
    normalized &&
    normalizeKey(master.tally_name) === normalized &&
    (!types || types.includes(master.master_type))
  ) ?? null;
}

function validGstin(value: string) {
  return /^\d{2}[0-9A-Z]{13}$/.test(normalizeGstin(value));
}

function isPurchaseTaxLedger(
  master: PurchasePostingMasterInput | null,
  dutyHead: "cgst" | "sgst" | "igst"
) {
  if (!master) return false;
  const identity = masterIdentity(master).toLowerCase();
  const dutyIdentity = dutyHead === "cgst"
    ? /\bcgst\b|central\s+tax/
    : dutyHead === "sgst"
      ? /\bsgst\b|state\s+tax/
      : /\bigst\b|integrated\s+tax/;
  return dutyIdentity.test(identity) && !(
    /\b(output|sales)\b/.test(identity) && !/\b(input|itc|purchase)\b/.test(identity)
  );
}

function mappingSelects(
  masters: PurchasePostingMasterInput[],
  mappings: PurchasePostingMappingInput[],
  mappingType: string,
  sourceKeys: string[],
  masterName: string
) {
  return sourceKeys.some((sourceKey) =>
    normalizeKey(mappedName(masters, mappings, mappingType, sourceKey)) === normalizeKey(masterName)
  );
}

function isWithholdingLedger(
  master: PurchasePostingMasterInput | null,
  role: "194q" | "transport" | "cgst_tds" | "sgst_tds" | "igst_tds" | "tcs"
) {
  if (!master) return false;
  const identity = masterIdentity(master);
  const withholding = /\b(tds|tcs)\b|withholding|tax\s+(?:deducted|collected)/i.test(identity);
  if (!withholding) return false;
  if (role === "194q") return /194q|0[.]?10/i.test(identity);
  if (role === "transport") return /transport|freight|goods\s+carriage/i.test(identity);
  if (role === "cgst_tds") return /cgst|central\s+tax/i.test(identity);
  if (role === "sgst_tds") return /sgst|state\s+tax/i.test(identity);
  if (role === "igst_tds") return /igst|integrated\s+tax/i.test(identity);
  return /\btcs\b|tax\s+collected/i.test(identity);
}

function issue(
  code: string,
  label: string,
  message: string,
  scope: PurchasePostingIssue["scope"],
  lineId?: string
): PurchasePostingIssue {
  return { code, label, message, scope, ...(lineId ? { lineId } : {}) };
}

// A withholding ledger that is missing or of the wrong kind: name the chosen
// ledger and offer a live one that the check accepts.
function withholdingLedgerIssue(
  code: string,
  label: string,
  kind: string,
  role: "194q" | "transport" | "cgst_tds" | "sgst_tds" | "igst_tds",
  selectedName: string,
  masters: PurchasePostingMasterInput[]
) {
  const suggestion = activeMasters(masters).find((master) =>
    ["ledger", "tax_ledger"].includes(master.master_type) && isWithholdingLedger(master, role)
  )?.tally_name;
  const chosen = text(selectedName);
  const message = `${chosen ? `${chosen} is not a ${kind} ledger.` : `Choose the ${kind} ledger.`}${suggestion ? ` Use ${suggestion}.` : " Create it in Tally, then refresh."}`;
  return { ...issue(code, label, message, "tax"), ...(suggestion ? { suggestion } : {}) };
}

const PURCHASE_VALIDATION_RULE_BY_CODE: Partial<
  Record<string, PurchaseValidationRuleKey>
> = {
  CASE_NOT_ACCEPTED: "caseNotAccepted",
  TALLY_MASTERS_STALE: "staleTallyMasters",
  COMPANY_IDENTITY_REQUIRED: "companyGstinMissing",
  COMPANY_GSTIN_INVALID: "companyGstinInvalid",
  BUYER_GSTIN_REQUIRED: "buyerGstinMissing",
  SUPPLIER_GSTIN_REQUIRED: "supplierGstinMissing",
  BUYER_COMPANY_GSTIN_MISMATCH: "buyerCompanyGstinMismatch",
  SUPPLIER_LEDGER_GSTIN_MISMATCH: "supplierLedgerGstinMismatch",
  HSN_MAPPING_REQUIRED: "hsnMissing",
  STOCK_ITEM_HSN_MISMATCH: "stockItemHsnMismatch",
  STOCK_ITEM_UNIT_MISMATCH: "stockItemUnitMismatch",
  SOURCE_DOCUMENT_REQUIRED: "sourceDocumentMissing",
  DUPLICATE_INVOICE: "possibleDuplicate",
};

function applyPurchaseValidationPolicy(
  blockers: PurchasePostingIssue[],
  warnings: PurchasePostingIssue[],
  policy: PurchaseValidationPolicy
) {
  const effectiveBlockers: PurchasePostingIssue[] = [];
  const effectiveWarnings = [...warnings];
  for (const blocker of blockers) {
    const policyRule = PURCHASE_VALIDATION_RULE_BY_CODE[blocker.code];
    if (!policyRule) {
      effectiveBlockers.push(blocker);
      continue;
    }
    const severity = policy[policyRule];
    if (severity === "off") continue;
    const controlled = { ...blocker, policyRule };
    if (severity === "warn") {
      effectiveWarnings.push({
        ...controlled,
        requiresAcknowledgement: true,
      });
    } else {
      effectiveBlockers.push(controlled);
    }
  }
  return { blockers: effectiveBlockers, warnings: effectiveWarnings };
}

function calculate(
  source: PurchasePostingSource,
  review: PurchasePostingReview,
  buyerGstin: string,
  accountingSettings: PurchaseAccountingSettings
): PurchasePostingCalculation {
  const supplierStateCode = stateCodeFromGstin(review.supplierGstin);
  const buyerStateCode = stateCodeFromGstin(buyerGstin || review.buyerGstin);
  const taxMode = supplierStateCode && buyerStateCode
    ? supplierStateCode === buyerStateCode ? "cgst_sgst" as const : "igst" as const
    : "unknown" as const;
  const basic = sum(review.lines.map(calculateLineTaxable));
  const invoiceLineGst = sum(source.lines.map((line) =>
    sum([
      moneyPaise(line.invoiceCgstAmount),
      moneyPaise(line.invoiceSgstAmount),
      moneyPaise(line.invoiceIgstAmount),
      !line.invoiceCgstAmount && !line.invoiceSgstAmount && !line.invoiceIgstAmount
        ? moneyPaise(line.invoiceTaxAmount)
        : null,
    ])
  ));
  const invoiceGst = moneyPaise(source.invoiceTaxAmount) ?? invoiceLineGst;
  const configuredGstRate = rateBasisPoints(review.gstRate);
  const gstRateBasisPoints = configuredGstRate !== null
    ? configuredGstRate
    : 0;
  const scrapGstTdsBasis = sum(review.lines.map((line) =>
    materialFromHsn(line.hsn).material === "ms_scrap"
      ? calculateLineTaxable(line)
      : null
  ));
  const scrapGstTdsEligible =
    isValidIsoDate(review.invoiceDate) &&
    review.invoiceDate >= SCRAP_GST_TDS_EFFECTIVE_DATE &&
    validGstin(review.supplierGstin) &&
    validGstin(buyerGstin || review.buyerGstin) &&
    taxMode !== "unknown" &&
    scrapGstTdsBasis > GST_TDS_CONTRACT_THRESHOLD_PAISE;
  const automaticScrapGstTds = accountingSettings.gstTdsEnabled && review.applyGstTds && scrapGstTdsEligible;
  const confirmedDeduction = (enabled: boolean, value: string) => {
    const amount = moneyPaise(value);
    return enabled && amount !== null ? Math.abs(amount) : 0;
  };
  // Section 194Q eligibility depends on buyer-level annual facts that a single
  // invoice cannot prove. The reviewer explicitly enables it for this voucher;
  // Kalika then performs the deterministic 0.1% calculation on the confirmed
  // basis instead of trusting an amount printed (or not printed) on the invoice.
  const reviewed194qBasis = moneyPaise(review.tds194qBasisAmount);
  const tds194qBasis = reviewed194qBasis !== null && reviewed194qBasis > 0
    ? reviewed194qBasis
    : basic;
  const tds194qRate = rateBasisPoints(review.tds194qRate) ?? 10;
  const rawTds194q = review.applyTds194q
    ? Math.round((tds194qBasis * tds194qRate) / 10000)
    : 0;
  const tds194q = review.tds194qRounding === "nearest_rupee"
    ? Math.round(rawTds194q / 100) * 100
    : rawTds194q;
  const transportTds = confirmedDeduction(
    accountingSettings.transporterTdsEnabled && review.applyTransportTds,
    source.invoiceTransportTdsAmount
  );
  const cgstTds = taxMode === "cgst_sgst"
    ? automaticScrapGstTds
      ? Math.round(scrapGstTdsBasis / 100)
      : confirmedDeduction(accountingSettings.gstTdsEnabled && review.applyGstTds, source.invoiceCgstTdsAmount)
    : 0;
  const sgstTds = taxMode === "cgst_sgst"
    ? automaticScrapGstTds
      ? Math.round(scrapGstTdsBasis / 100)
      : confirmedDeduction(accountingSettings.gstTdsEnabled && review.applyGstTds, source.invoiceSgstTdsAmount)
    : 0;
  const igstTds = taxMode === "igst"
    ? automaticScrapGstTds
      ? Math.round(scrapGstTdsBasis / 50)
      : confirmedDeduction(accountingSettings.gstTdsEnabled && review.applyGstTds, source.invoiceIgstTdsAmount)
    : 0;
  const hasGstTds = cgstTds + sgstTds + igstTds > 0;
  const effectiveGstTdsRate = hasGstTds
    ? taxMode === "cgst_sgst" ? "1" : "2"
    : review.gstTdsRate;
  // Reconcile only deductions that are visibly included in the supplier's
  // printed payable. Reviewer-enabled deductions (for example 194Q) alter the
  // Tally payable without manufacturing a mismatch against an invoice that did
  // not print that deduction.
  const printedWithholding = sum([
    moneyPaise(source.invoiceTds194qAmount) !== null ? tds194q : 0,
    moneyPaise(source.invoiceTransportTdsAmount) !== null ? transportTds : 0,
    moneyPaise(source.invoiceCgstTdsAmount) !== null ? cgstTds : 0,
    moneyPaise(source.invoiceSgstTdsAmount) !== null ? sgstTds : 0,
    moneyPaise(source.invoiceIgstTdsAmount) !== null ? igstTds : 0,
  ]);
  const finalCalculation = calculatePurchaseVoucher({
    taxMode,
    defaultGstRate: review.gstRate,
    lines: review.lines.map((line) => ({
      lineId: line.lineId,
      taxableAmount: line.taxableAmount || formatPaise(calculateLineTaxable(line)),
      taxRate: line.taxRate || review.gstRate,
    })),
    freightAmount: review.freightAmount,
    freightGstRate: review.freightGstRate,
    invoiceGstAmount: formatPaise(invoiceGst),
    invoiceTotal: review.invoiceTotal,
    invoiceWithholdingAmount: formatPaise(printedWithholding),
    sourceRoundOffAmount: source.invoiceRoundOffAmount,
    confirmedRoundOffAmount: review.roundOffAmount,
    tcsAmount: review.tcsReceivable ? review.tcsAmount : "0",
    tds194qEnabled: review.applyTds194q,
    tds194qBasisAmount: formatPaise(tds194qBasis),
    tds194qRate: review.tds194qRate,
    tds194qRounding: review.tds194qRounding,
    transportTdsEnabled: accountingSettings.transporterTdsEnabled && review.applyTransportTds,
    sourceTransportTdsAmount: source.invoiceTransportTdsAmount,
    transportTdsRate: review.transportTdsRate,
    cgstTdsAmount: formatPaise(cgstTds),
    sgstTdsAmount: formatPaise(sgstTds),
    igstTdsAmount: formatPaise(igstTds),
  });

  return {
    calculationVersion: PURCHASE_CALCULATION_VERSION,
    taxMode,
    gstRate: formatPaise(gstRateBasisPoints).replace(/\.00$/, ""),
    supplierStateCode,
    buyerStateCode,
    basicAmount: finalCalculation.basicAmount,
    freightAmount: finalCalculation.freightAmount,
    gstTaxableAmount: finalCalculation.gstTaxableAmount,
    cgstAmount: finalCalculation.cgstAmount,
    sgstAmount: finalCalculation.sgstAmount,
    igstAmount: finalCalculation.igstAmount,
    gstAmount: finalCalculation.gstAmount,
    taxBuckets: finalCalculation.taxBuckets,
    invoiceGstAmount: finalCalculation.invoiceGstAmount,
    gstDifference: finalCalculation.gstDifference,
    tdsAmount: formatPaise(sum([moneyPaise(finalCalculation.tds194qAmount), moneyPaise(finalCalculation.transportTdsAmount)])),
    tds194qAmount: finalCalculation.tds194qAmount,
    tds194qBasisAmount: finalCalculation.tds194qBasisAmount,
    tds194qRounding: review.tds194qRounding,
    transportTdsAmount: finalCalculation.transportTdsAmount,
    transportTdsCalculatedAmount: finalCalculation.transportTdsCalculatedAmount,
    transportTdsDifference: finalCalculation.transportTdsDifference,
    cgstTdsAmount: finalCalculation.cgstTdsAmount,
    sgstTdsAmount: finalCalculation.sgstTdsAmount,
    igstTdsAmount: finalCalculation.igstTdsAmount,
    gstTdsBasisAmount: formatPaise(scrapGstTdsBasis),
    gstTdsRate: effectiveGstTdsRate,
    gstTdsAutomatic: automaticScrapGstTds,
    scrapGstTdsEligible,
    totalWithholdingAmount: finalCalculation.totalWithholdingAmount,
    tcsAmount: finalCalculation.tcsAmount,
    roundOffAmount: finalCalculation.roundOffAmount,
    calculatedInvoiceTotal: finalCalculation.calculatedInvoiceTotal,
    calculatedPayable: finalCalculation.calculatedPayable,
    invoiceTotal: finalCalculation.invoiceTotal,
    totalDifference: finalCalculation.totalDifference,
  };
}

export function preparePurchasePosting(params: {
  documents: PurchasePostingDocumentInput[];
  masters: PurchasePostingMasterInput[];
  mappings?: PurchasePostingMappingInput[];
  savedReview?: Partial<PurchasePostingReview> | null;
  caseStatus: string;
  connectionReady: boolean;
  masterDataReady?: boolean;
  companyName: string;
  companyGstin?: string | null;
  sourceDocumentReference?: string | null;
  duplicateExists?: boolean;
  accountingSettings?: PurchaseAccountingSettings;
}) : PurchasePostingPrepared {
  const blockers: PurchasePostingIssue[] = [];
  const warnings: PurchasePostingIssue[] = [];
  const canonicalInvoices = getCanonicalInvoiceDocuments(params.documents);
  const invoiceCandidates = getPurchaseInvoiceCandidates(params.documents, params.companyGstin);

  if (canonicalInvoices.length === 0) {
    blockers.push(issue(
      "NO_INVOICE",
      "Invoice required",
      "This case does not contain an invoice.",
      "case"
    ));
    return {
      eligible: false,
      canonicalInvoiceCount: canonicalInvoices.length,
      invoiceCandidates,
      source: null,
      review: null,
      calculation: null,
      blockers,
      warnings,
      tallyPayload: null,
      suggestedStatus: "correction_required",
    };
  }

  const requestedDocumentId = text(params.savedReview?.selectedInvoiceDocumentId);
  const recommendedCandidates = invoiceCandidates.filter((candidate) => candidate.recommended);
  const selectedCandidate = invoiceCandidates.find((candidate) =>
    requestedDocumentId && candidate.documentId === requestedDocumentId
  ) ?? (recommendedCandidates.length === 1
    ? recommendedCandidates[0]
    : canonicalInvoices.length === 1
      ? invoiceCandidates[0]
      : null);

  if (!selectedCandidate) {
    blockers.push(issue(
      "INVOICE_SELECTION_REQUIRED",
      "Choose the invoice billed to your company",
      `This packet contains ${canonicalInvoices.length} distinct commercial invoices. Select the invoice whose buyer is the active Tally company; duplicate copies have already been collapsed.`,
      "case"
    ));
    return {
      eligible: true,
      canonicalInvoiceCount: canonicalInvoices.length,
      invoiceCandidates,
      source: null,
      review: null,
      calculation: null,
      blockers,
      warnings,
      tallyPayload: null,
      suggestedStatus: "correction_required",
    };
  }

  const invoice = canonicalInvoices.find((candidate) => candidate.id === selectedCandidate.documentId)!;
  const linkedLineSource = findLinkedLineSource(invoice, params.documents);
  const source = buildSource(invoice, linkedLineSource ?? invoice, params.documents);
  if (!isValidIsoDate(source.invoiceDate)) {
    source.invoiceDate = linkedInvoiceDate(invoice, params.documents);
  }
  if (linkedLineSource) {
    warnings.push(issue(
      "INVOICE_LINES_RECOVERED_FROM_LINKED_DOCUMENT",
      "Item details came from another matching document",
      `The invoice did not contain readable item rows, so Bhuleshwar used the matching ${linkedLineSource.document_type}. Check the item details against the invoice before approval.`,
      "line"
    ));
  }
  const review = buildDefaultReview(
    source,
    params.masters,
    params.mappings ?? [],
    normalizeGstin(params.companyGstin) || source.buyerGstin,
    params.savedReview
  );
  review.selectedInvoiceDocumentId = invoice.id;
  if (selectedCandidate.role === "mother_bill") {
    warnings.push(issue(
      "MOTHER_BILL_SELECTED",
      "Upstream mother bill selected",
      "This invoice appears to be billed to the intermediary rather than the active Tally company. Verify the buyer before approval.",
      "invoice"
    ));
  }
  const accountingSettings: PurchaseAccountingSettings = {
    purchaseGoodsTdsEnabled: false,
    transporterTdsEnabled: false,
    gstTdsEnabled: false,
    ...params.accountingSettings,
    validationPolicy: {
      ...DEFAULT_PURCHASE_VALIDATION_POLICY,
      ...params.accountingSettings?.validationPolicy,
    },
  };
  const calculation = calculate(
    source,
    review,
    params.companyGstin || source.buyerGstin,
    accountingSettings
  );

  if (params.caseStatus !== "accepted") {
    blockers.push(issue(
      "CASE_NOT_ACCEPTED",
      "Case approval is separate",
      params.caseStatus === "rejected"
        ? "This case is rejected. Tally posting cannot be approved."
        : "Approve the packet-matching case separately before sending anything to Tally.",
      "case"
    ));
  }
  if (!params.connectionReady || !params.companyName) {
    blockers.push(issue(
      "TALLY_NOT_READY",
      "Tally connection required",
      "Connect TallyPrime and keep the intended company open before posting.",
      "company"
    ));
  }
  if (params.connectionReady && params.masterDataReady === false) {
    blockers.push(issue(
      "TALLY_MASTERS_STALE",
      "Tally data is being refreshed",
      "Bhuleshwar is loading the latest ledgers and stock items from the selected company. Try again if the refresh does not finish.",
      "company"
    ));
  }
  if (!validGstin(review.buyerGstin)) {
    blockers.push(issue(
      "BUYER_GSTIN_REQUIRED",
      "Buyer GSTIN required",
      "Confirm the invoice buyer GSTIN before posting.",
      "invoice"
    ));
  }
  if (!review.invoiceNumber) {
    blockers.push(issue("INVOICE_NUMBER_REQUIRED", "Invoice number required", "Enter the supplier invoice number.", "invoice"));
  }
  const invoiceTotal = moneyPaise(review.invoiceTotal);
  if (invoiceTotal === null || invoiceTotal <= 0) {
    blockers.push(issue(
      "INVOICE_TOTAL_REQUIRED",
      "Invoice total required",
      "Confirm a positive final invoice payable amount.",
      "invoice"
    ));
  }
  if (!isValidIsoDate(review.invoiceDate)) {
    blockers.push(issue("INVOICE_DATE_REQUIRED", "Invoice date required", "Enter a valid invoice date.", "invoice"));
  }
  if (!isValidIsoDate(review.voucherDate)) {
    blockers.push(issue("VOUCHER_DATE_REQUIRED", "Tally voucher date required", "Enter the accounting date for the Tally voucher.", "invoice"));
  }
  if (!validGstin(review.supplierGstin)) {
    blockers.push(issue("SUPPLIER_GSTIN_REQUIRED", "Supplier GSTIN required", "Confirm the supplier GSTIN before posting.", "invoice"));
  }
  const supplierLedger = selectedMaster(params.masters, review.supplierLedgerName, ["ledger"]);
  // The party ledger carrying the invoice's GSTIN, offered as a one-click fix.
  const supplierByGstin = validGstin(review.supplierGstin)
    ? activeMasters(params.masters).find((master) =>
        master.master_type === "ledger" && normalizeGstin(master.gstin) === normalizeGstin(review.supplierGstin)
      )?.tally_name
    : undefined;
  if (!supplierLedger) {
    blockers.push({
      ...issue("SUPPLIER_LEDGER_REQUIRED", "Supplier ledger missing",
        `${text(review.supplierLedgerName) ? `${review.supplierLedgerName} is not a ledger in the selected Tally company.` : "Choose the party ledger."}${supplierByGstin ? ` Use ${supplierByGstin} (GSTIN ${review.supplierGstin}).` : ""}`,
        "invoice"),
      ...(supplierByGstin ? { suggestion: supplierByGstin } : {}),
    });
  } else if (
    supplierLedger.gstin &&
    normalizeGstin(supplierLedger.gstin) !== normalizeGstin(review.supplierGstin)
  ) {
    blockers.push({
      ...issue(
        "SUPPLIER_LEDGER_GSTIN_MISMATCH",
        "Supplier ledger GSTIN does not match",
        `${supplierLedger.tally_name} has GSTIN ${supplierLedger.gstin}, but the invoice is from ${review.supplierGstin}.${supplierByGstin ? ` Use ${supplierByGstin}.` : ""}`,
        "invoice"
      ),
      ...(supplierByGstin ? { suggestion: supplierByGstin } : {}),
    });
  } else if (!supplierLedger.gstin) {
    warnings.push(issue(
      "SUPPLIER_LEDGER_GSTIN_UNAVAILABLE",
      "GSTIN is missing from this supplier ledger",
      "Check that this is the correct supplier ledger before approval.",
      "invoice"
    ));
  }
  // E-way bill details are reference data: problems only warn and the voucher
  // is posted without them rather than blocked.
  if (review.ewayBill?.record) {
    if (!/^\d{12}$/.test(review.ewayBill.number)) {
      warnings.push(issue("EWAY_BILL_NUMBER_INVALID", "E-way bill number not recorded", "An e-way bill number has 12 digits. It will not be recorded in Tally until corrected.", "invoice"));
    }
    if (!isValidIsoDate(review.ewayBill.date)) {
      warnings.push(issue("EWAY_BILL_DATE_INVALID", "E-way bill date missing", "Enter the e-way bill date to record it in Tally.", "invoice"));
    }
    if (review.ewayBill.distanceKm && !/^\d{1,4}$/.test(review.ewayBill.distanceKm)) {
      warnings.push(issue("EWAY_BILL_DISTANCE_INVALID", "E-way bill distance is not a number", "Enter the distance in whole kilometres.", "invoice"));
    }
  }
  if (review.lines.length === 0) {
    blockers.push(issue("LINE_ITEMS_REQUIRED", "Invoice items required", "No invoice items were found. Add the item details before approval.", "invoice"));
  }

  for (const line of review.lines) {
    const material = materialFromHsn(line.hsn);
    if (!line.hsn || material.material === "unknown") {
      blockers.push(issue("HSN_MAPPING_REQUIRED", "HSN mapping required", `Map ${line.hsn || "the missing HSN"} manually before posting.`, "line", line.lineId));
    }
    const quantity = quantityMillis(line.quantity);
    const rate = moneyPaise(line.rate);
    const taxable = moneyPaise(line.taxableAmount);
    if (
      !line.description ||
      !line.unit ||
      quantity === null ||
      quantity <= 0 ||
      rate === null ||
      rate <= 0 ||
      taxable === null ||
      taxable <= 0
    ) {
      blockers.push(issue("LINE_ACCOUNTING_FIELDS_REQUIRED", "Complete item values", "Description, quantity, unit, rate and taxable amount are required.", "line", line.lineId));
    } else {
      const quantityDecimals = line.quantity.replace(/,/g, "").split(".")[1]?.length ?? 0;
      const rateDecimals = line.rate.replace(/,/g, "").split(".")[1]?.length ?? 0;
      const unitMaster = selectedMaster(params.masters, line.unit, ["unit"]);
      const liveUnitPrecision = Number(unitMaster?.raw_payload?.decimalPlaces);
      const quantityPrecision = Number.isFinite(liveUnitPrecision)
        ? Math.max(0, Math.min(6, Math.trunc(liveUnitPrecision)))
        : 3;
      if (quantityDecimals > quantityPrecision || rateDecimals > 4) {
        blockers.push(issue(
          "LINE_PRECISION_UNSUPPORTED",
          "Item precision is unsupported",
          `The selected Tally unit supports ${quantityPrecision} quantity decimal place${quantityPrecision === 1 ? "" : "s"}; Purchase rates support up to 4 decimals.`,
          "line",
          line.lineId
        ));
      }
      const numericQuantity = Number(line.quantity.replace(/,/g, ""));
      const numericRate = Number(line.rate.replace(/,/g, ""));
      const calculatedTaxable = moneyPaise(String(numericQuantity * numericRate));
      if (calculatedTaxable === null) {
        blockers.push(issue(
          "LINE_PRECISION_UNSUPPORTED",
          "Item precision is unsupported",
          "This quantity and rate cannot be represented safely at paise precision.",
          "line",
          line.lineId
        ));
        continue;
      }
      if (Math.abs(calculatedTaxable - taxable) > TOTAL_TOLERANCE_PAISE) {
        blockers.push(issue(
          "LINE_TAXABLE_MISMATCH",
          "Line taxable amount does not reconcile",
          `${line.quantity} × ₹${line.rate} does not equal the taxable amount ₹${line.taxableAmount}.`,
          "line",
          line.lineId
        ));
      }
    }
    const stockItem = selectedMaster(params.masters, line.stockItemName, ["stock_item"]);
    if (!stockItem) {
      blockers.push(issue("STOCK_ITEM_REQUIRED", "Stock item missing", `Select an existing Tally stock item for ${line.description || line.hsn || "this line"}.`, "line", line.lineId));
    } else {
      if (stockItem.hsn_code && normalizeHsn(stockItem.hsn_code) !== normalizeHsn(line.hsn)) {
        blockers.push(issue(
          "STOCK_ITEM_HSN_MISMATCH",
          "Stock item HSN does not match",
          `${stockItem.tally_name} uses HSN ${stockItem.hsn_code}, but the invoice line uses ${line.hsn}.`,
          "line",
          line.lineId
        ));
      }
      if (
        stockItem.unit_name &&
        normalizeUnit(stockItem.unit_name) !== normalizeUnit(line.unit)
      ) {
        blockers.push(issue(
          "STOCK_ITEM_UNIT_MISMATCH",
          "Stock item unit does not match",
          `${stockItem.tally_name} uses ${stockItem.unit_name}, but the invoice line uses ${line.unit}.`,
          "line",
          line.lineId
        ));
      }
    }
    const purchaseLedger = selectedMaster(params.masters, line.purchaseLedgerName, ["ledger"]);
    if (!purchaseLedger) {
      blockers.push(issue(
        "PURCHASE_LEDGER_REQUIRED",
        "Purchase ledger missing",
        "Select the client purchase ledger from the active Tally company.",
        "line",
        line.lineId
      ));
    }
    if (
      purchaseLedger &&
      normalizeKey(purchaseLedger.tally_name) === normalizeKey(review.supplierLedgerName)
    ) {
      blockers.push(issue(
        "PURCHASE_LEDGER_MATCHES_SUPPLIER",
        "Purchase ledger cannot be the supplier",
        "Select a Purchase Accounts ledger for the item. The supplier ledger is posted separately as the party payable.",
        "line",
        line.lineId
      ));
    }
    if (purchaseLedger && (
      purchaseLedger.parent_name &&
      !/purchase|direct\s*expense/i.test(
        masterIdentity(purchaseLedger)
      )
    )) {
      warnings.push(issue(
        "PURCHASE_LEDGER_CLASSIFICATION_UNCONFIRMED",
        "Check this purchase ledger",
        `${purchaseLedger.tally_name} is grouped under ${purchaseLedger.parent_name} in Tally. Confirm that it is correct for this purchase.`,
        "line",
        line.lineId
      ));
    }
    const liveGodowns = activeMasters(params.masters).filter(
      (master) => master.master_type === "godown"
    );
    if (
      line.godownName &&
      liveGodowns.length > 0 &&
      !selectedMaster(params.masters, line.godownName, ["godown"])
    ) {
      blockers.push(issue(
        "GODOWN_REQUIRED",
        "Godown missing",
        "Select an existing godown from the active Tally company.",
        "line",
        line.lineId
      ));
    } else if (source.godownName && !line.godownName) {
      blockers.push(issue(
        "GODOWN_REQUIRED",
        "Godown missing",
        `Select the live Tally godown matching ${source.godownName}.`,
        "line",
        line.lineId
      ));
    } else if (!line.godownName && liveGodowns.length > 1) {
      // With more than one godown Tally rejects the whole voucher ("Godown
      // name in Item Allocations is missing/invalid"); catch it here instead.
      const suggestion =
        review.lines.map((other) => selectedMaster(params.masters, other.godownName, ["godown"])?.tally_name).find(Boolean) ||
        liveGodowns.find((master) => /main\s+location/i.test(master.tally_name))?.tally_name ||
        liveGodowns[0].tally_name;
      blockers.push({
        ...issue(
          "GODOWN_REQUIRED",
          "Godown missing",
          `Choose a godown for ${line.description || "this item"} — Tally rejects items without one in this company. Use ${suggestion}.`,
          "line",
          line.lineId
        ),
        suggestion,
      });
    }
  }

  const gstRateBasisPoints = rateBasisPoints(review.gstRate);
  const invoiceGstPaise = moneyPaise(calculation.invoiceGstAmount) ?? 0;
  const gstApplicable = invoiceGstPaise > TAX_TOLERANCE_PAISE ||
    (gstRateBasisPoints !== null && gstRateBasisPoints > 0);
  if (gstApplicable && (
    gstRateBasisPoints === null ||
    gstRateBasisPoints <= 0 ||
    gstRateBasisPoints > 2800
  )) {
    blockers.push(issue(
      "GST_RATE_REQUIRED",
      "GST rate required",
      "Confirm a valid invoice GST rate before posting.",
      "tax"
    ));
  }
  if (gstApplicable && calculation.taxMode === "unknown") {
    blockers.push(issue("GST_STATE_REQUIRED", "GST state cannot be determined", "Confirm supplier and buyer GSTINs before calculating GST.", "tax"));
  } else if (gstApplicable && calculation.taxMode === "cgst_sgst") {
    const cgstLedger = selectedMaster(params.masters, review.cgstLedgerName, ["ledger", "gst_ledger", "tax_ledger"]);
    const sgstLedger = selectedMaster(params.masters, review.sgstLedgerName, ["ledger", "gst_ledger", "tax_ledger"]);
    const halfRate = Number(review.gstRate || 0) / 2;
    if (!cgstLedger || (!isPurchaseTaxLedger(cgstLedger, "cgst") && !mappingSelects(params.masters, params.mappings ?? [], "gst_rate", [`cgst:${halfRate}`, "cgst"], review.cgstLedgerName))) {
      blockers.push(issue("CGST_LEDGER_REQUIRED", "Input CGST ledger missing", "Select an existing purchase/input CGST ledger.", "tax"));
    }
    if (!sgstLedger || (!isPurchaseTaxLedger(sgstLedger, "sgst") && !mappingSelects(params.masters, params.mappings ?? [], "gst_rate", [`sgst:${halfRate}`, "sgst"], review.sgstLedgerName))) {
      blockers.push(issue("SGST_LEDGER_REQUIRED", "Input SGST ledger missing", "Select an existing purchase/input SGST ledger.", "tax"));
    }
  } else if (gstApplicable) {
    const igstLedger = selectedMaster(params.masters, review.igstLedgerName, ["ledger", "gst_ledger", "tax_ledger"]);
    if (!igstLedger || (!isPurchaseTaxLedger(igstLedger, "igst") && !mappingSelects(params.masters, params.mappings ?? [], "gst_rate", [`igst:${Number(review.gstRate || 0)}`, "igst"], review.igstLedgerName))) {
      blockers.push(issue("IGST_LEDGER_REQUIRED", "Input IGST ledger missing", "Select an existing purchase/input IGST ledger.", "tax"));
    }
  }

  const hasPostEffectiveScrap =
    isValidIsoDate(review.invoiceDate) &&
    review.invoiceDate >= SCRAP_GST_TDS_EFFECTIVE_DATE &&
    review.lines.some((line) => materialFromHsn(line.hsn).material === "ms_scrap");
  if (calculation.scrapGstTdsEligible && !accountingSettings.gstTdsEnabled) {
    blockers.push(issue(
      "SCRAP_GST_TDS_DISABLED",
      "Enable GST TDS for this metal-scrap purchase",
      "This registered-party MS Scrap purchase exceeds ₹2.5 lakh. Enable GST TDS in Purchase accounting settings so Bhuleshwar can withhold 1% CGST + 1% SGST, or 2% IGST.",
      "tax"
    ));
  } else if (
    hasPostEffectiveScrap &&
    validGstin(review.supplierGstin) &&
    validGstin(params.companyGstin || review.buyerGstin) &&
    !calculation.scrapGstTdsEligible
  ) {
    warnings.push(issue(
      "SCRAP_GST_TDS_CONTRACT_THRESHOLD_REVIEW",
      "Confirm the metal-scrap contract value",
      "This invoice alone does not exceed ₹2.5 lakh of MS Scrap. Confirm whether multiple invoices belong to one contract whose taxable value exceeds the threshold.",
      "tax"
    ));
  }

  const purchaseGoodsTdsActive = (moneyPaise(calculation.tds194qAmount) ?? 0) > 0;
  const gstTdsActive = sum([
    moneyPaise(calculation.cgstTdsAmount),
    moneyPaise(calculation.sgstTdsAmount),
    moneyPaise(calculation.igstTdsAmount),
  ]) > 0;
  const tcsReceivableActive =
    review.tcsReceivable && (moneyPaise(calculation.tcsAmount) ?? 0) > 0;
  if (purchaseGoodsTdsActive || gstTdsActive) {
    const requireMatchingInvoiceDeduction = (
      codePrefix: string,
      label: string,
      invoiceAmount: string,
      calculatedAmount: string,
      evidenceRequired = true
    ) => {
      const invoicePaise = moneyPaise(invoiceAmount);
      const calculatedPaise = moneyPaise(calculatedAmount) ?? 0;
      if (calculatedPaise > 0 && invoicePaise === null && evidenceRequired) {
        blockers.push(issue(
          `${codePrefix}_INVOICE_EVIDENCE_REQUIRED`,
          `${label} is not confirmed from the invoice`,
          `The calculated ${label} must match an amount printed on the supplier invoice before approval.`,
          "tax"
        ));
      } else if (
        invoicePaise !== null &&
        Math.abs(calculatedPaise - invoicePaise) > TAX_TOLERANCE_PAISE
      ) {
        blockers.push(issue(
          `${codePrefix}_MISMATCH`,
          `${label} does not reconcile`,
          `Calculated ${label} differs from the invoice by ₹${formatPaise(calculatedPaise - invoicePaise)}.`,
          "tax"
        ));
      }
    };

    if (purchaseGoodsTdsActive) {
      const tdsRateBasisPoints = rateBasisPoints(review.tds194qRate);
      if (
        tdsRateBasisPoints === null ||
        tdsRateBasisPoints <= 0 ||
        tdsRateBasisPoints > 1000
      ) {
        blockers.push(issue("TDS_194Q_RATE_REQUIRED", "Purchase TDS rate required", "Confirm the Section 194Q deduction rate.", "tax"));
      }
      if ((moneyPaise(calculation.tds194qBasisAmount) ?? 0) <= 0) {
        blockers.push(issue("TDS_194Q_BASIS_REQUIRED", "Purchase TDS basis required", "Confirm the basic amount on which Section 194Q should be calculated.", "tax"));
      }
      const tds194qMaster = selectedMaster(params.masters, review.tds194qLedgerName, ["ledger", "tax_ledger"]);
      if (!tds194qMaster || (!isWithholdingLedger(tds194qMaster, "194q") && !mappingSelects(params.masters, params.mappings ?? [], "tds_ledger", ["194q", "purchase_goods"], review.tds194qLedgerName))) {
        blockers.push(withholdingLedgerIssue("TDS_194Q_LEDGER_REQUIRED", "Purchase TDS ledger missing", "Section 194Q TDS", "194q", review.tds194qLedgerName, params.masters));
      }
      warnings.push(issue(
        "TDS_194Q_USER_CONFIRMED",
        "Section 194Q enabled for this voucher",
        `Bhuleshwar calculated ₹${calculation.tds194qAmount} at ${review.tds194qRate}% on ₹${calculation.tds194qBasisAmount}. Eligibility was confirmed by the reviewer, not inferred from this invoice.`,
        "tax"
      ));
    }
    if (gstTdsActive) {
      const gstTdsRate = rateBasisPoints(calculation.gstTdsRate);
      if (gstTdsRate === null || gstTdsRate <= 0) {
        blockers.push(issue("GST_TDS_RATE_REQUIRED", "GST TDS rate required", "Confirm the GST withholding rate for the selected tax mode.", "tax"));
      }
      if (calculation.taxMode === "cgst_sgst") {
      requireMatchingInvoiceDeduction(
        "CGST_TDS",
        "CGST TDS",
        source.invoiceCgstTdsAmount,
        calculation.cgstTdsAmount,
        !calculation.gstTdsAutomatic
      );
      requireMatchingInvoiceDeduction(
        "SGST_TDS",
        "SGST TDS",
        source.invoiceSgstTdsAmount,
        calculation.sgstTdsAmount,
        !calculation.gstTdsAutomatic
      );
      const cgstTdsMaster = selectedMaster(params.masters, review.cgstTdsLedgerName, ["ledger", "tax_ledger"]);
      if (!cgstTdsMaster || (!isWithholdingLedger(cgstTdsMaster, "cgst_tds") && !mappingSelects(params.masters, params.mappings ?? [], "tds_ledger", ["cgst_tds", "gst_tds_cgst"], review.cgstTdsLedgerName))) {
        blockers.push(withholdingLedgerIssue("CGST_TDS_LEDGER_REQUIRED", "CGST TDS ledger missing", "CGST TDS", "cgst_tds", review.cgstTdsLedgerName, params.masters));
      }
      const sgstTdsMaster = selectedMaster(params.masters, review.sgstTdsLedgerName, ["ledger", "tax_ledger"]);
      if (!sgstTdsMaster || (!isWithholdingLedger(sgstTdsMaster, "sgst_tds") && !mappingSelects(params.masters, params.mappings ?? [], "tds_ledger", ["sgst_tds", "gst_tds_sgst"], review.sgstTdsLedgerName))) {
        blockers.push(withholdingLedgerIssue("SGST_TDS_LEDGER_REQUIRED", "SGST TDS ledger missing", "SGST TDS", "sgst_tds", review.sgstTdsLedgerName, params.masters));
      }
      } else if (calculation.taxMode === "igst") {
      requireMatchingInvoiceDeduction(
        "IGST_TDS",
        "IGST TDS",
        source.invoiceIgstTdsAmount,
        calculation.igstTdsAmount,
        !calculation.gstTdsAutomatic
      );
      const igstTdsMaster = selectedMaster(params.masters, review.igstTdsLedgerName, ["ledger", "tax_ledger"]);
      if (!igstTdsMaster || (!isWithholdingLedger(igstTdsMaster, "igst_tds") && !mappingSelects(params.masters, params.mappings ?? [], "tds_ledger", ["igst_tds", "gst_tds_igst"], review.igstTdsLedgerName))) {
        blockers.push(withholdingLedgerIssue("IGST_TDS_LEDGER_REQUIRED", "IGST TDS ledger missing", "IGST TDS", "igst_tds", review.igstTdsLedgerName, params.masters));
      }
      }
    }
  }
  const freightAmount = moneyPaise(review.freightAmount) ?? 0;
  if (freightAmount > 0) {
    const freightMaster = selectedMaster(params.masters, review.freightLedgerName, ["ledger"]);
    if (!freightMaster) {
      blockers.push(issue("FREIGHT_LEDGER_REQUIRED", "Freight ledger missing", "Select the Purchase freight or inward-transport ledger from live Tally.", "tax"));
    }
    const freightRate = rateBasisPoints(review.freightGstRate);
    if (freightRate !== null && freightRate < 0) {
      blockers.push(issue("FREIGHT_GST_RATE_REQUIRED", "Freight GST rate is invalid", "Enter zero for exempt freight or a positive GST rate.", "tax"));
    }
  }

  const transportTdsActive = (moneyPaise(calculation.transportTdsAmount) ?? 0) > 0;
  if (transportTdsActive) {
    const transportTdsRate = rateBasisPoints(review.transportTdsRate);
    if (transportTdsRate === null || transportTdsRate <= 0) {
      blockers.push(issue("TRANSPORT_TDS_RATE_REQUIRED", "Transport TDS rate required", "Confirm the goods-transport TDS rate.", "tax"));
    }
    const transportTdsMaster = selectedMaster(params.masters, review.transportTdsLedgerName, ["ledger", "tax_ledger"]);
    if (!transportTdsMaster || (!isWithholdingLedger(transportTdsMaster, "transport") && !mappingSelects(params.masters, params.mappings ?? [], "tds_ledger", ["transport", "goods_transport"], review.transportTdsLedgerName))) {
      blockers.push(withholdingLedgerIssue("TRANSPORT_TDS_LEDGER_REQUIRED", "Transport TDS ledger missing", "goods-transport TDS", "transport", review.transportTdsLedgerName, params.masters));
    }
  }
  if (tcsReceivableActive) {
    if (!review.tcsLedgerName || !hasMaster(params.masters, review.tcsLedgerName, ["ledger", "tax_ledger"])) {
      blockers.push(issue("TCS_LEDGER_REQUIRED", "TCS ledger missing", "Select the configured TCS Receivable ledger.", "tax"));
    }
    if (moneyPaise(calculation.transportTdsDifference) !== 0) {
      blockers.push(issue(
        "TRANSPORT_TDS_MISMATCH",
        "Transport TDS amount and rate disagree",
        `The extracted deduction differs from ${review.transportTdsRate}% of freight by ₹${calculation.transportTdsDifference}. Correct the extracted invoice before posting.`,
        "tax"
      ));
    }
  }
  if (moneyPaise(calculation.gstDifference) !== null && Math.abs(moneyPaise(calculation.gstDifference) ?? 0) > TAX_TOLERANCE_PAISE) {
    blockers.push(issue("GST_MISMATCH", "GST does not reconcile", `Calculated GST differs from the invoice by ₹${calculation.gstDifference}.`, "tax"));
  }
  if (moneyPaise(calculation.totalDifference) !== null && Math.abs(moneyPaise(calculation.totalDifference) ?? 0) > TOTAL_TOLERANCE_PAISE) {
    blockers.push(issue("TOTAL_MISMATCH", "Invoice total does not reconcile", `Calculated payable differs from the invoice by ₹${calculation.totalDifference}.`, "tax"));
  }
  if (moneyPaise(calculation.roundOffAmount) && !review.roundOffLedgerName) {
    blockers.push(issue("ROUND_OFF_LEDGER_REQUIRED", "Round-off ledger missing", "Select an existing round-off ledger.", "tax"));
  } else if (review.roundOffLedgerName && !hasMaster(params.masters, review.roundOffLedgerName, ["ledger"])) {
    blockers.push(issue("ROUND_OFF_LEDGER_REQUIRED", "Round-off ledger missing", "The selected round-off ledger is not present in the active Tally company.", "tax"));
  }
  const supplierLedgerKey = normalizeKey(review.supplierLedgerName);
  const activeNonPartyLedgers = [
    ...(freightAmount > 0 ? [{ role: "freight", name: review.freightLedgerName }] : []),
    ...(calculation.taxMode === "cgst_sgst"
      ? [
        { role: "CGST", name: review.cgstLedgerName },
        { role: "SGST", name: review.sgstLedgerName },
      ]
      : calculation.taxMode === "igst"
        ? [{ role: "IGST", name: review.igstLedgerName }]
        : []),
    ...(purchaseGoodsTdsActive ? [{ role: "Section 194Q TDS", name: review.tds194qLedgerName }] : []),
    ...(transportTdsActive ? [{ role: "transport TDS", name: review.transportTdsLedgerName }] : []),
    ...(gstTdsActive && calculation.taxMode === "cgst_sgst"
      ? [
        { role: "CGST TDS", name: review.cgstTdsLedgerName },
        { role: "SGST TDS", name: review.sgstTdsLedgerName },
      ]
      : gstTdsActive && calculation.taxMode === "igst"
        ? [{ role: "IGST TDS", name: review.igstTdsLedgerName }]
        : []),
    ...(tcsReceivableActive ? [{ role: "TCS", name: review.tcsLedgerName }] : []),
    ...(moneyPaise(calculation.roundOffAmount)
      ? [{ role: "round-off", name: review.roundOffLedgerName }]
      : []),
  ].filter(
    (entry) => entry.name && normalizeKey(entry.name) === supplierLedgerKey
  );
  if (activeNonPartyLedgers.length > 0) {
    const roles = Array.from(new Set(activeNonPartyLedgers.map((entry) => entry.role)));
    blockers.push(issue(
      "SUPPLIER_LEDGER_ROLE_COLLISION",
      "Supplier ledger is reused",
      `Select separate ${roles.join(", ")} ledger${roles.length === 1 ? "" : "s"}. The supplier ledger is reserved for the final party payable.`,
      "tax"
    ));
  }
  if (!params.sourceDocumentReference) {
    blockers.push(issue("SOURCE_DOCUMENT_REQUIRED", "Source invoice unavailable", "The original invoice file must remain available from the Tally entry.", "source"));
  }
  if (params.duplicateExists) {
    blockers.push(issue("DUPLICATE_INVOICE", "Possible duplicate invoice", "This supplier invoice has already been approved or sent to the selected Tally company.", "invoice"));
  }

  const tallyPayload = {
    companyName: params.companyName,
    voucherType: "Purchase",
    // The standard Purchase voucher type is automatically numbered by Tally.
    // Supplying the supplier's invoice identity as VOUCHERNUMBER overrides that
    // sequence and Tally may reject the import without a field-level error.
    // Keep the supplier invoice in REFERENCE/BILLALLOCATIONS and read back the
    // voucher number assigned by Tally after creation.
    supplierInvoiceNumber: review.invoiceNumber,
    supplierInvoiceDate: review.invoiceDate,
    voucherDate: review.voucherDate,
    supplierLedgerName: review.supplierLedgerName,
    supplierGstin: review.supplierGstin,
    buyerGstin: review.buyerGstin,
    vehicleNumber: review.vehicleNumber,
    // Reference only: the connector records these with e-way bill
    // applicability left at No, as the client books purchases.
    ...(review.ewayBill?.record && /^\d{12}$/.test(review.ewayBill.number) && isValidIsoDate(review.ewayBill.date)
      ? { ewayBill: { ...review.ewayBill, vehicleNumber: review.ewayBill.vehicleNumber || review.vehicleNumber } }
      : {}),
    taxMode: calculation.taxMode,
    items: review.lines.map((line) => {
      const stockItem = selectedMaster(params.masters, line.stockItemName, ["stock_item"]);
      const postingUnit =
        stockItem?.unit_name &&
        normalizeUnit(stockItem.unit_name) === normalizeUnit(line.unit)
          ? stockItem.unit_name
          : line.unit;
      return {
        lineId: line.lineId,
        stockItemName: line.stockItemName,
        purchaseLedgerName: line.purchaseLedgerName,
        description: line.description,
        hsn: normalizeHsn(line.hsn),
        quantity: line.quantity,
        unit: postingUnit,
        rate: line.rate,
        taxableAmount: line.taxableAmount || formatPaise(calculateLineTaxable(line)),
        taxRate: line.taxRate || review.gstRate,
        godownName: line.godownName,
        batchName: line.batchName,
      };
    }),
    charges: [
      ...(freightAmount > 0
        ? [{
          kind: "freight",
          name: review.freightLedgerName,
          rate: review.freightGstRate,
          taxableBasis: calculation.freightAmount,
          amount: calculation.freightAmount,
        }]
        : []),
      ...calculation.taxBuckets.map((bucket) => ({
        ...bucket,
        name: bucket.kind === "cgst"
          ? review.cgstLedgerName
          : bucket.kind === "sgst"
            ? review.sgstLedgerName
            : review.igstLedgerName,
      })),
      ...(tcsReceivableActive
        ? [{ kind: "tcs", name: review.tcsLedgerName, amount: calculation.tcsAmount }]
        : []),
    ],
    withholdings: [
      ...(purchaseGoodsTdsActive
        ? [{
          kind: "tds_194q",
          name: review.tds194qLedgerName,
          rate: review.tds194qRate,
          taxableBasis: calculation.tds194qBasisAmount,
          rounding: calculation.tds194qRounding,
          amount: calculation.tds194qAmount,
        }]
        : []),
      ...(transportTdsActive
        ? [{
          kind: "transport_tds",
          name: review.transportTdsLedgerName,
          rate: review.transportTdsRate,
          taxableBasis: calculation.freightAmount,
          amount: calculation.transportTdsAmount,
        }]
        : []),
      ...(gstTdsActive && calculation.taxMode === "cgst_sgst"
        ? [
          { kind: "cgst_tds", name: review.cgstTdsLedgerName, rate: calculation.gstTdsRate, taxableBasis: calculation.gstTdsBasisAmount, amount: calculation.cgstTdsAmount },
          { kind: "sgst_tds", name: review.sgstTdsLedgerName, rate: calculation.gstTdsRate, taxableBasis: calculation.gstTdsBasisAmount, amount: calculation.sgstTdsAmount },
        ]
        : gstTdsActive && calculation.taxMode === "igst"
          ? [{ kind: "igst_tds", name: review.igstTdsLedgerName, rate: calculation.gstTdsRate, taxableBasis: calculation.gstTdsBasisAmount, amount: calculation.igstTdsAmount }]
          : []),
    ],
    ledgers: {
      cgst: calculation.taxMode === "cgst_sgst" ? { name: review.cgstLedgerName, amount: calculation.cgstAmount } : null,
      sgst: calculation.taxMode === "cgst_sgst" ? { name: review.sgstLedgerName, amount: calculation.sgstAmount } : null,
      igst: calculation.taxMode === "igst" ? { name: review.igstLedgerName, amount: calculation.igstAmount } : null,
      tds: null,
      tcs: tcsReceivableActive ? { name: review.tcsLedgerName, amount: calculation.tcsAmount } : null,
      roundOff: moneyPaise(calculation.roundOffAmount) ? { name: review.roundOffLedgerName, amount: calculation.roundOffAmount } : null,
    },
    basicAmount: calculation.basicAmount,
    finalPayableAmount: calculation.calculatedPayable,
    canonicalVersion: 2,
    calculationVersion: calculation.calculationVersion,
    narration: review.narration,
  };

  const effectiveIssues = applyPurchaseValidationPolicy(
    blockers,
    warnings,
    accountingSettings.validationPolicy
  );

  return {
    eligible: true,
    canonicalInvoiceCount: canonicalInvoices.length,
    invoiceCandidates,
    source,
    review,
    calculation,
    blockers: effectiveIssues.blockers,
    warnings: effectiveIssues.warnings,
    tallyPayload,
    suggestedStatus: effectiveIssues.blockers.length > 0
      ? "correction_required"
      : "ready_for_approval",
  };
}

export function normalizePurchaseDuplicatePart(value: unknown) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function compactPurchasePostingReview(
  base: PurchasePostingReview | null,
  reviewed: PurchasePostingReview | null
): PurchasePostingReviewPatch {
  if (!reviewed) return {};
  if (!base) return reviewed;

  const patch: PurchasePostingReviewPatch = {};
  const scalarKeys = (Object.keys(reviewed) as Array<keyof PurchasePostingReview>)
    .filter((key) => key !== "lines");

  for (const key of scalarKeys) {
    if (reviewed[key] !== base[key]) {
      (patch as Record<string, unknown>)[key] = reviewed[key];
    }
  }

  const baseLines = new Map(base.lines.map((line) => [line.lineId, line]));
  const linePatches = reviewed.lines.flatMap((line) => {
    const baseLine = baseLines.get(line.lineId);
    const linePatch: Partial<PurchasePostingReviewLine> & Pick<PurchasePostingReviewLine, "lineId"> = {
      lineId: line.lineId,
    };

    for (const key of Object.keys(line) as Array<keyof PurchasePostingReviewLine>) {
      if (key !== "lineId" && line[key] !== baseLine?.[key]) {
        (linePatch as Record<string, unknown>)[key] = line[key];
      }
    }

    return Object.keys(linePatch).length > 1 ? [linePatch] : [];
  });

  if (linePatches.length > 0) patch.lines = linePatches;
  return patch;
}

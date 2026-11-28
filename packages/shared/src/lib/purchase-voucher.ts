export const PURCHASE_CALCULATION_VERSION = 2;

/** Ordinary billet purchases no longer carry general sale-of-goods TCS from April 2025. */
export function allowsPurchaseTcs(invoiceDate: string, lines: readonly { hsn: string; description: string }[]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) || invoiceDate < "2025-04-01") return true;
  const onlyBillets = lines.length > 0 && lines.every(({ hsn, description }) => {
    if (/\bscrap\b/i.test(description)) return false;
    const code = hsn.trim();
    return code === "72071920" || ((!code || code.startsWith("7207")) && /\bbillets?\b/i.test(description));
  });
  return !onlyBillets;
}

export type PurchaseTaxMode = "cgst_sgst" | "igst" | "unknown";

export type PurchaseCalculationLine = {
  lineId: string;
  taxableAmount: string;
  taxRate?: string;
};

export type PurchaseCalculationInput = {
  taxMode: PurchaseTaxMode;
  roundPurchaseAndGst?: boolean;
  defaultGstRate: string;
  lines: PurchaseCalculationLine[];
  freightAmount: string;
  freightGstRate: string;
  invoiceGstAmount: string;
  invoiceTotal: string;
  /** Deductions visibly included in the source invoice's printed payable. */
  invoiceWithholdingAmount?: string;
  printedDeductions?: Record<"tds194q" | "transport" | "cgst" | "sgst" | "igst", boolean>;
  sourceRoundOffAmount: string;
  confirmedRoundOffAmount: string;
  tcsAmount: string;
  tds194qEnabled: boolean;
  tds194qBasisAmount: string;
  tds194qRate: string;
  tds194qRounding: "paise" | "nearest_rupee";
  transportTdsEnabled: boolean;
  sourceTransportTdsAmount: string;
  transportTdsRate: string;
  cgstTdsAmount: string;
  sgstTdsAmount: string;
  igstTdsAmount: string;
};

export type PurchaseTaxBucket = {
  kind: "cgst" | "sgst" | "igst";
  rate: string;
  taxableBasis: string;
  amount: string;
};

function scaled(value: unknown, scale: number): number | null {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  const match = normalized.match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
  if (!match || (!match[2] && !match[3])) return null;
  const decimals = Math.round(Math.log10(scale));
  const fractionSource = (match[3] || "").padEnd(decimals + 1, "0");
  const whole = Number(match[2] || 0);
  const fraction = Number(fractionSource.slice(0, decimals) || 0);
  const rounded = whole * scale + fraction + (Number(fractionSource[decimals] || 0) >= 5 ? 1 : 0);
  if (!Number.isSafeInteger(rounded)) return null;
  return match[1] === "-" ? -rounded : rounded;
}

export function purchaseMoneyPaise(value: unknown) {
  return scaled(value, 100);
}

export function purchaseRateBasisPoints(value: unknown) {
  return scaled(value, 100);
}

export function purchaseFormatPaise(value: number) {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const absolute = Math.abs(rounded);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function taxAmount(taxablePaise: number, rateBasisPoints: number) {
  return Math.round((taxablePaise * rateBasisPoints) / 10_000);
}

function addBucket(map: Map<string, { kind: PurchaseTaxBucket["kind"]; rate: number; basis: number; amount: number }>, kind: PurchaseTaxBucket["kind"], rate: number, basis: number, amount: number) {
  if (amount === 0) return;
  const key = `${kind}:${rate}`;
  const current = map.get(key) ?? { kind, rate, basis: 0, amount: 0 };
  current.basis += basis;
  current.amount += amount;
  map.set(key, current);
}

// Round the total once. Distribute its paise adjustment across the original
// amounts so every posted allocation still adds up to the displayed total.
function roundTotalToRupees(amounts: number[], targetPaise?: number) {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (total <= 0) return amounts;
  const adjustment = (targetPaise ?? Math.round(total / 100) * 100) - total;
  let cumulative = 0;
  let allocated = 0;
  return amounts.map(amount => {
    cumulative += amount;
    const target = Math.round(cumulative / total * adjustment);
    const result = amount + target - allocated;
    allocated = target;
    return result;
  });
}

export function calculatePurchaseVoucher(input: PurchaseCalculationInput) {
  const bucketMap = new Map<string, { kind: PurchaseTaxBucket["kind"]; rate: number; basis: number; amount: number }>();
  const defaultRate = purchaseRateBasisPoints(input.defaultGstRate) ?? 0;
  let basic = 0;
  let gstTaxable = 0;

  const freightInput = Math.max(0, purchaseMoneyPaise(input.freightAmount) ?? 0);
  const rows = [...input.lines, { lineId: "", taxableAmount: purchaseFormatPaise(freightInput), taxRate: input.freightGstRate || "0" }];
  const bases = rows.map(row => purchaseMoneyPaise(row.taxableAmount) ?? 0);
  const rates = rows.map(row => purchaseRateBasisPoints(row.taxRate) ?? defaultRate);
  const taxes = bases.map((basis, i) => input.taxMode === "unknown" ? 0 : taxAmount(basis, rates[i]));
  const book = (amounts: number[]) => input.roundPurchaseAndGst ? roundTotalToRupees(amounts) : amounts;
  const bookedBases = book(bases);
  const central = taxes.map(amount => input.taxMode === "cgst_sgst" ? Math.round(amount / 2) : 0);
  // Each local GST head receives half of GST before whole-rupee rounding.
  // Splitting odd paise first can otherwise push only one head over 50 paise.
  const localHead = Math.round(taxes.reduce((sum, amount) => sum + amount, 0) / 200) * 100;
  const cgstRows = input.taxMode === "cgst_sgst" && input.roundPurchaseAndGst ? roundTotalToRupees(taxes, localHead) : central;
  const sgstRows = input.roundPurchaseAndGst ? cgstRows : taxes.map((amount, i) => input.taxMode === "cgst_sgst" ? amount - central[i] : 0);
  const igstRows = book(taxes.map(amount => input.taxMode === "igst" ? amount : 0));
  const freight = bookedBases[input.lines.length];
  const itemTaxes = rows.map((line, i) => {
    const basis = bookedBases[i], rate = rates[i];
    if (i < input.lines.length) basic += basis;
    if (rate > 0) gstTaxable += basis;
    if (input.taxMode === "cgst_sgst") {
      addBucket(bucketMap, "cgst", rate / 2, basis, cgstRows[i]);
      addBucket(bucketMap, "sgst", rate / 2, basis, sgstRows[i]);
    } else if (input.taxMode === "igst") {
      addBucket(bucketMap, "igst", rate, basis, igstRows[i]);
    }
    return {
      lineId: line.lineId, taxable: purchaseFormatPaise(basis),
      rate: purchaseFormatPaise(rate).replace(/\.00$/, ""),
      gst: purchaseFormatPaise(cgstRows[i] + sgstRows[i] + igstRows[i]),
      cgst: purchaseFormatPaise(cgstRows[i]), sgst: purchaseFormatPaise(sgstRows[i]),
    };
  }).slice(0, input.lines.length);

  const buckets: PurchaseTaxBucket[] = Array.from(bucketMap.values()).map((bucket) => ({
    kind: bucket.kind,
    rate: purchaseFormatPaise(bucket.rate).replace(/\.00$/, ""),
    taxableBasis: purchaseFormatPaise(bucket.basis),
    amount: purchaseFormatPaise(bucket.amount),
  }));
  const byKind = (kind: PurchaseTaxBucket["kind"]) =>
    Array.from(bucketMap.values()).filter((bucket) => bucket.kind === kind).reduce((sum, bucket) => sum + bucket.amount, 0);
  const cgst = byKind("cgst");
  const sgst = byKind("sgst");
  const igst = byKind("igst");
  const gst = cgst + sgst + igst;

  const tdsBasis = purchaseMoneyPaise(input.tds194qBasisAmount) ?? basic;
  const tdsRate = purchaseRateBasisPoints(input.tds194qRate) ?? 0;
  const rawTds = input.tds194qEnabled ? taxAmount(tdsBasis, tdsRate) : 0;
  const tds194q = input.tds194qRounding === "nearest_rupee" ? Math.round(rawTds / 100) * 100 : rawTds;
  const transportTdsCalculated = input.transportTdsEnabled
    ? taxAmount(freight, purchaseRateBasisPoints(input.transportTdsRate) ?? 0)
    : 0;
  // A deduction printed on the invoice is used as printed. Invoices rarely
  // print it, so otherwise the rate on freight is deducted, rounded down to
  // the whole rupee as the client books it.
  const printedTransportTds = purchaseMoneyPaise(input.sourceTransportTdsAmount);
  const transportTds = !input.transportTdsEnabled
    ? 0
    : printedTransportTds !== null
      ? Math.abs(printedTransportTds)
      : Math.floor(transportTdsCalculated / 100) * 100;
  const cgstTds = Math.abs(purchaseMoneyPaise(input.cgstTdsAmount) ?? 0);
  const sgstTds = Math.abs(purchaseMoneyPaise(input.sgstTdsAmount) ?? 0);
  const igstTds = Math.abs(purchaseMoneyPaise(input.igstTdsAmount) ?? 0);
  const withholdings = tds194q + transportTds + cgstTds + sgstTds + igstTds;
  const tcs = Math.abs(purchaseMoneyPaise(input.tcsAmount) ?? 0);
  const sourceRoundOff = purchaseMoneyPaise(input.sourceRoundOffAmount);
  const confirmedRoundOff = purchaseMoneyPaise(input.confirmedRoundOffAmount);
  // The supplier rounds its printed total before our deductions; that figure
  // only reconciles the invoice. The Tally voucher rounds the final payable
  // (after TDS) to the nearest rupee, like the client's manual entries.
  const invoiceRoundOff = sourceRoundOff !== null && sourceRoundOff !== 0 ? (confirmedRoundOff ?? sourceRoundOff) : 0;
  const unroundedPayable = basic + freight + gst + tcs - withholdings;
  const roundOff = input.roundPurchaseAndGst ? 0 : Math.round(unroundedPayable / 100) * 100 - unroundedPayable;
  const gross = basic + freight + gst + tcs + (input.roundPurchaseAndGst ? 0 : invoiceRoundOff);
  const payable = unroundedPayable + roundOff;
  const invoiceGst = purchaseMoneyPaise(input.invoiceGstAmount) ?? 0;
  const invoiceTotal = purchaseMoneyPaise(input.invoiceTotal) ?? 0;
  const printed = input.printedDeductions;
  const invoiceWithholding = printed
    ? (printed.tds194q ? tds194q : 0) + (printed.transport ? transportTds : 0) +
      (printed.cgst ? cgstTds : 0) + (printed.sgst ? sgstTds : 0) + (printed.igst ? igstTds : 0)
    : Math.abs(purchaseMoneyPaise(input.invoiceWithholdingAmount) ?? 0);

  return {
    calculationVersion: PURCHASE_CALCULATION_VERSION,
    basicAmount: purchaseFormatPaise(basic),
    freightAmount: purchaseFormatPaise(freight),
    gstTaxableAmount: purchaseFormatPaise(gstTaxable),
    taxBuckets: buckets,
    itemTaxes,
    cgstAmount: purchaseFormatPaise(cgst),
    sgstAmount: purchaseFormatPaise(sgst),
    igstAmount: purchaseFormatPaise(igst),
    gstAmount: purchaseFormatPaise(gst),
    invoiceGstAmount: purchaseFormatPaise(invoiceGst),
    sourceGstDifference: purchaseFormatPaise(taxes.reduce((sum, amount) => sum + amount, 0) - invoiceGst),
    gstDifference: purchaseFormatPaise(gst - invoiceGst),
    tds194qAmount: purchaseFormatPaise(tds194q),
    tds194qBasisAmount: purchaseFormatPaise(tdsBasis),
    transportTdsAmount: purchaseFormatPaise(transportTds),
    transportTdsCalculatedAmount: purchaseFormatPaise(transportTdsCalculated),
    transportTdsDifference: purchaseFormatPaise(printedTransportTds !== null ? transportTds - transportTdsCalculated : 0),
    cgstTdsAmount: purchaseFormatPaise(cgstTds),
    sgstTdsAmount: purchaseFormatPaise(sgstTds),
    igstTdsAmount: purchaseFormatPaise(igstTds),
    totalWithholdingAmount: purchaseFormatPaise(withholdings),
    tcsAmount: purchaseFormatPaise(tcs),
    roundOffAmount: purchaseFormatPaise(roundOff),
    calculatedInvoiceTotal: purchaseFormatPaise(gross),
    calculatedPayable: purchaseFormatPaise(payable),
    invoiceTotal: purchaseFormatPaise(invoiceTotal),
    totalDifference: purchaseFormatPaise(gross - invoiceWithholding - invoiceTotal),
  };
}

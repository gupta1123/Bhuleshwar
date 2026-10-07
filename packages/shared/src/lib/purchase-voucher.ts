export const PURCHASE_CALCULATION_VERSION = 2;

export type PurchaseTaxMode = "cgst_sgst" | "igst" | "unknown";

export type PurchaseCalculationLine = {
  lineId: string;
  taxableAmount: string;
  taxRate?: string;
};

export type PurchaseCalculationInput = {
  taxMode: PurchaseTaxMode;
  defaultGstRate: string;
  lines: PurchaseCalculationLine[];
  freightAmount: string;
  freightGstRate: string;
  invoiceGstAmount: string;
  invoiceTotal: string;
  /** Deductions visibly included in the source invoice's printed payable. */
  invoiceWithholdingAmount?: string;
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

export function calculatePurchaseVoucher(input: PurchaseCalculationInput) {
  const bucketMap = new Map<string, { kind: PurchaseTaxBucket["kind"]; rate: number; basis: number; amount: number }>();
  const defaultRate = purchaseRateBasisPoints(input.defaultGstRate) ?? 0;
  let basic = 0;
  let gstTaxable = 0;

  for (const line of input.lines) {
    const basis = purchaseMoneyPaise(line.taxableAmount) ?? 0;
    const rate = purchaseRateBasisPoints(line.taxRate) ?? defaultRate;
    basic += basis;
    if (rate > 0) gstTaxable += basis;
    const totalTax = input.taxMode === "unknown" ? 0 : taxAmount(basis, rate);
    if (input.taxMode === "cgst_sgst") {
      const cgst = Math.round(totalTax / 2);
      addBucket(bucketMap, "cgst", rate / 2, basis, cgst);
      addBucket(bucketMap, "sgst", rate / 2, basis, totalTax - cgst);
    } else if (input.taxMode === "igst") {
      addBucket(bucketMap, "igst", rate, basis, totalTax);
    }
  }

  const freight = Math.max(0, purchaseMoneyPaise(input.freightAmount) ?? 0);
  const freightRate = purchaseRateBasisPoints(input.freightGstRate) ?? 0;
  if (freightRate > 0) gstTaxable += freight;
  const freightTax = input.taxMode === "unknown" ? 0 : taxAmount(freight, freightRate);
  if (freight > 0 && freightRate > 0 && input.taxMode === "cgst_sgst") {
    const cgst = Math.round(freightTax / 2);
    addBucket(bucketMap, "cgst", freightRate / 2, freight, cgst);
    addBucket(bucketMap, "sgst", freightRate / 2, freight, freightTax - cgst);
  } else if (freight > 0 && freightRate > 0 && input.taxMode === "igst") {
    addBucket(bucketMap, "igst", freightRate, freight, freightTax);
  }

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
  const roundOff = Math.round(unroundedPayable / 100) * 100 - unroundedPayable;
  const gross = basic + freight + gst + tcs + invoiceRoundOff;
  const payable = unroundedPayable + roundOff;
  const invoiceGst = purchaseMoneyPaise(input.invoiceGstAmount) ?? 0;
  const invoiceTotal = purchaseMoneyPaise(input.invoiceTotal) ?? 0;
  const invoiceWithholding = Math.abs(purchaseMoneyPaise(input.invoiceWithholdingAmount) ?? 0);

  return {
    calculationVersion: PURCHASE_CALCULATION_VERSION,
    basicAmount: purchaseFormatPaise(basic),
    freightAmount: purchaseFormatPaise(freight),
    gstTaxableAmount: purchaseFormatPaise(gstTaxable),
    taxBuckets: buckets,
    cgstAmount: purchaseFormatPaise(cgst),
    sgstAmount: purchaseFormatPaise(sgst),
    igstAmount: purchaseFormatPaise(igst),
    gstAmount: purchaseFormatPaise(gst),
    invoiceGstAmount: purchaseFormatPaise(invoiceGst),
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

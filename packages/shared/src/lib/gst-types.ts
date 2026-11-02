// Public shapes of the GST reconciliation engine (gst-engine.ts, gst-normalize.ts).
export type GstDocType = "inv" | "crn" | "dbn";
export type GstSource = "books" | "gstr2a" | "gstr2b";

export interface GstTax {
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total: number;
  value?: number;
}

export interface CanonicalInvoice {
  key: string;
  source: GstSource;
  gstin: string;
  supplierName: string;
  invoiceNo: string;
  normNo: string;
  invoiceDate: string;
  period: string;
  docType: GstDocType;
  rcm: boolean;
  itcAvailable: string;
  reason: string;
  reasonLabel: string;
  pos: string;
  imsAction: "" | "A" | "R" | "P";
  excluded: boolean;
  tax: GstTax;
  claimed: boolean;
  eligibility: string;
  voucherNumber: string;
  raw: unknown;
}

export type GstBucketId =
  | "matched"
  | "valueDiff"
  | "booksOnly"
  | "portalOnly"
  | "ineligible"
  | "rule37A"
  | "reopened"
  | "periodShift"
  | "duplicate";

export interface GstReconTolerance {
  amount: number;
  percent: number;
  dateWindowDays: number;
}

export interface GstReconOptions {
  asOf?: string;
  annualReturnDates?: Record<string, string>;
  tolerance?: Partial<GstReconTolerance>;
  includeA2?: boolean;
  fuzzy?: boolean;
  fuzzyWindowDays?: number;
  /** Prior run per item key: { b: bucket, p: 1 if 2B supported it }. */
  prior?: Record<string, { b: GstBucketId; p?: number }>;
}

export interface GstReconInput {
  books: CanonicalInvoice[];
  a2: CanonicalInvoice[];
  b2: CanonicalInvoice[];
  g3b: unknown[];
  suppliers?: Array<{ gstin: string; filingFrequency?: string }>;
  opts?: GstReconOptions;
}

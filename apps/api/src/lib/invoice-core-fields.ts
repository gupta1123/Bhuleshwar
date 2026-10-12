type InvoiceCoreFields = Partial<Record<string, string>>;

const GSTIN_PATTERN = /\b[0-9]{2}[A-Z0-9]{12,13}\b/i;

function sourceText(value: string | null | undefined) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[|*_`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeGstin(value: string | undefined) {
  const normalized = String(value ?? "").toUpperCase().replace(/\s+/g, "");
  return GSTIN_PATTERN.test(normalized) ? normalized : "";
}

function normalizeAmount(value: string | undefined) {
  const normalized = String(value ?? "").replace(/[^0-9.-]/g, "");
  if (!normalized || !/\d/.test(normalized)) return "";
  const amount = Number(normalized);
  return Number.isFinite(amount) ? String(amount) : "";
}

function parseDate(value: string | undefined) {
  const raw = String(value ?? "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return iso[0];

  const numeric = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (numeric) {
    const year = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
    return `${year}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`;
  }

  const named = raw.match(/^(\d{1,2})[\s./-]+([A-Za-z]+)[\s,./-]+(\d{2,4})$/);
  if (!named) return "";
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = months.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
  if (month < 1) return "";
  const year = named[3].length === 2 ? `20${named[3]}` : named[3];
  return `${year}-${String(month).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
}

function labelledToken(source: string, labels: string) {
  return source.match(new RegExp(`\\b(?:${labels})\\b\\s*[:#-]?\\s*([A-Z0-9][A-Z0-9./-]{2,})`, "i"))?.[1] ?? "";
}

function labelledDate(source: string) {
  const dateValue = String.raw`(\d{1,2}(?:[./-]\d{1,2}[./-]\d{2,4}|[\s./-]+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\s,./-]+\d{2,4})|\d{4}-\d{2}-\d{2})`;
  const match = source.match(new RegExp(`\\b(?:DOCUMENT\\s+DATE|INVOICE\\s+DATE|DATE\\s+OF\\s+INVOICE)\\b\\s*[:#-]?\\s*${dateValue}`, "i"));
  return parseDate(match?.[1]);
}

function labelledAmount(source: string, labels: string) {
  const match = source.match(new RegExp(`\\b(?:${labels})\\b\\s*[:#-]?\\s*(?:INR|RS\\.?|₹)?\\s*([+-]?\\d[\\d,]*(?:\\.\\d{1,2})?)`, "i"));
  return normalizeAmount(match?.[1]);
}

export function extractInvoiceCoreFieldsFromText(visibleText: string | null | undefined): InvoiceCoreFields {
  const source = sourceText(visibleText);
  if (!source) return {};

  const supplierGstin = normalizeGstin(
    source.match(/\bSUPPLIER\s+GSTIN(?:\s*\/\s*UIN)?\b\s*[:#-]?\s*([0-9A-Z]{14,15})/i)?.[1]
  );
  const buyerGstin = normalizeGstin(
    source.match(/\bBUYER\s+GSTIN(?:\s*\/\s*UIN)?\b\s*[:#-]?\s*([0-9A-Z]{14,15})/i)?.[1]
  );

  const invoiceNumber =
    labelledToken(source, "DOCUMENT\\s+(?:NUMBER|NO\\.?)") ||
    labelledToken(source, "TAX\\s+INVOICE\\s+(?:NUMBER|NO\\.?)") ||
    labelledToken(source, "INVOICE\\s+(?:NUMBER|NO\\.?)");
  const totalAmount =
    labelledAmount(source, "GRAND\\s+TOTAL") ||
    labelledAmount(source, "TOTAL\\s+(?:INVOICE\\s+VALUE|INV\\.?\\s*AMT)") ||
    labelledAmount(source, "INVOICE\\s+TOTAL") ||
    labelledAmount(source, "NET\\s+PAYABLE");
  const totalTaxableAmount = labelledAmount(source, "TAXABLE\\s+(?:VALUE|AMOUNT)");

  return {
    ...(invoiceNumber ? { invoiceNumber } : {}),
    ...(labelledDate(source) ? { documentDate: labelledDate(source) } : {}),
    ...(supplierGstin ? { supplierGstin } : {}),
    ...(buyerGstin ? { buyerGstin } : {}),
    ...(totalAmount ? { totalAmount } : {}),
    ...(totalTaxableAmount ? { totalTaxableAmount, subtotal: totalTaxableAmount } : {}),
  };
}

export function applyInvoiceCoreFieldFallback(
  fields: InvoiceCoreFields,
  docType: string,
  visibleText: string
) {
  if (!(docType === "Invoice" || docType === "Tax Invoice") || !visibleText.trim()) return fields;
  const recovered = extractInvoiceCoreFieldsFromText(visibleText);
  const next = { ...fields };
  for (const key of ["invoiceNumber", "documentDate", "supplierGstin", "buyerGstin", "totalAmount", "totalTaxableAmount", "subtotal"]) {
    if (!next[key] && recovered[key]) next[key] = recovered[key];
  }
  return next;
}

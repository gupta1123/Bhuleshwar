import type { DocType, FieldKey } from "@/types/pipeline";

export type InvoiceCommercialFields = {
  documentDate: string;
  vehicleNumber: string;
  taxAmount: string;
  tdsAmount: string;
  tdsRate: string;
  freightAmount: string;
  freightGstRate: string;
  tds194qAmount: string;
  tds194qRate: string;
  transportTdsAmount: string;
  transportTdsRate: string;
  cgstTdsAmount: string;
  sgstTdsAmount: string;
  igstTdsAmount: string;
  gstTdsRate: string;
  tcsAmount: string;
  roundOffAmount: string;
};

function normalizeVehicleNumber(value: string | undefined) {
  const normalized = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4}$/.test(normalized)
    ? normalized
    : "";
}

function vehicleNumberFromText(source: string) {
  const labelled = source.match(
    /\b(?:VEHICLE(?:\s+(?:NO|NUMBER|REFERENCE))?|LORRY\s+NO|TRUCK\s+NO)\s*[:#-]?\s*([A-Z]{2}[\s-]*\d{1,2}[\s-]*[A-Z]{1,3}[\s-]*\d{3,4})\b/i
  )?.[1];
  return normalizeVehicleNumber(labelled);
}

function cleanAmount(value: string | undefined) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/,/g, "")
    .replace(/^\+/, "")
    .trim();
}

function amountNearLabel(
  source: string,
  labelPattern: string,
  options: { signed?: boolean } = {}
) {
  const matches = [
    ...source.matchAll(new RegExp(`\\b(?:${labelPattern})\\b([^\\r\\n]{0,120})`, "gi")),
  ];
  const candidates: Array<{ value: string; score: number }> = [];

  for (const match of matches) {
    const context = `${match[0] ?? ""}`;
    const tail = `${match[1] ?? ""}`.replace(/\b\d+(?:\.\d+)?\s*%/g, " ");
    const isRateOnly = /\bRATE\b/i.test(context);
    const currency = tail.match(
      /(?:INR|RS\.?|₹|â‚¹)\s*([+-]?\s*[\d,]+(?:\.\d{1,2})?)/i
    );
    if (currency?.[1]) {
      const value = cleanAmount(currency[1]);
      if (value) {
        candidates.push({
          value: options.signed ? value : value.replace(/^-/, ""),
          score: 10 + (/\bAMOUNT\b/i.test(context) ? 2 : 0),
        });
      }
      continue;
    }

    if (isRateOnly) continue;
    const number = tail.match(/(?:^|[\s:=\-])([+-]?\s*\d[\d,]*(?:\.\d{1,2})?)(?=$|[\s.)\]])/);
    if (!number?.[1]) continue;
    const value = cleanAmount(number[1]);
    if (!value) continue;
    candidates.push({
      value: options.signed ? value : value.replace(/^-/, ""),
      score:
        (/\bAMOUNT\b/i.test(context) ? 4 : 0) +
        (/[,.]\d{1,2}\b|,\d{3}\b/.test(number[1]) ? 2 : 0) +
        (/[:=\-]/.test(tail) ? 1 : 0),
    });
  }

  return candidates.sort((left, right) => right.score - left.score)[0]?.value ?? "";
}

function invoiceDateFromText(source: string) {
  const dateValue = String.raw`(\d{1,2}(?:[./-]\d{1,2}[./-]|[\s./-]+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\s,./-]+)\d{2,4}|\d{4}-\d{2}-\d{2})`;
  const patterns = [
    new RegExp(String.raw`\bINVOICE\s+DATE\s*[:\-]?\s*${dateValue}\b`, "i"),
    new RegExp(String.raw`\bDATE\s+OF\s+INVOICE\s*[:\-]?\s*${dateValue}\b`, "i"),
    new RegExp(
      String.raw`\bINVOICE\s+(?:NO|NUMBER)\.?\s*[:#-]?[\s\S]{0,220}?\b(?:DATED|DATE)\s*[:\-]?\s*${dateValue}\b`,
      "i"
    ),
    new RegExp(
      String.raw`\bTAX\s+INVOICE\b[\s\S]{0,220}?\bDATE\s*[:\-]\s*${dateValue}\b`,
      "i"
    ),
    new RegExp(String.raw`\bDATE\s*[:\-]\s*${dateValue}\b`, "i"),
  ];
  for (const pattern of patterns) {
    const value = source.match(pattern)?.[1];
    if (!value) continue;
    const iso = value.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (iso) return iso[1];
    const numeric = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (numeric) {
      const year = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
      return `${year}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`;
    }
    const named = value.match(/^(\d{1,2})[\s./-]+([A-Za-z]+)[\s,./-]+(\d{2,4})$/);
    if (named) {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const month = months.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
      if (month > 0) {
        const year = named[3].length === 2 ? `20${named[3]}` : named[3];
        return `${year}-${String(month).padStart(2, "0")}-${named[1].padStart(2, "0")}`;
      }
    }
  }
  return "";
}

function tdsRateFromText(source: string) {
  return (
    source.match(
      /\bTDS(?:\s+ON\s+(?:MS\s+)?SCRAP)?(?:\s+BASIC)?(?:\s+RATE)?\s*(?:@)?\s*([\d.]+)\s*%/i
    )?.[1] ?? ""
  );
}

function rateNearLabel(source: string, labelPattern: string) {
  return source.match(
    new RegExp(`\\b(?:${labelPattern})\\b[^\\r\\n]{0,80}?(?:@|RATE\\s*[:\\-]?)?\\s*([\\d.]+)\\s*%`, "i")
  )?.[1] ?? "";
}

function sumAmounts(values: string[]) {
  const present = values.filter(Boolean);
  if (!present.length) return "";
  const total = present.reduce((sum, value) => sum + Number(value), 0);
  return Number.isFinite(total) ? String(Math.round(total * 100) / 100) : "";
}

export function extractInvoiceCommercialFieldsFromText(
  visibleText: string | null | undefined
): InvoiceCommercialFields {
  const source = String(visibleText ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_`|]/g, " ");
  const explicitTaxAmount =
    amountNearLabel(source, "(?:TOTAL\\s+)?GST\\s+AMOUNT") ||
    amountNearLabel(source, "(?:TOTAL\\s+)?TAX\\s+AMOUNT");
  const componentTaxAmount = sumAmounts([
    amountNearLabel(source, "CGST"),
    amountNearLabel(source, "SGST"),
    amountNearLabel(source, "IGST"),
  ]);

  return {
    documentDate: invoiceDateFromText(source),
    vehicleNumber: vehicleNumberFromText(source),
    taxAmount: explicitTaxAmount || componentTaxAmount,
    tdsAmount:
      amountNearLabel(source, "TDS\\s+ON\\s+(?:MS\\s+)?SCRAP(?:\\s+BASIC)?") ||
      amountNearLabel(source, "TDS\\s+AMOUNT") ||
      amountNearLabel(source, "TDS(?!\\s+BASE\\b)"),
    tdsRate: tdsRateFromText(source),
    freightAmount:
      amountNearLabel(source, "TRANSPORTATION\\s+INWARD") ||
      amountNearLabel(source, "FREIGHT(?:\\s+AMOUNT)?") ||
      amountNearLabel(source, "TRANSPORT(?:ATION)?\\s+CHARGES?"),
    freightGstRate: rateNearLabel(
      source,
      "TRANSPORTATION\\s+INWARD|FREIGHT|TRANSPORT(?:ATION)?\\s+CHARGES?"
    ),
    tds194qAmount:
      amountNearLabel(source, "TDS\\s+PAYABLE[^\\r\\n]{0,30}194Q") ||
      amountNearLabel(source, "TDS[^\\r\\n]{0,30}194Q"),
    tds194qRate: rateNearLabel(source, "TDS[^\\r\\n]{0,30}194Q"),
    transportTdsAmount:
      amountNearLabel(source, "TDS\\s+ON\\s+GOODS\\s+TRANSPORT") ||
      amountNearLabel(source, "TRANSPORT(?:ATION)?\\s+TDS"),
    transportTdsRate: rateNearLabel(
      source,
      "TDS\\s+ON\\s+GOODS\\s+TRANSPORT|TRANSPORT(?:ATION)?\\s+TDS"
    ),
    cgstTdsAmount: amountNearLabel(source, "CGST\\s+TDS(?:\\s+PAYABLE)?"),
    sgstTdsAmount: amountNearLabel(source, "SGST\\s+TDS(?:\\s+PAYABLE)?"),
    igstTdsAmount: amountNearLabel(source, "IGST\\s+TDS(?:\\s+PAYABLE)?"),
    gstTdsRate: rateNearLabel(
      source,
      "(?:CGST|SGST|IGST)\\s+TDS(?:\\s+PAYABLE)?|GST\\s+TDS"
    ),
    tcsAmount:
      amountNearLabel(source, "TCS\\s+AMOUNT") ||
      amountNearLabel(source, "TCS(?!\\s+RATE\\b)"),
    roundOffAmount: amountNearLabel(
      source,
      "ROUND(?:ING)?[\\s-]*OFF(?:\\s+AMOUNT)?",
      { signed: true }
    ),
  };
}

export function applyInvoiceCommercialFieldFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string
) {
  if (!["Invoice", "Tax Invoice"].includes(docType) || !visibleText.trim()) return fields;

  const recovered = extractInvoiceCommercialFieldsFromText(visibleText);
  const next = { ...fields };
  const recoverableKeys = [
    "documentDate",
    "vehicleNumber",
    "taxAmount",
    "tdsAmount",
    "tdsRate",
    "freightAmount",
    "freightGstRate",
    "tds194qAmount",
    "tds194qRate",
    "transportTdsAmount",
    "transportTdsRate",
    "cgstTdsAmount",
    "sgstTdsAmount",
    "igstTdsAmount",
    "gstTdsRate",
    "tcsAmount",
    "roundOffAmount",
  ] as const satisfies readonly FieldKey[];

  for (const key of recoverableKeys) {
    if (!next[key] && recovered[key]) next[key] = recovered[key];
  }
  return next;
}

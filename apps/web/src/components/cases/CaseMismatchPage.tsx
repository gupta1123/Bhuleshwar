"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Database,
  Loader2,
  RefreshCw,
  ShieldAlert,
  X,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { TallyConnectionPill } from "@/components/tally/TallyConnectionPill";
import {
  TallyPurchasePostingPanel,
  type TallyPurchaseHeaderState,
  type TallyPurchaseValidationState,
} from "@/components/cases/TallyPurchasePostingPanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getComparisonDisplayLabel,
  isPrimaryComparisonField,
} from "@/lib/comparison";
import {
  ACTIVE_FIELD_DEFINITIONS,
  shouldConsiderFieldKey,
} from "@/lib/document-schema";
import { isLineItemMismatchField } from "@/lib/line-items";
import {
  fetchCaseDetail,
  updateCaseDecision,
  updateCaseMismatchDecisions,
  updateCaseMismatchDecision,
  type MismatchDecision,
  type SavedCaseDetail,
} from "@/lib/case-persistence";
import {
  DEFAULT_COMPARISON_FIELD_GROUPS,
  fetchComparisonGroups,
  type ComparisonFieldGroup,
} from "@/lib/comparison-groups";
import { fetchTallyPurchasePosting } from "@/lib/tally-purchase-posting";

type LoadState = "loading" | "ready" | "error";
type MismatchRecord = SavedCaseDetail["mismatches"][number];

const FIELD_LABEL_LOOKUP = ACTIVE_FIELD_DEFINITIONS.reduce(
  (acc, field) => {
    acc[field.key] = field.label;
    return acc;
  },
  {} as Record<string, string>
);

const LINE_ITEM_FIELD_LABELS: Record<string, string> = {
  "lineItems.unmatchedDocumentLine": "Document line item",
  "lineItems.unmatchedInvoiceLine": "Invoice line item",
  "lineItems.uninvoicedPoLine": "PO line item",
  "lineItems.quantityExceeded": "Line item quantity",
  "lineItems.quantityMismatch": "Line item quantity",
  "lineItems.rateMismatch": "Line item rate",
  "lineItems.unitMismatch": "Line item unit",
  "lineItems.hsnSacMismatch": "Line item HSN/SAC",
  "lineItems.amountMismatch": "Line item amount",
};
const REVIEW_FIELD_LABELS: Record<string, string> = {
  documentDate: "Document date",
  eWayBillNumber: "E-way bill number",
  registrationNumber: "Registration number",
  vehicleNumber: "Registration number",
};
const TERMS_COMPLIANCE_FIELD = "termsAndConditions";

function normalizeCompanyName(value?: string | null) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeGstin(value?: string | null) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^\d{2}[A-Z0-9]{13}$/.test(normalized) ? normalized : "";
}

function getFieldLabel(fieldName: string) {
  if (LINE_ITEM_FIELD_LABELS[fieldName]) {
    return LINE_ITEM_FIELD_LABELS[fieldName];
  }
  if (REVIEW_FIELD_LABELS[fieldName]) {
    return REVIEW_FIELD_LABELS[fieldName];
  }
  return getComparisonDisplayLabel(fieldName, FIELD_LABEL_LOOKUP[fieldName]);
}

function getValueCount(mismatch: MismatchRecord) {
  return (mismatch.values ?? []).filter(
    (entry) => entry.value !== null && entry.value !== undefined && String(entry.value).trim().length > 0
  ).length;
}

function getMismatchResolutionLabel(status: MismatchRecord["resolutionStatus"]) {
  if (status === "accepted") return "Accepted";
  if (status === "rejected") return "Rejected";
  return "Pending";
}

function getMismatchResolutionClassName(status: MismatchRecord["resolutionStatus"]) {
  if (status === "accepted") {
    return "border-[#c3dfcb] bg-[#ebf5ee] text-[#1b4332]";
  }
  if (status === "rejected") {
    return "border-[#f2c7c4] bg-[#fbf0ef] text-[#8c1d18]";
  }
  return "border-[#f9d8a7] bg-[#fef6e9] text-[#78350f]";
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return <span className="italic font-normal text-[#b5aaa0]">Missing</span>;
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function getIssueDescription(fieldName: string) {
  switch (fieldName) {
    case "lineItems.unitMismatch":
      return "The item was matched, but the PO and invoice use different units. Confirm whether these units mean the same thing before approving.";
    case "lineItems.rateMismatch":
      return "The item was matched, but the invoice rate is different from the effective PO rate.";
    case "lineItems.hsnSacMismatch":
      return "The item was matched, but the HSN/SAC code differs between the documents.";
    case "lineItems.amountMismatch":
      return "The item was matched, but the line amount differs between the documents.";
    case "lineItems.uninvoicedPoLine":
      return "This PO line was ordered but was not found on the invoice.";
    case "lineItems.unmatchedDocumentLine":
      return "This document line could not be confidently matched to the reference document line.";
    case "lineItems.unmatchedInvoiceLine":
      return "This invoice line could not be matched to a PO line.";
    case "lineItems.quantityExceeded":
      return "The invoice quantity is greater than the matching PO quantity.";
    case "lineItems.quantityMismatch":
      return "The matched line quantity differs between the documents.";
    case TERMS_COMPLIANCE_FIELD:
      return "A visible terms and conditions clause was assessed against the packet and needs correction or review.";
    case "taxAmount":
      return "The document failed a GST tax calculation check. Review expected tax against the extracted taxable and tax amounts.";
    case "totalAmount":
      return "The invoice total and PO total do not match.";
    default:
      return "Review the values below and decide whether this issue needs correction.";
  }
}

function formatMismatchValue(fieldName: string, value: unknown, documentTitle: string) {
  if (typeof value !== "string") {
    return displayValue(value);
  }

  const unitMatch = value.match(/^([^:]+): invoice unit (.+) differs from PO unit (.+)$/i);
  if (fieldName === "lineItems.unitMismatch" && unitMatch) {
    const [, , invoiceUnit, poUnit] = unitMatch;
    const isPo = /purchase order|po\b/i.test(documentTitle);
    return isPo ? poUnit : invoiceUnit;
  }

  const rateMatch = value.match(/^([^:]+): invoice rate (.+) differs from PO rate (.+)$/i);
  if (fieldName === "lineItems.rateMismatch" && rateMatch) {
    const [, , invoiceRate, poRate] = rateMatch;
    const isPo = /purchase order|po\b/i.test(documentTitle);
    return isPo ? poRate : invoiceRate;
  }

  const quantityMatch = value.match(/^([^:]+): invoice quantity (.+) exceeds PO quantity (.+)$/i);
  if (fieldName === "lineItems.quantityExceeded" && quantityMatch) {
    const [, , invoiceQuantity, poQuantity] = quantityMatch;
    const isPo = /purchase order|po\b/i.test(documentTitle);
    return isPo ? poQuantity : invoiceQuantity;
  }

  const detailMatch = value.match(/^[^:]+:\s*(.+)$/);
  const detail = detailMatch?.[1]?.trim();
  if (detail) {
    if (fieldName === "lineItems.unitMismatch") {
      const unitValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+unit\s+(.+)$/i);
      if (unitValue?.[1]) return unitValue[1];
    }

    if (fieldName === "lineItems.rateMismatch") {
      const rateValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+(?:net\s+)?rate\s+(.+)$/i);
      if (rateValue?.[1]) return rateValue[1];
    }

    if (fieldName === "lineItems.quantityExceeded" || fieldName === "lineItems.quantityMismatch") {
      const quantityValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+quantity\s+(.+)$/i);
      if (quantityValue?.[1]) return quantityValue[1];
    }

    if (fieldName === "lineItems.hsnSacMismatch") {
      const hsnValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+HSN\/SAC\s+(.+)$/i);
      if (hsnValue?.[1]) return hsnValue[1];
    }

    if (fieldName === "lineItems.amountMismatch") {
      const amountValue = detail.match(/^(?:(?:amended\s+)?purchase order|po|tax invoice|invoice|e-way bill|delivery challan|lorry receipt)\s+line amount\s+(.+)$/i);
      if (amountValue?.[1]) return amountValue[1];
    }
  }

  return displayValue(value);
}

const BASE_CONTEXT_FIELDS = [
  "poNumber",
  "referencePoNumber",
  "invoiceNumber",
  "referenceInvoiceNumber",
  "eWayBillNumber",
  "lorryReceiptNumber",
  "documentDate",
];

const CONTEXT_FIELDS_BY_MISMATCH: Array<{ fields: string[]; context: string[] }> = [
  {
    fields: ["vendorName", "supplierGstin", "buyerName", "buyerGstin"],
    context: ["vendorName", "supplierGstin", "buyerName", "buyerGstin"],
  },
  {
    fields: ["vehicleNumber", "registrationNumber", "lorryReceiptNumber", "fastagReference", "eWayBillNumber"],
    context: ["vehicleNumber", "registrationNumber", "lorryReceiptNumber", "eWayBillNumber", "fastagReference"],
  },
  {
    fields: ["grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit"],
    context: ["weighmentNumber", "vehicleNumber", "grossWeight", "tareWeight", "netWeight", "itemQuantity", "unit"],
  },
  {
    fields: ["subtotal", "taxAmount", "totalAmount", "paidAmount", "statementAmount", "currency"],
    context: ["currency", "subtotal", "taxAmount", "totalAmount", "paidAmount", "statementAmount"],
  },
  {
    fields: [TERMS_COMPLIANCE_FIELD],
    context: [
      "termsAndConditions",
      "paymentTerms",
      "deliveryTerms",
      "freightTerms",
      "packingForwardingTerms",
      "priceBasis",
      "taxTerms",
      "inspectionTerms",
      "warrantyTerms",
      "hasAuthorizedSignature",
      "hasVendorStamp",
      "hasStoreStamp",
      "hasStoreSignature",
      "hasGateStamp",
    ],
  },
  {
    fields: ["lineItems.unmatchedDocumentLine", "lineItems.unmatchedInvoiceLine", "lineItems.uninvoicedPoLine", "lineItems.quantityExceeded", "lineItems.quantityMismatch", "lineItems.rateMismatch", "lineItems.unitMismatch", "lineItems.hsnSacMismatch", "lineItems.amountMismatch"],
    context: ["invoiceNumber", "referenceInvoiceNumber", "poNumber", "referencePoNumber", "eWayBillNumber", "itemQuantity", "unit", "subtotal", "taxAmount", "totalAmount"],
  },
];

type DocumentContextRow = {
  key: string;
  label: string;
  value: unknown;
  emphasis?: boolean;
};

type MismatchEvidence = {
  key: string;
  docId?: string;
  document?: SavedCaseDetail["documents"][number];
  value: unknown;
  contextRows: DocumentContextRow[];
};

type ParsedTaxValidationIssue = {
  lineLabel: string | null;
  condition: string | null;
  rule: string | null;
  taxableAmount: number | null;
  expectedTax: number | null;
  actualTax: number | null;
  difference: number | null;
  summary: string;
};

type MismatchGroupSection = {
  key: string;
  label: string;
  mismatches: MismatchRecord[];
  pending: number;
  accepted: number;
  rejected: number;
};

const LINE_ITEM_GROUP_KEY = "line_items";
const TERMS_GROUP_KEY = "terms_compliance";
const OTHER_GROUP_KEY = "other";

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getResolutionCounts(mismatches: MismatchRecord[]) {
  return {
    pending: mismatches.filter((mismatch) => mismatch.resolutionStatus === "pending").length,
    accepted: mismatches.filter((mismatch) => mismatch.resolutionStatus === "accepted").length,
    rejected: mismatches.filter((mismatch) => mismatch.resolutionStatus === "rejected").length,
  };
}

function getGroupKeyForMismatch(fieldName: string, comparisonGroups: ComparisonFieldGroup[]) {
  if (isLineItemMismatchField(fieldName)) return LINE_ITEM_GROUP_KEY;
  if (fieldName === TERMS_COMPLIANCE_FIELD) return TERMS_GROUP_KEY;

  const group = comparisonGroups.find(
    (entry) => entry.enabled !== false && entry.fields.includes(fieldName)
  );
  return group?.groupKey ?? OTHER_GROUP_KEY;
}

function buildMismatchGroupSections(
  mismatches: MismatchRecord[],
  comparisonGroups: ComparisonFieldGroup[]
): MismatchGroupSection[] {
  const configuredGroups: Array<{ key: string; label: string; sortOrder: number }> = [
    { key: LINE_ITEM_GROUP_KEY, label: "Line items", sortOrder: 0 },
    ...comparisonGroups
      .filter((group) => group.enabled !== false)
      .map((group) => ({ key: group.groupKey, label: group.label, sortOrder: group.sortOrder })),
    { key: TERMS_GROUP_KEY, label: "Terms compliance", sortOrder: 900 },
    { key: OTHER_GROUP_KEY, label: "Other fields", sortOrder: 1000 },
  ];

  const byKey = new Map<string, MismatchRecord[]>();
  for (const mismatch of mismatches) {
    const key = getGroupKeyForMismatch(mismatch.fieldName, comparisonGroups);
    byKey.set(key, [...(byKey.get(key) ?? []), mismatch]);
  }

  return configuredGroups
    .map((group) => {
      const groupMismatches = byKey.get(group.key) ?? [];
      const counts = getResolutionCounts(groupMismatches);
      return {
        key: group.key,
        label: group.label,
        mismatches: groupMismatches,
        ...counts,
      };
    })
    .filter((group) => group.mismatches.length > 0)
    .sort((a, b) => {
      const sortA = configuredGroups.find((group) => group.key === a.key)?.sortOrder ?? 999;
      const sortB = configuredGroups.find((group) => group.key === b.key)?.sortOrder ?? 999;
      return sortA - sortB;
    });
}

function getLineItemLabel(mismatch: MismatchRecord) {
  if (!isLineItemMismatchField(mismatch.fieldName)) return getFieldLabel(mismatch.fieldName);
  const firstValue = mismatch.values?.find((entry) => hasDisplayableValue(entry.value))?.value;
  const valueText = typeof firstValue === "string" ? firstValue : "";
  const lineMatch = valueText.match(/^([^:]{1,40}):/);
  if (lineMatch?.[1]) {
    const prefix = lineMatch[1].trim();
    if (/^\d+$/.test(prefix)) return `Line ${prefix}`;
    return prefix.replace(/\*+/g, "").trim();
  }
  return "Line item";
}

function parseAmountFromText(value: string, label: string) {
  const pattern = new RegExp(`${label}\\s+(?:INR\\s*)?(-?[\\d,]+(?:\\.\\d+)?)`, "i");
  const match = value.match(pattern);
  if (!match?.[1]) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTaxAmount(value: number | null) {
  if (value === null) return "-";
  return `INR ${value.toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  })}`;
}

function parseTaxValidationIssue(value: unknown): ParsedTaxValidationIssue | null {
  if (typeof value !== "string" || !/expected tax|actual tax/i.test(value)) {
    return null;
  }

  const text = value.replace(/\s+/g, " ").trim();
  const lineMatch = text.match(/^Line\s+(\d+):/i);
  const segments = text
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const expectedSegment =
    segments.find((segment) => /\bexpected\b/i.test(segment) && !/expected tax/i.test(segment)) ?? null;
  const conditionSegment =
    segments.find((segment) => segment !== expectedSegment && !/taxable|expected tax|actual tax/i.test(segment)) ??
    null;
  const ruleText = expectedSegment?.replace(/^Line\s+\d+:\s*/i, "").match(/expected\s+(.+)$/i)?.[1] ?? null;
  const taxableAmount = parseAmountFromText(text, "taxable");
  const expectedTax = parseAmountFromText(text, "expected tax");
  const actualTax = parseAmountFromText(text, "actual tax");
  const difference = expectedTax !== null && actualTax !== null ? actualTax - expectedTax : null;
  const lineLabel = lineMatch?.[1] ? `Line ${lineMatch[1]}` : null;
  const differenceText =
    difference === null || Math.abs(difference) < 0.005
      ? ""
      : ` ${formatTaxAmount(Math.abs(difference))} ${difference < 0 ? "short" : "extra"}.`;

  return {
    lineLabel,
    condition: conditionSegment?.replace(/^Line\s+\d+:\s*/i, "") ?? null,
    rule: ruleText,
    taxableAmount,
    expectedTax,
    actualTax,
    difference,
    summary:
      expectedTax !== null && actualTax !== null
        ? `${lineLabel ? `${lineLabel}: ` : ""}tax should be ${formatTaxAmount(expectedTax)}, but extracted tax is ${formatTaxAmount(actualTax)}.${differenceText}`
        : text,
  };
}

function getIssueDisplayTitle(mismatch: MismatchRecord, evidence: MismatchEvidence[]) {
  if (mismatch.fieldName === "taxAmount" && isSingleDocumentIssue(mismatch, evidence)) {
    const parsed = parseTaxValidationIssue(evidence[0]?.value);
    if (parsed?.actualTax === 0 && parsed.lineLabel) return "Line tax missing";
    if (parsed?.difference != null && parsed.difference < 0) return "Tax shortfall";
    if (parsed?.difference != null && parsed.difference > 0) return "Tax excess";
    return "Tax validation";
  }

  return getFieldLabel(mismatch.fieldName);
}

function isSingleDocumentIssue(mismatch: MismatchRecord, evidence: MismatchEvidence[]) {
  const documentIds = uniqueStrings(
    evidence.map((entry) => entry.docId || entry.document?.id || entry.document?.clientDocumentId || "")
  );
  return evidence.length <= 1 || getValueCount(mismatch) <= 1 || documentIds.length <= 1;
}

function getIssueModeLabel(mismatch: MismatchRecord, evidence: MismatchEvidence[]) {
  if (isSingleDocumentIssue(mismatch, evidence)) {
    return isLineItemMismatchField(mismatch.fieldName) ? "Line exception" : "Validation issue";
  }
  return "Document mismatch";
}

function getReviewerHint(mismatch: MismatchRecord, evidence?: MismatchEvidence[]) {
  if (evidence && isSingleDocumentIssue(mismatch, evidence)) {
    if (mismatch.fieldName === "taxAmount") {
      return "This is a tax validation issue inside one document, not a mismatch between documents. Check taxable amount, GST rate, and extracted tax before deciding.";
    }
    if (isLineItemMismatchField(mismatch.fieldName)) {
      return "This line needs attention because the system could not fully reconcile it with the related document line.";
    }
    return "This issue was found inside one document. Use the source/page and context below to decide whether it is a real problem or extraction noise.";
  }

  const values = (mismatch.values ?? [])
    .map((entry) => String(entry.value ?? "").trim())
    .filter(Boolean);
  const uniqueValues = uniqueStrings(values);

  if (
    uniqueValues.length === 2 &&
    uniqueValues[0].length === uniqueValues[1].length &&
    uniqueValues[0].length <= 24
  ) {
    const diffCount = uniqueValues[0]
      .split("")
      .filter((char, index) => char !== uniqueValues[1][index]).length;
    if (diffCount > 0 && diffCount <= 2) {
      return `${diffCount}-character difference. Likely OCR or formatting—verify the source.`;
    }
  }

  if (mismatch.fieldName === "lineItems.unmatchedInvoiceLine") {
    return "Invoice has a line that was not matched to the order. Check whether it is an extra charge, duplicate extraction, or missing PO line.";
  }
  if (mismatch.fieldName === "lineItems.unmatchedDocumentLine" || mismatch.fieldName === "lineItems.uninvoicedPoLine") {
    return "A line exists in one document but not the other. This is usually more important than a small field typo.";
  }
  if (mismatch.fieldName === "lineItems.rateMismatch" || mismatch.fieldName === "lineItems.amountMismatch") {
    return "Commercial value differs between documents. Confirm rate, quantity, and tax basis before approving.";
  }
  if (mismatch.fieldName === "lineItems.unitMismatch") {
    return "Matched item, but units differ. Confirm whether the units are equivalent or if extraction used the wrong unit.";
  }
  if (mismatch.fieldName === "taxAmount") {
    return "Tax discrepancy can come from GST type, rate, taxable value, or OCR. Verify tax calculation first.";
  }
  if (mismatch.fieldName === "vehicleNumber") {
    return "Vehicle number differences are often OCR-sensitive, but they affect dispatch traceability.";
  }

  return mismatch.analysis || getIssueDescription(mismatch.fieldName);
}

function getContextFieldsForMismatch(fieldName: string) {
  const configured = CONTEXT_FIELDS_BY_MISMATCH.find((entry) => entry.fields.includes(fieldName));
  return uniqueStrings([fieldName, ...(configured?.context ?? []), ...BASE_CONTEXT_FIELDS]);
}

function hasDisplayableValue(value: unknown) {
  return value !== null && value !== undefined && String(value).trim().length > 0;
}

function getDocumentSourceLabel(document?: SavedCaseDetail["documents"][number]) {
  if (!document) return "Document not found";
  const sourceHint = document.sourceHint?.trim();
  const sourceFileName = document.sourceFileName?.trim();
  if (sourceHint && sourceFileName && sourceHint.includes(sourceFileName)) {
    return sourceHint;
  }

  return [sourceHint, sourceFileName]
    .filter((value): value is string => Boolean(value && value.trim()))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" - ") || "Uploaded document";
}

function getCompactSourceLabel(document?: SavedCaseDetail["documents"][number]) {
  if (!document) return "Document not found";
  const sourceLabel = getDocumentSourceLabel(document);
  const pageMatch = sourceLabel.match(/\bpages?\s+\d+(?:\s*-\s*\d+)?/i);
  const fileName = document.sourceFileName?.trim();

  if (fileName && pageMatch?.[0]) {
    return `${fileName} (${pageMatch[0].toLowerCase()})`;
  }

  return fileName || document.title || sourceLabel;
}

function getDocumentPageLabel(document?: SavedCaseDetail["documents"][number]) {
  if (!document) return "Page —";

  const sourceLabel = getDocumentSourceLabel(document);
  const pageMatch = sourceLabel.match(/\bpages?\s+(\d+)(?:\s*[-–]\s*(\d+))?/i);
  if (!pageMatch) return "Page —";

  return pageMatch[2]
    ? `Pages ${pageMatch[1]}–${pageMatch[2]}`
    : `Page ${pageMatch[1]}`;
}

function getEvidenceDocumentRole(document?: SavedCaseDetail["documents"][number]) {
  return document?.documentType || "Document";
}

function getFieldValueFromDocument(
  document: SavedCaseDetail["documents"][number] | undefined,
  fieldName: string
) {
  if (!document) return undefined;
  return (document.extractedFields as Record<string, unknown> | undefined)?.[fieldName];
}

function buildDocumentContextRows(
  document: SavedCaseDetail["documents"][number] | undefined,
  fieldName: string,
  mismatchValue: unknown
) {
  const rows: DocumentContextRow[] = [];
  const primaryValue = getFieldValueFromDocument(document, fieldName);

  if (isLineItemMismatchField(fieldName) || fieldName === TERMS_COMPLIANCE_FIELD) {
    rows.push({
      key: "issueDetail",
      label: fieldName === TERMS_COMPLIANCE_FIELD ? "Terms assessment" : "Issue detail",
      value: mismatchValue,
      emphasis: true,
    });
  } else {
    rows.push({
      key: fieldName,
      label: getFieldLabel(fieldName),
      value: hasDisplayableValue(primaryValue) ? primaryValue : mismatchValue,
      emphasis: true,
    });
  }

  for (const contextField of getContextFieldsForMismatch(fieldName)) {
    if (contextField === fieldName) continue;
    const value = getFieldValueFromDocument(document, contextField);
    if (!hasDisplayableValue(value)) continue;
    rows.push({
      key: contextField,
      label: getFieldLabel(contextField),
      value,
    });
  }

  const lineItemCount = document?.lineItems?.length ?? 0;
  if (isLineItemMismatchField(fieldName) && lineItemCount > 0) {
    rows.push({
      key: "lineItemCount",
      label: "Extracted line items",
      value: lineItemCount,
    });
  }

  return rows.slice(0, 8);
}

function buildMismatchEvidence(
  mismatch: MismatchRecord,
  documentLookup: Map<string, SavedCaseDetail["documents"][number]>
): MismatchEvidence[] {
  return (mismatch.values ?? []).map((entry, index) => {
    const document = entry.docId ? documentLookup.get(entry.docId) : undefined;
    return {
      key: `${mismatch.id}-${entry.docId ?? "missing"}-${index}`,
      docId: entry.docId,
      document,
      value: entry.value,
      contextRows: buildDocumentContextRows(document, mismatch.fieldName, entry.value),
    };
  });
}

function getIssueListDetail(mismatch: MismatchRecord, evidence: MismatchEvidence[]) {
  if (isSingleDocumentIssue(mismatch, evidence)) {
    const sourceLabel = getCompactSourceLabel(evidence[0]?.document);
    const issueType = getIssueModeLabel(mismatch, evidence);
    const parsedTaxIssue =
      mismatch.fieldName === "taxAmount" ? parseTaxValidationIssue(evidence[0]?.value) : null;
    if (parsedTaxIssue && parsedTaxIssue.expectedTax !== null && parsedTaxIssue.actualTax !== null) {
      return `${formatTaxAmount(parsedTaxIssue.actualTax)} vs ${formatTaxAmount(parsedTaxIssue.expectedTax)} - ${sourceLabel}`;
    }
    return sourceLabel ? `${issueType} - ${sourceLabel}` : issueType;
  }

  const count = getValueCount(mismatch);
  const status = mismatch.resolutionStatus === "pending"
    ? ""
    : ` · ${getMismatchResolutionLabel(mismatch.resolutionStatus)}`;
  return `${count} value${count === 1 ? "" : "s"} compared${status}`;
}

function getSingleIssueRows(evidence: MismatchEvidence[], fieldName: string) {
  return (
    evidence[0]?.contextRows.filter((row) => !row.emphasis && row.key !== fieldName).slice(0, 6) ?? []
  );
}

function MismatchReviewSkeleton() {
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden lg:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-[#e0d8cc] bg-white lg:w-60 lg:border-b-0 lg:border-r">
        <div className="hidden border-b border-[#ece6dc] p-5 lg:block">
          <div className="mb-4 flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded bg-[#eee7dd]" />
            <Skeleton className="h-4 w-28 bg-[#eee7dd]" />
          </div>
          <div className="space-y-3">
            <div className="space-y-2">
              <Skeleton className="h-3 w-16 bg-[#eee7dd]" />
              <Skeleton className="h-4 w-40 bg-[#eee7dd]" />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-3 w-20 bg-[#eee7dd]" />
                <Skeleton className="h-4 w-8 bg-[#eee7dd]" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-16 bg-[#eee7dd]" />
                <Skeleton className="h-4 w-8 bg-[#eee7dd]" />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden bg-[#fbfaf8] lg:bg-white">
          <div className="flex items-center justify-between border-b border-[#ece6dc] bg-white px-4 py-3 lg:px-5 lg:py-4">
            <Skeleton className="h-4 w-32 bg-[#eee7dd]" />
          </div>
          <div className="flex gap-2 overflow-x-auto p-3 lg:block lg:space-y-0 lg:overflow-y-hidden lg:p-0">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className="shrink-0 rounded-full border border-[#e0d8cc] bg-white px-4 py-2 lg:w-full lg:rounded-none lg:border-0 lg:border-l-[3px] lg:border-transparent lg:px-5 lg:py-3"
              >
                <Skeleton className="h-4 w-28 bg-[#eee7dd]" />
                <Skeleton className="mt-2 hidden h-3 w-20 bg-[#eee7dd] lg:block" />
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-[#f7f4ef] p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="space-y-2">
            <Skeleton className="h-7 w-52 bg-[#eee7dd]" />
            <Skeleton className="h-4 w-80 max-w-full bg-[#eee7dd]" />
          </div>
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Skeleton className="h-4 w-4 rounded bg-[#eee7dd]" />
              <Skeleton className="h-4 w-32 bg-[#eee7dd]" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="rounded-lg border border-[#e0d8cc] bg-white p-4 shadow-sm">
                  <Skeleton className="mb-3 h-3 w-32 bg-[#eee7dd]" />
                  <Skeleton className="h-4 w-44 bg-[#eee7dd]" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-[#e0d8cc] bg-[#fbfaf8] p-4 sm:p-5">
            <Skeleton className="mb-4 h-4 w-36 bg-[#eee7dd]" />
            <div className="space-y-3">
              <Skeleton className="h-3.5 w-full bg-[#eee7dd]" />
              <Skeleton className="h-3.5 w-5/6 bg-[#eee7dd]" />
              <Skeleton className="h-3.5 w-4/6 bg-[#eee7dd]" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function CaseMismatchPage({ caseId }: { caseId: string }) {
  const [detail, setDetail] = useState<SavedCaseDetail | null>(null);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [activeMismatchId, setActiveMismatchId] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"mismatches" | "tally">("mismatches");
  const [tallyOpened, setTallyOpened] = useState(false);
  const [decisionStatus, setDecisionStatus] = useState<"idle" | "updating" | "error">("idle");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [tallyHeaderState, setTallyHeaderState] = useState<TallyPurchaseHeaderState | null>(null);
  const [tallyValidationState, setTallyValidationState] = useState<TallyPurchaseValidationState>({
    blockers: [],
    warnings: [],
    checking: true,
  });
  const [allowedTallyBlockerKeys, setAllowedTallyBlockerKeys] = useState<Set<string>>(() => new Set());
  const [refreshingTallyHeader, setRefreshingTallyHeader] = useState(false);
  const tallyPurchaseRefreshRef = useRef<(() => Promise<void>) | null>(null);
  const handleTallyValidationStateChange = useCallback((next: TallyPurchaseValidationState) => {
    setTallyValidationState(next);
  }, []);
  const toggleTallyBlockerOverride = useCallback((key: string) => {
    setAllowedTallyBlockerKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  useEffect(() => {
    setAllowedTallyBlockerKeys(new Set());
  }, [caseId]);
  const [selectedMismatchIds, setSelectedMismatchIds] = useState<Set<string>>(() => new Set());
  const [comparisonGroups, setComparisonGroups] = useState<ComparisonFieldGroup[]>(
    () => DEFAULT_COMPARISON_FIELD_GROUPS
  );
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(
    () => new Set([LINE_ITEM_GROUP_KEY])
  );

  useEffect(() => {
    let active = true;

    fetchCaseDetail(caseId)
      .then((payload) => {
        if (!active) return;
        setDetail(payload);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load mismatch review.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [caseId]);

  useEffect(() => {
    let active = true;

    fetchComparisonGroups()
      .then((groups) => {
        if (active) {
          setComparisonGroups(groups);
        }
      })
      .catch(() => {
        if (active) {
          setComparisonGroups(DEFAULT_COMPARISON_FIELD_GROUPS);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const visibleMismatches = useMemo(
    () =>
      detail?.mismatches.filter(
        (mismatch) =>
          mismatch.fieldName === TERMS_COMPLIANCE_FIELD ||
          isLineItemMismatchField(mismatch.fieldName) ||
          (shouldConsiderFieldKey(mismatch.fieldName) && isPrimaryComparisonField(mismatch.fieldName))
      ) ?? [],
    [detail]
  );
  const hasInvoice = useMemo(
    () => detail?.documents.some((document) => /invoice/i.test(document.documentType)) ?? false,
    [detail]
  );

  useEffect(() => {
    if (hasInvoice && visibleMismatches.length === 0) {
      setTallyOpened(true);
      setReviewMode("tally");
    }
  }, [hasInvoice, visibleMismatches.length]);

  useEffect(() => {
    if (reviewMode === "tally") setTallyOpened(true);
  }, [reviewMode]);

  useEffect(() => {
    setActiveMismatchId((current) => {
      if (current && visibleMismatches.some((mismatch) => mismatch.id === current)) {
        return current;
      }
      return visibleMismatches[0]?.id ?? null;
    });
  }, [visibleMismatches]);

  const documentLookup = useMemo(() => {
    const map = new Map<string, SavedCaseDetail["documents"][number]>();
    detail?.documents.forEach((document) => {
      map.set(document.id, document);
      if (document.clientDocumentId) {
        map.set(document.clientDocumentId, document);
      }
    });
    return map;
  }, [detail]);

  const activeMismatch = useMemo(() => {
    if (!activeMismatchId) return visibleMismatches[0] ?? null;
    return visibleMismatches.find((mismatch) => mismatch.id === activeMismatchId) ?? null;
  }, [activeMismatchId, visibleMismatches]);

  const mismatchGroups = useMemo(
    () => buildMismatchGroupSections(visibleMismatches, comparisonGroups),
    [visibleMismatches, comparisonGroups]
  );
  const activeGroupKey = activeMismatch
    ? getGroupKeyForMismatch(activeMismatch.fieldName, comparisonGroups)
    : null;
  const activeGroup = activeGroupKey
    ? mismatchGroups.find((group) => group.key === activeGroupKey) ?? null
    : null;

  const activeEvidence = useMemo(
    () => (activeMismatch ? buildMismatchEvidence(activeMismatch, documentLookup) : []),
    [activeMismatch, documentLookup]
  );
  const activeIsSingleDocumentIssue = activeMismatch
    ? isSingleDocumentIssue(activeMismatch, activeEvidence)
    : false;
  const activeIssueDisplayTitle = activeMismatch ? getIssueDisplayTitle(activeMismatch, activeEvidence) : "";
  const activeTaxValidationIssue =
    activeMismatch?.fieldName === "taxAmount" && activeIsSingleDocumentIssue
      ? parseTaxValidationIssue(activeEvidence[0]?.value)
      : null;
  const activeIssueHint = activeMismatch ? getReviewerHint(activeMismatch, activeEvidence) : "";
  const activeSingleIssueRows = activeMismatch
    ? getSingleIssueRows(activeEvidence, activeMismatch.fieldName)
    : [];
  const isCaseFinal = detail?.case.status === "accepted" || detail?.case.status === "rejected";
  const isActiveMismatchPending = activeMismatch?.resolutionStatus === "pending";
  const pendingMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "pending"
  ).length;
  const acceptedMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "accepted"
  ).length;
  const rejectedMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "rejected"
  ).length;
  const pendingVisibleMismatchIds = useMemo(
    () =>
      visibleMismatches
        .filter((mismatch) => mismatch.resolutionStatus === "pending")
        .map((mismatch) => mismatch.id),
    [visibleMismatches]
  );
  const selectedPendingMismatchIds = pendingVisibleMismatchIds.filter((id) =>
    selectedMismatchIds.has(id)
  );

  useEffect(() => {
    setSelectedMismatchIds((current) => {
      const allowed = new Set(pendingVisibleMismatchIds);
      const next = new Set(Array.from(current).filter((id) => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [pendingVisibleMismatchIds]);

  useEffect(() => {
    if (!activeGroupKey) return;
    setExpandedGroupKeys((current) => {
      if (current.has(activeGroupKey)) return current;
      const next = new Set(current);
      next.add(activeGroupKey);
      return next;
    });
  }, [activeGroupKey]);

  function handleToggleGroup(groupKey: string) {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  function handleToggleSelectedMismatch(mismatchId: string) {
    setSelectedMismatchIds((current) => {
      const next = new Set(current);
      if (next.has(mismatchId)) {
        next.delete(mismatchId);
      } else {
        next.add(mismatchId);
      }
      return next;
    });
  }

  function handleSelectAllPending() {
    setSelectedMismatchIds(new Set(pendingVisibleMismatchIds));
  }

  function handleClearSelected() {
    setSelectedMismatchIds(new Set());
  }

  async function handleMismatchDecisionFor(mismatch: MismatchRecord, decision: MismatchDecision) {
    if (!detail) return;

    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      await updateCaseMismatchDecision(caseId, mismatch.id, decision);
      const refreshed = await fetchCaseDetail(caseId);
      setDetail(refreshed);
      setSelectedMismatchIds((current) => {
        const next = new Set(current);
        next.delete(mismatch.id);
        return next;
      });
      setDecisionStatus("idle");
    } catch (decisionFailure) {
      setDecisionError(
        decisionFailure instanceof Error
          ? decisionFailure.message
          : `Failed to ${decision === "accepted" ? "accept" : "reject"} issue.`
      );
      setDecisionStatus("error");
    }
  }

  async function handleMismatchDecision(decision: MismatchDecision) {
    if (!activeMismatch) return;
    await handleMismatchDecisionFor(activeMismatch, decision);
  }

  async function handleBulkMismatchDecision(decision: MismatchDecision) {
    if (!detail || selectedPendingMismatchIds.length === 0) return;

    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      await updateCaseMismatchDecisions(caseId, selectedPendingMismatchIds, decision);
      const refreshed = await fetchCaseDetail(caseId);
      setDetail(refreshed);
      setSelectedMismatchIds(new Set());
      setDecisionStatus("idle");
    } catch (decisionFailure) {
      setDecisionError(
        decisionFailure instanceof Error
          ? decisionFailure.message
          : `Failed to ${decision === "accepted" ? "accept" : "reject"} selected issues.`
      );
      setDecisionStatus("error");
    }
  }

  async function handleApprovePacketFromTally() {
    if (!detail || detail.case.status !== "completed") return;
    if (pendingMismatchCount > 0 || rejectedMismatchCount > 0) {
      throw new Error("Resolve every packet issue before approving the packet.");
    }

    const updated = await updateCaseDecision(caseId, "accepted");
    setDetail((current) =>
      current
        ? {
            ...current,
            case: {
              ...current.case,
              ...updated.case,
            },
          }
        : current
    );
  }

  async function refreshTallyHeader() {
    try {
      setRefreshingTallyHeader(true);
      // The purchase panel owns the live Tally master refresh. Use it when it
      // is mounted so this header button performs the same real refresh as the
      // controls beside the missing-ledger fields. The old implementation only
      // re-read the API snapshot, which made the button appear to do nothing.
      if (tallyPurchaseRefreshRef.current) {
        await tallyPurchaseRefreshRef.current();
        return;
      }
      const payload = await fetchTallyPurchasePosting(
        caseId,
        tallyHeaderState?.selectedConnectionId
      );
      setTallyHeaderState({
        selectedConnectionId: payload.selectedConnectionId,
        connection: payload.connection,
        connectionOptions: payload.connectionOptions,
        buyerGstin: payload.review?.buyerGstin || payload.source?.buyerGstin || null,
        postingStatus: payload.posting?.status ?? null,
        tallyVoucherNumber: payload.posting?.tallyVoucherNumber ?? null,
        invoiceNumber: payload.posting?.invoiceNumber ?? payload.review?.invoiceNumber ?? null,
        verifiedAt: payload.posting?.verifiedAt ?? null,
      });
    } finally {
      setRefreshingTallyHeader(false);
    }
  }

  const selectedTallyConnection = tallyHeaderState?.connection;
  const tallyHeaderChecking = tallyHeaderState === null || refreshingTallyHeader;
  const tallyConnectionReady = Boolean(
    selectedTallyConnection?.bridgeConnected &&
    selectedTallyConnection?.tallyReachable &&
    selectedTallyConnection?.companyLoaded &&
    !selectedTallyConnection?.heartbeatStale
  );
  const kalikaCompanyName = selectedTallyConnection?.companyName || "Not selected";
  const activeTallyCompanyName =
    (selectedTallyConnection?.companyLoaded
      ? selectedTallyConnection.activeCompanyName
      : null) ||
    "Not detected";
  const tallyCompanyNameMatches = Boolean(
    tallyConnectionReady &&
      normalizeCompanyName(kalikaCompanyName) &&
      normalizeCompanyName(activeTallyCompanyName) &&
      normalizeCompanyName(kalikaCompanyName) ===
        normalizeCompanyName(activeTallyCompanyName)
  );
  const tallyCompanyContextMismatch = Boolean(
    tallyConnectionReady && !tallyCompanyNameMatches
  );
  const tallyCompanyContextVerified = tallyCompanyNameMatches;
  const tallyVoucherVerified = Boolean(
    tallyHeaderState?.tallyVoucherNumber &&
      ["created", "verification_required"].includes(tallyHeaderState?.postingStatus ?? "")
  );
  const remainingTallyBlockerCount = tallyValidationState.blockers.filter(
    (item) => !allowedTallyBlockerKeys.has(item.overrideKey)
  ).length;
  const tallyHeaderTitle = tallyHeaderChecking
    ? "Checking Tally company"
    : tallyVoucherVerified
      ? `Tally voucher ${tallyHeaderState?.tallyVoucherNumber || "created"}`
    : !tallyHeaderState?.selectedConnectionId
      ? "Select Tally company"
      : tallyCompanyContextVerified
        ? "Tally company verified"
        : tallyCompanyContextMismatch
          ? "Switch company in Tally"
          : "Tally unavailable";

  return (
    <AppShell defaultSidebarCollapsed>
      <div className="flex h-full flex-col bg-[#f7f4ef] animate-in fade-in duration-500 text-[#111827]">

        {/* Header - warm palette aligned to PageHeader (Cases/RecycleBin) */}
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[#e0d8cc] bg-[#f7f4ef]/95 px-4 shadow-[0_1px_3px_rgba(45,36,28,0.03)] backdrop-blur-md sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Link
              href={`/cases/${caseId}`}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#ded8d0] bg-[#fbfaf8] text-[#5a5046] transition-colors hover:bg-[#ede6d9] hover:text-[#111827]"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>

            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              {status === "loading" ? (
                <Skeleton className="h-5 w-52 max-w-[55vw] bg-[#eee7dd]" />
              ) : (
                <h1 className="truncate text-lg font-bold tracking-tight text-[#111827] sm:text-xl">
                  {detail?.case.displayName}
                </h1>
              )}
              {detail && reviewMode !== "tally" && (
                <div className="hidden items-center gap-2 sm:flex shrink-0">
                  <span className="hidden text-[#c4b9ad] sm:inline-block">·</span>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium shadow-sm ${detail.case.status === "accepted"
                        ? "border-[#c3dfcb] bg-[#ebf5ee] text-[#1b4332]"
                        : detail.case.status === "rejected"
                          ? "border-[#f2c7c4] bg-[#fbf0ef] text-[#8c1d18]"
                          : "border-[#ded8d0] bg-[#fbfaf8] text-[#5b4b3d]"
                      }`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${detail.case.status === "accepted" ? "bg-[#2d6a4f]" : detail.case.status === "rejected" ? "bg-[#b91c1c]" : "bg-[#8a7f72]"}`} />
                    {detail.case.status === "accepted"
                      ? "Review complete"
                      : detail.case.status === "rejected"
                        ? "Case rejected"
                        : "Review pending"}
                  </span>
                </div>
              )}
            </div>
          </div>
          {reviewMode === "tally" ? (
            <TallyConnectionPill
              className="hidden shrink-0 md:inline-flex"
              title={tallyHeaderTitle}
              subtitle={
                tallyVoucherVerified
                  ? `Supplier invoice ${tallyHeaderState?.invoiceNumber || "—"} · verified`
                  : `Bhuleshwar: ${kalikaCompanyName} - Tally: ${activeTallyCompanyName}`
              }
              status={
                tallyHeaderChecking
                  ? "checking"
                  : tallyVoucherVerified || tallyCompanyContextVerified
                    ? "verified"
                    : "warning"
              }
              avatarName={kalikaCompanyName}
              refreshing={tallyHeaderChecking}
              onRefresh={() => void refreshTallyHeader()}
              secondaryAction={{
                label: tallyConnectionReady ? "Manage Tally" : "Connect Tally",
                href: "/tally-prime?view=connection",
              }}
            />
          ) : null}
        </header>

        {/* Loading State */}
        {status === "loading" && (
          <MismatchReviewSkeleton />
        )}

        {/* Error State */}
        {status === "error" && (
          <div className="flex-1 bg-[#f7f4ef] p-4 sm:p-8">
            <div className="mx-auto flex max-w-2xl items-start gap-4 rounded-xl border border-rose-200 bg-white p-6 shadow-sm">
              <ShieldAlert className="h-6 w-6 shrink-0 text-rose-500" />
              <div>
                <h3 className="text-lg font-bold tracking-tight text-[#111827]">Unable to load review</h3>
                <p className="mt-1 text-xs font-normal text-[#8a7f72]">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Main Content Layout */}
        {status === "ready" && detail && (
          <div className="flex flex-1 flex-col lg:flex-row min-h-0 overflow-hidden bg-[#f7f4ef]">

            {/* Grouped issue navigation - warm palette */}
            <aside className="flex min-h-0 shrink-0 flex-col border-b border-[#e0d8cc] bg-white lg:w-60 lg:border-b-0 lg:border-r">

              {/* Desktop Only: Case Meta Summary */}
              <div className="hidden">
                <div className="flex items-center gap-2 mb-4">
                  <h2 className="text-xs font-semibold tracking-wide text-[#3d3530]">Case Summary</h2>
                </div>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-[#8a7f72]">Receiver</p>
                    <p className="text-[13px] font-medium text-[#111827] truncate" title={detail.case.receiverName || "—"}>
                      {detail.case.receiverName || "—"}
                    </p>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-[#8a7f72]">Documents</p>
                      <p className="text-[13px] font-medium text-[#111827]">{detail.documents.length}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-[#8a7f72]">Pending</p>
                      <p className="text-[13px] font-semibold text-[#78350f]">{pendingMismatchCount}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
                <div className="border-b border-[#ece6dc] bg-[#fbfaf8] px-4 py-3">
                  <h3 className="text-xs font-semibold tracking-wide text-[#3d3530]">Review</h3>
                  <p className="mt-0.5 text-xs font-normal text-[#8a7f72]">
                    {reviewMode === "tally"
                      ? tallyValidationState.checking
                        ? "Checking Tally data"
                        : remainingTallyBlockerCount > 0
                          ? `${remainingTallyBlockerCount} to fix`
                          : tallyValidationState.blockers.length > 0
                            ? `${tallyValidationState.blockers.length} allowed`
                          : tallyValidationState.warnings.length > 0
                            ? `${tallyValidationState.warnings.length} warning${tallyValidationState.warnings.length === 1 ? "" : "s"}`
                            : "Ready for approval"
                      : visibleMismatches.length === 0
                        ? "No issues"
                        : `${acceptedMismatchCount + rejectedMismatchCount} of ${visibleMismatches.length} done · ${pendingMismatchCount} left`}
                  </p>
                </div>

                {hasInvoice && (
                  <div className="border-b border-[#ece6dc] bg-white p-2">
                    <div className="grid grid-cols-2 gap-1 rounded-lg border border-[#e0d8cc] bg-[#ede6d9]/60 p-1">
                      <button
                        type="button"
                        onClick={() => setReviewMode("mismatches")}
                        className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${reviewMode === "mismatches" ? "bg-white text-[#111827] shadow-sm" : "text-[#6b5d50] hover:text-[#111827]"}`}
                      >
                        Issues{visibleMismatches.length ? ` · ${pendingMismatchCount}` : ""}
                      </button>
                      <button
                        type="button"
                        onClick={() => setReviewMode("tally")}
                        className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition flex items-center justify-center gap-1 ${reviewMode === "tally" ? "bg-white text-[#111827] shadow-sm" : "text-[#6b5d50] hover:text-[#111827]"}`}
                      >
                        <Database className="h-3.5 w-3.5" /> Tally
                      </button>
                    </div>
                  </div>
                )}

                {reviewMode === "tally" ? (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {tallyValidationState.checking ? (
                      <div className="flex items-center gap-2 px-4 py-4 text-xs text-[#8a7f72]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Checking validations…
                      </div>
                    ) : tallyValidationState.blockers.length === 0 && tallyValidationState.warnings.length === 0 ? (
                      <div className="flex items-start gap-2 px-4 py-4 text-xs text-[#55725f]">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        No Tally issues. Ready for approval.
                      </div>
                    ) : (
                      <div className="divide-y divide-[#f0ece4]">
                        {tallyValidationState.blockers.map((item, index) => (
                          <div
                            className="flex w-full items-start gap-2.5 px-3 py-3 transition hover:bg-rose-50/70"
                            key={`blocker:${item.code}:${item.lineId ?? index}`}
                          >
                            <input
                              aria-label={`Allow ${item.label} and continue`}
                              checked={allowedTallyBlockerKeys.has(item.overrideKey)}
                              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-rose-300 accent-rose-700"
                              onChange={() => toggleTallyBlockerOverride(item.overrideKey)}
                              type="checkbox"
                            />
                            <button
                              className="min-w-0 flex-1 text-left"
                              onClick={() => document.getElementById(item.targetId)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                              type="button"
                            >
                              <span className="flex items-start gap-2">
                                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />
                                <span className="min-w-0">
                                  <strong className="block text-[11px] font-semibold leading-4 text-rose-800">{item.label}</strong>
                                  <span className="mt-0.5 block text-[10px] leading-4 text-[#8f5a58]">
                                    {allowedTallyBlockerKeys.has(item.overrideKey) ? "Allowed for this posting" : "Check to allow anyway"}
                                  </span>
                                </span>
                              </span>
                            </button>
                          </div>
                        ))}
                        {tallyValidationState.warnings.map((item, index) => (
                          <button
                            className="flex w-full items-start gap-2.5 px-3 py-3 text-left transition hover:bg-amber-50/70"
                            key={`warning:${item.code}:${item.lineId ?? index}`}
                            onClick={() => document.getElementById(item.targetId)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                            type="button"
                          >
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                            <span className="min-w-0">
                              <strong className="block text-[11px] font-semibold leading-4 text-amber-900">{item.label}</strong>
                              <span className="mt-0.5 block text-[10px] leading-4 text-[#8a6a42]">Warning</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : visibleMismatches.length === 0 ? (
                  <div className="p-5 text-xs font-normal text-[#8a7f72]">All clear — no issues to review.</div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
                    {mismatchGroups.map((group) => {
                      const isExpanded = expandedGroupKeys.has(group.key);

                      return (
                        <section key={group.key} className="border-b border-[#f0ece4] last:border-0">
                          {/* Group header: compact bar, distinct from child rows */}
                          <button
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left bg-[#fbfaf8] hover:bg-[#f0ece6] transition border-b border-[#f0ece4]/60"
                            onClick={() => handleToggleGroup(group.key)}
                            type="button"
                            aria-expanded={isExpanded}
                            aria-label={`${group.label} — ${group.pending} pending, ${group.mismatches.length} total. Click to ${isExpanded ? "collapse" : "expand"}`}
                          >
                            <span className={`h-1 w-1 shrink-0 rounded-full ${group.pending > 0 ? "bg-[#b45309]" : "bg-[#2d6a4f]"}`} />
                            <span className="min-w-0 flex-1 flex items-center gap-1.5">
                              <span className="text-[11px] font-bold uppercase tracking-wide text-[#3d3530] leading-none">{group.label}</span>
                              <span className="text-[11px] font-normal text-[#8a7f72] leading-none">· {group.pending > 0 ? `${group.pending} to do` : "Done"} · {group.mismatches.length}</span>
                            </span>
                            <span className="text-[11px] font-medium text-[#8a7f72] tabular-nums leading-none">{group.pending > 0 ? `${group.pending}` : "✓"}</span>
                            <ChevronDown className={`h-3 w-3 shrink-0 text-[#b5aaa0] transition ${isExpanded ? "rotate-180" : ""}`} />
                          </button>

                          {isExpanded && (
                            <div className="bg-white border-t border-[#ece6dc]">
                              {group.mismatches.map((mismatch) => {
                                const isActive = activeMismatchId === mismatch.id;
                                const isPending = mismatch.resolutionStatus === "pending";
                                const isSelected = selectedMismatchIds.has(mismatch.id);
                                const itemLabel = isLineItemMismatchField(mismatch.fieldName) ? getLineItemLabel(mismatch) : null;
                                const mismatchEvidence = buildMismatchEvidence(mismatch, documentLookup);
                                const issueLabel = getIssueDisplayTitle(mismatch, mismatchEvidence);
                                const issueDetail = getIssueListDetail(mismatch, mismatchEvidence);

                                return (
                                  <div
                                    key={mismatch.id}
                                    className={`flex items-start gap-2.5 py-2.5 pr-3 transition border-l-2 ${isActive ? "border-[#2b1a10] bg-[#ede6d9]/35" : "border-transparent hover:bg-[#f7f4ef]"} ${isSelected && !isActive ? "bg-[#fbfaf8]" : ""}`}
                                    style={{ paddingLeft: "28px" }}
                                  >
                                    {isPending && !isCaseFinal ? (
                                      <input
                                        aria-label={`Select ${issueLabel}`}
                                        checked={isSelected}
                                        className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-[#c4b9ad] accent-[#2b1a10]"
                                        onChange={() => handleToggleSelectedMismatch(mismatch.id)}
                                        type="checkbox"
                                      />
                                    ) : (
                                      <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${mismatch.resolutionStatus === "accepted" ? "bg-[#2d6a4f]" : mismatch.resolutionStatus === "rejected" ? "bg-[#b91c1c]" : "bg-[#b45309]"}`} />
                                    )}
                                    <button
                                      className="min-w-0 flex-1 text-left"
                                      onClick={() => {
                                        setReviewMode("mismatches");
                                        setActiveMismatchId(mismatch.id);
                                      }}
                                      type="button"
                                    >
                                      {itemLabel ? <span className="block text-[10px] font-normal text-[#8a7f72] leading-3">{itemLabel}</span> : null}
                                      <span className={`block text-[12px] leading-4 ${isActive ? "font-semibold text-[#111827]" : "font-normal text-[#3d3530]"}`}>{issueLabel}</span>
                                      <span className="block text-[11px] font-normal text-[#8a7f72] leading-3 mt-0.5 truncate">{issueDetail}</span>
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>

            {/* Main Detail Content - warm palette */}
            <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#f7f4ef]">
              <div className="flex-1 overflow-y-auto">
                {tallyOpened ? (
                  <div className={reviewMode === "tally" ? "contents" : "hidden"} aria-hidden={reviewMode !== "tally"}>
                    <TallyPurchasePostingPanel
                      caseId={caseId}
                      onApprovePacket={
                        detail.case.status === "completed" &&
                        pendingMismatchCount === 0 &&
                        rejectedMismatchCount === 0
                          ? handleApprovePacketFromTally
                          : undefined
                      }
                      onHeaderStateChange={setTallyHeaderState}
                      onValidationStateChange={handleTallyValidationStateChange}
                      allowedBlockerKeys={Array.from(allowedTallyBlockerKeys)}
                      onRefreshReady={(refresh) => {
                        tallyPurchaseRefreshRef.current = refresh;
                      }}
                    />
                  </div>
                ) : null}
                {reviewMode === "mismatches" ? (
                <div className="mx-auto w-full max-w-6xl px-4 py-3 sm:px-6 sm:py-4 lg:px-8">
                  {visibleMismatches.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-2xl border border-[#e0d8cc] bg-white p-12 text-center shadow-sm mt-8">
                      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-[#ded8d0] bg-[#fbfaf8] text-[#2d6a4f]">
                        <CheckCircle2 className="h-6 w-6" />
                      </div>
                      <h2 className="text-lg font-bold tracking-tight text-[#111827]">All clear</h2>
                      <p className="mt-1 text-xs font-normal text-[#8a7f72]">
                        No value conflicts were found across the documents in this case.
                      </p>
                    </div>
                  ) : activeMismatch ? (
                    <article className="min-w-0">
                      <div className="border-b border-[#ded8d0] py-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-normal text-[#8a7f72]">
                              <span>{(activeGroup?.label ?? "Review group").replace(" / ", " & ")}</span>
                            </div>
                            <h2 className="text-lg font-bold tracking-tight text-[#111827] sm:text-xl">
                              {activeIssueDisplayTitle}
                            </h2>
                          </div>
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium shadow-sm ${getMismatchResolutionClassName(activeMismatch.resolutionStatus)}`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${activeMismatch.resolutionStatus === "accepted" ? "bg-[#2d6a4f]" : activeMismatch.resolutionStatus === "rejected" ? "bg-[#b91c1c]" : "bg-[#b45309]"}`} />
                            {getMismatchResolutionLabel(activeMismatch.resolutionStatus)}
                          </span>
                        </div>

                        {activeIssueHint && isActiveMismatchPending ? (
                          <div className="mt-3 border-l-2 border-[#cdbfae] py-0.5 pl-3 text-xs font-normal leading-5 text-[#5b4b3d]">
                            {activeIssueHint}
                          </div>
                        ) : null}
                      </div>

                      {activeIsSingleDocumentIssue ? (
                        <div className="space-y-4 py-4">
                          <div className="border-y border-[#f2c7c4] bg-[#fbf0ef] px-3 py-3">
                            <div className="text-xs font-semibold text-[#8c1d18]">
                              {activeTaxValidationIssue ? "Tax check failed" : "Issue found"}
                            </div>
                            <div className="mt-1.5 text-[13px] font-medium leading-5 text-[#8c1d18]">
                              {activeTaxValidationIssue
                                ? activeTaxValidationIssue.summary
                                : formatMismatchValue(
                                    activeMismatch.fieldName,
                                    activeEvidence[0]?.value,
                                    getEvidenceDocumentRole(activeEvidence[0]?.document)
                                  )}
                            </div>
                            {activeTaxValidationIssue ? (
                              <>
                                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                                  <div className="rounded-md bg-white px-2.5 py-2">
                                    <div className="text-[10px] font-semibold tracking-wide text-[#8a7f72]">Taxable</div>
                                    <div className="mt-0.5 text-[13px] font-medium text-[#111827]">
                                      {formatTaxAmount(activeTaxValidationIssue.taxableAmount)}
                                    </div>
                                  </div>
                                  <div className="rounded-md bg-white px-2.5 py-2">
                                    <div className="text-[10px] font-semibold tracking-wide text-[#8a7f72]">Expected tax</div>
                                    <div className="mt-0.5 text-[13px] font-medium text-[#111827]">
                                      {formatTaxAmount(activeTaxValidationIssue.expectedTax)}
                                    </div>
                                  </div>
                                  <div className="rounded-md bg-white px-2.5 py-2">
                                    <div className="text-[10px] font-semibold tracking-wide text-[#8a7f72]">Extracted tax</div>
                                    <div className="mt-0.5 text-[13px] font-medium text-[#111827]">
                                      {formatTaxAmount(activeTaxValidationIssue.actualTax)}
                                    </div>
                                  </div>
                                  <div className="rounded-md bg-white px-2.5 py-2">
                                    <div className="text-[10px] font-semibold tracking-wide text-[#8a7f72]">Difference</div>
                                    <div className="mt-0.5 text-[13px] font-medium text-[#111827]">
                                      {activeTaxValidationIssue.difference === null
                                        ? "-"
                                        : `${formatTaxAmount(Math.abs(activeTaxValidationIssue.difference))} ${
                                            activeTaxValidationIssue.difference < 0 ? "short" : "extra"
                                          }`}
                                    </div>
                                  </div>
                                </div>
                                {(activeTaxValidationIssue.rule || activeTaxValidationIssue.condition) && (
                                  <div className="mt-2 rounded-md bg-white px-2.5 py-1.5 text-[11px] font-normal leading-4 text-[#5b4b3d]">
                                    {activeTaxValidationIssue.condition ? (
                                      <span>{activeTaxValidationIssue.condition}. </span>
                                    ) : null}
                                    {activeTaxValidationIssue.rule ? (
                                      <span>Expected rule: {activeTaxValidationIssue.rule}.</span>
                                    ) : null}
                                  </div>
                                )}
                              </>
                            ) : null}
                          </div>

                          <div className="grid gap-2 border-y border-[#e0d8cc] px-3 py-2 text-[13px] sm:grid-cols-2">
                            <div className="min-w-0">
                              <span className="mr-2 text-xs font-semibold text-[#8a7f72]">Document</span>
                              <span className="font-medium text-[#111827]">
                                {getEvidenceDocumentRole(activeEvidence[0]?.document)}
                              </span>
                            </div>
                            <div className="min-w-0">
                              <span className="mr-2 text-xs font-semibold text-[#8a7f72]">Source</span>
                              <span
                                className="inline-block max-w-full truncate align-bottom font-medium text-[#111827]"
                                title={getDocumentSourceLabel(activeEvidence[0]?.document)}
                              >
                                {getCompactSourceLabel(activeEvidence[0]?.document)}
                              </span>
                            </div>
                          </div>

                          {activeSingleIssueRows.length > 0 ? (
                            <div className="border-y border-[#e0d8cc]">
                              <div className="border-b border-[#ece6dc] bg-[#fbfaf8] px-3 py-2 text-xs font-semibold text-[#3d3530]">
                                Useful context
                              </div>
                              <div className="divide-y divide-[#ece6dc]">
                                {activeSingleIssueRows.map((row) => (
                                  <div key={row.key} className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-[180px_1fr]">
                                    <div className="font-normal text-[#8a7f72]">{row.label}</div>
                                    <div className="font-medium text-[#111827]">{displayValue(row.value)}</div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="overflow-x-auto border-b border-[#ded8d0]">
                          <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
                            <thead>
                              <tr className="border-b border-[#e0d8cc] bg-transparent text-xs font-semibold tracking-wide text-[#3d3530]">
                                <th className="w-44 px-3 py-3">Field</th>
                                {activeEvidence.map((evidence) => (
                                  <th
                                    key={evidence.key}
                                    className="w-36 min-w-[9rem] max-w-[10rem] px-3 py-3 align-bottom"
                                  >
                                    <div className="whitespace-normal break-words leading-4">
                                      {getEvidenceDocumentRole(evidence.document)}
                                    </div>
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              <tr className="border-b border-[#f2c7c4] bg-[#fbf0ef]">
                                <td className="border-l-4 border-[#b91c1c] px-3 py-3 font-semibold text-[#3d3530]">
                                  Compared value
                                </td>
                                {activeEvidence.map((evidence) => (
                                  <td key={evidence.key} className="max-w-[10rem] break-words px-3 py-3 align-top font-semibold text-[#8c1d18]">
                                    <span className="break-all">
                                      {formatMismatchValue(
                                        activeMismatch.fieldName,
                                        evidence.value,
                                        getEvidenceDocumentRole(evidence.document)
                                      )}
                                    </span>
                                    <div className="mt-1 whitespace-nowrap text-[11px] font-normal text-[#8a7f72]">
                                      {getDocumentPageLabel(evidence.document)}
                                    </div>
                                  </td>
                                ))}
                              </tr>
                              {uniqueStrings(
                                activeEvidence.flatMap((evidence) =>
                                  evidence.contextRows
                                    .filter((row) => !row.emphasis && row.key !== activeMismatch.fieldName)
                                    .map((row) => row.key)
                                )
                              )
                                .slice(0, 5)
                                .map((contextKey) => {
                                  const label =
                                    activeEvidence
                                      .flatMap((evidence) => evidence.contextRows)
                                      .find((row) => row.key === contextKey)?.label ?? getFieldLabel(contextKey);

                                  return (
                                    <tr key={contextKey} className="border-b border-[#ece6dc]">
                                      <td className="px-3 py-3 font-semibold text-[#3d3530]">{label}</td>
                                      {activeEvidence.map((evidence) => {
                                        const row = evidence.contextRows.find((entry) => entry.key === contextKey);
                                        return (
                                          <td key={`${evidence.key}-${contextKey}`} className="max-w-[10rem] break-all px-3 py-3 font-normal text-[#111827]">
                                            {row ? displayValue(row.value) : <span className="text-[#b5aaa0]">—</span>}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>
                      )}

                    </article>
                  ) : (
                    <div className="flex h-[400px] items-center justify-center text-center text-xs font-normal text-[#8a7f72]">
                      Select an issue from the list to review conflicting values.
                    </div>
                  )}
                </div>
                ) : null}
              </div>

              {reviewMode === "mismatches" && visibleMismatches.length > 0 && activeMismatch && !isCaseFinal && (
                <footer className="z-20 shrink-0 border-t border-[#e0d8cc] bg-[#fbfaf8]/95 px-4 py-3 shadow-[0_-8px_24px_rgba(45,36,28,0.06)] backdrop-blur sm:px-6 lg:px-8">
                  <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                            detail.case.status === "accepted"
                              ? "bg-[#eaf7f0] text-[#1b4332]"
                              : detail.case.status === "rejected"
                                ? "bg-[#fbefee] text-[#8c1d18]"
                                : "bg-[#f1ece4] text-[#5f554b]"
                          }`}
                          aria-hidden="true"
                        >
                          {detail.case.status === "accepted" ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : detail.case.status === "rejected" ? (
                            <X className="h-3.5 w-3.5" />
                          ) : (
                            <span className="text-[11px] font-semibold">{pendingMismatchCount}</span>
                          )}
                        </span>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[#2d2722]">
                            {detail.case.status === "accepted"
                              ? "Review complete"
                              : detail.case.status === "rejected"
                                ? "Case rejected"
                                : selectedPendingMismatchIds.length > 0
                                  ? `${selectedPendingMismatchIds.length} selected`
                                  : `${pendingMismatchCount} ${pendingMismatchCount === 1 ? "issue" : "issues"} to review`}
                          </div>
                          <div className="mt-0.5 text-[11px] text-[#8a7f72]">
                            {detail.case.status === "accepted"
                              ? `${acceptedMismatchCount} ${acceptedMismatchCount === 1 ? "issue" : "issues"} accepted`
                              : detail.case.status === "rejected"
                                ? `${rejectedMismatchCount} rejected · ${acceptedMismatchCount} accepted`
                                : `${acceptedMismatchCount} accepted · ${rejectedMismatchCount} rejected`}
                          </div>
                        </div>
                      </div>
                      {decisionStatus === "error" && decisionError && (
                        <div className="mt-1 text-xs font-medium text-[#8c1d18]">{decisionError}</div>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap justify-end gap-2">
                      {selectedPendingMismatchIds.length > 0 && !isCaseFinal ? (
                        <>
                          <Button
                            className="rounded-lg border-[#ded8d0] bg-[#fbfaf8] text-xs font-medium text-[#3d3530] hover:bg-[#ede6d9] shadow-sm"
                            disabled={decisionStatus === "updating"}
                            onClick={handleClearSelected}
                            variant="outline"
                          >
                            Clear
                          </Button>
                          <Button
                            variant="outline"
                            className="rounded-lg border-[#f2c7c4] bg-[#fbf0ef] text-xs font-medium text-[#8c1d18] hover:bg-[#f2c7c4]/50 shadow-sm"
                            disabled={decisionStatus === "updating"}
                            onClick={() => {
                              void handleBulkMismatchDecision("rejected");
                            }}
                          >
                            {decisionStatus === "updating" ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <X className="mr-2 h-4 w-4" />
                            )}
                            Reject Selected
                          </Button>
                          <Button
                            className="rounded-lg bg-[#2b1a10] text-xs font-medium text-white hover:bg-[#3b271a] shadow-sm"
                            disabled={decisionStatus === "updating"}
                            onClick={() => {
                              void handleBulkMismatchDecision("accepted");
                            }}
                          >
                            {decisionStatus === "updating" ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="mr-2 h-4 w-4" />
                            )}
                            Accept Selected
                          </Button>
                        </>
                      ) : isActiveMismatchPending && !isCaseFinal ? (
	                        <>
                          <Button
                            className="rounded-lg border-[#ded8d0] bg-[#fbfaf8] text-xs font-medium text-[#3d3530] hover:bg-[#ede6d9] shadow-sm"
                            disabled={decisionStatus === "updating" || pendingVisibleMismatchIds.length === 0}
                            onClick={handleSelectAllPending}
                            variant="outline"
                          >
                            Select all
                          </Button>
 	                          <Button
                            variant="outline"
                            className="rounded-lg border-[#f2c7c4] bg-[#fbf0ef] text-xs font-medium text-[#8c1d18] hover:bg-[#f2c7c4]/50 shadow-sm"
                            disabled={decisionStatus === "updating"}
                            onClick={() => handleMismatchDecision("rejected")}
                          >
                            {decisionStatus === "updating" ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <X className="mr-2 h-4 w-4" />
                            )}
                            Reject Issue
                          </Button>
                          <Button
                            className="rounded-lg bg-[#2b1a10] text-xs font-medium text-white hover:bg-[#3b271a] shadow-sm"
                            disabled={decisionStatus === "updating"}
                            onClick={() => handleMismatchDecision("accepted")}
                          >
                            {decisionStatus === "updating" ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="mr-2 h-4 w-4" />
                            )}
                            Accept Issue
                          </Button>
                        </>
                      ) : !isCaseFinal ? (
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide ${getMismatchResolutionClassName(activeMismatch.resolutionStatus)}`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${activeMismatch.resolutionStatus === "accepted" ? "bg-[#2d6a4f]" : "bg-[#b91c1c]"}`} />
                          {getMismatchResolutionLabel(activeMismatch.resolutionStatus)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </footer>
              )}
            </main>
          </div>
        )}
      </div>
    </AppShell>
  );
}

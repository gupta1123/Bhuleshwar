"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  Folder,
  Loader2,
  Plus,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  Database,
  Check,
  X,
  FileSearch,
  Play,
  ZoomIn,
  ZoomOut,
  RotateCw,
  GripVertical,
  type LucideIcon,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import {
  CaseDetailRedesign,
  type RedesignedDocumentCard,
} from "@/components/cases/CaseDetailRedesign";
import { PdfEvidencePreview } from "@/components/cases/PdfEvidencePreview";
import {releaseProtectedPreview} from '@/lib/protected-preview';
import { TallyInReviewPanel } from "@/components/cases/TallyInReviewPanel";
import { ExtractedFieldsPanel, type ExtractedFieldItem } from "@/components/cases/ExtractedFieldsPanel";
import styles from "@/components/cases/CaseDetailPage.module.css";
import { AnalysisOptionsDialog } from "@/components/workspace/AnalysisOptionsDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  getComparableFieldValue,
  getComparisonModeLabel,
  isPrimaryComparisonField,
  readComparisonOptions,
} from "@/lib/comparison";
import {
  ACTIVE_FIELD_DEFINITIONS,
  getFieldDefinitionsByKeys,
  getFieldDefinitionsForDocType,
  shouldConsiderFieldKey,
} from "@/lib/document-schema";
import { isLineItemMismatchField } from "@/lib/line-items";
import {
  appendCaseFiles,
  enqueueCaseAnalysis,
  fetchCaseAnalysisStatus,
  fetchCaseDetail,
  fetchCaseDetailPreferCache,
  fetchCaseFileSignedUrlPreferCache,
  updateCaseDecision,
  type CaseDecision,
  type SavedCaseDetail,
} from "@/lib/case-persistence";
import { readUploadGroupMeta } from "@/lib/upload-groups";
import type {
  CaseAnalysisMode,
  CommercialLineItem,
  ComparisonOptions,
  DocType,
  FieldKey,
  PipelineStageProgress,
  QueuedUpload,
} from "@/types/pipeline";

type LoadState = "loading" | "ready" | "error";
type ActiveTab = "preview" | "data";
type DataViewMode = "fields" | "lineItems" | "terms";
type PreviewFocus = {
  id: string;
  label: string;
  query: string;
  pageNumber?: number;
  occurrence?: number;
};
type DocumentFieldComparison = { key: string; label: string } | null;
const DEFAULT_DATA_PANE_WIDTH = 576;
const DEFAULT_PREVIEW_ZOOM = 1;
const MIN_DATA_PANE_WIDTH = 280;
const MIN_PREVIEW_PANE_WIDTH = 440;
const PANE_RESIZE_STEP = 24;
const PURCHASE_ORDER_DOCUMENT_TYPES = new Set(["Purchase Order", "Amended Purchase Order"]);
const TERMS_CHECKLIST_DEFINITIONS = [
  { key: "paymentTerms", label: "Payment", keywords: ["payment", "advance", "proforma"] },
  { key: "deliveryTerms", label: "Delivery", keywords: ["delivery", "dispatch", "delivered", "schedule"] },
  { key: "freightTerms", label: "Freight", keywords: ["freight", "transport", "godown"] },
  { key: "packingForwardingTerms", label: "Packing / Forwarding", keywords: ["packing", "forwarding", "p&f"] },
  { key: "priceBasis", label: "Price Basis", keywords: ["price", "late", "fee", "basis"] },
  { key: "taxTerms", label: "Tax / GST", keywords: ["tax", "gst", "eway", "e-way"] },
  { key: "inspectionTerms", label: "Inspection / Quality", keywords: ["inspection", "test", "certificate", "quality"] },
  { key: "warrantyTerms", label: "Warranty", keywords: ["warranty", "guarantee"] },
  { key: "termsAndConditions", label: "Other Terms", keywords: ["terms", "conditions", "clause"] },
] as const;
const TERMS_FIELD_KEYS = TERMS_CHECKLIST_DEFINITIONS.map((item) => item.key);
const TERMS_FIELD_KEY_SET = new Set<string>(TERMS_FIELD_KEYS);

const DETAIL_TABS: { id: ActiveTab; label: string; icon: LucideIcon }[] = [
  { id: "preview", label: "Original", icon: Eye },
  { id: "data", label: "Data", icon: Database },
];

const FIELD_LABEL_LOOKUP = ACTIVE_FIELD_DEFINITIONS.reduce(
  (acc, field) => {
    acc[field.key] = field.label;
    return acc;
  },
  {} as Record<string, string>
);
const TERMS_COMPLIANCE_FIELD = "termsAndConditions";

type TermsComplianceChecklistItem = {
  sourceDocId: string;
  sourceClause: string;
  obligation: string;
  category: string;
  status: "fulfilled" | "not_fulfilled" | "unknown" | "not_applicable";
  evidenceDocIds: string[];
  evidence: string;
  reason: string;
  severity: "high" | "medium" | "low" | "none";
};

type CaseDetailDocument = SavedCaseDetail["documents"][number];

type SplitSiblingCase = {
  id: string;
  displayName: string;
  groupIndex: number;
};

type SplitAnalysisMeta = {
  groupCount: number;
  groupIndex: number;
  sourceCaseId: string;
  sourceFileNames: string[];
  groupId: string;
  siblingCases: SplitSiblingCase[];
  note: string;
};

type SellerChainRoleSelectionMeta = {
  primaryDocumentIds: string[];
  contextDocumentIds: string[];
  note: string;
};

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function readSplitAnalysisMeta(processingMeta: unknown): SplitAnalysisMeta | null {
  if (!processingMeta || typeof processingMeta !== "object" || Array.isArray(processingMeta)) {
    return null;
  }

  const raw = (processingMeta as Record<string, unknown>).splitAnalysis;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const groupCount = Number(record.groupCount);
  const groupIndex = Number(record.groupIndex);
  const sourceCaseId = String(record.sourceCaseId ?? "").trim();
  const groupId = String(record.groupId ?? "").trim();
  const note = String(record.note ?? "").trim();
  if (!Number.isFinite(groupCount) || groupCount < 2 || !Number.isFinite(groupIndex) || groupIndex < 1) {
    return null;
  }

  const siblingCases = Array.isArray(record.siblingCases)
    ? record.siblingCases.flatMap((entry): SplitSiblingCase[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const sibling = entry as Record<string, unknown>;
        const id = String(sibling.id ?? "").trim();
        const displayName = String(sibling.displayName ?? "").trim();
        const siblingGroupIndex = Number(sibling.groupIndex);
        if (!id || !displayName || !Number.isFinite(siblingGroupIndex)) return [];
        return [{ id, displayName, groupIndex: siblingGroupIndex }];
      })
    : [];

  return {
    groupCount,
    groupIndex,
    sourceCaseId,
    sourceFileNames: readStringArray(record.sourceFileNames),
    groupId,
    siblingCases,
    note: note || `This uploaded file was split into ${groupCount} separate cases during analysis.`,
  };
}

function readSellerChainRoleSelectionMeta(processingMeta: unknown): SellerChainRoleSelectionMeta | null {
  if (!processingMeta || typeof processingMeta !== "object" || Array.isArray(processingMeta)) {
    return null;
  }

  const rawGroups = (processingMeta as Record<string, unknown>).verificationGroups;
  if (!Array.isArray(rawGroups)) return null;

  for (const group of rawGroups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    const roleSelection = (group as Record<string, unknown>).roleSelection;
    if (!roleSelection || typeof roleSelection !== "object" || Array.isArray(roleSelection)) continue;

    const record = roleSelection as Record<string, unknown>;
    if (record.strategy !== "seller_chain") continue;

    const primaryDocumentIds = readStringArray(record.primaryDocumentIds);
    const contextDocumentIds = readStringArray(record.contextDocumentIds);
    if (!primaryDocumentIds.length || !contextDocumentIds.length) continue;

    return {
      primaryDocumentIds,
      contextDocumentIds,
      note:
        String(record.note ?? "").trim() ||
        "Seller-chain role selection applied: Kalika-facing invoice was reconciled; upstream seller invoices were kept as context.",
    };
  }

  return null;
}

function readTermsComplianceChecklist(processingMeta: unknown): TermsComplianceChecklistItem[] {
  if (!processingMeta || typeof processingMeta !== "object" || Array.isArray(processingMeta)) {
    return [];
  }

  const raw = (processingMeta as Record<string, unknown>).termsComplianceChecklist;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const sourceDocId = String(record.sourceDocId ?? "").trim();
    const sourceClause = String(record.sourceClause ?? "").trim();
    const obligation = String(record.obligation ?? "").trim();
    const status = String(record.status ?? "").trim() as TermsComplianceChecklistItem["status"];
    if (!sourceDocId || !sourceClause || !obligation) return [];
    if (!["fulfilled", "not_fulfilled", "unknown", "not_applicable"].includes(status)) return [];

    return [
      {
        sourceDocId,
        sourceClause,
        obligation,
        category: String(record.category ?? "Terms compliance").trim() || "Terms compliance",
        status,
        evidenceDocIds: Array.isArray(record.evidenceDocIds)
          ? record.evidenceDocIds.map((value) => String(value ?? "").trim()).filter(Boolean)
          : [],
        evidence: String(record.evidence ?? "").trim(),
        reason: String(record.reason ?? "").trim(),
        severity: String(record.severity ?? "none").trim() as TermsComplianceChecklistItem["severity"],
      },
    ];
  });
}

function getDocumentFieldLabel(documentType: string | undefined, key: string) {
  if (documentType === "E-Way Bill" && key === "subtotal") {
    return "Total Taxable Amount";
  }

  return FIELD_LABEL_LOOKUP[key] || key;
}

function getTermValue(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function isNonRequiredDocumentField(documentType: string, key: string) {
  return PURCHASE_ORDER_DOCUMENT_TYPES.has(documentType) && key === "hasVendorStamp";
}

function getTermsIssueText(mismatch: SavedCaseDetail["mismatches"][number]) {
  return [
    mismatch.analysis ?? "",
    mismatch.fixPlan ?? "",
    ...mismatch.values.map((entry) => String(entry.value ?? "")),
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function termsIssueMatchesDocument(
  mismatch: SavedCaseDetail["mismatches"][number],
  document: SavedCaseDetail["documents"][number] | null
) {
  if (!document || mismatch.fieldName !== TERMS_COMPLIANCE_FIELD) return false;
  const documentIds = new Set(
    [document.id, document.clientDocumentId, document.sourceHint, document.title]
      .filter((value): value is string => Boolean(value))
  );
  return mismatch.values.some((entry) => entry.docId && documentIds.has(entry.docId));
}

function termsIssueMatchesDefinition(
  mismatch: SavedCaseDetail["mismatches"][number],
  definition: (typeof TERMS_CHECKLIST_DEFINITIONS)[number],
  value: string
) {
  const issueText = getTermsIssueText(mismatch).toLowerCase();
  if (definition.key === "termsAndConditions") return false;
  if (definition.keywords.some((keyword) => issueText.includes(keyword))) return true;

  const usefulWords = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 5)
    .slice(0, 8);
  if (usefulWords.length < 2) return false;

  return usefulWords.filter((word) => issueText.includes(word)).length >= 2;
}

function getTermsIssueStatus(mismatch: SavedCaseDetail["mismatches"][number]) {
  const text = getTermsIssueText(mismatch).toLowerCase();
  if (text.includes("not fulfilled")) {
    return {
      label: "Not fulfilled",
      className: "border-rose-200 bg-rose-50 text-rose-700",
      icon: ShieldAlert,
    };
  }

  return {
    label: "Needs review",
    className: "border-amber-200 bg-amber-50 text-amber-700",
    icon: TriangleAlert,
  };
}

function getClearTermsStatus() {
  return {
    label: "No issue flagged",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  };
}

function getChecklistStatus(status: TermsComplianceChecklistItem["status"]) {
  if (status === "not_fulfilled") {
    return {
      label: "Not fulfilled",
      className: "border-rose-200 bg-rose-50 text-rose-700",
      icon: ShieldAlert,
    };
  }

  if (status === "unknown") {
    return {
      label: "Needs review",
      className: "border-amber-200 bg-amber-50 text-amber-700",
      icon: TriangleAlert,
    };
  }

  if (status === "not_applicable") {
    return {
      label: "Not applicable",
      className: "border-slate-200 bg-slate-50 text-slate-600",
      icon: Check,
    };
  }

  return {
    label: "Fulfilled",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  };
}

const LINE_ITEM_COLUMNS: Array<{
  key: keyof CommercialLineItem;
  label: string;
  className?: string;
}> = [
  { key: "lineNumber", label: "#", className: "w-12" },
  { key: "itemCode", label: "Item Code", className: "min-w-32" },
  { key: "description", label: "Description", className: "min-w-60" },
  { key: "hsnSac", label: "HSN/SAC", className: "min-w-24" },
  { key: "quantity", label: "Qty", className: "min-w-20 text-right" },
  { key: "unit", label: "Unit", className: "min-w-16" },
  { key: "rate", label: "Rate", className: "min-w-24 text-right" },
  { key: "taxableAmount", label: "Taxable", className: "min-w-28 text-right" },
  { key: "taxRate", label: "GST %", className: "min-w-20 text-right" },
  { key: "cgstRate", label: "CGST %", className: "min-w-20 text-right" },
  { key: "sgstRate", label: "SGST %", className: "min-w-20 text-right" },
  { key: "igstRate", label: "IGST %", className: "min-w-20 text-right" },
  { key: "taxAmount", label: "Tax", className: "min-w-24 text-right" },
  { key: "lineTotal", label: "Total", className: "min-w-28 text-right" },
];

const DRAFT_STAGE_SEQUENCE: PipelineStageProgress["stage"][] = [
  "upload_received",
  "classifying",
  "ocr",
  "extracting",
  "validating",
  "complete",
];

function buildDraftStages(): PipelineStageProgress[] {
  return DRAFT_STAGE_SEQUENCE.map((stage, index) => ({
    stage,
    status: index === 0 ? "active" : "pending",
    startedAt: index === 0 ? Date.now() : undefined,
  }));
}

function buildDraftUploads(files: File[]): QueuedUpload[] {
  return files.map((file, index) => ({
    id: `${file.name}-${Date.now()}-${index}`,
    name: file.name,
    file,
    files: [file],
    source: "file",
    stages: buildDraftStages(),
  }));
}

function getOrderedDocumentEntries(
  documentType: string,
  extractedFields: Record<string, unknown>
) {
  const visibleEntries = Object.entries(extractedFields).filter(
    ([key, value]) =>
      !isNonRequiredDocumentField(documentType, key) &&
      !(documentType === "E-Way Bill" && key === "subtotal" && extractedFields.totalTaxableAmount) &&
      value !== null &&
      value !== undefined &&
      value !== ""
  );
  const relevantDefinitions = getFieldDefinitionsForDocType(documentType);
  const relevantKeys = relevantDefinitions.map(({ key }) => key);
  const relevantKeySet = new Set(relevantKeys);
  const remainingKeys = visibleEntries
    .map(([key]) => key)
    .filter((key) => !relevantKeySet.has(key as (typeof relevantKeys)[number]));

  return getFieldDefinitionsByKeys([...relevantKeys, ...remainingKeys]).flatMap(({ key }) => {
    const value = extractedFields[key];
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      (documentType === "E-Way Bill" && key === "subtotal" && extractedFields.totalTaxableAmount)
    ) {
      return [];
    }
    return [[key, value] as [string, unknown]];
  });
}

function getCompactDocumentType(documentType: string) {
  if (/purchase order/i.test(documentType)) return "PO";
  if (/tax invoice|invoice/i.test(documentType)) return "Invoice";
  if (/e-?way/i.test(documentType)) return "E-Way";
  return documentType.replace(/\s+document$/i, "");
}

function getPacketDocumentLabels(documents: SavedCaseDetail["documents"]) {
  const labels = documents.map((document) => getCompactDocumentType(document.documentType || "Document"));
  return Array.from(new Set(labels));
}

function getMissingPacketDocumentLabels(documents: SavedCaseDetail["documents"]) {
  const documentTypes = documents.map((document) => document.documentType.toLowerCase());
  const hasPo = documentTypes.some((type) => type.includes("purchase order"));
  const hasInvoice = documentTypes.some((type) => type.includes("invoice"));
  const hasEWay = documentTypes.some((type) => type.includes("e-way") || type.includes("eway"));

  return [
    !hasPo ? "PO" : "",
    !hasInvoice ? "Invoice" : "",
    !hasEWay ? "E-Way" : "",
  ].filter(Boolean);
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeInvoiceCopyValue(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function getStringField(document: CaseDetailDocument, key: string) {
  const value = document.extractedFields[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function isInvoiceDocument(document: CaseDetailDocument) {
  return /^(?:tax\s+)?invoice$/i.test(document.documentType.trim());
}

function getInvoiceDisplayIdentity(document: CaseDetailDocument) {
  return normalizeInvoiceCopyValue(
    getStringField(document, "invoiceNumber") ||
      getStringField(document, "referenceInvoiceNumber")
  );
}

function parseInvoiceAmount(value: unknown) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function getInvoiceAmount(document: CaseDetailDocument) {
  return (
    parseInvoiceAmount(getStringField(document, "totalAmount")) ??
    parseInvoiceAmount(getStringField(document, "totalTaxableAmount")) ??
    parseInvoiceAmount(getStringField(document, "subtotal"))
  );
}

function invoiceAmountsMatch(left: CaseDetailDocument, right: CaseDetailDocument) {
  const leftAmount = getInvoiceAmount(left);
  const rightAmount = getInvoiceAmount(right);
  if (leftAmount === null || rightAmount === null) return false;
  return Math.abs(leftAmount - rightAmount) <= Math.max(1, Math.abs(rightAmount) * 0.001);
}

function normalizedInvoiceField(document: CaseDetailDocument, field: string) {
  return normalizeInvoiceCopyValue(getStringField(document, field));
}

function invoicePartyNameMatches(left: string, right: string) {
  return Boolean(
    left &&
      right &&
      left.length >= 5 &&
      right.length >= 5 &&
      (left === right || left.includes(right) || right.includes(left))
  );
}

function invoicePartySideMatches(
  left: CaseDetailDocument,
  right: CaseDetailDocument,
  gstinField: string,
  nameField: string
) {
  const leftGstin = normalizedInvoiceField(left, gstinField);
  const rightGstin = normalizedInvoiceField(right, gstinField);
  if (leftGstin && rightGstin) return leftGstin === rightGstin;

  const leftName = normalizedInvoiceField(left, nameField);
  const rightName = normalizedInvoiceField(right, nameField);
  if (leftName && rightName) return invoicePartyNameMatches(leftName, rightName);

  return null;
}

function hasInvoicePartySideEvidence(document: CaseDetailDocument, gstinField: string, nameField: string) {
  return Boolean(normalizedInvoiceField(document, gstinField) || normalizedInvoiceField(document, nameField));
}

function invoicePartiesCompatible(left: CaseDetailDocument, right: CaseDetailDocument) {
  const supplierMatch = invoicePartySideMatches(left, right, "supplierGstin", "vendorName");
  if (supplierMatch === false) return false;

  const buyerMatch = invoicePartySideMatches(left, right, "buyerGstin", "buyerName");
  if (buyerMatch === false) return false;

  const hasSupplierEvidence =
    hasInvoicePartySideEvidence(left, "supplierGstin", "vendorName") ||
    hasInvoicePartySideEvidence(right, "supplierGstin", "vendorName");
  if (hasSupplierEvidence) return supplierMatch === true;

  return buyerMatch === true;
}

function areDuplicateInvoiceDisplayCopies(left: CaseDetailDocument, right: CaseDetailDocument) {
  if (!isInvoiceDocument(left) || !isInvoiceDocument(right)) return false;
  const leftInvoice = getInvoiceDisplayIdentity(left);
  const rightInvoice = getInvoiceDisplayIdentity(right);
  if (!leftInvoice || !rightInvoice || leftInvoice !== rightInvoice) return false;

  return invoiceAmountsMatch(left, right) && invoicePartiesCompatible(left, right);
}

function inferSellerChainRoleSelection(
  documents: SavedCaseDetail["documents"]
): SellerChainRoleSelectionMeta | null {
  const invoices = documents.filter(isInvoiceDocument);
  const purchaseOrders = documents.filter((document) =>
    PURCHASE_ORDER_DOCUMENT_TYPES.has(document.documentType)
  );
  if (invoices.length < 2 || !purchaseOrders.length) return null;

  const identitiesMatch = (leftName: string, leftGstin: string, rightName: string, rightGstin: string) => {
    const normalizedLeftGstin = normalizeInvoiceCopyValue(leftGstin);
    const normalizedRightGstin = normalizeInvoiceCopyValue(rightGstin);
    if (normalizedLeftGstin && normalizedRightGstin) return normalizedLeftGstin === normalizedRightGstin;
    return invoicePartyNameMatches(normalizeInvoiceCopyValue(leftName), normalizeInvoiceCopyValue(rightName));
  };
  const poBuyers = purchaseOrders.map((document) => ({
    name: getStringField(document, "buyerName"),
    gstin: getStringField(document, "buyerGstin"),
  }));
  const poVendors = purchaseOrders.map((document) => ({
    name: getStringField(document, "vendorName"),
    gstin: getStringField(document, "supplierGstin"),
  }));
  const matchesAny = (name: string, gstin: string, parties: Array<{ name: string; gstin: string }>) =>
    parties.some((party) => identitiesMatch(name, gstin, party.name, party.gstin));

  const primaryInvoices = invoices.filter((document) =>
    matchesAny(
      getStringField(document, "buyerName"),
      getStringField(document, "buyerGstin"),
      poBuyers
    )
  );
  if (!primaryInvoices.length) return null;

  const primarySuppliers = [
    ...poVendors,
    ...primaryInvoices.map((document) => ({
      name: getStringField(document, "vendorName"),
      gstin: getStringField(document, "supplierGstin"),
    })),
  ];
  const upstreamInvoices = invoices.filter((document) => {
    if (primaryInvoices.some((primary) => primary.id === document.id)) return false;
    const buyerName = getStringField(document, "buyerName");
    const buyerGstin = getStringField(document, "buyerGstin");
    return !matchesAny(buyerName, buyerGstin, poBuyers) && matchesAny(buyerName, buyerGstin, primarySuppliers);
  });
  if (!upstreamInvoices.length) return null;

  const upstreamReferences = new Set(
    upstreamInvoices
      .map((document) => normalizeInvoiceCopyValue(getStringField(document, "invoiceNumber")))
      .filter(Boolean)
  );
  const contextDocumentIds = documents
    .filter((document) => {
      if (upstreamInvoices.some((invoice) => invoice.id === document.id)) return true;
      const reference = normalizeInvoiceCopyValue(
        getStringField(document, "referenceInvoiceNumber") || getStringField(document, "invoiceNumber")
      );
      return Boolean(reference && upstreamReferences.has(reference));
    })
    .map((document) => document.id);

  return {
    primaryDocumentIds: primaryInvoices.map((document) => document.id),
    contextDocumentIds,
    note: "Seller chain identified from the purchase-order buyer and supplier relationships.",
  };
}

function invoiceDisplayText(document: CaseDetailDocument) {
  return [document.title, document.sourceHint, document.sourceFileName, document.markdown]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getInvoiceCopyPreferenceRank(document: CaseDetailDocument) {
  const text = invoiceDisplayText(document);
  if (/\b(?:original|main)\s+copy\b|\b(?:original|main)\b/.test(text)) return 0;
  if (/\b(?:duplicate|extra|copy)\b/.test(text)) return 2;
  return 1;
}

function getInvoiceDisplayCompletenessScore(document: CaseDetailDocument) {
  const fieldScore = Object.values(document.extractedFields).filter((value) => {
    if (value === null || value === undefined) return false;
    return String(value).trim().length > 0;
  }).length;
  const lineScore = (document.lineItems?.length ?? 0) * 5;
  const textScore = Math.min(8, Math.floor((document.markdown?.trim().length ?? 0) / 500));
  return fieldScore + lineScore + textScore;
}

function shouldPreferInvoiceDisplayCopy(candidate: CaseDetailDocument, current: CaseDetailDocument) {
  const candidateRank = getInvoiceCopyPreferenceRank(candidate);
  const currentRank = getInvoiceCopyPreferenceRank(current);
  if (candidateRank !== currentRank) return candidateRank < currentRank;

  const candidateScore = getInvoiceDisplayCompletenessScore(candidate);
  const currentScore = getInvoiceDisplayCompletenessScore(current);
  return candidateScore > currentScore;
}

function getDisplayDocuments(documents: CaseDetailDocument[]) {
  const displayDocuments: CaseDetailDocument[] = [];

  for (const document of documents) {
    if (!isInvoiceDocument(document)) {
      displayDocuments.push(document);
      continue;
    }

    const existingIndex = displayDocuments.findIndex((candidate) =>
      areDuplicateInvoiceDisplayCopies(candidate, document)
    );
    if (existingIndex === -1) {
      displayDocuments.push(document);
      continue;
    }

    if (shouldPreferInvoiceDisplayCopy(document, displayDocuments[existingIndex])) {
      displayDocuments[existingIndex] = document;
    }
  }

  return displayDocuments;
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}
function getDocumentIndexDetails(document: SavedCaseDetail["documents"][number]) {
  const type = document.documentType || "Document";
  const sourcePage = getDocumentSourcePage(document);
  const fileName =
    document.sourceFileName ||
    document.sourceHint?.replace(/^pages?\s+\d+\s*[-:]\s*/i, "").trim() ||
    document.title ||
    "Source file";

  return {
    type,
    fileName,
    pageLabel: `Page ${sourcePage}`,
  };
}

function parseDisplayNumber(value: unknown) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDisplayNumber(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function formatPercentDisplay(value: unknown) {
  const parsed = parseDisplayNumber(value);
  if (parsed === null) return "";
  return `${formatDisplayNumber(parsed)}%`;
}

function getLineItemValue(item: CommercialLineItem, key: keyof CommercialLineItem) {
  if (key === "rate") {
    return item.netRate || item.rate || "";
  }
  if (key === "taxAmount") {
    if (item.taxAmount) return item.taxAmount;
    if (item.igstAmount) return item.igstAmount;
    const cgstAmount = parseDisplayNumber(item.cgstAmount);
    const sgstAmount = parseDisplayNumber(item.sgstAmount);
    if (cgstAmount !== null && sgstAmount !== null) {
      return formatDisplayNumber(cgstAmount + sgstAmount);
    }
    return item.cgstAmount || item.sgstAmount || "";
  }
  if (key === "taxRate" || key === "cgstRate" || key === "sgstRate" || key === "igstRate") {
    return formatPercentDisplay(item[key]);
  }
  return item[key] ?? "";
}

function getVisibleLineItemColumns(lineItems: CommercialLineItem[]) {
  return LINE_ITEM_COLUMNS.filter(
    (column) =>
      column.key === "lineNumber" ||
      column.key === "description" ||
      lineItems.some((item) => String(getLineItemValue(item, column.key)).trim().length > 0)
  );
}

function getSourceFileLabel(mimeType?: string | null, sourceName?: string | null) {
  if (mimeType?.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "PDF";
  if (sourceName && /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(sourceName)) return "Image";
  if (sourceName && /\.pdf$/i.test(sourceName)) return "PDF";
  return "File";
}

function isImageSourceFile(mimeType?: string | null, sourceName?: string | null) {
  if (mimeType?.startsWith("image/")) return true;
  if (sourceName && /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(sourceName)) return true;
  return false;
}

function getDocumentSourcePage(document?: SavedCaseDetail["documents"][number] | null) {
  const sourceText = [document?.sourceHint, document?.sourceFileName, document?.title]
    .filter(Boolean)
    .join(" ");
  const match = sourceText.match(/\bpages?\s+(\d+)/i);
  if (!match) return 1;
  const page = Number(match[1]);
  return Number.isFinite(page) && page > 0 ? Math.round(page) : 1;
}

function getLineItemPreviewPage(
  document: SavedCaseDetail["documents"][number] | null,
  item: CommercialLineItem
) {
  const documentStartPage = getDocumentSourcePage(document);
  const itemSourcePage = Number(item.sourcePage);
  if (!Number.isFinite(itemSourcePage) || itemSourcePage < 1) return documentStartPage;

  const documentPageCount = Math.max(1, document?.pageCount || 1);
  if (itemSourcePage <= documentPageCount) {
    return documentStartPage + itemSourcePage - 1;
  }

  return Math.round(itemSourcePage);
}

function normalizeEvidenceValue(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCaseStatusLabel(status: string) {
  if (status === "draft") return "Draft";
  if (status === "accepted") return "Approved";
  if (status === "rejected") return "Rejected";
  if (status === "failed") return "Failed";
  if (status === "processing") return "Processing";
  if (status === "completed") return "Pending decision";
  return "Pending";
}

function getCaseStatusClassName(status: string) {
  if (status === "draft") return "bg-slate-100 text-slate-700 border-slate-200";
  if (status === "accepted") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "rejected") return "bg-rose-50 text-rose-700 border-rose-200";
  if (status === "failed") return "bg-red-50 text-red-700 border-red-200";
  if (status === "processing") return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-slate-50 text-slate-600 border-slate-200";
}

function getFriendlyAnalysisStage(stage: string | null, status: "idle" | "processing" | "error") {
  if (status === "error") {
    return "Analysis failed";
  }

  const normalized = (stage ?? "").trim().toLowerCase();
  if (!normalized) {
    return "Analyzing documents...";
  }
  if (normalized.includes("retry")) {
    return "Retrying analysis...";
  }
  if (normalized.includes("queue")) {
    return "Preparing analysis...";
  }
  if (/\b(file|pdf|document)\s+\d+\s+of\s+\d+\b/.test(normalized)) {
    return stage;
  }
  if (normalized.includes("split") || normalized.includes("organizing")) {
    return "Organizing PDF documents...";
  }
  if (normalized.includes("extract")) {
    return "Extracting fields...";
  }
  if (normalized.includes("compar")) {
    return "Comparing documents...";
  }
  if (normalized.includes("validat")) {
    return "Validating results...";
  }
  if (normalized.includes("final") || normalized.includes("complete")) {
    return "Finalizing results...";
  }
  return stage;
}

function CaseDetailSkeleton() {
  const useRedesignedSkeleton = true;
  if (useRedesignedSkeleton) {
    return (
      <div className={styles.redesignPage} aria-label="Loading case details" aria-busy="true">
        {/* compactHeader — mirrors CaseDetailRedesign compactHeader */}
        <header className={styles.compactHeader}>
          <div className={styles.compactHeaderLeft}>
            <Skeleton className="h-8 w-8 rounded-lg bg-[#eee7dd] shrink-0" />
            <div className={styles.compactInfo}>
              <div className={styles.compactTitleRow}>
                <Skeleton className="h-5 w-48 bg-[#eee7dd] rounded" />
                <Skeleton className="h-5 w-20 rounded-full bg-[#eee7dd]" />
              </div>
              <div className={styles.compactMetaRow}>
                <Skeleton className="h-3 w-28 bg-[#eee7dd]" />
                <span className="hidden sm:block h-3 w-px bg-[#e8e2db]" />
                <Skeleton className="h-3 w-32 bg-[#eee7dd]" />
                <Skeleton className="hidden sm:block h-3 w-24 bg-[#eee7dd]" />
              </div>
            </div>
          </div>
          <div className={styles.compactHeaderRight}>
            <nav className={styles.compactTabs} aria-hidden="true">
              <Skeleton className="h-4 w-16 bg-[#eee7dd] rounded" />
              <Skeleton className="h-4 w-20 bg-[#eee7dd] rounded" />
              <Skeleton className="h-4 w-14 bg-[#eee7dd] rounded" />
            </nav>
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-24 rounded-lg bg-[#eee7dd]" />
              <Skeleton className="h-8 w-20 rounded-lg bg-[#eee7dd]" />
              <Skeleton className="h-8 w-20 rounded-lg bg-[#eee7dd]" />
            </div>
          </div>
        </header>

        {/* topDocumentStrip — 10-up grid, responsive scroll under 1280 */}
        <section className={styles.topDocumentStrip} aria-hidden="true">
          {Array.from({ length: 10 }).map((_, index) => (
            <div key={index} className={`${styles.topDocCard} ${index === 0 ? styles.topDocCardActive : ""} opacity-60`}>
              <div className={styles.topDocCardHeader}>
                <Skeleton className="h-[18px] w-[18px] rounded-[4px] bg-[#eee7dd]" />
                <Skeleton className="h-1.5 w-1.5 rounded-full bg-[#eee7dd]" />
              </div>
              <Skeleton className="h-3 w-20 bg-[#eee7dd] rounded" />
              <Skeleton className="mt-1.5 h-2.5 w-16 bg-[#eee7dd] rounded" />
            </div>
          ))}
        </section>

        {/* splitWorkspace — left preview + right data, exact grid as real */}
        <section className={styles.splitWorkspace} aria-hidden="true">
          <div className={styles.splitPreviewPane}>
            <div className={styles.splitPreviewHeader}>
              <div className={styles.splitDocTitleBlock}>
                <Skeleton className="h-4 w-20 bg-[#eee7dd] rounded" />
                <Skeleton className="h-3 w-28 bg-[#eee7dd] rounded" />
                <Skeleton className="h-3 w-12 bg-[#eee7dd] rounded" />
              </div>
              <div className={styles.splitPreviewControls}>
                <Skeleton className="h-6 w-28 rounded-full bg-[#eee7dd]" />
                <Skeleton className="h-7 w-20 rounded-md bg-[#eee7dd]" />
                <Skeleton className="h-7 w-20 rounded-md bg-[#eee7dd]" />
              </div>
            </div>
            <div className={styles.splitPreviewStage}>
              <div className="w-[min(760px,68vw)] max-w-[68vw] rounded-[6px] border border-[#ded8d0] bg-white p-6 shadow-[0_10px_25px_-10px_rgba(43,26,16,0.2)]">
                <Skeleton className="h-5 w-2/3 bg-[#eee7dd]" />
                <Skeleton className="mt-2 h-3 w-1/2 bg-[#eee7dd]" />
                <Skeleton className="mt-6 h-px w-full bg-[#e8e2db]" />
                <div className="mt-6 space-y-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-3 w-full bg-[#eee7dd]" />
                  ))}
                </div>
                <div className="mt-6 grid grid-cols-2 gap-4">
                  <Skeleton className="h-16 rounded-md bg-[#f3eee7]" />
                  <Skeleton className="h-16 rounded-md bg-[#f3eee7]" />
                </div>
              </div>
            </div>
          </div>
          <div className={styles.splitDataPane}>
            <div className={styles.splitDataHeader}>
              <Skeleton className="h-4 w-32 bg-[#eee7dd] rounded" />
              <Skeleton className="mt-1 h-3 w-20 bg-[#eee7dd] rounded" />
              <div className="mt-3 flex gap-4">
                <Skeleton className="h-3 w-16 bg-[#eee7dd] rounded" />
                <Skeleton className="h-3 w-20 bg-[#eee7dd] rounded" />
                <Skeleton className="h-3 w-16 bg-[#eee7dd] rounded" />
              </div>
            </div>
            <div className={styles.splitDataScroll}>
              {Array.from({ length: 3 }).map((_, sec) => (
                <div key={sec} className={styles.splitSection}>
                  <Skeleton className="mb-2 h-2.5 w-20 bg-[#eee7dd] rounded" />
                  <div className={styles.splitFieldList}>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className={styles.splitFieldItem}>
                        <Skeleton className="h-2.5 w-16 bg-[#eee7dd]" />
                        <Skeleton className="mt-1.5 h-3.5 w-24 bg-[#eee7dd]" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    );
  }
  return (
    <div className={styles.page} aria-label="Loading case details" aria-busy="true">
      <header className={styles.header}>
        <Skeleton className="h-7 w-7 shrink-0 rounded-md bg-slate-100" />
        <div className={styles.breadcrumb}>
          <Skeleton className="h-3.5 w-44 bg-slate-100" />
          <span className={styles.breadcrumbSeparator}>/</span>
          <Skeleton className="h-3.5 w-36 bg-slate-100" />
        </div>
        <div className={styles.headerSpacer} />
        <Skeleton className="hidden h-3.5 w-48 bg-slate-100 lg:block" />
        <Skeleton className="h-6 w-20 rounded-full bg-rose-50" />
      </header>

      <div className={`${styles.reviewBar} ${styles.reviewBarRed}`}>
        <span className={styles.severityDot} />
        <div className={styles.reviewCopy}>
          <Skeleton className="h-3.5 w-48 bg-slate-100" />
          <Skeleton className="mt-1.5 h-2.5 w-80 max-w-[52vw] bg-slate-100" />
        </div>
        <Skeleton className="h-3 w-12 bg-slate-100" />
        <Skeleton className="h-7 w-36 rounded-md bg-slate-200" />
      </div>

      <section className={styles.packetStrip} aria-label="Loading documents in packet">
        <div className={styles.packetStripLabel}>
          Documents in packet <span>· 5</span>
        </div>
        <div className={styles.packetCards}>
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className={`${styles.packetCard} ${styles.skeletonPacketCard} ${index === 0 ? styles.packetCardActive : ""}`}
            >
              <span className={styles.packetCardTopline}>
                <Skeleton className="h-4 w-12 rounded bg-slate-100" />
                <Skeleton className="ml-auto h-1.5 w-1.5 rounded-full bg-slate-200" />
              </span>
              <Skeleton className="mt-2 h-3.5 w-28 bg-slate-100" />
              <Skeleton className="mt-2 h-2.5 w-20 bg-slate-100" />
            </div>
          ))}
        </div>
      </section>

      <div className={styles.mobileControls} aria-hidden="true">
        <Skeleton className="h-8 flex-1 rounded-md bg-slate-100" />
        <Skeleton className="h-8 flex-1 rounded-md bg-slate-100" />
      </div>
      <div className={styles.mobileDocuments} aria-hidden="true">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-12 min-w-32 rounded-md bg-slate-100" />
        ))}
      </div>

      <div
        className={`${styles.workspace} ${styles.desktopWorkspace}`}
        style={{ "--data-pane-width": `${DEFAULT_DATA_PANE_WIDTH}px` } as CSSProperties}
      >
        <main className={styles.viewerPane}>
          <div className={styles.viewerToolbar}>
            <Skeleton className="h-3.5 w-24 bg-slate-100" />
            <Skeleton className="h-3 w-20 bg-slate-100" />
            <span className={styles.toolbarDivider} />
            <Skeleton className="h-5 w-20 bg-slate-100" />
            <div className={styles.zoomControls}>
              <Skeleton className="h-5 w-28 bg-slate-100" />
            </div>
          </div>
          <div className={styles.viewerCanvas}>
            <div className={styles.skeletonPreviewStage}>
              <div className={styles.skeletonPdfPage}>
                <div className={styles.skeletonPdfHeader}>
                  <div className="space-y-2">
                    <Skeleton className="h-6 w-56 bg-slate-100" />
                    <Skeleton className="h-2.5 w-48 bg-slate-100" />
                    <Skeleton className="h-2.5 w-36 bg-slate-100" />
                  </div>
                  <div className="flex flex-col items-end space-y-2">
                    <Skeleton className="h-5 w-40 bg-slate-100" />
                    <Skeleton className="h-2.5 w-32 bg-slate-100" />
                    <Skeleton className="h-2.5 w-24 bg-slate-100" />
                  </div>
                </div>
                <div className={styles.skeletonPdfRule} />
                <div className={styles.skeletonPdfPanel}>
                  <div className="space-y-2">
                    <Skeleton className="h-2.5 w-14 bg-slate-200" />
                    <Skeleton className="h-3.5 w-40 bg-slate-200" />
                    <Skeleton className="h-2.5 w-48 bg-slate-200" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-2.5 w-14 bg-slate-200" />
                    <Skeleton className="h-3.5 w-40 bg-slate-200" />
                    <Skeleton className="h-2.5 w-44 bg-slate-200" />
                  </div>
                </div>
                <div className={styles.skeletonPdfTable}>
                  <div className={styles.skeletonPdfTableHead} />
                  {Array.from({ length: 6 }).map((_, index) => (
                    <div key={index} className={styles.skeletonPdfTableRow}>
                      <Skeleton className="h-2.5 w-36 bg-slate-100" />
                      <Skeleton className="h-2.5 w-16 bg-slate-100" />
                      <Skeleton className="h-2.5 w-10 bg-slate-100" />
                      <Skeleton className="h-2.5 w-20 bg-slate-100" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </main>

        <div className={styles.paneResizeHandle} aria-hidden="true">
          <GripVertical />
        </div>

        <aside className={styles.dataPane} aria-label="Loading extracted document data">
          <div className={styles.dataTabs}>
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className={`${styles.dataTab} ${index === 0 ? styles.dataTabActive : ""}`}>
                <Skeleton className={`h-3 bg-slate-100 ${index === 1 ? "w-16" : "w-12"}`} />
                <Skeleton className="h-2.5 w-3 bg-slate-100" />
              </div>
            ))}
          </div>
          <div className={styles.dataBody}>
            <div className={styles.dataHint}>
              <Skeleton className="h-3.5 w-3.5 rounded-full bg-slate-100" />
              <Skeleton className="h-2.5 w-56 max-w-[80%] bg-slate-100" />
            </div>
            <div className={styles.dataGroupLabel}>
              <Skeleton className="h-2.5 w-28 bg-slate-100" />
            </div>
            {Array.from({ length: 9 }).map((_, index) => (
              <div key={index} className={styles.fieldRow}>
                <Skeleton className={`h-2.5 bg-slate-100 ${index % 3 === 0 ? "w-24" : "w-32"}`} />
                <Skeleton className={`mt-2 h-3 bg-slate-100 ${index % 2 === 0 ? "w-44" : "w-52"}`} />
              </div>
            ))}
          </div>
        </aside>
      </div>

      <div className={`${styles.workspace} ${styles.legacyMobileWorkspace}`} aria-hidden="true">
        <main className={styles.viewerPane}>
          <div className={styles.viewerToolbar}>
            <Skeleton className="h-3.5 w-24 bg-slate-100" />
            <Skeleton className="h-3 w-20 bg-slate-100" />
            <div className={styles.zoomControls}>
              <Skeleton className="h-5 w-20 bg-slate-100" />
            </div>
          </div>
          <div className={styles.viewerCanvas}>
            <div className={styles.skeletonPreviewStage}>
              <div className={styles.skeletonPdfPage} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export function CaseDetailPage({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<SavedCaseDetail | null>(null);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "processing" | "error">("idle");
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisStage, setAnalysisStage] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisOptionsOpen, setAnalysisOptionsOpen] = useState(false);
  const [pendingAnalysisMode, setPendingAnalysisMode] = useState<CaseAnalysisMode>("standard");
  const [draftFileStatus, setDraftFileStatus] = useState<"idle" | "saving" | "error">("idle");
  const [draftFileError, setDraftFileError] = useState<string | null>(null);
  const [decisionStatus, setDecisionStatus] = useState<"idle" | "updating" | "error">("idle");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [isMismatchNavigationPending, setIsMismatchNavigationPending] = useState(false);
  const [isTallyReviewOpen, setIsTallyReviewOpen] = useState(false);

  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("preview");
  const [activeDataView, setActiveDataView] = useState<DataViewMode>("fields");
  const [previewPageIndex, setPreviewPageIndex] = useState(0);
  const [previewZoom, setPreviewZoom] = useState(DEFAULT_PREVIEW_ZOOM);
  const [previewFocus, setPreviewFocus] = useState<PreviewFocus | null>(null);
  const [previewPdfPage, setPreviewPdfPage] = useState<number | null>(null);
  const [previewPdfPageCount, setPreviewPdfPageCount] = useState(1);
  const [documentFieldComparison, setDocumentFieldComparison] =
    useState<DocumentFieldComparison>(null);
  const [dataPaneWidth, setDataPaneWidth] = useState(DEFAULT_DATA_PANE_WIDTH);
  const [isPaneResizing, setIsPaneResizing] = useState(false);
  const [signedFileUrls, setSignedFileUrls] = useState<Record<string, string | null>>({});
  const protectedPreviews = useRef(new Set<string>());
  useEffect(() => {
    const reset = () => {
      for (const url of protectedPreviews.current) releaseProtectedPreview(url);
      protectedPreviews.current.clear();
      setSignedFileUrls({});
    };
    window.addEventListener('kalika-access-invalidated', reset);
    reset();
    return () => {
      window.removeEventListener('kalika-access-invalidated', reset);
      for (const url of protectedPreviews.current) releaseProtectedPreview(url);
      protectedPreviews.current.clear();
    };
  }, [caseId]);
  const [loadingPreviewFileId, setLoadingPreviewFileId] = useState<string | null>(null);
  const [previewUrlError, setPreviewUrlError] = useState<string | null>(null);
  const draftFileInputRef = useRef<HTMLInputElement | null>(null);
  const desktopWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const paneResizeStartRef = useRef<{ pointerX: number; paneWidth: number } | null>(null);

  useEffect(() => {
    let active = true;

    fetchCaseDetailPreferCache(caseId)
      .then((payload) => {
        if (!active) return;
        setDetail(payload);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load case details.");
        setStatus("error");
      });

    return () => {
      active = false;
    };
  }, [caseId]);

  useEffect(() => {
    setSignedFileUrls({});
    setLoadingPreviewFileId(null);
    setPreviewUrlError(null);
    setDataPaneWidth(DEFAULT_DATA_PANE_WIDTH);
    setDocumentFieldComparison(null);
  }, [caseId]);

  useEffect(() => {
    if (!documentFieldComparison) return;

    const clearComparisonWhenClickingOutside = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-document-comparison-trigger]")?.getAttribute("data-document-comparison-trigger") ===
          documentFieldComparison.key
      ) {
        return;
      }

      setDocumentFieldComparison(null);
    };

    document.addEventListener("pointerdown", clearComparisonWhenClickingOutside);
    return () => document.removeEventListener("pointerdown", clearComparisonWhenClickingOutside);
  }, [documentFieldComparison]);

  useEffect(() => {
    const workspace = desktopWorkspaceRef.current;
    if (!workspace) return;

    const observer = new ResizeObserver(([entry]) => {
      const workspaceWidth = entry?.contentRect.width || workspace.clientWidth;
      const maximumWidth = Math.max(
        MIN_DATA_PANE_WIDTH,
        workspaceWidth - MIN_PREVIEW_PANE_WIDTH - 8
      );
      setDataPaneWidth((current) => Math.min(current, maximumWidth));
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [status]);

  const displayDocuments = useMemo(
    () => (detail ? getDisplayDocuments(detail.documents) : []),
    [detail]
  );

  useEffect(() => {
    if (!detail) return;
    setActiveDocumentId((current) => {
      if (current && displayDocuments.some((document) => document.id === current)) {
        return current;
      }
      return displayDocuments[0]?.id ?? detail.documents[0]?.id ?? null;
    });
  }, [detail, displayDocuments]);

  useEffect(() => {
    if (!detail || detail.case.status !== "processing") {
      return;
    }

    let active = true;

    const pollStatus = async () => {
      try {
        const nextStatus = await fetchCaseAnalysisStatus(detail.case.id);
        if (!active) return;

        setAnalysisStatus("processing");
        setAnalysisProgress(nextStatus.job?.progress ?? 0);
        setAnalysisStage(nextStatus.job?.stage ?? null);
        setAnalysisError(nextStatus.job?.status === "failed" ? nextStatus.job.error ?? null : null);

        if (nextStatus.caseStatus === "completed" || nextStatus.caseStatus === "accepted" || nextStatus.caseStatus === "rejected") {
          const refreshed = await fetchCaseDetail(detail.case.id);
          if (!active) return;
          setDetail(refreshed);
          setAnalysisStatus("idle");
          setAnalysisProgress(100);
          setAnalysisStage(null);
          setAnalysisError(null);
          return;
        }

        if (nextStatus.caseStatus === "failed") {
          const refreshed = await fetchCaseDetail(detail.case.id);
          if (!active) return;
          setDetail(refreshed);
          setAnalysisStatus("error");
          setAnalysisError(nextStatus.job?.error ?? "Case analysis failed.");
          setAnalysisStage(nextStatus.job?.stage ?? "Failed");
        }
      } catch (statusError) {
        if (!active) return;
        setAnalysisStatus("error");
        setAnalysisError(
          statusError instanceof Error ? statusError.message : "Failed to load analysis progress."
        );
      }
    };

    void pollStatus();
    const intervalId = window.setInterval(() => {
      void pollStatus();
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [detail, detail?.case.id, detail?.case.status]);

  const fileLookup = useMemo(() => {
    const map = new Map<string, SavedCaseDetail["files"][number]>();
    detail?.files.forEach((file) => {
      map.set(normalizeText(file.originalName), file);
    });
    return map;
  }, [detail]);

  const uploadGroups = useMemo(
    () =>
      readUploadGroupMeta(
        detail?.case.processingMeta && typeof detail.case.processingMeta === "object"
          ? (detail.case.processingMeta as Record<string, unknown>).uploadGroups
          : undefined
      ),
    [detail]
  );

  const activeDocument = useMemo(() => {
    if (!detail || !activeDocumentId) return null;
    return (
      detail.documents.find((document) => document.id === activeDocumentId) ??
      displayDocuments[0] ??
      null
    );
  }, [detail, activeDocumentId, displayDocuments]);

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
  const pendingMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "pending"
  ).length;
  const rejectedMismatchCount = visibleMismatches.filter(
    (mismatch) => mismatch.resolutionStatus === "rejected"
  ).length;
  const mismatchReviewHref = `/cases/${caseId}/mismatches`;

  useEffect(() => {
    if (status !== "ready" || visibleMismatches.length === 0) return;
    router.prefetch(mismatchReviewHref);
  }, [mismatchReviewHref, router, status, visibleMismatches.length]);

  function prepareMismatchNavigation() {
    router.prefetch(mismatchReviewHref);
  }

  function beginMismatchNavigation() {
    setIsMismatchNavigationPending(true);
    prepareMismatchNavigation();
  }

  const reviewSummary = useMemo(() => {
    if (!detail) {
      return null;
    }

    const documentLabel = `${detail.documents.length} document${detail.documents.length === 1 ? "" : "s"}`;
    const documentLabels = getPacketDocumentLabels(detail.documents);
    const missingDocumentLabels = getMissingPacketDocumentLabels(detail.documents);
    const docsFact =
      documentLabels.length > 0
        ? `${detail.documents.length} ${detail.documents.length === 1 ? "document" : "documents"}`
        : "No extracted docs";
    const facts = [
      { label: "Docs", value: docsFact },
      { label: "Receiver", value: detail.case.receiverName || "-" },
    ];

    if (detail.case.status === "processing") {
      return {
        tone: "amber" as const,
        title: "Processing",
        description: `Checking ${documentLabel}.`,
        actionHint: "Wait for extraction and reconciliation to finish.",
        buttonLabel: null,
        action: null,
        badgeLabel: "Running",
        showConfidence: false,
        showBadge: true,
        facts,
      };
    }

    if (detail.case.status === "failed") {
      return {
        tone: "rose" as const,
        title: "Failed",
        description: "Could not complete analysis.",
        actionHint: "Retry analysis after checking the uploaded files.",
        buttonLabel: "Retry Analysis",
        action: "retry" as const,
        badgeLabel: "Failed",
        showConfidence: false,
        showBadge: true,
        facts,
      };
    }

    if (detail.case.status === "accepted") {
      return {
        tone: "emerald" as const,
        title: "Approved",
        description:
          visibleMismatches.length === 0
            ? `${documentLabel} verified. No pending action.`
            : `${visibleMismatches.length} reviewed issue${visibleMismatches.length === 1 ? "" : "s"} accepted.`,
        actionHint: "This case is cleared.",
        buttonLabel:
          visibleMismatches.length > 0
            ? `View ${visibleMismatches.length} Reviewed Issue${visibleMismatches.length === 1 ? "" : "s"}`
            : null,
        action: visibleMismatches.length > 0 ? "review" as const : null,
        badgeLabel: "Accepted",
        showConfidence: false,
        showBadge: false,
        facts,
      };
    }

    if (detail.case.status === "rejected") {
      return {
        tone: "rose" as const,
        title: "Blocked",
        description:
          rejectedMismatchCount > 0
            ? `${rejectedMismatchCount} rejected issue${rejectedMismatchCount === 1 ? "" : "s"} blocked this case.`
            : `Rejected after review across ${documentLabel}.`,
        actionHint: "Open the review trail before taking further action.",
        buttonLabel:
          visibleMismatches.length > 0
            ? `View ${visibleMismatches.length} Reviewed Issue${visibleMismatches.length === 1 ? "" : "s"}`
            : null,
        action: visibleMismatches.length > 0 ? "review" as const : null,
        badgeLabel: "Rejected",
        showConfidence: false,
        showBadge: false,
        facts,
      };
    }

    if (missingDocumentLabels.length > 0 && visibleMismatches.length === 0) {
      return {
        tone: "amber" as const,
        title: "Missing Documents",
        description: `Missing ${missingDocumentLabels.join(", ")} from this packet.`,
        actionHint: "Upload the missing document before approving.",
        buttonLabel: null,
        action: null,
        badgeLabel: "Incomplete",
        showConfidence: false,
        showBadge: true,
        facts: [{ label: "Missing", value: missingDocumentLabels.join(", ") }, ...facts],
      };
    }

    if (visibleMismatches.length === 0) {
      return {
        tone: "emerald" as const,
        title: "Ready to Approve",
        description: `${documentLabel} matched. No issues found.`,
        actionHint: "Approve this case and move on.",
        buttonLabel: "Approve Case",
        action: "approve" as const,
        badgeLabel: "Clear",
        showConfidence: false,
        showBadge: false,
        facts,
      };
    }

    if (pendingMismatchCount < visibleMismatches.length) {
      return {
        tone: "amber" as const,
        title: "Review In Progress",
        description: `${pendingMismatchCount} of ${visibleMismatches.length} issue${visibleMismatches.length === 1 ? "" : "s"} still need review.`,
        actionHint: "Finish the remaining decisions.",
        buttonLabel: `Review ${pendingMismatchCount} Pending Issue${pendingMismatchCount === 1 ? "" : "s"}`,
        action: "review" as const,
        badgeLabel: "Pending",
        showConfidence: false,
        showBadge: true,
        facts,
      };
    }

    return {
      tone: "rose" as const,
      title: "Needs Review",
      description: `${visibleMismatches.length} issue${visibleMismatches.length === 1 ? "" : "s"} found across ${documentLabel}.`,
      actionHint: "Review the mismatches before accepting.",
      buttonLabel: `Review ${visibleMismatches.length} Issue${visibleMismatches.length === 1 ? "" : "s"}`,
      action: "review" as const,
      badgeLabel: "Needs review",
      showConfidence: false,
      showBadge: false,
      facts,
    };
  }, [detail, pendingMismatchCount, rejectedMismatchCount, visibleMismatches.length]);

  const activeDocumentEntries = useMemo(() => {
    if (!activeDocument) return [];
    return getOrderedDocumentEntries(activeDocument.documentType, activeDocument.extractedFields);
  }, [activeDocument]);
  const activeTermsIssues = useMemo(() => {
    if (!detail) return [];
    return detail.mismatches.filter((mismatch) =>
      termsIssueMatchesDocument(mismatch, activeDocument)
    );
  }, [activeDocument, detail]);
  const caseTermsChecklist = useMemo(
    () => readTermsComplianceChecklist(detail?.case.processingMeta),
    [detail?.case.processingMeta]
  );
  const activeTermsChecklistRows = useMemo(() => {
    if (!activeDocument || !PURCHASE_ORDER_DOCUMENT_TYPES.has(activeDocument.documentType)) {
      return [];
    }

    const documentIds = new Set(
      [activeDocument.id, activeDocument.clientDocumentId, activeDocument.sourceHint, activeDocument.title]
        .filter((value): value is string => Boolean(value))
    );
    const assessedRows = caseTermsChecklist.filter((item) => documentIds.has(item.sourceDocId));
    if (assessedRows.length > 0) {
      return assessedRows.map((item, index) => ({
        key: `assessed-${item.sourceDocId}-${index}`,
        label: item.category || "Terms",
        value: item.sourceClause,
        detail: item.obligation,
        evidence: item.evidence || item.reason,
        issue: activeTermsIssues.find((mismatch) => getTermsIssueText(mismatch).includes(item.obligation)),
        status: getChecklistStatus(item.status),
      }));
    }

    return TERMS_CHECKLIST_DEFINITIONS.flatMap((definition) => {
      const value = getTermValue(activeDocument.extractedFields[definition.key]);
      if (!value) return [];

      const issue = activeTermsIssues.find((mismatch) =>
        termsIssueMatchesDefinition(mismatch, definition, value)
      );

      return [
        {
          key: definition.key,
          label: definition.label,
          value,
          detail: "",
          evidence: "",
          issue,
          status: issue ? getTermsIssueStatus(issue) : getClearTermsStatus(),
        },
      ];
    });
  }, [activeDocument, activeTermsIssues, caseTermsChecklist]);
  const unmatchedTermsIssues = useMemo(
    () =>
      activeTermsIssues.filter(
        (issue) => !activeTermsChecklistRows.some((row) => row.issue?.id === issue.id)
      ),
    [activeTermsChecklistRows, activeTermsIssues]
  );
  const activeDocumentFieldEntries = useMemo(() => {
    if (activeTermsChecklistRows.length === 0) {
      return activeDocumentEntries;
    }

    return activeDocumentEntries.filter(([key]) => !TERMS_FIELD_KEY_SET.has(key));
  }, [activeDocumentEntries, activeTermsChecklistRows.length]);
  const activeFieldDataCount =
    activeDocumentFieldEntries.length + activeTermsChecklistRows.length + unmatchedTermsIssues.length;
  const activeDocumentLineItems = useMemo(
    () => activeDocument?.lineItems ?? [],
    [activeDocument]
  );
  const activeDocumentLineItemColumns = useMemo(
    () => getVisibleLineItemColumns(activeDocumentLineItems),
    [activeDocumentLineItems]
  );

  useEffect(() => {
    setActiveDataView("fields");
  }, [activeDocumentId]);

  const activeDocumentFiles = useMemo(() => {
    if (!detail || !activeDocument) return [];

    const candidates = [activeDocument.sourceFileName, activeDocument.sourceHint]
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeText(value));

    const matchedUploadGroup = uploadGroups.find((group) => {
      const normalizedGroupName = normalizeText(group.name);
      const normalizedPrimaryFileName = normalizeText(group.primaryFileName || "");
      const normalizedFileNames = group.fileNames.map((fileName) => normalizeText(fileName));

      return candidates.some(
        (candidate) =>
          candidate === normalizedGroupName ||
          candidate === normalizedPrimaryFileName ||
          normalizedFileNames.includes(candidate)
      );
    });

    if (matchedUploadGroup) {
      const groupFiles = matchedUploadGroup.fileNames
        .map((fileName) => fileLookup.get(normalizeText(fileName)))
        .filter((file): file is SavedCaseDetail["files"][number] => Boolean(file));

      if (groupFiles.length) {
        return groupFiles;
      }
    }

    for (const candidate of candidates) {
      const exactMatch = fileLookup.get(candidate);
      if (exactMatch) return [exactMatch];
    }

    const partialMatch = detail.files.find((file) =>
      candidates.some((candidate) => normalizeText(file.originalName).includes(candidate))
    );

    if (partialMatch) return [partialMatch];
    return detail.files.length === 1 ? [detail.files[0]] : [];
  }, [activeDocument, detail, fileLookup, uploadGroups]);

  const activePreviewFile =
    activeDocumentFiles[previewPageIndex] ?? activeDocumentFiles[0] ?? null;
  const activeFileUrl = activePreviewFile
    ? signedFileUrls[activePreviewFile.id] ?? activePreviewFile.signedUrl ?? null
    : null;
  const isPreviewUrlLoading =
    Boolean(activePreviewFile) && loadingPreviewFileId === activePreviewFile?.id;
  const previewPageCount = activeDocumentFiles.length || activeDocument?.pageCount || 1;
  const activeSourceLabel = getSourceFileLabel(
    activePreviewFile?.mimeType,
    activePreviewFile?.originalName || activeDocument?.sourceFileName
  );
  const activeSourceIsImage = isImageSourceFile(
    activePreviewFile?.mimeType,
    activePreviewFile?.originalName || activeDocument?.sourceFileName || activeDocument?.sourceHint
  );
  const activeDocumentSourcePage = getDocumentSourcePage(activeDocument);
  const inferredPdfPageCount = useMemo(() => {
    const activeSourceName = normalizeText(
      activeDocument?.sourceFileName || activeDocument?.sourceHint || ""
    );
    const activeDocumentPageEnd =
      activeDocumentSourcePage + Math.max(1, activeDocument?.pageCount || 1) - 1;

    if (!activeSourceName) return activeDocumentPageEnd;

    return displayDocuments.reduce((highestPage, document) => {
      const documentSourceName = normalizeText(
        document.sourceFileName || document.sourceHint || ""
      );
      if (documentSourceName !== activeSourceName) return highestPage;

      return Math.max(
        highestPage,
        getDocumentSourcePage(document) + Math.max(1, document.pageCount || 1) - 1
      );
    }, activeDocumentPageEnd);
  }, [activeDocument, activeDocumentSourcePage, displayDocuments]);
  const activePdfPage = Math.min(
    Math.max(1, previewPdfPage ?? activeDocumentSourcePage),
    Math.max(1, previewPdfPageCount, inferredPdfPageCount)
  );
  const canGoToPreviousPreviewPage = activeSourceIsImage
    ? previewPageIndex > 0
    : activePdfPage > 1;
  const canGoToNextPreviewPage =
    activeSourceIsImage
      ? activeDocumentFiles.length > 0 && previewPageIndex < activeDocumentFiles.length - 1
      : activePdfPage < previewPdfPageCount;
  const canZoomOut = Boolean(activeFileUrl) && previewZoom > 0.75;
  const canZoomIn = Boolean(activeFileUrl) && previewZoom < 3;

  useEffect(() => {
    setPreviewPageIndex(0);
    setPreviewZoom(DEFAULT_PREVIEW_ZOOM);
    setPreviewFocus(null);
    setPreviewPdfPage(activeDocumentSourcePage);
    setPreviewPdfPageCount(inferredPdfPageCount);
  }, [activeDocumentId, activeDocumentSourcePage, inferredPdfPageCount]);

  useEffect(() => {
    setPreviewPageIndex((current) => Math.min(current, Math.max(activeDocumentFiles.length - 1, 0)));
  }, [activeDocumentFiles.length]);

  useEffect(() => {
    setPreviewZoom(DEFAULT_PREVIEW_ZOOM);
  }, [previewPageIndex]);

  useEffect(() => {
    if (!detail || !activePreviewFile) {
      return;
    }

    if (
      activePreviewFile.signedUrl ||
      Object.prototype.hasOwnProperty.call(signedFileUrls, activePreviewFile.id)
    ) {
      return;
    }

    let active = true;
    setLoadingPreviewFileId(activePreviewFile.id);
    setPreviewUrlError(null);

    fetchCaseFileSignedUrlPreferCache(detail.case.id, activePreviewFile.id)
      .then((payload) => {
        if (!active) { releaseProtectedPreview(payload.signedUrl); return; }
        if (payload.signedUrl.startsWith('blob:')) protectedPreviews.current.add(payload.signedUrl);
        setSignedFileUrls((current) => ({
          ...current,
          [payload.fileId]: payload.signedUrl,
        }));
      })
      .catch((loadError) => {
        if (!active) return;
        setPreviewUrlError(
          loadError instanceof Error ? loadError.message : "Failed to load source preview."
        );
        setSignedFileUrls((current) => ({
          ...current,
          [activePreviewFile.id]: null,
        }));
      })
      .finally(() => {
        if (!active) return;
        setLoadingPreviewFileId((current) =>
          current === activePreviewFile.id ? null : current
        );
      });

    return () => {
      active = false;
    };
  }, [activePreviewFile, detail, signedFileUrls]);

  const comparisonOptions = useMemo(
    () =>
      readComparisonOptions(
        detail?.case.processingMeta && typeof detail.case.processingMeta === "object"
          ? (detail.case.processingMeta as Record<string, unknown>).comparisonOptions
          : undefined
      ),
    [detail]
  );

  async function handleAnalyzeDraftCase(
    comparisonOptions: ComparisonOptions,
    analysisMode: CaseAnalysisMode = "standard"
  ) {
    if (!detail || detail.files.length === 0 || draftFileStatus === "saving") return;

    try {
      setAnalysisStatus("processing");
      setAnalysisError(null);
      setAnalysisProgress(0);
      setAnalysisStage(analysisMode === "smart_split" ? "Queued for multi-PDF document analysis" : "Queued for analysis");
      const started = await enqueueCaseAnalysis(detail.case.id, {
        analysisMode,
        comparisonOptions,
      });
      setDetail((current) =>
        current
          ? {
              ...current,
              case: {
                ...current.case,
                ...started.case,
              },
            }
          : current
      );
    } catch (analysisFailure) {
      setAnalysisError(
        analysisFailure instanceof Error ? analysisFailure.message : "Failed to analyze this case."
      );
      setAnalysisStatus("error");
    }
  }

  async function handleDraftFileInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (!detail || selectedFiles.length === 0) {
      return;
    }

    try {
      setDraftFileStatus("saving");
      setDraftFileError(null);
      await appendCaseFiles(detail.case.id, buildDraftUploads(selectedFiles));
      const refreshed = await fetchCaseDetail(detail.case.id);
      setDetail(refreshed);
      setDraftFileStatus("idle");
    } catch (appendError) {
      setDraftFileStatus("error");
      setDraftFileError(
        appendError instanceof Error ? appendError.message : "Failed to add files to case."
      );
    }
  }

  async function handleCaseDecision(decision: CaseDecision) {
    if (!detail) return;

    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      const updated = await updateCaseDecision(detail.case.id, decision);
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
      setDecisionStatus("idle");
    } catch (decisionFailure) {
      setDecisionError(
        decisionFailure instanceof Error
          ? decisionFailure.message
          : `Failed to ${decision === "accepted" ? "accept" : "reject"} case.`
      );
      setDecisionStatus("error");
    }
  }

  function handleDocumentSelection(documentId: string) {
    const selectedDocument = displayDocuments.find((document) => document.id === documentId);
    setActiveDocumentId(documentId);
    setPreviewPdfPage(getDocumentSourcePage(selectedDocument));
    setActiveTab("preview");
  }

  function handlePreviewFocus(nextFocus: PreviewFocus) {
    setPreviewFocus(nextFocus);
    if (nextFocus.pageNumber && nextFocus.pageNumber > 0) {
      setPreviewPdfPage(nextFocus.pageNumber);
    }
    setActiveTab("preview");
  }

  function getDataPaneWidthBounds() {
    const workspaceWidth = desktopWorkspaceRef.current?.clientWidth || 0;
    return {
      min: MIN_DATA_PANE_WIDTH,
      max: Math.max(
        MIN_DATA_PANE_WIDTH,
        workspaceWidth > 0
          ? workspaceWidth - MIN_PREVIEW_PANE_WIDTH - 8
          : DEFAULT_DATA_PANE_WIDTH
      ),
    };
  }

  function resizeDataPane(nextWidth: number) {
    const bounds = getDataPaneWidthBounds();
    setDataPaneWidth(Math.min(bounds.max, Math.max(bounds.min, Math.round(nextWidth))));
  }

  function handlePaneResizeStart(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    paneResizeStartRef.current = { pointerX: event.clientX, paneWidth: dataPaneWidth };
    setIsPaneResizing(true);
  }

  function handlePaneResizeMove(event: React.PointerEvent<HTMLButtonElement>) {
    const resizeStart = paneResizeStartRef.current;
    if (!resizeStart) return;
    resizeDataPane(resizeStart.paneWidth + resizeStart.pointerX - event.clientX);
  }

  function handlePaneResizeEnd(event: React.PointerEvent<HTMLButtonElement>) {
    if (!paneResizeStartRef.current) return;
    paneResizeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsPaneResizing(false);
  }

  function handlePaneResizeKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeDataPane(dataPaneWidth + PANE_RESIZE_STEP);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeDataPane(dataPaneWidth - PANE_RESIZE_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      resizeDataPane(MIN_DATA_PANE_WIDTH);
    } else if (event.key === "Enter") {
      event.preventDefault();
      resizeDataPane(DEFAULT_DATA_PANE_WIDTH);
    }
  }

  const isFinalDecision = detail?.case.status === "accepted" || detail?.case.status === "rejected";

  if (status === "loading") {
    return (
      <AppShell defaultSidebarCollapsed>
        <CaseDetailSkeleton />
      </AppShell>
    );
  }

  if (status === "error") {
    return (
      <AppShell defaultSidebarCollapsed>
        <div className="flex flex-1 items-center justify-center bg-slate-50/50 p-6 min-h-[calc(100vh-4rem)] tracking-normal">
          <div className="w-full max-w-md flex flex-col items-center text-center bg-white p-8 rounded-3xl shadow-sm border border-slate-200">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-50 mb-4">
              <ShieldAlert className="h-8 w-8 text-red-500" />
            </div>
            <h3 className="text-xl font-medium text-slate-900">Unable to load case</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">{error}</p>
            <Button asChild variant="outline" className="mt-8 rounded-xl w-full">
              <Link href="/cases">Return to Cases</Link>
            </Button>
          </div>
        </div>
      </AppShell>
    );
  }

  // =========================================
  // DRAFT STATE (Awaiting Analysis)
  // =========================================
  if (
    status === "ready" &&
    detail &&
    (detail.case.status === "draft" ||
      detail.case.status === "processing" ||
      (detail.case.status === "failed" && detail.documents.length === 0))
  ) {
    const isAnalyzing = detail.case.status === "processing" || analysisStatus === "processing";
    const canRetry = detail.case.status === "failed";
    const stageLabel = getFriendlyAnalysisStage(analysisStage, analysisStatus);
    const readyCount = detail.files.length;

    return (
      <AppShell defaultSidebarCollapsed>
        <div className="flex flex-1 flex-col bg-[#f7f7f5] animate-in fade-in duration-500 min-h-[calc(100vh-4rem)] tracking-normal">
          <header className="flex h-14 sm:h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
            <div className="flex items-center gap-3 sm:gap-4 w-full">
              <Link href="/cases" className="text-slate-400 hover:text-slate-800 transition-colors shrink-0">
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <h1 className="text-base sm:text-lg font-medium text-slate-900 truncate pr-2">
                {detail.case.displayName}
              </h1>
              <Badge variant="outline" className={`ml-auto rounded-full px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider shrink-0 ${getCaseStatusClassName(detail.case.status)}`}>
                {getCaseStatusLabel(detail.case.status)}
              </Badge>
            </div>
          </header>

          <main className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0 -z-10">
              <div className="absolute left-[12%] top-[14%] h-72 w-72 rounded-full bg-[#e5ddd0]/40 blur-3xl" />
              <div className="absolute right-[12%] bottom-[14%] h-80 w-80 rounded-full bg-[#d4c9b8]/30 blur-3xl" />
            </div>

            <div className="relative z-10 mx-auto flex w-full max-w-4xl flex-col items-center gap-8 px-6 py-12 text-center sm:py-16">
              <div className={`grid h-16 w-16 place-items-center rounded-[1.25rem] shadow-sm border ${canRetry ? "bg-red-50 text-red-700 border-red-200" : "bg-[#eaf0ff] text-[#4f46e5] border-[#d9dcff]"}`}>
                {canRetry ? <TriangleAlert className="h-8 w-8" /> : <CheckCircle2 className="h-8 w-8" />}
              </div>

              <div className="max-w-2xl space-y-4">
                <div className="text-xs font-medium uppercase tracking-[0.3em] text-[#8a7f72]">
                  {canRetry ? "Analysis failed" : "Case created"}
                </div>
                <h2 className="text-4xl font-medium tracking-tight text-[#1a1a1a] sm:text-5xl">
                  {canRetry ? "Analysis failed" : "Ready to analyze"}
                </h2>
                <p className="mx-auto text-base font-medium leading-relaxed text-[#5a5046]">
                  {canRetry
                    ? "The previous analysis run failed. Review the error below, then retry this case analysis."
                    : `This case has ${readyCount} document${readyCount === 1 ? "" : "s"} ready. Add any missing documents, then analyze to extract fields and check mismatches.`}
                </p>

                <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-[#e5ddd0] bg-white px-4 py-2 text-sm font-medium text-[#5a5046] shadow-sm">
                  <Folder className="h-4 w-4 text-[#8a7f72]" />
                  {detail.case.displayName}
                </div>

                {draftFileStatus === "saving" && (
                  <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full border border-[#c9ead2] bg-[#eaf7ee] px-4 py-2 text-sm font-medium text-[#15803d] shadow-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Adding documents to case...
                  </div>
                )}

                {isAnalyzing && (
                  <div className="mx-auto mt-4 w-full max-w-md space-y-3 text-left">
                    <div className="flex items-center justify-between text-sm font-medium text-[#5a5046]">
                      <span>{stageLabel}</span>
                      <span>{analysisProgress}%</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-[#ece8e0]">
                      <div
                        className="h-full rounded-full bg-[#1a1a1a] transition-all duration-300 ease-out"
                        style={{ width: `${analysisProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {((analysisStatus === "error" && analysisError) || draftFileError) && (
                  <div className="mx-auto mt-4 max-w-2xl rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-medium text-red-700 shadow-sm">
                    {draftFileError || analysisError}
                  </div>
                )}
              </div>

              <div className="w-full max-w-3xl rounded-[2rem] border border-[#e5ddd0] bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-left text-base font-medium text-[#1a1a1a]">Documents in this case</h3>
                  <div className="text-[11px] font-medium uppercase tracking-[0.25em] text-[#8a7f72]">
                    {readyCount} document{readyCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap gap-3">
                  {detail.files.map((file, index) => (
                    <div
                      key={file.id}
                      className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-[#e5ddd0] bg-[#faf8f4] text-[#8a7f72] shadow-sm"
                      title={file.originalName}
                    >
                      <FileText className="h-6 w-6" />
                      <span className="absolute -right-1.5 -top-1.5 rounded-full bg-[#1a1a1a] px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {index + 1}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-[#8a7f72]">
                Mode: {getComparisonModeLabel(comparisonOptions)}
              </div>

              {!isAnalyzing && (
                <div className="mt-2 flex w-full max-w-3xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-center">
                  <input
                    ref={draftFileInputRef}
                    type="file"
                    multiple
                    accept=".pdf,image/*"
                    className="hidden"
                    onChange={handleDraftFileInputChange}
                  />

                  <Button
                    variant="outline"
                    disabled={draftFileStatus === "saving"}
                    className="rounded-2xl px-6 py-6 text-base font-medium border-[#e5ddd0] text-[#5a5046] bg-white hover:bg-[#faf8f4] hover:text-[#1a1a1a] shadow-sm transition-transform hover:scale-[1.02]"
                    onClick={() => draftFileInputRef.current?.click()}
                  >
                    <Plus className="mr-2 h-5 w-5 text-[#8a7f72]" />
                    Add documents
                  </Button>

                  <Button
                    type="button"
                    disabled={detail.files.length === 0 || draftFileStatus === "saving"}
                    className="flex-1 rounded-2xl bg-[#1a1a1a] px-8 py-6 text-base font-medium text-white shadow-lg shadow-[#1a1a1a]/15 hover:bg-[#2d2d2d] transition-transform hover:scale-[1.02]"
                    onClick={() => {
                      setPendingAnalysisMode("standard");
                      setAnalysisOptionsOpen(true);
                    }}
                  >
                    <Play className="mr-2 h-5 w-5 fill-white" />
                    {canRetry ? "Retry analysis" : "Analyze case"}
                  </Button>

                  <Button
                    type="button"
                    disabled={detail.files.length === 0 || draftFileStatus === "saving"}
                    variant="outline"
                    className="rounded-2xl border-emerald-200 bg-emerald-50 px-6 py-6 text-base font-medium text-emerald-800 shadow-sm transition-transform hover:scale-[1.02] hover:bg-emerald-100 hover:text-emerald-900"
                    onClick={() => {
                      setPendingAnalysisMode("smart_split");
                      setAnalysisOptionsOpen(true);
                    }}
                  >
                    <Sparkles className="mr-2 h-5 w-5" />
                    Analyze multi-doc PDFs
                  </Button>
                </div>
              )}
            </div>
          </main>

          <AnalysisOptionsDialog
            open={analysisOptionsOpen}
            onOpenChange={setAnalysisOptionsOpen}
            onSelect={(nextOptions) => {
              setAnalysisOptionsOpen(false);
              void handleAnalyzeDraftCase(nextOptions, pendingAnalysisMode);
            }}
          />
        </div>
      </AppShell>
    );
  }

  // =========================================
  // ANALYZED STATE (Split Screen View)
  // =========================================
  const showActions = detail && detail.case.status !== "draft" && !isFinalDecision;
  const reviewCountLabel =
    visibleMismatches.length > 0
      ? isFinalDecision
        ? `${visibleMismatches.length} reviewed`
        : `${pendingMismatchCount || visibleMismatches.length} open`
      : `${displayDocuments.length} checked`;
  const splitAnalysisMeta = readSplitAnalysisMeta(detail?.case.processingMeta);
  const sellerChainRoleMeta =
    readSellerChainRoleSelectionMeta(detail?.case.processingMeta) ??
    (detail ? inferSellerChainRoleSelection(displayDocuments) : null);
  const packetPageCount = displayDocuments.reduce(
    (total, document) => total + Math.max(1, document.pageCount || 1),
    0
  );
  const headerInvoiceAmount = formatMoney(
    displayDocuments
      .map((document) => getInvoiceAmount(document))
      .find((value): value is number => value !== null)
  );
  const currentDocumentIndex = activeDocument ? getDocumentIndexDetails(activeDocument) : null;
  const caseStatusTone =
    detail?.case.status === "accepted"
      ? styles.statusAccepted
      : detail?.case.status === "rejected"
        ? styles.statusRejected
        : visibleMismatches.length > 0
          ? styles.statusReview
          : styles.statusNeutral;
  const reviewBarTone =
    reviewSummary?.tone === "emerald"
      ? styles.reviewBarGreen
      : reviewSummary?.tone === "rose"
        ? styles.reviewBarRed
        : styles.reviewBarAmber;

  const redesignedDetail = detail;
  if (Boolean(redesignedDetail)) {
    const detail = redesignedDetail as SavedCaseDetail;
    const redesignedDocuments: RedesignedDocumentCard[] = displayDocuments.map((document) => {
      const index = getDocumentIndexDetails(document);
      const identifiers = [document.id, document.clientDocumentId, document.sourceHint, document.title]
        .filter((value): value is string => Boolean(value));
      const extractedFieldCount = Object.values(document.extractedFields || {}).filter(
        (val) => val !== null && val !== undefined && String(val).trim() !== ""
      ).length;
      const comparisonValue = documentFieldComparison
        ? getComparableFieldValue(
            { type: document.documentType as DocType, fields: document.extractedFields },
            documentFieldComparison.key as FieldKey
          )
        : undefined;
      const normalizedComparisonValue = String(comparisonValue ?? "").trim().toLowerCase();
      const hasComparisonValue = Boolean(
        normalizedComparisonValue &&
        !["-", "not detected", "n/a", "na", "null", "undefined"].includes(normalizedComparisonValue)
      );
      const participatesInComparisonMismatch = documentFieldComparison
        ? visibleMismatches.some(
            (mismatch) =>
              mismatch.fieldName === documentFieldComparison.key &&
              mismatch.values.some((entry) => Boolean(entry.docId && identifiers.includes(entry.docId)))
          )
        : false;
      return {
        id: document.id,
        type: index.type,
        fileName: index.fileName,
        pageLabel: index.pageLabel,
        pageCount: Math.max(1, document.pageCount || 1),
        fieldCount: extractedFieldCount,
        hasIssue: visibleMismatches.some((mismatch) =>
          mismatch.values.some((entry) => Boolean(entry.docId && identifiers.includes(entry.docId)))
        ),
        comparisonState: documentFieldComparison
          ? !hasComparisonValue
            ? "absent"
            : participatesInComparisonMismatch
              ? "mismatch"
              : "matched"
          : undefined,
        comparisonValue: documentFieldComparison
          ? hasComparisonValue
            ? displayValue(comparisonValue)
            : "—"
          : undefined,
        chainRole: sellerChainRoleMeta
          ? sellerChainRoleMeta.contextDocumentIds.includes(document.id)
            ? "supporting"
            : "approval"
          : undefined,
      };
    });
    const extractedDate = displayDocuments
      .map((document) =>
        ["invoiceDate", "poDate", "documentDate", "date"]
          .map((key) => document.extractedFields[key])
          .find((value) => typeof value === "string" && value.trim())
      )
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    const createdDate = new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(detail.case.createdAt));
    const uploadedLabel = `Uploaded ${new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(detail.case.createdAt))}`;

    const previewNode = activeFileUrl ? (
      activeSourceIsImage ? (
        <div className={styles.redesignPreviewScroller}>
          <div
            className={styles.redesignPreviewImageScale}
            style={{ transform: `scale(${previewZoom})` }}
          >
            <Image
              src={activeFileUrl}
              alt={`Document preview page ${previewPageIndex + 1}`}
              width={1200}
              height={1600}
              unoptimized
              sizes="(min-width: 1100px) 64vw, 94vw"
              className={styles.redesignPreviewImage}
              draggable={false}
            />
          </div>
        </div>
      ) : (
        <div className={styles.redesignPdfPreview}>
          <PdfEvidencePreview
            url={activeFileUrl}
            pageNumber={activePdfPage}
            zoom={previewZoom}
            searchPageStart={activeDocumentSourcePage}
            searchPageEnd={
              activeDocumentSourcePage + Math.max(1, activeDocument?.pageCount || 1) - 1
            }
            onHighlightPageChange={setPreviewPdfPage}
            onPageCountChange={setPreviewPdfPageCount}
          />
        </div>
      )
    ) : (
      <div className={styles.redesignPreviewEmpty}>
        {isPreviewUrlLoading ? <Loader2 className={styles.redesignSpinner} /> : <FileSearch />}
        <strong>{isPreviewUrlLoading ? "Loading source preview…" : "Preview unavailable"}</strong>
        <span>{previewUrlError || "The source file could not be opened for this document."}</span>
      </div>
    );

    const stampCheckKeys = [
      "hasAuthorizedSignature",
      "hasVendorStamp",
      "hasStoreStamp",
      "hasStoreSignature",
      "hasGateStamp",
    ];

    const extractedFieldItems: ExtractedFieldItem[] = (activeDocumentFieldEntries || []).map(
      ([key, value]) => {
        const currentValue = typeof value === "string" ? value : displayValue(value);
        const fieldLabel = getDocumentFieldLabel(activeDocument?.documentType, key);
        const hasMismatch = visibleMismatches.some((m) => m.fieldName === key);
        return {
          key,
          label: fieldLabel,
          value: currentValue || "Not detected",
          hasMismatch,
        };
      }
    );

    if (activeDocument?.extractedFields) {
      const existingKeySet = new Set(extractedFieldItems.map((f) => f.key));
      for (const stampKey of stampCheckKeys) {
        if (!existingKeySet.has(stampKey)) {
          const rawVal = activeDocument.extractedFields[stampKey];
          if (rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== "") {
            const isYes = rawVal === true || String(rawVal).toLowerCase() === "yes";
            extractedFieldItems.push({
              key: stampKey,
              label: getDocumentFieldLabel(activeDocument.documentType, stampKey),
              value: isYes ? "Yes" : "No",
              hasMismatch: visibleMismatches.some((m) => m.fieldName === stampKey),
            });
          }
        }
      }
    }

    const lineItemsDocumentTotal = formatMoney(activeDocument ? getInvoiceAmount(activeDocument) : null);
    const lineItemsContent = (
      <div className={styles.redesignDataContent}>
        {lineItemsDocumentTotal ? (
          <div className={styles.redesignLineSummary}>
            <span>Document total</span>
            <strong>{lineItemsDocumentTotal}</strong>
          </div>
        ) : null}
        {activeDocumentLineItems.length > 0 ? (
          <div className={styles.redesignLineTableWrap}>
            <table className={styles.redesignLineTable}>
              <thead><tr>{activeDocumentLineItemColumns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
              <tbody>
                {activeDocumentLineItems.map((item, itemIndex) => {
                  return (
                    <tr
                      key={`${item.lineNumber ?? itemIndex}-${item.description ?? item.rawText ?? ""}`}
                    >
                      {activeDocumentLineItemColumns.map((column) => {
                        const cellValue = column.key === "lineNumber"
                          ? getLineItemValue(item, column.key) || String(itemIndex + 1)
                          : getLineItemValue(item, column.key);
                        return <td key={column.key}>{cellValue ? String(cellValue) : "—"}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <div className={styles.redesignDataEmpty}>No line-item table was extracted for this document.</div>}
      </div>
    );

    const termsContent = (
      <div className={styles.redesignDataContent}>
        <div className={styles.redesignDataGroupLabel}>Purchase-order terms</div>
        <div className={styles.redesignTermsList}>
          {activeTermsChecklistRows.map((row) => (
            <article
              key={row.key}
            >
              <span><strong>{row.label}</strong><small>{row.value}</small></span>
              <em className={row.issue ? styles.redesignTermIssue : styles.redesignTermClear}>
                {row.issue ? "Needs review" : "Fulfilled"}
              </em>
            </article>
          ))}
          {unmatchedTermsIssues.map((issue) => (
            <article
              key={issue.id}
            >
              <span><strong>Review item</strong><small>{issue.analysis || issue.fixPlan || getTermsIssueText(issue)}</small></span>
              <em className={styles.redesignTermIssue}>Needs review</em>
            </article>
          ))}
          {activeTermsChecklistRows.length === 0 && unmatchedTermsIssues.length === 0 ? (
            <div className={styles.redesignDataEmpty}>No purchase-order terms were extracted for this document.</div>
          ) : null}
        </div>
      </div>
    );

    const dataNode = (
      <ExtractedFieldsPanel
        fields={extractedFieldItems}
        lineItemCount={activeDocumentLineItems.length}
        activeComparisonFieldKey={documentFieldComparison?.key || null}
        onCompareField={(field) =>
          setDocumentFieldComparison((current) =>
            current?.key === field.key ? null : field
          )
        }
        activeDataView={activeDataView}
        onDataViewChange={setActiveDataView}
        termsCount={activeTermsChecklistRows.length + unmatchedTermsIssues.length}
        hasFailureState={visibleMismatches.some((m) =>
          m.values.some(
            (entry) =>
              entry.docId &&
              [activeDocument?.id, activeDocument?.clientDocumentId].includes(entry.docId)
          )
        )}
        lineItemsContent={lineItemsContent}
        termsContent={termsContent}
      />
    );

    const complianceContent = (
      <div className={styles.redesignComplianceList}>
        {activeTermsChecklistRows.length > 0 ? activeTermsChecklistRows.map((row) => (
          <article key={row.key}>
            <div><strong>{row.label}</strong><span className={row.issue ? styles.redesignComplianceIssue : styles.redesignComplianceClear}>
              {row.issue ? <TriangleAlert /> : <CheckCircle2 />} {row.issue ? "Needs review" : "Fulfilled"}
            </span></div>
            <p>{row.value}</p>
            {row.evidence ? <small>{row.evidence}</small> : null}
          </article>
        )) : <div className={styles.redesignDataEmpty}>Select a purchase order to review its compliance clauses.</div>}
      </div>
    );

    const activityContent = (
      <div className={styles.redesignActivityList}>
        <article><i /><time>{uploadedLabel}</time><p><strong>Case created</strong> with {detail.files.length} uploaded file{detail.files.length === 1 ? "" : "s"}.</p></article>
        <article><i /><time>{createdDate}</time><p><strong>Packet analyzed</strong> into {displayDocuments.length} classified document{displayDocuments.length === 1 ? "" : "s"}.</p></article>
        <article><i /><time>Current</time><p><strong>Status: {getCaseStatusLabel(detail.case.status)}</strong>{visibleMismatches.length ? ` · ${visibleMismatches.length} mismatch${visibleMismatches.length === 1 ? "" : "es"} on record.` : " · no mismatches found."}</p></article>
      </div>
    );

    return (
      <AppShell defaultSidebarCollapsed>
        <CaseDetailRedesign
          caseId={caseId}
          caseSlug={detail.case.slug}
          caseName={detail.case.displayName}
          parentName={detail.case.receiverName || detail.case.buyerName || "Procurement packet"}
          poNumber={detail.case.poNumber}
          invoiceNumber={detail.case.invoiceNumber}
          dateLabel={extractedDate || createdDate}
          amountLabel={headerInvoiceAmount}
          uploadedLabel={uploadedLabel}
          statusLabel={getCaseStatusLabel(detail.case.status)}
          status={detail.case.status}
          showActions={Boolean(showActions)}
          decisionUpdating={decisionStatus === "updating"}
          decisionError={decisionStatus === "error" ? decisionError : null}
          onDecision={(decision) => void handleCaseDecision(decision)}
          documents={redesignedDocuments}
          comparisonFieldLabel={documentFieldComparison?.label}
          activeDocumentId={activeDocumentId}
          onSelectDocument={handleDocumentSelection}
          mismatchCount={visibleMismatches.length}
          canReviewTally={displayDocuments.some(isInvoiceDocument)}
          pendingMismatchCount={pendingMismatchCount}
          reviewTitle={reviewSummary?.title || "Packet review"}
          reviewDescription={reviewSummary?.description || "Review the packet before deciding."}
          complianceCount={activeTermsChecklistRows.length + unmatchedTermsIssues.length}
          complianceContent={complianceContent}
          activityContent={activityContent}
          viewerMode={activeTab}
          onViewerModeChange={setActiveTab}
          sourceReference={currentDocumentIndex?.fileName || activeSourceLabel}
          previewNode={previewNode}
          dataNode={dataNode}
          canPreviousPage={canGoToPreviousPreviewPage}
          canNextPage={canGoToNextPreviewPage}
          showPageControls={activeSourceIsImage ? previewPageCount > 1 : previewPdfPageCount > 1}
          pageLabel={activeSourceIsImage ? `${Math.min(previewPageIndex + 1, previewPageCount)} / ${previewPageCount}` : `${activePdfPage} / ${previewPdfPageCount}`}
          onPreviousPage={() => {
            setPreviewFocus(null);
            if (activeSourceIsImage) setPreviewPageIndex((current) => Math.max(0, current - 1));
            else setPreviewPdfPage(Math.max(1, activePdfPage - 1));
          }}
          onNextPage={() => {
            setPreviewFocus(null);
            if (activeSourceIsImage) setPreviewPageIndex((current) => Math.min(Math.max(activeDocumentFiles.length - 1, 0), current + 1));
            else setPreviewPdfPage(Math.min(previewPdfPageCount, activePdfPage + 1));
          }}
          zoom={previewZoom}
          canZoomOut={canZoomOut}
          canZoomIn={canZoomIn}
          onZoomOut={() => setPreviewZoom((current) => Math.max(0.75, Number((current - 0.25).toFixed(2))))}
          onZoomIn={() => setPreviewZoom((current) => Math.min(3, Number((current + 0.25).toFixed(2))))}
          onResetZoom={() => setPreviewZoom(DEFAULT_PREVIEW_ZOOM)}
        />

        <AnalysisOptionsDialog
          open={analysisOptionsOpen}
          onOpenChange={setAnalysisOptionsOpen}
          onSelect={(nextOptions) => {
            setAnalysisOptionsOpen(false);
            void handleAnalyzeDraftCase(nextOptions, pendingAnalysisMode);
          }}
        />

        <Dialog open={isTallyReviewOpen} onOpenChange={setIsTallyReviewOpen}>
          <DialogContent className={styles.tallyReviewDialog}>
            <DialogHeader className={styles.tallyReviewDialogHeader}>
              <DialogTitle className={styles.tallyReviewDialogTitle}>Approved case · Tally review</DialogTitle>
              <DialogDescription className={styles.tallyReviewDialogDescription}>
                Review the prepared Purchase voucher and posting status without leaving the case workspace.
              </DialogDescription>
            </DialogHeader>
            <div className={styles.tallyReviewDialogBody}>
              {isTallyReviewOpen ? (
                <TallyInReviewPanel
                  caseId={caseId}
                  onViewOriginal={(documentId) => {
                    setActiveDocumentId(documentId);
                    setActiveTab("preview");
                    setIsTallyReviewOpen(false);
                  }}
                />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      </AppShell>
    );
  }

  return (
    <AppShell defaultSidebarCollapsed>
      <div
        className={`${styles.page} animate-in fade-in duration-300`}
      >

        {/* Top Navigation Bar */}
        <header className={styles.header}>
          <Link href="/cases" className={styles.backButton} aria-label="Back to cases">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className={styles.breadcrumb}>
            <span className={styles.breadcrumbParent}>
              {detail?.case.receiverName || detail?.case.buyerName || "Cases"}
            </span>
            <span className={styles.breadcrumbSeparator}>/</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <h1 className={styles.breadcrumbCurrent} tabIndex={0}>
                  {detail?.case.displayName}
                </h1>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="start"
                sideOffset={8}
                className={styles.breadcrumbTooltip}
              >
                {detail?.case.displayName}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className={styles.headerSpacer} />
          <div className={styles.headerMeta}>
            {[headerInvoiceAmount, `${displayDocuments.length} documents`, `${packetPageCount} pages`]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <div className={`${styles.statusPill} ${caseStatusTone}`}>
            <span className={styles.statusDot} />
            {getCaseStatusLabel(detail?.case.status || "")}
          </div>
          {showActions ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className={`${styles.headerAction} ${styles.rejectAction}`}
                disabled={decisionStatus === "updating"}
                onClick={() => handleCaseDecision("rejected")}
              >
                Reject
              </Button>
              <Button
                size="sm"
                className={`${styles.headerAction} ${styles.acceptAction}`}
                disabled={decisionStatus === "updating"}
                onClick={() => handleCaseDecision("accepted")}
              >
                {decisionStatus === "updating" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Accept case
              </Button>
            </>
          ) : null}
        </header>

        {decisionStatus === "error" && decisionError ? (
          <div className={styles.decisionError}>{decisionError}</div>
        ) : null}

        {(splitAnalysisMeta || sellerChainRoleMeta) && (
          <div className={styles.noticeStack}>
            {splitAnalysisMeta ? (
              <div className={styles.contextNotice}>
                <Sparkles className={styles.contextNoticeIcon} />
                <div className={styles.contextNoticeBody}>
                  <div className={styles.contextNoticeTitle}>{splitAnalysisMeta.note}</div>
                  <div className={styles.contextNoticeMeta}>
                    Case {splitAnalysisMeta.groupIndex} of {splitAnalysisMeta.groupCount}
                    {splitAnalysisMeta.sourceFileNames.length
                      ? ` · ${splitAnalysisMeta.sourceFileNames.join(", ")}`
                      : ""}
                  </div>
                </div>
                {splitAnalysisMeta.siblingCases.length > 0 ? (
                  <div className={styles.siblingLinks}>
                    {splitAnalysisMeta.siblingCases.map((sibling) => (
                      <Link key={sibling.id} href={`/cases/${sibling.id}`} className={styles.siblingLink}>
                        Case {sibling.groupIndex}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {sellerChainRoleMeta ? (
              <div className={`${styles.contextNotice} ${styles.contextNoticeAmber}`}>
                <ShieldAlert className={styles.contextNoticeIcon} />
                <div className={styles.contextNoticeBody}>
                  <div className={styles.contextNoticeTitle}>{sellerChainRoleMeta.note}</div>
                  <div className={styles.contextNoticeMeta}>
                    {sellerChainRoleMeta.primaryDocumentIds.length} reconciliation ·{" "}
                    {sellerChainRoleMeta.contextDocumentIds.length} context
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {reviewSummary ? (
          <div className={`${styles.reviewBar} ${reviewBarTone}`}>
            <span className={styles.severityDot} />
            <div className={styles.reviewCopy}>
              <div className={styles.reviewTitle}>{reviewSummary.title}</div>
              <div className={styles.reviewDescription}>
                {reviewSummary.description} {reviewSummary.actionHint}
              </div>
            </div>
            <span className={styles.reviewCount}>{reviewCountLabel}</span>
            <div className={styles.reviewActions}>
              {reviewSummary.action === "review" ? (
                <Link
                  href={mismatchReviewHref}
                  prefetch
                  className={styles.reviewButton}
                  aria-label={isMismatchNavigationPending ? "Opening mismatch review" : "Review mismatches"}
                  onPointerEnter={prepareMismatchNavigation}
                  onFocus={prepareMismatchNavigation}
                  onClick={beginMismatchNavigation}
                >
                  {isMismatchNavigationPending ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Opening review…
                    </>
                  ) : (
                    <>
                      Review mismatches
                      <span className={styles.mono}>{visibleMismatches.length}</span>
                    </>
                  )}
                </Link>
              ) : reviewSummary.action === "approve" && showActions ? (
                <button
                  type="button"
                  className={styles.reviewButton}
                  disabled={decisionStatus === "updating"}
                  onClick={() => handleCaseDecision("accepted")}
                >
                  Approve case
                </button>
              ) : reviewSummary.action === "retry" ? (
                <button
                  type="button"
                  className={styles.reviewButton}
                  onClick={() => {
                    setPendingAnalysisMode("standard");
                    setAnalysisOptionsOpen(true);
                  }}
                >
                  Retry analysis
                </button>
              ) : null}
              {detail?.case.status === "accepted" ? (
                <button
                  type="button"
                  className={`${styles.reviewButton} ${styles.tallyReviewButton}`}
                  onClick={() => setIsTallyReviewOpen(true)}
                >
                  <Database aria-hidden="true" />
                  Tally review
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <section className={styles.packetStrip} aria-label="Documents in packet">
          <div className={styles.packetStripLabel}>
            Documents in packet <span>· {displayDocuments.length}</span>
          </div>
          <div className={styles.packetCards}>
            {displayDocuments.map((doc) => {
              const isActive = activeDocumentId === doc.id;
              const documentIndex = getDocumentIndexDetails(doc);
              const documentIdentifiers = [doc.id, doc.clientDocumentId, doc.sourceHint, doc.title]
                .filter((value): value is string => Boolean(value));
              const hasIssue = visibleMismatches.some((mismatch) =>
                mismatch.values.some(
                  (entry) => entry.docId && documentIdentifiers.includes(entry.docId)
                )
              );

              return (
                <button
                  key={doc.id}
                  type="button"
                  className={`${styles.packetCard} ${isActive ? styles.packetCardActive : ""}`}
                  onClick={() => handleDocumentSelection(doc.id)}
                  aria-pressed={isActive}
                >
                  <span className={styles.packetCardTopline}>
                    <span className={styles.pageBadge}>{documentIndex.pageLabel}</span>
                    <span
                      className={`${styles.documentStateDot} ${hasIssue ? styles.documentStateDotIssue : ""}`}
                      aria-label={hasIssue ? "Has mismatch" : "Checked"}
                    />
                  </span>
                  <span className={styles.packetCardName}>{documentIndex.type}</span>
                  <span className={styles.packetCardMeta} title={documentIndex.fileName}>
                    {documentIndex.fileName}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Desktop review workspace: source document and extracted data stay visible together. */}
        <div
          ref={desktopWorkspaceRef}
          className={`${styles.workspace} ${styles.desktopWorkspace} ${isPaneResizing ? styles.workspaceResizing : ""}`}
          style={{ "--data-pane-width": `${dataPaneWidth}px` } as CSSProperties}
        >
          <main className={styles.viewerPane}>
            <div className={styles.viewerToolbar}>
              <span className={styles.viewerTitle}>{currentDocumentIndex?.type || "Document preview"}</span>
              <span className={styles.viewerSource} title={currentDocumentIndex?.fileName}>
                {currentDocumentIndex?.fileName || activeSourceLabel}
              </span>
              {previewFocus ? (
                <button
                  type="button"
                  className={styles.focusChip}
                  onClick={() => setPreviewFocus(null)}
                  title="Clear preview highlight"
                >
                  <span className={styles.focusChipDot} />
                  {previewFocus.label}
                  <X className="h-3 w-3" />
                </button>
              ) : null}
              <span className={styles.toolbarDivider} />
              <div className={styles.pageControls} aria-label="Page controls">
                <button
                  type="button"
                  className={styles.toolButton}
                  disabled={!canGoToPreviousPreviewPage}
                  onClick={() => {
                    setPreviewFocus(null);
                    if (activeSourceIsImage) {
                      setPreviewPageIndex((current) => Math.max(0, current - 1));
                    } else {
                      setPreviewPdfPage(Math.max(1, activePdfPage - 1));
                    }
                  }}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className={styles.pageCounter}>
                  {activeSourceIsImage
                    ? `${Math.min(previewPageIndex + 1, previewPageCount)} / ${previewPageCount}`
                    : `${activePdfPage} / ${previewPdfPageCount}`}
                </span>
                <button
                  type="button"
                  className={styles.toolButton}
                  disabled={!canGoToNextPreviewPage}
                  onClick={() => {
                    setPreviewFocus(null);
                    if (activeSourceIsImage) {
                      setPreviewPageIndex((current) =>
                        Math.min(Math.max(activeDocumentFiles.length - 1, 0), current + 1)
                      );
                    } else {
                      setPreviewPdfPage(Math.min(previewPdfPageCount, activePdfPage + 1));
                    }
                  }}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className={styles.zoomControls} aria-label="Zoom controls">
                <button
                  type="button"
                  className={styles.toolButton}
                  disabled={!canZoomOut}
                  onClick={() =>
                    setPreviewZoom((current) => Math.max(0.75, Number((current - 0.25).toFixed(2))))
                  }
                  aria-label="Zoom out"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <span className={styles.zoomLabel}>{Math.round(previewZoom * 100)}%</span>
                <button
                  type="button"
                  className={styles.toolButton}
                  disabled={!canZoomIn}
                  onClick={() =>
                    setPreviewZoom((current) => Math.min(3, Number((current + 0.25).toFixed(2))))
                  }
                  aria-label="Zoom in"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className={styles.toolButton}
                  disabled={!activeFileUrl || previewZoom === DEFAULT_PREVIEW_ZOOM}
                  onClick={() => setPreviewZoom(DEFAULT_PREVIEW_ZOOM)}
                  aria-label="Reset zoom"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className={styles.viewerCanvas}>
              {activeFileUrl ? (
                activeSourceIsImage ? (
                  <div className={styles.previewScroller}>
                    <div className={styles.previewImageWrap}>
                      <div
                        className={styles.previewImageScale}
                        style={{ transform: `scale(${previewZoom})` }}
                      >
                        <Image
                          src={activeFileUrl}
                          alt={`Document preview page ${previewPageIndex + 1}`}
                          width={1200}
                          height={1600}
                          unoptimized
                          sizes="(min-width: 1240px) 50vw, 44vw"
                          className={styles.previewImage}
                          draggable={false}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <PdfEvidencePreview
                    url={activeFileUrl}
                    pageNumber={activePdfPage}
                    zoom={previewZoom}
                    highlightText={previewFocus?.query}
                    highlightLabel={previewFocus?.label}
                    highlightOccurrence={previewFocus?.occurrence}
                    searchPageStart={activeDocumentSourcePage}
                    searchPageEnd={
                      activeDocumentSourcePage + Math.max(1, activeDocument?.pageCount || 1) - 1
                    }
                    onHighlightPageChange={setPreviewPdfPage}
                    onPageCountChange={setPreviewPdfPageCount}
                  />
                )
              ) : (
                <div className={styles.previewEmpty}>
                  <div className={styles.previewEmptyInner}>
                    {isPreviewUrlLoading ? (
                      <Loader2 className="h-8 w-8 animate-spin opacity-60" />
                    ) : (
                      <FileSearch className="h-8 w-8 opacity-50" />
                    )}
                    <span>
                      {isPreviewUrlLoading
                        ? "Loading source preview…"
                        : previewUrlError || "Source preview is not available for this document."}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </main>

          <button
            type="button"
            role="separator"
            className={styles.paneResizeHandle}
            aria-label="Resize PDF preview and extracted data panels"
            aria-orientation="vertical"
            aria-valuemin={MIN_DATA_PANE_WIDTH}
            aria-valuemax={getDataPaneWidthBounds().max}
            aria-valuenow={dataPaneWidth}
            title="Drag to resize · Double-click to reset"
            onPointerDown={handlePaneResizeStart}
            onPointerMove={handlePaneResizeMove}
            onPointerUp={handlePaneResizeEnd}
            onPointerCancel={handlePaneResizeEnd}
            onDoubleClick={() => resizeDataPane(DEFAULT_DATA_PANE_WIDTH)}
            onKeyDown={handlePaneResizeKeyDown}
          >
            <GripVertical aria-hidden="true" />
          </button>

          <aside className={styles.dataPane} aria-label="Extracted document data">
            <div className={styles.dataTabs} role="tablist" aria-label="Extracted data views">
              <button
                type="button"
                role="tab"
                aria-selected={activeDataView === "fields"}
                className={`${styles.dataTab} ${activeDataView === "fields" ? styles.dataTabActive : ""}`}
                onClick={() => setActiveDataView("fields")}
              >
                Fields <span className={styles.dataTabCount}>{activeDocumentFieldEntries.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeDataView === "lineItems"}
                className={`${styles.dataTab} ${activeDataView === "lineItems" ? styles.dataTabActive : ""}`}
                onClick={() => setActiveDataView("lineItems")}
              >
                Line items <span className={styles.dataTabCount}>{activeDocumentLineItems.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeDataView === "terms"}
                className={`${styles.dataTab} ${activeDataView === "terms" ? styles.dataTabActive : ""}`}
                onClick={() => setActiveDataView("terms")}
              >
                PO terms{" "}
                <span className={styles.dataTabCount}>
                  {activeTermsChecklistRows.length + unmatchedTermsIssues.length}
                </span>
              </button>
            </div>

            <div className={styles.dataBody}>
              {activeDataView === "fields" ? (
                <>
                  <div className={styles.dataHint}>
                    <Eye className="h-3.5 w-3.5" /> Values extracted from the selected document
                  </div>
                  <div className={styles.dataGroupLabel}>{currentDocumentIndex?.type || "Document"}</div>
                  {activeDocumentFieldEntries.length > 0 ? (
                    activeDocumentFieldEntries.map(([key, value]) => {
                      const currentValue = typeof value === "string" ? value : displayValue(value);
                      const fieldLabel = getDocumentFieldLabel(activeDocument?.documentType, key);
                      const focusId = `field-${activeDocument?.id || "document"}-${key}`;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`${styles.fieldRow} ${previewFocus?.id === focusId ? styles.dataRowActive : ""}`}
                          onClick={() =>
                            handlePreviewFocus({
                              id: focusId,
                              label: fieldLabel,
                              query: currentValue,
                              pageNumber: activeDocumentSourcePage,
                            })
                          }
                        >
                          <div className={styles.fieldKey}>
                            {fieldLabel}
                          </div>
                          <div className={styles.fieldValue}>
                            {currentValue || <span className={styles.emptyValue}>Not detected</span>}
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className={styles.emptyState}>No scalar fields were extracted for this document.</div>
                  )}
                </>
              ) : null}

              {activeDataView === "lineItems" ? (
                <>
                  <div className={styles.lineSummary}>
                    <div className={styles.lineSummaryItem}>
                      <div className={styles.lineSummaryLabel}>Rows</div>
                      <div className={styles.lineSummaryValue}>{activeDocumentLineItems.length}</div>
                    </div>
                    <div className={styles.lineSummaryItem}>
                      <div className={styles.lineSummaryLabel}>Document total</div>
                      <div className={styles.lineSummaryValue}>
                        {formatMoney(activeDocument ? getInvoiceAmount(activeDocument) : null) || "—"}
                      </div>
                    </div>
                  </div>
                  {activeDocumentLineItems.length > 0 ? (
                    <div className={styles.lineTableWrap}>
                      <table className={styles.lineTable}>
                        <thead>
                          <tr>
                            {activeDocumentLineItemColumns.map((column) => (
                              <th key={column.key}>{column.label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {activeDocumentLineItems.map((item, itemIndex) => {
                            const focusPrefix = `line-item-${activeDocument?.id || "document"}-${itemIndex}`;
                            const focusId = `${focusPrefix}-row`;
                            const lineLabel = `Line item ${item.lineNumber || itemIndex + 1}`;
                            const lineQuery =
                              item.rawText || item.description || item.itemCode || item.lineNumber || "";
                            const linePageNumber = getLineItemPreviewPage(activeDocument, item);
                            const normalizedLineQuery = normalizeEvidenceValue(lineQuery);
                            const lineOccurrence = activeDocumentLineItems
                              .slice(0, itemIndex)
                              .filter(
                                (previousItem) =>
                                  getLineItemPreviewPage(activeDocument, previousItem) === linePageNumber &&
                                  normalizeEvidenceValue(
                                    previousItem.rawText ||
                                      previousItem.description ||
                                      previousItem.itemCode ||
                                      previousItem.lineNumber ||
                                      ""
                                  ) === normalizedLineQuery
                              ).length;
                            const selectLineItem = () =>
                              handlePreviewFocus({
                                id: focusId,
                                label: lineLabel,
                                query: lineQuery,
                                pageNumber: linePageNumber,
                                occurrence: lineOccurrence,
                              });

                            return (
                              <tr
                                key={`${item.lineNumber ?? itemIndex}-${item.description ?? item.rawText ?? ""}`}
                                className={previewFocus?.id.startsWith(focusPrefix) ? styles.dataRowActive : undefined}
                                role="button"
                                tabIndex={0}
                                onClick={selectLineItem}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    selectLineItem();
                                  }
                                }}
                              >
                                {activeDocumentLineItemColumns.map((column) => {
                                  const value =
                                    column.key === "lineNumber"
                                      ? getLineItemValue(item, column.key) || String(itemIndex + 1)
                                      : getLineItemValue(item, column.key);
                                  const displayText = value ? String(value) : "—";
                                  const cellQuery =
                                    column.key === "lineNumber"
                                      ? item.itemCode || item.description || displayText
                                      : value
                                        ? String(value)
                                        : "";
                                  const cellFocusId = `${focusPrefix}-${column.key}`;
                                  const normalizedCellQuery = normalizeEvidenceValue(cellQuery);
                                  const cellOccurrence = activeDocumentLineItems
                                    .slice(0, itemIndex)
                                    .filter((previousItem) => {
                                      if (
                                        getLineItemPreviewPage(activeDocument, previousItem) !== linePageNumber
                                      ) {
                                        return false;
                                      }
                                      const previousValue =
                                        column.key === "lineNumber"
                                          ? previousItem.itemCode || previousItem.description || ""
                                          : getLineItemValue(previousItem, column.key);
                                      return normalizeEvidenceValue(previousValue) === normalizedCellQuery;
                                    }).length;
                                  const selectCell = () =>
                                    handlePreviewFocus({
                                      id: cellFocusId,
                                      label: `${column.label} · ${lineLabel}`,
                                      query: cellQuery,
                                      pageNumber: linePageNumber,
                                      occurrence: cellOccurrence,
                                    });

                                  return (
                                    <td
                                      key={column.key}
                                      className={previewFocus?.id === cellFocusId ? styles.lineCellActive : undefined}
                                      role="button"
                                      tabIndex={0}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        selectCell();
                                      }}
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          selectCell();
                                        }
                                      }}
                                    >
                                      {displayText}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className={styles.emptyState}>No line-item table was extracted for this document.</div>
                  )}
                </>
              ) : null}

              {activeDataView === "terms" ? (
                <>
                  <div className={styles.termsSummary}>
                    <div>
                      <div className={styles.termsSummaryTitle}>Terms compliance</div>
                      <div className={styles.termsSummaryCopy}>
                        {activeTermsChecklistRows.length} extracted clause
                        {activeTermsChecklistRows.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <span
                      className={`${styles.termsStatus} ${activeTermsIssues.length > 0 ? styles.termsStatusIssue : ""}`}
                    >
                      {activeTermsIssues.length > 0 ? (
                        <TriangleAlert className="h-3 w-3" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3" />
                      )}
                      {activeTermsIssues.length > 0 ? `${activeTermsIssues.length} flagged` : "Clear"}
                    </span>
                  </div>

                  {activeTermsChecklistRows.map((row) => {
                    const StatusIcon = row.status.icon;
                    const focusId = `term-${activeDocument?.id || "document"}-${row.key}`;
                    return (
                      <div
                        key={row.key}
                        className={`${styles.termRow} ${previewFocus?.id === focusId ? styles.dataRowActive : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          handlePreviewFocus({
                            id: focusId,
                            label: row.label,
                            query: row.value,
                            pageNumber: activeDocumentSourcePage,
                          })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handlePreviewFocus({
                              id: focusId,
                              label: row.label,
                              query: row.value,
                              pageNumber: activeDocumentSourcePage,
                            });
                          }
                        }}
                      >
                        <div className={styles.termHeader}>
                          <div className={styles.termCategory}>{row.label}</div>
                          <span className={`${styles.termBadge} ${row.status.className}`}>
                            <StatusIcon className="h-3 w-3" /> {row.status.label}
                          </span>
                        </div>
                        <div className={styles.termText}>{row.value}</div>
                        {row.detail ? <div className={styles.termDetail}>{row.detail}</div> : null}
                        {row.evidence ? <div className={styles.termEvidence}>{row.evidence}</div> : null}
                        {row.issue?.analysis ? <div className={styles.termIssue}>{row.issue.analysis}</div> : null}
                      </div>
                    );
                  })}

                  {unmatchedTermsIssues.map((issue) => {
                    const status = getTermsIssueStatus(issue);
                    const StatusIcon = status.icon;
                    const focusId = `term-issue-${activeDocument?.id || "document"}-${issue.id}`;
                    const issueText =
                      issue.analysis || issue.fixPlan || getTermsIssueText(issue) || "Terms issue requires review.";
                    const issueQuery =
                      issue.values
                        .map((entry) => String(entry.value ?? "").trim())
                        .find(Boolean) || issueText;
                    const selectIssue = () =>
                      handlePreviewFocus({
                        id: focusId,
                        label: "Terms review item",
                        query: issueQuery,
                        pageNumber: activeDocumentSourcePage,
                      });
                    return (
                      <div
                        key={issue.id}
                        className={`${styles.termRow} ${previewFocus?.id === focusId ? styles.dataRowActive : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={selectIssue}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            selectIssue();
                          }
                        }}
                      >
                        <div className={styles.termHeader}>
                          <div className={styles.termCategory}>Review item</div>
                          <span className={`${styles.termBadge} ${status.className}`}>
                            <StatusIcon className="h-3 w-3" /> {status.label}
                          </span>
                        </div>
                        <div className={styles.termText}>{issueText}</div>
                      </div>
                    );
                  })}

                  {activeTermsChecklistRows.length === 0 && unmatchedTermsIssues.length === 0 ? (
                    <div className={styles.emptyState}>No purchase-order terms were extracted for this document.</div>
                  ) : null}
                </>
              ) : null}
            </div>
          </aside>
        </div>

        {/* Main Content Split */}
        <div className={`${styles.legacyMobileWorkspace} flex-1 min-h-0 relative`}>

          {/* Left Sidebar (Desktop only) */}
          <aside className="hidden">
            <div className="min-w-0 shrink-0 p-5 pb-4">

                {/* Decision Summary Card */}
                {detail && reviewSummary && (
                  <div
                    className={`flex w-full max-w-full flex-col overflow-hidden rounded-2xl border bg-white shadow-sm ${
                      reviewSummary.tone === "emerald"
                        ? "border-emerald-200"
                        : reviewSummary.tone === "amber"
                          ? "border-amber-200"
                          : "border-rose-200"
                    }`}
                  >

                    <div
                      className={`p-5 ${
                        reviewSummary.tone === "emerald"
                          ? "bg-emerald-50/70"
                          : reviewSummary.tone === "amber"
                            ? "bg-amber-50/70"
                            : "bg-rose-50/70"
                      }`}
                    >
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <div
                            className={`rounded-full p-1.5 shadow-sm ${
                              reviewSummary.tone === "emerald"
                                ? "bg-emerald-100 text-emerald-600"
                                : reviewSummary.tone === "amber"
                                  ? "bg-amber-100 text-amber-600"
                                  : "bg-rose-100 text-rose-600"
                            }`}
                          >
                            {reviewSummary.tone === "emerald" ? (
                              <CheckCircle2 className="h-4 w-4" />
                            ) : reviewSummary.title === "Processing" ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <TriangleAlert className="h-4 w-4" />
                            )}
                          </div>
                          <h3
                            className={`truncate text-base font-medium ${
                              reviewSummary.tone === "emerald"
                                ? "text-emerald-950"
                                : reviewSummary.tone === "amber"
                                  ? "text-amber-950"
                                  : "text-rose-950"
                            }`}
                          >
                            {reviewSummary.title}
                          </h3>
                        </div>
                        {reviewSummary.showBadge ? (
                          <span
                            className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider ${
                              reviewSummary.tone === "emerald"
                                ? "bg-emerald-100 text-emerald-700"
                                : reviewSummary.tone === "amber"
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-rose-100 text-rose-700"
                            }`}
                          >
                            {reviewSummary.badgeLabel}
                          </span>
                        ) : null}
                      </div>

                      <p
                        className={`text-sm font-medium leading-snug ${
                          reviewSummary.tone === "emerald"
                            ? "text-emerald-800"
                            : reviewSummary.tone === "amber"
                              ? "text-amber-800"
                              : "text-rose-800"
                        }`}
                      >
                        {reviewSummary.description}
                      </p>
                      {reviewSummary.action !== "approve" && reviewSummary.actionHint ? (
                        <p className="mt-2 text-xs font-medium leading-snug text-slate-600">
                          {reviewSummary.actionHint}
                        </p>
                      ) : null}

                      {reviewSummary.buttonLabel && reviewSummary.action === "review" && (
                        <Button
                          asChild
                          className={`mt-4 h-10 w-full text-white shadow-sm font-medium ${
                            reviewSummary.tone === "emerald"
                              ? "bg-emerald-600 hover:bg-emerald-700"
                              : reviewSummary.tone === "amber"
                                ? "bg-amber-600 hover:bg-amber-700"
                                : "bg-rose-600 hover:bg-rose-700"
                          }`}
                        >
                          <Link
                            href={mismatchReviewHref}
                            prefetch
                            onPointerEnter={prepareMismatchNavigation}
                            onFocus={prepareMismatchNavigation}
                            onClick={beginMismatchNavigation}
                          >
                            {isMismatchNavigationPending ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <TriangleAlert className="mr-2 h-4 w-4" />
                            )}
                            {isMismatchNavigationPending ? "Opening review…" : reviewSummary.buttonLabel}
                          </Link>
                        </Button>
                      )}

                      {reviewSummary.buttonLabel && reviewSummary.action === "approve" && showActions && (
                        <Button
                          className="mt-4 h-10 w-full bg-emerald-600 font-medium text-white shadow-sm hover:bg-emerald-700"
                          disabled={decisionStatus === "updating"}
                          onClick={() => handleCaseDecision("accepted")}
                        >
                          {decisionStatus === "updating" ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="mr-2 h-4 w-4" />
                          )}
                          {reviewSummary.buttonLabel}
                        </Button>
                      )}

                      {reviewSummary.buttonLabel && reviewSummary.action === "retry" && (
                        <Button
                          className="mt-4 h-10 w-full bg-rose-600 font-medium text-white shadow-sm hover:bg-rose-700"
                          onClick={() => {
                            setPendingAnalysisMode("standard");
                            setAnalysisOptionsOpen(true);
                          }}
                        >
                          <Play className="mr-2 h-4 w-4 fill-white" />
                          {reviewSummary.buttonLabel}
                        </Button>
                      )}

                      {reviewSummary.showConfidence && (
                        <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-emerald-100 bg-emerald-100/60 py-2 text-xs font-medium text-emerald-700">
                          <Sparkles className="h-3.5 w-3.5" /> High Confidence
                        </div>
                      )}
                    </div>

                    <div className="border-t border-slate-100 bg-white p-4">
                      <div className="grid grid-cols-1 gap-2">
                        {reviewSummary.facts.map((fact) => (
                          <div
                            key={`${fact.label}-${fact.value}`}
                            className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"
                          >
                            <span className="shrink-0 text-[10px] font-medium uppercase tracking-widest text-slate-400">
                              {fact.label}
                            </span>
                            <span className="min-w-0 truncate text-right text-xs font-medium text-slate-800" title={fact.value}>
                              {fact.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

            </div>

            {/* Documents List */}
            <div className="flex min-h-0 flex-1 flex-col border-t border-slate-200 px-5 pb-5 pt-4">
                  <div className="mb-3 flex shrink-0 items-center justify-between px-1">
                    <h3 className="text-[11px] font-medium text-slate-500 uppercase tracking-widest">Documents in Packet</h3>
                    <span className="rounded-full bg-slate-200/50 px-2 py-0.5 text-[10px] font-medium text-slate-500">{displayDocuments.length}</span>
                  </div>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                    {displayDocuments.map((doc) => {
                      const isActive = activeDocumentId === doc.id;
                      const documentIndex = getDocumentIndexDetails(doc);
                      return (
                        <button
                          key={doc.id}
                          onClick={() => setActiveDocumentId(doc.id)}
                          className={`flex w-full min-w-0 items-start gap-3 rounded-xl px-3 py-3 text-left transition-all ${isActive ? 'bg-white shadow-sm border border-slate-200 ring-1 ring-slate-200' : 'hover:bg-slate-200/50 border border-transparent'
                            }`}
                        >
                          <div className={`mt-0.5 shrink-0 h-8 w-8 rounded-lg flex items-center justify-center ${isActive ? 'bg-indigo-50 text-indigo-600' : 'bg-white text-slate-400 border border-slate-200'}`}>
                            <FileText className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`whitespace-normal text-sm font-medium leading-snug [overflow-wrap:anywhere] ${isActive ? 'text-slate-950' : 'text-slate-700'}`}>
                              {documentIndex.type}
                            </p>
                            <p className={`mt-1 truncate text-xs font-medium leading-snug ${isActive ? 'text-slate-700' : 'text-slate-500'}`} title={documentIndex.fileName}>
                              {documentIndex.fileName}
                            </p>
                            <p className="mt-1 line-clamp-1 text-[10px] font-medium uppercase tracking-wider text-slate-400 [overflow-wrap:anywhere]">
                              {documentIndex.pageLabel}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
            </div>
          </aside>

          {/* Right Main Area (Document Viewer Card) */}
          <main className="flex-1 flex flex-col min-w-0 bg-[#fafafa] pt-2.5 px-2.5 pb-0 sm:p-4 md:p-6 lg:p-8 relative">

            {/* Mobile Document Selector (Horizontal scroll) */}
            <div className="bg-white border border-[#e5ddd0] rounded-xl mb-3 p-1.5 shrink-0 z-10 relative overflow-hidden shadow-sm">
              <div className="flex overflow-x-auto gap-2 snap-x scrollbar-hide py-0.5 px-0.5">
                {displayDocuments.map((doc) => {
                  const isActive = activeDocumentId === doc.id;
                  const documentIndex = getDocumentIndexDetails(doc);
                  return (
                      <button
                        key={doc.id}
                      onClick={() => setActiveDocumentId(doc.id)}
                      className={`snap-start shrink-0 flex flex-col items-center justify-center px-4 py-2 rounded-lg text-center transition-all border ${isActive 
                        ? 'bg-[#1a1a1a] border-slate-900 shadow-md text-white' 
                        : 'bg-[#f0ece6] border-[#e5ddd0] text-[#5a5046]'
                        }`}
                      style={{ minWidth: '160px' }}
                    >
                      <p className="w-full truncate text-[11px] font-medium">{documentIndex.type}</p>
                      <p className={`mt-0.5 w-full truncate text-[9px] font-medium opacity-70 ${isActive ? 'text-white' : 'text-[#8a7f72]'}`}>{documentIndex.fileName}</p>
                      <p className={`mt-0.5 w-full truncate text-[8px] font-medium uppercase tracking-wider opacity-60 ${isActive ? 'text-white' : 'text-[#8a7f72]'}`}>{documentIndex.pageLabel}</p>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* The Unified Card Container */}
            <div className="flex flex-col flex-1 bg-white sm:border border-slate-200 sm:rounded-2xl shadow-sm overflow-hidden mb-2 sm:mb-0">

              {/* Card Header (Tabs & Title) */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-2 sm:p-3 border-b border-slate-100 bg-white shrink-0">

                {/* Left Side: Title & Badge (Desktop Only) */}
                <div className="hidden sm:flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    {activeTab === 'preview' ? <Eye className="h-5 w-5 text-slate-500" /> : <Database className="h-5 w-5 text-slate-500" />}
                    <h2 className="text-base font-medium text-slate-900">
                      {activeTab === 'preview' ? 'Preview' : 'Extracted Data'}
                    </h2>
                  </div>
                  <Badge variant="outline" className="rounded-full px-2.5 py-0.5 text-[10px] uppercase font-medium text-slate-500 bg-slate-50 border-slate-200">
                    {activeTab === 'preview' ? activeSourceLabel : 'View'}
                  </Badge>
                </div>

                {/* Right Side: Segmented Control & Actions */}
                <div className="flex items-center justify-between sm:justify-end w-full sm:w-auto gap-3">

                  {/* Segmented Control */}
                  <div className="flex items-center bg-[#f0ece6] p-1 rounded-xl w-full sm:w-auto border border-[#e5ddd0]">
                    {DETAIL_TABS.map((tab) => {
                      const isActive = activeTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          onClick={() => setActiveTab(tab.id)}
                          className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition-all ${isActive
                              ? 'bg-[#1a1a1a] text-white shadow-md'
                              : 'text-[#5a5046] hover:bg-[#e5ddd0]/30'
                            }`}
                        >
                          <tab.icon className={`h-3.5 w-3.5 ${isActive ? 'text-white' : 'text-[#8a7f72]'}`} />
                          <span>{tab.label}</span>
                        </button>
                      );
                    })}
                  </div>

                </div>
              </div>

              {/* Card Body (The Views) */}
              <div className="flex-1 relative bg-white overflow-hidden">

                {/* 1. Preview View */}
                {activeTab === 'preview' && (
                  <div className="absolute inset-0 flex flex-col bg-[#525659]">

                    {/* PDF/Image Canvas */}
                    <div className="flex-1 relative overflow-hidden">
                      {activeFileUrl ? (
                        activeSourceIsImage ? (
                          <div className="absolute inset-0 overflow-auto">
                            <div className="flex min-h-full min-w-full items-start justify-center px-3 py-5 sm:px-6 sm:py-8">
                              <div
                                className="relative flex w-full max-w-[min(100%,880px)] justify-center transition-transform duration-150 ease-out"
                                style={{ transform: `scale(${previewZoom})`, transformOrigin: "top center" }}
                              >
                                <Image
                                  src={activeFileUrl}
                                  alt={`Document preview page ${previewPageIndex + 1}`}
                                  width={1200}
                                  height={1600}
                                  unoptimized
                                  sizes="(min-width: 1024px) 70vw, 92vw"
                                  className="h-auto max-h-[calc(100vh-13rem)] w-auto max-w-full rounded-sm bg-white object-contain shadow-2xl"
                                  draggable={false}
                                />
                              </div>
                            </div>
                          </div>
                        ) : (
                          <iframe
                            key={`${activeFileUrl}-${activeDocumentSourcePage}`}
                            src={`${activeFileUrl}#page=${activeDocumentSourcePage}&toolbar=0&navpanes=0`}
                            className="absolute inset-0 w-full h-full border-0 bg-white"
                            title="Document Preview"
                          />
                        )
                      ) : isPreviewUrlLoading ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 gap-4 p-6 text-center">
                          <Loader2 className="w-12 h-12 animate-spin opacity-70" />
                          <p className="text-sm font-medium">Loading source preview...</p>
                        </div>
                      ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 gap-4 p-6 text-center">
                          <FileSearch className="w-12 h-12 opacity-50" />
                          <p className="text-sm font-medium">
                            {previewUrlError || "Source preview not available for this document."}
                          </p>
                        </div>
                      )}

                      {/* Floating Dark Toolbar */}
                      {activeFileUrl && (
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-slate-900/80 backdrop-blur-md px-2 py-1.5 rounded-xl border border-white/10 shadow-2xl z-20">
                          {previewPageCount > 1 && (
                            <>
                              <button
                                type="button"
                                disabled={!canGoToPreviousPreviewPage}
                                className="p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                                onClick={() => setPreviewPageIndex((current) => Math.max(0, current - 1))}
                                aria-label="Previous page"
                              >
                                <ChevronLeft className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          <div className="text-white text-[10px] sm:text-xs font-medium px-2 flex items-center gap-1">
                            {Math.min(previewPageIndex + 1, previewPageCount)} <span className="opacity-50">/ {previewPageCount}</span>
                          </div>
                          {previewPageCount > 1 && (
                            <>
                              <button
                                type="button"
                                disabled={!canGoToNextPreviewPage}
                                className="p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                                onClick={() =>
                                  setPreviewPageIndex((current) =>
                                    Math.min(Math.max(activeDocumentFiles.length - 1, 0), current + 1)
                                  )
                                }
                                aria-label="Next page"
                              >
                                <ChevronRight className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          <div className="h-3 w-px bg-white/20 mx-1"></div>
                          <button
                            type="button"
                            disabled={!canZoomOut}
                            className="p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                            onClick={() => setPreviewZoom((current) => Math.max(0.75, Number((current - 0.25).toFixed(2))))}
                            aria-label="Zoom out"
                          >
                            <ZoomOut className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            disabled={!canZoomIn}
                            className="p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                            onClick={() => setPreviewZoom((current) => Math.min(3, Number((current + 0.25).toFixed(2))))}
                            aria-label="Zoom in"
                          >
                            <ZoomIn className="h-4 w-4" />
                          </button>
                          <div className="h-3 w-px bg-white/20 mx-1 hidden sm:block"></div>
                          <button
                            type="button"
                            disabled={!activeSourceIsImage || previewZoom === DEFAULT_PREVIEW_ZOOM}
                            className="hidden sm:block p-1.5 rounded-lg text-slate-300 hover:bg-white/20 hover:text-white transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
                            onClick={() => setPreviewZoom(DEFAULT_PREVIEW_ZOOM)}
                            aria-label="Reset zoom"
                          >
                            <RotateCw className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 2. Data View */}
                {activeTab === 'data' && (
                  <div className="absolute inset-0 overflow-y-auto">
                    <div className="mx-auto max-w-5xl space-y-3 p-3 pb-5 sm:p-4">
                      {(activeFieldDataCount > 0 || activeDocumentLineItems.length > 0) && (
                        <div className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-white px-3 py-2 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
                              Data View
                            </div>
                            <div className="text-xs font-medium text-slate-700">
                              {activeDocument?.title ?? "Selected document"}
                            </div>
                          </div>
                          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
                            <button
                              type="button"
                              className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                                activeDataView === "fields"
                                  ? "bg-white text-slate-950 shadow-sm"
                                  : "text-slate-500 hover:text-slate-800"
                              }`}
                              onClick={() => setActiveDataView("fields")}
                            >
                              Fields ({activeFieldDataCount})
                            </button>
                            <button
                              type="button"
                              disabled={activeDocumentLineItems.length === 0}
                              className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                                activeDataView === "lineItems"
                                  ? "bg-white text-slate-950 shadow-sm"
                                  : "text-slate-500 hover:text-slate-800"
                              }`}
                              onClick={() => setActiveDataView("lineItems")}
                            >
                              Line items ({activeDocumentLineItems.length})
                            </button>
                          </div>
                        </div>
                      )}

                      {activeFieldDataCount === 0 && activeDocumentLineItems.length === 0 ? (
                        <div className="py-12 text-center text-sm font-medium text-slate-500">
                          No specific fields extracted for this document type.
                        </div>
                      ) : activeDataView === "fields" && activeFieldDataCount > 0 ? (
                        <div className="space-y-3">
                          {(activeTermsChecklistRows.length > 0 || unmatchedTermsIssues.length > 0) && (
                            <div className="overflow-hidden rounded-xl border border-slate-100 bg-white shadow-sm">
                              <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                  <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                                    Terms & Conditions Compliance Checklist
                                  </div>
                                  <div className="mt-1 text-xs font-medium text-slate-700">
                                    {activeTermsChecklistRows.length} clause{activeTermsChecklistRows.length === 1 ? "" : "s"} extracted from this document.
                                  </div>
                                </div>
                                <div
                                  className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                                    activeTermsIssues.length > 0
                                      ? "border-amber-200 bg-amber-50 text-amber-700"
                                      : "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  }`}
                                >
                                  {activeTermsIssues.length > 0 ? (
                                    <TriangleAlert className="h-3.5 w-3.5" />
                                  ) : (
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                  )}
                                  {activeTermsIssues.length > 0
                                    ? `${activeTermsIssues.length} issue${activeTermsIssues.length === 1 ? "" : "s"} flagged`
                                    : "No issue flagged"}
                                </div>
                              </div>

                              <div className="divide-y divide-slate-100">
                                {activeTermsChecklistRows.map((row) => {
                                  const StatusIcon = row.status.icon;

                                  return (
                                    <div
                                      key={row.key}
                                      className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
                                    >
                                      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                                        {row.label}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="whitespace-pre-wrap break-words text-xs font-medium leading-snug text-slate-900">
                                          {row.value}
                                        </div>
                                        {row.detail ? (
                                          <div className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                                            {row.detail}
                                          </div>
                                        ) : null}
                                        {row.evidence ? (
                                          <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs font-medium leading-relaxed text-slate-700">
                                            {row.evidence}
                                          </div>
                                        ) : null}
                                        {row.issue?.analysis ? (
                                          <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-medium leading-relaxed text-amber-800">
                                            {row.issue.analysis}
                                          </div>
                                        ) : null}
                                      </div>
                                      <div
                                        className={`inline-flex h-fit w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${row.status.className}`}
                                      >
                                        <StatusIcon className="h-3.5 w-3.5" />
                                        {row.status.label}
                                      </div>
                                    </div>
                                  );
                                })}

                                {unmatchedTermsIssues.map((issue) => {
                                  const status = getTermsIssueStatus(issue);
                                  const StatusIcon = status.icon;
                                  const issueText =
                                    issue.analysis ||
                                    issue.fixPlan ||
                                    getTermsIssueText(issue) ||
                                    "Terms issue requires review.";

                                  return (
                                    <div
                                      key={issue.id}
                                      className="grid gap-2 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
                                    >
                                      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                                        Review Item
                                      </div>
                                      <div className="min-w-0 whitespace-pre-wrap break-words text-xs font-medium leading-snug text-slate-900">
                                        {issueText}
                                      </div>
                                      <div
                                        className={`inline-flex h-fit w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${status.className}`}
                                      >
                                        <StatusIcon className="h-3.5 w-3.5" />
                                        {status.label}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {activeDocumentFieldEntries.length > 0 ? (
                            <div className="flex flex-col overflow-hidden rounded-xl border border-slate-100 text-sm shadow-sm">
                              {activeDocumentFieldEntries.map(([key, value], index) => {
                                const currentValue = typeof value === "string" ? value : displayValue(value);

                                return (
                                  <div key={key} className={`flex flex-col bg-white px-3 py-2.5 transition-colors hover:bg-slate-50/50 sm:grid sm:grid-cols-[13rem_minmax(0,1fr)] sm:items-start sm:gap-4 sm:px-4 sm:py-3 ${index !== activeDocumentFieldEntries.length - 1 ? 'border-b border-slate-100' : ''}`}>
                                    <div className="mb-1 w-full pr-4 sm:mb-0">
                                      <div className="flex items-center gap-2 text-[11px] font-medium text-slate-500">
                                        {getDocumentFieldLabel(activeDocument?.documentType, key)}
                                      </div>
                                    </div>
                                    <div className="w-full break-words text-sm font-medium leading-snug text-slate-900">
                                      {currentValue || <span className="font-normal italic text-slate-300">Not detected</span>}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          ) : null}
                        </div>
                      ) : activeDataView === "fields" ? (
                        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-medium text-slate-500">
                          No scalar fields were extracted for this document.
                        </div>
                      ) : null}

                      {activeDataView === "lineItems" && activeDocumentLineItems.length > 0 && (
                        <div className="rounded-xl border border-slate-100 bg-white shadow-sm">
                          <div className="flex flex-col gap-1 border-b border-slate-100 px-4 py-2.5">
                            <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                              Line Items
                            </div>
                            <div className="text-xs font-medium text-slate-700">
                              {activeDocumentLineItems.length} row{activeDocumentLineItems.length === 1 ? "" : "s"} extracted from the document table.
                            </div>
                          </div>
                          <div className="overflow-x-auto">
                            <table className="w-full min-w-[760px] border-collapse text-left text-xs sm:text-sm">
                              <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                                <tr>
                                  {activeDocumentLineItemColumns.map((column) => (
                                    <th
                                      key={column.key}
                                      className={`border-b border-slate-100 px-3 py-2 font-medium ${column.className ?? ""}`}
                                    >
                                      {column.label}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {activeDocumentLineItems.map((item, itemIndex) => (
                                  <tr key={`${item.lineNumber ?? itemIndex}-${item.description ?? item.rawText ?? ""}`} className="border-b border-slate-100 last:border-0">
                                    {activeDocumentLineItemColumns.map((column) => {
                                      const value =
                                        column.key === "lineNumber"
                                          ? getLineItemValue(item, column.key) || String(itemIndex + 1)
                                          : getLineItemValue(item, column.key);

                                      return (
                                        <td
                                          key={column.key}
                                          className={`align-top px-3 py-3 font-medium text-slate-800 ${column.className ?? ""}`}
                                        >
                                          {value ? String(value) : <span className="text-slate-300">-</span>}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      {activeDataView === "lineItems" && activeDocumentLineItems.length === 0 && (
                        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm font-medium text-slate-500">
                          No line-item table was extracted for this document.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

          </main>
        </div>

        {/* Mobile Sticky Action Bar */}
        {showActions && (
          <div
            className={styles.mobileActionBar}
            style={{ bottom: "calc(5.25rem + env(safe-area-inset-bottom))" }}
          >
            <Button
              variant="outline"
              className={`${styles.mobileActionButton} text-rose-600 hover:bg-rose-50 hover:text-rose-700 border-slate-200 shadow-sm font-medium`}
              disabled={decisionStatus === "updating"}
              onClick={() => handleCaseDecision("rejected")}
            >
              <X className="h-5 w-5 mr-2" /> Reject
            </Button>
            <Button
              className={`${styles.mobileActionButton} bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm font-medium`}
              disabled={decisionStatus === "updating"}
              onClick={() => handleCaseDecision("accepted")}
            >
              {decisionStatus === "updating" ? (
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
              ) : (
                <Check className="h-5 w-5 mr-2" />
              )}
              Accept
            </Button>
          </div>
        )}

        <AnalysisOptionsDialog
          open={analysisOptionsOpen}
          onOpenChange={setAnalysisOptionsOpen}
          onSelect={(nextOptions) => {
            setAnalysisOptionsOpen(false);
            void handleAnalyzeDraftCase(nextOptions, pendingAnalysisMode);
          }}
        />

        <Dialog open={isTallyReviewOpen} onOpenChange={setIsTallyReviewOpen}>
          <DialogContent className={styles.tallyReviewDialog}>
            <DialogHeader className={styles.tallyReviewDialogHeader}>
              <DialogTitle className={styles.tallyReviewDialogTitle}>
                Approved case · Tally review
              </DialogTitle>
              <DialogDescription className={styles.tallyReviewDialogDescription}>
                Review the prepared Purchase voucher and posting status without leaving the case workspace.
              </DialogDescription>
            </DialogHeader>
            <div className={styles.tallyReviewDialogBody}>
              {isTallyReviewOpen ? (
                <TallyInReviewPanel
                  caseId={caseId}
                  onViewOriginal={(documentId) => {
                    setActiveDocumentId(documentId);
                    setActiveTab("preview");
                    setIsTallyReviewOpen(false);
                  }}
                />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  );
}

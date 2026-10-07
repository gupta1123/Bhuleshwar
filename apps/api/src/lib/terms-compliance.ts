import type { Mismatch } from "@/types/pipeline";

export const TERMS_COMPLIANCE_FIELD = "termsAndConditions";
export const TERMS_COMPLIANCE_MISMATCH_MODE = "actionableOnly";

type StoredTermsMismatchLike = {
  fieldName?: unknown;
  field_name?: unknown;
  values?: unknown;
  values_json?: unknown;
  analysis?: unknown;
  fixPlan?: unknown;
  fix_plan?: unknown;
};

function normalizeStatusText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function valuesText(values: unknown) {
  if (!Array.isArray(values)) return "";

  return values
    .map((entry) => {
      if (!entry || typeof entry !== "object") return String(entry ?? "");
      const value = (entry as Record<string, unknown>).value;
      return value === null || value === undefined ? "" : String(value);
    })
    .filter(Boolean)
    .join(" ");
}

function termsMismatchText(input: {
  values?: unknown;
  analysis?: unknown;
  fixPlan?: unknown;
  fix_plan?: unknown;
}) {
  return normalizeStatusText(
    [
      input.analysis,
      input.fixPlan,
      input.fix_plan,
      valuesText(input.values),
    ]
      .filter((value) => value !== null && value !== undefined)
      .join(" ")
  );
}

export function isActionableTermsComplianceStatus(status: unknown) {
  return normalizeStatusText(status) === "not fulfilled";
}

export function isActionableTermsComplianceText(input: {
  values?: unknown;
  analysis?: unknown;
  fixPlan?: unknown;
  fix_plan?: unknown;
}) {
  const text = termsMismatchText(input);
  if (!text) return false;

  return /\bnot fulfilled\b/.test(text);
}

export function isActionableTermsComplianceMismatch(
  mismatch: Pick<Mismatch, "field" | "values" | "analysis" | "fixPlan">
) {
  if (mismatch.field !== TERMS_COMPLIANCE_FIELD) return true;
  return isActionableTermsComplianceText(mismatch);
}

export function isActionableStoredTermsComplianceMismatch(mismatch: StoredTermsMismatchLike) {
  const fieldName = String(mismatch.fieldName ?? mismatch.field_name ?? "");
  if (fieldName !== TERMS_COMPLIANCE_FIELD) return true;

  return isActionableTermsComplianceText({
    values: mismatch.values ?? mismatch.values_json,
    analysis: mismatch.analysis,
    fixPlan: mismatch.fixPlan,
    fix_plan: mismatch.fix_plan,
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isLegacyMaterialUnknownChecklistItem(value: unknown) {
  const record = readRecord(value);
  const status = normalizeStatusText(record.status);
  const severity = normalizeStatusText(record.severity);

  return status === "unknown" && (severity === "high" || severity === "medium");
}

export function getLegacyHiddenTermsReviewCount(processingMeta: unknown) {
  const meta = readRecord(processingMeta);
  if (meta.termsComplianceMismatchMode === TERMS_COMPLIANCE_MISMATCH_MODE) {
    return 0;
  }

  const checklist = meta.termsComplianceChecklist;
  if (!Array.isArray(checklist)) {
    return 0;
  }

  return checklist.filter(isLegacyMaterialUnknownChecklistItem).length;
}

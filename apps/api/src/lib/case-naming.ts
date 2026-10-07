import { callOpenRouter } from "@/lib/processing/openrouter";
import type { CaseSummary } from "@/lib/case-summary";
import type { CaseDoc, FieldKey } from "@/types/pipeline";

const SUBJECT_CANDIDATE_FIELDS: FieldKey[] = [
  "vendorName",
  "buyerName",
  "ownerName",
  "transporterName",
  "holderName",
  "driverName",
];

type SubjectCandidate = {
  name: string;
  field: FieldKey;
  documentType: string;
  score: number;
};

const SUBJECT_DOC_TYPE_SCORES: Record<string, number> = {
  "Purchase Order": 10,
  "Amended Purchase Order": 10,
  "Tax Invoice": 8,
  Invoice: 8,
  "E-Way Bill": 7,
  "Delivery Note": 6,
  "Delivery Challan": 6,
  "Lorry Receipt": 4,
  "Weighment Slip": 3,
  "Material Test Certificate": 3,
};

const SUBJECT_FIELD_SCORES: Partial<Record<FieldKey, number>> = {
  vendorName: 8,
  buyerName: 5,
  ownerName: 4,
  transporterName: 3,
  holderName: 2,
  driverName: 2,
};

function normalizeValue(value?: string | null) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeMatchKey(value: string) {
  return normalizeValue(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeInternalNameHints(values: string[]) {
  return values.map((value) => normalizeMatchKey(value)).filter(Boolean);
}

function isInternalName(value: string, internalHints: string[]) {
  const key = normalizeMatchKey(value);
  if (!key) return false;
  return normalizeInternalNameHints(internalHints).some((hint) => key.includes(hint));
}

function collectSubjectCandidates(documents: CaseDoc[]) {
  const deduped = new Map<string, SubjectCandidate>();

  for (const document of documents) {
    for (const field of SUBJECT_CANDIDATE_FIELDS) {
      const value = normalizeValue(document.fields[field]);
      if (!value) {
        continue;
      }

      const key = normalizeMatchKey(value);
      if (!key) {
        continue;
      }

      const candidate = {
        name: value,
        field,
        documentType: document.type,
        score: (SUBJECT_DOC_TYPE_SCORES[document.type] ?? 0) + (SUBJECT_FIELD_SCORES[field] ?? 0),
      };
      const current = deduped.get(key);
      if (!current || candidate.score > current.score) {
        deduped.set(key, candidate);
      }
    }
  }

  return Array.from(deduped.values()).sort((left, right) => right.score - left.score);
}

function composeDisplayName(subjectName: string, summary: CaseSummary) {
  const reference = normalizeValue(summary.invoiceNumber || summary.poNumber || summary.primaryReference);
  return reference ? `${subjectName} / ${reference}` : subjectName;
}

function getInternalNameHints() {
  const configured =
    process.env.CASE_NAMING_INTERNAL_HINTS ||
    process.env.INTERNAL_COMPANY_NAMES ||
    "kalika,kalika steel,kalika steels,kalika steel alloys,kalika steel alloys pvt ltd,kalika steel alloys private limited";
  return configured
    .split(",")
    .map((value) => normalizeValue(value))
    .filter((value) => value.length > 0);
}

export async function resolveCaseDisplayNameWithAI(
  documents: CaseDoc[],
  summary: CaseSummary
) {
  const candidates = collectSubjectCandidates(documents);
  if (candidates.length === 0) {
    return summary.displayName;
  }

  const internalHints = getInternalNameHints();
  const externalCandidates = candidates.filter((candidate) => !isInternalName(candidate.name, internalHints));
  const candidatePool = externalCandidates.length ? externalCandidates : candidates;
  const deterministicFallback = composeDisplayName(candidatePool[0].name, summary);

  // Case naming is deterministic for normal packets. Keep the optional AI tie-breaker
  // behind an explicit flag so a cosmetic title cannot add a provider round-trip to
  // every analysis job.
  if (process.env.CASE_NAMING_AI_ENABLED !== "true") {
    return deterministicFallback;
  }

  try {
    const response = await callOpenRouter(
      [
        {
          role: "system",
          content:
            "You choose the best company or party name for a procurement case title. " +
            "Return only JSON with a single key named selectedName. " +
            "Prefer the external counterparty or supplier name that best identifies the case. " +
            "Never choose an internal buyer/operator name when another plausible external company name exists. " +
            "For Kalika procurement packets, prefer the supplier/vendor over Kalika. " +
            "If no better name exists, choose the clearest valid candidate from the list.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "Select the best subject name for this case title.",
            currentDeterministicDisplayName: summary.displayName,
            packetCategory: summary.packetCategory,
            primaryReference: summary.invoiceNumber || summary.poNumber || summary.primaryReference || null,
            internalNameHints: internalHints,
            candidates: candidatePool,
          }),
        },
      ],
      { expectJson: true }
    );

    const parsed = JSON.parse(response) as { selectedName?: unknown };
    const selectedName =
      typeof parsed.selectedName === "string" ? normalizeValue(parsed.selectedName) : "";

    if (!selectedName) {
      return deterministicFallback;
    }

    const matchedCandidate = candidatePool.find(
      (candidate) => normalizeMatchKey(candidate.name) === normalizeMatchKey(selectedName)
    );

    if (!matchedCandidate) {
      return deterministicFallback;
    }

    return composeDisplayName(matchedCandidate.name, summary);
  } catch {
    return deterministicFallback;
  }
}

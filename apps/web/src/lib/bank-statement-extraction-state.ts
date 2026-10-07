type PreviewExtractionState = {
  requiresManualExtraction?: boolean;
  transactions: unknown[];
  extractionDiagnostics?: {
    coverageComplete?: boolean;
  } | null;
};

export function isPreviewExtractionIncomplete(payload: PreviewExtractionState | null | undefined) {
  if (!payload || payload.transactions.length === 0) return true;
  const coverageComplete = payload.extractionDiagnostics?.coverageComplete;
  if (coverageComplete === true) return false;
  if (coverageComplete === false) return true;
  return Boolean(payload.requiresManualExtraction);
}

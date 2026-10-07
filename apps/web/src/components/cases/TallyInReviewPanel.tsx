"use client";

import { TallyPurchasePostingPanel } from "@/components/cases/TallyPurchasePostingPanel";

export function TallyInReviewPanel({
  caseId,
  onViewOriginal,
}: {
  caseId: string;
  onViewOriginal?: (documentId: string) => void;
}) {
  return (
    <TallyPurchasePostingPanel
      caseId={caseId}
    />
  );
}

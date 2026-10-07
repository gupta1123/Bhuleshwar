"use client";

import React from "react";

export type PdfEvidencePreviewProps = {
  url: string;
  pageNumber: number;
  zoom?: number;
  highlightText?: string | null;
  highlightQueries?: string[];
  highlightLabel?: string | null;
  highlightOccurrence?: number;
  highlightMode?: "text" | "row";
  searchPageStart?: number;
  searchPageEnd?: number;
  onHighlightPageChange?: (pageNumber: number) => void;
  onPageCountChange?: (pageCount: number) => void;
};

export function PdfEvidencePreview({
  url,
  pageNumber = 1,
  zoom = 1,
  highlightText,
  highlightQueries,
  searchPageStart,
  searchPageEnd,
  onHighlightPageChange,
}: PdfEvidencePreviewProps) {
  const query = (highlightText || highlightQueries?.[0] || "").trim();
  const shouldSearch = query.length >= 2 && query.toLowerCase() !== "not detected" && query !== "-" && query.length <= 120;
  const safeZoom = Number.isFinite(zoom) ? Math.min(3, Math.max(0.75, zoom)) : 1;
  const zoomParam = Math.round(safeZoom * 100);
  const isDefaultZoom = zoomParam === 100;
  // Default: fit width so no left/right scroll (FitH fits width in Chrome viewer). Only use explicit #zoom when user actively zoomed.
  const src = shouldSearch
    ? `${url}#page=${pageNumber}${isDefaultZoom ? "&view=FitH" : `&zoom=${zoomParam}`}&search=${encodeURIComponent(query)}&toolbar=0&navpanes=0`
    : isDefaultZoom
      ? `${url}#page=${pageNumber}&view=FitH&toolbar=0&navpanes=0`
      : `${url}#page=${pageNumber}&zoom=${zoomParam}&toolbar=0&navpanes=0`;

  return (
    <div
      className="relative w-full h-full min-h-[400px] bg-[#ede6d9] flex flex-col"
      data-search-start={searchPageStart}
      data-search-end={searchPageEnd}
      data-highlight={shouldSearch ? query : undefined}
      data-zoom={zoomParam}
    >
      <iframe
        key={`${url}-${pageNumber}-${shouldSearch ? query : ""}-${zoomParam}`}
        src={src}
        className="w-full h-full min-h-[400px] border-0 bg-white flex-1"
        title="PDF Preview"
        onLoad={() => {
          if (shouldSearch && onHighlightPageChange) {
            // viewer jumps via #search
          }
        }}
      />
    </div>
  );
}

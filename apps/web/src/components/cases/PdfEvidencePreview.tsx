"use client";

import React, { useEffect, useRef, useState } from "react";

export type PdfEvidencePreviewProps = {
  url: string;
  pageNumber: number;
  zoom?: number;
  /** "width" fills the pane width (default); "page" shows the whole page at once. */
  fitMode?: "width" | "page";
  /** Extra clockwise rotation in degrees, a multiple of 90, for sideways scans. */
  rotation?: number;
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

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf");
type PdfDocument = Awaited<ReturnType<PdfJsModule["getDocument"]>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;
type HighlightBox = { left: number; top: number; width: number; height: number };

let pdfJsPromise: Promise<PdfJsModule> | null = null;

function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist/legacy/build/pdf").then((lib) => {
      if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
        lib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url
        ).toString();
      }
      return lib;
    });
    pdfJsPromise.catch(() => {
      pdfJsPromise = null;
    });
  }
  return pdfJsPromise;
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// Text items of a page joined into one string so a query can span several items.
async function readPageText(page: PdfPage) {
  const content = await page.getTextContent();
  const spans: { start: number; end: number; item: (typeof content.items)[number] }[] = [];
  let text = "";
  for (const item of content.items) {
    const str = typeof item.str === "string" ? item.str : "";
    if (!str) continue;
    const start = text.length;
    text += str.toLowerCase();
    spans.push({ start, end: text.length, item });
    text += " ";
  }
  return { text, spans };
}

function findMatchRange(text: string, query: string, occurrence: number) {
  let from = 0;
  let found = -1;
  for (let seen = 0; seen <= Math.max(0, occurrence); seen += 1) {
    found = text.indexOf(query, from);
    if (found === -1) return null;
    from = found + query.length;
  }
  return { start: found, end: found + query.length };
}

export function PdfEvidencePreview({
  url,
  pageNumber = 1,
  zoom = 1,
  fitMode = "width",
  rotation = 0,
  highlightText,
  highlightQueries,
  highlightOccurrence = 0,
  searchPageStart,
  searchPageEnd,
  onHighlightPageChange,
  onPageCountChange,
}: PdfEvidencePreviewProps) {
  const rawQuery = (highlightText || highlightQueries?.[0] || "").trim();
  const query = normalizeSearchText(rawQuery);
  const shouldSearch =
    query.length >= 2 && query !== "not detected" && query !== "-" && query.length <= 120;
  const safeZoom = Number.isFinite(zoom) ? Math.min(3, Math.max(0.75, zoom)) : 1;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onPageCountChangeRef = useRef(onPageCountChange);
  const onHighlightPageChangeRef = useRef(onHighlightPageChange);
  useEffect(() => {
    onPageCountChangeRef.current = onPageCountChange;
    onHighlightPageChangeRef.current = onHighlightPageChange;
  });

  const [pdf, setPdf] = useState<{ url: string; doc: PdfDocument } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const containerWidth = containerSize.width;
  const safeRotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [boxes, setBoxes] = useState<HighlightBox[]>([]);
  const scannedKeyRef = useRef("");

  // Load the document once per url. Any failure drops back to the browser's own viewer below.
  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;

    (async () => {
      try {
        const [lib, response] = await Promise.all([loadPdfJs(), fetch(url)]);
        if (!response.ok) throw new Error(`Preview request failed (${response.status}).`);
        const data = new Uint8Array(await response.arrayBuffer());
        const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        loaded = doc;
        setPdf({ url, doc });
        onPageCountChangeRef.current?.(doc.numPages);
      } catch (error) {
        if (cancelled) return;
        console.warn("Falling back to the browser PDF viewer", error);
        setFailedUrl(url);
      }
    })();

    return () => {
      cancelled = true;
      scannedKeyRef.current = "";
      if (loaded) void loaded.destroy();
    };
  }, [url]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerSize({
        width: Math.floor(entry?.contentRect.width ?? container.clientWidth),
        height: Math.floor(entry?.contentRect.height ?? container.clientHeight),
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const doc = pdf?.url === url ? pdf.doc : null;
  const usingFallback = failedUrl === url;

  // If the evidence text is not on this page, look through the document's page range once per query.
  useEffect(() => {
    if (!doc || !shouldSearch) return;
    const key = `${url}|${query}|${searchPageStart ?? ""}|${searchPageEnd ?? ""}`;
    if (scannedKeyRef.current === key) return;
    scannedKeyRef.current = key;

    let cancelled = false;
    (async () => {
      const first = Math.max(1, searchPageStart ?? 1);
      const last = Math.min(doc.numPages, searchPageEnd ?? doc.numPages);
      const order: number[] = [];
      for (let page = pageNumber; page <= last; page += 1) order.push(page);
      for (let page = first; page < pageNumber; page += 1) order.push(page);
      for (const page of order) {
        if (cancelled) return;
        const { text } = await readPageText(await doc.getPage(page));
        if (cancelled) return;
        if (text.includes(query)) {
          if (page !== pageNumber) onHighlightPageChangeRef.current?.(page);
          return;
        }
      }
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      scannedKeyRef.current = "";
    };
    // pageNumber is deliberately left out: the scan runs per query, not on every page turn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, url, query, shouldSearch, searchPageStart, searchPageEnd]);

  // Draw the current page and, when there is a query, the highlight boxes on top of it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!doc || !canvas || containerWidth <= 0) return;

    let cancelled = false;
    let renderTask: { cancel(): void } | null = null;

    (async () => {
      const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
      if (cancelled) return;

      const pageRotation = ((page.rotate || 0) + safeRotation) % 360;
      const base = page.getViewport({ scale: 1, rotation: pageRotation });
      const widthScale = Math.max(280, containerWidth - 2) / base.width;
      // Whole-page fit also has to respect the pane height (minus a little breathing room).
      const fitScale =
        fitMode === "page" && containerSize.height > 0
          ? Math.min(widthScale, Math.max(200, containerSize.height - 8) / base.height)
          : widthScale;
      const cssScale = fitScale * safeZoom;
      const viewport = page.getViewport({ scale: cssScale, rotation: pageRotation });
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      const renderViewport = page.getViewport({
        scale: cssScale * pixelRatio,
        rotation: pageRotation,
      });

      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = Math.round(renderViewport.width);
      canvas.height = Math.round(renderViewport.height);
      setPageSize({ width: viewport.width, height: viewport.height });

      const task = page.render({ canvasContext: context, viewport: renderViewport });
      renderTask = task;
      await task.promise;
      if (cancelled) return;

      if (!shouldSearch) {
        setBoxes([]);
        return;
      }

      const { Util } = await loadPdfJs();
      const { text, spans } = await readPageText(page);
      if (cancelled) return;
      const range = findMatchRange(text, query, highlightOccurrence);
      if (!range) {
        setBoxes([]);
        return;
      }

      setBoxes(
        spans
          .filter((span) => span.end > range.start && span.start < range.end)
          .map(({ item }) => {
            // (a,b) runs along the text and (c,d) up its height, in rotated page space.
            const [a, b, c, d, e, f] = Util.transform(viewport.transform, item.transform);
            const run = Math.hypot(a, b) || 1;
            const advanceX = (a / run) * item.width * cssScale;
            const advanceY = (b / run) * item.width * cssScale;
            const xs = [e, e + advanceX, e + advanceX + c, e + c];
            const ys = [f, f + advanceY, f + advanceY + d, f + d];
            const left = Math.min(...xs);
            const top = Math.min(...ys);
            return {
              left,
              top,
              width: Math.max(...xs) - left,
              height: Math.max(...ys) - top,
            };
          })
      );
    })().catch((error) => {
      if (cancelled || (error as { name?: string })?.name === "RenderingCancelledException") return;
      console.warn("Unable to render PDF page", error);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [
    doc,
    pageNumber,
    safeZoom,
    containerWidth,
    containerSize.height,
    fitMode,
    safeRotation,
    shouldSearch,
    query,
    highlightOccurrence,
  ]);

  // A new page, file, rotation or fit mode starts at the top-left, not wherever the last page was scrolled.
  useEffect(() => {
    containerRef.current?.scrollTo({ top: 0, left: 0 });
  }, [url, pageNumber, safeRotation, fitMode]);

  if (usingFallback) {
    const zoomParam = Math.round(safeZoom * 100);
    const view = zoomParam === 100 ? "view=FitH" : `zoom=${zoomParam}`;
    const search = shouldSearch ? `&search=${encodeURIComponent(rawQuery)}` : "";
    return (
      <div className="relative w-full h-full min-h-[400px] bg-[#ede6d9] flex flex-col">
        <iframe
          src={`${url}#page=${pageNumber}&${view}${search}&toolbar=0&navpanes=0`}
          className="w-full h-full min-h-[400px] border-0 bg-white flex-1"
          title="PDF Preview"
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full min-h-[400px] bg-[#ede6d9] overflow-auto"
      data-highlight={shouldSearch ? rawQuery : undefined}
      data-zoom={Math.round(safeZoom * 100)}
    >
      {!doc && (
        <div className="flex h-full min-h-[400px] items-center justify-center text-sm text-neutral-500">
          Loading PDF…
        </div>
      )}
      <div
        className="relative mx-auto bg-white"
        style={{
          width: pageSize?.width,
          height: pageSize?.height,
          display: doc ? "block" : "none",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: pageSize?.width, height: pageSize?.height, display: "block" }}
        />
        {boxes.map((box, index) => (
          <div
            key={index}
            className="pointer-events-none absolute rounded-sm bg-yellow-300/50 ring-1 ring-yellow-500/70"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          />
        ))}
      </div>
    </div>
  );
}

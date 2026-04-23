import { useEffect, useMemo, useRef, useState } from "react";
import type { PdfRegionSelection } from "../../shared/types";

type PdfPageRender = {
  width: number;
  height: number;
};

type PdfTextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type PDFDocumentSurfaceProps = {
  fileName: string;
  pdfDataBase64: string;
  selection: PdfRegionSelection | null;
  onSelectionChange: (selection: PdfRegionSelection | null) => void;
  readOnly?: boolean;
  visiblePageIndex?: number | null;
  onPageCountChange?: (pageCount: number) => void;
};

type DraftSelection = {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeRect(x1: number, y1: number, x2: number, y2: number) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  return { x: left, y: top, w: width, h: height };
}

export function PDFDocumentSurface({
  fileName,
  pdfDataBase64,
  selection,
  onSelectionChange,
  readOnly = false,
  visiblePageIndex = null,
  onPageCountChange,
}: PDFDocumentSurfaceProps) {
  const pageCanvases = useRef<Array<HTMLCanvasElement | null>>([]);
  const pageLayers = useRef<Array<HTMLDivElement | null>>([]);
  const pageTextItems = useRef<Array<PdfTextItem[]>>([]);
  const dragStartRef = useRef<{ pageIndex: number; x: number; y: number } | null>(null);
  const [pageRenders, setPageRenders] = useState<PdfPageRender[]>([]);
  const [draftSelection, setDraftSelection] = useState<DraftSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => Promise<void>) | null = null;

    const renderPdf = async () => {
      setLoading(true);
      setError(null);
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/legacy/build/pdf.worker.mjs",
          import.meta.url,
        ).toString();
        const loadingTask = pdfjs.getDocument({ data: base64ToUint8Array(pdfDataBase64) });
        const document = await loadingTask.promise;
        if (!cancelled) {
          onPageCountChange?.(document.numPages);
        }
        cleanup = async () => {
          await loadingTask.destroy();
          if (typeof document.destroy === "function") {
            await document.destroy();
          }
        };

        const nextPages: PdfPageRender[] = [];
        for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
          const page = await document.getPage(pageIndex + 1);
          const viewport = page.getViewport({ scale: 1.25 });
          nextPages.push({ width: viewport.width, height: viewport.height });
          const textContent = await page.getTextContent();
          const typedTextItems = (textContent.items as Array<{
            str?: unknown;
            transform: number[];
            width?: number;
            height?: number;
          }>)
            .filter((item) => typeof item.str === "string" && item.str.trim().length > 0)
            .map((item) => {
              const text = item.str as string;
              const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
              return {
                str: text,
                x,
                y,
                width: Math.max(0, Number(item.width || 0)),
                height: Math.max(0, Number(item.height || 0)),
              };
            });
          pageTextItems.current[pageIndex] = typedTextItems;
          if (cancelled) return;
          setPageRenders((prev) => {
            const cloned = [...prev];
            cloned[pageIndex] = { width: viewport.width, height: viewport.height };
            return cloned;
          });
          requestAnimationFrame(async () => {
            const canvas = pageCanvases.current[pageIndex];
            if (!canvas) return;
            const context = canvas.getContext("2d");
            if (!context) return;
            const devicePixelRatio = window.devicePixelRatio || 1;
            canvas.width = Math.floor(viewport.width * devicePixelRatio);
            canvas.height = Math.floor(viewport.height * devicePixelRatio);
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
            await page.render({ canvas, canvasContext: context, viewport }).promise;
          });
        }
        if (!cancelled) {
          setPageRenders(nextPages);
        }
      } catch (renderError: unknown) {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : "Failed to render PDF");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void renderPdf();

    return () => {
      cancelled = true;
      if (cleanup) void cleanup();
    };
  }, [onPageCountChange, pdfDataBase64]);

  const selectionStyle = useMemo(() => {
    const target = draftSelection || selection;
    if (!target) return null;
    return {
      left: `${target.x * 100}%`,
      top: `${target.y * 100}%`,
      width: `${target.w * 100}%`,
      height: `${target.h * 100}%`,
    };
  }, [draftSelection, selection]);

  const getSelectionExcerpt = (pageIndex: number, rect: DraftSelection): string => {
    const items = pageTextItems.current[pageIndex] || [];
    const page = pageRenders[pageIndex];
    if (!page) return "";
    const selectionRect = {
      x: rect.x * page.width,
      y: rect.y * page.height,
      w: rect.w * page.width,
      h: rect.h * page.height,
    };
    const right = selectionRect.x + selectionRect.w;
    const bottom = selectionRect.y + selectionRect.h;
    const selected = items.filter((item) => {
      const itemRight = item.x + item.width;
      const itemBottom = item.y + item.height;
      return (
        item.x <= right + 8 &&
        itemRight >= selectionRect.x - 8 &&
        item.y <= bottom + 8 &&
        itemBottom >= selectionRect.y - 8
      );
    });
    selected.sort((a, b) => a.y - b.y || a.x - b.x);
    return selected.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
  };

  const updateDraft = (pageIndex: number, clientX: number, clientY: number) => {
    const layer = pageLayers.current[pageIndex];
    const start = dragStartRef.current;
    if (!layer || !start || start.pageIndex !== pageIndex) return;
    const rect = layer.getBoundingClientRect();
    const currentX = (clientX - rect.left) / rect.width;
    const currentY = (clientY - rect.top) / rect.height;
    setDraftSelection({
      pageIndex,
      ...normalizeRect(start.x, start.y, currentX, currentY),
    });
  };

  const commitDraft = () => {
    if (readOnly) {
      dragStartRef.current = null;
      setDraftSelection(null);
      return;
    }
    if (!draftSelection || draftSelection.w < 0.01 || draftSelection.h < 0.01) {
      onSelectionChange(null);
      setDraftSelection(null);
      dragStartRef.current = null;
      return;
    }
    onSelectionChange({
      kind: "pdf",
      pageIndex: draftSelection.pageIndex,
      x: draftSelection.x,
      y: draftSelection.y,
      w: draftSelection.w,
      h: draftSelection.h,
      excerpt:
        getSelectionExcerpt(draftSelection.pageIndex, draftSelection) ||
        `${fileName} page ${draftSelection.pageIndex + 1}`,
    });
    setDraftSelection(null);
    dragStartRef.current = null;
  };

  if (loading) {
    return <div className="document-editor-empty">Rendering PDF…</div>;
  }
  if (error) {
    return <div className="document-editor-error">{error}</div>;
  }

  return (
    <div className="pdf-document-surface">
      {pageRenders.map((page, pageIndex) => {
        if (typeof visiblePageIndex === "number" && pageIndex !== visiblePageIndex) return null;
        const showSelection =
          (draftSelection && draftSelection.pageIndex === pageIndex) ||
          (selection && selection.pageIndex === pageIndex);
        return (
          <div key={pageIndex} className="pdf-page-card">
            <div className="pdf-page-label">Page {pageIndex + 1}</div>
            <div
              className="pdf-page-layer"
              ref={(node) => {
                pageLayers.current[pageIndex] = node;
              }}
              style={{ width: `${page.width}px`, height: `${page.height}px` }}
              onPointerDown={
                readOnly
                  ? undefined
                  : (event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      dragStartRef.current = {
                        pageIndex,
                        x: (event.clientX - rect.left) / rect.width,
                        y: (event.clientY - rect.top) / rect.height,
                      };
                      setDraftSelection({ pageIndex, x: 0, y: 0, w: 0, h: 0 });
                      event.currentTarget.setPointerCapture(event.pointerId);
                      updateDraft(pageIndex, event.clientX, event.clientY);
                    }
              }
              onPointerMove={readOnly ? undefined : (event) => updateDraft(pageIndex, event.clientX, event.clientY)}
              onPointerUp={
                readOnly
                  ? undefined
                  : (event) => {
                      updateDraft(pageIndex, event.clientX, event.clientY);
                      event.currentTarget.releasePointerCapture(event.pointerId);
                      commitDraft();
                    }
              }
            >
              <canvas
                ref={(node) => {
                  pageCanvases.current[pageIndex] = node;
                }}
                className="pdf-page-canvas"
              />
              {!readOnly && showSelection && selectionStyle && (
                <div className="pdf-selection-box" style={selectionStyle} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

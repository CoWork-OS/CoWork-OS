import { useEffect, useMemo, useRef, useState } from "react";
import type { PdfRegionSelection } from "../../shared/types";
import {
  createPdfDocumentRenderer,
  type PdfPageRender,
  type PdfTextItem,
} from "./pdf-document-renderer";

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
  const pageLayers = useRef<Array<HTMLDivElement | null>>([]);
  const pageTextItems = useRef<Array<PdfTextItem[]>>([]);
  const onPageCountChangeRef = useRef(onPageCountChange);
  onPageCountChangeRef.current = onPageCountChange;
  const dragStartRef = useRef<{ pageIndex: number; x: number; y: number } | null>(null);
  const [pageRenders, setPageRenders] = useState<PdfPageRender[]>([]);
  const [draftSelection, setDraftSelection] = useState<DraftSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setPageRenders([]);
    setDraftSelection(null);
    dragStartRef.current = null;
    pageTextItems.current = [];
    const renderer = createPdfDocumentRenderer({
      openDocument: async () => {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/legacy/build/pdf.worker.mjs",
          import.meta.url,
        ).toString();
        return pdfjs.getDocument({ data: base64ToUint8Array(pdfDataBase64) });
      },
      onPages: (pages) => {
        pageTextItems.current = pages.map((page) => page.textItems);
        setPageRenders(pages);
        setLoading(false);
        onPageCountChangeRef.current?.(pages.length);
      },
      onError: (message) => {
        setError(message);
        setLoading(false);
      },
    });
    return renderer.dispose;
  }, [pdfDataBase64]);

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
    return selected
      .map((item) => item.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
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
              onPointerMove={
                readOnly
                  ? undefined
                  : (event) => updateDraft(pageIndex, event.clientX, event.clientY)
              }
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
              <canvas ref={page.mountCanvas} className="pdf-page-canvas" />
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

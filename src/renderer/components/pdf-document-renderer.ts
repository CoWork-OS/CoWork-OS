import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";

export type PdfTextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfPageRender = {
  width: number;
  height: number;
  textItems: PdfTextItem[];
  mountCanvas: (canvas: HTMLCanvasElement | null) => (() => void) | undefined;
};

/** Own one PDF's loading task and the renders of its currently mounted canvases. */
export function createPdfDocumentRenderer({
  openDocument,
  onPages,
  onError,
}: {
  openDocument: () => Promise<PDFDocumentLoadingTask>;
  onPages: (pages: PdfPageRender[]) => void;
  onError: (message: string) => void;
}) {
  let disposed = false;
  let loadingTask: PDFDocumentLoadingTask | null = null;
  const renderTasks = new Set<RenderTask>();
  const reportError = (error: unknown) => {
    if (!disposed) onError(error instanceof Error ? error.message : "Failed to render PDF");
  };
  const destroyDocument = () => {
    const task = loadingTask;
    loadingTask = null;
    if (task) {
      // A source can be replaced before its loading promise is awaited.
      void task.promise.catch(() => {});
      void task.destroy().catch(() => {});
    }
  };

  const ready = (async () => {
    try {
      loadingTask = await openDocument();
      if (disposed) {
        destroyDocument();
        return;
      }
      const document = await loadingTask.promise;
      if (disposed) return;
      const pages: PdfPageRender[] = [];
      for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
        const page = await document.getPage(pageIndex + 1);
        if (disposed) return;
        const viewport = page.getViewport({ scale: 1.25 });
        const textContent = await page.getTextContent();
        if (disposed) return;
        const textItems = textContent.items.flatMap((item) => {
          if (!("str" in item) || !item.str.trim()) return [];
          const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
          return [{ str: item.str, x, y, width: item.width, height: item.height }];
        });
        pages.push({
          width: viewport.width,
          height: viewport.height,
          textItems,
          // Stable per page: selection and parent callback changes do not
          // repaint it. A page becoming visible mounts a canvas and renders it.
          mountCanvas: (canvas) => {
            if (!canvas || disposed) return;
            let cancelled = false;
            let renderTask: RenderTask | null = null;
            try {
              const context = canvas.getContext("2d");
              if (!context) throw new Error("Could not create a canvas for the PDF preview.");
              const pixelRatio = window.devicePixelRatio || 1;
              canvas.width = Math.floor(viewport.width * pixelRatio);
              canvas.height = Math.floor(viewport.height * pixelRatio);
              canvas.style.width = `${viewport.width}px`;
              canvas.style.height = `${viewport.height}px`;
              renderTask = page.render({
                canvas,
                canvasContext: context,
                viewport,
                transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
              });
              const task = renderTask;
              renderTasks.add(task);
              void task.promise
                .catch((error: unknown) => {
                  if (!cancelled) reportError(error);
                })
                .finally(() => renderTasks.delete(task));
            } catch (error: unknown) {
              reportError(error);
            }
            return () => {
              cancelled = true;
              if (renderTask && renderTasks.delete(renderTask)) {
                renderTask.cancel();
              }
            };
          },
        });
      }
      if (!disposed) onPages(pages);
    } catch (error: unknown) {
      reportError(error);
    }
  })();

  return {
    ready,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const task of renderTasks) task.cancel();
      renderTasks.clear();
      destroyDocument();
    },
  };
}

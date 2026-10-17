import { afterEach, describe, expect, it, vi } from "vitest";
import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import { createPdfDocumentRenderer, type PdfPageRender } from "../pdf-document-renderer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePage(text = "Dinner notes") {
  const draw = deferred<void>();
  const cancel = vi.fn(() => draw.reject(new Error("Rendering cancelled")));
  return {
    draw,
    cancel,
    getViewport: vi.fn(() => ({
      width: 750,
      height: 990,
      convertToViewportPoint: (x: number, y: number) => [x, y],
    })),
    getTextContent: vi.fn(async () => ({
      items: [{ str: text, transform: [1, 0, 0, 1, 20, 30], width: 80, height: 12 }],
    })),
    render: vi.fn(() => ({ promise: draw.promise, cancel })),
  };
}

function makeCanvas(hasContext = true) {
  return {
    getContext: vi.fn(() => (hasContext ? {} : null)),
    style: {},
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

function makeRenderer(pages = [makePage()]) {
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  const getPage = vi.fn(async (pageNumber: number) => pages[pageNumber - 1]);
  const loadingTask = {
    promise: Promise.resolve({ numPages: pages.length, getPage }),
    destroy: vi.fn(async () => {}),
  };
  const onPages = vi.fn<(pages: PdfPageRender[]) => void>();
  const onError = vi.fn();
  const renderer = createPdfDocumentRenderer({
    openDocument: vi.fn(async () => loadingTask as unknown as PDFDocumentLoadingTask),
    onPages,
    onError,
  });
  return { renderer, loadingTask, onPages, onError, pages, getPage };
}

afterEach(() => vi.unstubAllGlobals());

describe("PDF document rendering lifecycle", () => {
  it("waits for the canvas mount before drawing a loaded page", async () => {
    const { renderer, onPages, pages, onError } = makeRenderer();
    await renderer.ready;
    const [page] = onPages.mock.calls[0][0];
    expect(pages[0].render).not.toHaveBeenCalled();
    expect(page.mountCanvas(null)).toBeUndefined();

    const canvas = makeCanvas();
    const unmount = page.mountCanvas(canvas);
    expect(pages[0].render).toHaveBeenCalledWith(
      expect.objectContaining({ canvas, transform: [2, 0, 0, 2, 0, 0] }),
    );
    expect(canvas.width).toBe(1500);
    expect(canvas.height).toBe(1980);
    expect(canvas.style).toMatchObject({ width: "750px", height: "990px" });
    expect(page.textItems).toEqual([{ str: "Dinner notes", x: 20, y: 30, width: 80, height: 12 }]);
    pages[0].draw.resolve();
    await pages[0].draw.promise;
    unmount?.();
    renderer.dispose();
    expect(onError).not.toHaveBeenCalled();
  });

  it("renders a newly visible page and cancels the page that was unmounted", async () => {
    const { renderer, onPages, pages, onError } = makeRenderer([makePage(), makePage("Page two")]);
    await renderer.ready;
    const [first, second] = onPages.mock.calls[0][0];
    const unmountFirst = first.mountCanvas(makeCanvas());
    expect(pages[1].render).not.toHaveBeenCalled();
    unmountFirst?.();
    const secondCanvas = makeCanvas();
    second.mountCanvas(secondCanvas);
    expect(pages[0].cancel).toHaveBeenCalledOnce();
    expect(pages[1].render).toHaveBeenCalledWith(expect.objectContaining({ canvas: secondCanvas }));
    renderer.dispose();
    await Promise.resolve();
    expect(pages[1].cancel).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("renders a page again when navigation mounts a fresh canvas", async () => {
    const { renderer, onPages, pages } = makeRenderer();
    await renderer.ready;
    const [page] = onPages.mock.calls[0][0];
    const firstDraw = page.mountCanvas(makeCanvas());
    firstDraw?.();
    const nextCanvas = makeCanvas();
    page.mountCanvas(nextCanvas);
    expect(pages[0].render).toHaveBeenCalledTimes(2);
    expect(pages[0].render).toHaveBeenLastCalledWith(
      expect.objectContaining({ canvas: nextCanvas }),
    );
    renderer.dispose();
  });

  it("reports an asynchronous drawing failure instead of leaving a silent blank canvas", async () => {
    const { renderer, onPages, pages, onError } = makeRenderer();
    await renderer.ready;
    onPages.mock.calls[0][0][0].mountCanvas(makeCanvas());
    pages[0].draw.reject(new Error("PDF image decoding failed"));
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith("PDF image decoding failed");
    renderer.dispose();
  });

  it("reports canvas and synchronous render failures", async () => {
    const { renderer, onPages, pages, onError } = makeRenderer();
    await renderer.ready;
    const [page] = onPages.mock.calls[0][0];
    page.mountCanvas(makeCanvas(false));
    expect(onError).toHaveBeenCalledWith("Could not create a canvas for the PDF preview.");
    pages[0].render.mockImplementationOnce(() => {
      throw new Error("PDF drawing failed");
    });
    page.mountCanvas(makeCanvas());
    expect(onError).toHaveBeenLastCalledWith("PDF drawing failed");
    renderer.dispose();
  });

  it("cancels active renders and destroys the document exactly once on disposal", async () => {
    const { renderer, onPages, pages, loadingTask, onError } = makeRenderer();
    await renderer.ready;
    const unmount = onPages.mock.calls[0][0][0].mountCanvas(makeCanvas());
    renderer.dispose();
    unmount?.();
    renderer.dispose();
    await Promise.resolve();
    expect(pages[0].cancel).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    onPages.mock.calls[0][0][0].mountCanvas(makeCanvas());
    expect(pages[0].render).toHaveBeenCalledOnce();
  });

  it("destroys a loading task that arrives after the source was replaced", async () => {
    const open = deferred<PDFDocumentLoadingTask>();
    const load = deferred<never>();
    const task = {
      promise: load.promise,
      destroy: vi.fn(async () => load.reject(new Error("Loading cancelled"))),
    };
    const onPages = vi.fn();
    const onError = vi.fn();
    const renderer = createPdfDocumentRenderer({
      openDocument: () => open.promise,
      onPages,
      onError,
    });
    renderer.dispose();
    open.resolve(task as unknown as PDFDocumentLoadingTask);
    await renderer.ready;
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(onPages).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not publish a stale document when cancellation happens during loading", async () => {
    const load = deferred<{ numPages: number; getPage: ReturnType<typeof vi.fn> }>();
    const task = { promise: load.promise, destroy: vi.fn(async () => {}) };
    const onPages = vi.fn();
    const onError = vi.fn();
    const renderer = createPdfDocumentRenderer({
      openDocument: async () => task as unknown as PDFDocumentLoadingTask,
      onPages,
      onError,
    });
    await Promise.resolve();
    renderer.dispose();
    const getPage = vi.fn();
    load.resolve({ numPages: 1, getPage });
    await renderer.ready;
    expect(getPage).not.toHaveBeenCalled();
    expect(onPages).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports loading failures", async () => {
    const onError = vi.fn();
    const onPages = vi.fn();
    const renderer = createPdfDocumentRenderer({
      openDocument: async () => {
        throw new Error("Invalid PDF");
      },
      onPages,
      onError,
    });
    await renderer.ready;
    expect(onError).toHaveBeenCalledWith("Invalid PDF");
    expect(onPages).not.toHaveBeenCalled();
    renderer.dispose();
  });
});

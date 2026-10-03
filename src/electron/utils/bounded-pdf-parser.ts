import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Worker, type ResourceLimits } from "node:worker_threads";

/**
 * The PDF ran past a deadline, memory, size or concurrency limit; it may be hostile or just very
 * large or complex.
 */
export class PdfParseLimitError extends Error {}

export type PdfParseLimits = {
  /** Wall-clock budget for the whole parse, worker start-up included. */
  deadlineMs: number;
  /** V8 old-generation heap for the parsing worker. */
  maxHeapMb: number;
  /** Extracted text past this many characters is dropped. */
  maxTextChars: number;
};

export type BoundedPdfParseResult = {
  text: string;
  numpages?: number;
  title?: string;
  author?: string;
  /** The text was cut at `maxTextChars`. */
  textTruncated: boolean;
};

/** One text run of a page, positioned in the page's scale-1 viewport (origin top-left). */
export type BoundedPdfTextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BoundedPdfPageText = {
  pageIndex: number;
  /** Scale-1 viewport size of the page. */
  width: number;
  height: number;
  items: BoundedPdfTextItem[];
};

export type BoundedPdfPageTextResult = {
  numPages: number;
  pages: BoundedPdfPageText[];
  /** Text or item limits stopped extraction early; later pages or items are missing. */
  textTruncated: boolean;
};

export type PdfPageTextOptions = {
  /** Read pages 0..maxPages-1 (ignored when `pageIndexes` is given). */
  maxPages?: number;
  /** Read exactly these zero-based pages; indexes past the end are skipped. */
  pageIndexes?: number[];
};

/** What a worker is asked to do with the bytes it is given. */
export type PdfWorkerTask =
  | { kind: "text" }
  | { kind: "pages"; maxPages: number; pageIndexes?: number[] };

export const DEFAULT_PDF_PARSE_LIMITS: Readonly<PdfParseLimits> = {
  deadlineMs: 30_000,
  maxHeapMb: 512,
  maxTextChars: 2 * 1024 * 1024,
};

/** Workspace and attachment PDFs: same deadline and heap, but room for book-length text. */
export const LOCAL_PDF_PARSE_LIMITS: Readonly<PdfParseLimits> = {
  ...DEFAULT_PDF_PARSE_LIMITS,
  maxTextChars: 16 * 1024 * 1024,
};

/** Largest PDF file read into memory for text extraction. */
export const DEFAULT_MAX_PDF_FILE_BYTES = 100 * 1024 * 1024;

/** PDF workers that may run at once across the app; further parses wait for a free slot. */
export const MAX_CONCURRENT_PDF_WORKERS = 2;

const DEFAULT_PAGE_TEXT_MAX_PAGES = 200;
const MAX_PAGE_TEXT_ITEMS = 500_000;

type WorkerReply = { ok: true; [key: string]: unknown } | { ok: false; error?: unknown };

class WorkerSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  /** Resolves with a release function once a slot is free; release is idempotent. */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.waiting.shift()?.();
        });
      };
      if (this.active < this.max) grant();
      else this.waiting.push(grant);
    });
  }
}

const pdfWorkerSlots = new WorkerSlots(MAX_CONCURRENT_PDF_WORKERS);

/** Running and queued PDF workers (for diagnostics and tests). */
export function getPdfWorkerStats(): { active: number; waiting: number } {
  return pdfWorkerSlots.stats();
}

// Runs pdf-parse (v2 PDFParse class, or the v1 function export) and replies once with plain,
// already-capped values.
const PDF_PARSE_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { modulePath, data, maxTextChars } = workerData;
(async () => {
  const pdfParse = require(modulePath);
  const legacy =
    typeof pdfParse === "function" ? pdfParse
      : typeof pdfParse.default === "function" ? pdfParse.default
        : null;
  let text, numpages, info;
  if (legacy) {
    const parsed = await legacy(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    ({ text, numpages, info } = parsed);
  } else if (typeof pdfParse.PDFParse === "function") {
    const parser = new pdfParse.PDFParse({ data });
    try {
      const textResult = await parser.getText();
      let infoResult;
      try {
        infoResult = typeof parser.getInfo === "function" ? await parser.getInfo() : undefined;
      } catch {}
      text = textResult.text;
      numpages = (infoResult && infoResult.total) || textResult.total;
      info = infoResult && infoResult.info;
    } finally {
      if (typeof parser.destroy === "function") await parser.destroy();
    }
  } else {
    throw new Error("Unsupported pdf-parse module export shape");
  }
  text = typeof text === "string" ? text : "";
  parentPort.postMessage({
    ok: true,
    text: text.slice(0, maxTextChars),
    textTruncated: text.length > maxTextChars,
    numpages: typeof numpages === "number" ? numpages : undefined,
    title: info && typeof info.Title === "string" ? info.Title : undefined,
    author: info && typeof info.Author === "string" ? info.Author : undefined,
  });
})().catch((error) => {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
});
`;

// Loads pdf.js and replies once with the non-blank text runs of the requested pages, each as
// [str, x, y, width, height] in the page's scale-1 viewport, stopping at the text/item limits.
const PDF_PAGES_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { moduleUrl, data, maxPages, pageIndexes, maxTextChars, maxItems } = workerData;
(async () => {
  const pdfjs = await import(moduleUrl);
  const loadingTask = pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 });
  try {
    const document = await loadingTask.promise;
    const numPages = document.numPages;
    const indexes = Array.isArray(pageIndexes)
      ? pageIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < numPages)
      : Array.from({ length: Math.min(numPages, maxPages) }, (_, index) => index);
    const pages = [];
    let chars = 0;
    let itemCount = 0;
    let textTruncated = false;
    for (const pageIndex of indexes) {
      if (textTruncated) break;
      const page = await document.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const items = [];
      for (const item of textContent.items) {
        if (typeof item.str !== "string" || item.str.trim().length === 0) continue;
        if (chars + item.str.length > maxTextChars || itemCount >= maxItems) {
          textTruncated = true;
          break;
        }
        const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
        items.push([item.str, x, y, Number(item.width) || 0, Number(item.height) || 0]);
        chars += item.str.length;
        itemCount += 1;
      }
      pages.push({ pageIndex, width: viewport.width, height: viewport.height, items });
      if (typeof page.cleanup === "function") page.cleanup();
    }
    parentPort.postMessage({ ok: true, numPages, pages, textTruncated });
  } finally {
    await loadingTask.destroy();
  }
})().catch((error) => {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
});
`;

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readPageText(value: unknown, maxTextChars: number): BoundedPdfPageText | null {
  if (!value || typeof value !== "object") return null;
  const page = value as { pageIndex?: unknown; width?: unknown; height?: unknown; items?: unknown };
  if (typeof page.pageIndex !== "number" || !Number.isInteger(page.pageIndex)) return null;
  const items: BoundedPdfTextItem[] = [];
  for (const raw of Array.isArray(page.items) ? page.items : []) {
    if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
    items.push({
      str: raw[0].slice(0, maxTextChars),
      x: finiteNumber(raw[1]),
      y: finiteNumber(raw[2]),
      width: finiteNumber(raw[3]),
      height: finiteNumber(raw[4]),
    });
  }
  return {
    pageIndex: page.pageIndex,
    width: finiteNumber(page.width),
    height: finiteNumber(page.height),
    items,
  };
}

/**
 * Parses untrusted PDF bytes in worker threads with a heap limit and a hard deadline, so a crafted
 * PDF cannot hang or exhaust the main process: on either limit the worker is terminated and the
 * parse fails with PdfParseLimitError. Each parse gets its own worker, which never outlives the
 * call, and at most MAX_CONCURRENT_PDF_WORKERS run at once app-wide; the rest queue.
 */
export class BoundedPdfParser {
  private readonly limits: PdfParseLimits;

  constructor(limits: Partial<PdfParseLimits> = {}) {
    this.limits = { ...DEFAULT_PDF_PARSE_LIMITS, ...limits };
  }

  /** The document's text layer and metadata, via pdf-parse. */
  async parse(data: Uint8Array): Promise<BoundedPdfParseResult> {
    const { maxTextChars } = this.limits;
    return this.run(data, { kind: "text" }, (reply) => {
      const text = typeof reply.text === "string" ? reply.text : "";
      return {
        text: text.slice(0, maxTextChars),
        textTruncated: reply.textTruncated === true || text.length > maxTextChars,
        numpages: typeof reply.numpages === "number" ? reply.numpages : undefined,
        title: typeof reply.title === "string" ? reply.title : undefined,
        author: typeof reply.author === "string" ? reply.author : undefined,
      };
    });
  }

  /** Positioned text runs of the selected pages, via pdf.js. */
  async extractPageText(
    data: Uint8Array,
    options: PdfPageTextOptions = {},
  ): Promise<BoundedPdfPageTextResult> {
    const { maxTextChars } = this.limits;
    const task: PdfWorkerTask = {
      kind: "pages",
      maxPages: Math.max(1, Math.floor(options.maxPages ?? DEFAULT_PAGE_TEXT_MAX_PAGES)),
      ...(options.pageIndexes ? { pageIndexes: [...options.pageIndexes] } : {}),
    };
    return this.run(data, task, (reply) => {
      const pages: BoundedPdfPageText[] = [];
      for (const raw of Array.isArray(reply.pages) ? reply.pages : []) {
        const page = readPageText(raw, maxTextChars);
        if (page) pages.push(page);
      }
      return {
        numPages: Math.max(0, Math.floor(finiteNumber(reply.numPages))),
        pages,
        textTruncated: reply.textTruncated === true,
      };
    });
  }

  private async run<T>(
    data: Uint8Array,
    task: PdfWorkerTask,
    accept: (reply: Record<string, unknown>) => T,
  ): Promise<T> {
    const { deadlineMs, maxHeapMb } = this.limits;
    const release = await pdfWorkerSlots.acquire();
    let worker: Worker;
    try {
      // The worker takes a copy of exactly these bytes; the caller's buffer is left intact.
      worker = this.createWorker(new Uint8Array(data), { maxOldGenerationSizeMb: maxHeapMb }, task);
    } catch (error) {
      release();
      throw error;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The slot frees only once the thread is really gone.
        worker.terminate().then(release, release);
        if (error) reject(error);
        else resolve(result as T);
      };
      const timer = setTimeout(
        () =>
          finish(
            new PdfParseLimitError(
              `PDF parsing did not finish within ${deadlineMs / 1000} seconds`,
            ),
          ),
        deadlineMs,
      );
      worker.once("message", (reply: WorkerReply) => {
        if (!reply || reply.ok !== true) {
          const failure = reply as { error?: unknown } | undefined;
          finish(new Error(String(failure?.error || "PDF parsing failed")));
          return;
        }
        try {
          finish(null, accept(reply));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      worker.on("error", (error: Error & { code?: string }) => {
        finish(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new PdfParseLimitError(`PDF parsing exceeded its ${maxHeapMb} MB memory limit`)
            : error,
        );
      });
      worker.once("exit", (code) => {
        finish(new Error(`PDF parser exited before finishing (code ${code})`));
      });
    });
  }

  /** The worker that runs `task` on `data`; tests substitute one that misbehaves. */
  protected createWorker(
    data: Uint8Array,
    resourceLimits: ResourceLimits,
    task: PdfWorkerTask = { kind: "text" },
  ): Worker {
    const { maxTextChars } = this.limits;
    const transferList = [data.buffer as ArrayBuffer];
    if (task.kind === "pages") {
      return new Worker(PDF_PAGES_WORKER_SOURCE, {
        eval: true,
        workerData: {
          // Resolved here so the worker loads the same pdf.js build as the rest of the app.
          moduleUrl: pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href,
          data,
          maxPages: task.maxPages,
          pageIndexes: task.pageIndexes,
          maxTextChars,
          maxItems: MAX_PAGE_TEXT_ITEMS,
        },
        transferList,
        resourceLimits,
      });
    }
    return new Worker(PDF_PARSE_WORKER_SOURCE, {
      eval: true,
      // Resolved here so the worker loads the same pdf-parse build as the rest of the app.
      workerData: { modulePath: require.resolve("pdf-parse"), data, maxTextChars },
      transferList,
      resourceLimits,
    });
  }
}

/** parse() of a BoundedPdfParser with the given limits (defaults: 30 s, 512 MB heap, 2 MB text). */
export function parsePdfBufferBounded(
  data: Uint8Array,
  limits: Partial<PdfParseLimits> = {},
): Promise<BoundedPdfParseResult> {
  return new BoundedPdfParser(limits).parse(data);
}

/** extractPageText() of a BoundedPdfParser with the given limits. */
export function extractPdfPageTextBounded(
  data: Uint8Array,
  options: PdfPageTextOptions = {},
  limits: Partial<PdfParseLimits> = {},
): Promise<BoundedPdfPageTextResult> {
  return new BoundedPdfParser(limits).extractPageText(data, options);
}

function formatMb(bytes: number): string {
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

/**
 * Reads a PDF for text extraction, refusing files over `maxBytes` before any of it is loaded.
 */
export async function readPdfFileBounded(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_PDF_FILE_BYTES,
): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const tooLarge = (bytes: number) =>
      new PdfParseLimitError(
        `the file is ${formatMb(bytes)}, over the ${formatMb(maxBytes)} limit for PDF text extraction`,
      );
    if (size > maxBytes) throw tooLarge(size);
    const buffer = await handle.readFile();
    // The file may have grown since stat().
    if (buffer.byteLength > maxBytes) throw tooLarge(buffer.byteLength);
    return buffer;
  } finally {
    await handle.close();
  }
}

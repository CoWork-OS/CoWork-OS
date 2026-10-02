import { Worker, type ResourceLimits } from "node:worker_threads";

/** The parse ran past its deadline or memory limit; the PDF may be hostile or just very large. */
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
  /** The text was cut at `maxTextChars`. */
  textTruncated: boolean;
};

export const DEFAULT_PDF_PARSE_LIMITS: Readonly<PdfParseLimits> = {
  deadlineMs: 30_000,
  maxHeapMb: 512,
  maxTextChars: 2 * 1024 * 1024,
};

type WorkerReply =
  | { ok: true; text?: unknown; textTruncated?: unknown; numpages?: unknown; title?: unknown }
  | { ok: false; error?: unknown };

// Runs pdf-parse (v2 PDFParse class, or the v1 function export) the same way parsePdfBuffer in
// ./pdf-parser does, and replies once with plain, already-capped values.
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
  });
})().catch((error) => {
  parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
});
`;

/**
 * Extracts the text of untrusted PDF bytes in a worker thread with a heap limit and a hard
 * deadline, so a crafted PDF cannot hang or exhaust the main process: on either limit the
 * worker is terminated and the parse fails with PdfParseLimitError. Each parse gets its own
 * worker, which never outlives the call.
 */
export class BoundedPdfParser {
  private readonly limits: PdfParseLimits;

  constructor(limits: Partial<PdfParseLimits> = {}) {
    this.limits = { ...DEFAULT_PDF_PARSE_LIMITS, ...limits };
  }

  async parse(data: Uint8Array): Promise<BoundedPdfParseResult> {
    const { deadlineMs, maxHeapMb, maxTextChars } = this.limits;
    // The worker takes a copy of exactly these bytes; the caller's buffer is left intact.
    const worker = this.createWorker(new Uint8Array(data), { maxOldGenerationSizeMb: maxHeapMb });
    return new Promise<BoundedPdfParseResult>((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | null, result?: BoundedPdfParseResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => undefined);
        if (error) reject(error);
        else resolve(result as BoundedPdfParseResult);
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
        if (!reply.ok) {
          finish(new Error(String(reply.error || "PDF parsing failed")));
          return;
        }
        const text = typeof reply.text === "string" ? reply.text : "";
        finish(null, {
          text: text.slice(0, maxTextChars),
          textTruncated: reply.textTruncated === true || text.length > maxTextChars,
          numpages: typeof reply.numpages === "number" ? reply.numpages : undefined,
          title: typeof reply.title === "string" ? reply.title : undefined,
        });
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

  /** The worker that parses `data`; tests substitute one that misbehaves. */
  protected createWorker(data: Uint8Array, resourceLimits: ResourceLimits): Worker {
    return new Worker(PDF_PARSE_WORKER_SOURCE, {
      eval: true,
      // Resolved here so the worker loads the same pdf-parse build as the rest of the app.
      workerData: {
        modulePath: require.resolve("pdf-parse"),
        data,
        maxTextChars: this.limits.maxTextChars,
      },
      transferList: [data.buffer as ArrayBuffer],
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

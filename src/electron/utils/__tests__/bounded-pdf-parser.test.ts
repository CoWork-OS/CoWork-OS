import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker, type ResourceLimits } from "node:worker_threads";
import PDFDocument from "pdfkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedPdfParser,
  MAX_CONCURRENT_PDF_WORKERS,
  PdfParseLimitError,
  extractPdfPageTextBounded,
  getPdfWorkerStats,
  parsePdfBufferBounded,
  readPdfFileBounded,
  type PdfParseLimits,
} from "../bounded-pdf-parser";

function createPdf(pages: string[], title?: string, author?: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const info: Record<string, string> = {};
    if (title) info.Title = title;
    if (author) info.Author = author;
    const doc = new PDFDocument({ margin: 72, info });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    pages.forEach((text, index) => {
      if (index > 0) doc.addPage();
      doc.font("Helvetica").fontSize(12).text(text);
    });
    doc.end();
  });
}

/** A parser whose worker runs `source` in place of pdf-parse. */
class FakeWorkerParser extends BoundedPdfParser {
  constructor(
    private readonly source: string,
    limits: Partial<PdfParseLimits> = {},
  ) {
    super(limits);
  }

  protected override createWorker(_data: Uint8Array, resourceLimits: ResourceLimits): Worker {
    return new Worker(this.source, { eval: true, resourceLimits });
  }
}

describe("parsePdfBufferBounded", () => {
  it("extracts a PDF's text, page count and title in a worker", async () => {
    const pdf = await createPdf(
      ["Quarterly transit ridership report.", "Appendix tables."],
      "Transit report",
      "Planning office",
    );

    const result = await parsePdfBufferBounded(pdf);

    expect(result.text).toContain("Quarterly transit ridership report.");
    expect(result.text).toContain("Appendix tables.");
    expect(result.numpages).toBe(2);
    expect(result.title).toBe("Transit report");
    expect(result.author).toBe("Planning office");
    expect(result.textTruncated).toBe(false);
  });

  it("leaves the caller's buffer intact", async () => {
    const pdf = await createPdf(["Buffer ownership check."]);
    const length = pdf.byteLength;

    await parsePdfBufferBounded(pdf);

    expect(pdf.byteLength).toBe(length);
  });

  it("cuts the extracted text at the text limit", async () => {
    const pdf = await createPdf([
      "The extracted text of this page is longer than forty characters.",
    ]);

    const result = await parsePdfBufferBounded(pdf, { maxTextChars: 40 });

    expect(result.text).toBe("The extracted text of this page is longe");
    expect(result.textTruncated).toBe(true);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(parsePdfBufferBounded(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
  });

  it.each([
    ["a parse that never finishes", "for (;;) {}"],
    ["a parse that never answers", "setInterval(() => {}, 1000);"],
  ])("stops %s at the deadline without blocking the main thread", async (_name, source) => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      const parse = new FakeWorkerParser(source, { deadlineMs: 300 }).parse(new Uint8Array([1]));

      await expect(parse).rejects.toBeInstanceOf(PdfParseLimitError);
      await expect(parse).rejects.toThrow("PDF parsing did not finish within 0.3 seconds");
      expect(ticks).toBeGreaterThan(3);
    } finally {
      clearInterval(timer);
    }
  });

  it("reports a parse that exhausts the worker heap as a limit error", async () => {
    const source =
      "const keep = []; for (;;) keep.push(new Array(1e5).fill({ n: Math.random() }));";

    const parse = new FakeWorkerParser(source, { maxHeapMb: 16 }).parse(new Uint8Array([1]));

    await expect(parse).rejects.toBeInstanceOf(PdfParseLimitError);
    await expect(parse).rejects.toThrow("PDF parsing exceeded its 16 MB memory limit");
  });

  it("caps text the worker returns past the limit", async () => {
    const source = `require("node:worker_threads").parentPort.postMessage({
      ok: true, text: "x".repeat(1000), textTruncated: false, numpages: 1, title: 42,
    });`;

    const result = await new FakeWorkerParser(source, { maxTextChars: 10 }).parse(
      new Uint8Array([1]),
    );

    expect(result).toEqual({ text: "x".repeat(10), textTruncated: true, numpages: 1 });
  });

  it("fails when the worker exits without answering", async () => {
    const parse = new FakeWorkerParser("process.exit(3);").parse(new Uint8Array([1]));

    await expect(parse).rejects.toThrow("PDF parser exited before finishing (code 3)");
  });
});

/** A parser whose workers each answer after `delayMs`, recording how many ran at once. */
class SlowWorkerParser extends BoundedPdfParser {
  static running = 0;
  static peak = 0;

  constructor(private readonly delayMs: number) {
    super();
  }

  protected override createWorker(_data: Uint8Array, resourceLimits: ResourceLimits): Worker {
    SlowWorkerParser.running += 1;
    SlowWorkerParser.peak = Math.max(SlowWorkerParser.peak, SlowWorkerParser.running);
    const worker = new Worker(
      `setTimeout(() => require("node:worker_threads").parentPort.postMessage({
        ok: true, text: "done", numpages: 1,
      }), ${this.delayMs});`,
      { eval: true, resourceLimits },
    );
    worker.once("exit", () => {
      SlowWorkerParser.running -= 1;
    });
    return worker;
  }
}

describe("PDF worker concurrency", () => {
  it("never runs more than the app-wide number of PDF workers at once", async () => {
    SlowWorkerParser.running = 0;
    SlowWorkerParser.peak = 0;
    let observedActive = 0;
    const sampler = setInterval(() => {
      observedActive = Math.max(observedActive, getPdfWorkerStats().active);
    }, 5);
    try {
      const parses = Array.from({ length: 6 }, () =>
        new SlowWorkerParser(120).parse(new Uint8Array([1])),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(getPdfWorkerStats().waiting).toBe(6 - MAX_CONCURRENT_PDF_WORKERS);

      const results = await Promise.all(parses);

      expect(results.map((result) => result.text)).toEqual(Array.from({ length: 6 }, () => "done"));
      expect(SlowWorkerParser.peak).toBe(MAX_CONCURRENT_PDF_WORKERS);
      expect(observedActive).toBeLessThanOrEqual(MAX_CONCURRENT_PDF_WORKERS);
    } finally {
      clearInterval(sampler);
    }
  });

  it("frees the slot of a worker stopped at its deadline", async () => {
    const stuck = Array.from({ length: MAX_CONCURRENT_PDF_WORKERS }, () =>
      new FakeWorkerParser("for (;;) {}", { deadlineMs: 200 }).parse(new Uint8Array([1])),
    );
    const next = new SlowWorkerParser(10).parse(new Uint8Array([1]));

    for (const parse of stuck) await expect(parse).rejects.toBeInstanceOf(PdfParseLimitError);
    await expect(next).resolves.toMatchObject({ text: "done" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getPdfWorkerStats()).toEqual({ active: 0, waiting: 0 });
  });
});

describe("extractPdfPageTextBounded", () => {
  it("returns each page's positioned text runs from pdf.js in a worker", async () => {
    const pdf = await createPdf(["First page heading.", "Second page body.", "Third page."]);

    const result = await extractPdfPageTextBounded(pdf, { maxPages: 2 });

    expect(result.numPages).toBe(3);
    expect(result.textTruncated).toBe(false);
    expect(result.pages.map((page) => page.pageIndex)).toEqual([0, 1]);
    const first = result.pages[0];
    expect(first.width).toBeCloseTo(612);
    expect(first.height).toBeCloseTo(792);
    expect(first.items.map((item) => item.str).join(" ")).toContain("First page heading.");
    // pdfkit's 72pt margin puts the first line near the top-left of the viewport.
    expect(first.items[0].x).toBeCloseTo(72, 0);
    expect(first.items[0].y).toBeGreaterThan(72);
    expect(first.items[0].y).toBeLessThan(100);
    expect(result.pages[1].items.map((item) => item.str).join(" ")).toContain("Second page");
  });

  it("reads only the requested pages", async () => {
    const pdf = await createPdf(["Alpha.", "Bravo.", "Charlie."]);

    const result = await extractPdfPageTextBounded(pdf, { pageIndexes: [2, 9] });

    expect(result.pages.map((page) => page.pageIndex)).toEqual([2]);
    expect(result.pages[0].items.map((item) => item.str).join("")).toContain("Charlie.");
  });

  it("stops at the text limit and says so", async () => {
    const pdf = await createPdf(["Some words on page one.", "More words on page two."]);

    const result = await extractPdfPageTextBounded(pdf, {}, { maxTextChars: 10 });

    expect(result.textTruncated).toBe(true);
    const chars = result.pages
      .flatMap((page) => page.items)
      .reduce((sum, item) => sum + item.str.length, 0);
    expect(chars).toBeLessThanOrEqual(10);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(
      extractPdfPageTextBounded(new TextEncoder().encode("not a pdf")),
    ).rejects.toThrow();
  });
});

describe("readPdfFileBounded", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeTemp(bytes: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bounded-pdf-"));
    dirs.push(dir);
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, Buffer.alloc(bytes, 0x20));
    return file;
  }

  it("reads a file within the size limit", async () => {
    const file = writeTemp(1024);

    await expect(readPdfFileBounded(file, 2048)).resolves.toHaveLength(1024);
  });

  it("refuses a file over the size limit with a limit error", async () => {
    const file = writeTemp(4096);

    const read = readPdfFileBounded(file, 2048);

    await expect(read).rejects.toBeInstanceOf(PdfParseLimitError);
    await expect(read).rejects.toThrow(/over the .* limit for PDF text extraction/);
  });
});

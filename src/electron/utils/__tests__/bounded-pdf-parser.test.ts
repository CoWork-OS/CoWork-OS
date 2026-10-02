import { Worker, type ResourceLimits } from "node:worker_threads";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import {
  BoundedPdfParser,
  PdfParseLimitError,
  parsePdfBufferBounded,
  type PdfParseLimits,
} from "../bounded-pdf-parser";

function createPdf(pages: string[], title?: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72, info: title ? { Title: title } : {} });
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
    );

    const result = await parsePdfBufferBounded(pdf);

    expect(result.text).toContain("Quarterly transit ridership report.");
    expect(result.text).toContain("Appendix tables.");
    expect(result.numpages).toBe(2);
    expect(result.title).toBe("Transit report");
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

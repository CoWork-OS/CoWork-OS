import { createRequire } from "module";
import PDFDocument from "pdfkit";
import { describe, expect, it, vi } from "vitest";

const { boundedParseSpy } = vi.hoisted(() => ({ boundedParseSpy: vi.fn() }));

// Pass-through spy: the real worker-backed parser runs, but calls are recorded.
vi.mock("../bounded-pdf-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bounded-pdf-parser")>();
  boundedParseSpy.mockImplementation(actual.parsePdfBufferBounded);
  return { ...actual, parsePdfBufferBounded: boundedParseSpy };
});

import { LOCAL_PDF_PARSE_LIMITS, PdfParseLimitError } from "../bounded-pdf-parser";
import { parsePdfBuffer } from "../pdf-parser";

function createPdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72, info: { Title: "Field notes", Author: "Survey" } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica").fontSize(12).text(text);
    doc.end();
  });
}

describe("parsePdfBuffer", () => {
  it("parses in the bounded worker and keeps the legacy result shape", async () => {
    const pdf = await createPdf("Wetland survey notes for the northern plots.");

    const parsed = await parsePdfBuffer(pdf);

    expect(parsed.text).toContain("Wetland survey notes for the northern plots.");
    expect(parsed.numpages).toBe(1);
    expect(parsed.info).toEqual({ Title: "Field notes", Author: "Survey" });
    expect(boundedParseSpy).toHaveBeenCalledWith(pdf, LOCAL_PDF_PARSE_LIMITS);
    // pdf-parse is only ever loaded inside the worker.
    const cache = createRequire(import.meta.url).cache;
    expect(Object.keys(cache).filter((key) => /[\\/]pdf-parse[\\/]/.test(key))).toEqual([]);
  });

  it("passes parse limits through as PdfParseLimitError", async () => {
    boundedParseSpy.mockRejectedValueOnce(
      new PdfParseLimitError("PDF parsing exceeded its 512 MB memory limit"),
    );

    await expect(parsePdfBuffer(Buffer.from("%PDF-1.7"))).rejects.toBeInstanceOf(
      PdfParseLimitError,
    );
  });
});

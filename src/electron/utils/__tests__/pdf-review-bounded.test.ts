import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import PDFDocument from "pdfkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pageTextSpy, legacyParseSpy, pdfjsImportedOnMainThread, execFileMock } = vi.hoisted(() => ({
  pageTextSpy: vi.fn(),
  legacyParseSpy: vi.fn(),
  pdfjsImportedOnMainThread: vi.fn(),
  execFileMock: vi.fn(),
}));

// Pass-through spies: the real worker-backed readers run, but calls are recorded.
vi.mock("../bounded-pdf-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bounded-pdf-parser")>();
  pageTextSpy.mockImplementation(actual.extractPdfPageTextBounded);
  legacyParseSpy.mockImplementation(actual.parsePdfBufferBounded);
  return {
    ...actual,
    extractPdfPageTextBounded: pageTextSpy,
    parsePdfBufferBounded: legacyParseSpy,
  };
});

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
  pdfjsImportedOnMainThread();
  throw new Error("pdf.js must not be loaded on the main thread");
});

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: execFileMock,
}));

vi.mock("../../ipc/image-viewer-ocr", () => ({
  OCR_TIMEOUT_MS: 12_000,
  TESSERACT_LANGUAGE_DEFAULT: "eng",
  isTesseractInstalled: async () => true,
  sanitizeOcrOutput: (value: string) => value.trim(),
}));

import { PdfParseLimitError } from "../bounded-pdf-parser";
import { extractPdfReviewData } from "../pdf-review";

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

function writePdf(outputPath: string, pages: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    pages.forEach((text, index) => {
      if (index > 0) doc.addPage();
      if (text) doc.font("Helvetica").fontSize(12).text(text, { lineGap: 4 });
      else doc.rect(100, 100, 300, 300).fill("#888888");
    });
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

describe("extractPdfReviewData bounds", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-pdf-review-bounded-"));
    // No ocrmypdf, so image-only documents take the page OCR path.
    execFileMock.mockImplementation((file: string, _args: string[], ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as ExecCallback;
      callback(new Error(`${file}: not installed`));
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads native page text with pdf.js in the worker and keeps the review layout", async () => {
    const pdfPath = path.join(tmpDir, "report.pdf");
    await writePdf(pdfPath, [
      "Quarterly ridership report for the regional transit authority, covering all bus lines.\nSecond line of the first page.",
      "Appendix with route tables and weekday boarding counts for each of the corridors.",
    ]);

    const review = await extractPdfReviewData(pdfPath, { includeOcr: false });

    expect(pageTextSpy).toHaveBeenCalledTimes(1);
    expect(pdfjsImportedOnMainThread).not.toHaveBeenCalled();
    expect(review.pageCount).toBe(2);
    expect(review.extractionMode).toBe("native");
    expect(review.nativeTextPages).toBe(2);
    expect(review.pages[0].text).toContain("Quarterly ridership report");
    expect(review.pages[0].text).toContain("\nSecond line of the first page.");
    expect(review.content).toMatch(/^\[Page 1\]\nQuarterly ridership report/);
    expect(review.content).toContain("[Page 2]\nAppendix with route tables");
  });

  it("propagates a pdf.js limit instead of retrying the same engine", async () => {
    const pdfPath = path.join(tmpDir, "bomb.pdf");
    await writePdf(pdfPath, ["Some text."]);
    pageTextSpy.mockRejectedValueOnce(
      new PdfParseLimitError("PDF parsing did not finish within 30 seconds"),
    );

    await expect(extractPdfReviewData(pdfPath)).rejects.toBeInstanceOf(PdfParseLimitError);
    expect(legacyParseSpy).not.toHaveBeenCalled();
  });

  it("falls back to the bounded pdf-parse reader when pdf.js rejects the file", async () => {
    const pdfPath = path.join(tmpDir, "odd.pdf");
    await writePdf(pdfPath, ["Legacy reader text for an odd file."]);
    pageTextSpy.mockRejectedValueOnce(new Error("Invalid PDF structure"));

    const review = await extractPdfReviewData(pdfPath);

    expect(legacyParseSpy).toHaveBeenCalledTimes(1);
    expect(review.extractionMode).toBe("fallback");
    expect(review.pages[0].text).toContain("Legacy reader text for an odd file.");
  });

  it("stops page OCR at its time budget and says so", async () => {
    const pdfPath = path.join(tmpDir, "scan.pdf");
    await writePdf(pdfPath, ["", "", "", "", "", "", "", ""]);
    const renderTimeouts: number[] = [];
    execFileMock.mockImplementation(
      (file: string, _args: string[], options: { timeout?: number }, callback: ExecCallback) => {
        if (file === "pdftoppm") {
          renderTimeouts.push(Number(options.timeout));
          // Each page render is slow; the budget, not the page count, must end the loop.
          setTimeout(() => callback(null, { stdout: "", stderr: "" }), 300);
        } else if (file === "tesseract") {
          callback(null, { stdout: "Scanned words recovered by OCR.", stderr: "" });
        } else {
          callback(new Error(`${file}: not installed`));
        }
      },
    );

    const started = Date.now();
    const review = await extractPdfReviewData(pdfPath, { maxPages: 8, ocrBudgetMs: 1300 });
    const elapsed = Date.now() - started;

    expect(review.imageHeavy).toBe(true);
    expect(review.extractionMode).toBe("page-ocr");
    expect(renderTimeouts.length).toBeGreaterThan(0);
    expect(renderTimeouts.length).toBeLessThan(8);
    expect(Math.max(...renderTimeouts)).toBeLessThanOrEqual(1300);
    expect(review.pages[0]).toMatchObject({ usedOcr: true });
    expect(review.pages[7]).toMatchObject({ usedOcr: false });
    expect(review.content).toMatch(
      /OCR stopped at its 1 s time budget; \d+ page\(s\) were not OCR'd/,
    );
    expect(elapsed).toBeLessThan(3000);
  });
});

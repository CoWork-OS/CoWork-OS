import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const { parsePdfBufferMock, mainThreadParserMock, extractPdfReviewDataMock } = vi.hoisted(() => ({
  parsePdfBufferMock: vi.fn(),
  mainThreadParserMock: vi.fn(),
  extractPdfReviewDataMock: vi.fn(),
}));

vi.mock("../bounded-pdf-parser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bounded-pdf-parser")>()),
  parsePdfBufferBounded: parsePdfBufferMock,
}));

vi.mock("../pdf-parser", () => ({
  parsePdfBuffer: mainThreadParserMock,
}));

vi.mock("../pdf-review", () => ({
  extractPdfReviewData: extractPdfReviewDataMock,
}));

import { LOCAL_PDF_PARSE_LIMITS, PdfParseLimitError } from "../bounded-pdf-parser";
import { extractPdfText } from "../pdf-text";

describe("extractPdfText", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-pdf-text-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("keeps the library-first path when pdf-parse already returns substantial text", async () => {
    const pdfPath = path.join(tmpDir, "sample.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7"));
    parsePdfBufferMock.mockResolvedValue({
      text: "Bonjour tout le monde.\nCeci est un PDF avec assez de texte pour une analyse normale.",
      numpages: 3,
    });

    const result = await extractPdfText(pdfPath);

    expect(result).toEqual({
      text: "Bonjour tout le monde.\nCeci est un PDF avec assez de texte pour une analyse normale.",
      pageCount: 3,
      extractionMode: "pdf-parse",
      usedFallback: false,
      previewLimited: false,
      extractionStatus: "complete",
      extractionNote: "complete via embedded text layer; OCR not needed",
    });
    expect(extractPdfReviewDataMock).not.toHaveBeenCalled();
    expect(parsePdfBufferMock).toHaveBeenCalledWith(expect.any(Buffer), LOCAL_PDF_PARSE_LIMITS);
    expect(mainThreadParserMock).not.toHaveBeenCalled();
  });

  it("falls back to review extraction when the library result is too thin", async () => {
    const pdfPath = path.join(tmpDir, "scan.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7"));
    parsePdfBufferMock.mockResolvedValue({
      text: "Page",
      numpages: 2,
    });
    extractPdfReviewDataMock.mockResolvedValue({
      pageCount: 5,
      nativeTextPages: 2,
      ocrPages: 0,
      scannedPages: 0,
      truncatedPages: true,
      extractionMode: "native",
      imageHeavy: false,
      pages: [
        { pageIndex: 0, text: "Premier paragraphe lisible.", usedOcr: false, truncated: false },
        { pageIndex: 1, text: "Deuxieme paragraphe lisible.", usedOcr: false, truncated: false },
      ],
      fullText: "",
      content: "",
    });

    const result = await extractPdfText(pdfPath);

    expect(result).toEqual({
      text: "Premier paragraphe lisible.\n\nDeuxieme paragraphe lisible.\n\n[... 3 additional page(s) omitted from extraction ...]",
      pageCount: 5,
      extractionMode: "native",
      usedFallback: true,
      previewLimited: true,
      extractionStatus: "preview",
      extractionNote: "partial preview extracted from fallback reader; later pages were omitted",
    });
    expect(extractPdfReviewDataMock).toHaveBeenCalledOnce();
  });

  it("falls back when the library text is long enough but clearly low quality", async () => {
    const pdfPath = path.join(tmpDir, "noisy.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7"));
    parsePdfBufferMock.mockResolvedValue({
      text: new Array(80).fill("A\uFFFDB").join(" "),
      numpages: 2,
    });
    extractPdfReviewDataMock.mockResolvedValue({
      pageCount: 2,
      nativeTextPages: 2,
      ocrPages: 0,
      scannedPages: 0,
      truncatedPages: false,
      extractionMode: "native",
      imageHeavy: false,
      pages: [
        {
          pageIndex: 0,
          text: "Texte propre de la premiere page.",
          usedOcr: false,
          truncated: false,
        },
        {
          pageIndex: 1,
          text: "Texte propre de la deuxieme page.",
          usedOcr: false,
          truncated: false,
        },
      ],
      fullText: "",
      content: "",
    });

    const result = await extractPdfText(pdfPath);

    expect(result).toEqual({
      text: "Texte propre de la premiere page.\n\nTexte propre de la deuxieme page.",
      pageCount: 2,
      extractionMode: "native",
      usedFallback: true,
      previewLimited: false,
      extractionStatus: "recovered",
      extractionNote: "complete via fallback PDF text reader",
    });
    expect(extractPdfReviewDataMock).toHaveBeenCalledOnce();
  });

  it("surfaces a parse limit as an actionable error without running the review reader", async () => {
    const pdfPath = path.join(tmpDir, "bomb.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7"));
    parsePdfBufferMock.mockRejectedValue(
      new PdfParseLimitError("PDF parsing did not finish within 30 seconds"),
    );

    const extraction = extractPdfText(pdfPath);

    await expect(extraction).rejects.toBeInstanceOf(PdfParseLimitError);
    await expect(extraction).rejects.toThrow(
      /bomb\.pdf is too large or complex to extract safely \(PDF parsing did not finish within 30 seconds\)\. .*split it into smaller PDFs.*read_pdf_visual/,
    );
    expect(extractPdfReviewDataMock).not.toHaveBeenCalled();
  });

  it("still falls back to the review reader when the library rejects a malformed PDF", async () => {
    const pdfPath = path.join(tmpDir, "odd.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7"));
    parsePdfBufferMock.mockRejectedValue(new Error("Invalid PDF structure"));
    extractPdfReviewDataMock.mockResolvedValue({
      pageCount: 1,
      nativeTextPages: 1,
      ocrPages: 0,
      scannedPages: 0,
      truncatedPages: false,
      extractionMode: "native",
      imageHeavy: false,
      pages: [{ pageIndex: 0, text: "Recovered text.", usedOcr: false, truncated: false }],
      fullText: "",
      content: "",
    });

    const result = await extractPdfText(pdfPath);

    expect(result.text).toBe("Recovered text.");
    expect(result.extractionStatus).toBe("recovered");
  });

  it("refuses a PDF over the file size limit before parsing it", async () => {
    const pdfPath = path.join(tmpDir, "huge.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7"));
    await fs.truncate(pdfPath, 101 * 1024 * 1024);

    const extraction = extractPdfText(pdfPath);

    await expect(extraction).rejects.toBeInstanceOf(PdfParseLimitError);
    await expect(extraction).rejects.toThrow(/huge\.pdf is too large or complex.*101 MB/);
    expect(parsePdfBufferMock).not.toHaveBeenCalled();
  });

  it("reports a review-reader limit when there is no text layer to fall back on", async () => {
    const pdfPath = path.join(tmpDir, "scan.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7"));
    parsePdfBufferMock.mockResolvedValue({ text: "", numpages: 3, textTruncated: false });
    extractPdfReviewDataMock.mockRejectedValue(
      new PdfParseLimitError("PDF parsing exceeded its 512 MB memory limit"),
    );

    await expect(extractPdfText(pdfPath)).rejects.toThrow(
      /scan\.pdf is too large or complex to extract safely \(PDF parsing exceeded its 512 MB/,
    );
  });

  it("keeps the thin text layer when the review reader hits a limit", async () => {
    const pdfPath = path.join(tmpDir, "thin.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7"));
    parsePdfBufferMock.mockResolvedValue({ text: "Cover page", numpages: 3, textTruncated: false });
    extractPdfReviewDataMock.mockRejectedValue(
      new PdfParseLimitError("PDF parsing did not finish within 30 seconds"),
    );

    const result = await extractPdfText(pdfPath);

    expect(result.text).toBe("Cover page");
    expect(result.extractionMode).toBe("pdf-parse");
  });

  it("marks a text layer cut at the local text limit as a partial read", async () => {
    const pdfPath = path.join(tmpDir, "book.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7"));
    parsePdfBufferMock.mockResolvedValue({
      text: "Chapitre premier. Il etait une fois un long livre avec beaucoup de pages et de mots.",
      numpages: 900,
      textTruncated: true,
    });

    const result = await extractPdfText(pdfPath);

    expect(result.text).toMatch(/\[\.\.\. PDF text truncated at \d+ characters \.\.\.\]$/);
    expect(result.previewLimited).toBe(true);
    expect(result.extractionStatus).toBe("preview");
    expect(result.extractionNote).toMatch(/^partial: embedded text layer cut at/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const { parsePdfBufferMock, extractPdfReviewDataMock } = vi.hoisted(() => ({
  parsePdfBufferMock: vi.fn(),
  extractPdfReviewDataMock: vi.fn(),
}));

vi.mock("../pdf-parser", () => ({
  parsePdfBuffer: parsePdfBufferMock,
}));

vi.mock("../pdf-review", () => ({
  extractPdfReviewData: extractPdfReviewDataMock,
}));

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
      text:
        "Premier paragraphe lisible.\n\nDeuxieme paragraphe lisible.\n\n[... 3 additional page(s) omitted from extraction ...]",
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
        { pageIndex: 0, text: "Texte propre de la premiere page.", usedOcr: false, truncated: false },
        { pageIndex: 1, text: "Texte propre de la deuxieme page.", usedOcr: false, truncated: false },
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
});

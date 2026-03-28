import { describe, expect, it } from "vitest";
import { decidePdfExtractionMode } from "../pdf-review";

describe("decidePdfExtractionMode", () => {
  const baseCoverage = {
    totalPages: 11,
    pageLimit: 11,
    nativeTextPages: 1,
    totalNativeChars: 42,
    totalNativeWords: 6,
    coverageRatio: 1 / 11,
    averageCharsPerPage: 42 / 11,
    averageWordsPerPage: 6 / 11,
    imageHeavy: true,
  };

  it("prefers document-level OCR when the PDF is image-heavy and ocrmypdf is available", () => {
    const result = decidePdfExtractionMode({
      includeOcr: true,
      ocrmypdfAvailable: true,
      coverage: baseCoverage,
    });

    expect(result).toEqual({
      extractionMode: "ocrmypdf",
      useDocumentOcr: true,
      forcePageOcr: false,
    });
  });

  it("falls back to page OCR when the PDF is image-heavy but ocrmypdf is unavailable", () => {
    const result = decidePdfExtractionMode({
      includeOcr: true,
      ocrmypdfAvailable: false,
      coverage: baseCoverage,
    });

    expect(result).toEqual({
      extractionMode: "page-ocr",
      useDocumentOcr: false,
      forcePageOcr: true,
    });
  });

  it("keeps the native path for text-heavy PDFs", () => {
    const result = decidePdfExtractionMode({
      includeOcr: true,
      ocrmypdfAvailable: true,
      coverage: {
        ...baseCoverage,
        nativeTextPages: 10,
        totalNativeChars: 1800,
        totalNativeWords: 260,
        coverageRatio: 10 / 11,
        averageCharsPerPage: 1800 / 11,
        averageWordsPerPage: 260 / 11,
        imageHeavy: false,
      },
    });

    expect(result).toEqual({
      extractionMode: "native",
      useDocumentOcr: false,
      forcePageOcr: false,
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_CONTENT_END_MARKER,
  ATTACHMENT_CONTENT_START_MARKER,
  PDF_ATTACHMENT_EXCERPT_MAX_CHARS,
  PDF_UNTRUSTED_CONTENT_NOTICE,
  buildPdfAttachmentContent,
  extractAttachmentNames,
  stripPptxBubbleContent,
  stripStrategyContextBlock,
} from "../attachment-content";

describe("attachment-content helpers", () => {
  it("strips strategy metadata blocks from rendered prompt text", () => {
    const input = `Build me a live dashboard showing system metrics

[AGENT_STRATEGY_CONTEXT_V1]
intent=execution
conversation_mode=task
[/AGENT_STRATEGY_CONTEXT_V1]`;

    expect(stripStrategyContextBlock(input)).toBe(
      "Build me a live dashboard showing system metrics",
    );
  });

  it("can remove strategy metadata after attachment cleanup", () => {
    const input = `Build me a live dashboard showing system metrics

[AGENT_STRATEGY_CONTEXT_V1]
intent=execution
[/AGENT_STRATEGY_CONTEXT_V1]

Attached files (relative to workspace):
- metrics.csv (text/csv)`;

    const cleaned = stripStrategyContextBlock(stripPptxBubbleContent(input));
    expect(cleaned).toBe("Build me a live dashboard showing system metrics");
  });

  it("formats text-layer PDF attachments with stable parse_document cues", () => {
    const content = buildPdfAttachmentContent({
      fileName: "report.pdf",
      relativePath: ".cowork/uploads/123/report.pdf",
      summary: {
        pageCount: 2,
        nativeTextPages: 2,
        ocrPages: 0,
        scannedPages: 0,
        truncatedPages: false,
        extractionMode: "native",
        pages: [
          {
            pageIndex: 0,
            text: "Executive summary and financial highlights.",
            usedOcr: false,
            truncated: false,
          },
        ],
      },
    });

    expect(content).toContain("PDF attachment: report.pdf");
    expect(content).toContain("Path: .cowork/uploads/123/report.pdf");
    expect(content).toContain("Pages: 2");
    expect(content).toContain("Extraction status: native text; mode=native");
    expect(content).toContain("call parse_document with the Path above");
    expect(content).toContain("Use read_pdf_visual only for layout");
    expect(content).toContain(PDF_UNTRUSTED_CONTENT_NOTICE);
    expect(content).toContain("[Page 1]");
    expect(content).toContain("Executive summary and financial highlights.");
  });

  it("formats scanned or OCR PDF attachments with OCR status", () => {
    const content = buildPdfAttachmentContent({
      fileName: "scan.pdf",
      relativePath: ".cowork/uploads/123/scan.pdf",
      summary: {
        pageCount: 3,
        nativeTextPages: 0,
        ocrPages: 2,
        scannedPages: 3,
        truncatedPages: false,
        extractionMode: "page-ocr",
        imageHeavy: true,
        pages: [
          {
            pageIndex: 1,
            text: "Recognized receipt text.",
            usedOcr: true,
            truncated: false,
          },
        ],
      },
    });

    expect(content).toContain("Extraction status: ocr; mode=page-ocr");
    expect(content).toContain("[Page 2] [OCR]");
    expect(content).toContain("scanned_pages=3");
  });

  it("does not label zero-native-page image-heavy PDFs as native text", () => {
    const content = buildPdfAttachmentContent({
      fileName: "image-heavy.pdf",
      relativePath: ".cowork/uploads/123/image-heavy.pdf",
      summary: {
        pageCount: 2,
        nativeTextPages: 0,
        ocrPages: 0,
        scannedPages: 1,
        truncatedPages: false,
        extractionMode: "native",
        imageHeavy: true,
        pages: [
          {
            pageIndex: 0,
            text: "[No extractable text found on this page.]",
            usedOcr: false,
            truncated: false,
          },
        ],
      },
    });

    expect(content).toContain("Extraction status: scan preview; mode=native");
    expect(content).not.toContain("Extraction status: native text");
  });

  it("truncates long PDF excerpts without losing the path", () => {
    const content = buildPdfAttachmentContent({
      fileName: "long.pdf",
      relativePath: ".cowork/uploads/123/long.pdf",
      summary: {
        pageCount: 20,
        nativeTextPages: 20,
        ocrPages: 0,
        scannedPages: 0,
        truncatedPages: true,
        extractionMode: "native",
        pages: [
          {
            pageIndex: 0,
            text: "A".repeat(PDF_ATTACHMENT_EXCERPT_MAX_CHARS + 500),
            usedOcr: false,
            truncated: true,
          },
        ],
      },
    });

    expect(content).toContain("Path: .cowork/uploads/123/long.pdf");
    expect(content).toContain("PDF excerpt truncated");
    expect(content.length).toBeLessThan(PDF_ATTACHMENT_EXCERPT_MAX_CHARS + 1000);
  });

  it("extracts multiple attachment names when content blocks are present", () => {
    const input = `Read these files

Attached files (relative to workspace):
- report.pdf (.cowork/uploads/123/report.pdf)
  Extracted content:
  ${ATTACHMENT_CONTENT_START_MARKER}
    PDF attachment: report.pdf
    Path: .cowork/uploads/123/report.pdf
  ${ATTACHMENT_CONTENT_END_MARKER}

- data.csv (.cowork/uploads/123/data.csv)
  Extracted content:
  ${ATTACHMENT_CONTENT_START_MARKER}
    a,b
  ${ATTACHMENT_CONTENT_END_MARKER}`;

    expect(extractAttachmentNames(input)).toEqual(["report.pdf", "data.csv"]);
  });
});

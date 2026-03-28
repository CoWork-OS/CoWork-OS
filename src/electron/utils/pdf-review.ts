import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import { parsePdfBuffer } from "./pdf-parser";
import {
  OCR_TIMEOUT_MS,
  TESSERACT_LANGUAGE_DEFAULT,
  isTesseractInstalled,
  sanitizeOcrOutput,
} from "../ipc/image-viewer-ocr";
import type {
  PdfReviewExtractionMode,
  PdfReviewPageSummary,
  PdfReviewSummary,
} from "../../shared/types";

const execFile = promisify(execFileCallback);

type ExtractedTextItem = {
  str?: unknown;
  transform: number[];
  width?: number;
  height?: number;
};

type PdfReviewOptions = {
  maxPages?: number;
  maxCharsPerPage?: number;
  pageTextThreshold?: number;
  maxOcrPages?: number;
  renderScale?: number;
  includeOcr?: boolean;
};

type NativePageText = {
  pageIndex: number;
  text: string;
  charCount: number;
  wordCount: number;
};

type PdfCoverageReport = {
  totalPages: number;
  pageLimit: number;
  nativeTextPages: number;
  totalNativeChars: number;
  totalNativeWords: number;
  coverageRatio: number;
  averageCharsPerPage: number;
  averageWordsPerPage: number;
  imageHeavy: boolean;
};

export type PdfReviewData = PdfReviewSummary & {
  fullText: string;
  content: string;
};

const DEFAULT_MAX_PAGES = 12;
const DEFAULT_MAX_CHARS_PER_PAGE = 1800;
const DEFAULT_PAGE_TEXT_THRESHOLD = 32;
const DEFAULT_MAX_OCR_PAGES = 4;
const DEFAULT_RENDER_SCALE = 1800;
const IMAGE_HEAVY_COVERAGE_THRESHOLD = 0.45;
const IMAGE_HEAVY_AVG_CHAR_THRESHOLD = 140;
const IMAGE_HEAVY_AVG_WORD_THRESHOLD = 20;
const OCR_TEMP_PREFIX = "cowork-pdf-ocr-";
const OCRMYPDF_TEMP_PREFIX = "cowork-pdf-ocrmypdf-";
const OCRMYPDF_TIMEOUT_MS = 5 * 60 * 1000;

let ocrmypdfChecked = false;
let isOcrmypdfAvailable = false;
let ocrmypdfCheckedAt = 0;
const OCRMYPDF_BINARY_CHECK_TTL_MS = 5 * 60 * 1000;

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function groupTextLines(items: Array<{ str: string; x: number; y: number }>): string {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Array<{ text: string; y: number }> = [];
  const lineTolerance = 8;

  for (const item of sorted) {
    const existing = lines[lines.length - 1];
    if (!existing || Math.abs(existing.y - item.y) > lineTolerance) {
      lines.push({ text: item.str, y: item.y });
    } else {
      existing.text = `${existing.text} ${item.str}`;
    }
  }

  return lines
    .map((line) => normalizeWhitespace(line.text))
    .filter(Boolean)
    .join("\n");
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, maxChars).trimEnd()}\n[... page text truncated to first ${maxChars} characters ...]`,
    truncated: true,
  };
}

async function loadPdfJs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function isOcrmypdfInstalled(): Promise<boolean> {
  const now = Date.now();
  if (ocrmypdfChecked && now - ocrmypdfCheckedAt < OCRMYPDF_BINARY_CHECK_TTL_MS) {
    return isOcrmypdfAvailable;
  }

  ocrmypdfChecked = true;
  ocrmypdfCheckedAt = now;
  try {
    await execFile("ocrmypdf", ["--version"], { timeout: 3000 });
    isOcrmypdfAvailable = true;
  } catch {
    isOcrmypdfAvailable = false;
  }
  return isOcrmypdfAvailable;
}

async function runOcrmypdf(pdfPath: string): Promise<Buffer | null> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), OCRMYPDF_TEMP_PREFIX));
  const outputPath = path.join(tempDir, "ocr.pdf");
  try {
    await execFile(
      "ocrmypdf",
      [
        "--skip-text",
        "--deskew",
        "--rotate-pages",
        "--quiet",
        pdfPath,
        outputPath,
      ],
      {
        timeout: OCRMYPDF_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return await fs.readFile(outputPath);
  } catch {
    return null;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function renderPdfPageForOcr(pdfPath: string, pageNumber: number, renderScale: number) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), OCR_TEMP_PREFIX));
  const outputPrefix = path.join(tempDir, `page-${pageNumber}`);
  try {
    await execFile(
      "pdftoppm",
      [
        "-f",
        String(pageNumber),
        "-singlefile",
        "-png",
        "-scale-to-x",
        String(renderScale),
        "-scale-to-y",
        "-1",
        pdfPath,
        outputPrefix,
      ],
      { timeout: 15_000 },
    );
    return `${outputPrefix}.png`;
  } catch {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

async function runPdfPageOcr(imagePath: string): Promise<string | null> {
  const available = await isTesseractInstalled();
  if (!available) return null;

  try {
    const { stdout } = await execFile(
      "tesseract",
      [imagePath, "stdout", "-l", TESSERACT_LANGUAGE_DEFAULT],
      {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    const cleaned = sanitizeOcrOutput(stdout || "");
    return cleaned || null;
  } catch {
    return null;
  }
}

async function extractPageText(page: Any): Promise<string> {
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();
  const textItems = textContent.items as ExtractedTextItem[];
  const lines = textItems
    .filter((item) => typeof item.str === "string" && String(item.str).trim().length > 0)
    .map((item) => {
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      return {
        str: String(item.str),
        x,
        y,
      };
    });
  return groupTextLines(lines);
}

function buildReviewBlock(pageIndex: number, text: string, usedOcr: boolean): string {
  const lines = [`[Page ${pageIndex + 1}]`];
  if (usedOcr) {
    lines.push("[OCR fallback used]");
  }
  lines.push(text || "[No extractable text found on this page.]");
  return lines.join("\n");
}

function countWords(text: string): number {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return 0;
  return normalized.split(/\s+/).filter(Boolean).length;
}

function assessPdfCoverage(nativePages: NativePageText[], totalPages: number, pageLimit: number): PdfCoverageReport {
  const nativeTextPages = nativePages.filter((page) => page.text.length > 0).length;
  const totalNativeChars = nativePages.reduce((sum, page) => sum + page.charCount, 0);
  const totalNativeWords = nativePages.reduce((sum, page) => sum + page.wordCount, 0);
  const coverageRatio = pageLimit > 0 ? nativeTextPages / pageLimit : 0;
  const averageCharsPerPage = pageLimit > 0 ? totalNativeChars / pageLimit : 0;
  const averageWordsPerPage = pageLimit > 0 ? totalNativeWords / pageLimit : 0;
  const imageHeavy =
    pageLimit > 0 &&
    (coverageRatio <= IMAGE_HEAVY_COVERAGE_THRESHOLD ||
      averageCharsPerPage <= IMAGE_HEAVY_AVG_CHAR_THRESHOLD ||
      averageWordsPerPage <= IMAGE_HEAVY_AVG_WORD_THRESHOLD);

  return {
    totalPages,
    pageLimit,
    nativeTextPages,
    totalNativeChars,
    totalNativeWords,
    coverageRatio,
    averageCharsPerPage,
    averageWordsPerPage,
    imageHeavy,
  };
}

export function decidePdfExtractionMode(params: {
  includeOcr: boolean;
  ocrmypdfAvailable: boolean;
  coverage: PdfCoverageReport;
}): {
  extractionMode: PdfReviewExtractionMode;
  useDocumentOcr: boolean;
  forcePageOcr: boolean;
} {
  const { includeOcr, ocrmypdfAvailable, coverage } = params;
  const useDocumentOcr = Boolean(includeOcr && ocrmypdfAvailable && coverage.imageHeavy);
  const forcePageOcr = Boolean(includeOcr && coverage.imageHeavy && !useDocumentOcr);

  return {
    extractionMode: useDocumentOcr
      ? "ocrmypdf"
      : forcePageOcr
        ? "page-ocr"
        : "native",
    useDocumentOcr,
    forcePageOcr,
  };
}

async function collectNativePageTexts(document: Any, pageLimit: number): Promise<NativePageText[]> {
  const pages: NativePageText[] = [];
  for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
    const page = await document.getPage(pageIndex + 1);
    const text = normalizeWhitespace(await extractPageText(page));
    pages.push({
      pageIndex,
      text,
      charCount: text.length,
      wordCount: countWords(text),
    });
  }
  return pages;
}

async function buildPdfReviewFromDocument(
  pdfPath: string,
  document: Any,
  nativePages: NativePageText[],
  coverage: PdfCoverageReport,
  options: PdfReviewOptions,
  extractionMode: PdfReviewExtractionMode,
  forcePageOcr: boolean,
): Promise<PdfReviewData> {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
  const maxCharsPerPage = Math.max(200, Math.floor(options.maxCharsPerPage ?? DEFAULT_MAX_CHARS_PER_PAGE));
  const pageTextThreshold = Math.max(1, Math.floor(options.pageTextThreshold ?? DEFAULT_PAGE_TEXT_THRESHOLD));
  const maxOcrPages = Math.max(0, Math.floor(options.maxOcrPages ?? DEFAULT_MAX_OCR_PAGES));
  const renderScale = Math.max(800, Math.floor(options.renderScale ?? DEFAULT_RENDER_SCALE));
  const includeOcr = options.includeOcr !== false;

  const pageLimit = Math.min(coverage.totalPages, maxPages);
  const effectiveOcrPageLimit = forcePageOcr ? pageLimit : maxOcrPages;

  const pages: PdfReviewPageSummary[] = [];
  const reviewBlocks: string[] = [];
  let nativeTextPages = 0;
  let ocrPages = 0;
  let scannedPages = 0;
  let ocrAttempts = 0;

  try {
    for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
      const nativePage = nativePages[pageIndex] ?? {
        pageIndex,
        text: "",
        charCount: 0,
        wordCount: 0,
      };

      let pageText = nativePage.text;
      let usedOcr = false;

      if (pageText) {
        nativeTextPages += 1;
      }

      const shouldTryOcr =
        includeOcr &&
        ocrAttempts < effectiveOcrPageLimit &&
        (forcePageOcr ||
          nativePage.charCount < pageTextThreshold ||
          nativePage.wordCount < pageTextThreshold);

      if (shouldTryOcr) {
        scannedPages += 1;
        const pageImagePath = await renderPdfPageForOcr(pdfPath, pageIndex + 1, renderScale);
        if (pageImagePath) {
          ocrAttempts += 1;
          const ocrText = await runPdfPageOcr(pageImagePath);
          if (ocrText) {
            const cleanedOcrText = normalizeWhitespace(ocrText);
            if (
              forcePageOcr ||
              !pageText ||
              cleanedOcrText.length >= pageText.length * 0.8 ||
              cleanedOcrText.length > pageText.length + 60
            ) {
              pageText = cleanedOcrText;
              usedOcr = true;
              ocrPages += 1;
            }
          }
          await fs.rm(path.dirname(pageImagePath), { recursive: true, force: true }).catch(() => {});
        }
      }

      const normalizedPageText = normalizeWhitespace(pageText || "");
      const effectiveText = normalizedPageText || "[No extractable text found on this page.]";
      const truncatedResult = truncateText(effectiveText, maxCharsPerPage);

      pages.push({
        pageIndex,
        text: truncatedResult.text,
        usedOcr,
        truncated: truncatedResult.truncated,
      });
      reviewBlocks.push(buildReviewBlock(pageIndex, truncatedResult.text, usedOcr));
    }
  } finally {
    if (typeof document.destroy === "function") {
      await document.destroy();
    }
  }

  if (coverage.totalPages > pageLimit) {
    reviewBlocks.push(`[... ${coverage.totalPages - pageLimit} additional page(s) omitted from preview ...]`);
  }

  const effectiveMode =
    extractionMode === "ocrmypdf"
      ? "ocrmypdf"
      : ocrPages > 0
        ? "page-ocr"
        : extractionMode;

  return {
    pageCount: coverage.totalPages,
    nativeTextPages,
    ocrPages,
    scannedPages,
    truncatedPages: coverage.totalPages > pageLimit,
    extractionMode: effectiveMode,
    imageHeavy: coverage.imageHeavy,
    pages,
    fullText: reviewBlocks.join("\n\n"),
    content: reviewBlocks.join("\n\n"),
  };
}

async function extractPdfReviewDataImpl(
  pdfPath: string,
  buffer: Buffer,
  options: PdfReviewOptions = {},
  allowDocumentOcr = true,
): Promise<PdfReviewData> {
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));

  try {
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({ data: buffer });
    const document = await loadingTask.promise;

    const pageLimit = Math.min(document.numPages, maxPages);
    const nativePages = await collectNativePageTexts(document, pageLimit);
    const coverage = assessPdfCoverage(nativePages, document.numPages, pageLimit);
    const ocrmypdfAvailable = allowDocumentOcr ? await isOcrmypdfInstalled() : false;
    const decision = decidePdfExtractionMode({
      includeOcr: options.includeOcr !== false,
      ocrmypdfAvailable,
      coverage,
    });

    if (allowDocumentOcr && decision.useDocumentOcr) {
      const ocrBuffer = await runOcrmypdf(pdfPath);
      if (ocrBuffer) {
        const review = await extractPdfReviewDataImpl(
          `${pdfPath}#ocrmypdf`,
          ocrBuffer,
          {
            ...options,
            includeOcr: false,
          },
          false,
        );
        return review.extractionMode === "fallback"
          ? review
          : {
              ...review,
              extractionMode: "ocrmypdf",
              imageHeavy: true,
            };
      }
    }

    return await buildPdfReviewFromDocument(
      pdfPath,
      document,
      nativePages,
      coverage,
      options,
      decision.extractionMode,
      decision.forcePageOcr,
    );
  } catch {
    try {
      const legacy = await parsePdfBuffer(buffer);
      const fallbackText = normalizeWhitespace(legacy.text || "");
      const truncatedResult = truncateText(
        fallbackText || "[No extractable text found in PDF.]",
        Math.max(200, Math.floor(options.maxCharsPerPage ?? DEFAULT_MAX_CHARS_PER_PAGE)),
      );
      const pages: PdfReviewPageSummary[] = [
        {
          pageIndex: 0,
          text: truncatedResult.text,
          usedOcr: false,
          truncated: truncatedResult.truncated,
        },
      ];
      return {
        pageCount: legacy.numpages || 1,
        nativeTextPages: fallbackText ? 1 : 0,
        ocrPages: 0,
        scannedPages: 0,
        truncatedPages: Boolean(legacy.numpages && legacy.numpages > 1),
        extractionMode: "fallback",
        imageHeavy: false,
        pages,
        fullText: buildReviewBlock(0, truncatedResult.text, false),
        content: buildReviewBlock(0, truncatedResult.text, false),
      };
    } catch {
      const placeholder = "[No extractable text found in PDF.]";
      const truncatedResult = truncateText(
        placeholder,
        Math.max(200, Math.floor(options.maxCharsPerPage ?? DEFAULT_MAX_CHARS_PER_PAGE)),
      );
      const pages: PdfReviewPageSummary[] = [
        {
          pageIndex: 0,
          text: truncatedResult.text,
          usedOcr: false,
          truncated: truncatedResult.truncated,
        },
      ];
      return {
        pageCount: 1,
        nativeTextPages: 0,
        ocrPages: 0,
        scannedPages: 0,
        truncatedPages: false,
        extractionMode: "fallback",
        imageHeavy: false,
        pages,
        fullText: buildReviewBlock(0, truncatedResult.text, false),
        content: buildReviewBlock(0, truncatedResult.text, false),
      };
    }
  }
}

export async function extractPdfReviewData(
  pdfPath: string,
  options: PdfReviewOptions = {},
): Promise<PdfReviewData> {
  const buffer = await fs.readFile(pdfPath);
  return extractPdfReviewDataImpl(pdfPath, buffer, options, true);
}

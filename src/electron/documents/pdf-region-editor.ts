import * as fs from "fs/promises";
import * as path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

type PdfRegionEditInput = {
  sourcePath: string;
  destPath: string;
  pageIndex: number;
  bbox: { x: number; y: number; w: number; h: number };
  instruction: string;
  selectionText?: string;
};

type ExtractedTextItem = {
  str: string;
  x: number;
  y: number;
};

type TextLine = {
  text: string;
  y: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function inferFontStyle(instruction: string): "regular" | "italic" | "bold" | "bold-italic" {
  const normalized = instruction.toLowerCase();
  const italic = /\bitalic(?:ize|ise|ized|ised)?\b|\bitalics?\b/.test(normalized);
  const bold = /\bbold\b/.test(normalized);
  if (bold && italic) return "bold-italic";
  if (bold) return "bold";
  if (italic) return "italic";
  return "regular";
}

function inferReplacementText(instruction: string, selectionText?: string): string {
  const trimmedSelection = normalizeWhitespace(selectionText || "");
  const normalized = instruction.trim();
  if (!normalized) return trimmedSelection;

  const explicitReplacement = normalized.match(
    /\b(?:replace|rewrite|change|set)\b[\s\S]{0,80}\b(?:with|to)\b\s+["“”']?(.+?)["“”']?$/i,
  );
  if (explicitReplacement?.[1]) {
    return normalizeWhitespace(explicitReplacement[1]);
  }

  const quoted = Array.from(normalized.matchAll(/["“”']([^"“”']+)["“”']/g)).map(
    (match) => match[1],
  );
  if (quoted.length > 0 && /\b(?:replace|rewrite|change|set)\b/i.test(normalized)) {
    return normalizeWhitespace(quoted[quoted.length - 1]);
  }

  return trimmedSelection;
}

async function loadPdfJs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

function groupTextLines(items: ExtractedTextItem[]): string {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextLine[] = [];
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
    .map((line) => normalizeLineText(line.text))
    .filter(Boolean)
    .join("\n");
}

function wrapParagraph(paragraph: string, font: Any, fontSize: number, maxWidth: number): string[] {
  const normalized = normalizeLineText(paragraph);
  if (!normalized) return [""];

  const words = normalized.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    const candidateWidth = font.widthOfTextAtSize(candidate, fontSize);
    if (candidateWidth <= maxWidth || !currentLine) {
      currentLine = candidate;
      continue;
    }
    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [normalized];
}

function wrapTextToBox(text: string, font: Any, fontSize: number, maxWidth: number): string[] {
  const wrapped: string[] = [];
  const paragraphs = text.split("\n");
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      wrapped.push("");
      continue;
    }
    wrapped.push(...wrapParagraph(paragraph, font, fontSize, maxWidth));
  }
  return wrapped;
}

function measureWrappedTextHeight(fontSize: number, lineCount: number): number {
  const lineHeight = fontSize * 1.18;
  return lineCount > 0 ? lineCount * lineHeight : 0;
}

function chooseFontSize(
  text: string,
  font: Any,
  maxWidth: number,
  maxHeight: number,
): { size: number; lines: string[] } {
  const maxSize = Math.max(8, Math.min(24, maxHeight * 0.28));
  const minSize = 7;
  for (let size = maxSize; size >= minSize; size -= 0.5) {
    const lines = wrapTextToBox(text, font, size, maxWidth);
    const height = measureWrappedTextHeight(size, lines.length);
    const widest = lines.reduce(
      (max, line) => Math.max(max, font.widthOfTextAtSize(line, size)),
      0,
    );
    if (widest <= maxWidth && height <= maxHeight) {
      return { size, lines };
    }
  }

  const fallbackSize = minSize;
  return {
    size: fallbackSize,
    lines: wrapTextToBox(text, font, fallbackSize, maxWidth),
  };
}

async function extractSelectionText(
  sourceBytes: Uint8Array,
  pageIndex: number,
  bbox: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: sourceBytes });
  const document = await loadingTask.promise;
  try {
    if (pageIndex < 0 || pageIndex >= document.numPages) {
      return "";
    }

    const page = await document.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const textItems = textContent.items as Array<{
      str?: unknown;
      transform: number[];
      width?: number;
      height?: number;
    }>;
    const selectionRect = {
      x: bbox.x * viewport.width,
      y: bbox.y * viewport.height,
      w: bbox.w * viewport.width,
      h: bbox.h * viewport.height,
    };
    const right = selectionRect.x + selectionRect.w;
    const bottom = selectionRect.y + selectionRect.h;

    const items: ExtractedTextItem[] = [];
    for (const item of textItems) {
      if (typeof item.str !== "string" || !item.str.trim()) continue;
      const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      const itemWidth = Math.max(0, Number(item.width || 0));
      const itemHeight = Math.max(0, Number(item.height || 0));
      const itemRight = x + itemWidth;
      const itemBottom = y + itemHeight;
      const intersects =
        x <= right + 8 &&
        itemRight >= selectionRect.x - 8 &&
        y <= bottom + 8 &&
        itemBottom >= selectionRect.y - 8;
      if (intersects) {
        items.push({ str: item.str, x, y });
      }
    }

    return groupTextLines(items);
  } finally {
    await loadingTask.destroy();
    if (typeof document.destroy === "function") {
      await document.destroy();
    }
  }
}

export async function editPdfRegion(input: PdfRegionEditInput): Promise<void> {
  await fs.mkdir(path.dirname(input.destPath), { recursive: true });
  const sourceBytes = await fs.readFile(input.sourcePath);
  const pdfBytes = await PDFDocument.load(sourceBytes);
  const page = pdfBytes.getPage(input.pageIndex);
  if (!page) {
    throw new Error(`Page ${input.pageIndex + 1} was not found in the source PDF.`);
  }

  const selectionText =
    normalizeWhitespace(input.selectionText || "") ||
    (await extractSelectionText(sourceBytes, input.pageIndex, input.bbox)) ||
    "selected text";
  const replacementText = inferReplacementText(input.instruction, selectionText);
  const fontStyle = inferFontStyle(input.instruction);
  const font =
    fontStyle === "italic"
      ? await pdfBytes.embedFont(StandardFonts.HelveticaOblique)
      : fontStyle === "bold"
        ? await pdfBytes.embedFont(StandardFonts.HelveticaBold)
        : fontStyle === "bold-italic"
          ? await pdfBytes.embedFont(StandardFonts.HelveticaBoldOblique)
          : await pdfBytes.embedFont(StandardFonts.Helvetica);

  const pageSize = page.getSize();
  const x = input.bbox.x * pageSize.width;
  const width = Math.max(1, input.bbox.w * pageSize.width);
  const height = Math.max(1, input.bbox.h * pageSize.height);
  const y = pageSize.height - (input.bbox.y + input.bbox.h) * pageSize.height;
  const padding = Math.max(1.5, Math.min(8, height * 0.12));
  const textBoxWidth = Math.max(1, width - padding * 2);
  const textBoxHeight = Math.max(1, height - padding * 2);
  const fit = chooseFontSize(replacementText, font, textBoxWidth, textBoxHeight);
  const fontSize = fit.size;
  const lines = fit.lines;
  const lineHeight = fontSize * 1.18;
  const textX = x + padding;
  const textTop = y + height - padding - fontSize;

  page.drawRectangle({
    x,
    y,
    width,
    height,
    color: rgb(1, 1, 1),
    borderColor: rgb(1, 1, 1),
    borderWidth: 0,
  });

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineY = textTop - index * lineHeight;
    if (lineY < y + padding - lineHeight) break;
    page.drawText(line, {
      x: textX,
      y: lineY,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
  }

  const output = await pdfBytes.save();
  await fs.writeFile(input.destPath, output);
}

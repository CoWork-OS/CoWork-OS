import { loadDocumentArchive, readDocumentArchiveBuffer } from "../../security/document-archive";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  Footer,
  PageBreak,
  PageNumber,
} from "docx";
import PDFDocument from "pdfkit";
import * as mammoth from "mammoth";
import { Workspace } from "../../../shared/types";
import { parseMarkdownTable } from "../../utils/document-generators/markdown-tables";
import { needsUnicodeFont, resolvePdfFonts } from "../../utils/pdf-unicode-fonts";

export interface ContentBlock {
  type: string; // 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'page_break'
  text: string;
  level?: number; // For headings: 1-6
  items?: string[]; // For lists
  rows?: string[][]; // For tables
  language?: string; // For code blocks
}

/**
 * A content block as a tool call sends it: tables and lists often carry only
 * rows/items, and cells may be numbers.
 */
export type ContentBlockInput = Omit<Partial<ContentBlock>, "items" | "rows"> & {
  items?: unknown[];
  rows?: unknown[];
};

export interface DocumentCreateReport {
  /** Blocks in the request. */
  requestedBlocks: number;
  /** Blocks written to the document. */
  renderedBlocks: number;
  /** Blocks with nothing to write, by position in the request. */
  droppedBlocks: Array<{ index: number; type: string; reason: string }>;
  warnings: string[];
}

/** A normalized block: every field a renderer reads is present. */
interface RenderBlock {
  type: string;
  text: string;
  level: number;
  items: string[];
  rows: string[][];
  language?: string;
}

const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/;

/** Block type that ends the current page; it carries no text. */
const PAGE_BREAK = "page_break";
const PAGE_BREAK_ALIASES = new Set([PAGE_BREAK, "pagebreak", "page-break", "page break"]);

function blockText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Rows as strings, padded to one column count; empty when no cell has text. */
function normalizeRows(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  const rows = value.map((row): string[] =>
    Array.isArray(row)
      ? row.map(blockText)
      : row && typeof row === "object"
        ? Object.values(row).map(blockText)
        : [blockText(row)],
  );
  if (!rows.some((row) => row.some((cell) => cell.trim()))) return [];
  const columns = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => [...row, ...Array<string>(columns - row.length).fill("")]);
}

function renderBlock(type: string, fields: Partial<RenderBlock>): RenderBlock {
  return { type, text: "", level: 1, items: [], rows: [], ...fields };
}

/** Maps one requested block to what gets drawn, or the reason nothing can be. */
function normalizeBlock(raw: unknown): RenderBlock | { type: string; reason: string } {
  const block: ContentBlockInput =
    raw && typeof raw === "object" ? (raw as ContentBlockInput) : { text: blockText(raw) };
  const type = (typeof block.type === "string" && block.type.trim().toLowerCase()) || "paragraph";
  const text = blockText(block.text);
  const hasText = text.trim().length > 0;
  const items = Array.isArray(block.items)
    ? block.items.map((item) => blockText(item).trim()).filter(Boolean)
    : [];
  const rows = normalizeRows(block.rows);
  const level = Math.min(Math.max(Math.trunc(Number(block.level)) || 1, 1), 6);

  if (PAGE_BREAK_ALIASES.has(type)) return renderBlock(PAGE_BREAK, {});
  if (type === "table") {
    if (rows.length > 0) return renderBlock(type, { rows });
    // A markdown table sent as text becomes a real table rather than pipes.
    const parsed = hasText ? parseMarkdownTable(text) : null;
    if (parsed) return renderBlock(type, { rows: normalizeRows([parsed.header, ...parsed.rows]) });
    return hasText ? renderBlock("paragraph", { text }) : { type, reason: "no rows" };
  }
  if (type === "list") {
    const lines =
      items.length > 0
        ? items
        : text
            .split("\n")
            .map((line) => line.replace(LIST_MARKER, "").trim())
            .filter(Boolean);
    return lines.length > 0 ? renderBlock(type, { items: lines }) : { type, reason: "no items" };
  }
  const language = typeof block.language === "string" ? block.language : undefined;
  if (hasText) return renderBlock(type, { text, level, language });
  if (items.length > 0) return renderBlock("list", { items });
  if (rows.length > 0) return renderBlock("table", { rows });
  return { type, reason: "no text" };
}

const DOCUMENT_FORMATS = ["docx", "pdf"] as const;
type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/**
 * The file name create_document writes. A name that already ends in the
 * format's extension (in any case) is used exactly as given; a name without
 * one gets it appended. The format may be left out when the name's
 * extension states it. A name ending in the other format's extension is
 * rejected instead of being written as "report.docx.pdf".
 */
export function resolveDocumentFilename(
  filename: unknown,
  format: unknown,
): { filename: string; format: DocumentFormat } {
  const name = typeof filename === "string" ? filename.trim() : "";
  if (!name) throw new Error('Missing required "filename", for example "report.pdf".');
  const extension = path.extname(name).slice(1).toLowerCase();
  const nameFormat = DOCUMENT_FORMATS.find((candidate) => candidate === extension);
  const requested = typeof format === "string" ? format.trim().toLowerCase() : "";
  if (requested && !DOCUMENT_FORMATS.some((candidate) => candidate === requested)) {
    throw new Error(`Unsupported document format "${String(format)}". Use "docx" or "pdf".`);
  }
  const resolved = (requested || nameFormat) as DocumentFormat | undefined;
  if (!resolved) {
    throw new Error(
      `Missing "format" for "${name}". Use "docx" or "pdf", or end the filename in .docx or .pdf.`,
    );
  }
  if (nameFormat && nameFormat !== resolved) {
    const stem = name.slice(0, -(extension.length + 1));
    throw new Error(
      `Filename "${name}" ends in .${nameFormat} but format is "${resolved}". ` +
        `Use filename "${stem}.${resolved}" for a ${resolved.toUpperCase()} file.`,
    );
  }
  return { filename: nameFormat ? name : `${name}.${resolved}`, format: resolved };
}

export interface DocumentOptions {
  title?: string;
  author?: string;
  subject?: string;
  /** Font size in points (default: 12) */
  fontSize?: number;
  /** Page margins in inches */
  margins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  /** Print "N / M" centered in the footer of every page. */
  pageNumbers?: boolean;
}

/** Space between table cell text and the cell's edges and rules, in points. */
const PDF_CELL_PAD_X = 5;
const PDF_CELL_PAD_Y = 4;
/** Space above and below a heading, in points. */
const PDF_HEADING_SPACE_ABOVE = 8;
const PDF_HEADING_SPACE_BELOW = 6;
/** How deep a run of consecutive headings is followed when keeping it with its content. */
const PDF_KEEP_WITH_NEXT_DEPTH = 4;

type PdfDocument = InstanceType<typeof PDFDocument>;

/**
 * Lays content blocks out on a pdfkit document.
 *
 * Tables use one layout model: a row is as tall as its tallest wrapped cell
 * plus top and bottom padding, its rule is drawn exactly at the row's bottom
 * edge, and the next row starts there. Rules therefore always sit in the
 * padding between rows. A row that does not fit above the bottom margin
 * starts a new page, where the header row is drawn again. Headings move to a
 * new page when the first part of the content they introduce would not fit
 * below them.
 */
class PdfBlockRenderer {
  private readonly warnings: string[] = [];

  constructor(
    private readonly doc: PdfDocument,
    private readonly fonts: { regular: string; bold: string },
    private readonly baseFontSize: number,
    private readonly codeFont: (text: string) => string,
  ) {}

  render(blocks: RenderBlock[]): string[] {
    blocks.forEach((block, index) => this.renderBlock(blocks, index));
    return this.warnings;
  }

  /** Writes "N / M" centered in the bottom margin of every page. */
  stampPageNumbers(): void {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index++) {
      doc.switchToPage(range.start + index);
      const { margins } = doc.page;
      const bottomMargin = margins.bottom;
      // Text inside the bottom margin would otherwise start another page.
      margins.bottom = 0;
      doc
        .font(this.fonts.regular)
        .fontSize(9)
        .fillColor("#666666")
        .text(
          `${index + 1} / ${range.count}`,
          margins.left,
          doc.page.height - bottomMargin / 2 - 4,
          { width: this.contentWidth, align: "center", lineBreak: false },
        );
      margins.bottom = bottomMargin;
    }
    doc.fillColor("#000000");
  }

  private get contentWidth(): number {
    const { page } = this.doc;
    return page.width - page.margins.left - page.margins.right;
  }

  private get contentBottom(): number {
    const { page } = this.doc;
    return page.height - page.margins.bottom;
  }

  private get contentHeight(): number {
    const { page } = this.doc;
    return page.height - page.margins.top - page.margins.bottom;
  }

  private atPageTop(): boolean {
    return this.doc.y <= this.doc.page.margins.top + 0.5;
  }

  /** Starts a new page unless `height` fits below the cursor or the page is still empty. */
  private ensureSpace(height: number): void {
    if (this.atPageTop()) return;
    if (this.doc.y + Math.min(height, this.contentHeight) > this.contentBottom) {
      this.doc.addPage();
    }
  }

  private headingFontSize(level: number): number {
    return this.baseFontSize + (7 - Math.min(Math.max(level || 1, 1), 6)) * 2; // h1 = base+12
  }

  /** Height of a heading including the space above and below it. */
  private headingHeight(block: RenderBlock): number {
    const { doc } = this;
    doc.font(this.fonts.bold).fontSize(this.headingFontSize(block.level));
    return (
      PDF_HEADING_SPACE_ABOVE +
      doc.heightOfString(block.text, {
        width: this.contentWidth,
        paragraphGap: PDF_HEADING_SPACE_BELOW,
      })
    );
  }

  /**
   * The part of block `index` that must share a page with a heading before
   * it: up to two lines of text, the first list item, or a table's header
   * and first row. A heading counts with what follows it.
   */
  private minimumHeight(blocks: RenderBlock[], index: number, depth = 0): number {
    const block = blocks[index];
    if (!block || block.type === PAGE_BREAK) return 0;
    const { doc } = this;
    const width = this.contentWidth;
    switch (block.type) {
      case "heading":
        return (
          this.headingHeight(block) +
          (depth < PDF_KEEP_WITH_NEXT_DEPTH ? this.minimumHeight(blocks, index + 1, depth + 1) : 0)
        );
      case "table": {
        const heights = this.tableRowHeights(block.rows);
        return heights[0] + (heights[1] ?? 0);
      }
      case "list":
        doc.font(this.fonts.regular).fontSize(this.baseFontSize);
        return doc.heightOfString(`• ${block.items[0] ?? ""}`, {
          width,
          indent: 20,
          paragraphGap: 4,
        });
      case "code": {
        doc.font(this.codeFont(block.text)).fontSize(this.baseFontSize - 2);
        const full = doc.heightOfString(block.text, { width, paragraphGap: 8 });
        return Math.min(full, doc.currentLineHeight(true) * 2);
      }
      default: {
        doc.font(this.fonts.regular).fontSize(this.baseFontSize);
        const full = doc.heightOfString(block.text, { width, paragraphGap: 8, lineGap: 4 });
        return Math.min(full, (doc.currentLineHeight(true) + 4) * 2);
      }
    }
  }

  private renderBlock(blocks: RenderBlock[], index: number): void {
    const { doc } = this;
    const block = blocks[index];
    const baseFontSize = this.baseFontSize;
    switch (block.type) {
      case PAGE_BREAK:
        // A break on an empty page would only add a blank page.
        if (!this.atPageTop()) doc.addPage();
        break;

      case "heading": {
        this.ensureSpace(this.minimumHeight(blocks, index));
        // More space above a heading than below it ties it to its own section.
        if (!this.atPageTop()) doc.y += PDF_HEADING_SPACE_ABOVE;
        doc
          .font(this.fonts.bold)
          .fontSize(this.headingFontSize(block.level))
          .text(block.text, { paragraphGap: PDF_HEADING_SPACE_BELOW });
        break;
      }

      case "paragraph":
        doc
          .font(this.fonts.regular)
          .fontSize(baseFontSize)
          .text(block.text, { paragraphGap: 8, lineGap: 4 });
        doc.moveDown(0.5);
        break;

      case "list": {
        doc.font(this.fonts.regular).fontSize(baseFontSize);
        for (const item of block.items) {
          doc.text(`• ${item}`, { indent: 20, paragraphGap: 4 });
        }
        doc.moveDown(0.5);
        break;
      }

      case "table":
        if (block.rows.length > 0) this.renderTable(block.rows);
        break;

      case "code":
        doc
          .font(this.codeFont(block.text))
          .fontSize(baseFontSize - 2)
          .fillColor("#333333")
          .text(block.text, { paragraphGap: 8 });
        doc.fillColor("#000000");
        doc.moveDown(0.5);
        break;

      default:
        doc.font(this.fonts.regular).fontSize(baseFontSize).text(block.text);
        doc.moveDown(0.5);
    }
  }

  private get tableFontSize(): number {
    return this.baseFontSize - 1;
  }

  private cellTextWidth(columnCount: number): number {
    return this.contentWidth / columnCount - PDF_CELL_PAD_X * 2;
  }

  /** Height of each row: its tallest wrapped cell plus top and bottom padding. */
  private tableRowHeights(rows: string[][]): number[] {
    const { doc } = this;
    const width = this.cellTextWidth(rows[0].length);
    doc.fontSize(this.tableFontSize);
    return rows.map((row, rowIndex) => {
      doc.font(rowIndex === 0 ? this.fonts.bold : this.fonts.regular);
      const textHeight = Math.max(...row.map((cell) => doc.heightOfString(cell || " ", { width })));
      return textHeight + PDF_CELL_PAD_Y * 2;
    });
  }

  private tableRule(y: number, strong: boolean): void {
    const { doc } = this;
    const left = doc.page.margins.left;
    doc
      .save()
      .lineWidth(strong ? 0.8 : 0.5)
      .strokeColor(strong ? "#444444" : "#AAAAAA")
      .moveTo(left, y)
      .lineTo(left + this.contentWidth, y)
      .stroke()
      .restore();
  }

  private renderTable(rows: string[][]): void {
    const { doc } = this;
    const columnCount = rows[0].length;
    const colWidth = this.contentWidth / columnCount;
    const cellWidth = this.cellTextWidth(columnCount);
    const hasHeader = rows.length > 1;
    const heights = this.tableRowHeights(rows);

    // The header never ends a page without the first row under it.
    this.ensureSpace(heights[0] + (hasHeader ? heights[1] : 0));
    let y = doc.y;
    this.tableRule(y, true);

    const drawRow = (rowIndex: number, available: number): void => {
      const row = rows[rowIndex];
      const left = doc.page.margins.left;
      // A row taller than a whole page is cut at the page bottom rather
      // than letting its cells flow onto pages of their own.
      const clip = heights[rowIndex] > available;
      const rowHeight = clip ? available : heights[rowIndex];
      if (clip) {
        this.warnings.push(
          `Table row ${rowIndex + 1} is taller than a page and was shortened to fit.`,
        );
      }
      doc.font(rowIndex === 0 ? this.fonts.bold : this.fonts.regular).fontSize(this.tableFontSize);
      for (let colIndex = 0; colIndex < row.length; colIndex++) {
        doc.text(row[colIndex], left + colIndex * colWidth + PDF_CELL_PAD_X, y + PDF_CELL_PAD_Y, {
          width: cellWidth,
          ...(clip ? { height: rowHeight - PDF_CELL_PAD_Y * 2, ellipsis: true } : {}),
        });
      }
      y += rowHeight;
      this.tableRule(y, rowIndex === 0 && hasHeader);
    };

    // Body rows drawn on the current page; a page holding only the header
    // keeps the next row even when that row has to be shortened.
    let bodyRowsOnPage = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      if (rowIndex > 0 && bodyRowsOnPage > 0 && y + heights[rowIndex] > this.contentBottom) {
        doc.addPage();
        y = doc.y;
        this.tableRule(y, true);
        if (hasHeader) drawRow(0, this.contentHeight);
        bodyRowsOnPage = 0;
      }
      drawRow(rowIndex, this.contentBottom - y);
      if (rowIndex > 0 || !hasHeader) bodyRowsOnPage++;
    }

    // Cells moved the cursor into the last column; later blocks start at the margin.
    doc.x = doc.page.margins.left;
    doc.y = y;
    doc.font(this.fonts.regular).fontSize(this.baseFontSize).moveDown(0.5);
  }
}

/**
 * Represents a document section identified by a heading
 */
interface DocumentSection {
  headingLevel: number;
  headingText: string;
  sectionNumber?: string;
  startIndex: number;
  endIndex: number;
  xmlContent: string;
}

/**
 * DocumentBuilder creates Word documents (.docx) and PDFs using docx and pdfkit
 */
export class DocumentBuilder {
  constructor(private workspace: Workspace) {}

  async create(
    outputPath: string,
    format: "docx" | "pdf" | "md",
    content: ContentBlockInput[] | ContentBlockInput | string | undefined,
    options: DocumentOptions = {},
  ): Promise<DocumentCreateReport> {
    // Normalize content to always be an array
    const { blocks, droppedBlocks, requestedBlocks } = this.normalizeContent(content);
    const ext = path.extname(outputPath).toLowerCase();
    const report: DocumentCreateReport = {
      requestedBlocks,
      renderedBlocks: blocks.length,
      droppedBlocks,
      warnings: [],
    };

    // Allow format override via extension
    if (ext === ".md" || format === "md") {
      await this.createMarkdown(outputPath, blocks);
      return report;
    }

    if (ext === ".pdf" || format === "pdf") {
      report.warnings.push(...(await this.createPDF(outputPath, blocks, options)));
      return report;
    }

    // Default to Word document
    await this.createDocx(outputPath, blocks, options);
    return report;
  }

  /**
   * Normalizes content input into the blocks the renderers draw. Tables and
   * lists may arrive with only rows/items; blocks with nothing to draw are
   * reported instead of being counted as written.
   * Throws an error if content is empty or invalid to prevent creating empty documents
   */
  private normalizeContent(content: ContentBlockInput[] | ContentBlockInput | string | undefined): {
    blocks: RenderBlock[];
    droppedBlocks: DocumentCreateReport["droppedBlocks"];
    requestedBlocks: number;
  } {
    // Handle undefined/null - FAIL instead of creating empty document
    if (!content) {
      throw new Error(
        "Document content is required. Please provide content as an array of blocks " +
          '(e.g., [{ type: "paragraph", text: "Your text here" }]) or as a string.',
      );
    }

    // Handle string input - convert to a single paragraph
    if (typeof content === "string") {
      if (content.trim().length === 0) {
        throw new Error("Document content cannot be empty. Please provide text content.");
      }
      return {
        blocks: [renderBlock("paragraph", { text: content })],
        droppedBlocks: [],
        requestedBlocks: 1,
      };
    }

    const input = Array.isArray(content) ? content : [content];

    // Already an array - ensure it's not empty
    if (input.length === 0) {
      throw new Error(
        "Document content array cannot be empty. " +
          'Please provide at least one content block (e.g., [{ type: "paragraph", text: "Your text" }]).',
      );
    }

    const blocks: RenderBlock[] = [];
    const droppedBlocks: DocumentCreateReport["droppedBlocks"] = [];
    input.forEach((block, index) => {
      const normalized = normalizeBlock(block);
      if ("reason" in normalized) droppedBlocks.push({ index, ...normalized });
      else blocks.push(normalized);
    });
    if (!blocks.some((block) => block.type !== PAGE_BREAK)) {
      throw new Error(
        "All content blocks are empty. Provide text, list items, or table rows. " +
          `Received ${input.length} block(s), none with anything to write.`,
      );
    }

    return { blocks, droppedBlocks, requestedBlocks: input.length };
  }

  /**
   * Creates a Word document (.docx)
   */
  private async createDocx(
    outputPath: string,
    content: RenderBlock[],
    options: DocumentOptions,
  ): Promise<void> {
    const children: Array<Paragraph | Table> = [];
    const textSize = (options.fontSize || 12) * 2;
    // A page break starts the next paragraph on a new page, so the new page
    // does not open with an empty line. A break with nothing after it is
    // written as an explicit break.
    let breakBeforeNext = false;
    const takePageBreak = (): boolean => {
      const value = breakBeforeNext;
      breakBeforeNext = false;
      return value;
    };

    for (const block of content) {
      switch (block.type) {
        case PAGE_BREAK:
          breakBeforeNext = true;
          break;

        case "heading": {
          const level = Math.min(Math.max(block.level || 1, 1), 6);
          const headingLevel = this.getHeadingLevel(level);
          children.push(
            new Paragraph({
              text: block.text,
              heading: headingLevel,
              spacing: { before: 240, after: 120 },
              // A heading never ends a page apart from the content it introduces.
              keepNext: true,
              keepLines: true,
              pageBreakBefore: takePageBreak(),
            }),
          );
          break;
        }

        case "paragraph":
          children.push(
            new Paragraph({
              children: [new TextRun({ text: block.text, size: textSize })],
              spacing: { after: 200 },
              pageBreakBefore: takePageBreak(),
            }),
          );
          break;

        case "list": {
          for (const item of block.items) {
            children.push(
              new Paragraph({
                children: [new TextRun({ text: item, size: textSize })],
                bullet: { level: 0 },
                spacing: { after: 100 },
                pageBreakBefore: takePageBreak(),
              }),
            );
          }
          break;
        }

        case "table": {
          if (block.rows && block.rows.length > 0) {
            // Size the grid to the A4 text width; without widths docx writes
            // 100-twip grid columns that some readers draw as slivers.
            const textWidth =
              11906 - ((options.margins?.left || 1) + (options.margins?.right || 1)) * 1440;
            const columnCount = block.rows[0].length;
            const hasHeader = block.rows.length > 1;
            const table = new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              columnWidths: Array<number>(columnCount).fill(Math.floor(textWidth / columnCount)),
              rows: block.rows.map(
                (row, rowIndex) =>
                  new TableRow({
                    // The header repeats on every page the table reaches.
                    tableHeader: hasHeader && rowIndex === 0 ? true : undefined,
                    cantSplit: true,
                    children: row.map(
                      (cell) =>
                        new TableCell({
                          children: [
                            new Paragraph({
                              // Keeps the header on the same page as the first row.
                              keepNext: hasHeader && rowIndex === 0 ? true : undefined,
                              children: [
                                new TextRun({
                                  text: cell,
                                  bold: rowIndex === 0,
                                  size: textSize,
                                }),
                              ],
                            }),
                          ],
                          borders: {
                            top: { style: BorderStyle.SINGLE, size: 1 },
                            bottom: { style: BorderStyle.SINGLE, size: 1 },
                            left: { style: BorderStyle.SINGLE, size: 1 },
                            right: { style: BorderStyle.SINGLE, size: 1 },
                          },
                        }),
                    ),
                  }),
              ),
            });
            // Spacing before the table; it carries the page break and stays
            // with the table so a preceding heading does too.
            children.push(
              new Paragraph({ children: [], keepNext: true, pageBreakBefore: takePageBreak() }),
            );
            children.push(table);
            children.push(new Paragraph({ children: [] })); // Spacing after table
          }
          break;
        }

        case "code":
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: block.text,
                  font: "Courier New",
                  size: 20, // 10pt
                  shading: { fill: "F0F0F0" },
                }),
              ],
              spacing: { before: 200, after: 200 },
              pageBreakBefore: takePageBreak(),
            }),
          );
          break;

        default:
          children.push(
            new Paragraph({
              children: [new TextRun({ text: block.text, size: textSize })],
              pageBreakBefore: takePageBreak(),
            }),
          );
      }
    }
    if (breakBeforeNext) children.push(new Paragraph({ children: [new PageBreak()] }));

    const doc = new Document({
      creator: options.author || "CoWork OS",
      title: options.title,
      subject: options.subject,
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: (options.margins?.top || 1) * 1440, // Convert inches to twips
                bottom: (options.margins?.bottom || 1) * 1440,
                left: (options.margins?.left || 1) * 1440,
                right: (options.margins?.right || 1) * 1440,
              },
            },
          },
          ...(options.pageNumbers
            ? {
                footers: {
                  default: new Footer({
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.CENTER,
                        children: [
                          new TextRun({
                            children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES],
                            size: 18,
                          }),
                        ],
                      }),
                    ],
                  }),
                },
              }
            : {}),
          children,
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    await fsPromises.writeFile(outputPath, buffer);
  }

  /**
   * Creates a PDF document. Returns warnings about text it cannot draw.
   */
  private async createPDF(
    outputPath: string,
    content: RenderBlock[],
    options: DocumentOptions,
  ): Promise<string[]> {
    // The built-in PDF fonts only encode Latin-1; text beyond that needs an
    // embedded Unicode font or it is written as the wrong glyphs.
    const fontChoice = resolvePdfFonts(
      content.flatMap((block) => [block.text, ...block.items, ...block.rows.flat()]).join("\n"),
    );
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: {
          top: (options.margins?.top || 1) * 72,
          bottom: (options.margins?.bottom || 1) * 72,
          left: (options.margins?.left || 1) * 72,
          right: (options.margins?.right || 1) * 72,
        },
        // Pages stay open until the end so footers can be stamped once the page count is known.
        bufferPages: true,
        info: {
          Title: options.title || "",
          Author: options.author || "CoWork OS",
          Subject: options.subject || "",
        },
      });

      const stream = fs.createWriteStream(outputPath);
      stream.on("error", reject);
      doc.pipe(stream);

      const fonts = { regular: "Helvetica", bold: "Helvetica-Bold" };
      if (fontChoice.font) {
        const { regular, bold } = fontChoice.font;
        doc.registerFont("UnicodeRegular", regular.path, regular.postscriptName);
        doc.registerFont("UnicodeBold", bold.path, bold.postscriptName);
        fonts.regular = "UnicodeRegular";
        fonts.bold = "UnicodeBold";
      }

      const renderer = new PdfBlockRenderer(doc, fonts, options.fontSize || 12, (text) =>
        // Courier is Latin-1 only; code with other characters uses the Unicode font.
        fontChoice.font && needsUnicodeFont(text) ? fonts.regular : "Courier",
      );
      let warnings: string[];
      try {
        warnings = [...fontChoice.warnings, ...renderer.render(content)];
        if (options.pageNumbers) renderer.stampPageNumbers();
      } catch (error) {
        stream.destroy();
        reject(error);
        return;
      }

      doc.end();

      stream.on("finish", () => resolve(warnings));
    });
  }

  /**
   * Creates a Markdown document (fallback)
   */
  private async createMarkdown(outputPath: string, content: RenderBlock[]): Promise<void> {
    const markdown = content
      .map((block) => {
        switch (block.type) {
          case "heading": {
            const level = Math.min(Math.max(block.level || 1, 1), 6);
            return `${"#".repeat(level)} ${block.text}\n`;
          }
          case "paragraph":
            return `${block.text}\n`;
          case "list": {
            return block.items.map((item) => `- ${item}`).join("\n") + "\n";
          }
          case "table": {
            if (!block.rows || block.rows.length === 0) return "";
            const header = block.rows[0];
            const separator = header.map(() => "---").join(" | ");
            const _rows = block.rows.map((row) => row.join(" | ")).join("\n");
            return `${header.join(" | ")}\n${separator}\n${block.rows
              .slice(1)
              .map((row) => row.join(" | "))
              .join("\n")}\n`;
          }
          case "code":
            return `\`\`\`${block.language || ""}\n${block.text}\n\`\`\`\n`;
          case PAGE_BREAK:
            // Markdown has no page break; this is what HTML and PDF converters honor.
            return '<div style="page-break-after: always;"></div>\n';
          default:
            return `${block.text}\n`;
        }
      })
      .join("\n");

    await fsPromises.writeFile(outputPath, markdown, "utf-8");
  }

  private getHeadingLevel(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
    switch (level) {
      case 1:
        return HeadingLevel.HEADING_1;
      case 2:
        return HeadingLevel.HEADING_2;
      case 3:
        return HeadingLevel.HEADING_3;
      case 4:
        return HeadingLevel.HEADING_4;
      case 5:
        return HeadingLevel.HEADING_5;
      case 6:
        return HeadingLevel.HEADING_6;
      default:
        return HeadingLevel.HEADING_1;
    }
  }

  /**
   * Reads an existing DOCX file and extracts its content as HTML
   */
  async readDocument(
    inputPath: string,
  ): Promise<{ html: string; text: string; messages: string[] }> {
    const buffer = await readDocumentArchiveBuffer(inputPath);
    const result = await mammoth.convertToHtml({ buffer });
    const textResult = await mammoth.extractRawText({ buffer });

    return {
      html: result.value,
      text: textResult.value,
      messages: result.messages.map((m) => m.message),
    };
  }

  /**
   * Appends new content sections to an existing DOCX file.
   * This method directly manipulates the DOCX XML structure to preserve
   * the original document formatting while adding new content at the end.
   */
  async appendToDocument(
    inputPath: string,
    outputPath: string,
    newContent: ContentBlock[],
    _options: DocumentOptions = {},
  ): Promise<{ success: boolean; sectionsAdded: number }> {
    console.log(
      `[DocumentBuilder] appendToDocument: ${inputPath} -> ${outputPath}, ${newContent.length} blocks`,
    );

    // Read the DOCX file as a ZIP
    const docxBuffer = await readDocumentArchiveBuffer(inputPath);
    const zip = await loadDocumentArchive(docxBuffer);

    // Get the main document.xml
    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      throw new Error("Invalid DOCX file: missing word/document.xml");
    }

    let xmlContent = await documentXml.async("text");

    // Generate OOXML for the new content
    const newXmlContent = this.contentBlocksToOoxml(newContent);

    // Find the insertion point - before </w:body> or before <w:sectPr
    // The sectPr element contains section properties and must stay at the end
    const sectPrMatch = xmlContent.match(/<w:sectPr[^>]*>[\s\S]*?<\/w:sectPr>/);
    const bodyEndMatch = xmlContent.match(/<\/w:body>/);

    if (sectPrMatch && sectPrMatch.index !== undefined) {
      // Insert before sectPr
      xmlContent =
        xmlContent.slice(0, sectPrMatch.index) +
        newXmlContent +
        xmlContent.slice(sectPrMatch.index);
      console.log(`[DocumentBuilder] Inserted content before <w:sectPr>`);
    } else if (bodyEndMatch && bodyEndMatch.index !== undefined) {
      // Insert before </w:body>
      xmlContent =
        xmlContent.slice(0, bodyEndMatch.index) +
        newXmlContent +
        xmlContent.slice(bodyEndMatch.index);
      console.log(`[DocumentBuilder] Inserted content before </w:body>`);
    } else {
      throw new Error("Could not find insertion point in document.xml");
    }

    // Update the document.xml in the ZIP
    zip.file("word/document.xml", xmlContent);

    // Write the modified DOCX
    const outputBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    await fsPromises.writeFile(outputPath, outputBuffer);

    console.log(
      `[DocumentBuilder] Successfully appended ${newContent.length} sections to ${outputPath}`,
    );

    return {
      success: true,
      sectionsAdded: newContent.length,
    };
  }

  /**
   * Converts ContentBlocks to OOXML (Office Open XML) format
   * This creates proper Word paragraph/table elements
   */
  private contentBlocksToOoxml(blocks: ContentBlock[]): string {
    const xmlParts: string[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case "heading": {
          const level = Math.min(Math.max(block.level || 1, 1), 6);
          // Word heading styles are "Heading1" through "Heading6"
          const styleId = `Heading${level}`;
          xmlParts.push(this.createOoxmlParagraph(block.text, styleId));
          break;
        }

        case "paragraph":
          xmlParts.push(this.createOoxmlParagraph(block.text));
          break;

        case "list": {
          const items = block.items || block.text.split("\n").filter((line) => line.trim());
          for (const item of items) {
            xmlParts.push(this.createOoxmlListItem(item));
          }
          break;
        }

        case "table": {
          if (block.rows && block.rows.length > 0) {
            xmlParts.push(this.createOoxmlTable(block.rows));
          }
          break;
        }

        case PAGE_BREAK:
          xmlParts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
          break;

        default:
          xmlParts.push(this.createOoxmlParagraph(block.text));
      }
    }

    return xmlParts.join("\n");
  }

  /**
   * Creates an OOXML paragraph element
   */
  private createOoxmlParagraph(text: string, styleId?: string): string {
    const escapedText = this.escapeXml(text);
    const styleXml = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : "";
    return `<w:p>${styleXml}<w:r><w:t>${escapedText}</w:t></w:r></w:p>`;
  }

  /**
   * Creates an OOXML list item (bullet point)
   */
  private createOoxmlListItem(text: string): string {
    const escapedText = this.escapeXml(text);
    // Simple bullet using a bullet character - more compatible than numPr
    return `<w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:t>• ${escapedText}</w:t></w:r></w:p>`;
  }

  /**
   * Creates an OOXML table element
   */
  private createOoxmlTable(rows: string[][]): string {
    const tableRows = rows
      .map((row, rowIndex) => {
        const cells = row
          .map((cellText) => {
            const escapedText = this.escapeXml(cellText);
            const boldStyle = rowIndex === 0 ? "<w:rPr><w:b/></w:rPr>" : "";
            return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/><w:tcBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/></w:tcBorders></w:tcPr><w:p><w:r>${boldStyle}<w:t>${escapedText}</w:t></w:r></w:p></w:tc>`;
          })
          .join("");
        return `<w:tr>${cells}</w:tr>`;
      })
      .join("");

    return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${tableRows}</w:tbl>`;
  }

  /**
   * Escapes special XML characters
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * Parses the document.xml content and identifies sections based on headings.
   * Sections are delimited by heading paragraphs (Heading1, Heading2, etc.)
   */
  private parseSections(xmlContent: string): DocumentSection[] {
    const sections: DocumentSection[] = [];

    // Find all paragraphs that are headings (have w:pStyle with Heading1-6)
    // Pattern: <w:p ...>...<w:pStyle w:val="Heading[1-6]"/>...</w:p>
    const paragraphRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
    const headingStyleRegex = /<w:pStyle\s+w:val="Heading([1-6])"\s*\/>/;
    const _textRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;

    let match;
    const headingPositions: Array<{
      level: number;
      text: string;
      sectionNumber?: string;
      startIndex: number;
      endIndex: number;
    }> = [];

    // Find all heading paragraphs
    while ((match = paragraphRegex.exec(xmlContent)) !== null) {
      const paragraph = match[0];
      const styleMatch = paragraph.match(headingStyleRegex);

      if (styleMatch) {
        const level = parseInt(styleMatch[1], 10);

        // Extract text from the paragraph
        let text = "";
        let textMatch;
        const textRegexLocal = /<w:t[^>]*>([^<]*)<\/w:t>/g;
        while ((textMatch = textRegexLocal.exec(paragraph)) !== null) {
          text += textMatch[1];
        }

        // Try to extract section number (e.g., "8. " or "8 ")
        const sectionNumMatch = text.match(/^(\d+(?:\.\d+)*)[.\s]/);
        const sectionNumber = sectionNumMatch ? sectionNumMatch[1] : undefined;

        headingPositions.push({
          level,
          text: text.trim(),
          sectionNumber,
          startIndex: match.index,
          endIndex: match.index + paragraph.length,
        });
      }
    }

    // Now create sections from heading positions
    // Each section spans from its heading to the next same-level or higher-level heading
    for (let i = 0; i < headingPositions.length; i++) {
      const current = headingPositions[i];
      let endIndex: number;

      // Find the end of this section
      // It ends at the next heading of same or higher level (lower number)
      // Or at the sectPr element, or end of body
      let nextSectionStart: number | undefined;

      for (let j = i + 1; j < headingPositions.length; j++) {
        if (headingPositions[j].level <= current.level) {
          nextSectionStart = headingPositions[j].startIndex;
          break;
        }
      }

      if (nextSectionStart !== undefined) {
        endIndex = nextSectionStart;
      } else {
        // This is the last section at this level
        // End at sectPr or end of body
        const sectPrMatch = xmlContent.match(/<w:sectPr[^>]*>/);
        const bodyEndMatch = xmlContent.match(/<\/w:body>/);

        if (sectPrMatch && sectPrMatch.index !== undefined) {
          endIndex = sectPrMatch.index;
        } else if (bodyEndMatch && bodyEndMatch.index !== undefined) {
          endIndex = bodyEndMatch.index;
        } else {
          endIndex = xmlContent.length;
        }
      }

      sections.push({
        headingLevel: current.level,
        headingText: current.text,
        sectionNumber: current.sectionNumber,
        startIndex: current.startIndex,
        endIndex,
        xmlContent: xmlContent.slice(current.startIndex, endIndex),
      });
    }

    return sections;
  }

  /**
   * Moves a section to a new position in the document.
   * @param inputPath Path to the source DOCX file
   * @param outputPath Path to save the modified DOCX file
   * @param sectionIdentifier The section to move (can be section number like "8" or heading text)
   * @param afterSection The section after which to place it (section number or heading text)
   */
  async moveSectionAfter(
    inputPath: string,
    outputPath: string,
    sectionIdentifier: string,
    afterSection: string,
  ): Promise<{ success: boolean; message: string }> {
    console.log(
      `[DocumentBuilder] moveSectionAfter: Moving "${sectionIdentifier}" after "${afterSection}"`,
    );

    // Read the DOCX file
    const docxBuffer = await readDocumentArchiveBuffer(inputPath);
    const zip = await loadDocumentArchive(docxBuffer);

    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      throw new Error("Invalid DOCX file: missing word/document.xml");
    }

    let xmlContent = await documentXml.async("text");

    // Parse sections
    const sections = this.parseSections(xmlContent);
    console.log(
      `[DocumentBuilder] Found ${sections.length} sections:`,
      sections.map((s) => `${s.sectionNumber || "N/A"}: ${s.headingText.substring(0, 50)}`),
    );

    // Find the section to move
    const sectionToMove = this.findSection(sections, sectionIdentifier);
    if (!sectionToMove) {
      return {
        success: false,
        message: `Could not find section "${sectionIdentifier}". Available sections: ${sections.map((s) => s.sectionNumber || s.headingText).join(", ")}`,
      };
    }

    // Find the target section (after which to insert)
    const targetSection = this.findSection(sections, afterSection);
    if (!targetSection) {
      return {
        success: false,
        message: `Could not find target section "${afterSection}". Available sections: ${sections.map((s) => s.sectionNumber || s.headingText).join(", ")}`,
      };
    }

    // Check if move is needed
    if (sectionToMove.startIndex === targetSection.endIndex) {
      return { success: true, message: "Section is already in the correct position" };
    }

    // Perform the move
    const sectionContent = sectionToMove.xmlContent;

    // Remove the section from its current position
    let newXmlContent: string;

    if (sectionToMove.startIndex > targetSection.endIndex) {
      // Section is after target - remove it first, then insert
      newXmlContent =
        xmlContent.slice(0, sectionToMove.startIndex) + xmlContent.slice(sectionToMove.endIndex);

      // Insert at target position (unchanged since it's before the removed section)
      newXmlContent =
        newXmlContent.slice(0, targetSection.endIndex) +
        sectionContent +
        newXmlContent.slice(targetSection.endIndex);
    } else {
      // Section is before target - need to adjust indices
      // First, calculate where target ends after section removal
      const sectionLength = sectionToMove.endIndex - sectionToMove.startIndex;
      const adjustedTargetEnd = targetSection.endIndex - sectionLength;

      // Remove section first
      newXmlContent =
        xmlContent.slice(0, sectionToMove.startIndex) + xmlContent.slice(sectionToMove.endIndex);

      // Insert at adjusted target position
      newXmlContent =
        newXmlContent.slice(0, adjustedTargetEnd) +
        sectionContent +
        newXmlContent.slice(adjustedTargetEnd);
    }

    // Update the document.xml in the ZIP
    zip.file("word/document.xml", newXmlContent);

    // Write the modified DOCX
    const outputBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    await fsPromises.writeFile(outputPath, outputBuffer);

    console.log(
      `[DocumentBuilder] Successfully moved section "${sectionIdentifier}" after "${afterSection}"`,
    );

    return {
      success: true,
      message: `Moved section "${sectionToMove.headingText}" after "${targetSection.headingText}"`,
    };
  }

  /**
   * Finds a section by its number or heading text
   */
  private findSection(
    sections: DocumentSection[],
    identifier: string,
  ): DocumentSection | undefined {
    const normalizedId = identifier.trim().toLowerCase();

    // First try exact section number match
    const byNumber = sections.find(
      (s) => s.sectionNumber === identifier || s.sectionNumber === normalizedId,
    );
    if (byNumber) return byNumber;

    // Try with "Section " prefix
    const withPrefix = sections.find(
      (s) =>
        s.headingText.toLowerCase().startsWith(`section ${normalizedId}`) ||
        s.headingText.toLowerCase().startsWith(`${normalizedId}.`) ||
        s.headingText.toLowerCase().startsWith(`${normalizedId} `),
    );
    if (withPrefix) return withPrefix;

    // Try partial heading text match
    const byText = sections.find((s) => s.headingText.toLowerCase().includes(normalizedId));
    if (byText) return byText;

    return undefined;
  }

  /**
   * Inserts new content after a specific section in the document.
   * @param inputPath Path to the source DOCX file
   * @param outputPath Path to save the modified DOCX file
   * @param afterSection Section identifier (number or heading text) after which to insert
   * @param newContent Content blocks to insert
   */
  async insertAfterSection(
    inputPath: string,
    outputPath: string,
    afterSection: string,
    newContent: ContentBlock[],
  ): Promise<{ success: boolean; message: string; sectionsAdded: number }> {
    console.log(
      `[DocumentBuilder] insertAfterSection: After "${afterSection}", inserting ${newContent.length} blocks`,
    );

    // Read the DOCX file
    const docxBuffer = await readDocumentArchiveBuffer(inputPath);
    const zip = await loadDocumentArchive(docxBuffer);

    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      throw new Error("Invalid DOCX file: missing word/document.xml");
    }

    let xmlContent = await documentXml.async("text");

    // Parse sections
    const sections = this.parseSections(xmlContent);

    // Find the target section
    const targetSection = this.findSection(sections, afterSection);
    if (!targetSection) {
      return {
        success: false,
        message: `Could not find section "${afterSection}". Available sections: ${sections.map((s) => s.sectionNumber || s.headingText).join(", ")}`,
        sectionsAdded: 0,
      };
    }

    // Generate OOXML for the new content
    const newXmlContent = this.contentBlocksToOoxml(newContent);

    // Insert after the target section
    const insertionPoint = targetSection.endIndex;
    xmlContent =
      xmlContent.slice(0, insertionPoint) + newXmlContent + xmlContent.slice(insertionPoint);

    // Update the document.xml in the ZIP
    zip.file("word/document.xml", xmlContent);

    // Write the modified DOCX
    const outputBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    await fsPromises.writeFile(outputPath, outputBuffer);

    console.log(
      `[DocumentBuilder] Successfully inserted ${newContent.length} blocks after section "${afterSection}"`,
    );

    return {
      success: true,
      message: `Inserted ${newContent.length} content blocks after "${targetSection.headingText}"`,
      sectionsAdded: newContent.length,
    };
  }

  async replaceBlocksById(
    inputPath: string,
    outputPath: string,
    blockIds: string[],
    newContent: ContentBlock[],
  ): Promise<{ success: boolean; message: string; sectionsAdded: number }> {
    const uniqueBlockIds = Array.from(
      new Set(blockIds.map((value) => value.trim()).filter(Boolean)),
    );
    if (uniqueBlockIds.length === 0) {
      return { success: false, message: "No blockIds provided", sectionsAdded: 0 };
    }

    const docxBuffer = await readDocumentArchiveBuffer(inputPath);
    const zip = await loadDocumentArchive(docxBuffer);
    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      throw new Error("Invalid DOCX file: missing word/document.xml");
    }

    let xmlContent = await documentXml.async("text");
    const { parseDocxBlocksFromXml } = await import("../../documents/docx-blocks");
    const blocks = parseDocxBlocksFromXml(xmlContent);
    const selectedBlocks = blocks.filter((block) => uniqueBlockIds.includes(block.id));

    if (selectedBlocks.length !== uniqueBlockIds.length) {
      const foundIds = new Set(selectedBlocks.map((block) => block.id));
      const missing = uniqueBlockIds.filter((id) => !foundIds.has(id));
      return {
        success: false,
        message: `Could not find blockIds: ${missing.join(", ")}`,
        sectionsAdded: 0,
      };
    }

    const orderedSelection = [...selectedBlocks].sort((a, b) => a.order - b.order);
    const first = orderedSelection[0];
    const last = orderedSelection[orderedSelection.length - 1];
    const isContiguous = orderedSelection.every(
      (block, index) => block.order === first.order + index,
    );
    if (!isContiguous) {
      return {
        success: false,
        message: "Selected DOCX blocks must be contiguous",
        sectionsAdded: 0,
      };
    }

    const replacementXml = this.contentBlocksToOoxml(newContent);
    xmlContent =
      xmlContent.slice(0, first.startIndex) + replacementXml + xmlContent.slice(last.endIndex);
    zip.file("word/document.xml", xmlContent);

    const outputBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    await fsPromises.writeFile(outputPath, outputBuffer);

    return {
      success: true,
      message: `Replaced ${orderedSelection.length} block(s)`,
      sectionsAdded: newContent.length,
    };
  }

  /**
   * Lists all sections in a document
   */
  async listSections(inputPath: string): Promise<
    Array<{
      number?: string;
      title: string;
      level: number;
    }>
  > {
    const docxBuffer = await readDocumentArchiveBuffer(inputPath);
    const zip = await loadDocumentArchive(docxBuffer);

    const documentXml = zip.file("word/document.xml");
    if (!documentXml) {
      throw new Error("Invalid DOCX file: missing word/document.xml");
    }

    const xmlContent = await documentXml.async("text");
    const sections = this.parseSections(xmlContent);

    return sections.map((s) => ({
      number: s.sectionNumber,
      title: s.headingText,
      level: s.headingLevel,
    }));
  }

  /**
   * Converts HTML from mammoth to ContentBlocks
   * This is a simplified conversion that preserves basic structure
   */
  private htmlToContentBlocks(html: string): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    // Simple regex-based HTML parsing for common elements
    // Match headings
    const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
    // Match paragraphs
    const paragraphRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    // Match list items
    const listRegex = /<ul[^>]*>([\s\S]*?)<\/ul>/gi;
    const _listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    // Match tables
    const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    const _trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const _tdThRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

    // Helper to strip HTML tags
    const stripTags = (str: string): string => str.replace(/<[^>]*>/g, "").trim();

    // Process in order of appearance
    let _lastIndex = 0;
    const processedRanges: Array<{ start: number; end: number }> = [];

    // Find all headings
    let match;
    while ((match = headingRegex.exec(html)) !== null) {
      const text = stripTags(match[2]);
      if (text) {
        blocks.push({
          type: "heading",
          text,
          level: parseInt(match[1], 10),
        });
        processedRanges.push({ start: match.index, end: match.index + match[0].length });
      }
    }

    // Find all paragraphs
    paragraphRegex.lastIndex = 0;
    while ((match = paragraphRegex.exec(html)) !== null) {
      // Skip if this range overlaps with an already processed element
      const overlaps = processedRanges.some(
        (r) =>
          (match!.index >= r.start && match!.index < r.end) ||
          (match!.index + match![0].length > r.start && match!.index + match![0].length <= r.end),
      );
      if (overlaps) continue;

      const text = stripTags(match[1]);
      if (text) {
        blocks.push({
          type: "paragraph",
          text,
        });
        processedRanges.push({ start: match.index, end: match.index + match[0].length });
      }
    }

    // Find all lists
    listRegex.lastIndex = 0;
    while ((match = listRegex.exec(html)) !== null) {
      const listHtml = match[1];
      const items: string[] = [];
      let itemMatch;
      const itemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      while ((itemMatch = itemRegex.exec(listHtml)) !== null) {
        const itemText = stripTags(itemMatch[1]);
        if (itemText) items.push(itemText);
      }
      if (items.length > 0) {
        blocks.push({
          type: "list",
          text: items.join("\n"),
          items,
        });
      }
    }

    // Find all tables
    tableRegex.lastIndex = 0;
    while ((match = tableRegex.exec(html)) !== null) {
      const tableHtml = match[1];
      const rows: string[][] = [];
      let rowMatch;
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
        const rowHtml = rowMatch[1];
        const cells: string[] = [];
        let cellMatch;
        const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
          cells.push(stripTags(cellMatch[1]));
        }
        if (cells.length > 0) rows.push(cells);
      }
      if (rows.length > 0) {
        blocks.push({
          type: "table",
          text: "",
          rows,
        });
      }
    }

    // Sort blocks by their original position would require more complex tracking
    // For now, we return them in the order found (headings, then paragraphs, then lists, then tables)
    // This may not preserve exact document order

    return blocks;
  }
}

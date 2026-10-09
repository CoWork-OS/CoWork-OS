import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentBuilder, type ContentBlockInput } from "../document";
import { parsePdfBuffer } from "../../../utils/pdf-parser";

/** Text drawn on one page, from the cursor before the call to the cursor after it. */
interface TextBox {
  page: number;
  top: number;
  bottom: number;
  text: string;
}

/** A horizontal rule stroked on one page. */
interface Rule {
  page: number;
  y: number;
  x1: number;
  x2: number;
}

interface DrawLog {
  boxes: TextBox[];
  rules: Rule[];
  /** Content area bottom (page height minus bottom margin) of each page. */
  pageBottoms: number[];
}

const tempDirs: string[] = [];
let log: DrawLog;

/**
 * Records where the renderer draws text and rules by wrapping pdfkit's own
 * drawing calls, so assertions check the real positions in the saved PDF.
 */
function instrumentPdfDrawing(): void {
  log = { boxes: [], rules: [], pageBottoms: [] };
  const pages = new Map<object, number>();
  const pageIndex = (doc: Any): number => {
    let index = pages.get(doc.page);
    if (index === undefined) {
      index = pages.size;
      pages.set(doc.page, index);
      log.pageBottoms[index] = doc.page.height - doc.page.margins.bottom;
    }
    return index;
  };
  const proto = PDFDocument.prototype as Any;
  const originalText = proto.text;
  const originalMoveTo = proto.moveTo;
  const originalLineTo = proto.lineTo;
  let pendingMove: { page: number; x: number; y: number } | null = null;

  vi.spyOn(proto, "text").mockImplementation(function (this: Any, ...args: unknown[]) {
    const startPage = this.page;
    const top = typeof args[2] === "number" ? args[2] : this.y;
    const result = originalText.apply(this, args);
    // Flowing text that continued onto a new page has no single box.
    if (this.page === startPage) {
      log.boxes.push({ page: pageIndex(this), top, bottom: this.y, text: String(args[0]) });
    }
    return result;
  });
  vi.spyOn(proto, "moveTo").mockImplementation(function (this: Any, x: number, y: number) {
    pendingMove = { page: pageIndex(this), x, y };
    return originalMoveTo.call(this, x, y);
  });
  vi.spyOn(proto, "lineTo").mockImplementation(function (this: Any, x: number, y: number) {
    if (pendingMove && pendingMove.y === y && pendingMove.x !== x) {
      log.rules.push({ page: pendingMove.page, y, x1: pendingMove.x, x2: x });
    }
    pendingMove = null;
    return originalLineTo.call(this, x, y);
  });
}

function makeBuilder(): { builder: DocumentBuilder; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-document-layout-"));
  tempDirs.push(dir);
  const workspace = { path: dir, permissions: { read: true, write: true } };
  return { builder: new DocumentBuilder(workspace as Any), dir };
}

/** Rules that pass through the text drawn on their page. */
function rulesCrossingText(): Array<{ rule: Rule; box: TextBox }> {
  const crossings: Array<{ rule: Rule; box: TextBox }> = [];
  for (const rule of log.rules) {
    for (const box of log.boxes) {
      if (box.page !== rule.page) continue;
      if (rule.y > box.top + 0.5 && rule.y < box.bottom - 0.5) crossings.push({ rule, box });
    }
  }
  return crossings;
}

function boxesWithText(text: string): TextBox[] {
  return log.boxes.filter((box) => box.text === text);
}

const longCell =
  "A topic long enough to wrap onto several lines inside a narrow table column, " +
  "so the row is taller than a single line of text.";

function scheduleTable(rowCount: number): ContentBlockInput {
  const rows: string[][] = [["Date", "Duration", "Topic"]];
  for (let index = 1; index <= rowCount; index++) {
    rows.push([
      `${index} October 2026`,
      "45 minutes",
      index % 3 === 0 ? `${longCell} (${index})` : `Session ${index}`,
    ]);
  }
  return { type: "table", rows };
}

function fillerParagraphs(count: number): ContentBlockInput[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "paragraph",
    text: `Filler line ${index + 1}.`,
  }));
}

beforeEach(() => {
  instrumentPdfDrawing();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PDF table layout", () => {
  it("draws every row rule in the padding between rows, never through cell text", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "schedule.pdf");

    await builder.create(outputPath, "pdf", [
      { type: "heading", text: "Schedule", level: 2 },
      scheduleTable(4),
      { type: "paragraph", text: "After the table." },
    ]);

    const tableRules = log.rules.filter((rule) => rule.page === 0);
    // A rule above the header and one under each of the five rows.
    expect(tableRules).toHaveLength(6);
    expect(rulesCrossingText()).toEqual([]);

    // Each rule sits strictly between the previous row's text and the next row's text.
    const rowTops = ["Date", "1 October 2026", "2 October 2026", "3 October 2026", "4 October 2026"]
      .map((text) => boxesWithText(text)[0])
      .map((box) => box.top);
    for (let index = 1; index < rowTops.length; index++) {
      const rule = tableRules[index];
      expect(rule.y).toBeLessThan(rowTops[index]);
    }
    // Wrapped cells make their row taller; the next rule waits for the last line.
    const wrapped = boxesWithText(`${longCell} (3)`)[0];
    expect(wrapped.bottom - wrapped.top).toBeGreaterThan(30);
    expect(tableRules[4].y).toBeGreaterThan(wrapped.bottom);

    // Text after the table starts below its last rule.
    expect(boxesWithText("After the table.")[0].top).toBeGreaterThan(tableRules[5].y);
  });

  it("repeats the header row and keeps rules clear of text when a table crosses pages", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "long.pdf");

    await builder.create(outputPath, "pdf", [
      ...fillerParagraphs(18),
      { type: "heading", text: "Schedule", level: 2 },
      scheduleTable(40),
    ]);

    const parsed = await parsePdfBuffer(fs.readFileSync(outputPath));
    expect(parsed.numpages).toBeGreaterThanOrEqual(2);
    expect(rulesCrossingText()).toEqual([]);

    // The header is drawn once on every page the table occupies.
    const tablePages = new Set(
      log.boxes.filter((box) => /^\d+ October 2026$/.test(box.text)).map((box) => box.page),
    );
    expect(tablePages.size).toBeGreaterThanOrEqual(2);
    const headerPages = boxesWithText("Date").map((box) => box.page);
    expect(headerPages).toEqual([...tablePages].sort((a, b) => a - b));

    // No cell or rule runs into the bottom margin.
    for (const box of log.boxes) {
      expect(box.bottom).toBeLessThanOrEqual(log.pageBottoms[box.page] + 0.5);
    }
    for (const rule of log.rules) {
      expect(rule.y).toBeLessThanOrEqual(log.pageBottoms[rule.page] + 0.5);
    }
  });

  it("keeps a heading with the table header and first row for any amount of preceding text", async () => {
    for (let filler = 26; filler <= 40; filler++) {
      vi.restoreAllMocks();
      instrumentPdfDrawing();
      const { builder, dir } = makeBuilder();

      await builder.create(path.join(dir, `keep-${filler}.pdf`), "pdf", [
        ...fillerParagraphs(filler),
        { type: "heading", text: "Responsibilities and budget", level: 1 },
        { type: "heading", text: "Responsibilities", level: 2 },
        {
          type: "table",
          rows: [
            ["Task", "Owner"],
            ["Welcome copy", "Marta"],
            ["Caption checks", "James"],
          ],
        },
      ]);

      const section = boxesWithText("Responsibilities and budget")[0];
      const subsection = boxesWithText("Responsibilities")[0];
      const header = boxesWithText("Task")[0];
      const firstRow = boxesWithText("Welcome copy")[0];
      expect({ filler, pages: [section.page, subsection.page, header.page] }).toEqual({
        filler,
        pages: [firstRow.page, firstRow.page, firstRow.page],
      });
      expect(rulesCrossingText()).toEqual([]);
    }
  });
});

describe("PDF page structure", () => {
  it("starts a new page at each page_break and numbers every page", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "paged.pdf");

    const report = await builder.create(
      outputPath,
      "pdf",
      [
        { type: "page_break" },
        { type: "heading", text: "Page one", level: 1 },
        { type: "paragraph", text: "Overview." },
        { type: "page_break" },
        { type: "heading", text: "Page two", level: 1 },
        { type: "paragraph", text: "Details." },
      ],
      { pageNumbers: true },
    );

    const parsed = await parsePdfBuffer(fs.readFileSync(outputPath));
    // A break before any content does not leave a blank first page.
    expect(parsed.numpages).toBe(2);
    expect(boxesWithText("Page one")[0].page).toBe(0);
    expect(boxesWithText("Page two")[0].page).toBe(1);
    expect(parsed.text).toContain("1 / 2");
    expect(parsed.text).toContain("2 / 2");
    expect(report.droppedBlocks).toEqual([]);
    expect(report.renderedBlocks).toBe(6);
  });

  it("leaves pages unnumbered unless page numbers are requested", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "plain.pdf");

    await builder.create(outputPath, "pdf", [
      { type: "paragraph", text: "One." },
      { type: "page_break" },
      { type: "paragraph", text: "Two." },
    ]);

    const parsed = await parsePdfBuffer(fs.readFileSync(outputPath));
    expect(parsed.numpages).toBe(2);
    expect(parsed.text).not.toContain("1 / 2");
  });

  it("rejects content made only of page breaks", async () => {
    const { builder, dir } = makeBuilder();
    await expect(
      builder.create(path.join(dir, "empty.pdf"), "pdf", [{ type: "page_break" }]),
    ).rejects.toThrow(/empty/i);
  });
});

describe("DOCX page structure", () => {
  async function docxParts(outputPath: string): Promise<Record<string, string>> {
    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const parts: Record<string, string> = {};
    for (const name of Object.keys(zip.files)) {
      if (name.endsWith(".xml")) parts[name] = await zip.file(name)!.async("text");
    }
    return parts;
  }

  it("writes page breaks, a PAGE field footer, keep-with-next headings and repeating headers", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "paged.docx");

    await builder.create(
      outputPath,
      "docx",
      [
        { type: "heading", text: "Page one", level: 1 },
        { type: "paragraph", text: "Overview." },
        { type: "page_break" },
        { type: "heading", text: "Page two", level: 1 },
        {
          type: "table",
          rows: [
            ["Task", "Owner"],
            ["Welcome copy", "Marta"],
          ],
        },
        { type: "page_break" },
        { type: "table", rows: [["Only", "Table"]] },
      ],
      { pageNumbers: true },
    );

    const parts = await docxParts(outputPath);
    const document = parts["word/document.xml"];
    // The paragraph after a break starts the new page, including the spacer before a table.
    expect(document).toMatch(/<w:pageBreakBefore\/>[\s\S]*Page two/);
    expect(document.match(/<w:pageBreakBefore\/>/g)).toHaveLength(2);
    expect(document).toMatch(/<w:pageBreakBefore\/><\/w:pPr><\/w:p><w:tbl>[\s\S]*Only/);
    expect(document).toMatch(/<w:keepNext\/>[\s\S]*Page one/);
    expect(document).toContain("<w:tblHeader/>");

    const footers = Object.entries(parts).filter(([name]) => /^word\/footer\d*\.xml$/.test(name));
    expect(footers).toHaveLength(1);
    expect(footers[0][1]).toMatch(/<w:instrText[^>]*>\s*PAGE\s*<\/w:instrText>/);
    expect(footers[0][1]).toMatch(/<w:instrText[^>]*>\s*NUMPAGES\s*<\/w:instrText>/);
    expect(document).toMatch(/<w:footerReference [^>]*w:type="default"/);
  });

  it("writes an explicit break when nothing follows the page break", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "trailing.docx");

    await builder.create(outputPath, "docx", [
      { type: "paragraph", text: "One." },
      { type: "page_break" },
    ]);

    const parts = await docxParts(outputPath);
    expect(parts["word/document.xml"]).toContain('<w:br w:type="page"/>');
  });

  it("adds no footer when page numbers are not requested", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "plain.docx");

    await builder.create(outputPath, "docx", [{ type: "paragraph", text: "One." }]);

    const parts = await docxParts(outputPath);
    expect(Object.keys(parts).some((name) => name.startsWith("word/footer"))).toBe(false);
  });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  choosePageFit,
  DocumentBuilder,
  parseMaxPages,
  PDF_FIT_LADDER,
  type ContentBlockInput,
} from "../document";
import { parsePdfBuffer } from "../../../utils/pdf-parser";
import northstarBrief from "./fixtures/northstar-brief-pt.json";

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
 * Fitting a page budget lays the content out several times; `log` holds the
 * drawing of the document that was written (ended), and `layoutPasses`
 * counts the documents laid out.
 */
let layoutPasses = 0;

function instrumentPdfDrawing(): void {
  log = { boxes: [], rules: [], pageBottoms: [] };
  layoutPasses = 0;
  const logs = new Map<object, { log: DrawLog; pages: Map<object, number> }>();
  const docLog = (doc: Any): { log: DrawLog; pages: Map<object, number> } => {
    let entry = logs.get(doc);
    if (!entry) {
      entry = { log: { boxes: [], rules: [], pageBottoms: [] }, pages: new Map() };
      logs.set(doc, entry);
      layoutPasses++;
    }
    return entry;
  };
  const pageIndex = (doc: Any): number => {
    const { log: target, pages } = docLog(doc);
    let index = pages.get(doc.page);
    if (index === undefined) {
      index = pages.size;
      pages.set(doc.page, index);
      target.pageBottoms[index] = doc.page.height - doc.page.margins.bottom;
    }
    return index;
  };
  const proto = PDFDocument.prototype as Any;
  const originalText = proto.text;
  const originalMoveTo = proto.moveTo;
  const originalLineTo = proto.lineTo;
  const originalEnd = proto.end;
  let pendingMove: { doc: object; page: number; x: number; y: number } | null = null;

  vi.spyOn(proto, "text").mockImplementation(function (this: Any, ...args: unknown[]) {
    const startPage = this.page;
    const top = typeof args[2] === "number" ? args[2] : this.y;
    const result = originalText.apply(this, args);
    // Flowing text that continued onto a new page has no single box.
    if (this.page === startPage) {
      const page = pageIndex(this);
      docLog(this).log.boxes.push({ page, top, bottom: this.y, text: String(args[0]) });
    }
    return result;
  });
  vi.spyOn(proto, "moveTo").mockImplementation(function (this: Any, x: number, y: number) {
    pendingMove = { doc: this, page: pageIndex(this), x, y };
    return originalMoveTo.call(this, x, y);
  });
  vi.spyOn(proto, "lineTo").mockImplementation(function (this: Any, x: number, y: number) {
    if (pendingMove && pendingMove.doc === this && pendingMove.y === y && pendingMove.x !== x) {
      docLog(this).log.rules.push({ page: pendingMove.page, y, x1: pendingMove.x, x2: x });
    }
    pendingMove = null;
    return originalLineTo.call(this, x, y);
  });
  vi.spyOn(proto, "end").mockImplementation(function (this: Any) {
    log = docLog(this).log;
    return originalEnd.call(this);
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

/** Text drawn on each page apart from the "N / M" page number. */
function contentPages(): number[] {
  return [
    ...new Set(log.boxes.filter((box) => !/^\d+ \/ \d+$/.test(box.text)).map((box) => box.page)),
  ].sort((a, b) => a - b);
}

describe("PDF page budget", () => {
  // create_document input from live two-page brief tasks that came out as three pages.
  const briefs = northstarBrief as Record<string, ContentBlockInput[]>;

  it.each(Object.keys(briefs))(
    "fits the live %s brief into two numbered pages without rules crossing text",
    async (name) => {
      const { builder, dir } = makeBuilder();
      const content = briefs[name];
      expect(builder.measurePdfLayouts(content, { pageNumbers: true })[0]).toBe(3);
      vi.restoreAllMocks();
      instrumentPdfDrawing();

      const outputPath = path.join(dir, "Northstar-brief.pdf");
      const report = await builder.create(outputPath, "pdf", content, {
        pageNumbers: true,
        maxPages: 2,
      });

      expect(report).toMatchObject({ pageCount: 2, fittedToMaxPages: true, warnings: [] });
      expect(report.layoutLevel).toBeGreaterThan(0);
      const parsed = await parsePdfBuffer(fs.readFileSync(outputPath));
      expect(parsed.numpages).toBe(2);
      expect(boxesWithText("1 / 2").map((box) => box.page)).toEqual([0]);
      expect(boxesWithText("2 / 2").map((box) => box.page)).toEqual([1]);
      expect(log.boxes.some((box) => box.text.endsWith(" / 3"))).toBe(false);
      expect(rulesCrossingText()).toEqual([]);
      for (const box of log.boxes.filter((entry) => !/^\d+ \/ \d+$/.test(entry.text))) {
        expect(box.bottom).toBeLessThanOrEqual(log.pageBottoms[box.page] + 0.5);
      }
      // The page_break still starts page 2, which now holds the last section.
      const breakIndex = content.findIndex((block) => block.type === "page_break");
      expect(boxesWithText(String(content[breakIndex + 1].text))[0].page).toBe(1);
      expect(boxesWithText("Decisões em aberto")[0].page).toBe(1);
      expect(boxesWithText(String(content[breakIndex - 2].text))[0].page).toBe(0);
    },
  );

  it("leaves content that already fits exactly as it is drawn without a budget", async () => {
    const content: ContentBlockInput[] = [
      { type: "heading", text: "Short brief", level: 1 },
      { type: "paragraph", text: "Overview." },
      scheduleTable(3),
      { type: "page_break" },
      { type: "heading", text: "Page two", level: 1 },
      { type: "list", items: ["One", "Two"] },
    ];
    const { builder, dir } = makeBuilder();
    const plain = await builder.create(path.join(dir, "plain.pdf"), "pdf", content, {
      pageNumbers: true,
    });
    const plainLog = log;

    vi.restoreAllMocks();
    instrumentPdfDrawing();
    const budget = await builder.create(path.join(dir, "budget.pdf"), "pdf", content, {
      pageNumbers: true,
      maxPages: 2,
    });

    expect(plain).toMatchObject({ pageCount: 2, layoutLevel: 0 });
    expect(plain.fittedToMaxPages).toBeUndefined();
    expect(budget).toMatchObject({ pageCount: 2, layoutLevel: 0, fittedToMaxPages: true });
    // One layout pass, drawn identically.
    expect(layoutPasses).toBe(1);
    expect(log).toEqual(plainLog);
  });

  it("writes the tightest layout and warns with the page count when content cannot fit", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "long.pdf");
    const content: ContentBlockInput[] = Array.from({ length: 120 }, (_, index) => ({
      type: "paragraph",
      text: `Paragraph ${index + 1}. ${longCell} ${longCell}`,
    }));

    const report = await builder.create(outputPath, "pdf", content, {
      pageNumbers: true,
      maxPages: 2,
    });

    const parsed = await parsePdfBuffer(fs.readFileSync(outputPath));
    expect(report.fittedToMaxPages).toBe(false);
    expect(report.layoutLevel).toBe(PDF_FIT_LADDER.length - 1);
    expect(report.pageCount).toBe(parsed.numpages);
    expect(report.pageCount).toBeGreaterThan(2);
    const [budgetWarning] = report.warnings;
    expect(budgetWarning).toContain(`The PDF has ${report.pageCount} pages, more than maxPages 2`);
    expect(budgetWarning).toMatch(/Shorten the content/);
    // The default and the tightest layout are measured; the levels between are skipped.
    expect(layoutPasses).toBe(2);
    expect(boxesWithText(`${report.pageCount} / ${report.pageCount}`)).toHaveLength(1);
  });

  it("says when the page breaks alone exceed the budget", async () => {
    const { builder, dir } = makeBuilder();
    const report = await builder.create(
      path.join(dir, "breaks.pdf"),
      "pdf",
      [
        { type: "paragraph", text: "One." },
        { type: "page_break" },
        { type: "paragraph", text: "Two." },
        { type: "page_break" },
        { type: "paragraph", text: "Three." },
      ],
      { maxPages: 2 },
    );

    expect(report).toMatchObject({ pageCount: 3, fittedToMaxPages: false });
    expect(report.warnings[0]).toMatch(/page_break blocks alone start 3 pages/);
  });

  it("never turns a page_break into a blank page", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "breaks.pdf");

    const report = await builder.create(
      outputPath,
      "pdf",
      [
        { type: "page_break" },
        { type: "paragraph", text: "One." },
        { type: "page_break" },
        { type: "page_break" },
        { type: "paragraph", text: "Two." },
        { type: "page_break" },
      ],
      { pageNumbers: true, maxPages: 2 },
    );

    const parsed = await parsePdfBuffer(fs.readFileSync(outputPath));
    expect(parsed.numpages).toBe(2);
    expect(report).toMatchObject({ pageCount: 2, fittedToMaxPages: true });
    expect(contentPages()).toEqual([0, 1]);
  });

  it("chooses the first layout that fits and measures as few layouts as it can", () => {
    const measured: number[] = [];
    const pages = (counts: number[]) => (level: number) => {
      measured.push(level);
      return counts[level];
    };

    expect(choosePageFit(2, 4, pages([2, 2, 1, 1]))).toEqual({
      level: 0,
      pageCount: 2,
      fitted: true,
    });
    expect(measured.splice(0)).toEqual([0]);

    expect(choosePageFit(2, 4, pages([3, 3, 2, 2]))).toEqual({
      level: 2,
      pageCount: 2,
      fitted: true,
    });
    expect(measured.splice(0)).toEqual([0, 3, 1, 2]);

    expect(choosePageFit(2, 4, pages([5, 4, 4, 3]))).toEqual({
      level: 3,
      pageCount: 3,
      fitted: false,
    });
    expect(measured.splice(0)).toEqual([0, 3]);
  });

  it("accepts whole-number page budgets only", () => {
    expect(parseMaxPages(undefined)).toBeUndefined();
    expect(parseMaxPages(2)).toBe(2);
    expect(parseMaxPages(" 3 ")).toBe(3);
    for (const invalid of [0, -1, 1.5, "two", true]) {
      expect(() => parseMaxPages(invalid)).toThrow(/maxPages/);
    }
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

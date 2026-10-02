import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as mammoth from "mammoth";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentBuilder } from "../document";
import { parsePdfBuffer } from "../../../utils/pdf-parser";

const tempDirs: string[] = [];

function makeBuilder(): { builder: DocumentBuilder; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-document-create-"));
  tempDirs.push(dir);
  const workspace = { path: dir, permissions: { read: true, write: true } };
  return { builder: new DocumentBuilder(workspace as Any), dir };
}

// Shapes the model sends: tables and lists carry rows/items and no text.
const reportBlocks = [
  { type: "heading", text: "Q3 Report", level: 1 },
  { type: "paragraph", text: "Revenue grew." },
  {
    type: "table",
    rows: [
      ["Region", "Revenue"],
      ["EMEA", 1200],
      ["APAC", "800"],
    ],
  },
  { type: "list", items: ["Hire 2 engineers", "Ship v2"] },
];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DocumentBuilder.create", () => {
  it("writes table rows and list items that arrive without a text field to DOCX", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "report.docx");

    const report = await builder.create(outputPath, "docx", reportBlocks as Any);

    const html = (await mammoth.convertToHtml({ path: outputPath })).value;
    expect(html).toMatch(/<table>[\s\S]*EMEA[\s\S]*1200[\s\S]*APAC[\s\S]*800[\s\S]*<\/table>/);
    expect(html).toMatch(/<li>Hire 2 engineers<\/li>\s*<li>Ship v2<\/li>/);
    expect(report).toEqual({
      requestedBlocks: 4,
      renderedBlocks: 4,
      droppedBlocks: [],
      warnings: [],
    });
  });

  it("writes table rows and list items to PDF", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "report.pdf");

    await builder.create(outputPath, "pdf", reportBlocks as Any);

    const text = (await parsePdfBuffer(fs.readFileSync(outputPath))).text;
    for (const value of ["Q3 Report", "Revenue grew.", "Region", "EMEA", "1200", "APAC", "800"]) {
      expect(text).toContain(value);
    }
    expect(text).toContain("Hire 2 engineers");
    expect(text).toContain("Ship v2");
  });

  it("turns a pipe-table text block into a real table", async () => {
    const { builder, dir } = makeBuilder();
    const outputPath = path.join(dir, "pipes.docx");

    await builder.create(outputPath, "docx", [
      { type: "table", text: "| Owner | Status |\n| --- | --- |\n| Ana | Done |" },
    ] as Any);

    const html = (await mammoth.convertToHtml({ path: outputPath })).value;
    expect(html).toMatch(/<table>[\s\S]*Owner[\s\S]*Status[\s\S]*Ana[\s\S]*Done[\s\S]*<\/table>/);
    expect(html).not.toContain("---");
  });

  it("reports blocks with nothing to render instead of counting them as written", async () => {
    const { builder, dir } = makeBuilder();

    const report = await builder.create(path.join(dir, "notes.docx"), "docx", [
      { type: "heading", text: "Notes", level: 1 },
      { type: "paragraph", text: "  " },
      { type: "table", rows: [] },
    ] as Any);

    expect(report.requestedBlocks).toBe(3);
    expect(report.renderedBlocks).toBe(1);
    expect(report.droppedBlocks).toEqual([
      { index: 1, type: "paragraph", reason: "no text" },
      { index: 2, type: "table", reason: "no rows" },
    ]);
  });
});

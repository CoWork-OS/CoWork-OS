import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ExcelJS from "exceljs";
import type { Workspace } from "../../../../shared/types";
import { SkillTools } from "../skill-tools";

describe("SkillTools access profile boundaries", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let in-place document edits turn a read grant into a write grant", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-tools-"));
    tempDirs.push(directory);
    const documentPath = path.join(directory, "source.docx");
    fs.writeFileSync(documentPath, "placeholder");

    const workspace: Workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: directory,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        accessFilesystemRules: [{ path: documentPath, access: "read" }],
      },
    };
    const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");

    await expect(
      tools.editDocument({
        sourcePath: "source.docx",
        action: "append",
        newContent: [{ type: "paragraph", text: "new content" }],
      }),
    ).rejects.toThrow(/active access profile/i);
  });

  it("appends a page break to an existing Word document", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-tools-"));
    tempDirs.push(directory);
    const workspace: Workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: directory,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    };
    const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");
    await tools.createDocument({
      filename: "brief.docx",
      format: "docx",
      content: [{ type: "paragraph", text: "Page one" }],
    } as Any);

    await tools.editDocument({
      sourcePath: "brief.docx",
      action: "append",
      newContent: [
        { type: "page_break" } as Any,
        { type: "heading", text: "Responsibilities", level: 2 },
      ],
    });

    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(directory, "brief.docx")));
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toMatch(/w:br w:type="page"|w:pageBreakBefore/);
    expect(xml.indexOf("Responsibilities")).toBeGreaterThan(xml.indexOf("Page one"));
  });

  it("creates and reads back a workbook from headers and rows sheet data", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-tools-"));
    tempDirs.push(directory);

    const workspace: Workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: directory,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    };
    const daemon = { logEvent: vi.fn() } as Any;
    const tools = new SkillTools(workspace, daemon, "task-1");

    const result = await tools.createSpreadsheet({
      filename: "attendee-audit",
      sheets: [
        {
          name: "Raw Rows",
          headers: ["Email", "City", "Tickets"],
          rows: [["Ava@example.test", "Lisbon", "2"]],
        },
        {
          name: "Summary",
          headers: ["Metric", "Value"],
          rows: [["Source Rows", "1"]],
        },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(directory, result.path));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Raw Rows", "Summary"]);
    const rawRowsSheet = workbook.getWorksheet("Raw Rows");
    const summarySheet = workbook.getWorksheet("Summary");
    expect([
      rawRowsSheet?.getRow(1).values.slice(1),
      rawRowsSheet?.getRow(2).values.slice(1),
    ]).toEqual([
      ["Email", "City", "Tickets"],
      // Numeric text is written as a number so formulas over the column compute.
      ["Ava@example.test", "Lisbon", 2],
    ]);
    expect([
      summarySheet?.getRow(1).values.slice(1),
      summarySheet?.getRow(2).values.slice(1),
    ]).toEqual([
      ["Metric", "Value"],
      ["Source Rows", 1],
    ]);
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "file_created",
      expect.objectContaining({ path: "attendee-audit.xlsx", sheets: 2 }),
    );
  });

  it("returns a clear error when a sheet has neither supported data shape", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-tools-"));
    tempDirs.push(directory);

    const workspace: Workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: directory,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    };
    const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");

    await expect(
      tools.createSpreadsheet({
        filename: "invalid",
        sheets: [{ name: "Raw Rows" }],
      }),
    ).rejects.toThrow(/must provide a 2D "data" array or both "headers" and "rows" arrays/i);
  });

  it("passes number formats through and reports formulas left without a saved result", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-skill-tools-"));
    tempDirs.push(directory);

    const workspace: Workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: directory,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    };
    const tools = new SkillTools(workspace, { logEvent: vi.fn() } as Any, "task-1");

    const result = await tools.createSpreadsheet({
      filename: "budget",
      sheets: [
        {
          name: "Summary",
          headers: ["Category", "Total EUR"],
          rows: [
            ["Venue", "150"],
            ["Total", "=SUM(B2:B2)"],
            ["Lookup", "=VLOOKUP(A2,A2:B3,2,FALSE)"],
          ],
          numberFormats: [
            { column: "Total EUR", numFmt: "€#,##0.00" },
            { column: "Nope", numFmt: "0" },
          ],
        },
      ],
    });

    expect(result.formulas).toEqual({
      computed: 1,
      uncached: [
        {
          sheet: "Summary",
          address: "B4",
          formula: "VLOOKUP(A2,A2:B3,2,FALSE)",
          reason: "VLOOKUP is not evaluated by CoWork",
        },
      ],
    });
    expect(result.warnings).toEqual([
      'Sheet "Summary": column "Nope" was not found, so "0" was not applied.',
      expect.stringMatching(/^1 formula cell\(s\) have no saved result/),
    ]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(directory, result.path));
    const sheet = workbook.getWorksheet("Summary")!;
    expect(sheet.getCell("B3").numFmt).toBe("€#,##0.00");
    expect(sheet.getCell("B3").value).toEqual({ formula: "SUM(B2:B2)", result: 150 });
  });
});

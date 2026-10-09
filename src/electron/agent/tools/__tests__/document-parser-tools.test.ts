import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { extractPdfTextMock, sensitiveSourceRefMock } = vi.hoisted(() => ({
  extractPdfTextMock: vi.fn(),
  sensitiveSourceRefMock: vi.fn(),
}));

vi.mock("../../../utils/pdf-text", () => ({
  extractPdfText: extractPdfTextMock,
}));

vi.mock("../../security/export-permission-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../security/export-permission-context")>();
  return {
    ...actual,
    buildSensitiveSourceRefForPath: sensitiveSourceRefMock,
  };
});

import { calculateDocumentWindow, DocumentParserTools } from "../document-parser-tools";

describe("DocumentParserTools", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    sensitiveSourceRefMock.mockImplementation((_workspace, filePath) => ({
      path: filePath,
      sourceKind: "workspace_native",
      trustLevel: "trusted",
    }));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-document-parser-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses the plain PDF text extractor for parse_document", async () => {
    const pdfPath = path.join(tmpDir, "book.pdf");
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.7"));
    extractPdfTextMock.mockResolvedValue({
      text: "Le texte du livre est clair.",
      pageCount: 4,
      extractionMode: "pdf-parse",
      usedFallback: false,
      previewLimited: false,
      extractionStatus: "complete",
      extractionNote: "complete via embedded text layer; OCR not needed",
    });

    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [],
      },
    } as Any);

    const result = await tools.parseDocument({ path: "book.pdf" });

    expect(result.content).toBe("Le texte du livre est clair.");
    expect(result.detected_type).toBe("pdf");
    expect(result.pdf_extraction).toEqual({
      status: "complete",
      mode: "pdf-parse",
      used_fallback: false,
      preview_limited: false,
      note: "complete via embedded text layer; OCR not needed",
      page_count: 4,
    });
    expect(extractPdfTextMock).toHaveBeenCalledWith(fs.realpathSync(pdfPath), {
      includeOcr: true,
      maxFallbackPages: 16,
      maxFallbackCharsPerPage: 1600,
      maxFallbackOcrPages: 4,
    });
  });

  it("rejects missing documents with a clear error", async () => {
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [],
      },
    } as Any);

    await expect(tools.parseDocument({ path: "missing.pdf" })).rejects.toThrow(/file not found/i);
  });

  it("reads plain text documents without using the PDF extractor", async () => {
    const textPath = path.join(tmpDir, "notes.txt");
    fs.writeFileSync(textPath, "Plain text note.");

    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [],
      },
    } as Any);

    const result = await tools.parseDocument({ path: "notes.txt" });

    expect(result.content).toBe("Plain text note.");
    expect(result.detected_type).toBe("txt");
    expect(extractPdfTextMock).toHaveBeenCalledTimes(0);
  });

  it("renders spreadsheet formula cells as their cached result or formula text", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Revenue");
    sheet.addRow(["Region", "Revenue"]);
    sheet.addRow(["EMEA", 1200]);
    sheet.addRow(["APAC", 800]);
    sheet.addRow(["Total", { formula: "SUM(B2:B3)" }]);
    sheet.addRow(["Cached", { formula: "B2*2", result: 2400 }]);
    await workbook.xlsx.writeFile(path.join(tmpDir, "revenue.xlsx"));

    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [],
      },
    } as Any);

    const text = await tools.parseDocument({ path: "revenue.xlsx" });
    const structured = await tools.parseDocument({ path: "revenue.xlsx", format: "structured" });

    for (const result of [text, structured]) {
      expect(result.content).not.toContain("[object Object]");
      expect(result.content).toContain("=SUM(B2:B3)");
      expect(result.content).toContain("2400");
    }
  });

  it("lists workbook formulas and number formats so a check can confirm them", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Summary");
    sheet.addRow(["Category", "Total"]);
    sheet.addRow(["Venue", 150]);
    sheet.addRow(["Overall", { formula: "SUM(B2:B2)", result: 150 }]);
    sheet.getCell("B2").numFmt = "€#,##0.00";
    sheet.getCell("B3").numFmt = "€#,##0.00";
    const plain = workbook.addWorksheet("Notes");
    plain.addRow(["Duplicate receipt counted once"]);
    await workbook.xlsx.writeFile(path.join(tmpDir, "budget.xlsx"));

    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [],
      },
    } as Any);

    const result = await tools.parseDocument({ path: "budget.xlsx" });

    expect(result.content).toContain("Formulas in Summary:");
    expect(result.content).toContain("- B3: =SUM(B2:B2) (saved result 150)");
    expect(result.content).toContain("Number formats in Summary:");
    expect(result.content).toContain("- B2: €#,##0.00 (number 150, shown as €150.00)");
    expect(result.content).toContain(
      "- B3: €#,##0.00 (formula result number 150, shown as €150.00)",
    );
    expect(result.content).toContain("Number formats in Notes: none (all cells use General)");
  });

  it("flags date-formatted text and reports a zero formula result", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Expenses");
    sheet.addRow(["Date", "Net", "VAT"]);
    sheet.addRow(["2026-10-05", 80, { formula: "B2*0", result: 0 }]);
    sheet.getCell("A2").numFmt = "DD/MM/YYYY";
    await workbook.xlsx.writeFile(path.join(tmpDir, "dates.xlsx"));

    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [],
      },
    } as Any);

    const result = await tools.parseDocument({ path: "dates.xlsx" });

    expect(result.content).toContain('- A2: DD/MM/YYYY (text "2026-10-05", not a date value)');
    expect(result.content).toContain("- C2: =B2*0 (saved result 0)");
  });

  it("reports stored types and built-in formats of a workbook with inline strings", async () => {
    // The same parts a Python writer produced in a live task: inline-string cells,
    // absolute relationship targets, and built-in numFmtIds 49 (@) and 9 (0%).
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        "</Types>",
    );
    zip.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml"/>' +
        "</Relationships>",
    );
    zip.file(
      "xl/workbook.xml",
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Expenses" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    zip.file(
      "xl/_rels/workbook.xml.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml" Id="rId1"/>' +
        '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml" Id="rId2"/>' +
        "</Relationships>",
    );
    zip.file(
      "xl/styles.xml",
      '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>' +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="7" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    );
    zip.file(
      "xl/worksheets/sheet1.xml",
      '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Invoice ID</t></is></c><c r="B1" t="inlineStr"><is><t>Date</t></is></c>' +
        '<c r="C1" t="inlineStr"><is><t>VAT rate</t></is></c><c r="D1" t="inlineStr"><is><t>Net</t></is></c>' +
        '<c r="E1" t="inlineStr"><is><t>VAT</t></is></c></row>' +
        '<row r="2"><c r="A2" s="1" t="inlineStr"><is><t>00041</t></is></c><c r="B2" s="2" t="n"><v>46300</v></c>' +
        '<c r="C2" s="3" t="n"><v>0.23</v></c><c r="D2" s="4" t="n"><v>120</v></c>' +
        '<c r="E2" s="4"><f>D2*0</f><v>0</v></c></row>' +
        "</sheetData></worksheet>",
    );
    fs.writeFileSync(
      path.join(tmpDir, "costs.xlsx"),
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );

    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [],
      },
    } as Any);

    const result = await tools.parseDocument({ path: "costs.xlsx", format: "structured" });

    expect(result.content).toContain("| Invoice ID | Date | VAT rate | Net | VAT |");
    // Dates print as the date Excel shows, not a local-time Date string; a zero
    // formula result prints as 0, not as the formula text.
    expect(result.content).toContain("| 00041 | 2026-10-05 | 0.23 | 120 | 0 |");
    expect(result.content).toContain('- A2: @ (text "00041")');
    expect(result.content).toContain("- B2: dd/mm/yyyy (date 2026-10-05, shown as 05/10/2026)");
    expect(result.content).toContain("- C2: 0% (number 0.23, shown as 23%)");
    expect(result.content).toContain(
      '- D2: "$"#,##0.00_);("$"#,##0.00) [built-in format 7] (number 120, shown as $120.00)',
    );
    expect(result.content).toContain("- E2: =D2*0 (saved result 0)");
    expect(result.content).not.toContain("GMT");
  });

  it("returns lossless continuation metadata for bounded document windows", async () => {
    fs.writeFileSync(path.join(tmpDir, "long.txt"), "0123456789".repeat(30));
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [],
      },
    } as Any);

    const windows = [];
    let startChar: number | undefined;
    do {
      const result = await tools.parseDocument({
        path: "long.txt",
        start_char: startChar,
        max_chars: 100,
      });
      windows.push(result);
      startChar = result.next_start_char;
    } while (startChar !== undefined);
    const tail = await tools.parseDocument({
      path: "long.txt",
      start_char: 200,
      max_chars: 100,
    });

    expect(windows[0].window.start).toBe(0);
    expect(windows.at(-1)?.window.end).toBe(300);
    expect(windows.every((result) => result.content.length <= 100)).toBe(true);
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index].window.start).toBe(windows[index - 1].window.end);
    }
    expect(tail.window).toEqual({ start: 200, end: 300, total: 300 });
    expect(tail.truncated).toBe(false);
    expect(tail.next_start_char).toBeUndefined();
  });

  it("paginates formatted JSON without discarding the remainder", async () => {
    const jsonPath = path.join(tmpDir, "long.json");
    const parsed = {
      records: Array.from({ length: 40 }, (_, index) => ({ index, value: `v-${index}` })),
    };
    fs.writeFileSync(jsonPath, JSON.stringify(parsed));
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    } as Any);

    const source = JSON.stringify(parsed, null, 2);
    let reconstructed = "";
    let startChar: number | undefined;
    do {
      const result = await tools.parseDocument({
        path: jsonPath,
        max_chars: 100,
        start_char: startChar,
      });
      reconstructed += source.slice(result.window.start, result.window.end);
      startChar = result.next_start_char;
    } while (startChar !== undefined);

    expect(reconstructed).toBe(source);
  });

  it("keeps output within max_chars across continuation-note digit boundaries", async () => {
    fs.writeFileSync(path.join(tmpDir, "boundary.txt"), "x".repeat(141));
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: false, shell: false },
    } as Any);

    const result = await tools.parseDocument({ path: "boundary.txt", max_chars: 140 });

    expect(result.content.length).toBeLessThanOrEqual(140);
    expect(result.window.end).toBeLessThan(141);
  });

  it("enforces workspace read permission and project ACCESS.md", async () => {
    const projectDir = path.join(tmpDir, ".cowork", "projects", "private");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "ACCESS.md"), "## Deny\n- role: reviewer\n");
    fs.writeFileSync(path.join(projectDir, "notes.txt"), "restricted");

    const deniedByWorkspace = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: false, write: true, delete: true, network: false, shell: false },
    } as Any);
    await expect(deniedByWorkspace.parseDocument({ path: "notes.txt" })).rejects.toThrow(
      /read permission not granted/i,
    );

    const deniedByProject = new DocumentParserTools(
      {
        id: "ws-1",
        name: "Test Workspace",
        path: tmpDir,
        createdAt: Date.now(),
        permissions: { read: true, write: true, delete: true, network: false, shell: false },
      } as Any,
      { getTask: () => ({ assignedAgentRoleId: "reviewer" }) } as Any,
      "task-1",
    );
    await expect(
      deniedByProject.parseDocument({ path: ".cowork/projects/private/notes.txt" }),
    ).rejects.toThrow(/denied by ACCESS\.md/i);
  });

  it("keeps trust banners and continuation notes inside max_chars", async () => {
    const workspacePath = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspacePath);
    const externalPath = path.join(tmpDir, "external.txt");
    fs.writeFileSync(externalPath, "x".repeat(300));
    sensitiveSourceRefMock.mockReturnValueOnce({
      path: externalPath,
      sourceKind: "download",
      trustLevel: "untrusted",
    });
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: workspacePath,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        allowedPaths: [tmpDir],
      },
    } as Any);

    const result = await tools.parseDocument({ path: externalPath, max_chars: 100 });

    expect(result.content.length).toBeLessThanOrEqual(100);
    expect(result.content).toContain("UNTRUSTED EXTERNAL CONTENT");
    expect(result.next_start_char).toBe(result.window.end);
    expect(result.window.end).toBeGreaterThan(0);
  });

  it("rejects a document denied by the active access profile", async () => {
    const deniedPath = path.join(tmpDir, "private.txt");
    fs.writeFileSync(deniedPath, "do not read");
    const tools = new DocumentParserTools({
      id: "ws-1",
      name: "Test Workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: false,
        shell: false,
        accessFilesystemRules: [{ path: deniedPath, access: "deny" }],
      },
    } as Any);

    await expect(tools.parseDocument({ path: "private.txt" })).rejects.toThrow(
      /denied by the active access profile/i,
    );
  });

  it("advances high-offset untrusted windows when an in-band note cannot fit", () => {
    const window = calculateDocumentWindow({
      total: 100_000_010,
      start: 100_000_000,
      maxChars: 100,
      prefixLength: 40,
    });

    expect(window.end).toBeGreaterThan(100_000_000);
    expect(window.note).toBe("");
    expect(40 + window.end - 100_000_000).toBeLessThanOrEqual(100);
  });
});

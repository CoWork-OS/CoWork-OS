import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import ExcelJS from "exceljs";
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
});

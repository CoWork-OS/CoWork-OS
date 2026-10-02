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
});

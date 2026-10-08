import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  buildDelimitedSpreadsheetPreview,
  buildSpreadsheetPreviewFromFile,
  spreadsheetPreviewToDelimitedText,
  spreadsheetPreviewToTsv,
  writeDelimitedSpreadsheetPreviewToFile,
  writeSpreadsheetPreviewToFile,
} from "../spreadsheet-preview";

describe("spreadsheet preview extraction", () => {
  it("extracts sheets, formulas, empty cells, styles, and bounds", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-xlsx-preview-"));
    const outPath = path.join(tmpDir, "preview.xlsx");
    const workbook = new ExcelJS.Workbook();

    const summary = workbook.addWorksheet("Summary");
    summary.columns = [{ width: 8 }, { width: 24 }, { width: 12 }];
    summary.getCell("A1").value = "Rank";
    summary.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" } };
    summary.getCell("A1").fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" },
    };
    summary.getCell("B1").value = "Topic";
    summary.getCell("C1").value = { formula: "SUM(A2:A3)", result: 3 };
    summary.getCell("A2").value = 1;
    summary.getCell("C2").value = "keeps B2 empty";
    summary.getCell("A3").value = 2;
    summary.getCell("B3").value = "Notifications";

    const detail = workbook.addWorksheet("Detail");
    detail.getCell("A1").value = "Issue";

    await workbook.xlsx.writeFile(outPath);

    const preview = await buildSpreadsheetPreviewFromFile(outPath);

    expect(preview.sheetCount).toBe(2);
    expect(preview.activeSheetName).toBe("Summary");
    expect(preview.sheets[0].name).toBe("Summary");
    expect(preview.sheets[0].rowCount).toBe(3);
    expect(preview.sheets[0].columnCount).toBe(3);
    expect(preview.sheets[0].columnWidths).toEqual([8, 24, 12]);
    expect(preview.sheets[0].rows[0][0]).toMatchObject({
      address: "A1",
      value: "Rank",
      bold: true,
      backgroundColor: "#1F4E78",
      fontColor: "#FFFFFF",
    });
    expect(preview.sheets[0].rows[0][2]).toMatchObject({
      address: "C1",
      value: "3",
      formula: "SUM(A2:A3)",
    });
    expect(preview.sheets[0].rows[1][1]).toMatchObject({
      address: "B2",
      value: "",
    });
    expect(preview.sheets[1].name).toBe("Detail");
    expect(spreadsheetPreviewToTsv(preview)).toContain("## Sheet: Summary");
  });

  it("writes edited preview values back to the workbook", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-xlsx-edit-"));
    const outPath = path.join(tmpDir, "editable.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.getCell("A1").value = "Name";
    sheet.getCell("B1").value = "Status";
    sheet.getCell("A2").value = "Alice";
    sheet.getCell("B2").value = "Active";
    await workbook.xlsx.writeFile(outPath);

    const preview = await buildSpreadsheetPreviewFromFile(outPath);
    preview.sheets[0].rows[1][1].value = "Pending";
    preview.sheets[0].rows.push([
      { address: "A3", row: 3, column: 1, value: "Bruno" },
      { address: "B3", row: 3, column: 2, value: "=UPPER(A3)", formula: "UPPER(A3)" },
    ]);
    preview.sheets[0].rowCount = 3;

    await writeSpreadsheetPreviewToFile(outPath, preview);

    const reread = new ExcelJS.Workbook();
    await reread.xlsx.readFile(outPath);
    const savedSheet = reread.getWorksheet("Sheet1");
    expect(savedSheet?.getCell("B2").value).toBe("Pending");
    expect(savedSheet?.getCell("A3").value).toBe("Bruno");
    expect(savedSheet?.getCell("B3").value).toMatchObject({ formula: "UPPER(A3)" });
  });

  it("marks xlsx previews as truncated when source bounds exceed the preview window", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-xlsx-large-preview-"));
    const outPath = path.join(tmpDir, "large.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Large");
    sheet.getCell("A1").value = "Header";
    sheet.getCell("A2001").value = "Outside preview";
    await workbook.xlsx.writeFile(outPath);

    const preview = await buildSpreadsheetPreviewFromFile(outPath);

    expect(preview.sheets[0].rows).toHaveLength(2000);
    expect(preview.sheets[0].sourceRowCount).toBe(2001);
    expect(preview.sheets[0].truncated).toBe(true);
  });

  it("extracts and writes CSV previews with quoted cells", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-csv-preview-"));
    const outPath = path.join(tmpDir, "people.csv");
    const preview = buildDelimitedSpreadsheetPreview(
      'Name,Notes\n"Alice, A.","Line 1\nLine 2"\nBruno,Ready',
      {
        delimiter: ",",
        sheetName: "people",
      },
    );

    expect(preview.sheetCount).toBe(1);
    expect(preview.sheets[0].name).toBe("people");
    expect(preview.sheets[0].columnCount).toBe(2);
    expect(preview.sheets[0].rows[1][0].value).toBe("Alice, A.");
    expect(preview.sheets[0].rows[1][1].value).toBe("Line 1\nLine 2");

    preview.sheets[0].rows[2][1].value = 'Ready, "verified"';
    await writeDelimitedSpreadsheetPreviewToFile(outPath, preview, ",");
    const saved = await fs.readFile(outPath, "utf-8");
    expect(saved).toContain('"Ready, ""verified"""');
  });

  it("preserves CSV rows outside the editable preview window", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-csv-large-"));
    const outPath = path.join(tmpDir, "large.csv");
    const lines = Array.from({ length: 2005 }, (_, index) => `row-${index + 1},value-${index + 1}`);
    await fs.writeFile(outPath, lines.join("\n"), "utf-8");

    const preview = buildDelimitedSpreadsheetPreview(await fs.readFile(outPath, "utf-8"), {
      delimiter: ",",
      sheetName: "large",
    });
    expect(preview.sheets[0].rows).toHaveLength(2000);
    expect(preview.sheets[0].truncated).toBe(true);

    preview.sheets[0].rows[0][1].value = "edited";
    await writeDelimitedSpreadsheetPreviewToFile(outPath, preview, ",");

    const saved = (await fs.readFile(outPath, "utf-8")).split("\n");
    expect(saved).toHaveLength(2005);
    expect(saved[0]).toBe("row-1,edited");
    expect(saved[2004]).toBe("row-2005,value-2005");
  });

  it("preserves the existing record line ending and final newline when saving a CSV cell", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-csv-newline-"));
    const outPath = path.join(tmpDir, "quoted.csv");

    for (const original of [
      'item,quantity\n"Pen ""blue""",3\n',
      'item,quantity\r\n"Pen ""blue""",3\r\n',
      'item,quantity\r\n"Line 1\nLine 2",2\r\n"Pen ""blue""",3\r\n',
      'item,quantity\r"Pen ""blue""",3\r',
      'item,quantity\n"Pen ""blue""",3',
    ]) {
      await fs.writeFile(outPath, original, "utf-8");
      const preview = buildDelimitedSpreadsheetPreview(original, { delimiter: "," });
      preview.sheets[0].rows.at(-1)![0].value = 'Pen, "blue"';

      await writeDelimitedSpreadsheetPreviewToFile(outPath, preview, ",");

      const expected = original.replace('"Pen ""blue"""', '"Pen, ""blue"""');
      expect(await fs.readFile(outPath, "utf-8")).toBe(expected);
    }
  });

  it("appends added CSV rows after hidden source rows", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-csv-append-large-"));
    const outPath = path.join(tmpDir, "large.csv");
    const lines = Array.from({ length: 2005 }, (_, index) => `row-${index + 1},value-${index + 1}`);
    await fs.writeFile(outPath, lines.join("\n"), "utf-8");

    const preview = buildDelimitedSpreadsheetPreview(await fs.readFile(outPath, "utf-8"), {
      delimiter: ",",
      sheetName: "large",
    });
    preview.sheets[0].rows.push([
      { address: "A2001", row: 2001, column: 1, value: "new-row" },
      { address: "B2001", row: 2001, column: 2, value: "new-value" },
    ]);
    preview.sheets[0].rowCount = 2001;

    await writeDelimitedSpreadsheetPreviewToFile(outPath, preview, ",");

    const saved = (await fs.readFile(outPath, "utf-8")).split("\n");
    expect(saved).toHaveLength(2006);
    expect(saved[2000]).toBe("row-2001,value-2001");
    expect(saved[2005]).toBe("new-row,new-value");
  });

  it("serializes TSV previews with tabs preserved as delimiters", () => {
    const preview = buildDelimitedSpreadsheetPreview("Name\tStatus\nAlice\tActive", {
      delimiter: "\t",
      sheetName: "Sheet",
    });

    expect(spreadsheetPreviewToDelimitedText(preview, "\t")).toBe("Name\tStatus\nAlice\tActive");
  });

  describe("number formats and formula results", () => {
    const EURO = "€#,##0.00;[Red]-€#,##0.00";

    /** The repaired budget workbook: euro amounts, a date, SUMIF totals and a shared formula. */
    async function writeBudgetWorkbook(outPath: string): Promise<void> {
      const workbook = new ExcelJS.Workbook();
      const transactions = workbook.addWorksheet("Transactions");
      transactions.addRow(["Date", "Category", "Amount EUR"]);
      transactions.addRow([new Date(Date.UTC(2026, 9, 1)), "Venue", 180]);
      transactions.addRow([new Date(Date.UTC(2026, 9, 2)), "Catering", 96.5]);
      transactions.addRow([new Date(Date.UTC(2026, 9, 5)), "Venue", -30]);
      transactions.getCell("A2").numFmt = "yyyy-mm-dd";
      for (const address of ["C2", "C3", "C4"]) transactions.getCell(address).numFmt = EURO;
      const summary = workbook.addWorksheet("Summary");
      summary.addRow(["Category", "Total EUR", "Double"]);
      summary.addRow([
        "Venue",
        { formula: "SUMIF(Transactions!B2:B4,A2,Transactions!C2:C4)", result: 150 },
        { formula: "B2*2", result: 300, shareType: "shared", ref: "C2:C3" },
      ]);
      summary.addRow([
        "Total",
        { formula: "SUM(Transactions!C2:C4)", result: 246.5 },
        { sharedFormula: "C2", result: 493 },
      ]);
      summary.addRow(["Pending", { formula: "SUM(B2:B3)" }]);
      for (const address of ["B2", "B3", "B4"]) summary.getCell(address).numFmt = EURO;
      await workbook.xlsx.writeFile(outPath);
    }

    it("keeps raw values editable and shows what Excel shows", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-xlsx-formats-"));
      const outPath = path.join(tmpDir, "budget.xlsx");
      await writeBudgetWorkbook(outPath);

      const preview = await buildSpreadsheetPreviewFromFile(outPath);
      const [transactions, summary] = preview.sheets;

      expect(transactions.rows[1][2]).toMatchObject({
        value: "180",
        displayValue: "€180.00",
        numFmt: EURO,
        valueType: "number",
      });
      expect(transactions.rows[3][2]).toMatchObject({ value: "-30", displayValue: "-€30.00" });
      expect(transactions.rows[1][0]).toMatchObject({
        value: "2026-10-01T00:00:00.000Z",
        displayValue: "2026-10-01",
        valueType: "date",
      });
      expect(transactions.rows[1][1].displayValue).toBeUndefined();
      expect(summary.rows.slice(1, 3).map((row) => row[1].displayValue)).toEqual([
        "€150.00",
        "€246.50",
      ]);
      expect(summary.rows[1][1]).toMatchObject({
        value: "150",
        formula: "SUMIF(Transactions!B2:B4,A2,Transactions!C2:C4)",
      });
      // A shared formula is still a formula, translated for its own row.
      expect(summary.rows[2][2]).toMatchObject({ value: "493", formula: "B3*2" });
      // No saved result: say so with the formula instead of a blank total.
      expect(summary.rows[3][1]).toMatchObject({
        value: "",
        displayValue: "=SUM(B2:B3)",
        formulaPending: true,
        formula: "SUM(B2:B3)",
      });
      expect(spreadsheetPreviewToTsv(preview)).toContain("Venue\t€150.00\t300");
    });

    it("saves edits without turning numbers, dates or shared formulas into text", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-xlsx-roundtrip-"));
      const outPath = path.join(tmpDir, "budget.xlsx");
      await writeBudgetWorkbook(outPath);

      const preview = await buildSpreadsheetPreviewFromFile(outPath);
      const [transactions, summary] = preview.sheets;
      transactions.rows[2][1].value = "Snacks";
      transactions.rows[3][2] = {
        ...transactions.rows[3][2],
        value: "-40",
        displayValue: "-€40.00",
      };
      // Display fields come from the renderer: an unchanged value with a forged display is not
      // written, and a changed value is written from `value`, never from `displayValue`.
      transactions.rows[1][2].displayValue = "forged";
      summary.rows[3][1].displayValue = "999";
      summary.rows.push([
        { address: "A5", row: 5, column: 1, value: "Average" },
        {
          address: "B5",
          row: 5,
          column: 2,
          value: "=AVERAGE(Transactions!C2:C4)",
          formula: "AVERAGE(Transactions!C2:C4)",
        },
      ]);
      summary.rowCount = 5;

      const saved = await writeSpreadsheetPreviewToFile(outPath, preview);

      const reread = new ExcelJS.Workbook();
      await reread.xlsx.readFile(outPath);
      const savedTransactions = reread.getWorksheet("Transactions")!;
      const savedSummary = reread.getWorksheet("Summary")!;
      expect(savedTransactions.getCell("C2").value).toBe(180);
      expect(savedTransactions.getCell("C4").value).toBe(-40);
      expect(savedTransactions.getCell("C4").numFmt).toBe(EURO);
      expect(savedTransactions.getCell("A2").value).toEqual(new Date(Date.UTC(2026, 9, 1)));
      expect(savedTransactions.getCell("B3").value).toBe("Snacks");
      expect(savedSummary.getCell("B2").value).toEqual({
        formula: "SUMIF(Transactions!B2:B4,A2,Transactions!C2:C4)",
        result: 140,
      });
      expect(savedSummary.getCell("B3").value).toEqual({
        formula: "SUM(Transactions!C2:C4)",
        result: 236.5,
      });
      expect(savedSummary.getCell("C3").value).toEqual({ sharedFormula: "C2", result: 473 });
      expect(savedSummary.getCell("B4").value).toEqual({ formula: "SUM(B2:B3)", result: 376.5 });
      expect(savedSummary.getCell("B5").value).toEqual({
        formula: "AVERAGE(Transactions!C2:C4)",
        result: 78.8333333333333,
      });
      expect(saved.sheets[1].rows[1][1].displayValue).toBe("€140.00");
      const workbookXml = await (
        await JSZip.loadAsync(await fs.readFile(outPath))
      )
        .file("xl/workbook.xml")!
        .async("string");
      expect(workbookXml).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
    });
  });
});

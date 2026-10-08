import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { normalizeSpreadsheetCell } from "../spreadsheet-cells";
import { computeWorkbookFormulaResults, summarizeFormulaReport } from "../spreadsheet-formulas";

/** The workbook from the live run: deduplicated transactions and a SUMIF summary. */
function buildBudgetWorkbook(summaryRows: string[][]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheets: Array<[string, string[][]]> = [
    [
      "Transactions",
      [
        ["Date", "Category", "Description", "Amount EUR"],
        ["2026-10-01", "Venue", "Room deposit", "180"],
        ["2026-10-02", "Catering", "Snacks", "96.5"],
        ["2026-10-03", "Equipment", "Microphone rental", "45"],
        ["2026-10-04", "Marketing", "Posters", "28.75"],
        ["2026-10-05", "Venue", "Deposit refund", "-30"],
        ["Audit note", "Excluded one duplicate Snacks charge"],
      ],
    ],
    ["Summary", [["Category", "Total EUR"], ...summaryRows]],
  ];
  for (const [name, rows] of sheets) {
    const sheet = workbook.addWorksheet(name);
    rows.forEach((row, index) =>
      sheet.addRow(row.map((cell) => normalizeSpreadsheetCell(cell, { coerceNumbers: index > 0 }))),
    );
  }
  return workbook;
}

function resultOf(workbook: ExcelJS.Workbook, address: string): unknown {
  const value = workbook.getWorksheet("Summary")!.getCell(address).value;
  return (value as ExcelJS.CellFormulaValue).result;
}

describe("computeWorkbookFormulaResults", () => {
  it("caches SUMIF and SUM totals across sheets", () => {
    const workbook = buildBudgetWorkbook([
      ["Venue", "=SUMIF(Transactions!B2:B6,A2,Transactions!D2:D6)"],
      ["Catering", "=SUMIF(Transactions!B2:B6,A3,Transactions!D2:D6)"],
      ["Equipment", "=SUMIF(Transactions!B2:B6,A4,Transactions!D2:D6)"],
      ["Marketing", "=SUMIF(Transactions!B2:B6,A5,Transactions!D2:D6)"],
      ["Overall Total", "=SUM(Transactions!D2:D6)"],
    ]);

    const report = computeWorkbookFormulaResults(workbook);

    expect(report).toEqual({ computed: 5, uncached: [] });
    expect(["B2", "B3", "B4", "B5", "B6"].map((address) => resultOf(workbook, address))).toEqual([
      150, 96.5, 45, 28.75, 320.25,
    ]);
    expect(workbook.getWorksheet("Summary")!.getCell("B6").value).toEqual({
      formula: "SUM(Transactions!D2:D6)",
      result: 320.25,
    });
  });

  it("evaluates common functions, criteria, operators and whole-column ranges", () => {
    const workbook = buildBudgetWorkbook([
      ["Average", "=ROUND(AVERAGE(Transactions!D2:D6),2)"],
      ["Venue rows", '=COUNTIF(Transactions!B:B,"Venue")'],
      [
        "Positive V*",
        '=SUMIFS(Transactions!D2:D6,Transactions!B2:B6,"v*",Transactions!D2:D6,">0")',
      ],
      ["Share", "=B2/SUM(B2:B3)"],
      ["Spread", "=MAX(Transactions!D2:D6)-MIN(Transactions!D:D)"],
      ["Label", '=A2&" total"'],
      ["Rows", "=COUNT(Transactions!D:D)+COUNTA(Transactions!A2:A7)"],
      ["Check", '=IF(SUM(Transactions!D2:D6)>300,"over","under")'],
      ["Percent", "=50%*-2^2"],
      ["Not venue", '=COUNTIFS(Transactions!B2:B6,"<>Venue")'],
      ["Rounded", "=ROUNDUP(1.231,2)+ROUNDDOWN(1.239,2)+ABS(-1)"],
      ["Avg venue", '=AVERAGEIF(Transactions!B2:B6,"venue",Transactions!D2:D6)'],
    ]);

    const report = computeWorkbookFormulaResults(workbook);

    expect(report.uncached).toEqual([]);
    const results = [
      "B2",
      "B3",
      "B4",
      "B5",
      "B6",
      "B7",
      "B8",
      "B9",
      "B10",
      "B11",
      "B12",
      "B13",
    ].map((address) => resultOf(workbook, address));
    expect(results[3]).toBeCloseTo(64.05 / 66.05, 12);
    expect([...results.slice(0, 3), ...results.slice(4)]).toEqual([
      64.05,
      2,
      180,
      210,
      "Average total",
      11,
      "over",
      2,
      3,
      3.47,
      75,
    ]);
  });

  it("leaves unsupported, circular and erroring formulas uncached and reports why", () => {
    const workbook = buildBudgetWorkbook([
      ["Lookup", '=XLOOKUP("Venue",A2:A4,B2:B4)'],
      ["Self", "=B3+1"],
      ["Divide", "=1/0"],
      ["Named", "=SUM(Budget)"],
      ["Fine", "=1+1"],
    ]);

    const report = computeWorkbookFormulaResults(workbook);

    expect(report.computed).toBe(1);
    expect(report.uncached.map(({ address, reason }) => [address, reason])).toEqual([
      ["B2", "XLOOKUP is not evaluated by CoWork"],
      ["B3", "circular reference"],
      ["B4", "#DIV/0!"],
      ["B5", 'unsupported syntax near "Budget)"'],
    ]);
    expect(workbook.getWorksheet("Summary")!.getCell("B2").value).toEqual({
      formula: 'XLOOKUP("Venue",A2:A4,B2:B4)',
    });
    expect(resultOf(workbook, "B6")).toBe(2);
  });

  it("stops at deep dependency chains instead of overflowing the stack", () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Run");
    sheet.getCell(1, 1).value = 1;
    for (let row = 2; row <= 3000; row += 1) {
      sheet.getCell(row, 1).value = { formula: `A${row - 1}+1` };
    }
    for (let row = 1; row < 800; row += 1) {
      sheet.getCell(row, 2).value = { formula: `B${row + 1}+1` };
    }
    sheet.getCell(800, 2).value = 0;

    const report = computeWorkbookFormulaResults(workbook);

    // Running totals compute top-down; a chain pointing 800 rows down is cut off, not crashed.
    expect((sheet.getCell(3000, 1).value as ExcelJS.CellFormulaValue).result).toBe(3000);
    expect((sheet.getCell(799, 2).value as ExcelJS.CellFormulaValue).result).toBe(1);
    expect(report.uncached.length).toBeGreaterThan(0);
    expect(report.uncached[0].reason).toBe("dependency chain is too deep");
  });

  it("summarizes a bounded uncached list with a note for the tool result", () => {
    const uncached = Array.from({ length: 25 }, (_, index) => ({
      sheet: "S",
      address: `A${index + 1}`,
      formula: "XLOOKUP(1,B:B,C:C)",
      reason: "XLOOKUP is not evaluated by CoWork",
    }));

    const summary = summarizeFormulaReport({ computed: 3, uncached });

    expect(summary.formulas.computed).toBe(3);
    expect(summary.formulas.uncached).toHaveLength(20);
    expect(summary.formulas.uncachedOmitted).toBe(5);
    expect(summary.warning).toMatch(/25 formula cell\(s\) have no saved result/);
    expect(summarizeFormulaReport({ computed: 1, uncached: [] })).toEqual({
      formulas: { computed: 1, uncached: [] },
    });
  });
});

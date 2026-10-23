import { describe, expect, it } from "vitest";
import { buildSpreadsheetPointerAnnotation, spreadsheetRangeAddress } from "../spreadsheet-pointer";
import {
  adjustChangesToAnnotationValues,
  describeAdjustChanges,
} from "../BrowserWorkbench/adjust-changes";

describe("spreadsheet pointer", () => {
  it("names a cell or a range whichever corner came first", () => {
    const at = (row: number, column: number) => ({ row, column });
    expect(spreadsheetRangeAddress({ start: at(2, 2), end: at(2, 2) })).toBe("B2");
    expect(spreadsheetRangeAddress({ start: at(5, 3), end: at(2, 2) })).toBe("B2:C5");
    expect(spreadsheetRangeAddress({ start: at(1, 27), end: at(1, 27) })).toBe("AA1");
  });

  it("builds a change annotation with the range and its current values", () => {
    const annotation = buildSpreadsheetPointerAnnotation({
      taskId: "task-1",
      workspaceId: "ws-1",
      filePath: "/ws/report.xlsx",
      sheetName: "Q3",
      range: { start: { row: 2, column: 2 }, end: { row: 3, column: 3 } },
      cellText: (row, column) => `r${row}c${column}`,
      request: "Use net figures",
    });
    expect(annotation).toEqual({
      taskId: "task-1",
      workspaceId: "ws-1",
      surfaceType: "artifact",
      surfaceId: "/ws/report.xlsx",
      body: "Use net figures",
      targetRef: {
        surfaceType: "artifact",
        filePath: "/ws/report.xlsx",
        fileType: "spreadsheet",
        sheetName: "Q3",
        cellRange: "B2:C3",
      },
      intent: "change",
      before: { B2: "r2c2", C2: "r2c3", B3: "r3c2", C3: "r3c3" },
    });
  });

  it("sends at most 50 cells' values", () => {
    const annotation = buildSpreadsheetPointerAnnotation({
      taskId: "task-1",
      filePath: "/ws/report.xlsx",
      sheetName: "Q3",
      range: { start: { row: 1, column: 1 }, end: { row: 100, column: 10 } },
      cellText: () => "x",
      request: "Round everything",
    });
    expect(Object.keys(annotation.before!)).toHaveLength(50);
    expect(annotation.targetRef).toMatchObject({ cellRange: "A1:J100" });
  });
});

describe("Browser Adjust as annotation values", () => {
  it("splits each adjusted property into what it was and what it was set to", () => {
    const changes = {
      styles: {
        fontSize: { from: "14px", to: "16px" },
        color: { from: "rgb(0, 0, 0)", to: "#08213f" },
      },
      text: { from: "Buy", to: "Buy now" },
    };
    expect(adjustChangesToAnnotationValues(changes)).toEqual({
      before: { fontSize: "14px", color: "rgb(0, 0, 0)", text: "Buy" },
      after: { fontSize: "16px", color: "#08213f", text: "Buy now" },
    });
    expect(describeAdjustChanges(changes)).toContain("- font-size: 14px → 16px");
  });
});

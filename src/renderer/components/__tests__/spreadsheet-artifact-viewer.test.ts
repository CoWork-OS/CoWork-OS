import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  getCellDisplayText,
  hasPendingFormulaResults,
  SpreadsheetArtifactViewer,
} from "../SpreadsheetArtifactViewer";
import type { SpreadsheetPreview } from "../../../shared/spreadsheet-preview";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("SpreadsheetArtifactViewer", () => {
  it("shows the spreadsheet filename only in the header", () => {
    const markup = render(
      React.createElement(SpreadsheetArtifactViewer, {
        filePath: "/workspace/sample.xlsx",
        workspacePath: "/workspace",
        mode: "sidebar",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
      }),
    );

    expect(markup.match(/sample\.xlsx/g)?.length).toBe(1);
    expect(markup).not.toContain('class="spreadsheet-viewer-title"');
  });

  it("renders an icon-only full screen action in sidebar mode", () => {
    const markup = render(
      React.createElement(SpreadsheetArtifactViewer, {
        filePath: "/workspace/sample.xlsx",
        workspacePath: "/workspace",
        mode: "sidebar",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
      }),
    );

    expect(markup).toContain("Open spreadsheet in full screen");
    expect(markup).not.toContain(">Full screen</button>");
    expect(markup).not.toContain("New tab");
  });

  it("renders an icon-only exit full screen action in full screen mode", () => {
    const markup = render(
      React.createElement(SpreadsheetArtifactViewer, {
        filePath: "/workspace/sample.xlsx",
        workspacePath: "/workspace",
        mode: "fullscreen",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
      }),
    );

    expect(markup).toContain("Exit full screen");
    expect(markup).not.toContain(">Exit full screen</button>");
    expect(markup).not.toContain("New tab");
  });

  it("renders fullscreen turn context collapsed by default", () => {
    const markup = render(
      React.createElement(SpreadsheetArtifactViewer, {
        filePath: "/workspace/sample.xlsx",
        workspacePath: "/workspace",
        mode: "fullscreen",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
        onSendMessage: async () => {},
        turnContext: {
          statusLabel: "Latest turn",
          summary: "Created the sample spreadsheet.",
          artifactPath: "/workspace/sample.xlsx",
          artifactName: "sample.xlsx",
        },
      }),
    );

    expect(markup).toContain("spreadsheet-viewer-turn-frame collapsed");
    expect(markup).toContain("Latest turn");
    expect(markup).not.toContain("Created the sample spreadsheet.");
  });

  it("shows number-formatted text, pending formulas and typed formulas in the grid", () => {
    const cell = { address: "B2", row: 2, column: 2 };
    expect(getCellDisplayText({ ...cell, value: "96.5", displayValue: "€96.50" })).toBe("€96.50");
    expect(getCellDisplayText({ ...cell, value: "Venue" })).toBe("Venue");
    expect(
      getCellDisplayText({
        ...cell,
        value: "",
        formula: "SUM(B2:B5)",
        displayValue: "=SUM(B2:B5)",
        formulaPending: true,
      }),
    ).toBe("=SUM(B2:B5)");
    // A formula typed in the viewer shows as typed until it is saved and calculated.
    expect(getCellDisplayText({ ...cell, value: "=B2*2", formula: "B2*2" })).toBe("=B2*2");
    expect(getCellDisplayText(undefined)).toBe("");
  });

  it("hides cached dependent totals across sheets while draft edits await Save", () => {
    const quantity = { address: "B2", row: 2, column: 2, value: "3" };
    const lineTotal = {
      address: "D2",
      row: 2,
      column: 4,
      value: "4.8",
      displayValue: "€4.80",
      formula: "B2*C2",
    };
    const grandTotal = {
      address: "D6",
      row: 6,
      column: 4,
      value: "16.7",
      displayValue: "€16.70",
      formula: "SUM(Shopping!D2:D5)",
    };
    const preview = {
      sheetCount: 2,
      sheets: [
        {
          name: "Shopping",
          rowCount: 2,
          columnCount: 4,
          columnWidths: [],
          rows: [[quantity, lineTotal]],
        },
        { name: "Summary", rowCount: 1, columnCount: 4, columnWidths: [], rows: [[grandTotal]] },
      ],
    } as SpreadsheetPreview;

    expect(hasPendingFormulaResults(preview, true)).toBe(true);
    expect(getCellDisplayText(quantity, true)).toBe("3");
    expect(getCellDisplayText(lineTotal, true)).toBe("=B2*C2");
    expect(getCellDisplayText(grandTotal, true)).toBe("=SUM(Shopping!D2:D5)");
    // Presentation must preserve raw formulas and data for the existing save path.
    expect(lineTotal.value).toBe("4.8");
    expect(lineTotal.formula).toBe("B2*C2");

    expect(hasPendingFormulaResults(preview, false)).toBe(false);
    expect(getCellDisplayText({ ...lineTotal, value: "7.2", displayValue: "€7.20" }, false)).toBe(
      "€7.20",
    );
    expect(
      getCellDisplayText({ ...grandTotal, value: "19.1", displayValue: "€19.10" }, false),
    ).toBe("€19.10");
  });

  it("does not show a recalculation notice for edits in a workbook without formulas", () => {
    const preview = {
      sheetCount: 1,
      sheets: [
        {
          name: "List",
          rowCount: 1,
          columnCount: 1,
          columnWidths: [],
          rows: [[{ address: "A1", row: 1, column: 1, value: "Apples" }]],
        },
      ],
    } as SpreadsheetPreview;
    expect(hasPendingFormulaResults(preview, true)).toBe(false);
    expect(hasPendingFormulaResults(null, true)).toBe(false);
  });
});

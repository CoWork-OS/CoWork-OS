import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getCellDisplayText, SpreadsheetArtifactViewer } from "../SpreadsheetArtifactViewer";

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
});

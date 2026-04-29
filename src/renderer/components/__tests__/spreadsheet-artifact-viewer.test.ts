import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SpreadsheetArtifactViewer } from "../SpreadsheetArtifactViewer";

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
});

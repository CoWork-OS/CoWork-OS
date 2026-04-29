import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PresentationArtifactViewer } from "../PresentationArtifactViewer";
import { PresentationViewer } from "../PresentationViewer";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("PresentationArtifactViewer", () => {
  it("shows the presentation filename only in the header", () => {
    const markup = render(
      React.createElement(PresentationArtifactViewer, {
        filePath: "/workspace/sample.pptx",
        workspacePath: "/workspace",
        mode: "sidebar",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
      }),
    );

    expect(markup.match(/sample\.pptx/g)?.length).toBe(1);
    expect(markup).toContain("Open presentation in full screen");
  });

  it("renders fullscreen turn context collapsed by default", () => {
    const markup = render(
      React.createElement(PresentationArtifactViewer, {
        filePath: "/workspace/sample.pptx",
        workspacePath: "/workspace",
        mode: "fullscreen",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
        onSendMessage: async () => {},
        turnContext: {
          statusLabel: "Latest turn",
          summary: "Created the sample deck.",
          artifactPath: "/workspace/sample.pptx",
          artifactName: "sample.pptx",
        },
      }),
    );

    expect(markup).toContain("spreadsheet-viewer-turn-frame collapsed");
    expect(markup).toContain("Latest turn");
    expect(markup).not.toContain("Created the sample deck.");
  });

  it("renders review controls before a PPTX preview is loaded", () => {
    const markup = render(
      React.createElement(PresentationArtifactViewer, {
        filePath: "/workspace/sample.pptx",
        workspacePath: "/workspace",
        mode: "sidebar",
        onClose: () => {},
        onFullscreen: () => {},
        onExitFullscreen: () => {},
      }),
    );

    expect(markup).toContain("PPTX");
    expect(markup).toContain("Copy");
    expect(markup).toContain("Folder");
  });

  it("renders text preview while slide images are still rendering", () => {
    const markup = render(
      React.createElement(PresentationViewer, {
        fileName: "sample.pptx",
        preview: {
          slideCount: 1,
          renderStatus: "rendering",
          renderMessage: "Rendering slide previews...",
          slides: [{ index: 1, title: "Intro", text: "Opening slide" }],
        },
        onOpenExternal: () => {},
        onShowInFinder: () => {},
      }),
    );

    expect(markup).toContain("Rendering previews");
    expect(markup).toContain("Opening slide");
    expect(markup).toContain("Rendering slide previews...");
  });

  it("uses tokenized image URLs when rendered slide images are available", () => {
    const markup = render(
      React.createElement(PresentationViewer, {
        fileName: "sample.pptx",
        preview: {
          slideCount: 1,
          renderStatus: "rendered",
          slides: [
            {
              index: 1,
              title: "Intro",
              text: "Opening slide",
              imageUrl: "media://local/slide-token",
            },
          ],
        },
        onOpenExternal: () => {},
        onShowInFinder: () => {},
      }),
    );

    expect(markup).toContain("media://local/slide-token");
    expect(markup).toContain("1 rendered");
  });
});

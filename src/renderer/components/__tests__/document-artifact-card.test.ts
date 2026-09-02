import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DocumentArtifactCard } from "../DocumentArtifactCard";

const cssPath = fileURLToPath(new URL("../MainContent/main-content.css", import.meta.url));
const artifactCss = readFileSync(cssPath, "utf8");

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("DocumentArtifactCard", () => {
  it("renders a compact Codex-style document output card", () => {
    const markup = render(
      React.createElement(DocumentArtifactCard, {
        filePath: "/workspace/artifacts/sample_report.docx",
        workspacePath: "/workspace",
        onOpenViewer: () => {},
      }),
    );

    expect(markup).toContain("document-artifact-card");
    expect(markup).toContain("sample_report.docx");
    expect(markup).toContain("Document · DOCX");
    expect(markup).toContain("Open");
    expect(markup).toContain("document-artifact-menu-btn");
    expect(markup).not.toContain('role="menu"');
  });

  it("labels common Word-style formats", () => {
    const cases = [
      ["/workspace/report.doc", "Document · DOC"],
      ["/workspace/notes.rtf", "Document · RTF"],
      ["/workspace/memo.odt", "Document · ODT"],
      ["/workspace/proposal.pages", "Document · Pages"],
      ["/workspace/channels.md", "Document · MD"],
    ] as const;

    for (const [filePath, label] of cases) {
      const markup = render(
        React.createElement(DocumentArtifactCard, {
          filePath,
          workspacePath: "/workspace",
          onOpenViewer: () => {},
        }),
      );
      expect(markup).toContain(label);
    }
  });

  it("keeps a safe ink gutter for every artifact label glyph", () => {
    expect(artifactCss).toMatch(
      /\.spreadsheet-artifact-name,\s*\.spreadsheet-artifact-meta,\s*\.document-artifact-name,\s*\.document-artifact-meta,\s*\.presentation-artifact-name,\s*\.presentation-artifact-meta,\s*\.web-artifact-name,\s*\.web-artifact-meta\s*\{[\s\S]*margin-left:\s*-4px;[\s\S]*padding-left:\s*4px;/,
    );
  });
});

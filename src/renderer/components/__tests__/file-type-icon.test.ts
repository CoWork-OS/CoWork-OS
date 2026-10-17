import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DocumentArtifactCard } from "../DocumentArtifactCard";
import { getDocumentIconKind } from "../FileTypeIcon";
import { PresentationArtifactCard } from "../PresentationArtifactCard";
import { SpreadsheetArtifactCard } from "../SpreadsheetArtifactCard";
import { WebArtifactCard } from "../WebArtifactCard";

function iconTile(markup: string, tileClass: string): string {
  const match = markup.match(new RegExp(`<div class="${tileClass}[^"]*"[^>]*>([\\s\\S]*?)</div>`));
  return match?.[0] ?? "";
}

describe("FileTypeIcon", () => {
  it("tells Markdown apart from word-processor documents", () => {
    expect(getDocumentIconKind("/w/tests.md")).toBe("markdown");
    expect(getDocumentIconKind("/w/NOTES.MARKDOWN")).toBe("markdown");
    expect(getDocumentIconKind("/w/readme", "markdown")).toBe("markdown");
    expect(getDocumentIconKind("/w/report.docx")).toBe("document");
  });

  it("draws the Markdown mark on a slate tile instead of a letter", () => {
    const tile = iconTile(
      renderToStaticMarkup(React.createElement(DocumentArtifactCard, { filePath: "/w/tests.md" })),
      "document-artifact-icon",
    );
    expect(tile).toContain('class="document-artifact-icon is-markdown"');
    expect(tile).toContain("file-type-icon-markdown");
    expect(tile).not.toMatch(/<span>[A-Z]<\/span>/);
  });

  it("uses glyphs, not Office letters, for every artifact card", () => {
    const cards = [
      [DocumentArtifactCard, "/w/report.docx", "document-artifact-icon", "lucide-file-text"],
      [SpreadsheetArtifactCard, "/w/data.xlsx", "spreadsheet-artifact-icon", "lucide-sheet"],
      [
        PresentationArtifactCard,
        "/w/deck.pptx",
        "presentation-artifact-icon",
        "lucide-presentation",
      ],
      [WebArtifactCard, "/w/page.html", "web-artifact-icon", "lucide-globe"],
    ] as const;
    for (const [Card, filePath, tileClass, glyphClass] of cards) {
      const tile = iconTile(
        renderToStaticMarkup(
          React.createElement(Card as React.FC<{ filePath: string }>, { filePath }),
        ),
        tileClass,
      );
      expect(tile).toContain(glyphClass);
      expect(tile).not.toMatch(/<span>[A-Z]<\/span>/);
    }
  });
});

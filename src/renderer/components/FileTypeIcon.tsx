import { FileText, Globe, Presentation, Sheet } from "lucide-react";

import { getDocumentFileExtension } from "../../shared/document-formats";

/**
 * The glyph inside an artifact card's or viewer tab's colored tile. Glyphs instead of
 * letters, so a Markdown file no longer reads as a Word "W"-style tile and a web page
 * no longer shows Word's "W".
 */
export type FileTypeIconKind = "markdown" | "document" | "spreadsheet" | "presentation" | "web";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

/** Document cards and the document viewer cover both Markdown and word-processor files. */
export function getDocumentIconKind(filePath: string, fileType?: string): FileTypeIconKind {
  if (fileType === "markdown") return "markdown";
  return MARKDOWN_EXTENSIONS.has(getDocumentFileExtension(filePath)) ? "markdown" : "document";
}

// The Markdown mark (public domain): an "M" and a down arrow in a rounded frame.
function MarkdownMark() {
  return (
    <svg
      className="file-type-icon file-type-icon-markdown"
      viewBox="0 0 208 128"
      aria-hidden="true"
    >
      <rect
        x="5"
        y="5"
        width="198"
        height="118"
        rx="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
      />
      <path
        fill="currentColor"
        d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0-30-33h20V30h20v35h20z"
      />
    </svg>
  );
}

export function FileTypeIcon({ kind }: { kind: FileTypeIconKind }) {
  if (kind === "markdown") return <MarkdownMark />;
  const Glyph =
    kind === "spreadsheet"
      ? Sheet
      : kind === "presentation"
        ? Presentation
        : kind === "web"
          ? Globe
          : FileText;
  return <Glyph className="file-type-icon" strokeWidth={1.9} aria-hidden="true" />;
}

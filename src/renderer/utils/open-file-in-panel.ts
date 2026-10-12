import {
  getInlinePreviewKindForGeneratedFile,
  type GeneratedInlinePreviewKind,
} from "../components/MainContent/artifact-logic";
import { canPreviewWebPageInApp } from "../../shared/web-page-formats";
import { canOpenSpreadsheetInApp } from "../../shared/spreadsheet-formats";
import { canPreviewDocumentInApp } from "../../shared/document-formats";
import { canPreviewPresentationInApp } from "../../shared/presentation-formats";

export type ArtifactOpeners = Partial<Record<GeneratedInlinePreviewKind, (path: string) => void>>;

/** The side-panel viewer kind that can open this file in CoWork, if any. */
export function getSidePanelViewerKind(filePath: string): GeneratedInlinePreviewKind | null {
  const kind = getInlinePreviewKindForGeneratedFile({ path: filePath });
  switch (kind) {
    case "html":
      return canPreviewWebPageInApp(filePath) ? kind : null;
    case "spreadsheet":
      return canOpenSpreadsheetInApp(filePath) ? kind : null;
    case "document":
      return canPreviewDocumentInApp(filePath) ? kind : null;
    case "presentation":
      return canPreviewPresentationInApp(filePath) ? kind : null;
    default:
      return null;
  }
}

/**
 * Opens a file inside CoWork: documents, spreadsheets, decks and web pages go to their
 * right-panel viewer, everything else to `fallback` (the file preview modal).
 */
export function openPreviewableFileInSidebar(
  filePath: string,
  openers: ArtifactOpeners,
  fallback: (path: string) => void,
): void {
  const kind = getSidePanelViewerKind(filePath);
  const opener = kind ? openers[kind] : undefined;
  if (opener) {
    opener(filePath);
    return;
  }
  fallback(filePath);
}

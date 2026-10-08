import {
  ATTACHMENT_CONTENT_END_MARKER,
  ATTACHMENT_CONTENT_START_MARKER,
  MAX_IMAGE_OCR_CHARS,
  buildImageAttachmentViewerOptions,
  buildPdfAttachmentContent,
  stripHtmlForText,
  truncateTextForTaskPrompt,
} from "../utils/attachment-content";
import type { ImageAttachment } from "../../../shared/types";

export type SelectedFileInfo = {
  path?: string;
  name: string;
  size: number;
  mimeType?: string;
  /** Preview image (data URL) rendered by the OS file picker, when available. */
  thumbnailDataUrl?: string;
};

export type PendingAttachment = SelectedFileInfo & {
  id: string;
  dataBase64?: string;
  draftRefId?: string;
  draftSha256?: string;
  status?: "available" | "unavailable";
};

export type ImportedAttachment = {
  relativePath: string;
  fileName: string;
  size: number;
  mimeType?: string;
};

export const formatFileSize = (size: number): string => {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};

export const composeMessageWithAttachments = async (
  workspacePath: string | undefined,
  text: string,
  attachments: ImportedAttachment[],
): Promise<{ message: string; extractionWarnings: string[] }> => {
  const extractedByPath: Record<string, string> = {};
  const extractionWarnings: string[] = [];

  if (workspacePath && attachments.length > 0) {
    for (const attachment of attachments) {
      try {
        const options = buildImageAttachmentViewerOptions(text, attachment.fileName);
        const result = await window.electronAPI.readFileForViewer(
          attachment.relativePath,
          workspacePath,
          {
            ...options,
            imageOcrMaxChars: MAX_IMAGE_OCR_CHARS,
          },
        );

        if (!result.success || !result.data) continue;

        const fileType = result.data.fileType;
        if (fileType === "unsupported") continue;
        if (fileType === "image" && !result.data.ocrText?.trim()) continue;

        let content: string | null = null;
        if (fileType === "image") {
          content = result.data.ocrText ?? null;
        } else if (fileType === "pdf" && result.data.pdfReviewSummary) {
          content = buildPdfAttachmentContent({
            fileName: attachment.fileName,
            relativePath: attachment.relativePath,
            summary: result.data.pdfReviewSummary,
          });
        } else {
          content = result.data.content;
        }
        if (!content && result.data.htmlContent) {
          content = stripHtmlForText(result.data.htmlContent);
        }
        if ((!content || !content.trim()) && result.data.ocrText?.trim()) {
          content = result.data.ocrText;
        }
        if (!content?.trim()) continue;

        extractedByPath[attachment.relativePath] = truncateTextForTaskPrompt(content);
      } catch {
        extractionWarnings.push(attachment.fileName);
      }
    }
  }

  const base = text.trim() || "Please review the attached files.";
  const attachmentSummaryLines = attachments.map((attachment) => {
    const lines = [`- ${attachment.fileName} (${attachment.relativePath})`];
    const extracted = extractedByPath[attachment.relativePath];
    if (extracted) {
      lines.push("  Extracted content:");
      lines.push(`  ${ATTACHMENT_CONTENT_START_MARKER}`);
      for (const row of extracted.split("\n")) {
        lines.push(`    ${row}`);
      }
      lines.push(`  ${ATTACHMENT_CONTENT_END_MARKER}`);
    }
    return lines.join("\n");
  });

  const summary =
    attachmentSummaryLines.length === 0
      ? ""
      : `Attached files (relative to workspace):\n${attachmentSummaryLines.join("\n\n")}`;
  return {
    message: summary ? `${base}\n\n${summary}` : base,
    extractionWarnings,
  };
};

const VISUAL_ATTACHMENT_MIME_SET = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

export const guessVisualAttachmentMimeType = (
  fileName: string,
  mimeType?: string,
): string | undefined => {
  if (mimeType && VISUAL_ATTACHMENT_MIME_SET.has(mimeType)) return mimeType;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  return undefined;
};

export const isVideoVisualAttachmentMimeType = (mimeType: string | undefined): boolean =>
  Boolean(mimeType && mimeType.startsWith("video/"));

export const joinWorkspaceRelativePath = (workspacePath: string, relativePath: string): string =>
  `${workspacePath.replace(/[\\/]+$/, "")}/${relativePath.replace(/^[\\/]+/, "")}`;

/**
 * Imports pending attachments into a workspace and turns them into what a new
 * task needs: the prompt with attachment content appended, plus native visual
 * attachments for images and video. Used by composers outside MainContent.
 */
export const prepareTaskAttachments = async (
  workspace: { id: string; path: string },
  text: string,
  pending: PendingAttachment[],
): Promise<{ message: string; images?: ImageAttachment[]; extractionWarnings: string[] }> => {
  if (pending.length === 0) return { message: text, extractionWarnings: [] };
  const imported: ImportedAttachment[] = [];
  const pathFiles = pending.filter((attachment) => attachment.path && !attachment.dataBase64);
  const dataFiles = pending.filter((attachment) => attachment.dataBase64);
  if (pathFiles.length > 0) {
    imported.push(
      ...(await window.electronAPI.importFilesToWorkspace({
        workspaceId: workspace.id,
        files: pathFiles.map((attachment) => attachment.path as string),
      })),
    );
  }
  if (dataFiles.length > 0) {
    imported.push(
      ...(await window.electronAPI.importDataToWorkspace({
        workspaceId: workspace.id,
        files: dataFiles.map((attachment) => ({
          name: attachment.name,
          data: attachment.dataBase64 as string,
          mimeType: attachment.mimeType,
        })),
      })),
    );
  }

  const images = imported.flatMap((attachment): ImageAttachment[] => {
    const mimeType = guessVisualAttachmentMimeType(attachment.fileName, attachment.mimeType);
    if (!mimeType) return [];
    return [
      {
        filePath: joinWorkspaceRelativePath(workspace.path, attachment.relativePath),
        mimeType: mimeType as ImageAttachment["mimeType"],
        filename: attachment.fileName,
        sizeBytes: attachment.size,
      },
    ];
  });
  const textAttachments = imported.filter(
    (attachment) =>
      !isVideoVisualAttachmentMimeType(
        guessVisualAttachmentMimeType(attachment.fileName, attachment.mimeType),
      ),
  );
  const { message, extractionWarnings } = await composeMessageWithAttachments(
    workspace.path,
    text,
    textAttachments,
  );
  return { message, images: images.length > 0 ? images : undefined, extractionWarnings };
};

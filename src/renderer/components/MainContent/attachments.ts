import {
  ATTACHMENT_CONTENT_END_MARKER,
  ATTACHMENT_CONTENT_START_MARKER,
  MAX_IMAGE_OCR_CHARS,
  buildImageAttachmentViewerOptions,
  buildPdfAttachmentContent,
  stripHtmlForText,
  truncateTextForTaskPrompt,
} from "../utils/attachment-content";

export type SelectedFileInfo = {
  path?: string;
  name: string;
  size: number;
  mimeType?: string;
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

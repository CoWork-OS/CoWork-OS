import type { VisualAttachmentMimeType } from "../../shared/types";
import { relativePathForWorkspace } from "./browser-file-bridge";

export interface BrowserVisualAttachment {
  relativePath: string;
  mimeType: VisualAttachmentMimeType;
  filename?: string;
  sizeBytes: number;
}

/** Translate the shared composer's imported files without sending host paths. */
export function browserVisualAttachments(
  images: unknown,
  workspacePath: string,
): BrowserVisualAttachment[] {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images) || images.length > 5) {
    throw new Error("Attach up to five visual files per message.");
  }
  let totalBytes = 0;
  return images.map((image) => {
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new Error("Invalid visual attachment.");
    }
    const input = image as Record<string, unknown>;
    const allowed = new Set(["filePath", "mimeType", "filename", "sizeBytes"]);
    const relativePath = relativePathForWorkspace(input.filePath, workspacePath);
    if (
      Object.keys(input).some((key) => !allowed.has(key)) ||
      !relativePath ||
      ![
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "video/mp4",
        "video/quicktime",
        "video/webm",
      ].includes(String(input.mimeType)) ||
      typeof input.sizeBytes !== "number" ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > (String(input.mimeType).startsWith("image/") ? 25 : 64) * 1024 * 1024 ||
      (input.filename !== undefined &&
        (typeof input.filename !== "string" ||
          input.filename.length > 255 ||
          /[\0-\x1f\x7f/\\]/.test(input.filename)))
    ) {
      throw new Error("Visual attachments must be imported into the selected workspace.");
    }
    totalBytes += input.sizeBytes;
    if (totalBytes > 128 * 1024 * 1024)
      throw new Error("Visual attachments exceed 128 MiB per message.");
    return {
      relativePath,
      mimeType: input.mimeType as VisualAttachmentMimeType,
      sizeBytes: input.sizeBytes,
      ...(input.filename !== undefined ? { filename: input.filename as string } : {}),
    };
  });
}

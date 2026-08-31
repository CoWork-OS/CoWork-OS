import type { ImageAttachment, VisualAttachmentMimeType } from "./types";

export type UserMessageAttachmentMetadata = Pick<
  ImageAttachment,
  "filePath" | "mimeType" | "filename" | "sizeBytes"
>;

const VISUAL_ATTACHMENT_MIME_TYPES = new Set<VisualAttachmentMimeType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVisualAttachmentMimeType(value: unknown): value is VisualAttachmentMimeType {
  return (
    typeof value === "string" && VISUAL_ATTACHMENT_MIME_TYPES.has(value as VisualAttachmentMimeType)
  );
}

/**
 * Keep only the non-binary fields needed to render a sent-message attachment.
 * Base64 data is intentionally excluded so timeline events stay small and do
 * not retain the image bytes in the task database.
 */
export function buildUserMessageAttachmentMetadata(
  images?: ImageAttachment[] | null,
): UserMessageAttachmentMetadata[] {
  if (!Array.isArray(images)) return [];

  return images.flatMap((image) => {
    if (!image || !isVisualAttachmentMimeType(image.mimeType)) return [];

    return [
      {
        ...(typeof image.filePath === "string" && image.filePath.trim().length > 0
          ? { filePath: image.filePath }
          : {}),
        mimeType: image.mimeType,
        ...(typeof image.filename === "string" && image.filename.trim().length > 0
          ? { filename: image.filename }
          : {}),
        sizeBytes: image.sizeBytes,
      },
    ];
  });
}

/** Parse attachment metadata carried by a persisted or remote task event. */
export function parseUserMessageAttachmentMetadata(
  value: unknown,
): UserMessageAttachmentMetadata[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isVisualAttachmentMimeType(entry.mimeType)) return [];

    const sizeBytes = entry.sizeBytes;
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      return [];
    }

    const filePath = typeof entry.filePath === "string" ? entry.filePath.trim() : "";
    const filename = typeof entry.filename === "string" ? entry.filename.trim() : "";

    return [
      {
        ...(filePath ? { filePath } : {}),
        mimeType: entry.mimeType,
        ...(filename ? { filename } : {}),
        sizeBytes,
      },
    ];
  });
}

export function isImageAttachmentMimeType(
  mimeType: VisualAttachmentMimeType | string | undefined,
): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

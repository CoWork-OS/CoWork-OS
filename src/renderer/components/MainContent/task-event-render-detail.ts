import { TaskEvent } from "../../../shared/types";
import {
  isImageAttachmentMimeType,
  type UserMessageAttachmentMetadata,
} from "../../../shared/user-message-attachments";

export function getTruncatedTaskEventDetailId(event: TaskEvent): string | null {
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
  if (!payload || payload.__coworkPayloadTruncated !== true) return null;
  if (typeof payload.eventDetailId === "string" && payload.eventDetailId.trim().length > 0) {
    return payload.eventDetailId.trim();
  }
  if (typeof payload.eventId === "string" && payload.eventId.trim().length > 0) {
    return payload.eventId.trim();
  }
  return event.eventId || event.id;
}

export const getAttachmentNamesWithoutImagePreviews = (
  names: string[],
  attachments: UserMessageAttachmentMetadata[],
): string[] => {
  const imageNames = new Set(
    attachments
      .filter((attachment) => isImageAttachmentMimeType(attachment.mimeType))
      .map((attachment) => attachment.filename)
      .filter((filename): filename is string => Boolean(filename)),
  );
  return names.filter((name) => !imageNames.has(name));
};

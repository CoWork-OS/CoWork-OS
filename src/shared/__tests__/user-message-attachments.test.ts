import { describe, expect, it } from "vitest";
import {
  buildUserMessageAttachmentMetadata,
  isImageAttachmentMimeType,
  parseUserMessageAttachmentMetadata,
} from "../user-message-attachments";

describe("user message attachment metadata", () => {
  it("keeps renderable metadata without retaining base64 image data", () => {
    expect(
      buildUserMessageAttachmentMetadata([
        {
          data: "a-large-base64-payload",
          mimeType: "image/png",
          filename: "screen.png",
          sizeBytes: 2048,
        },
        {
          filePath: "/workspace/reference.jpg",
          mimeType: "image/jpeg",
          filename: "reference.jpg",
          sizeBytes: 4096,
        },
      ]),
    ).toEqual([
      {
        mimeType: "image/png",
        filename: "screen.png",
        sizeBytes: 2048,
      },
      {
        filePath: "/workspace/reference.jpg",
        mimeType: "image/jpeg",
        filename: "reference.jpg",
        sizeBytes: 4096,
      },
    ]);
  });

  it("parses only valid persisted visual attachment records", () => {
    expect(
      parseUserMessageAttachmentMetadata([
        {
          filePath: " /workspace/screen.png ",
          mimeType: "image/png",
          filename: " screen.png ",
          sizeBytes: 100,
        },
        { mimeType: "image/jpeg", filename: "missing-size.jpg", sizeBytes: 0 },
        { mimeType: "text/plain", filename: "notes.txt", sizeBytes: 100 },
        null,
      ]),
    ).toEqual([
      {
        filePath: "/workspace/screen.png",
        mimeType: "image/png",
        filename: "screen.png",
        sizeBytes: 100,
      },
    ]);
  });

  it("identifies image MIME types while leaving videos out of the image gallery", () => {
    expect(isImageAttachmentMimeType("image/webp")).toBe(true);
    expect(isImageAttachmentMimeType("video/mp4")).toBe(false);
    expect(isImageAttachmentMimeType(undefined)).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor image attachment routing", () => {
  it("emits a user-facing switch-model message when the active provider cannot accept images", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.provider = { type: "gemini" };
    executor.emitEvent = vi.fn();

    const result = await executor.buildUserContent("What is in this image?", [
      {
        data: "AA==",
        mimeType: "image/png",
        filename: "image.png",
        sizeBytes: 2,
      },
    ]);

    expect(result).toBe(
      "I can't analyze attached images with the current model. Switch to an image-capable model/provider and resend the image.",
    );
    expect(executor.emitEvent).toHaveBeenCalledWith("assistant_message", {
      message:
        "I can't analyze attached images with the current model. Switch to an image-capable model/provider and resend the image.",
    });
  });

  it("turns mp4 video attachments into video notes plus extracted image frames", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.provider = { type: "openai" };
    executor.emitEvent = vi.fn();
    executor.buildVideoAttachmentContent = vi.fn().mockResolvedValue({
      note: 'Video attachment "clip.mp4" is available at /tmp/clip.mp4. I extracted 1 representative frame.',
      images: [
        {
          type: "image",
          data: "AA==",
          mimeType: "image/jpeg",
          originalSizeBytes: 2,
        },
      ],
    });

    const result = await executor.buildUserContent("What happens in this clip?", [
      {
        filePath: "/tmp/clip.mp4",
        mimeType: "video/mp4",
        filename: "clip.mp4",
        sizeBytes: 1024,
      },
    ]);

    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Video processing notes:"),
    });
    expect(result[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Do not inspect the original video with shell"),
    });
    expect(result[1]).toMatchObject({
      type: "image",
      data: "AA==",
      mimeType: "image/jpeg",
      originalSizeBytes: 2,
    });
  });

  it("routes quicktime mov attachments through video frame extraction", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.provider = { type: "openai" };
    executor.emitEvent = vi.fn();
    executor.buildVideoAttachmentContent = vi.fn().mockResolvedValue({
      note: 'Video attachment "clip.mov" is available at /tmp/clip.mov. I extracted 1 representative frame.',
      images: [
        {
          type: "image",
          data: "AA==",
          mimeType: "image/jpeg",
          originalSizeBytes: 2,
        },
      ],
    });

    const result = await executor.buildUserContent("What happens in this clip?", [
      {
        filePath: "/tmp/clip.mov",
        mimeType: "video/quicktime",
        filename: "clip.mov",
        sizeBytes: 1024,
      },
    ]);

    expect(Array.isArray(result)).toBe(true);
    expect(executor.buildVideoAttachmentContent).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "/tmp/clip.mov",
        mimeType: "video/quicktime",
      }),
    );
  });

  it("emits extracted video preview frames as workspace image artifacts", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.workspace = { path: "/workspace" };
    executor.emitEvent = vi.fn();

    const video = {
      filePath: "/workspace/.cowork/uploads/clip.mp4",
      mimeType: "video/mp4",
      filename: "clip.mp4",
      sizeBytes: 1024,
      videoContactSheetPath: "/workspace/.cowork/video-frames/clip/contact_sheet.jpg",
      videoFramePaths: ["/workspace/.cowork/video-frames/clip/frame_001.jpg"],
    };

    executor.emitVideoPreviewArtifacts(video, "clip.mp4");
    executor.emitVideoPreviewArtifacts(video, "clip.mp4");

    expect(executor.emitEvent).toHaveBeenCalledTimes(2);
    expect(executor.emitEvent).toHaveBeenNthCalledWith(1, "artifact_created", {
      path: ".cowork/video-frames/clip/contact_sheet.jpg",
      mimeType: "image/jpeg",
      type: "image",
      label: "Video contact sheet: clip.mp4",
      source: "video_attachment",
    });
    expect(executor.emitEvent).toHaveBeenNthCalledWith(2, "artifact_created", {
      path: ".cowork/video-frames/clip/frame_001.jpg",
      mimeType: "image/jpeg",
      type: "image",
      label: "Video representative frame: clip.mp4",
      source: "video_attachment",
    });
  });
});

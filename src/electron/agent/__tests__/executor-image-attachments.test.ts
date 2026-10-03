import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { QueuedAttachmentStore } from "../runtime/queued-attachment-store";

describe("TaskExecutor image attachment routing", () => {
  it("loads a queued durable image through the executor after a receipt-only restart", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-executor-attachments-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const persisted = store.persist("task-1", "message-1", [
        { data: "aGVsbG8=", mimeType: "image/png", filename: "hello.png", sizeBytes: 5 },
      ]);
      const executor = Object.create(TaskExecutor.prototype) as Any;
      executor.provider = { type: "openai" };
      executor.emitEvent = vi.fn();

      const result = await executor.buildUserContent("Inspect this image", persisted.images);

      expect(result).toEqual([
        { type: "text", text: "Inspect this image" },
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
          originalSizeBytes: 5,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores original visual input as an attributed historical provider turn", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-executor-original-media-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const persisted = store.persist("task-1", "__task_initial_media__", [
        { data: "aGVsbG8=", mimeType: "image/png", filename: "chart.png", sizeBytes: 5 },
      ]);
      const executor = Object.create(TaskExecutor.prototype) as Any;
      executor.provider = { type: "openai" };
      executor.emitEvent = vi.fn();
      executor.ensureProviderFailoverSelectionsContext = vi.fn();
      executor.conversationHistory = [
        { role: "user", content: "Original task prompt" },
        { role: "assistant", content: "Prior answer" },
        { role: "user", content: "Current follow-up" },
      ];
      executor.updateConversationHistory = vi.fn((history: Any[]) => {
        executor.conversationHistory = history;
      });
      const priorConversation = executor.conversationHistory.slice();

      await executor.restoreInitialMediaContext("Original task prompt", persisted.images);

      expect(executor.conversationHistory.slice(0, 3)).toEqual(priorConversation);
      expect(executor.conversationHistory).toHaveLength(4);
      expect(executor.conversationHistory[3]).toEqual({
        role: "user",
        content: [
          {
            type: "text",
            text: "Original task request and visual attachments (provided at task creation):\nOriginal task prompt",
          },
          {
            type: "image",
            data: "aGVsbG8=",
            mimeType: "image/png",
            originalSizeBytes: 5,
          },
        ],
      });

      // A snapshot replaces image bytes with a text marker; recreate only the
      // attributed restoration turn without changing the surrounding history.
      executor.conversationHistory[3] = {
        role: "user",
        content: [
          {
            type: "text",
            text: "Original task request and visual attachments (provided at task creation):\nOriginal task prompt",
          },
          { type: "text", text: "[Image was attached: image/png, 0KB]" },
        ],
      };
      await executor.restoreInitialMediaContext("Original task prompt", persisted.images);

      expect(executor.conversationHistory).toHaveLength(4);
      expect(executor.conversationHistory.slice(0, 3)).toEqual(priorConversation);
      expect(executor.conversationHistory[3].content).toEqual([
        {
          type: "text",
          text: "Original task request and visual attachments (provided at task creation):\nOriginal task prompt",
        },
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
          originalSizeBytes: 5,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rehydrates media on an accepted follow-up turn without adding another user turn", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-executor-follow-up-media-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const persisted = store.persist("task-1", "accepted-follow-up", [
        { data: "aGVsbG8=", mimeType: "image/png", filename: "chart.png", sizeBytes: 5 },
      ]);
      const executor = Object.create(TaskExecutor.prototype) as Any;
      executor.provider = { type: "openai" };
      executor.task = { id: "task-1" };
      executor.emitEvent = vi.fn();
      executor.conversationHistory = [
        { role: "user", content: "Earlier request" },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'QUOTED ASSISTANT MESSAGE (the user explicitly quoted this earlier assistant reply and is responding to it):\n"""\nEarlier chart context\n"""\n\nUSER UPDATE: Compare these charts',
            },
            { type: "text", text: "[Image was attached: image/png, 0KB]" },
          ],
        },
      ];
      executor.updateConversationHistory = vi.fn((history: Any[]) => {
        executor.conversationHistory = history;
      });
      executor.saveConversationSnapshot = vi.fn(() => true);

      await (TaskExecutor.prototype as Any).restorePersistedFollowUpMediaContext.call(
        executor,
        "Compare these charts",
        persisted.images,
        { eventId: "assistant-7", message: "Earlier chart context" },
      );

      expect(executor.conversationHistory).toHaveLength(2);
      expect(executor.conversationHistory[0]).toEqual({ role: "user", content: "Earlier request" });
      expect(executor.conversationHistory[1].content).toEqual([
        {
          type: "text",
          text: 'QUOTED ASSISTANT MESSAGE (the user explicitly quoted this earlier assistant reply and is responding to it):\n"""\nEarlier chart context\n"""\n\nCompare these charts',
        },
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
          originalSizeBytes: 5,
        },
      ]);
      expect(executor.saveConversationSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replace a historical message that only starts with the media attribution", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "cowork-executor-original-media-prefix-"));
    try {
      const store = new QueuedAttachmentStore(path.join(root, "store"));
      const persisted = store.persist("task-1", "__task_initial_media__", [
        { data: "aGVsbG8=", mimeType: "image/png", filename: "chart.png", sizeBytes: 5 },
      ]);
      const unrelatedHistoricalMessage =
        "Original task request and visual attachments (provided at task creation):\n" +
        "Original task prompt\nA continuation supplied later by the user";
      const executor = Object.create(TaskExecutor.prototype) as Any;
      executor.provider = { type: "openai" };
      executor.emitEvent = vi.fn();
      executor.ensureProviderFailoverSelectionsContext = vi.fn();
      executor.conversationHistory = [
        { role: "user", content: unrelatedHistoricalMessage },
        { role: "assistant", content: "Prior answer" },
      ];
      executor.updateConversationHistory = vi.fn((history: Any[]) => {
        executor.conversationHistory = history;
      });

      await executor.restoreInitialMediaContext("Original task prompt", persisted.images);

      expect(executor.conversationHistory[0]).toEqual({
        role: "user",
        content: unrelatedHistoricalMessage,
      });
      expect(executor.conversationHistory[1]).toEqual({
        role: "assistant",
        content: "Prior answer",
      });
      expect(executor.conversationHistory[2]).toMatchObject({
        role: "user",
        content: [
          {
            type: "text",
            text: "Original task request and visual attachments (provided at task creation):\nOriginal task prompt",
          },
          { type: "image", mimeType: "image/png" },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a user-facing switch-model message when the active provider cannot accept images", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.provider = { type: "groq" };
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

import { describe, expect, it } from "vitest";

import { ToolBatchExecutor } from "../tool-batch-executor";

describe("ToolBatchExecutor", () => {
  it("appends tool results in order and normalizes malformed transcript leftovers", () => {
    const executor = new ToolBatchExecutor();
    const messages = [
      {
        role: "assistant" as const,
        content: [
          { type: "tool_use" as const, id: "tool-1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ];

    executor.appendOrderedToolResults(messages, [
      { type: "tool_result" as const, tool_use_id: "tool-1", content: "done" },
      { type: "tool_result" as const, tool_use_id: "orphan", content: "stale" },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
      },
    ]);
  });

  it("appends the latest companion user content after tool results", () => {
    const executor = new ToolBatchExecutor();
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "tool-1", name: "screenshot", input: {} }],
      },
    ];

    executor.appendOrderedToolResults(messages, [
      {
        type: "tool_result" as const,
        tool_use_id: "tool-1",
        content: '{"ok":true,"captureId":"cap_1","imageAttached":true}',
        companion_user_content: [
          { type: "text" as const, text: "Latest screenshot." },
          { type: "image" as const, data: "ZmFrZQ==", mimeType: "image/png" as const },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "screenshot", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: '{"ok":true,"captureId":"cap_1","imageAttached":true}',
            companion_user_content: [
              { type: "text", text: "Latest screenshot." },
              { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
            ],
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Latest screenshot." },
          { type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
        ],
      },
    ]);
  });
});

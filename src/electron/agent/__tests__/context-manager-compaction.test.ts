import { describe, it, expect } from "vitest";
import { ContextManager } from "../context-manager";
import type { LLMMessage } from "../llm";

describe("ContextManager.compactMessagesWithMeta", () => {
  it("returns kind=none when within limits", () => {
    const cm = new ContextManager("gpt-3.5-turbo");
    const messages: LLMMessage[] = [
      { role: "user", content: "short task context" },
      { role: "assistant", content: "short response" },
    ];

    const res = cm.compactMessagesWithMeta(messages, 0);
    expect(res.meta.kind).toBe("none");
    expect(res.meta.removedMessages.didRemove).toBe(false);
    expect(res.meta.removedMessages.messages).toEqual([]);
    expect(res.messages).toEqual(messages);
  });

  it("keeps pinned messages and reports removed messages", () => {
    const cm = new ContextManager("gpt-3.5-turbo");
    const pinned: LLMMessage = {
      role: "user",
      content: "<cowork_memory_recall>\n- pinned\n</cowork_memory_recall>",
    };

    const messages: LLMMessage[] = [{ role: "user", content: "task context" }, pinned];

    // Force compaction by exceeding the available token estimate.
    for (let i = 0; i < 40; i++) {
      messages.push({
        role: i % 2 === 0 ? "assistant" : "user",
        content: "x".repeat(2000),
      });
    }

    const res = cm.compactMessagesWithMeta(messages, 0);
    expect(res.meta.kind).toBe("message_removal");
    expect(res.meta.removedMessages.didRemove).toBe(true);
    expect(res.meta.removedMessages.count).toBeGreaterThan(0);
    expect(res.meta.removedMessages.messages.length).toBe(res.meta.removedMessages.count);

    // Pinned recall must be retained.
    expect(
      res.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("<cowork_memory_recall>"),
      ),
    ).toBe(true);

    // Removed messages should never include pinned blocks.
    expect(
      res.meta.removedMessages.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("<cowork_memory_recall>"),
      ),
    ).toBe(false);

    // First message (task/step context) is always retained.
    expect(res.messages[0]?.role).toBe("user");
    expect(res.messages[0]?.content).toBe("task context");
  });

  it("does not keep a user tool_result without its preceding assistant tool_use turn", () => {
    const cm = new ContextManager("gpt-3.5-turbo");
    const messages: LLMMessage[] = [
      { role: "user", content: "task context" },
      { role: "assistant", content: "older context " + "x".repeat(600) },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "read_file", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "y".repeat(320) }],
      },
    ];

    const targetTokens = 100;
    const result = (cm as Any).removeOlderMessagesWithMeta(messages, targetTokens);
    const compacted = result.messages as LLMMessage[];

    for (let i = 0; i < compacted.length; i++) {
      const current = compacted[i];
      if (!Array.isArray(current.content)) continue;
      const hasToolResult = current.content.some((block: Any) => block?.type === "tool_result");
      if (!hasToolResult) continue;

      const previous = i > 0 ? compacted[i - 1] : null;
      const previousHasToolUse =
        previous?.role === "assistant" &&
        Array.isArray(previous.content) &&
        previous.content.some((block: Any) => block?.type === "tool_use");
      expect(previousHasToolUse).toBe(true);
    }
  });
});

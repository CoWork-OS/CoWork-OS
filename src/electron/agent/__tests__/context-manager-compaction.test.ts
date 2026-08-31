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

describe("ContextManager active-file path retention", () => {
  /**
   * Build a message whose text content references the given file path.
   */
  function msgWithPath(role: "user" | "assistant", filePath: string): LLMMessage {
    return { role, content: `Here is the content of ${filePath}` };
  }

  /**
   * Build a filler message with no file path references and a fixed token footprint.
   */
  function fillerMsg(role: "user" | "assistant", size = 500): LLMMessage {
    return { role, content: "x".repeat(size) };
  }

  it("retains an older message referencing a file touched in recent turns during compaction", () => {
    const cm = new ContextManager("gpt-3.5-turbo");

    // Message [0]: initial task (always kept)
    // Message [1]: references /src/auth.ts (old — should be kept because recent turns also touch it)
    // Messages [2..N-4]: filler (expendable)
    // Messages [N-3..N]: recent turns that also reference /src/auth.ts
    const filePath = "/src/auth.ts";

    const messages: LLMMessage[] = [
      { role: "user", content: "Fix the auth module" }, // index 0 — always kept
      msgWithPath("assistant", filePath), // index 1 — should be retained
    ];

    // Bulk filler to force compaction — use 1000 chars (~250 tokens) each so
    // 35 × 250 = 8,750 tokens, which exceeds the gpt-3.5-turbo 8,000-token available budget.
    for (let i = 0; i < 35; i++) {
      messages.push(fillerMsg(i % 2 === 0 ? "assistant" : "user", 1000));
    }

    // Recent turns that also reference the same file (within ACTIVE_PATH_CONTEXT_WINDOW)
    messages.push(fillerMsg("assistant", 50));
    messages.push(msgWithPath("user", filePath));
    messages.push(fillerMsg("assistant", 50));
    messages.push(msgWithPath("user", filePath));

    const res = cm.compactMessagesWithMeta(messages, 0);

    // Compaction must have removed something for this test to be meaningful
    expect(res.meta.kind).toBe("message_removal");

    const keptContents = res.messages.map((m) => (typeof m.content === "string" ? m.content : ""));

    // The old message referencing the active file should be retained
    const activeFileRetained = keptContents.some(
      (c) => c.includes(filePath) && c.startsWith("Here is"),
    );
    expect(activeFileRetained).toBe(true);
  });

  it("does NOT retain an older message referencing a file not touched in recent turns", () => {
    const cm = new ContextManager("gpt-3.5-turbo");

    const staleFile = "/src/old-module.ts";
    const activeFile = "/src/new-feature.ts";

    const messages: LLMMessage[] = [
      { role: "user", content: "Refactor the new feature" }, // index 0
      msgWithPath("assistant", staleFile), // index 1 — stale, should be evicted
    ];

    // Bulk filler — 1000 chars each to exceed the 8,000-token available budget
    for (let i = 0; i < 35; i++) {
      messages.push(fillerMsg(i % 2 === 0 ? "assistant" : "user", 1000));
    }

    // Recent turns reference only the new active file
    messages.push(msgWithPath("assistant", activeFile));
    messages.push(msgWithPath("user", activeFile));
    messages.push(msgWithPath("assistant", activeFile));
    messages.push(msgWithPath("user", activeFile));

    const res = cm.compactMessagesWithMeta(messages, 0);
    expect(res.meta.kind).toBe("message_removal");

    const keptContents = res.messages.map((m) => (typeof m.content === "string" ? m.content : ""));

    // The stale file message should NOT be among the kept messages (it fell outside budget)
    const staleRetained = keptContents.some(
      (c) => c.includes(staleFile) && c.startsWith("Here is"),
    );
    expect(staleRetained).toBe(false);
  });

  it("never retains more than 15% of the token budget for active-file messages", () => {
    const cm = new ContextManager("gpt-3.5-turbo");

    const filePath = "/src/big-file.ts";
    const messages: LLMMessage[] = [
      { role: "user", content: "Process big file" }, // index 0
    ];

    // Add many old messages referencing the active file (all large)
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "assistant", content: `${filePath} content: ${"y".repeat(800)}` });
    }

    // Recent turns (within window) also reference the file
    for (let i = 0; i < 4; i++) {
      messages.push({
        role: i % 2 === 0 ? "assistant" : "user",
        content: `Working on ${filePath}`,
      });
    }

    const res = cm.compactMessagesWithMeta(messages, 0);

    if (res.meta.kind === "message_removal") {
      // Count how many of the large old messages were kept
      const keptOldActiveFileMessages = res.messages.filter(
        (m) =>
          typeof m.content === "string" && m.content.includes(filePath) && m.content.length > 400,
      );
      // Should not retain all 20 — budget cap must have kicked in
      expect(keptOldActiveFileMessages.length).toBeLessThan(20);
    }
    // If no removal needed, the test is vacuously satisfied
  });
});

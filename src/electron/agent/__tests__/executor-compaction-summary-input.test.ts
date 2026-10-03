import { describe, expect, it, vi } from "vitest";

import { ContextManager } from "../context-manager";
import { TaskExecutor } from "../executor";
import type { LLMMessage } from "../llm";

function createSummaryExecutor(): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1", agentConfig: {} };
  executor.modelId = "claude-sonnet-4-5";
  executor.contextManager = new ContextManager("claude-sonnet-4-5");
  executor.updateTracking = vi.fn();
  executor.createMessageWithTimeout = vi.fn(async () => ({
    content: [{ type: "text", text: "Primary Request and Intent: migrate the build." }],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  executor.callLLMWithRetry = vi.fn(async (requestFn: Any) => requestFn(0));
  return executor;
}

// Far more dropped transcript than the summarizer input cap holds.
function buildLongDroppedSpan(): { removed: LLMMessage[]; correction: string } {
  const removed: LLMMessage[] = [
    { role: "user", content: "Original request: migrate the build to pnpm" },
  ];
  for (let index = 0; index < 120; index++) {
    removed.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `t${index}`,
          name: "read_file",
          input: { path: `src/f${index}.ts` },
        },
      ],
    });
    removed.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `t${index}`,
          content: `file ${index} ${"x".repeat(1900)}`,
        },
      ],
    });
  }
  const correction = `Correction: keep npm for the docs site.${" Reason given in detail.".repeat(250)}`;
  removed.push({ role: "user", content: correction });
  removed.push({
    role: "assistant",
    content: "Decision: the build stays on npm until the lockfile is fixed.",
  });
  return { removed, correction };
}

describe("compaction summary input", () => {
  it("sends the newest dropped work and the latest user wording to the summarizer", async () => {
    const executor = createSummaryExecutor();
    const { removed, correction } = buildLongDroppedSpan();

    await executor.buildCompactionSummaryBlock({
      removedMessages: removed,
      maxOutputTokens: 2000,
      contextLabel: "step:1",
      previousSummary: "Current State: halfway through the lockfile migration.",
    });

    const prompt = String(executor.createMessageWithTimeout.mock.calls[0][0].messages[0].content);
    expect(prompt).toContain("Original request: migrate the build to pnpm");
    expect(prompt).toContain("Decision: the build stays on npm until the lockfile is fixed.");
    expect(prompt).toContain(correction);
    expect(prompt).toContain("Current State: halfway through the lockfile migration.");
    expect(prompt.length).toBeLessThan(140_000);
  });

  it("keeps the newest dropped work in the deterministic fallback", async () => {
    const executor = createSummaryExecutor();
    executor.callLLMWithRetry = vi.fn(async () => {
      throw new Error("summarizer unavailable");
    });
    const { removed } = buildLongDroppedSpan();

    const block = await executor.buildCompactionSummaryBlock({
      removedMessages: removed,
      maxOutputTokens: 2000,
      contextLabel: "step:1",
    });

    expect(block).toContain("Dropped context (raw, truncated):");
    expect(block).toContain("Decision: the build stays on npm until the lockfile is fixed.");
  });
});

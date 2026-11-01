import { describe, expect, it, vi } from "vitest";

import { ContextManager } from "../context-manager";
import { TaskExecutor } from "../executor";
import type { LLMMessage } from "../llm";
import { omittedCharsNotice, SPILL_HANDLE_INDEX_HEADER } from "../tool-result-spill";

function createSummaryExecutor(summary: string): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1", agentConfig: {} };
  executor.modelId = "claude-sonnet-4-5";
  executor.contextManager = new ContextManager("claude-sonnet-4-5");
  executor.updateTracking = vi.fn();
  executor.createMessageWithTimeout = vi.fn(async () => ({
    content: [{ type: "text", text: summary }],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  executor.callLLMWithRetry = vi.fn(async (requestFn: Any) => requestFn(0));
  return executor;
}

const HANDLE = "sp00000000beef.0";

function removedWithSpilledResult(): LLMMessage[] {
  const stdout =
    `${"build step ok\n".repeat(400)}\n` +
    omittedCharsNotice(90_000, { handle: HANDLE, offset: 5_600 }) +
    `\n${"test passed\n".repeat(400)}`;
  return [
    { role: "user", content: "Run the full test suite." },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu-1", name: "run_command", input: { command: "npm test" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: JSON.stringify({ exitCode: 0, stdout }),
        },
      ],
    },
  ];
}

describe("compaction keeps spill handles", () => {
  it("indexes the handles of removed results even when the summarizer drops them", async () => {
    const executor = createSummaryExecutor("Primary Request and Intent: run the tests.");
    const block = await executor.buildCompactionSummaryBlock({
      removedMessages: removedWithSpilledResult(),
      maxOutputTokens: 2000,
      contextLabel: "step:1",
    });

    expect(block).toContain(SPILL_HANDLE_INDEX_HEADER);
    expect(block).toContain(`tool_result_read(handle="${HANDLE}", offset=5600) (run_command)`);
    expect(block).toContain("Primary Request and Intent: run the tests.");

    // The summarizer sees the handle although the clamp cut the marker out of the result.
    const prompt = String(executor.createMessageWithTimeout.mock.calls[0][0].messages[0].content);
    expect(prompt).toContain(`tool_result_read(handle="${HANDLE}", offset=5600)`);
    expect(prompt).toContain("Copy any tool_result_read");
  });

  it("carries the handles of an earlier summary into the next one", async () => {
    const executor = createSummaryExecutor("Current State: tests pass.");
    const first = await executor.buildCompactionSummaryBlock({
      removedMessages: removedWithSpilledResult(),
      maxOutputTokens: 2000,
      contextLabel: "step:1",
    });
    const second = await executor.buildCompactionSummaryBlock({
      removedMessages: [{ role: "assistant", content: "Moving on to the docs." }],
      maxOutputTokens: 2000,
      contextLabel: "step:2",
      previousSummary: first,
    });

    expect(second).toContain(`tool_result_read(handle="${HANDLE}", offset=5600)`);
    expect(second.split(SPILL_HANDLE_INDEX_HEADER)).toHaveLength(2);
  });

  it("keeps the index in the deterministic fallback", async () => {
    const executor = createSummaryExecutor("unused");
    executor.callLLMWithRetry = vi.fn(async () => {
      throw new Error("summarizer unavailable");
    });
    const block = await executor.buildCompactionSummaryBlock({
      removedMessages: removedWithSpilledResult(),
      maxOutputTokens: 2000,
      contextLabel: "step:1",
    });
    expect(block).toContain(`tool_result_read(handle="${HANDLE}", offset=5600)`);
    expect(block).toContain("Dropped context (raw, truncated):");
  });
});

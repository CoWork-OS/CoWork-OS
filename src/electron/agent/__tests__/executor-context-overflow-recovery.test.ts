import { describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";
import { ContextCapacityExhaustedError, SessionRuntime } from "../runtime/SessionRuntime";

function makeExecutor(): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1" };
  executor.workspace = { id: "workspace-1", path: "/tmp" };
  executor.contextManager = {
    proactiveCompactWithMeta: vi.fn((messages: Any[]) => ({
      messages: messages.slice(1),
      meta: {
        removedMessages: {
          didRemove: true,
          count: Math.max(0, messages.length - 1),
          messages: messages.slice(0, 1),
          tokensAfter: 1,
        },
        kind: "message_removal",
      },
    })),
    compactMessagesWithMeta: vi.fn((messages: Any[]) => ({
      messages,
      meta: {
        removedMessages: { didRemove: false, count: 0, messages: [], tokensAfter: 1 },
        kind: "none",
      },
    })),
  };
  executor.pruneStaleToolErrors = vi.fn();
  executor.consolidateConsecutiveUserMessages = vi.fn();
  executor.emitEvent = vi.fn();
  executor.getSessionRuntime = vi.fn(
    () =>
      new SessionRuntime(
        {
          emitEvent: executor.emitEvent,
          getContextManager: () => executor.contextManager,
          getTask: () => executor.task,
          getWorkspace: () => executor.workspace,
          buildCompactionSummaryBlock: vi.fn(async () => "compaction summary"),
          extractPinnedBlockContent: vi.fn((summary: string) => summary),
          pruneStaleToolErrors: executor.pruneStaleToolErrors,
          consolidateConsecutiveUserMessages: executor.consolidateConsecutiveUserMessages,
        } as Any,
        { transcript: { conversationHistory: [] } } as Any,
      ),
  );
  return executor;
}

describe("TaskExecutor context-overflow recovery", () => {
  it("recovers from a context-capacity error by compacting and retrying", async () => {
    const executor = makeExecutor();
    const messages: Any[] = [
      { role: "user", content: [{ type: "text", text: "A".repeat(4000) }] },
      { role: "assistant", content: [{ type: "text", text: "B".repeat(4000) }] },
    ];
    const result = await (executor as Any).recoverFromContextCapacityOverflow({
      error: new Error("Context length exceeded for this model"),
      messages,
      systemPromptTokens: 0,
      phase: "step",
      stepId: "step-1",
      attempt: 0,
      maxAttempts: 2,
    });

    expect(result.recovered).toBe(true);
    expect(result.exhausted).toBe(false);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect((executor as Any).contextManager.proactiveCompactWithMeta).toHaveBeenCalledTimes(1);
    expect((executor as Any).emitEvent).toHaveBeenCalledWith(
      "context_capacity_recovery_started",
      expect.objectContaining({ phase: "step", stepId: "step-1", attempt: 1, maxAttempts: 2 }),
    );
    expect((executor as Any).emitEvent).toHaveBeenCalledWith(
      "context_capacity_recovery_completed",
      expect.objectContaining({ phase: "step", stepId: "step-1", attempt: 1, maxAttempts: 2 }),
    );
  });

  it("returns exhausted after repeated context overflow beyond retry cap", async () => {
    const executor = makeExecutor();
    const messages: Any[] = [{ role: "user", content: [{ type: "text", text: "A".repeat(4000) }] }];
    const result = await (executor as Any).recoverFromContextCapacityOverflow({
      error: new Error("Input too long: maximum context window reached"),
      messages,
      systemPromptTokens: 0,
      phase: "follow_up",
      attempt: 2,
      maxAttempts: 2,
    });

    expect(result.recovered).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.messages).toBe(messages);
    expect((executor as Any).emitEvent).toHaveBeenCalledWith(
      "context_capacity_recovery_failed",
      expect.objectContaining({
        phase: "follow_up",
        attempt: 3,
        maxAttempts: 2,
        reason: "retries_exhausted",
      }),
    );
  });

  it("classifies hard retained-context exhaustion as terminal budget failure", () => {
    const executor = makeExecutor();
    const error = new ContextCapacityExhaustedError({
      phase: "step",
      contextLabel: "step:context-overflow",
      availableTokens: 100,
      tokensBefore: 240,
      tokensAfter: 220,
    });

    expect((executor as Any).isContextCapacityExhaustedError(error)).toBe(true);
    expect((executor as Any).isBudgetExhaustionError(error)).toBe(true);
    expect((executor as Any).shouldFinalizeAsPartialSuccess(error)).toBe(false);
    expect(
      (executor as Any).isContextCapacityExhaustedError({
        code: error.code,
        message: error.message,
      }),
    ).toBe(true);
  });

  it("does not report recovery when compaction cannot shrink the request", async () => {
    const executor = makeExecutor();
    executor.contextManager.proactiveCompactWithMeta = vi.fn((messages: Any[]) => ({
      messages,
      meta: {
        removedMessages: { didRemove: false, count: 0, messages: [], tokensAfter: 1 },
        truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 1 },
        kind: "none",
      },
    }));
    const messages: Any[] = [
      { role: "user", content: [{ type: "text", text: "A".repeat(4000) }] },
      { role: "assistant", content: [{ type: "text", text: "B".repeat(4000) }] },
    ];

    const result = await (executor as Any).recoverFromContextCapacityOverflow({
      error: new Error("Context length exceeded for this model"),
      messages,
      systemPromptTokens: 0,
      phase: "step",
      stepId: "step-1",
      attempt: 0,
      maxAttempts: 3,
    });

    // Retrying the identical request would only hit the same overflow again.
    expect(result.recovered).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.messages).toBe(messages);
    expect((executor as Any).emitEvent).toHaveBeenCalledWith(
      "context_capacity_recovery_failed",
      expect.objectContaining({ phase: "step", reason: "no_reduction_possible" }),
    );
  });

  it("tightens the compaction target until something can be removed", async () => {
    const executor = makeExecutor();
    const ratios: number[] = [];
    executor.contextManager.proactiveCompactWithMeta = vi.fn(
      (messages: Any[], _systemPromptTokens: number, ratio: number) => {
        ratios.push(ratio);
        const remove = ratio < 0.2;
        return {
          messages: remove ? messages.slice(1) : messages,
          meta: {
            removedMessages: {
              didRemove: remove,
              count: remove ? 1 : 0,
              messages: remove ? messages.slice(0, 1) : [],
              tokensAfter: 1,
            },
            truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 1 },
            kind: remove ? "message_removal" : "none",
          },
        };
      },
    );
    const messages: Any[] = [
      { role: "user", content: [{ type: "text", text: "A".repeat(4000) }] },
      { role: "assistant", content: [{ type: "text", text: "B".repeat(4000) }] },
    ];

    const result = await (executor as Any).recoverFromContextCapacityOverflow({
      error: new Error("Context length exceeded for this model"),
      messages,
      systemPromptTokens: 0,
      phase: "follow_up",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(result.recovered).toBe(true);
    expect(ratios[0]).toBeCloseTo(0.35);
    expect(ratios[ratios.length - 1]).toBeLessThan(0.2);
  });

  it("sizes the first target from the token counts the provider reports", async () => {
    const executor = makeExecutor();
    executor.contextManager.getAvailableTokens = vi.fn(() => 188_000);
    const ratios: number[] = [];
    executor.contextManager.proactiveCompactWithMeta = vi.fn(
      (messages: Any[], _systemPromptTokens: number, ratio: number) => {
        ratios.push(ratio);
        return {
          messages: messages.slice(1),
          meta: {
            removedMessages: {
              didRemove: true,
              count: 1,
              messages: messages.slice(0, 1),
              tokensAfter: 1,
            },
            truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 1 },
            kind: "message_removal",
          },
        };
      },
    );
    // About 20K estimated tokens, while the provider counts 10K more than it allows.
    const messages: Any[] = [
      { role: "user", content: [{ type: "text", text: "A".repeat(40_000) }] },
      { role: "assistant", content: [{ type: "text", text: "B".repeat(40_000) }] },
    ];

    await (executor as Any).recoverFromContextCapacityOverflow({
      error: new Error(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
      ),
      messages,
      systemPromptTokens: 0,
      phase: "step",
      attempt: 0,
      maxAttempts: 3,
    });

    expect(ratios[0]).toBeLessThan(0.1);
  });

  it("tags exhausted follow-up recovery with the terminal context code", () => {
    const executor = makeExecutor();
    const error = (executor as Any).createContextCapacityRecoveryExhaustedError(
      "Context capacity recovery exhausted during follow-up processing.",
    );

    expect(error).toMatchObject({ code: "CONTEXT_CAPACITY_RECOVERY_EXHAUSTED" });
    expect((executor as Any).isContextCapacityExhaustedError(error)).toBe(true);
    expect((executor as Any).classifyFailure(error)).toBe("budget_exhausted");
  });
});

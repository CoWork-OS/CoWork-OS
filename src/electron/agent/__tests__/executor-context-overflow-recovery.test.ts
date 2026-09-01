import { describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";
import { SessionRuntime } from "../runtime/SessionRuntime";

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
          pruneStaleToolErrors: executor.pruneStaleToolErrors,
          consolidateConsecutiveUserMessages: executor.consolidateConsecutiveUserMessages,
        } as Any,
        {} as Any,
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
});

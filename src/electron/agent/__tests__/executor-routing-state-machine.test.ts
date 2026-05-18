import { describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";
import type { TaskStrategySnapshot } from "../strategy/TaskStrategySnapshot";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

function createExecutorWithSnapshot(snapshot?: Partial<TaskStrategySnapshot>) {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-1",
    title: "Task",
    prompt: snapshot ? "Task prompt" : "Task prompt\nanswer_first=true",
    agentConfig: snapshot
      ? {
          taskStrategySnapshot: {
            taskIntent: "mixed",
            conversationMode: "hybrid",
            executionMode: "execute",
            taskDomain: "code",
            directResponseMode: "none",
            preflightGates: [],
            workflowMode: "none",
            confidence: 0.8,
            overrides: [],
            ...snapshot,
          } satisfies TaskStrategySnapshot,
        }
      : {},
  };
  return executor;
}

describe("TaskExecutor routing state machine gates", () => {
  it("uses terminal quick-answer snapshots for answer-first LLM calls", () => {
    const executor = createExecutorWithSnapshot({
      directResponseMode: "terminal_quick_answer",
      executionMode: "plan",
    });

    expect((executor as Any).shouldEmitAnswerFirst()).toBe(true);
  });

  it("skips separate quick-answer LLM for answer-then-execute snapshots", () => {
    const executor = createExecutorWithSnapshot({
      directResponseMode: "brief_status_then_execute",
      executionMode: "execute",
    });

    expect((executor as Any).shouldEmitAnswerFirst()).toBe(false);
  });

  it("uses explicit preflight snapshot gates when present", () => {
    const withoutPreflight = createExecutorWithSnapshot({
      directResponseMode: "brief_status_then_execute",
      preflightGates: [],
    });
    const withPreflight = createExecutorWithSnapshot({
      directResponseMode: "none",
      preflightGates: ["preflight_framing"],
    });

    expect((withoutPreflight as Any).shouldEmitPreflight()).toBe(false);
    expect((withPreflight as Any).shouldEmitPreflight()).toBe(true);
  });

  it("falls back to legacy answer_first prompt marker when no snapshot exists", () => {
    const executor = createExecutorWithSnapshot();

    expect((executor as Any).shouldEmitAnswerFirst()).toBe(true);
  });
});

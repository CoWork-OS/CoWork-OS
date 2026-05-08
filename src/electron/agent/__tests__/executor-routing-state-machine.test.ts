import { describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";
import type { IntentRoute } from "../strategy/IntentRouter";
import { TaskStrategyService } from "../strategy/TaskStrategyService";
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

function makeRoute(overrides: Partial<IntentRoute> = {}): IntentRoute {
  return {
    intent: "execution",
    confidence: 0.8,
    conversationMode: "task",
    answerFirst: false,
    signals: [],
    complexity: "low",
    domain: "code",
    ...overrides,
  };
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

describe("agent loop routing matrix", () => {
  const cases: Array<{
    name: string;
    route: IntentRoute;
    title: string;
    prompt: string;
    expected: Partial<TaskStrategySnapshot>;
  }> = [
    {
      name: "simple chat",
      route: makeRoute({ intent: "chat", conversationMode: "chat", domain: "general" }),
      title: "Quick check-in",
      prompt: "Hey, how are you?",
      expected: { taskIntent: "chat", directResponseMode: "companion", workflowMode: "none" },
    },
    {
      name: "thinking-only prompt",
      route: makeRoute({ intent: "thinking", conversationMode: "think", answerFirst: true, domain: "general" }),
      title: "Think through tradeoffs",
      prompt: "Think deeply about whether I should use SQLite or Postgres here.",
      expected: { taskIntent: "thinking", directResponseMode: "companion", workflowMode: "none" },
    },
    {
      name: "advice prompt",
      route: makeRoute({ intent: "advice", conversationMode: "hybrid", answerFirst: true, domain: "general" }),
      title: "Advice",
      prompt: "Should I use pnpm or npm for this repo?",
      expected: {
        taskIntent: "advice",
        executionMode: "plan",
        directResponseMode: "terminal_quick_answer",
      },
    },
    {
      name: "mixed answer then execute",
      route: makeRoute({ intent: "mixed", conversationMode: "hybrid", answerFirst: true, signals: ["path-or-command"] }),
      title: "Explain then fix",
      prompt: "Briefly explain the likely bug, then edit src/app.ts to fix it.",
      expected: {
        taskIntent: "mixed",
        executionMode: "execute",
        directResponseMode: "brief_status_then_execute",
      },
    },
    {
      name: "workflow task",
      route: makeRoute({ intent: "workflow", conversationMode: "task", complexity: "high", domain: "code" }),
      title: "Launch workflow",
      prompt: "Run a multi-phase workflow to research, implement, test, and summarize the feature.",
      expected: { taskIntent: "workflow", executionMode: "execute", workflowMode: "workflow" },
    },
    {
      name: "simple image generation",
      route: makeRoute({ intent: "execution", domain: "creative", signals: ["image-creation-intent"] }),
      title: "Create image",
      prompt: "Create an image of a snow leopard wearing a small backpack.",
      expected: { taskIntent: "execution", executionMode: "execute", taskDomain: "creative" },
    },
    {
      name: "document artifact task",
      route: makeRoute({ intent: "execution", domain: "document", signals: ["artifact-creation-intent"] }),
      title: "Create PDF",
      prompt: "Create a PDF report from the attached notes and save it in the workspace.",
      expected: { taskIntent: "execution", executionMode: "execute", taskDomain: "document" },
    },
    {
      name: "code execution task",
      route: makeRoute({ intent: "execution", domain: "code" }),
      title: "Fix tests",
      prompt: "Run the tests, fix the failing TypeScript code, and verify the result.",
      expected: { taskIntent: "execution", executionMode: "execute", taskDomain: "code" },
    },
  ];

  it.each(cases)("$name derives the expected canonical strategy", ({ route, title, prompt, expected }) => {
    const strategy = TaskStrategyService.derive(route, undefined, { title, prompt });

    expect(strategy.snapshot).toMatchObject(expected);
  });
});

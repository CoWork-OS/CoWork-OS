import { describe, expect, it } from "vitest";
import type { IntentRoute } from "../IntentRouter";
import { TaskStrategyService } from "../TaskStrategyService";

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

describe("TaskStrategySnapshot", () => {
  it("classifies chat and thinking as companion direct responses", () => {
    const chat = TaskStrategyService.derive(makeRoute({ intent: "chat", conversationMode: "chat" }));
    const thinking = TaskStrategyService.derive(
      makeRoute({ intent: "thinking", conversationMode: "think", answerFirst: true }),
    );

    expect(chat.snapshot).toMatchObject({
      taskIntent: "chat",
      conversationMode: "chat",
      directResponseMode: "companion",
      workflowMode: "none",
    });
    expect(thinking.snapshot).toMatchObject({
      taskIntent: "thinking",
      conversationMode: "think",
      directResponseMode: "companion",
      workflowMode: "none",
    });
  });

  it("distinguishes terminal quick answers from answer-then-execute work", () => {
    const advice = TaskStrategyService.derive(makeRoute({ intent: "advice", answerFirst: true }));
    const mixedExecute = TaskStrategyService.derive(
      makeRoute({ intent: "mixed", answerFirst: true, signals: ["path-or-command"] }),
    );

    expect(advice.snapshot.directResponseMode).toBe("terminal_quick_answer");
    expect(mixedExecute.snapshot.directResponseMode).toBe("brief_status_then_execute");
  });

  it("records workflow mode and preflight gates", () => {
    const workflow = TaskStrategyService.derive(
      makeRoute({ intent: "workflow", complexity: "high", confidence: 0.92 }),
    );

    expect(workflow.snapshot).toMatchObject({
      taskIntent: "workflow",
      workflowMode: "workflow",
      preflightGates: ["preflight_framing"],
      confidence: 0.92,
    });
  });

  it("persists the snapshot onto agent config", () => {
    const strategy = TaskStrategyService.derive(makeRoute({ intent: "planning", answerFirst: true }));
    const config = TaskStrategyService.applyToAgentConfig({}, strategy) as Any;

    expect(config.taskStrategySnapshot).toEqual(strategy.snapshot);
    expect(config.taskStrategySnapshot.directResponseMode).toBe("terminal_quick_answer");
  });
});

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

describe("TaskStrategyService deriveLlmProfile", () => {
  it("returns strong for planning intent", () => {
    const strategy = TaskStrategyService.derive(makeRoute({ intent: "planning" }));
    expect(strategy.llmProfileHint).toBe("strong");
  });

  it("returns strong for verification tasks regardless of confidence", () => {
    const profile = TaskStrategyService.deriveLlmProfile(
      { executionMode: "execute", preflightRequired: false },
      { intent: "execution", isVerificationTask: true },
    );
    expect(profile).toBe("strong");
  });

  it("returns cheap for routine execution tasks", () => {
    const strategy = TaskStrategyService.derive(makeRoute({ intent: "execution" }));
    expect(strategy.llmProfileHint).toBe("cheap");
  });

  it("returns strong for strict artifact-length execution tasks", () => {
    const strategy = TaskStrategyService.derive(
      makeRoute({ intent: "execution" }),
      undefined,
      {
        title: "Create DOCX",
        prompt:
          "Create an exact 1000 characters long word document (.docx) and verify the final character count.",
      },
    );
    expect(strategy.llmProfileHint).toBe("strong");
  });
});

describe("TaskStrategyService getRelevantToolSet", () => {
  it("keeps request_user_input available for advice/planning intents", () => {
    const planning = TaskStrategyService.getRelevantToolSet("planning");
    const advice = TaskStrategyService.getRelevantToolSet("advice");
    expect(planning.has("request_user_input")).toBe(true);
    expect(advice.has("request_user_input")).toBe(true);
  });
});

describe("TaskStrategyService applyToAgentConfig", () => {
  it("adds llmProfileHint when no explicit model override exists", () => {
    const strategy = TaskStrategyService.derive(makeRoute({ intent: "planning" }));
    const config = TaskStrategyService.applyToAgentConfig({}, strategy);
    expect(config.llmProfileHint).toBe("strong");
  });

  it("does not keep llmProfileHint when explicit model override is present", () => {
    const strategy = TaskStrategyService.derive(makeRoute({ intent: "planning" }));
    const config = TaskStrategyService.applyToAgentConfig({ modelKey: "gpt-4o" }, strategy);
    expect(config.llmProfileHint).toBeUndefined();
  });

  it("downshifts stale execute mode for advice intent", () => {
    const route = makeRoute({ intent: "advice" });
    const strategy = TaskStrategyService.derive(route, { executionMode: "execute" });
    expect(strategy.executionMode).toBe("plan");

    const config = TaskStrategyService.applyToAgentConfig({ executionMode: "execute" }, strategy);
    expect(config.executionMode).toBe("plan");
  });

  it("downshifts stale execute mode for chat intent", () => {
    const route = makeRoute({ intent: "chat" });
    const strategy = TaskStrategyService.derive(route, { executionMode: "execute" });
    expect(strategy.executionMode).toBe("chat");

    const config = TaskStrategyService.applyToAgentConfig({ executionMode: "execute" }, strategy);
    expect(config.executionMode).toBe("chat");
  });

  it("preserves explicit non-execute override for execution intent", () => {
    const route = makeRoute({ intent: "execution" });
    const strategy = TaskStrategyService.derive(route, { executionMode: "plan" });
    expect(strategy.executionMode).toBe("plan");

    const config = TaskStrategyService.applyToAgentConfig({ executionMode: "plan" }, strategy);
    expect(config.executionMode).toBe("plan");
    expect(config.executionModeSource).toBe("user");
  });

  it("keeps mixed intent in plan mode without hard execution signals", () => {
    const route = makeRoute({
      intent: "mixed",
      signals: ["strategy-language", "planning-language", "action-verb"],
    });
    const strategy = TaskStrategyService.derive(route);
    expect(strategy.executionMode).toBe("plan");
  });

  it("allows mixed intent to execute with hard execution signals", () => {
    const route = makeRoute({
      intent: "mixed",
      signals: ["action-verb", "execution-target", "path-or-command"],
    });
    const strategy = TaskStrategyService.derive(route);
    expect(strategy.executionMode).toBe("execute");
  });

  it("allows mixed intent to execute with shell troubleshooting signals", () => {
    const route = makeRoute({
      intent: "mixed",
      signals: ["planning-language", "shell-troubleshooting", "terminal-transcript"],
      domain: "operations",
    });
    const strategy = TaskStrategyService.derive(route);
    expect(strategy.executionMode).toBe("execute");
  });

  it("forces mixed intent into execute mode with artifact creation signal", () => {
    const route = makeRoute({
      intent: "mixed",
      signals: ["planning-language", "action-verb"],
    });
    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Website build",
      prompt: "Make an interactive website with timeline controls and ship the project files.",
    });
    expect(strategy.executionMode).toBe("execute");
  });

  it("promotes mixed intent maxTurns to 60 with concrete execution signals", () => {
    const route = makeRoute({
      intent: "mixed",
      complexity: "medium",
      signals: ["action-verb", "path-or-command"],
    });

    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Apply quick fix",
      prompt: "Open src/main.ts and update the config.",
    });

    expect(strategy.maxTurns).toBe(60);
  });

  it("promotes high-complexity workflow-like mixed prompts to 80 turns", () => {
    const route = makeRoute({
      intent: "mixed",
      complexity: "high",
      signals: ["planning-language", "action-verb"],
    });

    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Ship release patch",
      prompt:
        "Run tests, then update configuration, and then deploy the worker. Finally summarize the rollout.",
    });

    expect(strategy.maxTurns).toBe(80);
  });

  it("marks strategy-derived execution mode source when no override is provided", () => {
    const route = makeRoute({ intent: "execution" });
    const strategy = TaskStrategyService.derive(route);
    const config = TaskStrategyService.applyToAgentConfig({}, strategy);
    expect(config.executionMode).toBe("execute");
    expect(config.executionModeSource).toBe("strategy");
  });

  it("defaults execution tasks to adaptive unbounded turn policy with follow-up recovery", () => {
    const route = makeRoute({ intent: "execution" });
    const strategy = TaskStrategyService.derive(route);
    const config = TaskStrategyService.applyToAgentConfig({}, strategy);
    expect(config.turnBudgetPolicy).toBe("adaptive_unbounded");
    expect(config.followUpAutoRecovery).toBe(true);
    expect(config.workspacePathAliasPolicy).toBe("rewrite_and_retry");
    expect(config.taskPathRootPolicy).toBe("pin_and_rewrite");
    expect(config.pathDriftRetryBudget).toBe(3);
    expect(config.suppressToolDisableOnRecoverablePathDrift).toBe(true);
    expect(config.mutationCheckpointRetryBudget).toBe(1);
  });

  it("returns chat mode and no tools for chat intent", () => {
    const route = makeRoute({ intent: "chat" });
    const strategy = TaskStrategyService.derive(route);
    expect(strategy.executionMode).toBe("chat");
    expect(TaskStrategyService.getRelevantToolSet("chat").size).toBe(0);
  });

  it("forces execute mode and at least 80 turns for build+verify+render artifact prompts", () => {
    const route = makeRoute({
      intent: "mixed",
      complexity: "medium",
      signals: ["planning-language", "action-verb"],
    });

    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Build and verify widget artifact",
      prompt:
        "Build the widget project, verify it compiles, then render and show the canvas artifact preview.",
    });

    expect(strategy.executionMode).toBe("execute");
    expect(strategy.maxTurns).toBe(80);
    expect(strategy.llmProfileHint).toBe("strong");
  });

  it("forces execute mode, strong profile, and >=80 turns for build+render artifact prompts without explicit verify", () => {
    const route = makeRoute({
      intent: "execution",
      complexity: "medium",
      signals: ["action-verb"],
    });

    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Build widget and show canvas",
      prompt: "Build a macOS widget and show it in canvas.",
    });

    expect(strategy.executionMode).toBe("execute");
    expect(strategy.maxTurns).toBeGreaterThanOrEqual(80);
    expect(strategy.llmProfileHint).toBe("strong");
  });

  it("escalates llm profile from cheap to strong for low-progress mutation-heavy artifact retries", () => {
    const route = makeRoute({
      intent: "execution",
      complexity: "medium",
      signals: ["action-verb", "path-or-command"],
    });

    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Retry artifact generation",
      prompt:
        "Create and render a canvas artifact in artifacts/system-metrics-widget-preview.html and verify it updates.",
      lastProgressScore: 0.1,
    });

    expect(strategy.llmProfileHint).toBe("strong");
  });
});

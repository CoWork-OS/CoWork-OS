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

  it("keeps simple image generation to one quality pass", () => {
    const strategy = TaskStrategyService.derive(
      makeRoute({ intent: "execution", signals: ["image-creation-intent"], domain: "creative" }),
      undefined,
      {
        title: "Create image",
        prompt: "create an image of a snow leopard",
      },
    );

    expect(strategy.qualityPasses).toBe(1);
  });

  it("keeps infographic image generation to one quality pass", () => {
    const strategy = TaskStrategyService.derive(
      makeRoute({ intent: "execution", signals: ["image-creation-intent"], domain: "creative" }),
      undefined,
      {
        title: "Create infographic",
        prompt: "create an infographic image explaining snow leopards",
      },
    );

    expect(strategy.qualityPasses).toBe(1);
  });

  it("keeps app avatar image generation to one quality pass", () => {
    const strategy = TaskStrategyService.derive(
      makeRoute({ intent: "execution", signals: ["image-creation-intent"], domain: "creative" }),
      undefined,
      {
        title: "Create avatar",
        prompt: "generate an image of a cool avatar of a snow leopard for cowork os app",
      },
    );

    expect(strategy.qualityPasses).toBe(1);
  });

  it("keeps grounded infographic image generation to one quality pass", () => {
    const strategy = TaskStrategyService.derive(
      makeRoute({ intent: "execution", signals: ["image-creation-intent"], domain: "creative" }),
      undefined,
      {
        title: "Create infographic",
        prompt: "create an infographic about cowork os",
      },
    );

    expect(strategy.qualityPasses).toBe(1);
  });
});

describe("TaskStrategyService getRelevantToolSet", () => {
  it("keeps request_user_input available for advice/planning intents", () => {
    const planning = TaskStrategyService.getRelevantToolSet("planning");
    const advice = TaskStrategyService.getRelevantToolSet("advice");
    expect(planning.has("request_user_input")).toBe(true);
    expect(advice.has("request_user_input")).toBe(true);
  });

  it("keeps tool_search available for chat intent so deferred MCP tools remain discoverable", () => {
    const chat = TaskStrategyService.getRelevantToolSet("chat");
    expect(chat.has("tool_search")).toBe(true);
  });
});

describe("TaskStrategyService decoratePrompt", () => {
  it("adds checklist guidance for execution-style intents only", () => {
    const executionRoute = makeRoute({ intent: "execution" });
    const executionStrategy = TaskStrategyService.derive(executionRoute);
    const executionPrompt = TaskStrategyService.decoratePrompt(
      "Implement the feature",
      executionRoute,
      executionStrategy,
      "",
    );

    const planningRoute = makeRoute({ intent: "planning" });
    const planningStrategy = TaskStrategyService.derive(planningRoute);
    const planningPrompt = TaskStrategyService.decoratePrompt(
      "Plan the feature",
      planningRoute,
      planningStrategy,
      "",
    );

    expect(executionPrompt).toContain("checklist_contract:");
    expect(executionPrompt).toContain("task_list_create");
    expect(executionPrompt).toContain("Do not create a checklist for basic questions");
    expect(planningPrompt).not.toContain("checklist_contract:");
  });

  it("adds direct completion guidance for simple image generation", () => {
    const route = makeRoute({
      intent: "execution",
      signals: ["image-creation-intent"],
      domain: "creative",
    });
    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Create image",
      prompt: "create an image of a snow leopard",
    });
    const prompt = TaskStrategyService.decoratePrompt(
      "create an image of a snow leopard",
      route,
      strategy,
      "",
    );

    expect(prompt).toContain("image_generation_contract:");
    expect(prompt).toContain("call generate_image once");
    expect(prompt).toContain("Do not search files");
  });

  it("adds direct completion guidance for infographic image generation", () => {
    const route = makeRoute({
      intent: "execution",
      signals: ["image-creation-intent"],
      domain: "creative",
    });
    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Create infographic",
      prompt: "create an infographic image explaining snow leopards",
    });
    const prompt = TaskStrategyService.decoratePrompt(
      "create an infographic image explaining snow leopards",
      route,
      strategy,
      "",
    );

    expect(prompt).toContain("image_generation_contract:");
    expect(prompt).toContain("call generate_image once");
  });

  it("keeps direct image guidance when strategy context is already present", () => {
    const rawPrompt = 'generate an image of a cool avatar of a snow leopard for "cowork os" app';
    const decoratedPrompt = `${rawPrompt}

[AGENT_STRATEGY_CONTEXT_V1]
image_generation_contract:
- Do not run analyze_image unless explicitly requested.
[/AGENT_STRATEGY_CONTEXT_V1]`;
    const route = makeRoute({
      intent: "execution",
      signals: ["image-creation-intent"],
      domain: "creative",
    });
    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Create avatar",
      prompt: decoratedPrompt,
    });

    expect(strategy.qualityPasses).toBe(1);
    expect(strategy.autoReportEnabled).toBe(false);
  });

  it("allows bounded context gathering for grounded infographic requests", () => {
    const route = makeRoute({
      intent: "execution",
      signals: ["image-creation-intent"],
      domain: "creative",
    });
    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Create infographic",
      prompt: "create an infographic about cowork os",
    });
    const prompt = TaskStrategyService.decoratePrompt(
      "create an infographic about cowork os",
      route,
      strategy,
      "",
    );

    expect(prompt).toContain("gather only the information needed");
    expect(prompt).toContain("call generate_image once");
    expect(prompt).not.toContain("Do not search files");
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

  it("keeps execute mode for chat intent so chat-like tasks still use the task pipeline", () => {
    const route = makeRoute({ intent: "chat" });
    const strategy = TaskStrategyService.derive(route, { executionMode: "execute" });
    expect(strategy.executionMode).toBe("execute");

    const config = TaskStrategyService.applyToAgentConfig({ executionMode: "execute" }, strategy);
    expect(config.executionMode).toBe("execute");
    expect(config.executionModeSource).toBe("strategy");
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

  it("does not inject maxTurns for mixed execution signals", () => {
    const route = makeRoute({
      intent: "mixed",
      complexity: "medium",
      signals: ["action-verb", "path-or-command"],
    });

    const strategy = TaskStrategyService.derive(route, undefined, {
      title: "Apply quick fix",
      prompt: "Open src/main.ts and update the config.",
    });

    expect(strategy.maxTurns).toBeUndefined();
  });

  it("does not inject maxTurns for workflow-like mixed prompts", () => {
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

    expect(strategy.maxTurns).toBeUndefined();
  });

  it("marks strategy-derived execution mode source when no override is provided", () => {
    const route = makeRoute({ intent: "execution" });
    const strategy = TaskStrategyService.derive(route);
    const config = TaskStrategyService.applyToAgentConfig({}, strategy);
    expect(config.executionMode).toBe("execute");
    expect(config.executionModeSource).toBe("strategy");
  });

  it("leaves turn budget unset by default while keeping recovery defaults", () => {
    const route = makeRoute({ intent: "execution" });
    const strategy = TaskStrategyService.derive(route);
    const config = TaskStrategyService.applyToAgentConfig({}, strategy);
    expect(config.maxTurns).toBeUndefined();
    expect(config.turnBudgetPolicy).toBeUndefined();
    expect(config.followUpAutoRecovery).toBe(true);
    expect(config.workspacePathAliasPolicy).toBe("rewrite_and_retry");
    expect(config.taskPathRootPolicy).toBe("pin_and_rewrite");
    expect(config.pathDriftRetryBudget).toBe(3);
    expect(config.suppressToolDisableOnRecoverablePathDrift).toBe(true);
    expect(config.mutationCheckpointRetryBudget).toBe(1);
  });

  it("keeps chat intent conversationMode but leaves executionMode on execute", () => {
    const route = makeRoute({ intent: "chat" });
    const strategy = TaskStrategyService.derive(route);
    expect(strategy.conversationMode).toBe("chat");
    expect(strategy.executionMode).toBe("execute");
    expect(strategy.answerFirst).toBe(false);
  });

  it("forces execute mode for build+verify+render artifact prompts without injecting maxTurns", () => {
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
    expect(strategy.maxTurns).toBeUndefined();
    expect(strategy.llmProfileHint).toBe("strong");
  });

  it("forces execute mode and strong profile for build+render artifact prompts without explicit verify", () => {
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
    expect(strategy.maxTurns).toBeUndefined();
    expect(strategy.llmProfileHint).toBe("strong");
  });

  it("preserves explicit maxTurns and hard-window policy", () => {
    const route = makeRoute({ intent: "advice" });
    const strategy = TaskStrategyService.derive(route, {
      maxTurns: 25,
      turnBudgetPolicy: "hard_window",
    });
    const config = TaskStrategyService.applyToAgentConfig(
      { maxTurns: 25, turnBudgetPolicy: "hard_window" },
      strategy,
    );

    expect(strategy.maxTurns).toBeUndefined();
    expect(config.maxTurns).toBe(25);
    expect(config.turnBudgetPolicy).toBe("hard_window");
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

  it("applies research workflow defaults when researchWorkflow.enabled", () => {
    const route = makeRoute({ intent: "chat" });
    const strategy = TaskStrategyService.derive(route);
    const config = TaskStrategyService.applyToAgentConfig(
      {
        researchWorkflow: { enabled: true, emitSemanticProgress: true },
      },
      strategy,
    );
    expect(config.qualityPasses).toBe(3);
    expect(config.deepWorkMode).toBe(true);
    expect(config.autoReportEnabled).toBe(true);
    expect(config.progressJournalEnabled).toBe(true);
    expect(config.taskDomain).toBe("research");
    expect(config.capabilityHint).toBe("research");
    expect(config.researchWorkflow?.emitSemanticProgress).toBe(true);
    expect(config.verificationAgent).toBe(true);
  });

  it("uses strong profile for debug execution mode", () => {
    const profile = TaskStrategyService.deriveLlmProfile(
      { executionMode: "debug", preflightRequired: false },
      { intent: "execution" },
    );
    expect(profile).toBe("strong");
  });

  it("includes debug_contract when strategy execution mode is debug", () => {
    const route = makeRoute({ intent: "execution" });
    const strategy = TaskStrategyService.derive(route, { executionMode: "debug" });
    expect(strategy.executionMode).toBe("debug");
    const decorated = TaskStrategyService.decoratePrompt("Find the race", route, strategy, "");
    expect(decorated).toContain("debug_contract:");
    expect(decorated).toContain("cowork-debug");
  });
});

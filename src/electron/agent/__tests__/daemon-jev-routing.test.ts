import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMProviderFactory } from "../llm/provider-factory";
import { createConfiguredJevProvider, isJevActiveHarnessEnabled } from "../jev";
import { decideTaskStrategyWithJev } from "../jev/task-strategy-decision";

vi.mock("../llm/provider-factory", () => ({
  LLMProviderFactory: {
    loadSettings: vi.fn(),
  },
}));

vi.mock("../jev", () => ({
  createConfiguredJevProvider: vi.fn(),
  isJevActiveHarnessEnabled: vi.fn(),
}));

vi.mock("../jev/task-strategy-decision", () => ({
  decideTaskStrategyWithJev: vi.fn(),
}));

describe("AgentDaemon Jev task routing", () => {
  it("offers foreground advice tasks to Jev instead of filtering by execution intent", async () => {
    vi.mocked(LLMProviderFactory.loadSettings).mockReturnValue({
      jev: {
        enabled: true,
        harnessEnabled: true,
        toolReviewMode: "active",
        adaptiveStrategyEnabled: true,
      },
    } as Any);
    vi.mocked(isJevActiveHarnessEnabled).mockReturnValue(true);
    vi.mocked(createConfiguredJevProvider).mockReturnValue({
      provider: {} as Any,
      providerType: "openrouter",
      model: "jev-latest",
    });
    vi.mocked(decideTaskStrategyWithJev).mockResolvedValue({
      status: "selected",
      strategy: "single_agent",
      profile: "cheap",
      reason: "selected",
      model: "jev-latest",
    });

    const daemonLike = {
      agentRoleRepo: {
        findAll: vi.fn().mockReturnValue([]),
      },
    } as Any;
    const task = {
      id: "task-jev-advice",
      title: "Choose a note-taking approach",
      prompt:
        "Help decide between three fictional note-taking approaches and explain the trade-offs clearly for a small team.",
      rawPrompt:
        "Help decide between three fictional note-taking approaches and explain the trade-offs clearly for a small team.",
      source: "manual",
      parentTaskId: undefined,
      workspaceId: "workspace-1",
      agentConfig: { executionMode: "plan" },
    } as Task;
    const adviceRoute = {
      intent: "advice",
      confidence: 0.8,
      conversationMode: "hybrid",
      answerFirst: true,
      signals: ["advice-question"],
      complexity: "medium",
      domain: "general",
    } as const;

    const result = await (AgentDaemon.prototype as Any)["applyJevTaskStrategy"].call(
      daemonLike,
      task,
      adviceRoute,
    );

    expect(decideTaskStrategyWithJev).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      changed: true,
      profileSelected: true,
      status: "selected",
      strategy: "single_agent",
    });
    expect(result.task.agentConfig.llmProfileHint).toBe("cheap");
  });
});

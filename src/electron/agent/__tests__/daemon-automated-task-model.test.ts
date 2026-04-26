import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";
import { LLMProviderFactory } from "../llm/provider-factory";
import { IntentRouter } from "../strategy/IntentRouter";
import { TaskStrategyService } from "../strategy/TaskStrategyService";
import type { Task } from "../../../shared/types";

vi.mock("../llm/provider-factory", () => ({
  LLMProviderFactory: {
    loadSettings: vi.fn(),
    getProviderRoutingSettings: vi.fn(),
  },
}));

function createDaemonLike() {
  return {
    deriveTaskStrategy(params: {
      title: string;
      prompt: string;
      routingPrompt?: string;
      agentConfig?: Record<string, unknown>;
      lastProgressScore?: number;
    }) {
      const route = IntentRouter.route(params.title, params.routingPrompt ?? params.prompt);
      const strategy = TaskStrategyService.derive(route, params.agentConfig as Any, {
        title: params.title,
        prompt: params.prompt,
        lastProgressScore: params.lastProgressScore,
      });
      const agentConfig = TaskStrategyService.applyToAgentConfig(
        params.agentConfig as Any,
        strategy,
      );
      return {
        route,
        strategy,
        prompt: params.prompt,
        agentConfig,
        promptChanged: false,
        agentConfigChanged: false,
      };
    },
  };
}

function applyRuntimeTaskStrategy(daemonLike: ReturnType<typeof createDaemonLike>, task: Task) {
  return (AgentDaemon.prototype as Any).applyRuntimeTaskStrategy.call(daemonLike, task);
}

describe("AgentDaemon automated task model selection", () => {
  it("does not resume startup background system tasks", () => {
    const daemonLike = Object.create(AgentDaemon.prototype) as Any;

    expect(
      daemonLike.shouldResumeTaskOnStartup({
        title: "Routine prep: editor startup",
        source: "hook",
      }),
    ).toBe(false);
    expect(
      daemonLike.shouldResumeTaskOnStartup({
        title: "Heartbeat: System QA Twin",
        source: "api",
      }),
    ).toBe(false);
    expect(
      daemonLike.shouldResumeTaskOnStartup({
        title: "Subconscious: workspace",
        source: "subconscious",
      }),
    ).toBe(false);
    expect(
      daemonLike.shouldResumeTaskOnStartup({
        title: "User task",
        source: "manual",
      }),
    ).toBe(true);
    expect(
      daemonLike.shouldResumeTaskOnStartup({
        title: "Synthesis",
        source: "manual",
        parentTaskId: "parent-1",
        agentType: "sub",
      }),
    ).toBe(false);
    expect(
      daemonLike.shouldResumeTaskOnStartup({
        title: "Collaborative root task",
        source: "manual",
        agentConfig: { collaborativeMode: true },
      }),
    ).toBe(false);
  });

  it("forces llmProfileHint to cheap for automated tasks when profile routing and cheap model are defined", () => {
    const daemonLike = createDaemonLike();
    vi.mocked(LLMProviderFactory.loadSettings).mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o",
    } as Any);
    vi.mocked(LLMProviderFactory.getProviderRoutingSettings).mockReturnValue({
      profileRoutingEnabled: true,
      cheapModelKey: "gpt-4o-mini",
      strongModelKey: "gpt-4o",
      automatedTaskModelKey: undefined,
      preferStrongForVerification: true,
    });

    const task: Task = {
      id: "task-1",
      title: "Scheduled: Nightly sync",
      prompt: "Sync data",
      status: "queued",
      workspaceId: "ws-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: "cron",
      agentConfig: {},
    } as Task;

    const result = applyRuntimeTaskStrategy(daemonLike, task);

    expect(result.agentConfigChanged).toBe(true);
    expect(result.task.agentConfig?.llmProfileHint).toBe("cheap");
  });

  it("does not inject a default maxTurns for ordinary routed tasks", () => {
    const daemonLike = createDaemonLike();

    const result = daemonLike.deriveTaskStrategy({
      title: "Portugal tax question",
      prompt: "Check why this legal research task failed and find the root cause.",
      agentConfig: {},
    });

    expect(result.strategy.maxTurns).toBeUndefined();
    expect(result.agentConfig.maxTurns).toBeUndefined();
    expect(result.agentConfig.turnBudgetPolicy).toBeUndefined();
  });

  it("uses automatedTaskModelKey when set, bypassing cheap profile", () => {
    const daemonLike = createDaemonLike();
    vi.mocked(LLMProviderFactory.loadSettings).mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o",
    } as Any);
    vi.mocked(LLMProviderFactory.getProviderRoutingSettings).mockReturnValue({
      profileRoutingEnabled: true,
      cheapModelKey: "gpt-4o-mini",
      strongModelKey: "gpt-4o",
      automatedTaskModelKey: "gpt-4o-nano",
      preferStrongForVerification: true,
    });

    const task: Task = {
      id: "task-1b",
      title: "Scheduled: Nightly sync",
      prompt: "Sync data",
      status: "queued",
      workspaceId: "ws-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: "cron",
      agentConfig: {},
    } as Task;

    const result = applyRuntimeTaskStrategy(daemonLike, task);

    expect(result.agentConfigChanged).toBe(true);
    expect(result.task.agentConfig?.modelKey).toBe("gpt-4o-nano");
    expect(result.task.agentConfig?.llmProfileHint).toBeUndefined();
  });

  it("does not override llmProfileHint for automated tasks when profile routing is disabled", () => {
    const daemonLike = createDaemonLike();
    vi.mocked(LLMProviderFactory.loadSettings).mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o",
    } as Any);
    vi.mocked(LLMProviderFactory.getProviderRoutingSettings).mockReturnValue({
      profileRoutingEnabled: false,
      cheapModelKey: "gpt-4o-mini",
      strongModelKey: "gpt-4o",
      automatedTaskModelKey: undefined,
      preferStrongForVerification: true,
    });

    const task: Task = {
      id: "task-2",
      title: "Scheduled: Daily digest",
      prompt: "Generate digest",
      status: "queued",
      workspaceId: "ws-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: "cron",
      agentConfig: { llmProfileHint: "strong" },
    } as Task;

    const result = applyRuntimeTaskStrategy(daemonLike, task);

    expect(result.task.agentConfig?.llmProfileHint).toBe("strong");
  });

  it("does not override when task has explicit modelKey", () => {
    const daemonLike = createDaemonLike();
    vi.mocked(LLMProviderFactory.loadSettings).mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o",
    } as Any);
    vi.mocked(LLMProviderFactory.getProviderRoutingSettings).mockReturnValue({
      profileRoutingEnabled: true,
      cheapModelKey: "gpt-4o-mini",
      strongModelKey: "gpt-4o",
      automatedTaskModelKey: undefined,
      preferStrongForVerification: true,
    });

    const task: Task = {
      id: "task-3",
      title: "Scheduled: Important job",
      prompt: "Run job",
      status: "queued",
      workspaceId: "ws-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: "cron",
      agentConfig: { modelKey: "gpt-4o" },
    } as Task;

    const result = applyRuntimeTaskStrategy(daemonLike, task);

    expect(result.task.agentConfig?.modelKey).toBe("gpt-4o");
    expect(result.task.agentConfig?.llmProfileHint).toBeUndefined();
  });

  it("does not override for manual tasks even when profile routing is enabled", () => {
    const daemonLike = createDaemonLike();
    vi.mocked(LLMProviderFactory.loadSettings).mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o",
    } as Any);
    vi.mocked(LLMProviderFactory.getProviderRoutingSettings).mockReturnValue({
      profileRoutingEnabled: true,
      cheapModelKey: "gpt-4o-mini",
      strongModelKey: "gpt-4o",
      automatedTaskModelKey: "gpt-4o-nano",
      preferStrongForVerification: true,
    });

    const task: Task = {
      id: "task-4",
      title: "Manual task from user",
      prompt: "Do something",
      status: "queued",
      workspaceId: "ws-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: "manual",
      agentConfig: { llmProfileHint: "strong" },
    } as Task;

    const result = applyRuntimeTaskStrategy(daemonLike, task);

    expect(result.task.agentConfig?.llmProfileHint).toBe("strong");
  });
});

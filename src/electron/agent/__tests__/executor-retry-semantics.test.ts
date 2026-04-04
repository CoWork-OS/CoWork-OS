import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { LLMProviderFactory } from "../llm";

function createRetryExecutor(overrides?: {
  successCriteria?: Any;
  agentConfig?: Any;
  maxAttempts?: number;
}) {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  executor.task = {
    id: "task-retry-1",
    title: "Retry semantics test",
    prompt: "Run the task",
    createdAt: Date.now() - 1000,
    successCriteria: overrides?.successCriteria,
    agentConfig: overrides?.agentConfig || {},
    maxAttempts: overrides?.maxAttempts,
  };
  executor.workspace = {
    id: "workspace-1",
    path: "/tmp",
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = {
    updateTaskStatus: vi.fn(),
    updateTask: vi.fn(),
    logEvent: vi.fn(),
    getTransientRetryCount: vi.fn().mockReturnValue(0),
  };
  executor.emitEvent = vi.fn();
  executor.logTag = "[Executor:test]";
  executor.modelId = "gpt-5.3-codex";
  executor.initialImages = [];
  executor.provider = { createMessage: vi.fn() };
  executor.toolRegistry = { cleanup: vi.fn().mockResolvedValue(undefined) };
  executor.abortController = new AbortController();
  executor.conversationHistory = [];

  executor.cancelled = false;
  executor.wrapUpRequested = false;
  executor.waitingForUserInput = false;
  executor.softDeadlineTriggered = false;
  executor.taskCompleted = false;
  executor.requiresTestRun = false;
  executor.requiresExecutionToolRun = false;
  executor.allowExecutionWithoutShell = false;
  executor.executionToolRunObserved = false;
  executor.executionToolAttemptObserved = false;
  executor.executionToolLastError = "";
  executor.planCompletedEffectively = false;

  executor.maybeHandleScheduleSlashCommand = vi.fn().mockResolvedValue(false);
  executor.resolveConversationMode = vi.fn().mockReturnValue("task");
  executor.analyzeTask = vi.fn().mockResolvedValue({});
  executor.shouldEmitAnswerFirst = vi.fn().mockReturnValue(false);
  executor.shouldShortCircuitAfterAnswerFirst = vi.fn().mockReturnValue(false);
  executor.shouldEmitPreflight = vi.fn().mockReturnValue(false);
  executor.startProgressJournal = vi.fn();
  executor.createPlan = vi.fn().mockResolvedValue(undefined);
  executor.appendConversationHistory = vi.fn((entry: Any) => {
    executor.conversationHistory.push(entry);
  });
  executor.dispatchMentionedAgentsAfterPlanning = vi.fn().mockResolvedValue(undefined);
  executor.executePlan = vi.fn().mockResolvedValue(undefined);
  executor.verifySuccessCriteria = vi
    .fn()
    .mockResolvedValue({ success: true, message: "criteria satisfied" });
  executor.spawnVerificationAgent = vi.fn().mockResolvedValue(undefined);
  executor.buildResultSummary = vi.fn().mockReturnValue("Done");
  executor.finalizeTask = vi.fn();
  executor.finalizeTaskBestEffort = vi.fn();
  executor.updateTracking = vi.fn();

  return executor as TaskExecutor & {
    emitEvent: ReturnType<typeof vi.fn>;
    executePlan: ReturnType<typeof vi.fn>;
    verifySuccessCriteria: ReturnType<typeof vi.fn>;
  };
}

describe("TaskExecutor executeUnlocked retry semantics", () => {
  it("executes only once when no success criteria and no explicit retry policy", async () => {
    const executor = createRetryExecutor({
      agentConfig: { deepWorkMode: true },
      maxAttempts: 3,
    });

    await (executor as Any).executeUnlocked();

    expect(executor.executePlan).toHaveBeenCalledTimes(1);
    expect(
      executor.emitEvent.mock.calls.filter((call: Any[]) => call[0] === "retry_started"),
    ).toHaveLength(0);
  });

  it("skips replaying the initial prompt and preflight framing on transient task retries", async () => {
    const executor = createRetryExecutor({
      agentConfig: { deepWorkMode: true },
    });
    executor.shouldEmitPreflight = vi.fn().mockReturnValue(true);
    executor.emitPreflightFraming = vi.fn().mockResolvedValue(undefined);
    executor.daemon.getTransientRetryCount = vi.fn().mockReturnValue(1);

    await (executor as Any).executeUnlocked();

    expect(
      executor.emitEvent.mock.calls.filter((call: Any[]) => call[0] === "user_message"),
    ).toHaveLength(0);
    expect(executor.emitPreflightFraming).not.toHaveBeenCalled();
  });

  it("retries only while success criteria are failing, then stops after pass", async () => {
    const executor = createRetryExecutor({
      successCriteria: { type: "assistant_assertion", assertion: "must be true" },
      agentConfig: { deepWorkMode: true },
      maxAttempts: 3,
    });
    executor.verifySuccessCriteria = vi
      .fn()
      .mockResolvedValueOnce({ success: false, message: "first attempt failed" })
      .mockResolvedValueOnce({ success: true, message: "second attempt passed" });

    await (executor as Any).executeUnlocked();

    expect(executor.executePlan).toHaveBeenCalledTimes(2);
    expect(executor.verifySuccessCriteria).toHaveBeenCalledTimes(2);
    expect(
      executor.emitEvent.mock.calls.filter((call: Any[]) => call[0] === "retry_started"),
    ).toHaveLength(1);
  });
});

describe("TaskExecutor provider failover retry semantics", () => {
  it("switches to the next configured provider when a retryable LLM error occurs", async () => {
    const executor = createRetryExecutor();
    executor.llmCallSequence = 0;
    executor.providerRetryV2Enabled = false;
    executor.recordObservedOutputThroughput = vi.fn();
    executor.provider = { type: "openai", createMessage: vi.fn() };
    executor.modelId = "gpt-4o-mini";
    executor.modelKey = "gpt-4o-mini";
    executor.llmProfileUsed = "cheap";
    executor.resolvedModelKey = "gpt-4o-mini";
    executor.providerFailoverIndex = 0;
    executor.providerFailoverSelections = [
      {
        providerType: "openai",
        modelId: "gpt-4o-mini",
        modelKey: "gpt-4o-mini",
        llmProfileUsed: "cheap",
        resolvedModelKey: "gpt-4o-mini",
        modelSource: "provider_default",
        warnings: [],
      },
      {
        providerType: "anthropic",
        modelId: "claude-sonnet-4-5-20250514",
        modelKey: "sonnet-4-5",
        llmProfileUsed: "cheap",
        resolvedModelKey: "sonnet-4-5",
        modelSource: "provider_default",
        warnings: [],
      },
    ];
    executor.lastRoutingState = {
      currentProvider: "openai",
      currentModel: "gpt-4o-mini",
      activeProvider: "openai",
      activeModel: "gpt-4o-mini",
      routeReason: "automatic_execution",
      fallbackChain: [],
      fallbackOccurred: false,
      manualOverride: false,
      updatedAt: Date.now(),
    };
    executor.emitRoutingState = vi.fn((overrides?: Any) => {
      executor.lastRoutingState = {
        currentProvider: "openai",
        currentModel: "gpt-4o-mini",
        activeProvider: executor.provider.type,
        activeModel: executor.modelId,
        routeReason: overrides?.routeReason || "automatic_execution",
        fallbackChain: overrides?.fallbackChain || [],
        fallbackOccurred: overrides?.fallbackOccurred ?? false,
        manualOverride: overrides?.manualOverride ?? false,
        updatedAt: Date.now(),
      };
    });
    executor.applyResolvedProviderSelection = vi.fn((selection: Any) => {
      executor.provider = { type: selection.providerType, createMessage: vi.fn() };
      executor.modelId = selection.modelId;
      executor.modelKey = selection.modelKey;
      executor.llmProfileUsed = selection.llmProfileUsed;
      executor.resolvedModelKey = selection.resolvedModelKey;
    });

    const requestFn = vi.fn(async () => {
      if (executor.provider.type === "openai") {
        const error = new Error("rate limit exceeded");
        (error as Any).status = 429;
        throw error;
      }
      return {
        content: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });

    const response = await (executor as Any).callLLMWithRetry(requestFn, "provider failover");

    expect(response.stopReason).toBe("end_turn");
    expect(requestFn).toHaveBeenCalledTimes(2);
    expect(executor.provider.type).toBe("anthropic");
    expect(executor.providerFailoverIndex).toBe(1);
    expect(executor.lastRoutingState?.fallbackOccurred).toBe(true);
    expect(executor.lastRoutingState?.fallbackChain).toEqual([
      expect.objectContaining({
        providerType: "openai",
        modelKey: "gpt-4o-mini",
        success: false,
      }),
      expect.objectContaining({
        providerType: "anthropic",
        modelKey: "sonnet-4-5",
        success: true,
      }),
    ]);
  });

  it("uses the configured primary retry cooldown when failover activates", () => {
    const executor = createRetryExecutor() as Any;
    executor.provider = { type: "openrouter", createMessage: vi.fn() };
    executor.modelId = "minimax/minimax-m2.5:free";
    executor.modelKey = "minimax/minimax-m2.5:free";
    executor.providerFailoverIndex = 0;
    executor.providerFailoverSelections = [
      {
        providerType: "openrouter",
        modelId: "minimax/minimax-m2.5:free",
        modelKey: "minimax/minimax-m2.5:free",
        llmProfileUsed: "cheap",
        resolvedModelKey: "minimax/minimax-m2.5:free",
        modelSource: "provider_default",
        warnings: [],
      },
      {
        providerType: "openrouter",
        modelId: "qwen/qwen3.6-plus:free",
        modelKey: "qwen/qwen3.6-plus:free",
        llmProfileUsed: "cheap",
        resolvedModelKey: "qwen/qwen3.6-plus:free",
        modelSource: "provider_default",
        warnings: [],
      },
    ];
    executor.cachedLlmSettings = null;
    executor.lastRoutingState = { fallbackChain: [] };
    executor.hasExplicitTaskRouteOverride = vi.fn(() => false);
    executor.appendRoutingFallbackStep = vi.fn(() => []);
    executor.emitRoutingState = vi.fn();
    executor.applyResolvedProviderSelection = vi.fn();

    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      modelKey: "openrouter/free",
      failoverPrimaryRetryCooldownSeconds: 5,
    } as Any);

    const before = Date.now();
    const didFailover = executor.failoverToNextProvider("quota", new Error("429"));

    expect(didFailover).toBe(true);
    expect(executor.providerFailoverPreserveUntil).toBeGreaterThanOrEqual(before + 5000);
    expect(executor.providerFailoverPreserveUntil).toBeLessThan(before + 7000);
  });

  it("fails over on retryable OpenRouter moderation route errors", async () => {
    const executor = createRetryExecutor();
    executor.llmCallSequence = 0;
    executor.providerRetryV2Enabled = true;
    executor.recordObservedOutputThroughput = vi.fn();
    executor.provider = { type: "openrouter", createMessage: vi.fn() };
    executor.modelId = "minimax/minimax-m2.5:free";
    executor.modelKey = "minimax/minimax-m2.5:free";
    executor.llmProfileUsed = "cheap";
    executor.resolvedModelKey = "minimax/minimax-m2.5:free";
    executor.providerFailoverIndex = 0;
    executor.providerFailoverSelections = [
      {
        providerType: "openrouter",
        modelId: "minimax/minimax-m2.5:free",
        modelKey: "minimax/minimax-m2.5:free",
        llmProfileUsed: "cheap",
        resolvedModelKey: "minimax/minimax-m2.5:free",
        modelSource: "provider_default",
        warnings: [],
      },
      {
        providerType: "openrouter",
        modelId: "qwen/qwen3.6-plus:free",
        modelKey: "qwen/qwen3.6-plus:free",
        llmProfileUsed: "cheap",
        resolvedModelKey: "qwen/qwen3.6-plus:free",
        modelSource: "provider_default",
        warnings: [],
      },
    ];
    executor.lastRoutingState = {
      currentProvider: "openrouter",
      currentModel: "minimax/minimax-m2.5:free",
      activeProvider: "openrouter",
      activeModel: "minimax/minimax-m2.5:free",
      routeReason: "automatic_execution",
      fallbackChain: [],
      fallbackOccurred: false,
      manualOverride: false,
      updatedAt: Date.now(),
    };
    executor.emitRoutingState = vi.fn((overrides?: Any) => {
      executor.lastRoutingState = {
        currentProvider: "openrouter",
        currentModel: "minimax/minimax-m2.5:free",
        activeProvider: executor.provider.type,
        activeModel: executor.modelId,
        routeReason: overrides?.routeReason || "automatic_execution",
        fallbackChain: overrides?.fallbackChain || [],
        fallbackOccurred: overrides?.fallbackOccurred ?? false,
        manualOverride: overrides?.manualOverride ?? false,
        updatedAt: Date.now(),
      };
    });
    executor.applyResolvedProviderSelection = vi.fn((selection: Any) => {
      executor.provider = { type: selection.providerType, createMessage: vi.fn() };
      executor.modelId = selection.modelId;
      executor.modelKey = selection.modelKey;
      executor.llmProfileUsed = selection.llmProfileUsed;
      executor.resolvedModelKey = selection.resolvedModelKey;
    });

    const requestFn = vi.fn(async () => {
      if (executor.modelId === "minimax/minimax-m2.5:free") {
        const error = new Error(
          'OpenRouter API error: 403 Forbidden - minimax/minimax-m2.5-20260211:free requires moderation on OpenInference. Your input was flagged for "violence/graphic". No credits were charged.',
        );
        (error as Any).status = 403;
        (error as Any).retryable = true;
        throw error;
      }
      return {
        content: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    });

    const response = await (executor as Any).callLLMWithRetry(
      requestFn,
      "provider moderation failover",
    );

    expect(response.stopReason).toBe("end_turn");
    expect(requestFn).toHaveBeenCalledTimes(2);
    expect(executor.modelId).toBe("qwen/qwen3.6-plus:free");
    expect(executor.providerFailoverIndex).toBe(1);
    expect(executor.lastRoutingState?.routeReason).toBe("model_capability");
    expect(executor.lastRoutingState?.fallbackOccurred).toBe(true);
    expect(executor.lastRoutingState?.fallbackChain).toEqual([
      expect.objectContaining({
        providerType: "openrouter",
        modelKey: "minimax/minimax-m2.5:free",
        reason: "model_capability",
        success: false,
      }),
      expect.objectContaining({
        providerType: "openrouter",
        modelKey: "qwen/qwen3.6-plus:free",
        success: true,
      }),
    ]);
  });
});

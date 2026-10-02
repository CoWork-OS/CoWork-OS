import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ThrottlingException } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
import { LLMProviderFactory } from "../llm";
import { LLMRefusalError } from "../llm/provider-error-classifier";

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
  it("does not replay an identical Ollama request after a local timeout", async () => {
    const executor = createRetryExecutor() as Any;
    executor.llmCallSequence = 0;
    executor.providerRetryV2Enabled = true;
    executor.recordObservedOutputThroughput = vi.fn();
    executor.provider = { type: "ollama", createMessage: vi.fn() };
    executor.modelId = "qwen3.8:27b-q8_0";
    executor.modelKey = "qwen3.8:27b-q8_0";
    executor.providerFailoverIndex = 0;
    executor.providerFailoverSelections = [];
    executor.appendRoutingFallbackStep = vi.fn();
    const requestFn = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Ollama request timed out after 5 minutes. The model may be too slow or not responding.",
        ),
      );

    await expect(
      executor.callLLMWithRetry(requestFn, "oversized local request", 3),
    ).rejects.toThrow(/timed out/i);

    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  it("does not schedule task-level transient recovery for explicitly bounded failures", () => {
    const executor = createRetryExecutor() as Any;
    expect(
      executor.isTransientProviderError({
        message: "Document review synthesis timed out after 120s",
        retryable: false,
      }),
    ).toBe(false);
  });

  it("preserves image-aware failover context when retrying without an explicit modality override", async () => {
    const executor = createRetryExecutor() as Any;
    executor.llmCallSequence = 0;
    executor.providerRetryV2Enabled = false;
    executor.providerFailoverRequiresImageInput = true;
    executor.recordObservedOutputThroughput = vi.fn();
    executor.ensureProviderFailoverSelectionsContext = vi.fn();

    await executor.callLLMWithRetry(
      vi.fn().mockResolvedValue({
        content: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      "image-aware retry",
    );

    expect(executor.ensureProviderFailoverSelectionsContext).toHaveBeenCalledWith(true);
  });

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

  it("retries the next provider immediately after failover without backoff", async () => {
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

    await (executor as Any).callLLMWithRetry(requestFn, "provider failover without delay");

    const retryEvents = executor.emitEvent.mock.calls
      .filter((call: Any[]) => call[0] === "llm_retry")
      .map((call: Any[]) => call[1]);
    expect(retryEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ attempt: 1, delayMs: 0 })]),
    );
  });

  it("retries the primary provider once before cross-provider failover on transient outages", async () => {
    const executor = createRetryExecutor();
    executor.llmCallSequence = 0;
    executor.providerRetryV2Enabled = true;
    executor.recordObservedOutputThroughput = vi.fn();
    executor.provider = { type: "azure", createMessage: vi.fn() };
    executor.modelId = "gpt-5.4";
    executor.modelKey = "gpt-5.4";
    executor.llmProfileUsed = "strong";
    executor.resolvedModelKey = "gpt-5.4";
    executor.providerFailoverIndex = 0;
    executor.providerFailoverSelections = [
      {
        providerType: "azure",
        modelId: "gpt-5.4",
        modelKey: "gpt-5.4",
        llmProfileUsed: "strong",
        resolvedModelKey: "gpt-5.4",
        modelSource: "provider_default",
        warnings: [],
      },
      {
        providerType: "openrouter",
        modelId: "qwen/qwen3.6-plus:free",
        modelKey: "qwen/qwen3.6-plus:free",
        llmProfileUsed: "strong",
        resolvedModelKey: "qwen/qwen3.6-plus:free",
        modelSource: "provider_default",
        warnings: [],
      },
    ];
    executor.lastRoutingState = {
      currentProvider: "azure",
      currentModel: "gpt-5.4",
      activeProvider: "azure",
      activeModel: "gpt-5.4",
      routeReason: "profile_routing",
      fallbackChain: [],
      fallbackOccurred: false,
      manualOverride: false,
      updatedAt: Date.now(),
    };
    executor.emitRoutingState = vi.fn((overrides?: Any) => {
      executor.lastRoutingState = {
        currentProvider: "azure",
        currentModel: "gpt-5.4",
        activeProvider: executor.provider.type,
        activeModel: executor.modelId,
        routeReason: overrides?.routeReason || "profile_routing",
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

    const requestFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({
        content: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      });

    const response = await (executor as Any).callLLMWithRetry(requestFn, "provider outage retry");

    expect(response.stopReason).toBe("end_turn");
    expect(requestFn).toHaveBeenCalledTimes(2);
    expect(executor.provider.type).toBe("azure");
    expect(executor.providerFailoverIndex).toBe(0);
    expect(executor.applyResolvedProviderSelection).not.toHaveBeenCalled();
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

  it("fails over on retryable OpenRouter image-input route errors", async () => {
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
          "OpenRouter API error: 404 Not Found - No endpoints found that support image input",
        );
        (error as Any).status = 404;
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
      "provider image-input failover",
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

  it("fails over on retryable OpenRouter tool_choice route errors", async () => {
    const executor = createRetryExecutor();
    executor.llmCallSequence = 0;
    executor.providerRetryV2Enabled = true;
    executor.recordObservedOutputThroughput = vi.fn();
    executor.provider = { type: "openrouter", createMessage: vi.fn() };
    executor.modelId = "nvidia/nemotron-3-super-120b-a12b:free";
    executor.modelKey = "nvidia/nemotron-3-super-120b-a12b:free";
    executor.llmProfileUsed = "cheap";
    executor.resolvedModelKey = "nvidia/nemotron-3-super-120b-a12b:free";
    executor.providerFailoverIndex = 0;
    executor.providerFailoverSelections = [
      {
        providerType: "openrouter",
        modelId: "nvidia/nemotron-3-super-120b-a12b:free",
        modelKey: "nvidia/nemotron-3-super-120b-a12b:free",
        llmProfileUsed: "cheap",
        resolvedModelKey: "nvidia/nemotron-3-super-120b-a12b:free",
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
      currentModel: "nvidia/nemotron-3-super-120b-a12b:free",
      activeProvider: "openrouter",
      activeModel: "nvidia/nemotron-3-super-120b-a12b:free",
      routeReason: "automatic_execution",
      fallbackChain: [],
      fallbackOccurred: false,
      manualOverride: false,
      updatedAt: Date.now(),
    };
    executor.emitRoutingState = vi.fn((overrides?: Any) => {
      executor.lastRoutingState = {
        currentProvider: "openrouter",
        currentModel: "nvidia/nemotron-3-super-120b-a12b:free",
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
      if (executor.modelId === "nvidia/nemotron-3-super-120b-a12b:free") {
        const error = new Error(
          "OpenRouter API error: 404 Not Found - No endpoints found that support the provided 'tool_choice' value. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
        );
        (error as Any).status = 404;
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
      "provider tool-choice failover",
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
        modelKey: "nvidia/nemotron-3-super-120b-a12b:free",
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

describe("TaskExecutor provider error classification with real SDK errors", () => {
  const successResponse = {
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
  const anthropicOverloaded = () =>
    Anthropic.APIError.generate(
      529,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      undefined,
      new Headers({ "request-id": "req_overloaded" }),
    );
  const anthropicServerError = () =>
    Anthropic.APIError.generate(
      500,
      { type: "error", error: { type: "api_error", message: "Internal server error" } },
      undefined,
      new Headers({ "request-id": "req_server" }),
    );
  const anthropicConnectionError = () =>
    new Anthropic.APIConnectionError({
      cause: new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), {
          code: "ENOTFOUND",
        }),
      }),
    });
  const openAIQuotaError = () =>
    OpenAI.APIError.generate(
      429,
      {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
          code: "insufficient_quota",
          param: null,
        },
      },
      undefined,
      new Headers(),
    );
  const bedrockThrottling = () =>
    new ThrottlingException({
      message: "Too many requests, please wait before trying your request again.",
      $metadata: { httpStatusCode: 429 },
    });

  function createCallExecutor(
    primary: { providerType: string; modelId: string },
    fallback?: {
      providerType: string;
      modelId: string;
    },
  ) {
    const executor = createRetryExecutor() as Any;
    executor.llmCallSequence = 0;
    executor.providerRetryV2Enabled = true;
    executor.recordObservedOutputThroughput = vi.fn();
    executor.provider = { type: primary.providerType, createMessage: vi.fn() };
    executor.modelId = primary.modelId;
    executor.modelKey = primary.modelId;
    executor.llmProfileUsed = "strong";
    executor.resolvedModelKey = primary.modelId;
    executor.providerFailoverIndex = 0;
    executor.providerFailoverSelections = [primary, ...(fallback ? [fallback] : [])].map(
      (selection) => ({
        providerType: selection.providerType,
        modelId: selection.modelId,
        modelKey: selection.modelId,
        llmProfileUsed: "strong",
        resolvedModelKey: selection.modelId,
        modelSource: "provider_default",
        warnings: [],
      }),
    );
    executor.lastRoutingState = { fallbackChain: [] };
    executor.emitRoutingState = vi.fn();
    executor.appendRoutingFallbackStep = vi.fn(() => []);
    executor.applyResolvedProviderSelection = vi.fn((selection: Any) => {
      executor.provider = { type: selection.providerType, createMessage: vi.fn() };
      executor.modelId = selection.modelId;
      executor.modelKey = selection.modelKey;
    });
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: primary.providerType,
      modelKey: primary.modelId,
    } as Any);
    return executor;
  }

  async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: Any }> {
    const outcome = promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return outcome;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["Anthropic 529 overloaded_error", anthropicOverloaded],
    ["Anthropic 500 api_error", anthropicServerError],
    ["Anthropic connection error with a nested errno", anthropicConnectionError],
    ["Bedrock ThrottlingException", bedrockThrottling],
  ])("retries a transient %s in-call", async (_label, makeError) => {
    const executor = createCallExecutor({
      providerType: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    const requestFn = vi.fn().mockRejectedValueOnce(makeError()).mockResolvedValue(successResponse);

    const outcome = await settle(executor.callLLMWithRetry(requestFn, "sdk transient retry", 3));

    expect(outcome.error).toBeUndefined();
    expect(outcome.value?.stopReason).toBe("end_turn");
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("fails over to the configured fallback when Anthropic stays overloaded", async () => {
    const executor = createCallExecutor(
      { providerType: "anthropic", modelId: "claude-sonnet-4-6" },
      { providerType: "openai", modelId: "gpt-5.5" },
    );
    const requestFn = vi.fn(async () => {
      if (executor.provider.type === "anthropic") throw anthropicOverloaded();
      return successResponse;
    });

    const outcome = await settle(executor.callLLMWithRetry(requestFn, "overloaded failover", 3));

    expect(outcome.error).toBeUndefined();
    expect(executor.provider.type).toBe("openai");
    expect(executor.providerFailoverIndex).toBe(1);
    // One local retry of the primary, then the fallback provider.
    expect(requestFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry an exhausted OpenAI quota even though it arrives as HTTP 429", async () => {
    const executor = createCallExecutor({ providerType: "openai", modelId: "gpt-5.5" });
    const requestFn = vi.fn().mockRejectedValue(openAIQuotaError());

    const outcome = await settle(executor.callLLMWithRetry(requestFn, "quota exhausted", 5));

    expect(outcome.error?.status).toBe(429);
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  it("fails over immediately on an exhausted quota when a fallback is configured", async () => {
    const executor = createCallExecutor(
      { providerType: "openai", modelId: "gpt-5.5" },
      { providerType: "anthropic", modelId: "claude-sonnet-4-6" },
    );
    const requestFn = vi.fn(async () => {
      if (executor.provider.type === "openai") throw openAIQuotaError();
      return successResponse;
    });

    const outcome = await settle(executor.callLLMWithRetry(requestFn, "quota failover", 5));

    expect(outcome.error).toBeUndefined();
    expect(executor.provider.type).toBe("anthropic");
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("surfaces a provider refusal without retrying or failing over", async () => {
    const executor = createCallExecutor(
      { providerType: "anthropic", modelId: "claude-sonnet-4-6" },
      { providerType: "openai", modelId: "gpt-5.5" },
    );
    const requestFn = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "" }],
      stopReason: "refusal",
      usage: { inputTokens: 10, outputTokens: 0 },
    });

    const outcome = await settle(executor.callLLMWithRetry(requestFn, "refusal", 5));

    expect(outcome.error).toBeInstanceOf(LLMRefusalError);
    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(executor.provider.type).toBe("anthropic");
  });

  it("waits at least the provider's retry-after before retrying", async () => {
    const executor = createCallExecutor({
      providerType: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    const rateLimited = Anthropic.APIError.generate(
      429,
      { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } },
      undefined,
      new Headers({ "retry-after": "7" }),
    );
    const requestFn = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValue(successResponse);

    const outcome = await settle(executor.callLLMWithRetry(requestFn, "retry-after", 3));

    expect(outcome.error).toBeUndefined();
    const retryEvents = executor.emitEvent.mock.calls
      .filter((call: Any[]) => call[0] === "llm_retry")
      .map((call: Any[]) => call[1]);
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0].delayMs).toBeGreaterThanOrEqual(7_000);
    expect(retryEvents[0].delayMs).toBeLessThanOrEqual(8_000);
  });
});

describe("TaskExecutor Ollama context budget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("budgets context for the window Ollama runs the model with, not the catalogue window", () => {
    const executor = createRetryExecutor() as Any;
    vi.spyOn(LLMProviderFactory, "createProvider").mockReturnValue({
      type: "ollama",
      createMessage: vi.fn(),
    } as Any);

    executor.applyResolvedProviderSelection({
      providerType: "ollama",
      modelId: "qwen3:32b",
      modelKey: "qwen3:32b",
      llmProfileUsed: "strong",
      resolvedModelKey: "qwen3:32b",
      modelSource: "provider_default",
      warnings: [],
    });

    expect(executor.contextManager.getModelTokenLimit()).toBe(32_768);
  });
});

describe("TaskExecutor planning warmup tool routing", () => {
  it("skips planning warmup tools on OpenRouter failover routes", () => {
    const executor = createRetryExecutor() as Any;
    executor.provider = { type: "openrouter" };
    executor.providerFailoverIndex = 1;
    executor.getEffectivePromptCachingSettings = vi.fn().mockReturnValue({
      mode: "auto",
      surfaceCoverage: { executor: true },
    });

    expect(executor.shouldWarmPlanningPromptCacheWithTools("openrouter-openai", "executor")).toBe(
      false,
    );
  });
});

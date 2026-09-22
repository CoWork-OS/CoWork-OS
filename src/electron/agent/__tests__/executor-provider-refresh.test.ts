import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextManager } from "../context-manager";
import { TaskExecutor } from "../executor";
import { LLMProviderFactory } from "../llm";

describe("TaskExecutor provider refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "counts a successful response exactly once when usage is present=%s",
    async (hasUsage) => {
      const recordLlmTurn = vi.fn();
      const executor = Object.assign(Object.create(TaskExecutor.prototype), {
        _runtime: { recordLlmTurn },
        provider: {
          type: "openai",
          createMessage: vi.fn().mockResolvedValue({
            content: [],
            ...(hasUsage ? { usage: { inputTokens: 1, outputTokens: 1 } } : {}),
          }),
        },
        modelId: "test-model",
        abortController: new AbortController(),
        refreshProviderIfSettingsChanged: vi.fn(),
        emitEvent: vi.fn(),
      });
      await executor.createMessageWithTimeout(
        { model: "test-model", maxTokens: 8, messages: [] },
        1000,
        "test",
      );
      // Usage-bearing responses are counted by updateTracking at their existing callsites.
      expect(recordLlmTurn).toHaveBeenCalledTimes(hasUsage ? 0 : 1);
      executor.provider.createMessage.mockRejectedValue(new Error("provider failed"));
      await expect(
        executor.createMessageWithTimeout(
          { model: "test-model", maxTokens: 8, messages: [] },
          1000,
          "test",
        ),
      ).rejects.toThrow("provider failed");
      expect(recordLlmTurn).toHaveBeenCalledTimes(hasUsage ? 0 : 1);
    },
  );

  it.each([
    ["document", false],
    ["document", true],
    ["canvas", false],
    ["canvas", true],
    ["report", false],
    ["report", true],
  ])("accounts for %s helper turns when usage is present=%s", async (kind, hasUsage) => {
    const recordLlmTurn = vi.fn();
    const updateTracking = vi.fn(() => recordLlmTurn());
    const executor = Object.assign(Object.create(TaskExecutor.prototype), {
      _runtime: { recordLlmTurn },
      task: { id: "accounting-test", title: "test", agentConfig: { autoReportEnabled: true } },
      provider: {
        type: "openai",
        createMessage: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "<html><body>ok</body></html>" }],
          ...(hasUsage
            ? { usage: { inputTokens: 3, outputTokens: 2, cachedTokens: 1, cacheWriteTokens: 0 } }
            : {}),
        }),
      },
      modelId: "test-model",
      abortController: new AbortController(),
      refreshProviderIfSettingsChanged: vi.fn(),
      emitEvent: vi.fn(),
      updateTracking,
      getContractPrompt: () => "test",
      callLLMWithRetry: (fn: () => Promise<unknown>) => fn(),
      extractTextFromLLMContent: (content: Any[]) =>
        content.map((item) => item.text || "").join(""),
    });
    if (kind === "document") {
      await executor.requestBoundedDocumentAnalysisTurn({
        system: "test",
        prompt: "test",
        label: "test",
        maxTokens: 8,
      });
    } else if (kind === "canvas") {
      expect(await executor.generateCanvasHtml("test")).toContain("<html>");
    } else {
      // Deliberately short output: account for the response, then stop before file creation.
      await executor.autoGenerateReport();
    }
    expect(executor.provider.createMessage).toHaveBeenCalledOnce();
    expect(recordLlmTurn).toHaveBeenCalledOnce();
    expect(updateTracking).toHaveBeenCalledTimes(hasUsage ? 1 : 0);
    if (hasUsage) expect(updateTracking).toHaveBeenCalledWith(3, 2, 1, 0, undefined);
  });

  it("refreshes provider before an LLM call and uses the refreshed model id", async () => {
    const oldProvider = {
      type: "ollama",
      createMessage: vi.fn(async () => ({ content: [], usage: undefined })),
    };
    const newProvider = {
      type: "minimax-portal",
      createMessage: vi.fn(async () => ({ content: [], usage: undefined })),
    };

    vi.spyOn(LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "minimax-portal",
      modelId: "mini-max-model",
      modelKey: "gpt-4.1",
      llmProfileUsed: "strong",
      resolvedModelKey: "gpt-4.1",
      modelSource: "provider_default",
    } as Any);
    vi.spyOn(LLMProviderFactory, "createProvider").mockReturnValue(newProvider as Any);

    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-1",
      title: "Automatic task",
      agentConfig: {},
    };
    executor.provider = oldProvider;
    executor.modelId = "qwen3.5:35b";
    executor.modelKey = "opus-4-5";
    executor.llmProfileUsed = "strong";
    executor.resolvedModelKey = "opus-4-5";
    executor.contextManager = new ContextManager("opus-4-5");
    executor.abortController = new AbortController();
    executor.cancelled = false;
    executor.taskCompleted = false;
    executor.emitEvent = vi.fn();
    executor.logTag = "[Executor:test]";
    executor.getCumulativeInputTokens = vi.fn(() => 0);
    executor.getCumulativeOutputTokens = vi.fn(() => 0);
    executor.getEffectiveExecutionMode = vi.fn(() => "execute");

    await executor.createMessageWithTimeout(
      {
        model: "qwen3.5:35b",
        maxTokens: 64,
        system: "test",
        messages: [],
      },
      1000,
      "Test operation",
    );

    expect(oldProvider.createMessage).not.toHaveBeenCalled();
    expect(newProvider.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "mini-max-model",
      }),
    );
    expect(executor.provider).toBe(newProvider);
    expect(executor.modelId).toBe("mini-max-model");
    expect(executor.contextManager).toBeInstanceOf(ContextManager);
    expect(executor.iterationCount).toBe(1);
    expect(executor.globalTurnCount).toBe(1);
    expect(executor.lifetimeTurnCount).toBe(1);
  });

  it("switches to the new global provider even when the task has an older model override", async () => {
    const oldProvider = {
      type: "minimax-portal",
      createMessage: vi.fn(async () => ({ content: [], usage: undefined })),
    };
    const newProvider = {
      type: "ollama",
      createMessage: vi.fn(async () => ({ content: [], usage: undefined })),
    };

    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "ollama",
      ollama: { model: "qwen3.5:latest" },
    } as Any);
    vi.spyOn(LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "ollama",
      modelId: "qwen3.5:latest",
      modelKey: "qwen3.5:latest",
      llmProfileUsed: "cheap",
      resolvedModelKey: "qwen3.5:latest",
      modelSource: "provider_default",
      warnings: [],
    } as Any);
    vi.spyOn(LLMProviderFactory, "createProvider").mockReturnValue(newProvider as Any);

    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-2",
      title: "Automatic task",
      agentConfig: {
        modelKey: "MiniMax-M2.5-highspeed",
      },
    };
    executor.provider = oldProvider;
    executor.modelId = "MiniMax-M2.5-highspeed";
    executor.modelKey = "MiniMax-M2.5-highspeed";
    executor.llmProfileUsed = "strong";
    executor.resolvedModelKey = "MiniMax-M2.5-highspeed";
    executor.contextManager = new ContextManager("MiniMax-M2.5-highspeed");
    executor.abortController = new AbortController();
    executor.cancelled = false;
    executor.taskCompleted = false;
    executor.emitEvent = vi.fn();
    executor.logTag = "[Executor:test]";
    executor.getCumulativeInputTokens = vi.fn(() => 0);
    executor.getCumulativeOutputTokens = vi.fn(() => 0);
    executor.getEffectiveExecutionMode = vi.fn(() => "execute");

    await executor.createMessageWithTimeout(
      {
        model: "MiniMax-M2.5-highspeed",
        maxTokens: 64,
        system: "test",
        messages: [],
      },
      1000,
      "Test operation",
    );

    expect(oldProvider.createMessage).not.toHaveBeenCalled();
    expect(newProvider.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "qwen3.5:latest",
      }),
    );
    expect(LLMProviderFactory.resolveTaskModelSelection).toHaveBeenCalledWith(
      expect.not.objectContaining({
        modelKey: "MiniMax-M2.5-highspeed",
      }),
      expect.any(Object),
    );
    expect(executor.provider).toBe(newProvider);
    expect(executor.modelId).toBe("qwen3.5:latest");
  });

  it("switches from the strong planning profile to the cheap execution profile before an LLM call", async () => {
    const oldProvider = {
      type: "openai",
      createMessage: vi.fn(async () => ({ content: [], usage: undefined })),
    };
    const newProvider = {
      type: "openai",
      createMessage: vi.fn(async () => ({ content: [], usage: undefined })),
    };

    vi.spyOn(LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "openai",
      modelId: "gpt-5.4-mini",
      modelKey: "gpt-5.4-mini",
      llmProfileUsed: "cheap",
      resolvedModelKey: "gpt-5.4-mini",
      modelSource: "profile_model",
      warnings: [],
    } as Any);
    vi.spyOn(LLMProviderFactory, "createProvider").mockReturnValue(newProvider as Any);

    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-3",
      title: "Build a simple app",
      agentConfig: {
        llmProfileHint: "strong",
      },
    };
    executor.provider = oldProvider;
    executor.modelId = "gpt-5.4";
    executor.modelKey = "gpt-5.4";
    executor.llmProfileUsed = "cheap";
    executor.resolvedModelKey = "gpt-5.4";
    executor.contextManager = new ContextManager("gpt-5.4");
    executor.abortController = new AbortController();
    executor.cancelled = false;
    executor.taskCompleted = false;
    executor.emitEvent = vi.fn();
    executor.logTag = "[Executor:test]";
    executor.getCumulativeInputTokens = vi.fn(() => 0);
    executor.getCumulativeOutputTokens = vi.fn(() => 0);
    executor.getEffectiveExecutionMode = vi.fn(() => "execute");

    await executor.createMessageWithTimeout(
      {
        model: "gpt-5.4",
        maxTokens: 64,
        system: "test",
        messages: [],
      },
      1000,
      "Test operation",
    );

    expect(LLMProviderFactory.resolveTaskModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        llmProfileHint: "strong",
      }),
      expect.objectContaining({
        forceProfile: "cheap",
      }),
    );
    expect(oldProvider.createMessage).not.toHaveBeenCalled();
    expect(newProvider.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4-mini",
      }),
    );
    expect(executor.modelId).toBe("gpt-5.4-mini");
    expect(executor.llmProfileUsed).toBe("cheap");
  });

  it("does not revert an active failover route back to the primary settings route", () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      modelKey: "openrouter/free",
      openrouter: {
        apiKey: "openrouter-key",
        model: "minimax/minimax-m2.5:free",
      },
    } as Any);
    vi.spyOn(LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "openrouter",
      modelId: "minimax/minimax-m2.5:free",
      modelKey: "minimax/minimax-m2.5:free",
      llmProfileUsed: "cheap",
      resolvedModelKey: "minimax/minimax-m2.5:free",
      modelSource: "provider_default",
      warnings: [],
    } as Any);

    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-failover-refresh",
      title: "Automatic task",
      agentConfig: {},
    };
    executor.provider = { type: "openrouter", createMessage: vi.fn() };
    executor.modelId = "qwen/qwen3.6-plus:free";
    executor.modelKey = "qwen/qwen3.6-plus:free";
    executor.llmProfileUsed = "cheap";
    executor.resolvedModelKey = "qwen/qwen3.6-plus:free";
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
        modelSource: "explicit_override",
        warnings: [],
      },
    ];
    executor.providerFailoverIndex = 1;
    executor.providerFailoverPreserveUntil = Date.now() + 60_000;
    executor.cachedLlmSettings = null;
    executor.logTag = "[Executor:test]";
    executor.emitEvent = vi.fn();
    executor.emitRoutingState = vi.fn();
    executor.applyResolvedProviderSelection = vi.fn();
    executor.rebuildProviderFailoverSelections = vi.fn();
    executor.isVerificationTaskRoute = vi.fn(() => false);
    executor.hasExplicitTaskRouteOverride = vi.fn(() => false);

    executor.refreshProviderIfSettingsChanged();

    expect(executor.applyResolvedProviderSelection).not.toHaveBeenCalled();
    expect(executor.rebuildProviderFailoverSelections).not.toHaveBeenCalled();
    expect(executor.provider.type).toBe("openrouter");
    expect(executor.modelId).toBe("qwen/qwen3.6-plus:free");
  });

  it("returns to the primary route after the failover cooldown expires", () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openrouter",
      modelKey: "openrouter/free",
      openrouter: {
        apiKey: "openrouter-key",
        model: "minimax/minimax-m2.5:free",
      },
    } as Any);
    vi.spyOn(LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "openrouter",
      modelId: "minimax/minimax-m2.5:free",
      modelKey: "minimax/minimax-m2.5:free",
      llmProfileUsed: "cheap",
      resolvedModelKey: "minimax/minimax-m2.5:free",
      modelSource: "provider_default",
      warnings: [],
    } as Any);

    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-failover-retry-primary",
      title: "Automatic task",
      agentConfig: {},
    };
    executor.provider = { type: "openrouter", createMessage: vi.fn() };
    executor.modelId = "qwen/qwen3.6-plus:free";
    executor.modelKey = "qwen/qwen3.6-plus:free";
    executor.llmProfileUsed = "cheap";
    executor.resolvedModelKey = "qwen/qwen3.6-plus:free";
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
        modelSource: "explicit_override",
        warnings: [],
      },
    ];
    executor.providerFailoverIndex = 1;
    executor.providerFailoverPreserveUntil = Date.now() - 1;
    executor.cachedLlmSettings = null;
    executor.logTag = "[Executor:test]";
    executor.emitEvent = vi.fn();
    executor.emitRoutingState = vi.fn();
    executor.applyResolvedProviderSelection = vi.fn();
    executor.rebuildProviderFailoverSelections = vi.fn();
    executor.isVerificationTaskRoute = vi.fn(() => false);
    executor.hasExplicitTaskRouteOverride = vi.fn(() => false);

    executor.refreshProviderIfSettingsChanged();

    expect(executor.applyResolvedProviderSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: "openrouter",
        modelId: "minimax/minimax-m2.5:free",
      }),
    );
    expect(executor.rebuildProviderFailoverSelections).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: "openrouter",
        modelId: "minimax/minimax-m2.5:free",
      }),
      "cheap",
    );
  });

  it("passes stream callbacks for Azure chat and execute modes", async () => {
    const makeExecutor = (providerType: string, executionMode: string) => {
      const provider = {
        type: providerType,
        createMessage: vi.fn(async () => ({ content: [], usage: undefined })),
      };

      const executor = Object.create(TaskExecutor.prototype) as Any;
      executor.task = {
        id: "task-stream",
        title: "Stream test",
        agentConfig: {},
      };
      executor.provider = provider;
      executor.modelId = "gpt-4o";
      executor.abortController = new AbortController();
      executor.cancelled = false;
      executor.taskCompleted = false;
      executor.emitEvent = vi.fn();
      executor.logTag = "[Executor:test]";
      executor.getCumulativeInputTokens = vi.fn(() => 0);
      executor.getCumulativeOutputTokens = vi.fn(() => 0);
      executor.refreshProviderIfSettingsChanged = vi.fn();
      executor.getEffectiveExecutionMode = vi.fn().mockReturnValue(executionMode);
      return { executor, provider };
    };

    const azureChat = makeExecutor("azure", "chat");
    await azureChat.executor.createMessageWithTimeout(
      {
        model: "gpt-4o",
        maxTokens: 32,
        system: "test",
        messages: [],
      },
      1000,
      "Test operation",
    );
    expect((azureChat.provider.createMessage as Any).mock.calls[0][0].onStreamProgress).toEqual(
      expect.any(Function),
    );

    const azureExecute = makeExecutor("azure", "execute");
    await azureExecute.executor.createMessageWithTimeout(
      {
        model: "gpt-4o",
        maxTokens: 32,
        system: "test",
        messages: [],
      },
      1000,
      "Test operation",
    );
    expect((azureExecute.provider.createMessage as Any).mock.calls[0][0].onStreamProgress).toEqual(
      expect.any(Function),
    );

    const openaiChat = makeExecutor("openai", "chat");
    await openaiChat.executor.createMessageWithTimeout(
      {
        model: "gpt-4o",
        maxTokens: 32,
        system: "test",
        messages: [],
      },
      1000,
      "Test operation",
    );
    expect(
      (openaiChat.provider.createMessage as Any).mock.calls[0][0].onStreamProgress,
    ).toBeUndefined();
  });

  it("forwards Azure execute stream text into llm_streaming events", async () => {
    const provider = {
      type: "azure",
      createMessage: vi.fn(async (request: Any) => {
        request.onStreamProgress?.({
          inputTokens: 11,
          outputTokens: 7,
          outputChars: 28,
          elapsedMs: 240,
          streaming: true,
          text: "Checking the repo state first.",
        });
        return { content: [], usage: undefined };
      }),
    };

    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-stream-text",
      title: "Stream text test",
      agentConfig: {},
    };
    executor.provider = provider;
    executor.modelId = "gpt-4o";
    executor.abortController = new AbortController();
    executor.cancelled = false;
    executor.taskCompleted = false;
    executor.emitEvent = vi.fn();
    executor.logTag = "[Executor:test]";
    executor.getCumulativeInputTokens = vi.fn(() => 3);
    executor.getCumulativeOutputTokens = vi.fn(() => 5);
    executor.refreshProviderIfSettingsChanged = vi.fn();
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");

    await executor.createMessageWithTimeout(
      {
        model: "gpt-4o",
        maxTokens: 32,
        system: "test",
        messages: [],
      },
      1000,
      "Test operation",
    );

    expect(executor.emitEvent).toHaveBeenCalledWith(
      "llm_streaming",
      expect.objectContaining({
        text: "Checking the repo state first.",
        streaming: true,
        totalInputTokens: 14,
        totalOutputTokens: 12,
      }),
    );
  });
});

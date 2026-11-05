import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextManager } from "../context-manager";
import { TaskExecutor } from "../executor";
import { LLMProviderFactory } from "../llm";

const route = {
  providerType: "openai-compatible",
  modelId: "fixture-model",
  modelKey: "fixture-model",
  llmProfileUsed: "cheap",
  resolvedModelKey: "fixture-model",
  modelSource: "provider_default",
  warnings: [],
};

function executorWith(provider: Any, connectionKey: string) {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1", title: "Chat", agentConfig: {} };
  executor.provider = provider;
  executor.providerConnection = {
    type: "openai-compatible",
    model: "fixture-model",
    key: connectionKey,
  };
  executor.modelId = "fixture-model";
  executor.modelKey = "fixture-model";
  executor.llmProfileUsed = "cheap";
  executor.resolvedModelKey = "fixture-model";
  executor.contextManager = new ContextManager("fixture-model");
  executor.abortController = new AbortController();
  executor.cancelled = false;
  executor.taskCompleted = false;
  executor.emitEvent = vi.fn();
  executor.logTag = "[Executor:test]";
  executor.getCumulativeInputTokens = vi.fn(() => 0);
  executor.getCumulativeOutputTokens = vi.fn(() => 0);
  executor.getEffectiveExecutionMode = vi.fn(() => "execute");
  return executor;
}

const send = (executor: Any) =>
  executor.createMessageWithTimeout(
    { model: "fixture-model", maxTokens: 64, system: "test", messages: [] },
    1000,
    "Test operation",
  );

describe("TaskExecutor provider connection refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rebuilds the client when the saved key or base URL of the same provider changes", async () => {
    const oldProvider = {
      type: "openai-compatible",
      createMessage: vi.fn(async () => ({ content: [] })),
    };
    const newProvider = {
      type: "openai-compatible",
      createMessage: vi.fn(async () => ({ content: [] })),
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai-compatible",
    } as Any);
    vi.spyOn(LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue(route as Any);
    vi.spyOn(LLMProviderFactory, "providerConnectionKey").mockReturnValue("key-after-edit");
    const create = vi
      .spyOn(LLMProviderFactory, "createProvider")
      .mockReturnValue(newProvider as Any);

    const executor = executorWith(oldProvider, "key-before-edit");
    await send(executor);

    expect(create).toHaveBeenCalledWith({ type: "openai-compatible", model: "fixture-model" });
    expect(oldProvider.createMessage).not.toHaveBeenCalled();
    expect(newProvider.createMessage).toHaveBeenCalledOnce();
    expect(executor.providerConnection.key).toBe("key-after-edit");
  });

  it("keeps the client while the saved connection is unchanged", async () => {
    const provider = {
      type: "openai-compatible",
      createMessage: vi.fn(async () => ({ content: [] })),
    };
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai-compatible",
    } as Any);
    vi.spyOn(LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue(route as Any);
    vi.spyOn(LLMProviderFactory, "providerConnectionKey").mockReturnValue("same-key");
    const create = vi.spyOn(LLMProviderFactory, "createProvider");

    const executor = executorWith(provider, "same-key");
    await send(executor);

    expect(create).not.toHaveBeenCalled();
    expect(provider.createMessage).toHaveBeenCalledOnce();
  });
});

describe("LLMProviderFactory.providerConnectionKey", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const keyFor = (openaiCompatible: Record<string, string>) => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai-compatible",
      modelKey: "fixture-model",
      openaiCompatible,
    } as Any);
    return LLMProviderFactory.providerConnectionKey("openai-compatible", "fixture-model");
  };

  it("changes with the provider's key or base URL and is stable otherwise", () => {
    const base = { apiKey: "key-1", baseUrl: "http://127.0.0.1:1/v1", model: "fixture-model" };
    const original = keyFor(base);
    expect(keyFor({ ...base })).toBe(original);
    expect(keyFor({ ...base, apiKey: "key-2" })).not.toBe(original);
    expect(keyFor({ ...base, baseUrl: "http://127.0.0.1:2/v1" })).not.toBe(original);
    expect(original).not.toContain("key-1");
  });
});

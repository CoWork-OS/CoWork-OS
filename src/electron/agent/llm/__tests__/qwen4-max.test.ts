import { afterEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_PROVIDER_MAP, QWEN4_MAX_MODEL } from "../../../../shared/llm-provider-catalog";
import { resolveModelMetadata } from "../../../../shared/model-metadata";
import { OpenCodeProvider } from "../opencode-go-provider";
import { LLMProviderFactory } from "../provider-factory";
import { getModelPricing } from "../pricing";
import type { LLMRequest } from "../types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const { id, openRouterId, vercelId, veniceId } = QWEN4_MAX_MODEL;
const request: LLMRequest = {
  model: id,
  maxTokens: 4_096,
  messages: [{ role: "user", content: "Look up the fixture" }],
  tools: [{ name: "lookup", description: "Read a fixture", input_schema: { type: "object" } }],
};

describe("Qwen4-Max", () => {
  it.each([
    ["qwencloud", id],
    ["openrouter", openRouterId],
    ["opencode-go", id],
    ["vercel-ai-gateway", vercelId],
    ["venice", veniceId],
    ["nano-gpt", openRouterId],
    ["nano-gpt", `${openRouterId}:thinking`],
  ] as const)("lists %s model %s with context size and pricing", (providerType, model) => {
    const status = LLMProviderFactory.getProviderModelStatus({
      providerType,
      modelKey: "sonnet-4-5",
      cachedOpenRouterModels: [{ key: "older-model", displayName: "Older model", description: "" }],
    });

    expect(status.models).toContainEqual(
      expect.objectContaining({
        key: model,
        displayName: expect.stringMatching(/^Qwen4-Max/),
      }),
    );
    expect(resolveModelMetadata(model)?.context).toBe(1_000_000);
    expect(getModelPricing(model, providerType)?.inputPer1M).toBeGreaterThan(0);
  });

  it("sends a tool result with the assistant reasoning to the QwenCloud API", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "qwencloud",
      modelKey: "sonnet-4-5",
      customProviders: { qwencloud: { apiKey: "test-key" } },
    });
    const assistant = {
      role: "assistant",
      content: null,
      reasoning_content: "Use the fixture.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ choices: [{ finish_reason: "tool_calls", message: assistant }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ choices: [{ finish_reason: "stop", message: { content: "Done" } }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = LLMProviderFactory.createProvider();
    const first = await provider.createMessage({ ...request, reasoningEffort: "xhigh" });
    const result = await provider.createMessage({
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: first.content, reasoning: first.reasoning },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
      ],
    });

    expect(result.content).toEqual([{ type: "text", text: "Done" }]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1/chat/completions",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: id,
      reasoning_effort: "xhigh",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.slice(1)).toEqual([
      assistant,
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ]);
  });

  it("routes OpenCode Go requests through its Qwen Messages endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        content: [{ type: "text", text: "Done" }],
        stop_reason: "end_turn",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenCodeProvider({
      type: "opencode-go",
      providerName: "OpenCode Go",
      apiKey: "test-key",
      baseUrl: CUSTOM_PROVIDER_MAP.get("opencode-go")!.baseUrl!,
      defaultModel: id,
    });

    const result = await provider.createMessage({ ...request, model: `opencode-go/${id}` });
    expect(result.content).toEqual([{ type: "text", text: "Done" }]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://opencode.ai/inference/go/anthropic/v1/messages",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(id);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { MoaPreset } from "../../../../shared/types";
import { MoaProvider } from "../moa-provider";
import type { LLMProvider, LLMRequest, LLMResponse } from "../types";

function textResponse(
  text: string,
  usage?: LLMResponse["usage"],
): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage,
  };
}

function makeProvider(
  createMessage = vi.fn<LLMProvider["createMessage"]>(),
): LLMProvider {
  return {
    type: "openai",
    createMessage,
    testConnection: vi.fn().mockResolvedValue({ success: true }),
  };
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "frontier-council",
    maxTokens: 512,
    system: "system",
    messages: [{ role: "user", content: "solve this" }],
    ...overrides,
  };
}

function makePreset(overrides: Partial<MoaPreset> = {}): MoaPreset {
  return {
    id: "frontier-council",
    name: "Frontier council",
    enabled: true,
    referenceModels: [
      { providerType: "openai", modelKey: "advisor-a" },
      { providerType: "openrouter", modelKey: "advisor-b" },
    ],
    aggregator: { providerType: "anthropic", modelKey: "aggregator" },
    ...overrides,
  };
}

describe("MoaProvider", () => {
  it("runs references without tools and aggregator with original tools", async () => {
    const advisorA = makeProvider(
      vi.fn().mockResolvedValue(textResponse("advisor a", { inputTokens: 1, outputTokens: 2 })),
    );
    const advisorB = makeProvider(
      vi.fn().mockResolvedValue(textResponse("advisor b", { inputTokens: 3, outputTokens: 4 })),
    );
    const aggregator = makeProvider(
      vi.fn().mockResolvedValue(textResponse("final", { inputTokens: 5, outputTokens: 6 })),
    );
    const providers = new Map<string, LLMProvider>([
      ["advisor-a", advisorA],
      ["advisor-b", advisorB],
      ["aggregator", aggregator],
    ]);
    const provider = new MoaProvider({
      defaultPreset: "frontier-council",
      presets: { "frontier-council": makePreset() },
      resolveSlot: (slot) => ({
        provider: providers.get(slot.modelKey)!,
        modelId: `${slot.providerType}:${slot.modelKey}`,
      }),
    });

    const tools = [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: { type: "object", properties: {} },
      },
    ];
    const response = await provider.createMessage(makeRequest({ tools }));

    const advisorARequest = vi.mocked(advisorA.createMessage).mock.calls[0][0];
    const advisorBRequest = vi.mocked(advisorB.createMessage).mock.calls[0][0];
    expect(advisorARequest).toMatchObject({
      model: "openai:advisor-a",
      toolChoice: "none",
    });
    expect(advisorBRequest).toMatchObject({
      model: "openrouter:advisor-b",
      toolChoice: "none",
    });
    expect("tools" in advisorARequest).toBe(false);
    expect("tools" in advisorBRequest).toBe(false);
    expect(aggregator.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic:aggregator",
        tools,
      }),
    );
    const aggregatorRequest = vi.mocked(aggregator.createMessage).mock.calls[0][0];
    expect(String(aggregatorRequest.messages.at(-1)?.content)).toContain("advisor a");
    expect(String(aggregatorRequest.messages.at(-1)?.content)).toContain("advisor b");
    expect(response.usage).toEqual({
      inputTokens: 9,
      outputTokens: 12,
      cachedTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("keeps tool-result turns intact by appending advisory as a new user message", async () => {
    const advisor = makeProvider(vi.fn().mockResolvedValue(textResponse("advisor")));
    const aggregator = makeProvider(vi.fn().mockResolvedValue(textResponse("final")));
    const provider = new MoaProvider({
      defaultPreset: "frontier-council",
      presets: {
        "frontier-council": makePreset({
          referenceModels: [{ providerType: "openai", modelKey: "advisor" }],
        }),
      },
      resolveSlot: (slot) => ({
        provider: slot.modelKey === "advisor" ? advisor : aggregator,
        modelId: slot.modelKey,
      }),
    });

    await provider.createMessage(
      makeRequest({
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "1", name: "read", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }],
          },
        ],
      }),
    );

    const aggregatorRequest = vi.mocked(aggregator.createMessage).mock.calls[0][0];
    expect(Array.isArray(aggregatorRequest.messages.at(-2)?.content)).toBe(true);
    expect(aggregatorRequest.messages.at(-1)).toMatchObject({
      role: "user",
    });
    expect(String(aggregatorRequest.messages.at(-1)?.content)).toContain(
      "cowork_moa_advisory",
    );
  });

  it("continues to the aggregator when a reference model fails", async () => {
    const failingAdvisor = makeProvider(vi.fn().mockRejectedValue(new Error("quota")));
    const aggregator = makeProvider(vi.fn().mockResolvedValue(textResponse("final")));
    const provider = new MoaProvider({
      defaultPreset: "frontier-council",
      presets: {
        "frontier-council": makePreset({
          referenceModels: [{ providerType: "openai", modelKey: "advisor" }],
        }),
      },
      resolveSlot: (slot) => ({
        provider: slot.modelKey === "advisor" ? failingAdvisor : aggregator,
        modelId: slot.modelKey,
      }),
    });

    const response = await provider.createMessage(makeRequest());

    expect(response.content).toEqual([{ type: "text", text: "final" }]);
    const aggregatorRequest = vi.mocked(aggregator.createMessage).mock.calls[0][0];
    expect(String(aggregatorRequest.messages.at(-1)?.content)).toContain(
      "Reference call failed: quota",
    );
  });

  it("tries aggregator fallback candidates before failing the MoA call", async () => {
    const advisor = makeProvider(vi.fn().mockResolvedValue(textResponse("advisor")));
    const failingAggregator = makeProvider(
      vi.fn().mockRejectedValue(new Error("fetch failed")),
    );
    const fallbackAggregator = makeProvider(
      vi.fn().mockResolvedValue(textResponse("fallback final")),
    );
    const provider = new MoaProvider({
      defaultPreset: "frontier-council",
      presets: {
        "frontier-council": makePreset({
          referenceModels: [{ providerType: "azure", modelKey: "advisor" }],
          aggregator: { providerType: "openai", modelKey: "primary" },
        }),
      },
      resolveSlot: (slot) => {
        if (slot.modelKey === "advisor") {
          return { provider: advisor, modelId: "advisor" };
        }
        return [
          { provider: failingAggregator, modelId: "openai:primary" },
          { provider: fallbackAggregator, modelId: "azure:fallback" },
        ];
      },
    });

    const response = await provider.createMessage(makeRequest());

    expect(response.content).toEqual([
      { type: "text", text: "fallback final" },
    ]);
    expect(failingAggregator.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai:primary" }),
    );
    expect(fallbackAggregator.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: "azure:fallback" }),
    );
  });

  it("rejects recursive MoA presets", async () => {
    const aggregator = makeProvider(vi.fn().mockResolvedValue(textResponse("final")));
    const provider = new MoaProvider({
      defaultPreset: "frontier-council",
      presets: {
        "frontier-council": makePreset({
          referenceModels: [{ providerType: "moa", modelKey: "other-preset" }],
        }),
      },
      resolveSlot: () => ({ provider: aggregator, modelId: "unused" }),
    });

    await expect(provider.createMessage(makeRequest())).rejects.toThrow(
      "cannot reference another MoA preset",
    );
  });
});

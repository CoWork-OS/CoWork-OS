import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelMetadata } from "../../../../shared/model-metadata";
import { GEMINI_NEON_MODEL } from "../../../../shared/llm-provider-catalog";
import { AnthropicCompatibleProvider } from "../anthropic-compatible-provider";
import { GeminiProvider } from "../gemini-provider";
import { OpenAICompatibleProvider } from "../openai-compatible-provider";
import { OpenCodeProvider } from "../opencode-go-provider";
import { OpenRouterProvider } from "../openrouter-provider";
import { LLMProviderFactory, type LLMSettings } from "../provider-factory";
import type { LLMRequest } from "../types";

const { id, gatewayId } = GEMINI_NEON_MODEL;
const request: LLMRequest = {
  model: id,
  maxTokens: 128_000,
  messages: [{ role: "user", content: "Look up the fixture" }],
  tools: [{ name: "lookup", description: "Read a fixture", input_schema: { type: "object" } }],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Gemini 4 Neon", () => {
  it("discovers Neon while still excluding image-generation models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          models: [id, "gemini-4-pro-native-audio", "gemini-2.5-flash"].map((name) => ({
            name: `models/${name}`,
            supportedGenerationMethods: ["generateContent"],
          })),
        }),
      ),
    );
    const provider = new GeminiProvider({ type: "gemini", model: id, geminiApiKey: "test" });

    expect((await provider.getAvailableModels()).map((model) => model.name)).toEqual([
      id,
      "gemini-2.5-flash",
    ]);
  });

  it("preserves the function ID and thought signature across native Gemini tool calls", async () => {
    const provider = new GeminiProvider({ type: "gemini", model: id, geminiApiKey: "test" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "Thought summary", thought: true },
                  {
                    functionCall: { id: "call_1", name: "lookup", args: {} },
                    thoughtSignature: "signed",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 8 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          candidates: [{ content: { parts: [{ text: "Done" }] }, finishReason: "STOP" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await provider.createMessage({ ...request, reasoningEffort: "xhigh" });
    expect(first.usage).toEqual({ inputTokens: 20, outputTokens: 13 });
    expect(first.stopReason).toBe("tool_use");
    expect(first.content).toHaveLength(1);
    const [toolCall] = first.content;
    if (toolCall.type !== "tool_use") throw new Error("Expected a tool call");

    // A fresh provider must be able to resume from serialized history.
    const restored = new GeminiProvider({ type: "gemini", model: id, geminiApiKey: "test" });
    await restored.createMessage({
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: JSON.parse(JSON.stringify(first.content)) },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolCall.id, content: "ok" }],
        },
      ],
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).generationConfig).toEqual({
      maxOutputTokens: 65_536,
      thinkingConfig: { thinkingLevel: "XHIGH" },
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).contents.slice(1)).toEqual([
      {
        role: "model",
        parts: [
          { functionCall: { id: "call_1", name: "lookup", args: {} }, thoughtSignature: "signed" },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_1",
              name: "lookup",
              response: { result: "ok", is_error: false },
            },
          },
        ],
      },
    ]);
  });

  it.each(["openrouter", "google-vertex"] as const)(
    "replays signed tool calls through %s",
    async (route) => {
      const isVertex = route === "google-vertex";
      const details = [{ type: "reasoning.encrypted", id: "call_1", data: "signed" }];
      const toolCall = {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: "{}" },
        ...(isVertex ? { extra_content: { google: { thought_signature: "signed" } } } : {}),
      };
      const assistant = {
        role: "assistant",
        content: null,
        tool_calls: [toolCall],
        ...(!isVertex ? { reasoning_details: details } : {}),
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            choices: [{ finish_reason: "tool_calls", message: assistant }],
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            choices: [{ finish_reason: "stop", message: { content: "Done" } }],
          }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const provider = isVertex
        ? new OpenAICompatibleProvider({
            type: route,
            providerName: "Google Vertex",
            apiKey: "test",
            baseUrl:
              "https://aiplatform.googleapis.com/v1/projects/test/locations/global/endpoints/openapi",
            defaultModel: gatewayId,
          })
        : new OpenRouterProvider({ type: route, model: gatewayId, openrouterApiKey: "test" });

      const first = await provider.createMessage({
        ...request,
        model: gatewayId,
        reasoningEffort: "xhigh",
      });
      const result = await provider.createMessage({
        ...request,
        model: gatewayId,
        messages: [
          ...request.messages,
          { role: "assistant", content: first.content, reasoning: first.reasoning },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
          },
        ],
      });

      expect(result.content).toEqual([{ type: "text", text: "Done" }]);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        model: gatewayId,
        max_tokens: 65_536,
        ...(!isVertex ? { reasoning: { effort: "xhigh" } } : {}),
      });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.slice(1)).toEqual([
        assistant,
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ]);
    },
  );

  it("uses the Vercel Messages endpoint for the namespaced model", async () => {
    const provider = new AnthropicCompatibleProvider({
      type: "vercel-ai-gateway",
      providerName: "Vercel AI Gateway",
      apiKey: "test",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      defaultModel: gatewayId,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        content: [{ type: "text", text: "Done" }],
        stop_reason: "end_turn",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider.createMessage({ ...request, model: gatewayId })).resolves.toMatchObject({
      content: [{ type: "text", text: "Done" }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://ai-gateway.vercel.sh/v1/messages");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: gatewayId,
      max_tokens: 65_536,
    });
  });

  it("sends OpenCode Zen requests to its native Gemini endpoint", async () => {
    const provider = new OpenCodeProvider({
      type: "opencode",
      providerName: "OpenCode Zen",
      apiKey: "test-key",
      baseUrl: "https://opencode.ai/zen/v1",
      defaultModel: id,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        candidates: [{ content: { parts: [{ text: "Done" }] }, finishReason: "STOP" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider.createMessage({ ...request, model: `opencode/${id}` });

    expect(result.content).toEqual([{ type: "text", text: "Done" }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://opencode.ai/inference/google/v1beta/models/gemini-4-neon:generateContent",
    );
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("x-goog-api-key")).toBe("test-key");
  });

  it.each([
    ["gemini", id],
    ["openrouter", gatewayId],
    ["google-vertex", gatewayId],
    ["vercel-ai-gateway", gatewayId],
    ["opencode", id],
    ["venice", id],
    ["github-copilot", id],
  ] as const)("lists Neon in %s with its bundled context size", (providerType, model) => {
    const cached = [{ key: "older-model", displayName: "Older model", description: "" }];
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType,
      modelKey: "sonnet-4-5",
      cachedGeminiModels: cached,
      cachedOpenRouterModels: cached,
    } as LLMSettings);
    vi.spyOn(LLMProviderFactory, "getAvailableProviders").mockReturnValue([]);

    const status = LLMProviderFactory.getConfigStatus();
    expect(status.models).toContainEqual(
      expect.objectContaining({
        key: model,
        displayName: "Gemini 4 Neon",
      }),
    );
    expect(resolveModelMetadata(model)?.context).toBe(1_048_576);
    expect(status.currentModel).not.toBe(model);
  });
});

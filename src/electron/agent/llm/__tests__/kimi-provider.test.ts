import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KIMI_CURRENT_MODEL_IDS,
  KIMI_DEFAULT_MODEL,
  getDiscontinuedKimiModel,
  normalizeKimiModelId,
} from "../../../../shared/kimi-models";
import {
  CUSTOM_PROVIDER_MAP,
  KIMI_CODE_CHINA_BASE_URL,
  KIMI_CODE_DEFAULT_BASE_URL,
} from "../../../../shared/llm-provider-catalog";
import type { LLMSettingsData } from "../../../../shared/types";
import { appendAssistantResponseToConversation } from "../../executor-loop-utils";
import { getProviderImageCaps } from "../image-utils";
import { KimiProvider } from "../kimi-provider";
import { OpenAICompatibleProvider } from "../openai-compatible-provider";
import { LLMProviderFactory } from "../provider-factory";
import { KIMI_MODELS, type LLMMessage, type LLMRequest, type LLMTool } from "../types";

const tools: LLMTool[] = [
  {
    name: "read_file",
    description: "Read a file from the workspace.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function completion(message: Record<string, unknown>, finishReason = "stop"): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: vi.fn().mockResolvedValue({
      choices: [{ message: { role: "assistant", ...message }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  } as unknown as Response;
}

function requestBody(fetchSpy: ReturnType<typeof vi.spyOn>, call = 0): Any {
  return JSON.parse(String((fetchSpy.mock.calls[call]?.[1] as RequestInit | undefined)?.body));
}

function kimi(model?: string): KimiProvider {
  return new KimiProvider({ type: "kimi", model: model ?? "", kimiApiKey: "test-key" });
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "kimi-k3",
    maxTokens: 4096,
    system: "You are helpful.",
    messages: [{ role: "user", content: "Read README.md" }],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Kimi model list and defaults", () => {
  it("offers only models Moonshot still serves, with K3 as the default", () => {
    const ids = Object.values(KIMI_MODELS).map((model) => model.id);
    expect(ids).toEqual([...KIMI_CURRENT_MODEL_IDS]);
    expect(ids.filter((id) => getDiscontinuedKimiModel(id))).toEqual([]);
    expect(KIMI_DEFAULT_MODEL).toBe("kimi-k3");
    expect(CUSTOM_PROVIDER_MAP.get("moonshot")?.defaultModel).toBe("kimi-k3");
    expect(CUSTOM_PROVIDER_MAP.get("moonshot")?.knownModels).toEqual([...KIMI_CURRENT_MODEL_IDS]);
  });

  it("lists the Kimi Code plan models on the overseas endpoint", () => {
    const entry = CUSTOM_PROVIDER_MAP.get("kimi-code");
    expect(entry?.baseUrl).toBe(KIMI_CODE_DEFAULT_BASE_URL);
    expect(entry?.knownModels).toEqual([
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "k3",
      "k3-256k",
    ]);
  });

  it("returns the current models when no key is saved", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "kimi",
      modelKey: "sonnet-4-5",
    } as Any);
    const models = await LLMProviderFactory.getKimiModels();
    expect(models.map((model) => model.id)).toEqual([...KIMI_CURRENT_MODEL_IDS]);
  });

  it("drops discontinued ids from the live model list", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "kimi",
      modelKey: "sonnet-4-5",
    } as Any);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: "kimi-k3" }, { id: "kimi-k2.5" }, { id: "kimi-k2.6" }],
      }),
    } as Response);
    const models = await LLMProviderFactory.getKimiModels("test-key");
    expect(models.map((model) => model.id)).toEqual(["kimi-k3", "kimi-k2.6"]);
  });

  it("defaults a Kimi provider without a model to K3", async () => {
    vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "kimi",
      modelKey: "sonnet-4-5",
      kimi: {},
    } as Any);
    vi.spyOn(LLMProviderFactory, "getAvailableProviders").mockReturnValue([]);
    expect(LLMProviderFactory.getConfigStatus().currentModel).toBe("kimi-k3");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(completion({ content: "hi" }));
    await kimi().createMessage(request({ model: "" }));
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(requestBody(fetchSpy).model).toBe("kimi-k3");
  });
});

describe("discontinued Kimi model migration", () => {
  it("maps each discontinued id to a current model", () => {
    expect(normalizeKimiModelId("kimi-k2.5")).toBe("kimi-k3");
    expect(normalizeKimiModelId("kimi-k2-thinking")).toBe("kimi-k3");
    expect(normalizeKimiModelId("kimi-k2-thinking-turbo")).toBe("kimi-k3");
    expect(normalizeKimiModelId("kimi-k2-0905-preview")).toBe("kimi-k2.6");
    expect(normalizeKimiModelId("kimi-k2-turbo-preview")).toBe("kimi-k2.6");
    expect(normalizeKimiModelId("moonshot-v1-128k")).toBe("kimi-k2.6");
    expect(normalizeKimiModelId("kimi-k2.6")).toBe("kimi-k2.6");
    // Router ids belong to providers that may still serve the model.
    expect(normalizeKimiModelId("moonshotai/kimi-k2.5")).toBe("moonshotai/kimi-k2.5");
  });

  it("moves saved Kimi and Moonshot choices off discontinued models", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const settings = {
      providerType: "kimi",
      modelKey: "sonnet-4-5",
      kimi: { apiKey: "k", model: "kimi-k2.5" },
      cachedKimiModels: [
        { key: "kimi-k2-turbo-preview", displayName: "Kimi K2 Turbo" },
        { key: "kimi-k3", displayName: "Kimi K3" },
      ],
      customProviders: {
        moonshot: { apiKey: "m", model: "kimi-k2-turbo-preview" },
      },
      fallbackProviders: [{ providerType: "kimi", modelKey: "kimi-k2-thinking" }],
      openrouter: {
        fallbackProviders: [{ providerType: "moonshot", modelKey: "kimi-k2.5" }],
      },
    } as Any;

    LLMProviderFactory.migrateKimiSettings(settings);

    expect(settings.kimi.model).toBe("kimi-k3");
    expect(settings.cachedKimiModels.map((model: Any) => model.key)).toEqual(["kimi-k3"]);
    expect(settings.customProviders.moonshot.model).toBe("kimi-k2.6");
    expect(settings.fallbackProviders[0].modelKey).toBe("kimi-k3");
    expect(settings.openrouter.fallbackProviders[0].modelKey).toBe("kimi-k3");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('"kimi-k2.5" was discontinued by Moonshot on 2026-08-31'),
    );
  });

  it("leaves current choices unchanged", () => {
    const settings = {
      providerType: "kimi",
      modelKey: "sonnet-4-5",
      kimi: { apiKey: "k", model: "kimi-k2.7-code" },
    } as Any;
    LLMProviderFactory.migrateKimiSettings(settings);
    expect(settings.kimi.model).toBe("kimi-k2.7-code");
  });

  it("keeps an existing Kimi Code key on the endpoint it was saved for", () => {
    const saved = {
      providerType: "kimi-code",
      modelKey: "sonnet-4-5",
      customProviders: { "kimi-code": { apiKey: "sk-kimi", model: "kimi-for-coding" } },
    } as Any;
    LLMProviderFactory.migrateKimiSettings(saved);
    expect(saved.customProviders["kimi-code"].baseUrl).toBe(KIMI_CODE_CHINA_BASE_URL);

    const custom = {
      providerType: "kimi-code",
      modelKey: "sonnet-4-5",
      customProviders: {
        "kimi-code": { apiKey: "sk-kimi", baseUrl: KIMI_CODE_DEFAULT_BASE_URL },
      },
    } as Any;
    LLMProviderFactory.migrateKimiSettings(custom);
    expect(custom.customProviders["kimi-code"].baseUrl).toBe(KIMI_CODE_DEFAULT_BASE_URL);

    const unconfigured = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      customProviders: { "kimi-code": { model: "k3" } },
    } as LLMSettingsData as Any;
    LLMProviderFactory.migrateKimiSettings(unconfigured);
    expect(unconfigured.customProviders["kimi-code"].baseUrl).toBeUndefined();
  });

  it("sends a pinned discontinued model to Moonshot as its replacement", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(completion({ content: "hi" }));
    await kimi("kimi-k2.5").createMessage(request({ model: "kimi-k2-turbo-preview" }));
    expect(requestBody(fetchSpy).model).toBe("kimi-k2.6");
  });

  it("does not rewrite the same id on other OpenAI-compatible endpoints", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(completion({ content: "hi" }));
    const provider = new OpenAICompatibleProvider({
      type: "openai-compatible",
      providerName: "Gateway",
      apiKey: "key",
      baseUrl: "https://gateway.example.com/v1",
      defaultModel: "kimi-k2.5",
    });
    await provider.createMessage(request({ model: "kimi-k2.5" }));
    expect(requestBody(fetchSpy).model).toBe("kimi-k2.5");
  });
});

describe("Kimi K3 tool calls keep reasoning_content", () => {
  it("resends each K3 assistant message with its reasoning_content across tool calls and turns", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        completion(
          {
            content: "",
            reasoning_content: "Need to read the file first.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"README.md"}' },
              },
            ],
          },
          "tool_calls",
        ),
      )
      .mockResolvedValueOnce(
        completion({ content: "It is a readme.", reasoning_content: "The file is short." }),
      )
      .mockResolvedValueOnce(completion({ content: "Done." }));

    const provider = kimi("kimi-k3");
    const messages: LLMMessage[] = [{ role: "user", content: "Read README.md" }];

    const first = await provider.createMessage(request({ messages, tools }));
    expect(first.stopReason).toBe("tool_use");
    expect(first.reasoning).toEqual([
      {
        format: "chat-reasoning-content",
        model: "kimi-k3",
        data: { reasoning_content: "Need to read the file first." },
      },
    ]);
    appendAssistantResponseToConversation(messages, first, 0);
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "# Readme" }],
    });

    const second = await provider.createMessage(request({ messages, tools }));
    appendAssistantResponseToConversation(messages, second, 0);
    messages.push({ role: "user", content: "Thanks. Anything else?" });

    await provider.createMessage(request({ messages, tools }));

    const toolLoopBody = requestBody(fetchSpy, 1);
    expect(toolLoopBody.thinking).toBeUndefined();
    expect(toolLoopBody.max_completion_tokens).toBe(4096);
    expect(toolLoopBody.max_tokens).toBeUndefined();
    expect(toolLoopBody.messages.slice(1)).toEqual([
      { role: "user", content: "Read README.md" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          },
        ],
        reasoning_content: "Need to read the file first.",
      },
      { role: "tool", content: "# Readme", tool_call_id: "call_1" },
    ]);

    const nextTurnBody = requestBody(fetchSpy, 2);
    const assistants = nextTurnBody.messages.filter((m: Any) => m.role === "assistant");
    expect(assistants.map((m: Any) => m.reasoning_content)).toEqual([
      "Need to read the file first.",
      "The file is short.",
    ]);
  });

  it("keeps reasoning_content when visible reasoning is stripped from the reply", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      completion({ content: "<think>draft</think>Answer.", reasoning_content: "Plan the answer." }),
    );
    const result = await kimi("kimi-k3").createMessage(request());
    expect(result.content).toEqual([{ type: "text", text: "Answer." }]);
    expect(result.reasoning?.[0]?.data).toEqual({ reasoning_content: "Plan the answer." });
  });

  it("does not send reasoning produced by a different model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(completion({ content: "ok" }));
    await kimi("kimi-k3").createMessage(
      request({
        messages: [
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
            reasoning: [
              {
                format: "chat-reasoning-content",
                model: "kimi-k2.7-code",
                data: { reasoning_content: "other model" },
              },
            ],
          },
          { role: "user", content: "Again" },
        ],
      }),
    );
    const assistant = requestBody(fetchSpy).messages.find((m: Any) => m.role === "assistant");
    expect(assistant).toEqual({ role: "assistant", content: "Hello" });
  });

  it("never sends thinking disabled to K2.7 Code, which rejects it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(completion({ content: "ok" }));
    await kimi("kimi-k2.7-code").createMessage(request({ model: "kimi-k2.7-code", tools }));
    expect(requestBody(fetchSpy).thinking).toBeUndefined();
  });

  it("keeps turning thinking off for K2.6 tool calls", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(completion({ content: "ok", reasoning_content: "ignored" }));
    const result = await kimi("kimi-k2.6").createMessage(request({ model: "kimi-k2.6", tools }));
    expect(requestBody(fetchSpy).thinking).toEqual({ type: "disabled" });
    expect(result.reasoning).toBeUndefined();
  });
});

describe("Kimi image input", () => {
  it("is per model", () => {
    expect(getProviderImageCaps("kimi").supportsImages).toBe(false);
    expect(getProviderImageCaps("kimi", "kimi-k3").supportsImages).toBe(true);
    expect(getProviderImageCaps("kimi", "kimi-k2.6").supportsImages).toBe(true);
    expect(getProviderImageCaps("kimi", "kimi-k2.7-code-highspeed").supportsImages).toBe(true);
    expect(getProviderImageCaps("kimi", "kimi-k2.5").supportsImages).toBe(false);
    expect(getProviderImageCaps("moonshot", "kimi-k3").supportsImages).toBe(true);
    expect(getProviderImageCaps("kimi-code", "k3-256k").supportsImages).toBe(true);
    expect(getProviderImageCaps("groq", "kimi-k3").supportsImages).toBe(false);
  });

  it("sends images inline to K3 and as text to a text-only model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(completion({ content: "ok" }));
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    ];

    await kimi("kimi-k3").createMessage(request({ messages }));
    expect(requestBody(fetchSpy, 0).messages[1].content).toEqual([
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    ]);

    await kimi("moonshot-v1-custom").createMessage(
      request({ model: "moonshot-v1-custom", messages }),
    );
    expect(typeof requestBody(fetchSpy, 1).messages[1].content).toBe("string");
  });
});

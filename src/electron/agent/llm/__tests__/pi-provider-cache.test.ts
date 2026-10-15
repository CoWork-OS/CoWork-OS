import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiProvider } from "../pi-provider";
import type { LLMRequest } from "../types";

const complete = vi.fn();
const getModels = vi.fn();
vi.mock("../pi-ai-loader", () => ({ loadPiAiModule: async () => ({ complete, getModels }) }));

const success = {
  model: "claude-sonnet-4-6",
  stopReason: "stop",
  content: [{ type: "text", text: "ok" }],
  usage: { input: 100, output: 5, cacheRead: 2_048, cacheWrite: 128 },
};
function request(): LLMRequest {
  return {
    model: "claude-sonnet-4-6",
    maxTokens: 128,
    system: "Legacy fallback",
    systemBlocks: [
      { text: "Stable instructions", scope: "session", cacheable: true },
      { text: "Only inspect the scratch fixture", scope: "turn", cacheable: false },
    ],
    messages: [{ role: "user", content: "Read the fixture" }],
    promptCache: { mode: "pi", ttl: "5m", cacheKey: "pi-cache-fixture", explicitRecentMessages: 3 },
  };
}
function provider(piProvider = "anthropic", model = "claude-sonnet-4-6") {
  return new PiProvider({ type: "pi", piProvider, model, piApiKey: "test-key" });
}

describe("Pi provider prompt caching", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    complete.mockResolvedValue(success);
    getModels.mockReturnValue([
      { id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages" },
    ]);
  });

  it.each(["absent", "disabled"] as const)(
    "keeps every system block when caching is %s",
    async (state) => {
      const input = request();
      input.promptCache =
        state === "absent" ? undefined : { ...input.promptCache!, mode: "disabled" };
      await provider().createMessage(input);
      const [, context, options] = complete.mock.calls[0];
      expect(context.systemPrompt).toBe("Stable instructions\n\nOnly inspect the scratch fixture");
      expect(context.messages[0].content).toEqual([{ type: "text", text: "Read the fixture" }]);
      expect(options.cacheRetention).toBe("none");
      expect(options.sessionId).toBeUndefined();
      expect(options.onPayload).toBeUndefined();
    },
  );

  it("protects the Anthropic stable system prefix without rewriting user history", async () => {
    const input = request();
    const snapshot = structuredClone(input);
    const response = await provider().createMessage(input);
    const [, context, options] = complete.mock.calls[0];
    expect(context.messages[0].content).toEqual([{ type: "text", text: "Read the fixture" }]);
    const payload = {
      model: input.model,
      system: [{ type: "text", text: context.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Read the fixture" }],
    };
    const body = options.onPayload(payload);
    expect(body.system).toEqual([
      { type: "text", text: "Stable instructions", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Only inspect the scratch fixture" },
    ]);
    const identity = {
      type: "text",
      text: "SDK-owned authentication identity",
      cache_control: { type: "ephemeral" },
    };
    const oauthBody = options.onPayload({ ...payload, system: [identity, ...payload.system] });
    expect(oauthBody.system[0]).toEqual(identity);
    expect(oauthBody.system.slice(1)).toEqual(body.system);
    expect(body.messages).toEqual(payload.messages);
    expect(input).toEqual(snapshot);
    expect(response.usage).toEqual({
      inputTokens: 2_276,
      outputTokens: 5,
      cachedTokens: 2_048,
      cacheWriteTokens: 128,
    });
  });

  it("puts changing context after history on Pi OpenAI Responses requests", async () => {
    getModels.mockReturnValue([{ id: "gpt-5.4", provider: "openai", api: "openai-responses" }]);
    const input = { ...request(), model: "gpt-5.4" };
    await provider("openai", input.model).createMessage(input);
    const [, context, options] = complete.mock.calls[0];
    expect(context.systemPrompt).toBe("Stable instructions");
    expect(context.messages[0].content).toEqual([{ type: "text", text: "Read the fixture" }]);
    const body = options.onPayload({ input: [{ role: "user", content: "Read the fixture" }] });
    expect(body.input[0]).toEqual({ role: "user", content: "Read the fixture" });
    expect(body.input.at(-1)).toEqual({
      role: "developer",
      content: [{ type: "input_text", text: "Only inspect the scratch fixture" }],
    });
    expect(body.prompt_cache_key).toBe("pi-cache-fixture");
  });

  it("throws SDK error responses and retries cache rejection without losing instructions", async () => {
    complete
      .mockResolvedValueOnce({
        stopReason: "error",
        errorMessage: "Unsupported parameter: cache_control",
      })
      .mockResolvedValue(success);
    const p = provider();
    const input = request();
    await p.createMessage(input);
    await p.createMessage(input);
    expect(complete).toHaveBeenCalledTimes(3);
    for (const [, context, options] of complete.mock.calls.slice(1)) {
      expect(context.systemPrompt).toBe("Stable instructions\n\nOnly inspect the scratch fixture");
      expect(options.cacheRetention).toBe("none");
      expect(options.sessionId).toBeUndefined();
      expect(options.onPayload).toBeUndefined();
    }
  });

  it.each(["error", "aborted"])(
    "does not report an SDK %s response as a completed turn",
    async (stopReason) => {
      complete.mockResolvedValue({ stopReason, errorMessage: "fixture request failed" });
      await expect(provider().createMessage(request())).rejects.toThrow(
        stopReason === "aborted" ? "cancelled" : "fixture request failed",
      );
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );
});

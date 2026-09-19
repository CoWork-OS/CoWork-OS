import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AtomicChatProvider,
  AtomicChatProviderError,
  ATOMIC_CHAT_DEFAULT_BASE_URL,
  atomicChatCapabilityRegistry,
} from "../atomic-chat-provider";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function makeProvider(model = "auto") {
  return new AtomicChatProvider({
    apiKey: "",
    defaultModel: model,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  atomicChatCapabilityRegistry.clear();
});

describe("Atomic Chat inference adapter", () => {
  it("discovers the exact loaded model through the local OpenAI-compatible endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [{ id: "qwen-local-loaded" }] }));

    const provider = makeProvider();
    await expect(provider.getAvailableModelsDetailed()).resolves.toMatchObject({
      status: "success",
      models: [{ id: "qwen-local-loaded", name: "qwen-local-loaded" }],
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      `${ATOMIC_CHAT_DEFAULT_BASE_URL}/models`,
      expect.objectContaining({ headers: {} }),
    );
  });

  it.each([
    ["valid_empty", jsonResponse({ data: [] })],
    ["authentication_rejected", jsonResponse({ error: "auth required" }, 401)],
  ] as const)(
    "reports %s discovery without collapsing it into an empty success",
    async (status, response) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

      await expect(makeProvider().getAvailableModelsDetailed()).resolves.toMatchObject({
        status,
        models: [],
      });
    },
  );

  it("distinguishes a caller cancellation from a discovery timeout", async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });

    await expect(
      makeProvider().getAvailableModelsDetailed({ signal: cancelled.signal }),
    ).resolves.toMatchObject({ status: "cancelled" });

    await expect(
      new AtomicChatProvider({
        apiKey: "",
        defaultModel: "auto",
        discoveryTimeoutMs: 1,
      }).getAvailableModelsDetailed(),
    ).resolves.toMatchObject({ status: "timeout" });
  });

  it("resolves auto to the discovered model and sends a non-streaming request", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "atomic-qwen-14b" }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ finish_reason: "stop", message: { content: "ready" } }],
        }),
      );

    const provider = makeProvider();
    const response = await provider.createMessage({
      model: "auto",
      maxTokens: 64,
      system: "",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.content).toEqual([{ type: "text", text: "ready" }]);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      `${ATOMIC_CHAT_DEFAULT_BASE_URL}/chat/completions`,
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: "atomic-qwen-14b",
      stream: false,
    });
  });

  it("supports optional Atomic proxy authentication without requiring it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "ok" } }],
      }),
    );
    const provider = new AtomicChatProvider({
      apiKey: "atomic-secret",
      defaultModel: "loaded-model",
    });

    await provider.createMessage({
      model: "loaded-model",
      maxTokens: 32,
      system: "",
      messages: [{ role: "user", content: "hello" }],
    });

    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      Authorization: "Bearer atomic-secret",
      "X-Api-Key": "atomic-secret",
    });
  });

  it("rejects an invalid tool-call envelope before response conversion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ type: "function", function: { name: "read_file" } }],
            },
          },
        ],
      }),
    );

    await expect(
      makeProvider("loaded-model").createMessage({
        model: "loaded-model",
        maxTokens: 32,
        system: "",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_tool_call", retryable: false });
  });

  it("records tool capability evidence only after a valid observed tool-call response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  type: "function",
                  id: "call-1",
                  function: { name: "read_file", arguments: "{}" },
                },
                {
                  type: "function",
                  id: "call-2",
                  function: { name: "list_dir", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    );

    const provider = makeProvider("loaded-model");
    await provider.createMessage({
      model: "loaded-model",
      maxTokens: 32,
      system: "",
      messages: [{ role: "user", content: "inspect" }],
      tools: [
        { name: "read_file", description: "Read", input_schema: { type: "object" } },
        { name: "list_dir", description: "List", input_schema: { type: "object" } },
      ],
    });

    const profile = provider.getCapabilityProfile("loaded-model");
    expect(profile.capabilities.tools).toBe("verified");
    expect(profile.capabilities.multiple_tool_calls).toBe("verified");
    expect(profile.key.endpoint).toBe(ATOMIC_CHAT_DEFAULT_BASE_URL);
  });

  it.each([
    [401, "authentication"],
    [404, "model_unavailable"],
    [429, "temporarily_busy"],
  ] as const)("classifies HTTP %s as %s", async (status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "provider failure" } }, status),
    );
    const provider = makeProvider("loaded-model");

    await expect(
      provider.createMessage({
        model: "loaded-model",
        maxTokens: 32,
        system: "",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toMatchObject({
      code,
      status,
    });
  });

  it("returns explicit discovery outcomes for malformed payloads and offline servers", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ object: "list" }))
      .mockRejectedValueOnce(
        Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      );
    const provider = makeProvider();

    await expect(provider.getAvailableModelsDetailed()).resolves.toMatchObject({
      status: "invalid_response",
      models: [],
    });
    await expect(provider.getAvailableModelsDetailed()).resolves.toMatchObject({
      status: "unreachable",
      models: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns an actionable error when the connection probe cannot reach Atomic Chat", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );

    await expect(makeProvider().testConnection()).resolves.toEqual({
      success: false,
      error: "Atomic Chat is unavailable at the configured endpoint.",
    });
  });

  it("preserves cancellation as a terminal typed error", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    const provider = makeProvider("loaded-model");
    await expect(
      provider.createMessage({
        model: "loaded-model",
        maxTokens: 32,
        system: "",
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AtomicChatProviderError);
    await expect(
      provider.createMessage({
        model: "loaded-model",
        maxTokens: 32,
        system: "",
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled", retryable: false });
  });
});

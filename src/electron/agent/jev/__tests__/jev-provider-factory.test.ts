import { describe, expect, it, vi } from "vitest";
import {
  createConfiguredJevProvider,
  createJevProvider,
  testJevProvider,
} from "../jev-provider-factory";

function response(model = "~typesafe/jev-latest") {
  return new Response(
    JSON.stringify({
      model,
      answers: {
        connection: { type: "noul", noul: 1 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Jev settings provider factory", () => {
  it("uses the direct TypeSafe endpoint and normalizes pasted key prefixes", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return response("jev-latest");
    });
    const resolved = createJevProvider(
      {
        provider: "typesafe",
        typesafe: {
          apiKey: ' export TYPESAFE_API_KEY="Bearer typesafe-secret" ',
          baseUrl: "https://api.typesafe.ai",
        },
      },
      undefined,
      { fetch: fetchMock as unknown as typeof fetch },
    );

    await resolved.provider.decide(
      {
        state: "test",
        questions: {
          connection: { type: "noul", instructions: "Is this a test?" },
        },
      },
      { maxRetries: 0 },
    );

    expect(requestUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(requestInit?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer typesafe-secret" }),
    );
  });

  it("reuses the main OpenRouter key only when explicitly enabled", async () => {
    const fetchMock = vi.fn(async () => response());
    const configured = createConfiguredJevProvider({
      jev: {
        enabled: true,
        provider: "openrouter",
        teamSelectionEnabled: true,
        openrouter: {
          reuseOpenRouterKey: true,
          baseUrl: "https://openrouter.ai",
        },
      },
      openrouter: { apiKey: "main-openrouter-key" },
    });

    const resolvedWithFetch = createJevProvider(
      {
        provider: "openrouter",
        openrouter: {
          reuseOpenRouterKey: true,
          baseUrl: "https://openrouter.ai",
        },
      },
      "main-openrouter-key",
      { fetch: fetchMock as unknown as typeof fetch },
    );
    expect(configured).not.toBeNull();
    expect(resolvedWithFetch.provider).toBeDefined();
    await resolvedWithFetch.provider.decide({
      state: "test",
      questions: {
        connection: { type: "noul", instructions: "Is this a test?" },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/alpha/decisions",
      expect.anything(),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer main-openrouter-key" }),
    );
  });

  it("configures the provider for the optional harness without enabling team selection", () => {
    const configured = createConfiguredJevProvider({
      jev: {
        enabled: true,
        provider: "typesafe",
        harnessEnabled: true,
        toolReviewMode: "observe",
        typesafe: {
          apiKey: "typesafe-key",
        },
      },
    });

    expect(configured).not.toBeNull();
    expect(configured?.providerType).toBe("typesafe");
  });

  it("configures the provider for active harness decisions", () => {
    const configured = createConfiguredJevProvider({
      jev: {
        enabled: true,
        provider: "typesafe",
        harnessEnabled: true,
        toolReviewMode: "active",
        typesafe: {
          apiKey: "typesafe-key",
        },
      },
    });

    expect(configured).not.toBeNull();
    expect(configured?.providerType).toBe("typesafe");
  });

  it("prefers the main OpenRouter key over a legacy Jev-specific key when reuse is enabled", async () => {
    const fetchMock = vi.fn(async () => response());
    const resolved = createJevProvider(
      {
        provider: "openrouter",
        openrouter: {
          apiKey: "legacy-jev-key",
          reuseOpenRouterKey: true,
          baseUrl: "https://openrouter.ai",
        },
      },
      "main-openrouter-key",
      { fetch: fetchMock as unknown as typeof fetch },
    );

    await resolved.provider.decide({
      state: "test",
      questions: {
        connection: { type: "noul", instructions: "Is this a test?" },
      },
    });

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer main-openrouter-key" }),
    );
  });

  it("does not implicitly reuse the main OpenRouter key", () => {
    expect(() =>
      createJevProvider(
        {
          provider: "openrouter",
          openrouter: { baseUrl: "https://openrouter.ai" },
        },
        "main-openrouter-key",
      ),
    ).toThrow(/OpenRouter API key is required/);
  });

  it("does not send the main key to a custom endpoint", () => {
    expect(() =>
      createJevProvider(
        {
          provider: "openrouter",
          openrouter: {
            reuseOpenRouterKey: true,
            baseUrl: "https://gateway.example.test",
          },
        },
        "main-openrouter-key",
      ),
    ).toThrow(/official provider host/);
  });

  it("rejects insecure Jev endpoints before constructing a client", () => {
    expect(() =>
      createJevProvider({
        provider: "typesafe",
        typesafe: { apiKey: "test-key", baseUrl: "http://api.typesafe.ai" },
      }),
    ).toThrow(/HTTPS/);
  });

  it("returns a redacted-friendly connection result for an auth failure", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }),
    );
    const result = await testJevProvider(
      {
        provider: "openrouter",
        openrouter: { apiKey: "secret-key", baseUrl: "https://openrouter.ai" },
      },
      undefined,
      { fetch: fetchMock as unknown as typeof fetch },
    );

    expect(result.provider).toBe("openrouter");
    expect(result.success).toBe(false);
    expect(result.latencyMs).toEqual(expect.any(Number));
    expect(result.error).toContain("API key");
    expect(String(result.error)).not.toContain("secret-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

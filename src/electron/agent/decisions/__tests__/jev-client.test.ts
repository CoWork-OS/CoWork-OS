import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DecisionClientError,
  createDecisionProvider,
  type DecisionFetch,
  JevRequest,
  OpenRouterDecisionProvider,
  OPENROUTER_DECISION_ENDPOINT,
  OPENROUTER_DEFAULT_MODEL,
  TypeSafeDecisionProvider,
  TYPESAFE_DECISION_ENDPOINT,
  TYPESAFE_DEFAULT_MODEL,
} from "../index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function request(): JevRequest {
  return {
    state: {
      message: "My card was charged twice.",
      order: { id: "A-104", amount: 49 },
    },
    questions: {
      route: {
        type: "choice",
        instructions: "Which team should handle this?",
        criteria: {
          billing: "Payments and refunds",
          technical: "Bugs and outages",
        },
      },
      urgent: {
        type: "noul",
        instructions: "Does the customer communicate urgency?",
        criteria: { true: "Time-sensitive", false: "No time pressure" },
      },
      severity: {
        type: "score",
        instructions: "How severe is the issue?",
        criteria: ["Minor", "Degraded", "Blocking"],
      },
    },
  };
}

function responseBody(model: string, provider?: string): Record<string, unknown> {
  return {
    model,
    ...(provider ? { provider } : {}),
    answers: {
      route: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.88, technical: 0.12 },
        confidence: 0.76,
      },
      urgent: { type: "noul", noul: 0.91 },
      severity: {
        type: "score",
        score: 1.2,
        legend: { "0": "Minor", "1": "Degraded", "2": "Blocking" },
        probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
        confidence: 0.65,
      },
    },
    usage: { input_tokens: 123, output_tokens: 17 },
  };
}

function pendingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted", "AbortError")),
        { once: true },
      );
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TypeSafe Jev decision transport", () => {
  it("sends the documented request and preserves typed answers and usage", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse(responseBody(TYPESAFE_DEFAULT_MODEL));
    });
    const provider = new TypeSafeDecisionProvider({
      apiKey: "typesafe-secret",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    const result = await provider.decide(request());

    expect(capturedUrl).toBe(TYPESAFE_DECISION_ENDPOINT);
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer typesafe-secret",
        Accept: "application/json",
        "Content-Type": "application/json",
      }),
    );
    expect(capturedInit?.redirect).toBe("error");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      ...request(),
      model: TYPESAFE_DEFAULT_MODEL,
    });
    expect(result).toEqual(responseBody(TYPESAFE_DEFAULT_MODEL));
  });

  it("uses a per-request model override", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(responseBody("jev-pinned"));
    });
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      model: "jev-default",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    await provider.decide({ ...request(), model: "jev-pinned" });

    expect(body?.model).toBe("jev-pinned");
  });

  it("supports a configured full endpoint and a minimal connection test", async () => {
    let capturedUrl = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse({
        model: "jev-health",
        answers: { connection: { type: "noul", noul: 1 } },
        usage: { input_tokens: 11, output_tokens: 1 },
      });
    });
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      endpoint: "https://jev.example.test/custom/decisions",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    await expect(provider.testConnection()).resolves.toMatchObject({
      success: true,
      model: "jev-health",
    });
    expect(capturedUrl).toBe("https://jev.example.test/custom/decisions");
  });

  it("also resolves a base URL to the direct endpoint path", async () => {
    let capturedUrl = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return jsonResponse(responseBody(TYPESAFE_DEFAULT_MODEL));
    });
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      baseUrl: "https://typesafe.example.test",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    await provider.decide(request());

    expect(capturedUrl).toBe("https://typesafe.example.test/v1/systemone");
  });
});

describe("OpenRouter Jev decision transport", () => {
  it("uses the decisions endpoint and preserves provider, cost, probabilities, and confidence", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonResponse({
        ...responseBody(OPENROUTER_DEFAULT_MODEL, "TypeSafe"),
        usage: { input_tokens: 321, output_tokens: 9, cost: 0.000014 },
      });
    });
    const provider = new OpenRouterDecisionProvider({
      apiKey: "openrouter-secret",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    const result = await provider.decide(request());

    expect(capturedUrl).toBe(OPENROUTER_DECISION_ENDPOINT);
    expect(capturedInit?.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer openrouter-secret",
        "Content-Type": "application/json",
      }),
    );
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      state: request().state,
      questions: request().questions,
      model: OPENROUTER_DEFAULT_MODEL,
    });
    expect(result.provider).toBe("TypeSafe");
    expect(result.model).toBe(OPENROUTER_DEFAULT_MODEL);
    expect(result.usage).toMatchObject({ input_tokens: 321, output_tokens: 9, cost: 0.000014 });
    expect(result.answers.route).toMatchObject({
      choice: "billing",
      probabilities: { billing: 0.88, technical: 0.12 },
      confidence: 0.76,
    });
  });

  it("normalizes camel-case usage fields from a gateway response", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        ...responseBody("gateway-model", "TypeSafe"),
        usage: { inputTokens: 7, outputTokens: 3, cost: 0 },
      }),
    );
    const provider = new OpenRouterDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    const result = await provider.decide(request());

    expect(result.usage).toEqual({ input_tokens: 7, output_tokens: 3, cost: 0 });
  });

  it("returns an actionable failed connection result without throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: "Missing Authentication header" } }, 401),
      );
    const provider = new OpenRouterDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    await expect(provider.health()).resolves.toMatchObject({
      success: false,
      status: 401,
      error: expect.stringContaining("API key"),
    });
  });
});

describe("Jev provider factory", () => {
  it("reuses the stored OpenRouter key and settings when constructing the transport", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return jsonResponse(responseBody(OPENROUTER_DEFAULT_MODEL, "TypeSafe"));
    });
    const provider = createDecisionProvider(
      {
        provider: "openrouter",
        openrouterApiKey: "stored-openrouter-key",
        baseUrl: "https://router.example.test",
        model: "~typesafe/jev-pinned",
        maxRetries: 0,
      },
      { fetch: fetchMock as unknown as DecisionFetch },
    );

    await provider.decide(request());

    expect(capturedInit?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer stored-openrouter-key" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://router.example.test/api/alpha/decisions",
      expect.anything(),
    );
  });

  it("accepts a generic stored key for the direct TypeSafe transport", () => {
    const provider = createDecisionProvider({
      provider: "typesafe",
      apiKey: "stored-typesafe-key",
    });

    expect(provider).toBeInstanceOf(TypeSafeDecisionProvider);
  });
});

describe("Jev HTTP behavior", () => {
  it.each([429, 529, 500, 503])("retries transient HTTP status %s and succeeds", async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "temporary failure" } }, status))
      .mockResolvedValueOnce(jsonResponse(responseBody(TYPESAFE_DEFAULT_MODEL)));
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 1,
      retryDelayMs: 0,
    });

    await expect(provider.decide(request())).resolves.toMatchObject({
      model: TYPESAFE_DEFAULT_MODEL,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry validation responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "Invalid request parameters" } }, 400));
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 3,
      retryDelayMs: 0,
    });

    await expect(provider.decide(request())).rejects.toMatchObject({
      code: "request",
      status: 400,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry authentication responses or expose the API key in the error", async () => {
    const secret = "secret-key-that-must-not-leak";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: `Invalid key ${secret}` } }, 401));
    const provider = new OpenRouterDecisionProvider({
      apiKey: secret,
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 3,
      retryDelayMs: 0,
    });

    const error = await provider.decide(request()).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(DecisionClientError);
    expect(error).toMatchObject({ code: "authentication", status: 401 });
    expect(String(error)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed successful responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{not-json", { status: 200 }));
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    await expect(provider.decide(request())).rejects.toMatchObject({ code: "response" });
  });

  it("rejects malformed answer fields without silently dropping probabilities", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: TYPESAFE_DEFAULT_MODEL,
        answers: {
          route: { type: "choice", choice: "billing" },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    await expect(provider.decide(request())).rejects.toMatchObject({ code: "response" });
  });

  it("does not reflect an untrusted answer id in validation errors", async () => {
    const secretAnswerId = "Bearer synthetic-provider-secret";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: TYPESAFE_DEFAULT_MODEL,
        answers: {
          [secretAnswerId]: { type: "noul", noul: 1 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    const error = await provider.decide(request()).catch((value: unknown) => value);

    expect(error).toMatchObject({ code: "response" });
    expect(String(error)).not.toContain(secretAnswerId);
  });

  it("keeps the timeout active while a response body is stalled", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      text: () => new Promise<string>(() => undefined),
    } as unknown as Response);
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });

    await expect(provider.decide(request(), { timeoutMs: 5 })).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("rejects unsupported non-JSON state/content before fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(responseBody(TYPESAFE_DEFAULT_MODEL)));
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });
    const invalidRequest = {
      state: { attachment: new Uint8Array([1, 2, 3]) },
      questions: {
        route: {
          type: "choice",
          instructions: new Date(),
          criteria: { yes: "Yes", no: "No" },
        },
      },
    } as unknown as JevRequest;

    await expect(provider.decide(invalidRequest)).rejects.toMatchObject({ code: "validation" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces caller aborts and timeouts distinctly", async () => {
    const fetchMock = pendingFetch();
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test-key",
      fetch: fetchMock as unknown as DecisionFetch,
      maxRetries: 0,
    });
    const controller = new AbortController();

    const aborted = provider.decide(request(), {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });

    const timedOut = provider.decide(request(), { timeoutMs: 5 });
    await expect(timedOut).rejects.toMatchObject({ code: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

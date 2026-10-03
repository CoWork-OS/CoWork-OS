import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  InternalServerException,
  ModelNotReadyException,
  ServiceUnavailableException,
  ThrottlingException,
  ValidationException,
} from "@aws-sdk/client-bedrock-runtime";
import { GoogleGenerativeAIFetchError } from "@google/generative-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LLMRefusalError,
  MAX_PROVIDER_RETRY_AFTER_MS,
  classifyProviderError,
  resolveProviderRetryDelayMs,
} from "../provider-error-classifier";

const fetchFailed = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), {
      code: "ENOTFOUND",
    }),
  });

const anthropicError = (status: number, type: string, headers: Record<string, string> = {}) =>
  Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message: type } },
    undefined,
    new Headers(headers),
  );

const openAIError = (
  status: number,
  body: { message: string; type: string; code: string | null },
  headers: Record<string, string> = {},
) =>
  OpenAI.APIError.generate(
    status,
    { error: { ...body, param: null } },
    undefined,
    new Headers(headers),
  );

describe("classifyProviderError", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("classifies Anthropic SDK errors", () => {
    expect(classifyProviderError(anthropicError(529, "overloaded_error"))).toMatchObject({
      retryable: true,
      failoverEligible: true,
      reason: "overloaded",
      status: 529,
    });
    expect(classifyProviderError(anthropicError(500, "api_error"))).toMatchObject({
      retryable: true,
      reason: "server_error",
      status: 500,
    });
    expect(classifyProviderError(anthropicError(401, "authentication_error"))).toMatchObject({
      retryable: false,
      failoverEligible: false,
      reason: "authentication",
    });
    expect(classifyProviderError(anthropicError(400, "invalid_request_error", {}))).toMatchObject({
      retryable: false,
      reason: "invalid_request",
    });
  });

  it("finds an errno several causes deep in SDK connection errors", () => {
    expect(
      classifyProviderError(new Anthropic.APIConnectionError({ cause: fetchFailed() })),
    ).toMatchObject({ retryable: true, reason: "connection", code: "ENOTFOUND" });
    expect(
      classifyProviderError(new OpenAI.APIConnectionError({ cause: fetchFailed() })),
    ).toMatchObject({ retryable: true, reason: "connection", code: "ENOTFOUND" });
    // A wrapper around the SDK error (as adapters produce) still resolves the errno.
    const wrapped = Object.assign(new Error("Connection error."), {
      cause: new OpenAI.APIConnectionError({ cause: fetchFailed() }),
    });
    expect(classifyProviderError(wrapped)).toMatchObject({ retryable: true, code: "ENOTFOUND" });
  });

  it("recognises SDK connection classes without a cause", () => {
    expect(classifyProviderError(new OpenAI.APIConnectionError({}))).toMatchObject({
      retryable: true,
      reason: "connection",
    });
    expect(classifyProviderError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({
      retryable: true,
      reason: "timeout",
    });
  });

  it("treats an exhausted quota as final even when it arrives as HTTP 429", () => {
    const classification = classifyProviderError(
      openAIError(429, {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      }),
    );
    expect(classification).toMatchObject({
      retryable: false,
      failoverEligible: true,
      reason: "quota_exhausted",
      status: 429,
    });
  });

  it("keeps an ordinary OpenAI rate limit retryable and exposes retry-after-ms", () => {
    expect(
      classifyProviderError(
        openAIError(
          429,
          {
            message:
              "Rate limit reached for gpt-5 on tokens per min (TPM). You can increase your rate limit by adding a payment method at https://platform.openai.com/account/billing.",
            type: "tokens",
            code: "rate_limit_exceeded",
          },
          { "retry-after-ms": "1500" },
        ),
      ),
    ).toMatchObject({ retryable: true, reason: "rate_limited", retryAfterMs: 1500 });
  });

  it("does not retry deterministic request errors", () => {
    expect(
      classifyProviderError(
        openAIError(400, {
          message: "Invalid value for 'input'.",
          type: "invalid_request_error",
          code: null,
        }),
      ),
    ).toMatchObject({ retryable: false, reason: "invalid_request" });
    expect(
      classifyProviderError(
        openAIError(400, {
          message: "This model's maximum context length is 128000 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        }),
      ),
    ).toMatchObject({ retryable: false, reason: "context_overflow" });
  });

  it("classifies Bedrock exceptions by name and $metadata status", () => {
    expect(
      classifyProviderError(
        new ThrottlingException({
          message: "Too many tokens, please wait before trying your request again.",
          $metadata: { httpStatusCode: 429 },
        }),
      ),
    ).toMatchObject({ retryable: true, reason: "rate_limited", status: 429 });
    expect(
      classifyProviderError(
        new ServiceUnavailableException({
          message: "Unavailable",
          $metadata: { httpStatusCode: 503 },
        }),
      ),
    ).toMatchObject({ retryable: true, reason: "overloaded" });
    expect(
      classifyProviderError(
        new InternalServerException({ message: "Internal", $metadata: { httpStatusCode: 500 } }),
      ),
    ).toMatchObject({ retryable: true, reason: "server_error" });
    expect(
      classifyProviderError(
        new ModelNotReadyException({
          message: "Model is not ready",
          $metadata: { httpStatusCode: 429 },
        }),
      ),
    ).toMatchObject({ retryable: true });
    expect(
      classifyProviderError(
        new ValidationException({
          message: "Malformed input request",
          $metadata: { httpStatusCode: 400 },
        }),
      ),
    ).toMatchObject({ retryable: false, reason: "invalid_request" });
  });

  it("classifies Gemini fetch errors by status", () => {
    const error = new GoogleGenerativeAIFetchError(
      "[503 Service Unavailable] The model is overloaded. Please try again later.",
      503,
      "Service Unavailable",
    );
    expect(classifyProviderError(error)).toMatchObject({ retryable: true, status: 503 });
  });

  it("honours explicit adapter flags", () => {
    const moderation = Object.assign(new Error("403 requires moderation on OpenInference"), {
      status: 403,
      retryable: true,
    });
    expect(classifyProviderError(moderation)).toMatchObject({
      retryable: true,
      reason: "explicit_retryable",
    });
    expect(classifyProviderError(moderation, { legacyRetrySemantics: true }).retryable).toBe(false);

    const stamped = Object.assign(anthropicError(529, "overloaded_error"), { retryable: false });
    expect(classifyProviderError(stamped).retryable).toBe(true);
    expect(classifyProviderError(stamped, { respectExplicitNonRetryable: true })).toMatchObject({
      retryable: false,
      reason: "explicit_non_retryable",
    });
  });

  it("falls back to message heuristics for text-only adapter errors", () => {
    expect(classifyProviderError({ message: "socket hang up" }).retryable).toBe(true);
    expect(
      classifyProviderError({ message: "socket hang up" }, { legacyRetrySemantics: true })
        .retryable,
    ).toBe(false);
    expect(classifyProviderError({ message: "LLM request timed out after 120s" })).toMatchObject({
      retryable: true,
      reason: "timeout",
    });
    expect(classifyProviderError({ message: "Prompt has 14290 tokens" }).retryable).toBe(false);
    expect(classifyProviderError({ message: "Request cancelled" })).toMatchObject({
      retryable: false,
      reason: "cancelled",
    });
    expect(classifyProviderError(null)).toMatchObject({ retryable: false, reason: "unknown" });
  });

  it("never retries or fails over a safety refusal", () => {
    expect(classifyProviderError(new LLMRefusalError())).toMatchObject({
      retryable: false,
      failoverEligible: false,
      reason: "refusal",
    });
  });

  it("parses HTTP-date retry-after headers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    const error = anthropicError(429, "rate_limit_error", {
      "retry-after": "Fri, 02 Oct 2026 12:00:30 GMT",
    });
    expect(classifyProviderError(error).retryAfterMs).toBe(30_000);
  });
});

describe("resolveProviderRetryDelayMs", () => {
  it("waits for the longer of backoff and the provider's requested delay", () => {
    expect(resolveProviderRetryDelayMs(1_000)).toBe(1_000);
    expect(resolveProviderRetryDelayMs(4_000, 500)).toBe(4_000);
    const delay = resolveProviderRetryDelayMs(1_000, 7_000);
    expect(delay).toBeGreaterThanOrEqual(7_000);
    expect(delay).toBeLessThanOrEqual(7_700);
  });

  it("caps very long provider delays", () => {
    const delay = resolveProviderRetryDelayMs(1_000, 3_600_000);
    expect(delay).toBeGreaterThanOrEqual(MAX_PROVIDER_RETRY_AFTER_MS);
    expect(delay).toBeLessThanOrEqual(MAX_PROVIDER_RETRY_AFTER_MS + 1_000);
  });
});

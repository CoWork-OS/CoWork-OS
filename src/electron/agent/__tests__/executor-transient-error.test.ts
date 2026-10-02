/**
 * Tests for TaskExecutor transient provider error detection
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ServiceUnavailableException, ThrottlingException } from "@aws-sdk/client-bedrock-runtime";
import { describe, it, expect } from "vitest";
import { TaskExecutor } from "../executor";

// Exercise the executor's real predicate rather than a copy of it.
function isTransientProviderError(error: Any): boolean {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  return executor.isTransientProviderError(error);
}

describe("isTransientProviderError", () => {
  describe("error codes", () => {
    it("should return true for ECONNRESET", () => {
      const error = { code: "ECONNRESET", message: "Connection reset" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for ETIMEDOUT", () => {
      const error = { code: "ETIMEDOUT", message: "Connection timed out" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for ENOTFOUND", () => {
      const error = { code: "ENOTFOUND", message: "DNS lookup failed" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for EAI_AGAIN", () => {
      const error = { code: "EAI_AGAIN", message: "DNS lookup temporary failure" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for ECONNREFUSED", () => {
      const error = { code: "ECONNREFUSED", message: "Connection refused" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for error code in cause", () => {
      const error = {
        message: "Some error",
        cause: { code: "ECONNRESET" },
      };
      expect(isTransientProviderError(error)).toBe(true);
    });
  });

  describe("error messages", () => {
    it("should return true for fetch failed", () => {
      const error = { message: "fetch failed: connection terminated" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for network errors", () => {
      const error = { message: "Network request failed" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for timeout messages", () => {
      const error = { message: "Request timeout after 30s" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for socket hang up", () => {
      const error = { message: "socket hang up" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for terminated interruptions", () => {
      const error = { message: "terminated" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for stream disconnections", () => {
      const error = { message: "stream disconnected by upstream" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for unexpected eof", () => {
      const error = { message: "unexpected eof while reading stream" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for overloaded service errors", () => {
      const error = {
        message:
          'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}',
      };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should return true for temporarily unavailable provider errors", () => {
      const error = { message: "The provider is temporarily unavailable" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should be case insensitive", () => {
      const error = { message: "FETCH FAILED: CONNECTION RESET" };
      expect(isTransientProviderError(error)).toBe(true);
    });
  });

  describe("non-transient errors", () => {
    it("should return false for null", () => {
      expect(isTransientProviderError(null)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isTransientProviderError(undefined)).toBe(false);
    });

    it("should return false for API errors", () => {
      const error = { message: "Invalid API key", code: "INVALID_KEY" };
      expect(isTransientProviderError(error)).toBe(false);
    });

    it("should return true for rate limit / 429 (transient, retry after delay)", () => {
      expect(isTransientProviderError({ message: "Rate limit exceeded" })).toBe(true);
      expect(isTransientProviderError({ message: "429 Too Many Requests" })).toBe(true);
      expect(isTransientProviderError({ message: "free-models-per-min" })).toBe(true);
    });

    it("should return false for permission errors", () => {
      const error = { message: "Permission denied", code: "EPERM" };
      expect(isTransientProviderError(error)).toBe(false);
    });

    it("should return false for validation errors", () => {
      const error = { message: "Invalid input: missing required field" };
      expect(isTransientProviderError(error)).toBe(false);
    });

    it("should return false for empty error object", () => {
      expect(isTransientProviderError({})).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle error with only message", () => {
      const error = { message: "Some network issue" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should handle error with only code", () => {
      const error = { code: "ETIMEDOUT" };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should handle TypeError with fetch failed", () => {
      const error = new TypeError("fetch failed");
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should handle nested error structures", () => {
      const error = {
        message: "Request failed",
        cause: {
          code: "ECONNREFUSED",
          message: "Connection refused",
        },
      };
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("should trust structured retryable provider errors", () => {
      const error = { message: "provider interruption", retryable: true };
      expect(isTransientProviderError(error)).toBe(true);
    });
  });
  describe("real provider SDK errors", () => {
    const connectionFailure = () =>
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.anthropic.com"), {
          code: "ENOTFOUND",
        }),
      });

    it("treats an Anthropic 529 overloaded_error as transient", () => {
      const error = Anthropic.APIError.generate(
        529,
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        undefined,
        new Headers({ "request-id": "req_1" }),
      );
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("treats an Anthropic 500 api_error as transient", () => {
      const error = Anthropic.APIError.generate(
        500,
        { type: "error", error: { type: "api_error", message: "Internal server error" } },
        undefined,
        new Headers({ "request-id": "req_1" }),
      );
      expect(isTransientProviderError(error)).toBe(true);
    });

    it("treats SDK connection errors with a nested errno as transient", () => {
      expect(
        isTransientProviderError(new Anthropic.APIConnectionError({ cause: connectionFailure() })),
      ).toBe(true);
      expect(
        isTransientProviderError(new OpenAI.APIConnectionError({ cause: connectionFailure() })),
      ).toBe(true);
    });

    it("treats Bedrock throttling and unavailability as transient", () => {
      expect(
        isTransientProviderError(
          new ThrottlingException({
            message: "Too many requests, please wait before trying your request again.",
            $metadata: { httpStatusCode: 429 },
          }),
        ),
      ).toBe(true);
      expect(
        isTransientProviderError(
          new ServiceUnavailableException({
            message: "Bedrock is unable to process your request.",
            $metadata: { httpStatusCode: 503 },
          }),
        ),
      ).toBe(true);
    });

    it("does not treat an exhausted OpenAI quota as transient even though it is a 429", () => {
      const error = OpenAI.APIError.generate(
        429,
        {
          error: {
            message: "You exceeded your current quota, please check your plan and billing details.",
            type: "insufficient_quota",
            code: "insufficient_quota",
            param: null,
          },
        },
        undefined,
        new Headers(),
      );
      expect(isTransientProviderError(error)).toBe(false);
    });

    it("keeps an explicit retryable=false stamp authoritative over the status", () => {
      const error = Object.assign(
        Anthropic.APIError.generate(
          529,
          { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
          undefined,
          new Headers(),
        ),
        { retryable: false },
      );
      expect(isTransientProviderError(error)).toBe(false);
    });
  });
});

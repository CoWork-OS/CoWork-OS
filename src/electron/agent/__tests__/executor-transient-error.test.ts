/**
 * Tests for TaskExecutor transient provider error detection
 */

import { describe, it, expect } from "vitest";

// Test the isTransientProviderError logic directly
function isTransientProviderError(error: Any): boolean {
  if (!error) return false;
  const message = String(error.message || "").toLowerCase();
  const code = error.cause?.code || error.code;
  const retryableCodes = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
  ]);
  if (code && retryableCodes.has(code)) return true;
  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("socket hang up")
  );
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

    it("should return false for rate limit messages without code", () => {
      // Rate limits are handled elsewhere, not by this function
      const error = { message: "Rate limit exceeded" };
      expect(isTransientProviderError(error)).toBe(false);
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
  });
});

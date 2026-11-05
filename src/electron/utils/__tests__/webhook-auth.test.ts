import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { readBearerToken, readWebhookSecret, timingSafeEqualString } from "../webhook-auth";

function requestWithHeaders(headers: Record<string, string>): IncomingMessage {
  // Node lowercases incoming header names, so the fakes use lowercase keys.
  return { headers } as unknown as IncomingMessage;
}

describe("timingSafeEqualString", () => {
  it("accepts equal strings", () => {
    expect(timingSafeEqualString("secret-abc", "secret-abc")).toBe(true);
    expect(timingSafeEqualString("", "")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(timingSafeEqualString("secret-abc", "secret-abd")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    expect(timingSafeEqualString("short", "longer-secret")).toBe(false);
    expect(timingSafeEqualString("", "nonempty")).toBe(false);
  });

  it("compares UTF-8 bytes, not JS length", () => {
    // "é" is one JS character but two UTF-8 bytes, "e" is one: the byte
    // lengths differ, so this must return false rather than throw on
    // timingSafeEqual with mismatched buffer sizes.
    expect(timingSafeEqualString("é", "e")).toBe(false);
    // Same UTF-8 byte length, different bytes.
    expect(timingSafeEqualString("é", "ü")).toBe(false);
    // Multi-byte characters that are actually equal.
    expect(timingSafeEqualString("café", "café")).toBe(true);
  });
});

describe("readBearerToken", () => {
  it("reads a canonical Bearer header", () => {
    expect(readBearerToken("Bearer abc")).toBe("abc");
  });

  it("is case-insensitive on the scheme", () => {
    expect(readBearerToken("bearer abc")).toBe("abc");
    expect(readBearerToken("BEARER abc")).toBe("abc");
  });

  it("tolerates extra whitespace around the token", () => {
    expect(readBearerToken("Bearer   abc  ")).toBe("abc");
  });

  it("takes the first value of an array header", () => {
    expect(readBearerToken(["Bearer first", "Bearer second"])).toBe("first");
  });

  it("returns null for missing, empty, scheme-only and non-bearer headers", () => {
    expect(readBearerToken(undefined)).toBeNull();
    expect(readBearerToken("")).toBeNull();
    expect(readBearerToken("Bearer    ")).toBeNull();
    expect(readBearerToken("Basic abc")).toBeNull();
  });
});

describe("readWebhookSecret", () => {
  it("prefers the explicit webhook secret header", () => {
    const req = requestWithHeaders({
      "x-cowork-webhook-secret": "shared-secret",
      authorization: "Bearer bearer-token",
    });
    expect(readWebhookSecret(req)).toBe("shared-secret");
  });

  it("trims the explicit header value", () => {
    const req = requestWithHeaders({ "x-cowork-webhook-secret": "  shared-secret  " });
    expect(readWebhookSecret(req)).toBe("shared-secret");
  });

  it("falls back to the bearer token", () => {
    const req = requestWithHeaders({ authorization: "Bearer bearer-token" });
    expect(readWebhookSecret(req)).toBe("bearer-token");
  });

  it("treats a whitespace-only custom header as absent", () => {
    const req = requestWithHeaders({
      "x-cowork-webhook-secret": "   ",
      authorization: "Bearer bearer-token",
    });
    expect(readWebhookSecret(req)).toBe("bearer-token");
  });

  it("returns null when neither source is present", () => {
    expect(readWebhookSecret(requestWithHeaders({}))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { sanitizeChannelConfig, toPublicChannel } from "../channel-config-sanitizer";

describe("channel-config-sanitizer", () => {
  it("removes schema-marked secret keys from email config", () => {
    const input = {
      protocol: "imap-smtp",
      email: "agent@example.com",
      password: "secret-password",
      loomBaseUrl: "https://loom.example.com",
      loomAccessToken: "loom-secret",
    };

    const sanitized = sanitizeChannelConfig("email", input);

    expect(sanitized).toEqual({
      protocol: "imap-smtp",
      email: "agent@example.com",
      loomBaseUrl: "https://loom.example.com",
    });
  });

  it("removes regex-matching secret-like keys", () => {
    const input = {
      protocol: "imap-smtp",
      publicField: "value",
      apiKey: "redact-me",
      ACCESS_TOKEN: "redact-me",
      passwordHint: "redact-me",
      email: "agent@example.com",
    };

    const sanitized = sanitizeChannelConfig("email", input);

    expect(sanitized).toEqual({
      protocol: "imap-smtp",
      email: "agent@example.com",
      publicField: "value",
    });
  });

  it("builds a public channel payload with sanitized config", () => {
    const payload = toPublicChannel({
      id: "channel-id",
      type: "email",
      name: "Work Email",
      enabled: true,
      status: "connected",
      botUsername: "bot",
      configReadError: "Secure storage unavailable",
      securityConfig: { mode: "pairing" },
      createdAt: 1700000000000,
      updatedAt: 1700000000001,
      config: {
        email: "agent@example.com",
        password: "secret-password",
        api_key: "redact-me",
        markAsRead: true,
        loomAccessToken: "loom-secret",
      },
    });

    expect(payload).toEqual({
      id: "channel-id",
      type: "email",
      name: "Work Email",
      enabled: true,
      status: "connected",
      botUsername: "bot",
      configReadError: "Secure storage unavailable",
      securityMode: "pairing",
      createdAt: 1700000000000,
      updatedAt: 1700000000001,
      config: {
        email: "agent@example.com",
        markAsRead: true,
      },
    });
  });

  it("returns undefined when config is not an object", () => {
    expect(sanitizeChannelConfig("email", null)).toBeUndefined();
    expect(sanitizeChannelConfig("email", "bad")).toBeUndefined();
    expect(sanitizeChannelConfig("email", [])).toBeUndefined();
  });
});

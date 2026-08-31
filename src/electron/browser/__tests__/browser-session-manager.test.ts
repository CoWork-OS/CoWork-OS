import { describe, expect, it } from "vitest";
import {
  BrowserSessionManager,
  normalizeBrowserUrl,
  redactBrowserStoragePayload,
  redactBrowserText,
} from "../browser-session-manager";

describe("BrowserSessionManager helpers", () => {
  it("normalizes bare localhost and domain URLs", () => {
    expect(normalizeBrowserUrl("localhost:5173/app")).toBe("http://localhost:5173/app");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
    expect(normalizeBrowserUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("redacts common secret values and query params", () => {
    const redacted = redactBrowserText(
      "Authorization=Bearer abc123 https://example.com?access_token=secret&ok=1 password=hunter2",
    );
    expect(redacted).toContain("Authorization=[REDACTED]");
    expect(redacted).toContain("[REDACTED_PARAM]");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("hunter2");
  });

  it("redacts secret-like JSON storage keys and JSON string values", () => {
    const redacted = redactBrowserStoragePayload({
      localStorage: {
        token: "abc123",
        profile: JSON.stringify({
          password: "hunter2",
          nested: { apiKey: "key-123" },
        }),
        public: "ok",
      },
      sessionStorage: {
        authToken: "def456",
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("ok");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("key-123");
    expect(serialized).not.toContain("def456");
  });

  it("enforces disabled profile networking at the visible request boundary", () => {
    const manager = new BrowserSessionManager();
    const isAllowed = (manager as Any).isUrlAllowedWithPolicy.bind(manager);

    expect(
      isAllowed({ networkEnabled: true, accessNetworkMode: "disabled" }, "https://example.com"),
    ).toBe(false);
  });
});

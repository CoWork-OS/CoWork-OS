import { describe, expect, it } from "vitest";
import {
  isDisallowedWebhookAddress,
  normalizeWebhookMethod,
  signWebhookBody,
  validateSignedWebhookUrl,
} from "../signed-webhook";

describe("signed webhook security", () => {
  it("requires HTTPS and rejects URL credentials and local hosts", () => {
    expect(() => validateSignedWebhookUrl("http://example.com/hook")).toThrow(/HTTPS/);
    expect(() => validateSignedWebhookUrl("https://user:pass@example.com/hook")).toThrow(
      /credentials/,
    );
    expect(() => validateSignedWebhookUrl("https://localhost/hook")).toThrow(/local/);
    expect(() => validateSignedWebhookUrl("https://127.0.0.1/hook")).toThrow(/private/);
    expect(validateSignedWebhookUrl("https://hooks.example.com/path").hostname).toBe(
      "hooks.example.com",
    );
  });

  it("blocks private, link-local, metadata, multicast, and mapped addresses", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.20.1.1",
      "192.168.1.1",
      "224.0.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isDisallowedWebhookAddress(address), address).toBe(true);
    }
    expect(isDisallowedWebhookAddress("8.8.8.8")).toBe(false);
    expect(isDisallowedWebhookAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("allows only explicit write methods", () => {
    expect(normalizeWebhookMethod()).toBe("POST");
    expect(normalizeWebhookMethod("patch")).toBe("PATCH");
    expect(() => normalizeWebhookMethod("GET")).toThrow(/POST, PUT, or PATCH/);
  });

  it("produces a stable HMAC over timestamp and body", () => {
    expect(signWebhookBody("secret", "1700000000", '{"ok":true}')).toBe(
      "c1afc7c2df3db0690d7d75954610ed1a1d959ce96355ccb8c0a8bc09fd0cfc27",
    );
  });
});

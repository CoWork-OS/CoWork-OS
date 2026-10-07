import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordOAuthRefresh,
  isProvenOAuthRefresh,
  credentialFingerprint,
} from "../oauth-refresh-proof";
const source = () => ({
  type: "bearer" as const,
  token: "old-" + randomUUID(),
  refreshToken: "refresh-" + randomUUID(),
  clientId: "client",
  clientSecret: "private fixture secret",
  tokenUrl: "https://fixture.invalid/token",
  expiresAt: 1,
});
afterEach(() => vi.useRealTimers());
describe("trusted OAuth refresh evidence", () => {
  it("recognizes only recorded forward rotations, including a bounded chain", () => {
    const before = source(),
      next = { ...before, token: "next", refreshToken: "next-refresh", expiresAt: 2 },
      last = { ...next, token: "last", expiresAt: 3 };
    expect(isProvenOAuthRefresh(before, next)).toBe(false);
    recordOAuthRefresh(before, next);
    recordOAuthRefresh(next, last);
    expect(isProvenOAuthRefresh(before, last)).toBe(true);
    expect(isProvenOAuthRefresh(last, before)).toBe(false);
    expect(isProvenOAuthRefresh(before, { ...last, token: "manual" })).toBe(false);
    expect(credentialFingerprint(before)).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["clientId", "clientSecret", "tokenUrl", "type", "apiKey"])(
    "does not register a change to fixed authority %s",
    (key) => {
      const before = source(),
        after = { ...before, token: "next", [key]: "different" } as Any;
      recordOAuthRefresh(before, after);
      expect(isProvenOAuthRefresh(before, after)).toBe(false);
    },
  );
  it("expires proof without extending it on reads", () => {
    vi.useFakeTimers();
    const before = source(),
      after = { ...before, token: "new" };
    recordOAuthRefresh(before, after);
    vi.advanceTimersByTime(299999);
    expect(isProvenOAuthRefresh(before, after)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isProvenOAuthRefresh(before, after)).toBe(false);
  });
  it("rejects invalid material and permits a stable public OAuth client without a secret", () => {
    const before = source();
    const after = { ...before, token: { untrusted: true } } as Any;
    recordOAuthRefresh(before, after);
    expect(isProvenOAuthRefresh(before, after)).toBe(false);
    const missing = { ...before, clientSecret: undefined };
    recordOAuthRefresh(missing, { ...missing, token: "new" });
    expect(isProvenOAuthRefresh(missing, { ...missing, token: "new" })).toBe(true);
    const changedSecret = { ...missing, clientSecret: "added-later" };
    expect(isProvenOAuthRefresh(missing, changedSecret)).toBe(false);
    const noAccessToken = { ...before, token: undefined };
    const refreshed = { ...noAccessToken, token: "restored" };
    recordOAuthRefresh(noAccessToken, refreshed);
    expect(isProvenOAuthRefresh(noAccessToken, refreshed)).toBe(true);
  });
});

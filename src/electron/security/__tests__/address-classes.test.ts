import { describe, expect, it } from "vitest";
import {
  isBlockedInternalHost,
  isLoopbackAddress,
  isPrivateOrLoopbackAddress,
  normalizeHostname,
} from "../address-classes";

describe("address classification", () => {
  it("blocks the cloud metadata endpoint", () => {
    // The whole point: agent-supplied URLs must not reach instance metadata.
    expect(isBlockedInternalHost("169.254.169.254", true)).toBe(true);
    expect(isBlockedInternalHost("metadata.google.internal", true)).toBe(true);
    expect(isBlockedInternalHost("metadata", true)).toBe(true);
  });

  it("blocks private ranges", () => {
    for (const host of [
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "fd00::1",
      "fe80::1",
      "::",
    ]) {
      expect(isBlockedInternalHost(host, true), host).toBe(true);
    }
  });

  it("blocks IPv4-mapped IPv6 forms of private addresses", () => {
    expect(isBlockedInternalHost("::ffff:10.0.0.1", true)).toBe(true);
    expect(isBlockedInternalHost("::ffff:169.254.169.254", true)).toBe(true);
  });

  it("allows loopback when the caller permits it, and blocks it otherwise", () => {
    // Agent fetches keep loopback so a dev server the agent started stays
    // reachable; the app's own loopback services require bearer tokens.
    for (const host of ["127.0.0.1", "localhost", "app.localhost", "::1"]) {
      expect(isBlockedInternalHost(host, true), host).toBe(false);
      expect(isBlockedInternalHost(host, false), host).toBe(true);
    }
  });

  it("allows ordinary public hosts", () => {
    for (const host of ["example.com", "api.github.com", "8.8.8.8", "172.32.0.1", "11.0.0.1"]) {
      expect(isBlockedInternalHost(host, true), host).toBe(false);
    }
  });

  it("normalizes brackets, trailing dots, and case", () => {
    expect(normalizeHostname("[::1]")).toBe("::1");
    expect(normalizeHostname("Example.COM.")).toBe("example.com");
    expect(isLoopbackAddress("[::1]")).toBe(true);
    expect(isBlockedInternalHost("LOCALHOST.", true)).toBe(false);
    expect(isBlockedInternalHost("LOCALHOST.", false)).toBe(true);
  });

  it("does not classify a public hostname as private", () => {
    expect(isPrivateOrLoopbackAddress("example.com")).toBe(false);
  });

  it("treats an empty host as blocked", () => {
    expect(isBlockedInternalHost("", true)).toBe(true);
  });
});

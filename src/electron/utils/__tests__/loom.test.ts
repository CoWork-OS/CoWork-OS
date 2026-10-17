import { describe, expect, it } from "vitest";
import {
  assertSafeLoomBaseUrl,
  assertSafeLoomMailboxFolder,
  isLocalhostHost,
  isSecureOrLocalLoomUrl,
  normalizeLoomBaseUrl,
} from "../loom";

describe("isLocalhostHost", () => {
  it("accepts every spelling of IPv6 loopback", () => {
    expect(isLocalhostHost("::1")).toBe(true);
    expect(isLocalhostHost("[::1]")).toBe(true);
    // The WHATWG parser hands back the bracketed form.
    expect(new URL("http://[::1]:8787").hostname).toBe("[::1]");
  });

  it("accepts IPv4 loopback and localhost in any case or with a root dot", () => {
    for (const host of ["localhost", "LOCALHOST", "localhost.", "127.0.0.1"]) {
      expect(isLocalhostHost(host)).toBe(true);
    }
  });

  it("rejects remote hosts and empty input", () => {
    for (const host of ["example.com", "::2", "10.0.0.1", ""]) {
      expect(isLocalhostHost(host)).toBe(false);
    }
  });
});

describe("isSecureOrLocalLoomUrl", () => {
  it("accepts IPv6 loopback over plain http", () => {
    expect(isSecureOrLocalLoomUrl("http://[::1]:8787")).toBe(true);
    expect(isSecureOrLocalLoomUrl("http://[::1]")).toBe(true);
  });

  it("still accepts the other local forms and any https URL", () => {
    expect(isSecureOrLocalLoomUrl("http://localhost:8787")).toBe(true);
    expect(isSecureOrLocalLoomUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isSecureOrLocalLoomUrl("https://example.com")).toBe(true);
    expect(isSecureOrLocalLoomUrl("https://[2606:4700::1111]")).toBe(true);
  });

  it("still rejects plain http to a remote host and malformed input", () => {
    expect(isSecureOrLocalLoomUrl("http://example.com")).toBe(false);
    expect(isSecureOrLocalLoomUrl("not a url")).toBe(false);
    expect(isSecureOrLocalLoomUrl("")).toBe(false);
  });
});

describe("assertSafeLoomBaseUrl", () => {
  it("returns the parsed URL for IPv6 loopback", () => {
    expect(assertSafeLoomBaseUrl("http://[::1]:8787/").hostname).toBe("[::1]");
  });

  it("throws for a remote plain-http URL", () => {
    expect(() => assertSafeLoomBaseUrl("http://example.com")).toThrow(/HTTPS/);
  });

  it("throws for a malformed URL", () => {
    expect(() => assertSafeLoomBaseUrl("nonsense")).toThrow(/valid URL/);
  });
});

describe("normalizeLoomBaseUrl", () => {
  it("strips trailing slashes and keeps the port", () => {
    const normalized = normalizeLoomBaseUrl("http://[::1]:8787/api///");
    expect(normalized.pathname).toBe("/api");
    expect(normalized.port).toBe("8787");
  });

  it("gives the root path when the URL has none", () => {
    expect(normalizeLoomBaseUrl("https://example.com").pathname).toBe("/");
  });
});

describe("assertSafeLoomMailboxFolder", () => {
  it("defaults empty input to INBOX", () => {
    expect(assertSafeLoomMailboxFolder("")).toBe("INBOX");
    expect(assertSafeLoomMailboxFolder(undefined)).toBe("INBOX");
    expect(assertSafeLoomMailboxFolder("   ")).toBe("INBOX");
  });

  it("keeps ordinary folder names", () => {
    expect(assertSafeLoomMailboxFolder("Sent Items")).toBe("Sent Items");
    expect(assertSafeLoomMailboxFolder("Archive/2026")).toBe("Archive/2026");
  });

  it("rejects traversal and invalid characters", () => {
    expect(() => assertSafeLoomMailboxFolder("../INBOX")).toThrow(/invalid characters/);
    expect(() => assertSafeLoomMailboxFolder("A..B")).toThrow(/invalid characters/);
    expect(() => assertSafeLoomMailboxFolder("Inbox*")).toThrow(/invalid characters/);
  });
});

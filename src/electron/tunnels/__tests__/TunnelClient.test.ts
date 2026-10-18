import { describe, expect, it, vi } from "vitest";
import { assertAllowedRelayUrl } from "../TunnelClient";

vi.mock("../settings", () => ({
  SecureMcpTunnelSettingsManager: {},
}));

describe("assertAllowedRelayUrl", () => {
  it("accepts HTTPS relays on any host", () => {
    expect(() => assertAllowedRelayUrl("https://relay.example.com")).not.toThrow();
  });

  it("accepts plain HTTP relays on loopback, including bracketed IPv6", () => {
    // new URL() keeps IPv6 hostnames bracketed ("[::1]"), which a bare "::1"
    // comparison used to reject.
    for (const url of [
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
      "http://[0:0:0:0:0:0:0:1]:8787",
    ]) {
      expect(() => assertAllowedRelayUrl(url), url).not.toThrow();
    }
  });

  it("rejects plain HTTP to the root-dot form of localhost", () => {
    expect(() => assertAllowedRelayUrl("http://localhost.:8787")).toThrow(
      "Plain HTTP tunnel relays are only allowed on loopback hosts",
    );
  });

  it("rejects plain HTTP relays on remote and private hosts", () => {
    for (const url of [
      "http://relay.example.com",
      "http://10.0.0.5:8787",
      "http://[fd00::1]:8787",
      "http://[2001:db8::1]:8787",
    ]) {
      expect(() => assertAllowedRelayUrl(url), url).toThrow(
        "Plain HTTP tunnel relays are only allowed on loopback hosts",
      );
    }
  });

  it("rejects non-HTTP schemes", () => {
    expect(() => assertAllowedRelayUrl("ftp://127.0.0.1")).toThrow(
      "Tunnel relay URL must use HTTPS, or HTTP for loopback development",
    );
  });
});

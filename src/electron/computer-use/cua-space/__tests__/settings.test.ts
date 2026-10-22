import { describe, expect, it } from "vitest";
import { resolveCuaSpaceEndpoint } from "../settings";

describe("resolveCuaSpaceEndpoint", () => {
  it("allows a tokenless loopback Space and normalizes to the origin", () => {
    const endpoint = resolveCuaSpaceEndpoint("http://127.0.0.1:3211/some/path", undefined);
    expect(endpoint).toEqual({
      origin: "http://127.0.0.1:3211",
      mcpUrl: "http://127.0.0.1:3211/mcp",
      healthUrl: "http://127.0.0.1:3211/health",
      loopback: true,
    });
  });

  it("allows plain http to a private-network Space when a token is set", () => {
    const endpoint = resolveCuaSpaceEndpoint("http://192.168.64.5:3211", "secret");
    expect(endpoint.mcpUrl).toBe("http://192.168.64.5:3211/mcp");
    expect(endpoint.loopback).toBe(false);
  });

  it("requires a token for non-loopback Spaces", () => {
    expect(() => resolveCuaSpaceEndpoint("http://192.168.64.5:3211", undefined)).toThrow(
      /token is required/,
    );
  });

  it("refuses plain http to public hosts", () => {
    expect(() => resolveCuaSpaceEndpoint("http://spaces.example.com", "secret")).toThrow(/https/);
    expect(() => resolveCuaSpaceEndpoint("http://8.8.8.8:3211", "secret")).toThrow(/https/);
    expect(resolveCuaSpaceEndpoint("https://spaces.example.com", "secret").mcpUrl).toBe(
      "https://spaces.example.com/mcp",
    );
  });

  it("does not treat lookalike hosts as private or loopback", () => {
    expect(() => resolveCuaSpaceEndpoint("http://192.168.64.5.evil.com", "secret")).toThrow(
      /https/,
    );
    expect(() => resolveCuaSpaceEndpoint("http://127.0.0.1.nip.io", undefined)).toThrow();
    expect(() => resolveCuaSpaceEndpoint("http://space.localhost:3211", undefined)).toThrow();
    expect(() => resolveCuaSpaceEndpoint("http://172.32.0.1", "secret")).toThrow(/https/);
  });

  it("canonicalizes IPv4-mapped and alternate IPv4 forms before classifying", () => {
    expect(resolveCuaSpaceEndpoint("http://[::ffff:127.0.0.1]:3211", undefined).loopback).toBe(
      true,
    );
    expect(resolveCuaSpaceEndpoint("http://0x7f.1:3211", undefined).loopback).toBe(true);
    expect(resolveCuaSpaceEndpoint("http://[fe80::1]:3211", "secret").loopback).toBe(false);
    expect(() => resolveCuaSpaceEndpoint("http://[::ffff:8.8.8.8]", "secret")).toThrow(/https/);
  });

  it("rejects credentials in the URL and non-http schemes", () => {
    expect(() => resolveCuaSpaceEndpoint("http://u:p@127.0.0.1:3211", undefined)).toThrow(
      /credentials/,
    );
    expect(() => resolveCuaSpaceEndpoint("file:///etc/passwd", undefined)).toThrow(/http/);
    expect(() => resolveCuaSpaceEndpoint("not a url", undefined)).toThrow(/valid URL/);
  });
});

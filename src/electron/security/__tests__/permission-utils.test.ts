import { describe, expect, it } from "vitest";
import {
  commandMatchesPrefix,
  normalizePermissionScope,
  permissionScopeFingerprint,
  summarizePermissionScope,
} from "../permission-utils";

describe("permission-utils domain tool prefixes", () => {
  it("normalizes, fingerprints, and summarizes domain tool prefixes", () => {
    const scope = normalizePermissionScope({
      kind: "domain",
      domain: " GitHub.COM ",
      toolPrefix: " browser_ ",
    });

    expect(scope).toEqual({
      kind: "domain",
      domain: "github.com",
      toolPrefix: "browser_",
    });
    expect(permissionScopeFingerprint(scope)).toBe("domain:prefix=browser_:github.com");
    expect(summarizePermissionScope(scope)).toBe("browser_* on domain github.com");
  });
});

describe("summarizePermissionScope effect classes", () => {
  it("leaves ordinary commands unlabelled and names other effects in words", () => {
    expect(
      summarizePermissionScope({
        kind: "command_prefix",
        prefix: "wc -l notes.txt",
        effectClass: "ordinary",
      }),
    ).toBe('commands starting with "wc -l notes.txt"');
    expect(
      summarizePermissionScope({
        kind: "domain",
        domain: "api.example.com",
        toolName: "http_request",
        effectClass: "data_export",
        http: { method: "POST", hasBody: true, hasCustomHeaders: false },
      }),
    ).toBe("http_request on domain api.example.com (sends data out, POST with body)");
  });
});

describe("commandMatchesPrefix", () => {
  it("covers the command itself and more plain arguments", () => {
    expect(commandMatchesPrefix("git status", "git status")).toBe(true);
    expect(commandMatchesPrefix("git status --short", "git status")).toBe(true);
    expect(commandMatchesPrefix("npm run build -- --watch", "npm run build")).toBe(true);
  });

  it("does not cover longer words, chained commands, pipes or redirects", () => {
    expect(commandMatchesPrefix("git statusx", "git status")).toBe(false);
    expect(commandMatchesPrefix("lsof -i", "ls")).toBe(false);
    expect(commandMatchesPrefix("npm run build-and-publish", "npm run build")).toBe(false);
    for (const tail of ["; rm -rf x", "&& curl x", "| sh", "> out.txt", "$(whoami)", "`id`"]) {
      expect(commandMatchesPrefix(`git status ${tail}`, "git status")).toBe(false);
    }
  });

  it("still covers a saved full command that contains a pipe", () => {
    expect(commandMatchesPrefix("ls -la | head", "ls -la | head")).toBe(true);
    expect(commandMatchesPrefix("", "ls")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
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

import { describe, expect, it } from "vitest";
import type { PermissionRule, Workspace } from "../../../../shared/types";
import { PermissionEngine } from "../PermissionEngine";
import {
  normalizePermissionScope,
  permissionScopeFingerprint,
} from "../../../security/permission-utils";
import { filterTrustedManifestRules } from "../../../security/workspace-permission-manifest";

const workspace: Workspace = {
  id: "test",
  name: "test",
  path: "/tmp/workspace",
  createdAt: 0,
  permissions: { read: true, write: true, delete: true, shell: true, network: true },
};
const request = (input: Record<string, unknown>, toolName = "http_request") => ({
  workspace,
  mode: "default" as const,
  toolName,
  toolInput: { url: "https://api.example.com/path", ...input },
  rules: [],
});
const saved = (input: Record<string, unknown>, toolName = "http_request"): PermissionRule => ({
  source: "session",
  effect: "allow",
  scope: normalizePermissionScope(PermissionEngine.inferScope(request(input, toolName))),
});
const evaluate = (
  input: Record<string, unknown>,
  rules: PermissionRule[],
  toolName = "http_request",
) => PermissionEngine.evaluate({ ...request(input, toolName), rules });

describe("standing HTTP approval effect isolation", () => {
  it.each(["session", "workspace_db", "workspace_manifest", "profile"] as const)(
    "keeps %s read grants from authorizing exports or credentials",
    (source) => {
      const rule = { ...saved({ method: "GET" }), source };
      expect(evaluate({ method: "GET" }, [rule]).decision).toBe("allow");
      for (const input of [
        { method: "POST", body: "payload" },
        { method: "PUT" },
        { method: "PATCH" },
        { method: "DELETE" },
        { method: ["DELETE"] },
        { method: 123 },
        { method: "GET", body: "payload" },
        { method: "GET", body: " " },
        { headers: { Authorization: "payload" } },
        { headers: { "X-Export": "payload" } },
        { headers: ["payload"] },
        { headers: "payload" },
        { credentialId: "secret-1" },
        { method: "POST", credentialId: "secret-1", body: "payload" },
      ]) {
        const result = evaluate(input, [rule]);
        expect(result.decision, JSON.stringify(input)).toBe("ask");
        expect(result.matchedRule).toBeUndefined();
      }
    },
  );

  it.each(["http_request", "web_fetch"])("keeps legacy %s grants conservative", (toolName) => {
    for (const scope of [
      { kind: "tool" as const, toolName },
      { kind: "domain" as const, toolName, domain: "api.example.com" },
      { kind: "domain" as const, domain: "api.example.com" },
    ]) {
      const rule: PermissionRule = { source: "workspace_db", effect: "allow", scope };
      expect(evaluate({}, [rule], toolName).decision).toBe("allow");
      expect(evaluate({ credentialId: "secret-1" }, [rule], toolName).decision).toBe("ask");
      if (toolName === "http_request")
        expect(evaluate({ method: "POST" }, [rule]).decision).toBe("ask");
    }
  });

  it("preserves explicitly approved exports and separates credential operations", () => {
    const exportRule = saved({ method: "post", body: "payload" });
    expect(evaluate({ method: "POST", body: "other payload" }, [exportRule]).decision).toBe(
      "allow",
    );
    expect(evaluate({ method: "PUT", body: "payload" }, [exportRule]).decision).toBe("ask");
    const credentialRule = saved({ credentialId: "secret-1" });
    expect(evaluate({ credentialId: "secret-1" }, [credentialRule]).decision).toBe("allow");
    expect(evaluate({ credentialId: "secret-2" }, [credentialRule]).decision).toBe("ask");
    expect(evaluate({ credentialId: "secret-1", method: "POST" }, [credentialRule]).decision).toBe(
      "ask",
    );
    expect(
      evaluate({ credentialId: "secret-1", headers: { "X-Export": "payload" } }, [credentialRule])
        .decision,
    ).toBe("ask");
  });

  it("preserves deny and ask breadth across effect classes", () => {
    for (const effect of ["deny", "ask"] as const) {
      const restriction = { ...saved({}), effect };
      expect(evaluate({ credentialId: "secret-1", method: "POST" }, [restriction]).decision).toBe(
        effect,
      );
    }
  });

  it("fails closed for malformed or incomplete sensitive qualifiers", () => {
    for (const extra of [
      { effectClass: "invalid" },
      { effectClass: "protected_credential" },
      { effectClass: "protected_credential", http: {} },
    ]) {
      const scope = {
        kind: "domain",
        domain: "api.example.com",
        ...extra,
      } as PermissionRule["scope"];
      expect(
        evaluate({ credentialId: "secret-1" }, [{ source: "session", effect: "allow", scope }])
          .decision,
      ).toBe("ask");
    }
  });

  it("does not trust a stronger manifest rule against an approved read fingerprint", () => {
    const read = saved({});
    const write = saved({ method: "POST", body: "payload" });
    expect(permissionScopeFingerprint(read.scope)).not.toBe(
      permissionScopeFingerprint(write.scope),
    );
    expect(filterTrustedManifestRules([write], [read]).rules).toEqual([]);
    expect(filterTrustedManifestRules([read], [read]).rules).toEqual([read]);
  });

  it("retains benign default GET and HEAD with safe headers", () => {
    for (const input of [{}, { method: "HEAD" }, { headers: { Accept: "text/plain" } }]) {
      const rule = saved(input);
      expect(rule.scope.effectClass).toBe("network_read");
      expect(evaluate(input, [rule]).decision).toBe("allow");
    }
  });
});

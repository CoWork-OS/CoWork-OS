import { beforeEach, describe, expect, it, vi } from "vitest";

import { GuardrailManager } from "../../guardrails/guardrail-manager";
import { domainMatches, evaluateNetworkPolicy } from "../network-policy";

vi.mock("../../admin/policies", () => ({
  loadPolicies: vi.fn(() => ({
    runtime: {
      network: {
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        allowShellNetwork: false,
      },
    },
  })),
}));

import { loadPolicies } from "../../admin/policies";

describe("evaluateNetworkPolicy", () => {
  beforeEach(() => {
    vi.mocked(loadPolicies).mockReturnValue({
      version: 1,
      updatedAt: new Date().toISOString(),
      packs: { allowed: [], blocked: [], required: [] },
      connectors: { blocked: [] },
      agents: { maxHeartbeatFrequencySec: 60, maxConcurrentAgents: 10 },
      runtime: {
        allowedPermissionModes: [],
        allowedSandboxTypes: ["macos", "docker"],
        requireSandboxForShell: true,
        allowUnsandboxedShell: true,
        network: {
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: [],
          allowShellNetwork: false,
        },
        autoReview: { enabled: true },
        telemetry: { enabled: false },
      },
      general: {
        allowCustomPacks: true,
        allowGitInstall: true,
        allowUrlInstall: true,
      },
    });
    vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValue(true);
  });

  it("denies admin-blocked domains before legacy guardrails", () => {
    vi.mocked(loadPolicies).mockReturnValueOnce({
      ...loadPolicies(),
      runtime: {
        ...loadPolicies().runtime,
        network: {
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: ["*.example.com"],
          allowShellNetwork: false,
        },
      },
    });

    const decision = evaluateNetworkPolicy({
      url: "https://api.example.com/v1",
      toolName: "web_fetch",
    });

    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("blocked_domain");
    expect(decision.ruleSource).toBe("admin_policy");
  });

  it("allows explicit admin allowlist matches", () => {
    vi.mocked(loadPolicies).mockReturnValueOnce({
      ...loadPolicies(),
      runtime: {
        ...loadPolicies().runtime,
        network: {
          defaultAction: "deny",
          allowedDomains: ["docs.example.com"],
          blockedDomains: [],
          allowShellNetwork: false,
        },
      },
    });

    const decision = evaluateNetworkPolicy({
      url: "https://docs.example.com/reference",
      toolName: "web_fetch",
    });

    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("admin_allowlist_match");
  });

  it("falls back to legacy guardrail domain decisions", () => {
    vi.spyOn(GuardrailManager, "isDomainAllowed").mockReturnValueOnce(false);

    const decision = evaluateNetworkPolicy({
      url: "https://blocked.example",
      toolName: "browser_navigate",
    });

    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("legacy_guardrail_domain_denied");
    expect(decision.ruleSource).toBe("legacy_guardrails");
  });

  it("redacts credentials, query strings, and fragments from returned policy URLs", () => {
    const decision = evaluateNetworkPolicy({
      url: "https://user:pass@docs.example.com/oauth/callback?code=secret-code&access_token=secret-token#frag",
      toolName: "web_fetch",
    });

    expect(decision.action).toBe("allow");
    expect(decision.url).toBe("https://docs.example.com/oauth/callback");
    expect(decision.url).not.toContain("secret");
    expect(decision.url).not.toContain("user:pass");
    expect(decision.url).not.toContain("#frag");
  });

  it("distinguishes apex and subdomain wildcard patterns", () => {
    expect(domainMatches("example.com", "**.example.com")).toBe(true);
    expect(domainMatches("api.example.com", "**.example.com")).toBe(true);
    expect(domainMatches("example.com", "*.example.com")).toBe(false);
    expect(domainMatches("api.example.com", "*.example.com")).toBe(true);
    expect(domainMatches("API.EXAMPLE.COM.", "api.example.com")).toBe(true);
    expect(domainMatches("anything.example.com", "*")).toBe(true);
  });

  it("enforces profile domain deny and allow rules before admin or legacy rules", () => {
    const denied = evaluateNetworkPolicy({
      url: "https://private.example.com/secret",
      toolName: "web_fetch",
      profileDomainRules: [{ access: "deny", pattern: "**.example.com" }],
    });
    const outsideAllowlist = evaluateNetworkPolicy({
      url: "https://other.test/reference",
      toolName: "web_fetch",
      profileDomainRules: [{ access: "allow", pattern: "docs.example.com" }],
    });

    expect(denied).toMatchObject({
      action: "deny",
      reason: "profile_domain_denied",
      ruleSource: "access_profile",
      matchedRule: "**.example.com",
    });
    expect(outsideAllowlist).toMatchObject({
      action: "deny",
      reason: "profile_domain_not_allowed",
      ruleSource: "access_profile",
    });
  });

  it("denies network requests when the resolved workspace profile disables network", () => {
    const decision = evaluateNetworkPolicy({
      url: "https://docs.example.com/reference",
      toolName: "web_fetch",
      networkEnabled: false,
    });

    expect(decision).toMatchObject({
      action: "deny",
      reason: "workspace_network_disabled",
      ruleSource: "workspace_permissions",
    });
  });

  it("denies direct callers that only carry the disabled profile metadata", () => {
    const decision = evaluateNetworkPolicy({
      url: "https://docs.example.com/reference",
      toolName: "web_fetch",
      networkEnabled: true,
      accessNetworkMode: "disabled",
    });

    expect(decision).toMatchObject({
      action: "deny",
      reason: "profile_network_disabled",
      ruleSource: "access_profile",
    });
  });
});

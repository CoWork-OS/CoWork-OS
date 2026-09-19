import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../guardrails/guardrail-manager", () => ({
  GuardrailManager: { isDomainAllowed: () => true },
}));

vi.mock("../../admin/policies", () => ({
  loadPolicies: vi.fn(),
}));

import { loadPolicies } from "../../admin/policies";
import { evaluateNetworkPolicy } from "../network-policy";

type Any = any; // oxlint-disable-line typescript-eslint(no-explicit-any)

function policiesWith(allowedInternalHosts: string[] | undefined): Any {
  return {
    runtime: {
      network: {
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        allowedInternalHosts,
        allowShellNetwork: false,
      },
    },
  };
}

describe("internal-address boundary and its admin escape hatch", () => {
  beforeEach(() => {
    vi.mocked(loadPolicies).mockReturnValue(policiesWith([]));
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.20:8080/search",
    "http://10.0.0.5/",
    "http://metadata.google.internal/",
    "http://build.corp.internal/",
  ])("denies %s by default", (url) => {
    expect(evaluateNetworkPolicy({ url, toolName: "web_fetch" })).toMatchObject({
      action: "deny",
      reason: "internal_address_blocked",
    });
  });

  it("keeps loopback reachable so the agent can fetch a dev server it started", () => {
    expect(
      evaluateNetworkPolicy({ url: "http://127.0.0.1:5173/", toolName: "web_fetch" }).action,
    ).toBe("allow");
  });

  it("re-opens only the internal host an administrator named", () => {
    vi.mocked(loadPolicies).mockReturnValue(policiesWith(["192.168.1.20"]));

    expect(
      evaluateNetworkPolicy({ url: "http://192.168.1.20:8080/search", toolName: "web_search" })
        .action,
    ).toBe("allow");
    // The metadata endpoint is not covered by that entry.
    expect(
      evaluateNetworkPolicy({ url: "http://169.254.169.254/", toolName: "web_fetch" }),
    ).toMatchObject({ action: "deny", reason: "internal_address_blocked" });
  });

  it("fails closed when the policy predates the field", () => {
    vi.mocked(loadPolicies).mockReturnValue(policiesWith(undefined));

    expect(
      evaluateNetworkPolicy({ url: "http://169.254.169.254/", toolName: "web_fetch" }),
    ).toMatchObject({ action: "deny", reason: "internal_address_blocked" });
  });

  it("does not let a broad allowedDomains entry open the boundary", () => {
    const policies = policiesWith([]);
    policies.runtime.network.allowedDomains = ["*"];
    vi.mocked(loadPolicies).mockReturnValue(policies);

    expect(
      evaluateNetworkPolicy({ url: "http://169.254.169.254/", toolName: "web_fetch" }),
    ).toMatchObject({ action: "deny", reason: "internal_address_blocked" });
  });
});

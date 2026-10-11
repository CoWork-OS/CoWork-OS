import { describe, expect, it } from "vitest";
import { canEnableSubprocessNetwork } from "../subprocess-network-policy";
import type { AdminPolicies } from "../../admin/policies";
const permissions = { network: true, read: true, write: true, delete: false, shell: true };
function policy(network = {}) {
  return {
    runtime: {
      network: {
        allowShellNetwork: true,
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        ...network,
      },
    },
  } as AdminPolicies;
}
describe("subprocess network authority", () => {
  it.each([
    { allowShellNetwork: false },
    { defaultAction: "deny" },
    { allowedDomains: ["example.com"] },
    { blockedDomains: ["example.com"] },
  ])("refuses unenforceable administrator rules %j", (network) => {
    expect(canEnableSubprocessNetwork(permissions, policy(network))).toBe(false);
  });
  it("retains explicitly unrestricted access and rejects disabled or scoped workspace access", () => {
    expect(canEnableSubprocessNetwork(permissions, policy())).toBe(true);
    expect(
      canEnableSubprocessNetwork({ ...permissions, accessNetworkMode: "disabled" }, policy()),
    ).toBe(false);
    expect(
      canEnableSubprocessNetwork(
        { ...permissions, accessDomainRules: [{ pattern: "example.com", access: "allow" }] },
        policy(),
      ),
    ).toBe(false);
  });
  it("denies on-request networking even with unrestricted administrator policy", () => {
    expect(
      canEnableSubprocessNetwork({ ...permissions, accessNetworkMode: "on-request" }, policy()),
    ).toBe(false);
    expect(canEnableSubprocessNetwork({ ...permissions, network: false }, policy())).toBe(false);
    expect(
      canEnableSubprocessNetwork({ ...permissions, accessNetworkMode: "enabled" }, policy()),
    ).toBe(true);
  });
  it("allows an invocation-local grant only within unrestricted network authority", () => {
    const requested = { ...permissions, accessNetworkMode: "on-request" as const };
    expect(canEnableSubprocessNetwork(requested, policy(), true)).toBe(true);
    expect(canEnableSubprocessNetwork(requested, policy())).toBe(false);
    for (const network of [
      { allowShellNetwork: false },
      { defaultAction: "deny" },
      { allowedDomains: ["example.com"] },
      { blockedDomains: ["example.com"] },
    ]) {
      expect(canEnableSubprocessNetwork(requested, policy(network), true)).toBe(false);
    }
    expect(canEnableSubprocessNetwork({ ...requested, network: false }, policy(), true)).toBe(
      false,
    );
    expect(
      canEnableSubprocessNetwork({ ...requested, accessNetworkMode: "disabled" }, policy(), true),
    ).toBe(false);
    expect(
      canEnableSubprocessNetwork(
        { ...requested, accessDomainRules: [{ pattern: "example.com", access: "allow" }] },
        policy(),
        true,
      ),
    ).toBe(false);
  });
});

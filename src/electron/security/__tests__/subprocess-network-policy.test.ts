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
});

import { loadPolicies, type AdminPolicies } from "../admin/policies";
import type { Workspace } from "../../shared/types";

/**
 * Policy eligibility only: callers must also authorize the specific invocation
 * before enabling on-request networking. Coarse process sandboxes cannot
 * enforce hostname-scoped network rules.
 * A shell classifier is only a hint: arbitrary code can construct networking
 * primitives at runtime. Keep subprocesses offline until an invocation-bound
 * network grant is authorized by the execution layer.
 */
export function canEnableSubprocessNetwork(
  permissions: Workspace["permissions"],
  policies: AdminPolicies = loadPolicies(),
  invocationApproved = false,
): boolean {
  const network = policies.runtime.network;
  return (
    permissions?.network === true &&
    permissions.accessNetworkMode !== "disabled" &&
    (permissions.accessNetworkMode !== "on-request" || invocationApproved) &&
    !permissions.accessDomainRules?.length &&
    network.allowShellNetwork === true &&
    network.defaultAction === "allow" &&
    network.allowedDomains.length === 0 &&
    network.blockedDomains.length === 0
  );
}

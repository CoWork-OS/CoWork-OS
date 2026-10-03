import { loadPolicies, type AdminPolicies } from "../admin/policies";
import type { Workspace } from "../../shared/types";

/** Coarse process sandboxes cannot enforce hostname-scoped network rules. */
export function canEnableSubprocessNetwork(
  permissions: Workspace["permissions"],
  policies: AdminPolicies = loadPolicies(),
): boolean {
  const network = policies.runtime.network;
  return (
    permissions?.network === true &&
    permissions.accessNetworkMode !== "disabled" &&
    !permissions.accessDomainRules?.length &&
    network.allowShellNetwork === true &&
    network.defaultAction === "allow" &&
    network.allowedDomains.length === 0 &&
    network.blockedDomains.length === 0
  );
}

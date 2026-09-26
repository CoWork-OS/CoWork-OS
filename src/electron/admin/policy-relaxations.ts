import type { AdminPolicies } from "./policies";

/**
 * Describe the ways an admin-policy update would weaken CoWork's safety boundaries.
 *
 * Renderer code can call ADMIN_POLICIES_UPDATE directly, so a compromised or buggy page
 * could quietly turn off sandboxing or open the network. The main process uses this list
 * to require the user's confirmation in a native dialog before saving such a change.
 */
export function describePolicyRelaxations(current: AdminPolicies, next: AdminPolicies): string[] {
  const changes: string[] = [];
  const now = current.runtime;
  const then = next.runtime;

  if (now.requireSandboxForShell && !then.requireSandboxForShell) {
    changes.push("Stop requiring an OS sandbox for shell commands");
  }
  if (!now.allowUnsandboxedShell && then.allowUnsandboxedShell) {
    changes.push("Allow shell commands to run without a sandbox");
  }
  const addedSandboxTypes = then.allowedSandboxTypes.filter(
    (type) => !now.allowedSandboxTypes.includes(type),
  );
  if (addedSandboxTypes.includes("none")) {
    changes.push('Allow the "none" (unsandboxed) sandbox type');
  }
  if (
    now.allowedPermissionModes.length > 0 &&
    (then.allowedPermissionModes.length === 0 ||
      then.allowedPermissionModes.some((mode) => !now.allowedPermissionModes.includes(mode)))
  ) {
    changes.push("Allow additional permission modes");
  }

  if (now.network.defaultAction !== "allow" && then.network.defaultAction === "allow") {
    changes.push("Allow network access by default");
  }
  if (!now.network.allowShellNetwork && then.network.allowShellNetwork) {
    changes.push("Allow shell commands to use the network");
  }
  const unblocked = now.network.blockedDomains.filter(
    (domain) => !then.network.blockedDomains.includes(domain),
  );
  if (unblocked.length > 0) {
    changes.push(`Unblock domains: ${unblocked.join(", ")}`);
  }
  const newlyAllowed = then.network.allowedDomains.filter(
    (domain) => !now.network.allowedDomains.includes(domain),
  );
  if (newlyAllowed.length > 0 && now.network.defaultAction !== "allow") {
    changes.push(`Allow domains: ${newlyAllowed.join(", ")}`);
  }
  const newInternalHosts = then.network.allowedInternalHosts.filter(
    (host) => !now.network.allowedInternalHosts.includes(host),
  );
  if (newInternalHosts.length > 0) {
    changes.push(`Allow internal network hosts: ${newInternalHosts.join(", ")}`);
  }

  if (!now.autoReview.enabled && then.autoReview.enabled) {
    changes.push("Automatically approve low-risk permission prompts");
  }
  if (
    then.telemetry.enabled &&
    (!now.telemetry.enabled || now.telemetry.otlpEndpoint !== then.telemetry.otlpEndpoint)
  ) {
    changes.push(
      `Export task-event telemetry to ${then.telemetry.otlpEndpoint || "the default endpoint"}`,
    );
  }

  if (now.agentSecurity.enabled && !then.agentSecurity.enabled) {
    changes.push("Turn off agent security monitoring");
  }
  if (now.agentSecurity.mode === "enforce" && then.agentSecurity.mode !== "enforce") {
    changes.push("Stop enforcing agent security rules (monitor only)");
  }
  if (
    now.agentSecurity.failurePolicy !== "open" &&
    then.agentSecurity.failurePolicy === "open"
  ) {
    changes.push("Allow agent actions when the security check fails");
  }

  if (current.everydayAgent.blocked && !next.everydayAgent.blocked) {
    changes.push("Unblock the Everyday Agent");
  }
  if (current.everydayAgent.forceReviewOnly && !next.everydayAgent.forceReviewOnly) {
    changes.push("Stop forcing review for Everyday Agent actions");
  }

  const unblockedConnectors = current.connectors.blocked.filter(
    (id) => !next.connectors.blocked.includes(id),
  );
  if (unblockedConnectors.length > 0) {
    changes.push(`Unblock connectors: ${unblockedConnectors.join(", ")}`);
  }
  const unblockedPacks = current.packs.blocked.filter((id) => !next.packs.blocked.includes(id));
  if (unblockedPacks.length > 0) {
    changes.push(`Unblock plugin packs: ${unblockedPacks.join(", ")}`);
  }
  // An empty allowlist allows every pack.
  if (current.packs.allowed.length > 0) {
    if (next.packs.allowed.length === 0) {
      changes.push("Allow all plugin packs");
    } else {
      const newlyAllowedPacks = next.packs.allowed.filter(
        (id) => !current.packs.allowed.includes(id),
      );
      if (newlyAllowedPacks.length > 0) {
        changes.push(`Allow plugin packs: ${newlyAllowedPacks.join(", ")}`);
      }
    }
  }
  if (next.general.orgPluginDir && next.general.orgPluginDir !== current.general.orgPluginDir) {
    changes.push(`Load organization plugin packs from ${next.general.orgPluginDir}`);
  }
  for (const [key, label] of [
    ["allowCustomPacks", "Allow installing custom plugin packs"],
    ["allowGitInstall", "Allow installing plugin packs from git"],
    ["allowUrlInstall", "Allow installing plugin packs from URLs"],
  ] as const) {
    if (!current.general[key] && next.general[key]) changes.push(label);
  }

  return changes;
}

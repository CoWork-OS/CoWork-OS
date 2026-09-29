import type { Task, Workspace } from "../../shared/types";
import { loadPolicies } from "../admin/policies";
import { resolveEffectiveAccessProfile } from "../security/access-profile-resolver";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import { TerminalPtyManager } from "./TerminalPtyManager";

/** Apply the same current shell policy before desktop or browser terminal access. */
export function assertTerminalShellAllowed(workspace: Workspace, task?: Task): void {
  const accessProfile = resolveEffectiveAccessProfile({
    task,
    workspace,
    settings: PermissionSettingsManager.loadSettings(),
    adminPolicies: loadPolicies(),
  });
  const legacyShellOverride =
    typeof task?.agentConfig?.accessProfileId !== "string" &&
    task?.agentConfig?.shellAccess === true;
  const shellAllowed = accessProfile.requestedId
    ? accessProfile.shellEnabled
    : workspace.permissions?.shell === true || legacyShellOverride;
  if (!shellAllowed) {
    TerminalPtyManager.getInstance().stopTabsForWorkspace(workspace.id, "Shell access revoked");
    throw new Error("An access profile that permits command tools is required for terminal tabs.");
  }
}

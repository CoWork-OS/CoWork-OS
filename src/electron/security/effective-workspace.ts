import type { Workspace } from "../../shared/types";
import { loadPolicies } from "../admin/policies";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "./access-profile-resolver";
import { PermissionSettingsManager } from "./permission-settings-manager";

/**
 * The workspace with its effective access profile applied (workspace profile, the user's
 * default profile and admin policies), for file writes that run outside a task, such as
 * kit edits from Settings or onboarding. Checks against the returned workspace use the
 * same filesystem rules a task in that workspace would.
 */
export function withEffectiveAccessProfile(workspace: Workspace): Workspace {
  return applyAccessProfileToWorkspace(
    workspace,
    resolveEffectiveAccessProfile({
      workspace,
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    }),
  );
}

import { loadPolicies } from "../admin/policies";
import {
  applyAccessProfileToWorkspace,
  resolveEffectiveAccessProfile,
} from "../security/access-profile-resolver";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import type { Task, Workspace } from "../../shared/types";
import type { AnswerImageNetworkContext } from "./AnswerImageService";

/** The network policy inputs for image lookups made on a task's behalf. */
export function answerImageNetworkContext(
  task: Task,
  workspace: Workspace,
): AnswerImageNetworkContext {
  const effective = applyAccessProfileToWorkspace(
    workspace,
    resolveEffectiveAccessProfile({
      task,
      workspace,
      settings: PermissionSettingsManager.loadSettings(),
      adminPolicies: loadPolicies(),
    }),
  );
  return {
    networkEnabled: effective.permissions.network,
    accessNetworkMode: effective.permissions.accessNetworkMode,
    profileDomainRules: effective.permissions.accessDomainRules,
  };
}

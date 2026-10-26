import {
  BUILTIN_ACCESS_PROFILE_IDS,
  resolveAccessProfileDefinitionWithStatus,
} from "../shared/access-profiles";
import { normalizeTaskAgentConfigForCreation } from "../shared/security/task-entrypoint";
import type { AgentConfig, PermissionSettingsData } from "../shared/types";

const PROFILE_SETTINGS = "Settings > System & Security > Permissions";

/**
 * `cowork run --access-profile`: throws before the task exists when its access profile does
 * not resolve. The task would otherwise pause at start with a read-only unavailable profile
 * and wait for a person, which an unattended run never gets. Checks the configured default
 * profile too when the run doesn't name one, since the task inherits it.
 */
export function checkRunAccessProfile(
  agentConfig: Pick<AgentConfig, "accessProfileId" | "permissionMode">,
  settings: Pick<PermissionSettingsData, "defaultAccessProfileId" | "accessProfiles">,
): void {
  const { agentConfig: taskConfig, source } = normalizeTaskAgentConfigForCreation(
    agentConfig,
    settings,
  );
  const profileId = taskConfig?.accessProfileId;
  if (!profileId || (source !== "explicit_profile" && source !== "inherited_default")) return;

  const customProfiles = settings.accessProfiles || [];
  const { status } = resolveAccessProfileDefinitionWithStatus(profileId, customProfiles);
  if (status === "resolved") return;

  const subject =
    source === "explicit_profile"
      ? `Access profile "${profileId}"`
      : `The default access profile "${profileId}"`;
  if (status === "invalid") {
    throw new Error(
      `${subject} is invalid: its "extends" chain is broken or it allows more than the profile it extends. Fix it in the desktop app: ${PROFILE_SETTINGS}.`,
    );
  }
  const customIds = customProfiles
    .map((profile) => (typeof profile?.id === "string" ? profile.id.trim() : ""))
    .filter(Boolean);
  const available = [...Object.values(BUILTIN_ACCESS_PROFILE_IDS), ...customIds].join(", ");
  throw new Error(
    `${subject} does not exist. Available profiles: ${available}. Create custom profiles in the desktop app: ${PROFILE_SETTINGS}.`,
  );
}

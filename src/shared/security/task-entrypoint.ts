import type { AccessProfileId } from "../access-profiles";
import type { AgentConfig, PermissionSettingsData } from "../types";

/**
 * The small settings surface task creators need when they persist a new task.
 * Keeping this helper independent of Electron lets the daemon and direct
 * repository callers apply exactly the same rule.
 */
export type TaskCreationAccessSettings = Pick<PermissionSettingsData, "defaultAccessProfileId">;

export interface NormalizedTaskAgentConfig {
  agentConfig?: AgentConfig;
  source: "explicit_profile" | "legacy_override" | "inherited_default" | "none";
}

/**
 * Normalize authority at the persistence boundary for a newly-created task.
 *
 * An explicit profile wins. Legacy per-task permission/shell fields are kept
 * verbatim so old callers cannot be widened by a newly configured default.
 * Otherwise the caller receives the already-migrated named default. This
 * function intentionally has no fallback to Full access when settings are
 * absent or malformed.
 */
export function normalizeTaskAgentConfigForCreation(
  agentConfig: AgentConfig | undefined,
  settings: TaskCreationAccessSettings,
): NormalizedTaskAgentConfig {
  let normalized = agentConfig ? { ...agentConfig } : undefined;
  const requestedProfile = normalized?.accessProfileId;

  if (typeof requestedProfile === "string") {
    const accessProfileId = requestedProfile.trim() as AccessProfileId;
    if (accessProfileId) {
      normalized = { ...normalized, accessProfileId };
      return { agentConfig: normalized, source: "explicit_profile" };
    }
    if (normalized) {
      const { accessProfileId: _emptyProfile, ...withoutEmptyProfile } = normalized;
      normalized = withoutEmptyProfile;
    }
  }

  // These fields are compatibility authority for persisted and older direct
  // callers. Preserve them exactly and do not attach the current profile.
  if (
    typeof normalized?.permissionMode === "string" ||
    typeof normalized?.shellAccess === "boolean"
  ) {
    return { agentConfig: normalized, source: "legacy_override" };
  }

  const defaultAccessProfileId = settings?.defaultAccessProfileId;
  if (typeof defaultAccessProfileId === "string" && defaultAccessProfileId.trim()) {
    normalized = {
      ...normalized,
      accessProfileId: defaultAccessProfileId.trim() as AccessProfileId,
    };
    return { agentConfig: normalized, source: "inherited_default" };
  }

  return { agentConfig: normalized, source: "none" };
}

/** Convenience form for callers that only need the config payload. */
export function taskAgentConfigForCreation(
  agentConfig: AgentConfig | undefined,
  settings: TaskCreationAccessSettings,
): AgentConfig | undefined {
  return normalizeTaskAgentConfigForCreation(agentConfig, settings).agentConfig;
}

import * as nodePath from "node:path";
import type {
  AccessProfileDefinition,
  AccessProfileId,
  AccessSandboxMode,
} from "../../shared/access-profiles";
import {
  BUILTIN_ACCESS_PROFILE_IDS,
  getLegacyPermissionModeForAccessProfile,
  hasAccessProfileFilesystemScope,
  hasAccessProfileScope,
  isFullAccessProfile,
  isRestrictedAccessProfile,
  resolveAccessProfileDefinition,
  resolveAccessProfileDefinitionWithStatus,
} from "../../shared/access-profiles";
import type {
  AgentConfig,
  PermissionMode,
  PermissionSettingsData,
  Task,
  Workspace,
  WorkspacePermissions,
} from "../../shared/types";
import { taskAgentConfigForCreation } from "../../shared/security/task-entrypoint";
import type { AdminPolicies } from "../admin/policies";

export interface EffectiveAccessProfile {
  id: AccessProfileId;
  /** Undefined when a legacy task has not selected a named profile. */
  requestedId?: AccessProfileId;
  definition: AccessProfileDefinition;
  permissionMode: PermissionMode;
  sandboxMode: AccessSandboxMode;
  requiresSandbox: boolean;
  shellEnabled: boolean;
  networkEnabled: boolean;
  adminConstrained: boolean;
  /** True when the requested named profile could not be resolved safely. */
  profileUnavailable: boolean;
  /** True when a named profile has a finite filesystem or domain boundary. */
  profileScoped: boolean;
  /** True when a named profile has a finite filesystem boundary. */
  filesystemScoped: boolean;
  constraintReason?: string;
}

/**
 * Attach the configured named profile to a newly-created task unless the
 * caller explicitly selected a profile or supplied a legacy permission
 * override. This keeps the default profile authoritative for modern task
 * creation while preserving the behavior of older callers and persisted
 * tasks that still use permissionMode/shellAccess.
 */
export function applyDefaultAccessProfile(
  agentConfig: AgentConfig | undefined,
  settings: PermissionSettingsData,
): AgentConfig | undefined {
  return taskAgentConfigForCreation(agentConfig, settings);
}

interface ResolveAccessProfileInput {
  task?: Pick<Task, "agentConfig"> & Partial<Pick<Task, "workerRole">>;
  workspace?: Pick<Workspace, "permissions" | "path">;
  settings?: PermissionSettingsData;
  adminPolicies?: AdminPolicies;
}

const LEGACY_PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "plan",
  "dangerous_only",
  "accept_edits",
  "dont_ask",
  "bypass_permissions",
]);

function getRequestedProfileId(
  task: ResolveAccessProfileInput["task"],
  settings: PermissionSettingsData,
): AccessProfileId {
  const taskProfileId = task?.agentConfig?.accessProfileId;
  if (typeof taskProfileId === "string" && taskProfileId.trim()) {
    return taskProfileId.trim();
  }

  if (
    typeof settings.defaultAccessProfileId === "string" &&
    settings.defaultAccessProfileId.trim()
  ) {
    return settings.defaultAccessProfileId.trim();
  }

  return settings.defaultPermissionAccess === "full"
    ? BUILTIN_ACCESS_PROFILE_IDS.fullAccess
    : BUILTIN_ACCESS_PROFILE_IDS.askForApproval;
}

function getLegacyMode(task: ResolveAccessProfileInput["task"]): PermissionMode | undefined {
  const value = task?.agentConfig?.permissionMode;
  return typeof value === "string" && LEGACY_PERMISSION_MODES.has(value) ? value : undefined;
}

function chooseAdminFallbackMode(
  requested: PermissionMode,
  policies: AdminPolicies | undefined,
): PermissionMode {
  const allowed = policies?.runtime.allowedPermissionModes || [];
  if (allowed.length === 0 || allowed.includes(requested)) return requested;
  return (
    allowed.find((mode) => mode === "default") ||
    allowed.find((mode) => mode === "dangerous_only") ||
    allowed[0] ||
    "default"
  );
}

function profileForMode(mode: PermissionMode): AccessProfileDefinition {
  if (mode === "bypass_permissions") {
    return resolveAccessProfileDefinition(BUILTIN_ACCESS_PROFILE_IDS.fullAccess);
  }
  if (mode === "plan") {
    return {
      ...resolveAccessProfileDefinition(BUILTIN_ACCESS_PROFILE_IDS.askForApproval),
      id: "legacy_plan",
      label: "Legacy plan mode",
      description: "Read-only compatibility mode.",
      sandbox: "read-only",
      network: "disabled",
    };
  }
  return resolveAccessProfileDefinition(BUILTIN_ACCESS_PROFILE_IDS.askForApproval);
}

function unavailableProfileForId(
  profileId: AccessProfileId,
  status: "missing" | "invalid",
): AccessProfileDefinition {
  return {
    id: profileId,
    label: "Unavailable access profile",
    description:
      status === "missing"
        ? "The selected access profile no longer exists. Execution is limited until a valid profile is selected."
        : "The selected access profile is invalid. Execution is limited until the profile is repaired or replaced.",
    sandbox: "read-only",
    approval: "on-request",
    reviewer: "user",
    network: "disabled",
    shellAccess: false,
    workspaceRoots: ["."],
  };
}

export function resolveEffectiveAccessProfile(
  input: ResolveAccessProfileInput = {},
): EffectiveAccessProfile {
  const settings: PermissionSettingsData = input.settings || {
    version: 1,
    defaultMode: "dangerous_only",
    defaultShellEnabled: false,
    defaultPermissionAccess: "default",
    defaultAccessProfileId: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    accessProfiles: [],
    rules: [],
  };
  const explicitProfile =
    typeof input.task?.agentConfig?.accessProfileId === "string" &&
    input.task.agentConfig.accessProfileId.trim().length > 0;
  // A task object without a named profile may be an older persisted task. Do
  // not let a newly configured default profile rewrite its legacy permission
  // mode or silently turn on command tools for that task.
  const legacyTaskWithoutProfile = Boolean(input.task) && !explicitProfile;
  const requestedId = legacyTaskWithoutProfile
    ? undefined
    : getRequestedProfileId(input.task, settings);
  const hasConfiguredDefaultProfile =
    !legacyTaskWithoutProfile &&
    typeof settings.defaultAccessProfileId === "string" &&
    settings.defaultAccessProfileId.trim();
  const profileResolution = resolveAccessProfileDefinitionWithStatus(
    requestedId,
    settings.accessProfiles || [],
  );
  const profileUnavailable =
    !legacyTaskWithoutProfile &&
    (explicitProfile || Boolean(hasConfiguredDefaultProfile)) &&
    profileResolution.status !== "resolved";
  let definition =
    profileUnavailable && profileResolution.status !== "resolved"
      ? unavailableProfileForId(profileResolution.profileId, profileResolution.status)
      : profileResolution.definition || resolveAccessProfileDefinition(requestedId);
  const legacyMode = getLegacyMode(input.task);
  const inheritedLegacyMode =
    !explicitProfile && !hasConfiguredDefaultProfile && !legacyMode
      ? settings.defaultMode
      : undefined;
  let permissionMode: PermissionMode = explicitProfile
    ? getLegacyPermissionModeForAccessProfile(definition)
    : (legacyMode ?? inheritedLegacyMode ?? getLegacyPermissionModeForAccessProfile(definition));
  if (!explicitProfile && legacyMode === "bypass_permissions") {
    definition = profileForMode("bypass_permissions");
  } else if (!explicitProfile && legacyMode === "plan") {
    definition = profileForMode("plan");
  } else if (!explicitProfile && inheritedLegacyMode) {
    definition = profileForMode(inheritedLegacyMode);
  }
  let adminConstrained = false;
  let constraintReason: string | undefined;

  // A custom profile that declares a scoped boundary cannot safely use the
  // unsandboxed danger-full-access path: persistent shell commands and some
  // native helpers would otherwise bypass its path/domain rules. Preserve its
  // approval choice, but force the execution boundary to workspace-write so
  // the selected scope remains authoritative.
  if (definition.sandbox === "danger-full-access" && hasAccessProfileScope(definition)) {
    definition = { ...definition, sandbox: "workspace-write" };
    adminConstrained = true;
    constraintReason = "Scoped access rules require a sandboxed execution boundary.";
  }

  if (
    input.adminPolicies?.runtime.requireSandboxForShell === true &&
    isFullAccessProfile(definition) &&
    (input.task?.agentConfig?.shellAccess === true || definition.shellAccess !== false)
  ) {
    definition = profileForMode("default");
    permissionMode = "default";
    adminConstrained = true;
    constraintReason = "Administrator requires OS sandboxing for shell execution.";
  }

  const adminMode = chooseAdminFallbackMode(permissionMode, input.adminPolicies);
  if (adminMode !== permissionMode) {
    permissionMode = adminMode;
    definition = profileForMode(adminMode);
    adminConstrained = true;
    constraintReason = "Requested permission mode is blocked by administrator policy.";
  }

  // A verifier or internal read-only helper is a separate trust boundary from
  // the task that requested it.
  // Apply the read-only profile after ordinary profile/admin resolution so an
  // inherited full-access or custom approval profile cannot re-enable writes,
  // shell, network, or dynamically-discovered MCP tools. Preserve only the
  // caller's explicit filesystem/domain scope; widening that scope would make
  // the role boundary unsafe for custom profiles.
  if (
    input.task?.workerRole === "verifier" ||
    input.task?.agentConfig?.readOnlyExecution === true
  ) {
    const readOnlyProfile = profileForMode("plan");
    definition = {
      ...readOnlyProfile,
      ...(definition.workspaceRoots ? { workspaceRoots: definition.workspaceRoots } : {}),
      ...(definition.filesystemRules ? { filesystemRules: definition.filesystemRules } : {}),
      ...(definition.domainRules ? { domainRules: definition.domainRules } : {}),
      shellAccess: false,
    };
    permissionMode = "plan";
    adminConstrained = true;
    constraintReason = [
      constraintReason,
      "Read-only worker execution enforces a read-only access boundary.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const workspacePermissions = input.workspace?.permissions;
  const fullAccess = isFullAccessProfile(definition) && permissionMode === "bypass_permissions";
  const restricted = isRestrictedAccessProfile(definition);
  const profileAllowsNetwork = definition.network !== "disabled";
  const profileSelectionIsAuthoritative = explicitProfile || Boolean(hasConfiguredDefaultProfile);
  const legacyShellAccess =
    !explicitProfile && typeof input.task?.agentConfig?.shellAccess === "boolean"
      ? input.task.agentConfig.shellAccess
      : undefined;

  return {
    id: definition.id,
    requestedId,
    definition,
    permissionMode,
    sandboxMode: definition.sandbox,
    requiresSandbox: restricted,
    // Named access profiles are the primary command-tool control. A legacy
    // workspace shell flag is only consulted when no profile was selected, so
    // existing shell-disabled workspaces keep their old behavior until the
    // user explicitly chooses a profile. `shellAccess: false` remains a
    // read-only compatibility deny for profiles saved by older versions; new
    // profiles do not expose a separate shell toggle.
    shellEnabled:
      definition.shellAccess !== false &&
      legacyShellAccess !== false &&
      (legacyShellAccess === true ||
        fullAccess ||
        profileSelectionIsAuthoritative ||
        workspacePermissions?.shell === true),
    networkEnabled:
      profileAllowsNetwork &&
      (fullAccess ||
        profileSelectionIsAuthoritative ||
        workspacePermissions === undefined ||
        workspacePermissions.network === true),
    adminConstrained,
    profileUnavailable,
    profileScoped: hasAccessProfileScope(definition),
    filesystemScoped: hasAccessProfileFilesystemScope(definition),
    ...(constraintReason ? { constraintReason } : {}),
  };
}

function resolveProfilePath(workspacePath: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return nodePath.isAbsolute(trimmed)
    ? nodePath.normalize(trimmed)
    : nodePath.resolve(workspacePath, trimmed);
}

export function applyAccessProfileToWorkspace(
  workspace: Workspace,
  profile: EffectiveAccessProfile,
): Workspace {
  const current = workspace.permissions;
  const definition = profile.definition;
  // The resolved definition is the authority for a named profile. Do not
  // derive this from PermissionMode: mode mapping is retained only for legacy
  // callers and would make a custom `never` profile depend on a retired mode.
  const namedProfile = Boolean(profile.requestedId || profile.profileUnavailable);
  // Both dimensions must line up before the filesystem boundary and the
  // process sandbox come off: a `danger-full-access` profile that still asks
  // for approval on request has chosen to keep the external-file prompt, and
  // deriving this from the sandbox mode alone silently converts that
  // "on-request" into "never ask".
  const fullAccess = isFullAccessProfile(definition);
  const readOnly = definition.sandbox === "read-only";
  const extraRoots = (definition.workspaceRoots || [])
    .map((root) => resolveProfilePath(workspace.path, root))
    .filter(Boolean);
  const filesystemRules = (definition.filesystemRules || [])
    .map((rule) => ({ ...rule, path: resolveProfilePath(workspace.path, rule.path) }))
    .filter((rule) => rule.path);

  const profileMetadata: Partial<WorkspacePermissions> = namedProfile
    ? {
        accessProfileId: profile.id,
        accessSandboxMode: definition.sandbox,
        accessApprovalPolicy: definition.approval,
        accessReviewer: definition.reviewer,
        accessNetworkMode: definition.network,
        accessWorkspaceRoots: extraRoots,
        accessFilesystemRules: filesystemRules,
        accessDomainRules: definition.domainRules || [],
        accessProfileScoped: profile.profileScoped,
        accessFilesystemScoped: profile.filesystemScoped,
        accessProfileUnavailable: profile.profileUnavailable,
      }
    : {
        // Clear stale named-profile metadata when an old task is resumed in a
        // legacy compatibility mode. Otherwise the runtime engine would see
        // the old fields and silently apply the modern boundary policy.
        accessProfileId: undefined,
        accessSandboxMode: undefined,
        accessApprovalPolicy: undefined,
        accessReviewer: undefined,
        accessNetworkMode: undefined,
        accessWorkspaceRoots: undefined,
        accessFilesystemRules: undefined,
        accessDomainRules: undefined,
        accessProfileScoped: undefined,
        accessFilesystemScoped: undefined,
        accessProfileUnavailable: undefined,
      };

  const nextPermissions: WorkspacePermissions = {
    ...current,
    ...profileMetadata,
    read: fullAccess ? true : current.read,
    write: fullAccess ? true : current.write && !readOnly,
    delete: fullAccess ? true : current.delete && !readOnly,
    // A selected profile owns the network capability. This matters for
    // workspaces created with the legacy `network: false` default: Ask for
    // approval and Approve for me must still be able to reach the approval
    // boundary, while a disabled-network profile must turn it off.
    network: profile.networkEnabled,
    shell: profile.shellEnabled,
    unrestrictedFileAccess: fullAccess && !profile.filesystemScoped,
    // A restricted profile must not inherit a legacy `none` setting. The
    // sandbox factory will fail closed if no restricted backend is available.
    sandboxType: fullAccess
      ? "none"
      : current.sandboxType === "none"
        ? "auto"
        : current.sandboxType,
    // Named profiles own their filesystem boundary. Legacy allowedPaths are
    // retained only for unprofiled tasks; otherwise they would silently widen
    // a newly selected profile.
    allowedPaths: namedProfile ? undefined : current.allowedPaths,
  };

  return {
    ...workspace,
    permissions: nextPermissions,
  };
}

export function legacyAccessProfileIdForSettings(
  settings: Pick<PermissionSettingsData, "defaultAccessProfileId" | "defaultPermissionAccess">,
): AccessProfileId {
  return (
    settings.defaultAccessProfileId ||
    (settings.defaultPermissionAccess === "full"
      ? BUILTIN_ACCESS_PROFILE_IDS.fullAccess
      : BUILTIN_ACCESS_PROFILE_IDS.askForApproval)
  );
}

export function profileSummary(profile: EffectiveAccessProfile): string {
  const sandbox = profile.sandboxMode;
  const approval = profile.definition.approval;
  const reviewer = profile.definition.reviewer;
  return `${sandbox}; approval=${approval}; reviewer=${reviewer}`;
}

export function getProfileForAgentConfig(
  agentConfig: AgentConfig | undefined,
  settings: PermissionSettingsData,
  workspace: Workspace,
  adminPolicies?: AdminPolicies,
): EffectiveAccessProfile {
  return resolveEffectiveAccessProfile({
    task: { agentConfig },
    settings,
    workspace,
    adminPolicies,
  });
}

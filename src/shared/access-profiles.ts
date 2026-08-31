/**
 * User-selectable access profiles.
 *
 * Access profiles intentionally keep the process sandbox, approval policy, and
 * reviewer policy separate. A reviewer can decide whether an operation is
 * safe to run, but it must never widen the sandbox boundary.
 */

export type AccessSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AccessApprovalPolicy = "untrusted" | "on-request" | "never";
export type AccessReviewer = "user" | "auto-review" | "none";
export type AccessNetworkMode = "disabled" | "on-request" | "enabled";

export type BuiltinAccessProfileId = "ask_for_approval" | "approve_for_me" | "full_access";

// The open string intersection preserves autocomplete for built-ins while
// allowing administrator- or workspace-defined named profiles.
export type AccessProfileId = BuiltinAccessProfileId | (string & {});

export interface AccessFilesystemRule {
  path: string;
  access: "read" | "write" | "deny";
}

export interface AccessDomainRule {
  pattern: string;
  access: "allow" | "deny";
}

export interface AccessProfileDefinition {
  id: AccessProfileId;
  label: string;
  description: string;
  sandbox: AccessSandboxMode;
  approval: AccessApprovalPolicy;
  reviewer: AccessReviewer;
  network: AccessNetworkMode;
  /**
   * Legacy compatibility deny for profiles persisted before command tools
   * became part of the access mode. New profiles should omit this field;
   * command-tool access is derived from the selected profile mode.
   */
  shellAccess?: boolean;
  /** Additional workspace roots, resolved and validated by the main process. */
  workspaceRoots?: string[];
  filesystemRules?: AccessFilesystemRule[];
  domainRules?: AccessDomainRule[];
  /** Named profile inheritance. Profiles may inherit from another profile. */
  extends?: AccessProfileId;
}

export interface AccessProfileInheritanceIssue {
  profileId: string;
  message: string;
}

export type AccessProfileResolutionStatus = "resolved" | "missing" | "invalid";

export interface AccessProfileResolution {
  profileId: AccessProfileId;
  status: AccessProfileResolutionStatus;
  definition?: AccessProfileDefinition;
}

export const BUILTIN_ACCESS_PROFILE_IDS = {
  askForApproval: "ask_for_approval",
  approveForMe: "approve_for_me",
  fullAccess: "full_access",
} as const satisfies Record<string, BuiltinAccessProfileId>;

export const BUILTIN_ACCESS_PROFILES: readonly AccessProfileDefinition[] = [
  {
    id: BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    label: "Ask for approval",
    description: "Workspace writes with user approval for boundary crossings.",
    sandbox: "workspace-write",
    approval: "on-request",
    reviewer: "user",
    network: "on-request",
  },
  {
    id: BUILTIN_ACCESS_PROFILE_IDS.approveForMe,
    label: "Approve for me",
    description: "The same sandbox as Ask for approval with automatic safety review.",
    sandbox: "workspace-write",
    approval: "on-request",
    reviewer: "auto-review",
    network: "on-request",
  },
  {
    id: BUILTIN_ACCESS_PROFILE_IDS.fullAccess,
    label: "Full access",
    description:
      "Unrestricted local and network access without approval prompts, subject to OS/system protections.",
    sandbox: "danger-full-access",
    approval: "never",
    reviewer: "none",
    network: "enabled",
  },
] as const;

export function getBuiltinAccessProfile(
  profileId: string | undefined,
): AccessProfileDefinition | undefined {
  return BUILTIN_ACCESS_PROFILES.find((profile) => profile.id === profileId);
}

export function getAccessProfileLabel(profileId: string | undefined): string {
  return (
    getBuiltinAccessProfile(profileId)?.label || (profileId ? "Custom profile" : "Ask for approval")
  );
}

type AccessScopeOperation = "read" | "write";

function normalizeScopePath(value: string): {
  value: string;
  absolute: boolean;
  escapedRelativeRoot: boolean;
} {
  const source = String(value || "")
    .trim()
    .replace(/\\/g, "/");
  const absolute = source.startsWith("/") || /^[A-Za-z]:\//.test(source);
  const prefix = /^[A-Za-z]:\//.test(source) ? source.slice(0, 3) : absolute ? "/" : "";
  const stack: string[] = [];
  let escapedRelativeRoot = false;
  for (const segment of source.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!absolute) {
        stack.push("..");
        escapedRelativeRoot = true;
      }
      continue;
    }
    stack.push(segment);
  }
  const joined = stack.join("/");
  if (absolute) return { value: `${prefix}${joined}`, absolute, escapedRelativeRoot };
  return { value: joined || ".", absolute, escapedRelativeRoot };
}

function scopePathIsWithin(parentPath: string, childPath: string): boolean {
  const parent = normalizeScopePath(parentPath);
  const child = normalizeScopePath(childPath);
  if (parent.absolute !== child.absolute) return false;
  // `.` is the implicit workspace root for relative profile scopes. It covers
  // every non-escaping relative path, but never an absolute path or a path
  // that climbs above the workspace.
  if (!parent.absolute && parent.value === ".") {
    return !child.absolute && !child.escapedRelativeRoot;
  }
  if (!parent.absolute && child.escapedRelativeRoot && !parent.escapedRelativeRoot) return false;
  const parentSegments = parent.value.split("/").filter(Boolean);
  const childSegments = child.value.split("/").filter(Boolean);
  if (parentSegments.length > childSegments.length) return false;
  return parentSegments.every((segment, index) => segment === childSegments[index]);
}

function profileWorkspaceRoots(profile: AccessProfileDefinition): readonly string[] {
  return profile.workspaceRoots && profile.workspaceRoots.length > 0
    ? profile.workspaceRoots
    : ["."];
}

function filesystemRuleAllows(
  rule: AccessFilesystemRule,
  operation: AccessScopeOperation,
): boolean {
  if (rule.access === "write") return operation === "read" || operation === "write";
  return rule.access === "read" && operation === "read";
}

function filesystemPathIsCovered(
  childRule: AccessFilesystemRule,
  parentProfile: AccessProfileDefinition,
): boolean {
  const parentRules = parentProfile.filesystemRules || [];
  const operations: AccessScopeOperation[] =
    childRule.access === "write" ? ["read", "write"] : ["read"];

  return operations.every((operation) => {
    if (!filesystemRuleAllows(childRule, operation)) return true;
    if (
      profileWorkspaceRoots(parentProfile).some((root) => scopePathIsWithin(root, childRule.path))
    ) {
      return true;
    }
    return parentRules.some(
      (parentRule) =>
        filesystemRuleAllows(parentRule, operation) &&
        scopePathIsWithin(parentRule.path, childRule.path),
    );
  });
}

type DomainPattern =
  | { kind: "any" }
  | { kind: "exact"; value: string }
  | { kind: "subdomain"; suffix: string }
  | { kind: "subtree"; suffix: string };

function parseDomainPattern(pattern: string): DomainPattern {
  const normalized = String(pattern || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (normalized === "*") return { kind: "any" };
  if (normalized.startsWith("**.") && normalized.length > 3) {
    return { kind: "subtree", suffix: normalized.slice(3) };
  }
  if (normalized.startsWith("*.") && normalized.length > 2) {
    return { kind: "subdomain", suffix: normalized.slice(2) };
  }
  return { kind: "exact", value: normalized };
}

/**
 * Conservative language-inclusion check for the domain glob syntax used by
 * the network policy (`*`, `*.example.com`, and `**.example.com`). Unknown
 * syntax is treated as an exact literal and therefore cannot widen a parent.
 */
function domainPatternIsWithin(childPattern: string, parentPattern: string): boolean {
  const child = parseDomainPattern(childPattern);
  const parent = parseDomainPattern(parentPattern);
  if (parent.kind === "any") return true;
  if (child.kind === "any") return false;
  if (parent.kind === "exact") {
    return child.kind === "exact" && child.value === parent.value;
  }
  if (parent.kind === "subdomain") {
    if (child.kind === "exact") {
      return child.value.endsWith(`.${parent.suffix}`) && child.value !== parent.suffix;
    }
    if (child.kind === "subdomain") {
      return child.suffix === parent.suffix || child.suffix.endsWith(`.${parent.suffix}`);
    }
    return false;
  }
  // A subtree includes its apex and every descendant.
  if (child.kind === "exact") {
    return child.value === parent.suffix || child.value.endsWith(`.${parent.suffix}`);
  }
  if (child.kind === "subdomain" || child.kind === "subtree") {
    return child.suffix === parent.suffix || child.suffix.endsWith(`.${parent.suffix}`);
  }
  return false;
}

function mergeInheritedFilesystemRules(
  parentRules: readonly AccessFilesystemRule[] | undefined,
  childRules: readonly AccessFilesystemRule[] | undefined,
): AccessFilesystemRule[] | undefined {
  if (childRules === undefined) return parentRules ? [...parentRules] : undefined;
  const parent = parentRules || [];
  const parentDenies = parent.filter((rule) => rule.access === "deny");
  const childDenies = childRules.filter((rule) => rule.access === "deny");
  const childAllows = childRules.filter((rule) => rule.access !== "deny");
  // An explicitly supplied child list is an override: it may narrow the
  // parent's positive grants, including by supplying an empty list. Parent
  // denies remain non-removable and are always carried into the result.
  const merged = [...parentDenies, ...childAllows, ...childDenies];
  return merged.length > 0 ? merged : undefined;
}

function mergeInheritedDomainRules(
  parentRules: readonly AccessDomainRule[] | undefined,
  childRules: readonly AccessDomainRule[] | undefined,
): AccessDomainRule[] | undefined {
  if (childRules === undefined) return parentRules ? [...parentRules] : undefined;
  const parent = parentRules || [];
  const parentDenies = parent.filter((rule) => rule.access === "deny");
  const childDenies = childRules.filter((rule) => rule.access === "deny");
  const childAllows = childRules.filter((rule) => rule.access === "allow");
  // As with filesystem rules, a child can narrow inherited positive domain
  // grants with an explicit replacement list, while inherited denies remain.
  const merged = [...parentDenies, ...childAllows, ...childDenies];
  return merged.length > 0 ? merged : undefined;
}

function mergeInheritedWorkspaceRoots(
  parentRoots: readonly string[] | undefined,
  childRoots: readonly string[] | undefined,
): string[] | undefined {
  if (childRoots === undefined) return parentRoots ? [...parentRoots] : undefined;
  return [...childRoots];
}

function isScopedProfileAtMostPrivileged(
  child: AccessProfileDefinition,
  parent: AccessProfileDefinition,
): boolean {
  // Full-access parents intentionally have no finite path or domain boundary.
  // Treating their implicit `.` root as a real scope would reject a perfectly
  // safe child profile that narrows access to an absolute directory.
  if (isFullAccessProfile(parent) && !hasAccessProfileScope(parent)) return true;

  const parentRoots = profileWorkspaceRoots(parent);
  if (child.workspaceRoots !== undefined) {
    for (const childRoot of child.workspaceRoots) {
      // `.` is already part of every workspace boundary; extra roots must be
      // contained by the parent's boundary or remain inside the workspace.
      if (!parentRoots.some((parentRoot) => scopePathIsWithin(parentRoot, childRoot))) {
        return false;
      }
    }
  }

  const parentFilesystemDenies = (parent.filesystemRules || []).filter(
    (rule) => rule.access === "deny",
  );
  const childFilesystemDenies = (child.filesystemRules || []).filter(
    (rule) => rule.access === "deny",
  );
  // A child task/profile may narrow a parent, but it may not remove a deny
  // rule that protects a path the child could otherwise reach. Requiring the
  // deny language to be retained is intentionally conservative and remains
  // correct when the child profile is resolved through `extends` (resolved
  // children carry parent denies forward).
  for (const parentDeny of parentFilesystemDenies) {
    if (
      !childFilesystemDenies.some((childDeny) => scopePathIsWithin(childDeny.path, parentDeny.path))
    ) {
      return false;
    }
  }

  for (const childRule of child.filesystemRules || []) {
    if (childRule.access === "deny") continue;
    const parentDenyCoversChild = parentFilesystemDenies.some((parentDeny) =>
      scopePathIsWithin(parentDeny.path, childRule.path),
    );
    const childDenyCoversChild = childFilesystemDenies.some((childDeny) =>
      scopePathIsWithin(childDeny.path, childRule.path),
    );
    if (parentDenyCoversChild && !childDenyCoversChild) return false;
    if (!filesystemPathIsCovered(childRule, parent)) return false;
    const parentRule = (parent.filesystemRules || []).find(
      (rule) =>
        rule.access !== "deny" &&
        scopePathIsWithin(rule.path, childRule.path) &&
        ((childRule.access === "read" && (rule.access === "read" || rule.access === "write")) ||
          (childRule.access === "write" && rule.access === "write")),
    );
    if (
      !parentRule &&
      !parentRoots.some((parentRoot) => scopePathIsWithin(parentRoot, childRule.path))
    ) {
      return false;
    }
  }

  const parentAllows = (parent.domainRules || [])
    .filter((rule) => rule.access === "allow")
    .map((rule) => rule.pattern);
  const childAllows = (child.domainRules || [])
    .filter((rule) => rule.access === "allow")
    .map((rule) => rule.pattern);
  if (parentAllows.length > 0) {
    // A parent allowlist is a boundary. Omitting it in the child would turn
    // the effective policy into "all domains except denies" and widen access.
    if (childAllows.length === 0) return false;
    if (
      childAllows.some(
        (childPattern) =>
          !parentAllows.some((parentPattern) => domainPatternIsWithin(childPattern, parentPattern)),
      )
    ) {
      return false;
    }
  }

  const parentDomainDenies = (parent.domainRules || []).filter((rule) => rule.access === "deny");
  const childDomainDenies = (child.domainRules || []).filter((rule) => rule.access === "deny");
  for (const parentDeny of parentDomainDenies) {
    if (
      !childDomainDenies.some((childDeny) =>
        domainPatternIsWithin(parentDeny.pattern, childDeny.pattern),
      )
    ) {
      return false;
    }
  }

  return true;
}

export function resolveAccessProfileDefinitionWithStatus(
  profileId: AccessProfileId | undefined,
  customProfiles: readonly AccessProfileDefinition[] = [],
): AccessProfileResolution {
  const requestedId =
    typeof profileId === "string" && profileId.trim()
      ? profileId.trim()
      : BUILTIN_ACCESS_PROFILE_IDS.askForApproval;
  const customById = new Map(
    customProfiles
      .filter((profile) => typeof profile?.id === "string" && profile.id.trim())
      .map((profile) => [
        profile.id.trim(),
        {
          ...profile,
          id: profile.id.trim(),
          ...(typeof profile.extends === "string" && profile.extends.trim()
            ? { extends: profile.extends.trim() }
            : { extends: undefined }),
        },
      ]),
  );
  const getProfile = (id: AccessProfileId): AccessProfileDefinition | undefined =>
    getBuiltinAccessProfile(id) || customById.get(id);

  const resolve = (
    id: AccessProfileId,
    visiting: Set<string>,
  ): { definition?: AccessProfileDefinition; status: AccessProfileResolutionStatus } => {
    const base = getProfile(id);
    if (!base) return { status: "missing" };
    if (!base.extends) return { definition: { ...base }, status: "resolved" };
    if (visiting.has(base.id)) return { status: "invalid" };

    const nextVisiting = new Set(visiting);
    nextVisiting.add(base.id);
    const parentResult = resolve(base.extends, nextVisiting);
    if (!parentResult.definition) return { status: "invalid" };
    const parent = parentResult.definition;

    return {
      status: "resolved",
      definition: {
        ...parent,
        ...base,
        shellAccess: base.shellAccess ?? parent.shellAccess,
        workspaceRoots: mergeInheritedWorkspaceRoots(parent.workspaceRoots, base.workspaceRoots),
        filesystemRules: mergeInheritedFilesystemRules(
          parent.filesystemRules,
          base.filesystemRules,
        ),
        domainRules: mergeInheritedDomainRules(parent.domainRules, base.domainRules),
      },
    };
  };

  const result = resolve(requestedId, new Set());
  return {
    profileId: requestedId,
    status: result.definition ? "resolved" : result.status,
    ...(result.definition ? { definition: result.definition } : {}),
  };
}

export function resolveAccessProfileDefinition(
  profileId: AccessProfileId | undefined,
  customProfiles: readonly AccessProfileDefinition[] = [],
): AccessProfileDefinition {
  return (
    resolveAccessProfileDefinitionWithStatus(profileId, customProfiles).definition || {
      ...BUILTIN_ACCESS_PROFILES[0],
    }
  );
}

/**
 * Validate the inheritance graph before it is persisted. A bad profile must
 * not silently fall back to an unrestricted parent or produce partial policy
 * resolution at runtime.
 */
export function validateAccessProfileInheritance(
  customProfiles: readonly AccessProfileDefinition[] = [],
): AccessProfileInheritanceIssue[] {
  const issues: AccessProfileInheritanceIssue[] = [];
  const builtinIds = new Set<string>(BUILTIN_ACCESS_PROFILES.map((profile) => profile.id));
  const customById = new Map<string, AccessProfileDefinition>();
  const invalidIds = new Set<string>();
  const addIssue = (profileId: string, message: string): void => {
    invalidIds.add(profileId);
    if (!issues.some((issue) => issue.profileId === profileId && issue.message === message)) {
      issues.push({ profileId, message });
    }
  };

  for (const profile of customProfiles) {
    const rawId = typeof profile?.id === "string" ? profile.id : "";
    const profileId = rawId.trim();
    if (!profileId) {
      addIssue(profileId, "Profile id must be a non-empty string.");
      continue;
    }
    const normalizedProfile: AccessProfileDefinition = {
      ...profile,
      id: profileId,
      ...(typeof profile.extends === "string" && profile.extends.trim()
        ? { extends: profile.extends.trim() }
        : { extends: undefined }),
    };
    if (customById.has(profileId) || builtinIds.has(profileId)) {
      addIssue(
        profileId,
        `Profile id "${profileId}" is duplicated or reserved by a built-in profile.`,
      );
      continue;
    }
    customById.set(profileId, normalizedProfile);
  }

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const walk = (profileId: string): boolean => {
    const profile = customById.get(profileId);
    if (!profile) return false;

    const currentState = state.get(profile.id);
    if (currentState === "visited") return !invalidIds.has(profile.id);
    if (currentState === "visiting") {
      const cycleStart = Math.max(0, stack.indexOf(profile.id));
      const cycle = [...stack.slice(cycleStart), profile.id].join(" -> ");
      for (const cycleProfileId of new Set(stack.slice(cycleStart))) {
        addIssue(cycleProfileId, `Profile inheritance cycle detected: ${cycle}.`);
      }
      return false;
    }

    state.set(profile.id, "visiting");
    stack.push(profile.id);
    let valid = !invalidIds.has(profile.id);
    if (profile.extends) {
      if (builtinIds.has(profile.extends)) {
        const parent = getBuiltinAccessProfile(profile.extends);
        const resolvedChild = resolveAccessProfileDefinition(profile.id, customProfiles);
        if (parent && !isAccessProfileAtMostPrivileged(resolvedChild, parent)) {
          addIssue(
            profile.id,
            `Profile cannot widen the inherited sandbox, approval, reviewer, shell, filesystem, or network access from "${parent.id}".`,
          );
          valid = false;
        }
      } else {
        const parent = customById.get(profile.extends);
        if (!parent) {
          addIssue(profile.id, `Profile extends unknown profile "${profile.extends}".`);
          valid = false;
        } else if (!walk(parent.id)) {
          addIssue(profile.id, `Profile extends invalid profile "${parent.id}".`);
          valid = false;
        } else {
          const resolvedParent = resolveAccessProfileDefinition(parent.id, customProfiles);
          const resolvedChild = resolveAccessProfileDefinition(profile.id, customProfiles);
          if (!isAccessProfileAtMostPrivileged(resolvedChild, resolvedParent)) {
            addIssue(
              profile.id,
              `Profile cannot widen the inherited sandbox, approval, reviewer, shell, filesystem, or network access from "${parent.id}".`,
            );
            valid = false;
          }
        }
      }
    }
    stack.pop();
    state.set(profile.id, "visited");
    if (!valid) invalidIds.add(profile.id);
    return valid;
  };

  for (const profile of customById.values()) walk(profile.id);
  return issues;
}

export function isFullAccessProfile(profile: AccessProfileDefinition): boolean {
  return profile.sandbox === "danger-full-access" && profile.approval === "never";
}

export function isRestrictedAccessProfile(profile: AccessProfileDefinition): boolean {
  return !isFullAccessProfile(profile);
}

export function hasAccessProfileScope(profile: AccessProfileDefinition): boolean {
  return (
    (profile.workspaceRoots || []).some((root) => {
      const normalized = normalizeScopePath(root).value;
      return normalized !== ".";
    }) ||
    (profile.filesystemRules?.length || 0) > 0 ||
    (profile.domainRules?.length || 0) > 0
  );
}

/**
 * Returns whether a profile defines a finite filesystem boundary. Domain-only
 * profiles remain scoped for network and native-tool decisions, but they do
 * not turn a one-shot approval for an external file into a hard denial.
 */
export function hasAccessProfileFilesystemScope(profile: AccessProfileDefinition): boolean {
  return (
    (profile.workspaceRoots || []).some((root) => normalizeScopePath(root).value !== ".") ||
    (profile.filesystemRules?.length || 0) > 0
  );
}

function accessDimensionRank(value: string, order: readonly string[]): number {
  const rank = order.indexOf(value);
  return rank >= 0 ? rank : 0;
}

/**
 * Returns true when a child profile does not widen any of the parent's
 * sandbox, approval, reviewer, command-tool, filesystem, or network dimensions. This is intentionally
 * conservative: a profile with an unknown/custom value is treated as the
 * least privileged value rather than being allowed to widen access.
 */
export function isAccessProfileAtMostPrivileged(
  child: AccessProfileDefinition,
  parent: AccessProfileDefinition,
): boolean {
  return (
    accessDimensionRank(child.sandbox, ["read-only", "workspace-write", "danger-full-access"]) <=
      accessDimensionRank(parent.sandbox, ["read-only", "workspace-write", "danger-full-access"]) &&
    accessDimensionRank(child.approval, ["untrusted", "on-request", "never"]) <=
      accessDimensionRank(parent.approval, ["untrusted", "on-request", "never"]) &&
    accessDimensionRank(child.network, ["disabled", "on-request", "enabled"]) <=
      accessDimensionRank(parent.network, ["disabled", "on-request", "enabled"]) &&
    accessDimensionRank(child.reviewer, ["user", "auto-review", "none"]) <=
      accessDimensionRank(parent.reviewer, ["user", "auto-review", "none"]) &&
    // `false` is retained as a legacy deny. An omitted value means command
    // tools follow the profile mode and therefore must not be rejected when
    // the parent is a modern built-in profile without the legacy field.
    (child.shellAccess !== true || parent.shellAccess !== false) &&
    isScopedProfileAtMostPrivileged(child, parent)
  );
}

export function getLegacyPermissionModeForAccessProfile(
  profile: AccessProfileDefinition,
): "default" | "plan" | "dangerous_only" | "bypass_permissions" {
  if (profile.approval === "never" || isFullAccessProfile(profile)) return "bypass_permissions";
  if (profile.sandbox === "read-only") return "plan";
  if (profile.approval === "untrusted" || profile.reviewer === "auto-review") {
    return "dangerous_only";
  }
  return "default";
}

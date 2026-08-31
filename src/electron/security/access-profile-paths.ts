import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import type { AccessFilesystemRule } from "../../shared/access-profiles";
import type { Workspace } from "../../shared/types";

export type AccessFilesystemOperation = "read" | "write" | "delete";
export type AccessFilesystemDecision = "allow" | "deny" | "unmatched";

export function isAccessPathWithin(parentPath: string, candidatePath: string): boolean {
  const parent = canonicalizeAccessPath(parentPath);
  const candidate = canonicalizeAccessPath(candidatePath);
  const relative = nodePath.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

/**
 * Compare filesystem policy paths in the same namespace used by the OS.
 * macOS exposes locations such as /var through symlinks, and write rules may
 * target paths that do not exist yet. Canonicalize the existing prefix while
 * preserving the non-existent suffix for both cases.
 */
export function canonicalizeAccessPath(inputPath: string): string {
  const resolved = nodePath.resolve(inputPath);
  let current = resolved;
  const suffix: string[] = [];

  while (!nodeFs.existsSync(current)) {
    const parent = nodePath.dirname(current);
    if (parent === current) return resolved;
    suffix.unshift(nodePath.basename(current));
    current = parent;
  }

  try {
    return nodePath.join(nodeFs.realpathSync.native(current), ...suffix);
  } catch {
    return resolved;
  }
}

function expandHomeShortcutPath(rawPath: string): string {
  const value = String(rawPath || "").trim();
  if (value === "~") return nodeOs.homedir();
  if (value.startsWith(`~${nodePath.sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    return nodePath.join(nodeOs.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Resolve a user/tool supplied path while preserving the existing-prefix
 * canonicalization used by the access evaluator. This catches symlink escapes
 * and `..` traversal even when the final file does not exist yet.
 */
export function resolveAccessControlledPath(workspacePath: string, rawPath: string): string {
  const value = expandHomeShortcutPath(rawPath);
  if (!value) throw new Error("Path is required");
  return canonicalizeAccessPath(
    nodePath.isAbsolute(value) ? value : nodePath.resolve(workspacePath, value),
  );
}

function ruleAllowsOperation(
  rule: AccessFilesystemRule,
  operation: AccessFilesystemOperation,
): boolean {
  // A write grant must never become a delete grant. Delete is a separate,
  // destructive capability and is controlled by the workspace delete bit.
  if (rule.access === "write") return operation === "read" || operation === "write";
  return rule.access === "read" && operation === "read";
}

/**
 * Evaluate the most specific policy dimension available for a path.
 * Deny rules always win, including when the workspace has unrestricted access.
 */
export function evaluateAccessFilesystemRules(
  rules: readonly AccessFilesystemRule[] | undefined,
  absolutePath: string,
  operation: AccessFilesystemOperation,
): AccessFilesystemDecision {
  if (!Array.isArray(rules) || rules.length === 0) return "unmatched";

  const matchingRules = rules.filter(
    (rule) =>
      !!rule &&
      typeof rule.path === "string" &&
      rule.path.trim().length > 0 &&
      isAccessPathWithin(rule.path, absolutePath),
  );
  if (matchingRules.some((rule) => rule.access === "deny")) return "deny";
  if (matchingRules.some((rule) => ruleAllowsOperation(rule, operation))) return "allow";
  // A matching positive rule is still a boundary. For example, `read:/x`
  // must not fall through to a broader workspace root and accidentally grant
  // writes (and `write:/x` must not grant deletes).
  if (matchingRules.some((rule) => rule.access !== "deny")) return "deny";
  return "unmatched";
}

export function isAccessFilesystemPathDenied(
  rules: readonly AccessFilesystemRule[] | undefined,
  absolutePath: string,
): boolean {
  return evaluateAccessFilesystemRules(rules, absolutePath, "read") === "deny";
}

export interface WorkspaceFilesystemAccessResult {
  decision: "allow" | "deny";
  path: string;
  reason: string;
}

export interface WorkspaceFilesystemAccessOptions {
  /** A one-shot approval granted for this exact operation by the daemon. */
  externalApprovalGranted?: boolean;
}

export interface ExternalFileApprovalRequest {
  path: string;
  operation: AccessFilesystemOperation;
  label: string;
}

export type ExternalFileApprovalRequester = (
  request: ExternalFileApprovalRequest,
) => Promise<boolean>;

export type ExternalFileApprovalConsumer = (
  path: string,
  operation: AccessFilesystemOperation,
) => boolean;

export interface WorkspaceFilesystemApprovalHandlers {
  request?: ExternalFileApprovalRequester;
  consume?: ExternalFileApprovalConsumer;
}

/**
 * Adapt the daemon's approval lifecycle to the filesystem policy helpers.
 * Keeping this adapter here makes high-level tools use the same exact-path,
 * one-shot grant semantics as the low-level file tools instead of inventing
 * connector-specific permission checks.
 */
export function createWorkspaceFilesystemApprovalHandlers(
  daemon: unknown,
  taskId: string,
  toolName: string,
): WorkspaceFilesystemApprovalHandlers {
  const candidate = daemon as {
    requestApproval?: (
      taskId: string,
      type: string,
      description: string,
      details: Record<string, unknown>,
    ) => Promise<unknown>;
    consumeExternalFileApproval?: (
      taskId: string,
      path: string,
      operation: AccessFilesystemOperation,
    ) => boolean;
  } | null;

  if (!candidate || !taskId) return {};

  return {
    ...(typeof candidate.requestApproval === "function"
      ? {
          request: async ({ path: approvedPath, operation, label }) =>
            (await candidate.requestApproval!.call(
              daemon,
              taskId,
              "external_file_access",
              `Allow ${operation} access to external ${label}: ${approvedPath}`,
              { path: approvedPath, operation, tool: toolName },
            )) === true,
        }
      : {}),
    ...(typeof candidate.consumeExternalFileApproval === "function"
      ? {
          consume: (approvedPath: string, operation: AccessFilesystemOperation) =>
            candidate.consumeExternalFileApproval!.call(daemon, taskId, approvedPath, operation) ===
            true,
        }
      : {}),
  };
}

export interface WorkspaceFilesystemAccessWithApprovalResult extends WorkspaceFilesystemAccessResult {
  externalApprovalGranted: boolean;
}

const PROTECTED_FILESYSTEM_ROOTS = [
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/private/etc",
  "/var/db",
  "/var/root",
  "/var/run",
  "/private/var/db",
  "/private/var/root",
  "/private/var/run",
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
];

/**
 * Return true for operating-system locations that CoWork never mutates.
 * Keep the list specific enough that ordinary runtime scratch locations such
 * as /tmp and /private/var/folders remain usable for approved artifacts.
 */
export function isProtectedFilesystemPath(absolutePath: string): boolean {
  const normalizedPath = nodePath.normalize(absolutePath).toLowerCase();
  return PROTECTED_FILESYSTEM_ROOTS.some((root) => {
    const normalizedRoot = nodePath.normalize(root).toLowerCase();
    if (isAccessPathWithin(normalizedRoot, absolutePath)) return true;
    const slashPath = normalizedPath.replaceAll("\\", "/");
    const slashRoot = normalizedRoot.replaceAll("\\", "/");
    return slashPath === slashRoot || slashPath.startsWith(`${slashRoot.replace(/\/$/, "")}/`);
  });
}

function resolveWorkspacePolicyPath(workspacePath: string, value: string): string {
  value = expandHomeShortcutPath(value);
  return canonicalizeAccessPath(
    nodePath.isAbsolute(value) ? value : nodePath.resolve(workspacePath, value),
  );
}

function normalizeMacPathAlias(value: string): string {
  return value
    .replace(/^\/private\/var(?=\/|$)/, "/var")
    .replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
}

function preserveLexicalMacAlias(requestedPath: string, canonicalPath: string): string {
  return normalizeMacPathAlias(requestedPath) === normalizeMacPathAlias(canonicalPath)
    ? requestedPath
    : canonicalPath;
}

function operationRequiresWorkspacePermission(
  operation: AccessFilesystemOperation,
): "read" | "write" | "delete" {
  return operation;
}

function hasWorkspacePermission(
  permissions: Workspace["permissions"],
  operation: AccessFilesystemOperation,
): boolean {
  const current = permissions[operation];
  if (typeof current === "boolean") return current;

  // A few older callers and persisted test fixtures still use the pre-profile
  // names. Keep them as a compatibility read without weakening the typed
  // WorkspacePermissions contract used by new code.
  const legacyKey =
    `${operation === "read" ? "fileRead" : operation === "write" ? "fileWrite" : "fileDelete"}` as
      | "fileRead"
      | "fileWrite"
      | "fileDelete";
  return (permissions as Workspace["permissions"] & Record<string, unknown>)[legacyKey] === true;
}

/**
 * Read the filesystem-scope marker with a compatibility fallback for
 * workspaces persisted before `accessFilesystemScoped` was introduced. A
 * domain-only profile may set `accessProfileScoped` without owning a finite
 * filesystem boundary, so the legacy flag alone is intentionally not enough.
 */
export function hasEffectiveFilesystemScope(
  workspacePath: string,
  permissions: Workspace["permissions"],
): boolean {
  if (permissions.accessFilesystemScoped === true) return true;
  if ((permissions.accessFilesystemRules || []).length > 0) return true;
  if (permissions.accessProfileScoped !== true) return false;

  const workspaceRoot = canonicalizeAccessPath(workspacePath);
  return (permissions.accessWorkspaceRoots || []).some(
    (root) => resolveWorkspacePolicyPath(workspacePath, root) !== workspaceRoot,
  );
}

/**
 * Evaluate the complete workspace/profile filesystem boundary for a path.
 * Tool implementations should use this instead of checking only
 * `unrestrictedFileAccess` or `allowedPaths`; those legacy flags do not carry
 * profile deny rules or symlink semantics by themselves.
 */
export function evaluateWorkspaceFilesystemAccess(
  workspace: Pick<Workspace, "path" | "permissions"> & Partial<Pick<Workspace, "isTemp">>,
  rawPath: string,
  operation: AccessFilesystemOperation,
  options: WorkspaceFilesystemAccessOptions = {},
): WorkspaceFilesystemAccessResult {
  const normalizedRawPath = expandHomeShortcutPath(rawPath);
  const requestedPath = nodePath.isAbsolute(normalizedRawPath)
    ? nodePath.resolve(normalizedRawPath)
    : nodePath.resolve(workspace.path, normalizedRawPath);
  const resolvedPath = resolveAccessControlledPath(workspace.path, rawPath);
  const operationPath = preserveLexicalMacAlias(requestedPath, resolvedPath);
  const permissions = workspace.permissions || ({} as Workspace["permissions"]);
  const filesystemScoped = hasEffectiveFilesystemScope(workspace.path, permissions);
  if (permissions.accessProfileUnavailable === true) {
    return { decision: "deny", path: operationPath, reason: "access_profile_unavailable" };
  }
  const rules = (permissions.accessFilesystemRules || []).map((rule) => ({
    ...rule,
    path: resolveWorkspacePolicyPath(workspace.path, rule.path),
  }));
  const ruleDecision = evaluateAccessFilesystemRules(rules, resolvedPath, operation);
  if (ruleDecision === "deny") {
    return { decision: "deny", path: operationPath, reason: "profile_filesystem_denied" };
  }

  // System locations are a hard mutation boundary. Check this before legacy
  // unrestricted access or one-shot external approval so a protected target
  // is never presented as an approvable file operation.
  if (operation !== "read" && isProtectedFilesystemPath(resolvedPath)) {
    return { decision: "deny", path: operationPath, reason: "protected_path" };
  }

  const requiredPermission = operationRequiresWorkspacePermission(operation);
  if (!hasWorkspacePermission(permissions, requiredPermission)) {
    return {
      decision: "deny",
      path: operationPath,
      reason: `workspace_${requiredPermission}_disabled`,
    };
  }

  if (ruleDecision === "allow") {
    return { decision: "allow", path: operationPath, reason: "profile_filesystem_allow" };
  }

  const workspaceRoot = canonicalizeAccessPath(workspace.path);
  if (isAccessPathWithin(workspaceRoot, resolvedPath)) {
    return { decision: "allow", path: operationPath, reason: "workspace_path" };
  }

  if (permissions.unrestrictedFileAccess === true) {
    return { decision: "allow", path: operationPath, reason: "unrestricted_file_access" };
  }

  // Temporary workspaces historically allow scratch files outside their
  // generated directory. Keep that compatibility only when no explicit
  // profile scope is present; a profile deny/root rule must still constrain a
  // temporary workspace.
  if (
    (workspace as Pick<Workspace, "isTemp">).isTemp === true &&
    rules.length === 0 &&
    (permissions.accessWorkspaceRoots || []).length === 0 &&
    !permissions.accessProfileId &&
    !filesystemScoped
  ) {
    return { decision: "allow", path: operationPath, reason: "temporary_workspace" };
  }

  const explicitlyAllowedRoots = [
    ...(filesystemScoped ? [] : permissions.allowedPaths || []),
    ...(permissions.accessWorkspaceRoots || []),
  ].map((root) => resolveWorkspacePolicyPath(workspace.path, root));
  if (explicitlyAllowedRoots.some((root) => isAccessPathWithin(root, resolvedPath))) {
    return { decision: "allow", path: operationPath, reason: "explicit_file_root" };
  }

  // A named profile with a finite filesystem boundary must not fall through
  // to legacy unrestricted access or a fresh external-file approval. The
  // approval UI can authorize a plain workspace boundary crossing, but it is
  // never allowed to widen an explicit profile scope.
  if (filesystemScoped) {
    return { decision: "deny", path: operationPath, reason: "profile_filesystem_outside" };
  }

  if (options.externalApprovalGranted) {
    return { decision: "allow", path: operationPath, reason: "external_approval" };
  }

  return { decision: "deny", path: operationPath, reason: "outside_workspace" };
}

/**
 * Resolve a filesystem operation and, only for a plain workspace boundary
 * crossing, offer a one-shot external-file approval. Profile denies,
 * unavailable profiles, disabled capabilities, and protected mutation paths
 * remain hard denials and never become prompts.
 */
export async function resolveWorkspaceFilesystemAccessWithApproval(
  workspace: Pick<Workspace, "path" | "permissions"> & Partial<Pick<Workspace, "isTemp">>,
  rawPath: string,
  operation: AccessFilesystemOperation,
  label = "path",
  handlers: WorkspaceFilesystemApprovalHandlers = {},
): Promise<WorkspaceFilesystemAccessWithApprovalResult> {
  const initial = evaluateWorkspaceFilesystemAccess(workspace, rawPath, operation);
  if (initial.reason !== "outside_workspace") {
    return { ...initial, externalApprovalGranted: false };
  }

  const candidate = resolveAccessControlledPath(workspace.path, rawPath);
  let approved = handlers.consume?.(candidate, operation) === true;
  if (!approved && handlers.request) {
    approved = await handlers.request({ path: candidate, operation, label });
    if (approved) handlers.consume?.(candidate, operation);
  }

  if (!approved) {
    return { ...initial, externalApprovalGranted: false };
  }

  const granted = evaluateWorkspaceFilesystemAccess(workspace, candidate, operation, {
    externalApprovalGranted: true,
  });
  return { ...granted, externalApprovalGranted: granted.decision === "allow" };
}

export function assertWorkspaceFilesystemAccess(
  workspace: Pick<Workspace, "path" | "permissions">,
  rawPath: string,
  operation: AccessFilesystemOperation,
  label = "path",
  options: WorkspaceFilesystemAccessOptions = {},
): string {
  const result = evaluateWorkspaceFilesystemAccess(workspace, rawPath, operation, options);
  if (result.decision !== "allow") {
    throw new Error(`Access denied for ${label} "${rawPath}": ${result.reason}`);
  }
  return result.path;
}

export async function assertWorkspaceFilesystemAccessWithApproval(
  workspace: Pick<Workspace, "path" | "permissions"> & Partial<Pick<Workspace, "isTemp">>,
  rawPath: string,
  operation: AccessFilesystemOperation,
  label = "path",
  handlers: WorkspaceFilesystemApprovalHandlers = {},
): Promise<string> {
  const result = await resolveWorkspaceFilesystemAccessWithApproval(
    workspace,
    rawPath,
    operation,
    label,
    handlers,
  );
  if (result.decision !== "allow") {
    throw new Error(`Access denied for ${label} "${rawPath}": ${result.reason}`);
  }
  return result.path;
}

/** Validate a filesystem input that must already exist and be a regular file. */
export function assertWorkspaceReadableFileAccess(
  workspace: Pick<Workspace, "path" | "permissions" | "isTemp">,
  rawPath: string,
  label = "file input",
): string {
  const checkedPath = assertWorkspaceFilesystemAccess(workspace, rawPath, "read", label);
  let resolvedPath: string;
  try {
    resolvedPath = nodeFs.realpathSync.native
      ? nodeFs.realpathSync.native(checkedPath)
      : nodeFs.realpathSync(checkedPath);
  } catch {
    throw new Error(`${label} does not exist: ${rawPath}`);
  }
  const resolved = assertWorkspaceFilesystemAccess(workspace, resolvedPath, "read", label);
  let stats: nodeFs.Stats;
  try {
    stats = nodeFs.statSync(resolved);
  } catch {
    throw new Error(`${label} does not exist: ${rawPath}`);
  }
  if (!stats.isFile()) throw new Error(`${label} is not a file: ${rawPath}`);
  return resolved;
}

/** Validate an existing regular file after applying the external approval path. */
export async function assertWorkspaceReadableFileAccessWithApproval(
  workspace: Pick<Workspace, "path" | "permissions" | "isTemp">,
  rawPath: string,
  label = "file input",
  handlers: WorkspaceFilesystemApprovalHandlers = {},
): Promise<string> {
  const access = await resolveWorkspaceFilesystemAccessWithApproval(
    workspace,
    rawPath,
    "read",
    label,
    handlers,
  );
  if (access.decision !== "allow") {
    throw new Error(`Access denied for ${label} "${rawPath}": ${access.reason}`);
  }

  let resolvedPath: string;
  try {
    resolvedPath = nodeFs.realpathSync.native
      ? nodeFs.realpathSync.native(access.path)
      : nodeFs.realpathSync(access.path);
  } catch {
    throw new Error(`${label} does not exist: ${rawPath}`);
  }

  const resolved = evaluateWorkspaceFilesystemAccess(workspace, resolvedPath, "read", {
    externalApprovalGranted: access.externalApprovalGranted,
  });
  if (resolved.decision !== "allow") {
    throw new Error(`Access denied for ${label} "${rawPath}": ${resolved.reason}`);
  }

  let stats: nodeFs.Stats;
  try {
    stats = nodeFs.statSync(resolved.path);
  } catch {
    throw new Error(`${label} does not exist: ${rawPath}`);
  }
  if (!stats.isFile()) throw new Error(`${label} is not a file: ${rawPath}`);
  return resolved.path;
}

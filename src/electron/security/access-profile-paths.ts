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
  /** All external targets when one filesystem operation crosses more than one path. */
  paths?: string[];
  pathOperations?: Array<{
    path: string;
    operation: AccessFilesystemOperation;
  }>;
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
 * The execution-boundary authorization request used by AgentDaemon.  Tools
 * intentionally depend on this small structural contract instead of importing
 * the daemon implementation so that native/test runners can provide the same
 * policy boundary without pulling in Electron state.
 */
export interface ToolAuthorizationRequest {
  toolName: string;
  approvalType?: string;
  details?: Record<string, unknown>;
  description?: string;
  allowAutoApprove?: boolean;
  requireExplicitApproval?: boolean;
  signal?: AbortSignal;
}

interface ToolAuthorizationDaemon {
  authorizeToolAction?: (taskId: string, request: ToolAuthorizationRequest) => Promise<unknown>;
  evaluateToolPermission?: (
    taskId: string,
    options: {
      approvalType?: string;
      toolName: string;
      details?: Record<string, unknown>;
      allowPersistence?: boolean;
    },
  ) => { decision?: unknown };
  requestApproval?: (
    taskId: string,
    type: string,
    description: string,
    details: Record<string, unknown>,
    options?: {
      allowAutoApprove?: boolean;
      requireExplicitApproval?: boolean;
      signal?: AbortSignal;
    },
  ) => Promise<unknown>;
}

/**
 * Authorize one operation through the daemon's typed execution broker.
 *
 * The fallback exists for older test doubles and legacy embedders only.  It
 * evaluates the current policy before calling the old approval API and never
 * treats a missing authority method as an allow.  A production AgentDaemon
 * always takes the first branch, where allowed workspace work is silent and
 * only a real exception can reach the user reviewer.
 */
export async function authorizeToolActionWithFallback(
  daemon: unknown,
  taskId: string,
  request: ToolAuthorizationRequest,
): Promise<boolean> {
  const candidate = daemon as ToolAuthorizationDaemon | null;
  if (!candidate || !taskId) return false;

  if (typeof candidate.authorizeToolAction === "function") {
    return (await candidate.authorizeToolAction.call(daemon, taskId, request)) === true;
  }

  const details = request.details || {};
  if (typeof candidate.evaluateToolPermission === "function") {
    const evaluation = candidate.evaluateToolPermission.call(daemon, taskId, {
      approvalType: request.approvalType,
      toolName: request.toolName,
      details,
      allowPersistence: false,
    });
    if (
      evaluation?.decision === "allow" &&
      !request.requireExplicitApproval &&
      request.allowAutoApprove !== false
    ) {
      return true;
    }
    if (evaluation?.decision === "deny") return false;
  }

  if (typeof candidate.requestApproval !== "function") return false;
  return (
    (await candidate.requestApproval.call(
      daemon,
      taskId,
      request.approvalType || request.toolName,
      request.description || `Review ${request.toolName} before continuing.`,
      details,
      {
        allowAutoApprove: request.allowAutoApprove,
        signal: request.signal,
        requireExplicitApproval: request.requireExplicitApproval,
      },
    )) === true
  );
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
    authorizeToolAction?: (taskId: string, request: ToolAuthorizationRequest) => Promise<unknown>;
    evaluateToolPermission?: ToolAuthorizationDaemon["evaluateToolPermission"];
    requestApproval?: ToolAuthorizationDaemon["requestApproval"];
    consumeExternalFileApproval?: (
      taskId: string,
      path: string,
      operation: AccessFilesystemOperation,
    ) => boolean;
  } | null;

  if (!candidate || !taskId) return {};

  return {
    ...(typeof candidate.authorizeToolAction === "function" ||
    typeof candidate.evaluateToolPermission === "function" ||
    typeof candidate.requestApproval === "function"
      ? {
          request: async ({ path: approvedPath, operation, label, paths, pathOperations }) => {
            // A single approval grants every path in the batch, so the prompt
            // has to name every path and its operation. Describing only the
            // first one let `move_file("/tmp/scratch", "~/Library/...")` grant
            // the write to the second target from a prompt that said it was
            // deleting a scratch file.
            const batched =
              pathOperations && pathOperations.length > 1 ? pathOperations : undefined;
            const description = batched
              ? `Allow external ${label} access to ${batched.length} paths:\n${batched
                  .map((entry) => `  - ${entry.operation}: ${entry.path}`)
                  .join("\n")}`
              : `Allow ${operation} access to external ${label}: ${approvedPath}`;
            return authorizeToolActionWithFallback(daemon, taskId, {
              toolName,
              approvalType: "external_file_access",
              description,
              details: {
                path: approvedPath,
                operation,
                tool: toolName,
                ...(paths && paths.length > 1 ? { paths } : {}),
                ...(pathOperations && pathOperations.length > 1 ? { pathOperations } : {}),
              },
              allowAutoApprove: true,
            });
          },
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

export interface WorkspaceFilesystemAccessRequest {
  rawPath: string;
  operation: AccessFilesystemOperation;
  label?: string;
}

function hasSameBoundCanonicalAccessPath(boundIdentity: string, currentPath: string): boolean {
  try {
    // Compare identities, not spellings.  macOS can expose the same temporary
    // directory as /var/... and /private/var/..., and a policy check must not
    // reject a stable target merely because the alias changed.
    return boundIdentity === canonicalizeAccessPath(currentPath);
  } catch {
    return false;
  }
}

function pathChangedAfterApproval(item: {
  candidate: string;
  access: WorkspaceFilesystemAccessResult;
}): WorkspaceFilesystemAccessResult {
  return {
    decision: "deny",
    path: item.access.path || item.candidate,
    reason: "path_changed_after_approval",
  };
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

/**
 * Workspace-relative locations that tools may read but never mutate.
 *
 * `.cowork/policy` holds the permission mirror (`permissions.json`) and the
 * tool-policy script (`tools.monty`) — the rules that decide whether a tool
 * call is allowed. `.git` holds hooks, which git executes on the next commit.
 * A tool able to write either could rewrite the rules that govern it, or plant
 * code that runs outside the tool sandbox entirely.
 *
 * Matched per path segment rather than as a prefix of the workspace root, so a
 * nested repository's `.git` (submodules, vendored checkouts) is covered too.
 */
const PROTECTED_WORKSPACE_SEGMENTS: string[][] = [[".cowork", "policy"], [".git"]];

/**
 * Exact paths carved out of the segments above.
 *
 * `.git/info/exclude` is a list of ignore patterns with no execution or
 * credential semantics, and CoWork writes it to keep its own scratch
 * directories out of `git status`. Anything that git can turn into code — a
 * hook, `core.hooksPath`, `credential.helper`, `core.fsmonitor` — stays denied.
 */
const PROTECTED_WORKSPACE_EXCEPTIONS: string[][] = [[".git", "info", "exclude"]];

/**
 * Return true when `absolutePath` falls inside a protected location within
 * `workspacePath`. Paths outside the workspace return false — those are
 * governed by the access profile and the external-approval flow instead.
 */
export function isProtectedWorkspacePath(workspacePath: string, absolutePath: string): boolean {
  // Compare against both the lexical and the canonical workspace root. A
  // canonicalized target resolves the macOS /var -> /private/var alias (and any
  // symlinked workspace root), which would otherwise appear to escape a
  // lexical root and skip this check entirely.
  const roots = new Set<string>([nodePath.resolve(workspacePath)]);
  try {
    roots.add(canonicalizeAccessPath(workspacePath));
  } catch {
    // Workspace root may not exist yet; the lexical root still applies.
  }

  const target = nodePath.resolve(absolutePath);
  for (const root of roots) {
    const relative = nodePath.relative(root, target);
    if (!relative || relative.startsWith("..") || nodePath.isAbsolute(relative)) continue;
    const segments = relative.split(/[\\/]/).map((segment) => segment.toLowerCase());

    const isException = PROTECTED_WORKSPACE_EXCEPTIONS.some(
      (allowed) =>
        allowed.length === segments.length &&
        allowed.every((expected, index) => segments[index] === expected),
    );
    if (isException) continue;

    const matched = PROTECTED_WORKSPACE_SEGMENTS.some((protectedSegments) =>
      segments.some((_, index) =>
        protectedSegments.every((expected, offset) => segments[index + offset] === expected),
      ),
    );
    if (matched) return true;
  }
  return false;
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

export function preserveLexicalMacAlias(requestedPath: string, canonicalPath: string): string {
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

  // In-workspace policy and git-hook locations are the same kind of hard
  // boundary: they govern tool permissions or execute on commit. Both the
  // canonical and the lexical path are checked so a symlink pointing into
  // `.git/` cannot launder the write.
  if (
    operation !== "read" &&
    (isProtectedWorkspacePath(workspace.path, resolvedPath) ||
      isProtectedWorkspacePath(workspace.path, operationPath))
  ) {
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
  const [result] = await resolveWorkspaceFilesystemAccessesWithApproval(
    workspace,
    [{ rawPath, operation, label }],
    handlers,
  );
  return result;
}

/**
 * Resolve a filesystem operation that may touch multiple paths.  A rename or
 * copy can cross the workspace boundary at both ends, but the user should see
 * one scoped request describing the complete operation.  Each target is still
 * canonicalized and checked independently before and after that request.
 */
export async function resolveWorkspaceFilesystemAccessesWithApproval(
  workspace: Pick<Workspace, "path" | "permissions"> & Partial<Pick<Workspace, "isTemp">>,
  requests: readonly WorkspaceFilesystemAccessRequest[],
  handlers: WorkspaceFilesystemApprovalHandlers = {},
): Promise<WorkspaceFilesystemAccessWithApprovalResult[]> {
  if (requests.length === 0) return [];

  const initial = requests.map((request) => {
    const candidate = resolveAccessControlledPath(workspace.path, request.rawPath);
    const access = evaluateWorkspaceFilesystemAccess(workspace, candidate, request.operation);
    return {
      request,
      candidate,
      // Capture this before yielding to the approval handler.  Re-canonicalizing
      // `candidate` after the await would follow a newly installed symlink and
      // make the replacement look like the originally approved target.
      canonicalCandidate: canonicalizeAccessPath(candidate),
      access,
      external: access.reason === "outside_workspace",
      approved: false,
    };
  });
  // A hard denial anywhere in the operation (profile, protected path,
  // disabled capability, unavailable profile) must not be diluted by an
  // approval for another path.
  if (initial.some((item) => item.access.decision !== "allow" && !item.external)) {
    return initial.map(({ access }) => ({ ...access, externalApprovalGranted: false }));
  }
  const external = initial.filter((item) => item.external);
  if (external.length === 0) {
    return initial.map(({ access }) => ({ ...access, externalApprovalGranted: false }));
  }

  const missing: typeof external = [];
  for (const item of external) {
    item.approved = handlers.consume?.(item.candidate, item.request.operation) === true;
    if (!item.approved) missing.push(item);
  }

  if (missing.length > 0 && handlers.request) {
    const first = missing[0];
    const pathOperations = missing.map((item) => ({
      path: item.candidate,
      operation: item.request.operation,
    }));
    const approved = await handlers.request({
      path: first.candidate,
      operation: first.request.operation,
      label: first.request.label || "path",
      paths: pathOperations.map(({ path }) => path),
      pathOperations,
    });
    if (approved) {
      for (const item of missing) {
        // Consume the exact canonical one-shot grant when the daemon exposes
        // it.  The broker decision remains the authority for this operation;
        // consuming here prevents replay by another filesystem call.
        handlers.consume?.(item.candidate, item.request.operation);
        item.approved = true;
      }
    }
  }

  return initial.map((item) => {
    let currentCandidate: string;
    try {
      currentCandidate = resolveAccessControlledPath(workspace.path, item.request.rawPath);
    } catch {
      return {
        ...pathChangedAfterApproval(item),
        externalApprovalGranted: false,
      };
    }

    // The approval callback yields to another actor.  Re-resolve every path,
    // including paths that were initially inside the workspace, before any
    // grant is returned.  Otherwise a workspace file can be rebound through a
    // symlink while approval for a different external path is pending.
    if (!hasSameBoundCanonicalAccessPath(item.canonicalCandidate, currentCandidate)) {
      return {
        ...pathChangedAfterApproval(item),
        externalApprovalGranted: false,
      };
    }

    const currentAccess = evaluateWorkspaceFilesystemAccess(
      workspace,
      currentCandidate,
      item.request.operation,
    );
    if (!item.external) {
      if (currentAccess.decision !== "allow") {
        return { ...currentAccess, externalApprovalGranted: false };
      }
      return { ...currentAccess, externalApprovalGranted: false };
    }

    if (!item.approved) {
      return { ...currentAccess, externalApprovalGranted: false };
    }
    const granted = evaluateWorkspaceFilesystemAccess(
      workspace,
      currentCandidate,
      item.request.operation,
      { externalApprovalGranted: true },
    );
    return {
      ...granted,
      externalApprovalGranted: granted.decision === "allow",
    };
  });
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

  // `access.path` is the canonical identity captured by the approval helper;
  // keep this value immutable while checking the file below.
  const approvedCanonicalPath = access.path;
  let resolvedPath: string;
  try {
    resolvedPath = nodeFs.realpathSync.native
      ? nodeFs.realpathSync.native(access.path)
      : nodeFs.realpathSync(access.path);
  } catch {
    throw new Error(`${label} does not exist: ${rawPath}`);
  }
  if (!hasSameBoundCanonicalAccessPath(approvedCanonicalPath, resolvedPath)) {
    throw new Error(`${label} changed while awaiting approval: ${rawPath}`);
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

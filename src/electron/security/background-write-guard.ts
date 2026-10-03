import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import type { Workspace } from "../../shared/types";
import {
  canonicalizeAccessPath,
  evaluateWorkspaceFilesystemAccess,
  isAccessPathWithin,
  type AccessFilesystemOperation,
} from "./access-profile-paths";

/**
 * Guards for CoWork's own background writers (Workflow Intelligence artifacts,
 * CrossSignal / Feedback / Lore kit files). These run without a user turn, so
 * they must stay inside the workspace that owns them and still honor that
 * workspace's access profile: a denied write is skipped, never escalated.
 */

export type BackgroundWriteWorkspace = Pick<Workspace, "path" | "permissions"> &
  Partial<Pick<Workspace, "isTemp">>;

export type BackgroundKitPathGuard = (absPath: string, operation: "read" | "write") => void;

/**
 * Kit `pathGuard` for background services: the path must resolve inside the
 * workspace root (no symlink escape out of the workspace) and the workspace
 * access profile must allow the operation. Protected paths are denied by
 * `evaluateWorkspaceFilesystemAccess` itself.
 */
export function createBackgroundKitPathGuard(
  workspace: BackgroundWriteWorkspace,
  label = "workspace kit file",
): BackgroundKitPathGuard {
  return (candidatePath: string, operation: AccessFilesystemOperation) => {
    const decision = evaluateBackgroundWorkspaceAccess(workspace, candidatePath, operation);
    if (!decision.allowed) {
      throw new Error(`Access denied for ${label} "${candidatePath}": ${decision.reason}`);
    }
  };
}

export type BackgroundWriteDecision = { allowed: true } | { allowed: false; reason: string };

/** Containment in the workspace root plus the full access-profile evaluation. */
export function evaluateBackgroundWorkspaceAccess(
  workspace: BackgroundWriteWorkspace,
  candidatePath: string,
  operation: AccessFilesystemOperation,
): BackgroundWriteDecision {
  if (!workspace.path || !nodePath.isAbsolute(workspace.path)) {
    return { allowed: false, reason: "workspace_path_unavailable" };
  }
  let contained = false;
  try {
    contained = isAccessPathWithin(
      canonicalizeAccessPath(workspace.path),
      canonicalizeAccessPath(candidatePath),
    );
  } catch {
    contained = false;
  }
  if (!contained) return { allowed: false, reason: "outside_workspace_root" };
  try {
    const evaluation = evaluateWorkspaceFilesystemAccess(workspace, candidatePath, operation);
    return evaluation.decision === "allow"
      ? { allowed: true }
      : { allowed: false, reason: evaluation.reason };
  } catch {
    return { allowed: false, reason: "access_evaluation_failed" };
  }
}

export interface ConfinedInternalWriteRequest {
  /** Root that owns the artifacts (a workspace path or the user data dir). */
  root: string;
  /** Root-relative directory every target must stay in, e.g. `.cowork/subconscious`. */
  confineTo: string;
  /** Absolute file or directory paths about to be created or written. */
  targets: string[];
  /** Registered workspace at `root`, when there is one; its access profile then applies. */
  workspace?: BackgroundWriteWorkspace | null;
}

/**
 * Decide whether an internal artifact write may proceed. Requires:
 * - the root to exist as a directory (a deleted workspace is never recreated),
 * - every target to stay lexically inside `<root>/<confineTo>`,
 * - no symlink anywhere between the root and the target (so a planted link
 *   cannot redirect the write out of the workspace or into a protected path),
 * - the workspace access profile, when the root is a registered workspace.
 */
export function evaluateConfinedInternalWrite(
  request: ConfinedInternalWriteRequest,
): BackgroundWriteDecision {
  const root = nodePath.resolve(request.root);
  try {
    if (!nodeFs.statSync(root).isDirectory()) return { allowed: false, reason: "root_missing" };
  } catch {
    return { allowed: false, reason: "root_missing" };
  }
  const confineDir = nodePath.resolve(root, request.confineTo);
  for (const rawTarget of request.targets) {
    const target = nodePath.resolve(rawTarget);
    const relative = nodePath.relative(confineDir, target);
    if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
      return { allowed: false, reason: "outside_confined_dir" };
    }
    if (hasSymlinkBetween(root, target)) {
      return { allowed: false, reason: "symlink_escape" };
    }
    if (request.workspace) {
      const decision = evaluateBackgroundWorkspaceAccess(request.workspace, target, "write");
      if (!decision.allowed) return decision;
    }
  }
  return { allowed: true };
}

/** True when any existing path component below `root` up to `target` is a symlink. */
function hasSymlinkBetween(root: string, target: string): boolean {
  const relative = nodePath.relative(root, target);
  let current = root;
  for (const segment of relative.split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    let stat: nodeFs.Stats;
    try {
      stat = nodeFs.lstatSync(current);
    } catch {
      return false; // Nothing further exists; mkdir/write creates real entries.
    }
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

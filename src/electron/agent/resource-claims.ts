/**
 * Shared-change coordination (agent-first roadmap WP11): the resource a file write claims, and
 * the error a file tool reports when another task in the same folder is changing that file.
 */
import * as path from "path";
import type { ResourceClaimHolder } from "../../shared/types";

/** Prefix of the wait a refused write records; the wait ends when the write goes ahead. */
export const RESOURCE_CONFLICT_WAIT_PREFIX = "resource_conflict:";

/**
 * The claim key for a file: its path relative to the task's checkout root, so the same file in
 * the shared folder and in each worktree of the repository has one key. Undefined outside it.
 */
export function fileResource(
  workspaceRoot: string,
  candidatePath: string,
): { key: string; label: string } | undefined {
  const root = path.resolve(workspaceRoot);
  const absolute = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(root, candidatePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const label = relative.split(path.sep).join("/");
  return { key: `file:${label}`, label };
}

/** A write refused because another task in the same folder is changing the file. */
export class ResourceConflictError extends Error {
  constructor(
    readonly label: string,
    readonly holder: ResourceClaimHolder,
  ) {
    super(
      `Not written: ${label} is being changed by another task in this folder ("${holder.title}"). ` +
        "Wait for that task to finish before changing this file, or run this work in a worktree.",
    );
    this.name = "ResourceConflictError";
  }
}

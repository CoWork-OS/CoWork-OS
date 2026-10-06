/**
 * The memory repo as an app-owned filesystem root (docs/memory-repo-phase1-design.md §6.4).
 *
 * `evaluateWorkspaceFilesystemAccess` treats the running memory repo's root specially, before
 * any workspace or profile rule:
 *  - every mutation anywhere under it is denied with `protected_path` (a hard boundary: only
 *    `MemoryRepoService` writes the repo);
 *  - a read is allowed only inside a task scope whose `memoryRepo` injection layer is on
 *    (private gateway, memory retained, not a sub-agent, no `<no-memory>`), otherwise denied
 *    with `memory_repo_unavailable`.
 *
 * The root is registered by the repo bootstrap when the service starts and cleared when it
 * stops. The per-task read flag travels in an AsyncLocalStorage scope that the executor
 * opens around each tool call, so it reaches the evaluator without threading a parameter
 * through every file tool. Outside such a scope (IPC handlers, background services) reads are
 * denied: fail closed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as nodePath from "node:path";

export interface MemoryRepoAccessScope {
  /** The task's `memoryRepo` layer is on: file tools may read the repo. */
  readAllowed: boolean;
}

let memoryRepoRoot: string | null = null;
const accessScope = new AsyncLocalStorage<MemoryRepoAccessScope>();

/** Register the running memory repo's root (null when the repo stops or is off). */
export function setMemoryRepoRoot(root: string | null): void {
  const value = typeof root === "string" ? root.trim() : "";
  memoryRepoRoot = value ? nodePath.resolve(value) : null;
}

/** The registered memory repo root (lexical, absolute), or null. */
export function getMemoryRepoRoot(): string | null {
  return memoryRepoRoot;
}

let teamMemoryRepoRoots: string[] = [];

/** Register the team memory repo roots (docs/memory-repo-phase4-design.md §2): read-only. */
export function setTeamMemoryRepoRoots(roots: readonly string[]): void {
  teamMemoryRepoRoots = roots
    .map((root) => (typeof root === "string" ? root.trim() : ""))
    .filter(Boolean)
    .map((root) => nodePath.resolve(root));
}

/** The registered team memory repo roots (lexical, absolute). */
export function getTeamMemoryRepoRoots(): string[] {
  return [...teamMemoryRepoRoots];
}

/** Run `fn` (one tool call) with this task's memory repo access. */
export function runWithMemoryRepoAccess<T>(scope: MemoryRepoAccessScope, fn: () => T): T {
  return accessScope.run({ readAllowed: scope.readAllowed === true }, fn);
}

/** Whether the current tool call may read the memory repo (false outside a task scope). */
export function isMemoryRepoReadAllowed(): boolean {
  return accessScope.getStore()?.readAllowed === true;
}

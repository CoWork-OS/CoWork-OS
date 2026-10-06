/**
 * Team memory repos (docs/memory-repo-phase4-design.md §2): other memory repos read next to
 * the personal folder, never written. Each configured folder gets a read-only
 * `MemoryRepoService`; `teamMemoryReposFor(workspaceId)` lists the ones that apply.
 */
import path from "node:path";
import type { MemoryRepoTeamRepoSetting } from "../../../shared/types";
import { createLogger } from "../../utils/logger";
import { MemoryRepoService } from "./MemoryRepoService";
import { parsePorcelainZ, runMemoryRepoGit, type GitRunner } from "./memory-repo-git";
import { memoryRepoPathProblem } from "./memory-repo-paths";

const logger = createLogger("TeamMemoryRepos");

export interface TeamMemoryRepo {
  name: string;
  root: string;
  workspaceIds: string[];
  service: MemoryRepoService;
  problem?: string;
}

export interface TeamMemoryRepoStatus {
  name: string;
  root: string;
  ready: boolean;
  problem?: string;
  workspaceIds: string[];
  lastPullAt: number | null;
  lastPullError: string | null;
}

let repos: TeamMemoryRepo[] = [];
const pulls = new Map<string, { at: number | null; error: string | null }>();
const listeners = new Set<() => void>();

/** Why a team repo setting is refused, or null. */
export function teamRepoPathProblem(
  setting: MemoryRepoTeamRepoSetting,
  context: { personalRoot: string | null; workspacePaths: readonly string[]; others: readonly string[] },
): string | null {
  const problem = memoryRepoPathProblem(setting.path, context.workspacePaths);
  if (problem) return problem;
  const resolved = path.resolve(setting.path);
  const overlaps = (other: string) => {
    const a = path.resolve(other);
    return a === resolved || resolved.startsWith(`${a}${path.sep}`) || a.startsWith(`${resolved}${path.sep}`);
  };
  if (context.personalRoot && overlaps(context.personalRoot)) {
    return "A team repo cannot be inside or around your own memory folder.";
  }
  if (context.others.some(overlaps)) return "Two team repos cannot overlap.";
  return null;
}

/** Replace the configured team repos (read-only services). */
export async function configureTeamMemoryRepos(
  settings: readonly MemoryRepoTeamRepoSetting[],
  context: { personalRoot: string | null; workspacePaths: readonly string[] },
): Promise<TeamMemoryRepoStatus[]> {
  const next: TeamMemoryRepo[] = [];
  for (const setting of settings) {
    const root = path.resolve(setting.path);
    const problem = teamRepoPathProblem(setting, {
      ...context,
      others: next.map((repo) => repo.root),
    });
    const service = new MemoryRepoService({ root, runtime: "desktop", readOnly: true });
    let startProblem: string | undefined = problem ?? undefined;
    if (!problem) {
      const status = await service.start();
      if (!status.ready) startProblem = status.problem ?? "not a memory repo";
    }
    next.push({
      name: setting.name,
      root,
      workspaceIds: setting.workspaceIds ?? [],
      service,
      ...(startProblem ? { problem: startProblem } : {}),
    });
  }
  repos = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      logger.warn("Team memory listener failed:", error);
    }
  }
  return teamMemoryRepoStatuses();
}

/** The ready team repos that apply to a workspace. */
export function teamMemoryReposFor(workspaceId: string | null | undefined): TeamMemoryRepo[] {
  return repos.filter(
    (repo) =>
      !repo.problem &&
      repo.service.isReady() &&
      (repo.workspaceIds.length === 0 || (workspaceId ? repo.workspaceIds.includes(workspaceId) : false)),
  );
}

/** Every configured team repo root that is ready (for the read-only access boundary). */
export function teamMemoryRepoRoots(): string[] {
  return repos.filter((repo) => !repo.problem && repo.service.isReady()).map((repo) => repo.root);
}

export function teamMemoryRepoStatuses(): TeamMemoryRepoStatus[] {
  return repos.map((repo) => ({
    name: repo.name,
    root: repo.root,
    ready: !repo.problem && repo.service.isReady(),
    ...(repo.problem ? { problem: repo.problem } : {}),
    workspaceIds: repo.workspaceIds,
    lastPullAt: pulls.get(repo.root)?.at ?? null,
    lastPullError: pulls.get(repo.root)?.error ?? null,
  }));
}

export function onTeamMemoryReposChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Fast-forward team repos that have an `origin` remote and a clean work tree. Anything else
 * (local changes, diverged history) is left to the user.
 */
export async function pullTeamMemoryRepos(git: GitRunner = runMemoryRepoGit): Promise<void> {
  for (const repo of repos.filter((entry) => !entry.problem && entry.service.isReady())) {
    try {
      const remotes = (await git(repo.root, ["remote"])).split("\n").map((line) => line.trim());
      if (!remotes.includes("origin")) continue;
      if (parsePorcelainZ(await git(repo.root, ["status", "--porcelain=v1", "-z"])).length > 0) {
        pulls.set(repo.root, { at: pulls.get(repo.root)?.at ?? null, error: "Local changes; not updated." });
        continue;
      }
      await git(repo.root, ["pull", "--quiet", "--ff-only", "--no-tags", "origin"]);
      pulls.set(repo.root, { at: Date.now(), error: null });
    } catch (error) {
      pulls.set(repo.root, {
        at: pulls.get(repo.root)?.at ?? null,
        error: String(error instanceof Error ? error.message : error).slice(0, 300),
      });
    }
  }
}

export function resetTeamMemoryReposForTests(): void {
  repos = [];
  pulls.clear();
}

/**
 * Private-remote sync of the memory folder (docs/memory-repo-phase4-design.md §1).
 *
 * Only this module talks to the network for the folder. The remote `cowork-sync` is managed
 * from the settings; pull = fetch + rebase of local commits (abort on conflict, sync pauses);
 * push = `push cowork-sync main` (never dream branches; `--force-with-lease` only after a
 * compaction the user confirmed). Credentials come from the user's own git setup.
 */
import type { GitRunner } from "./memory-repo-git";

export const MEMORY_REPO_SYNC_REMOTE = "cowork-sync";
const BRANCH = "main";

/** Why a remote URL is refused, or null when it is acceptable. */
export function memoryRepoRemoteUrlProblem(value: string): string | null {
  const url = String(value || "").trim();
  if (!url) return null;
  if (url.length > 500) return "The URL is too long.";
  if (url.startsWith("-")) return "Not a repository URL.";
  if (/[\s\r\n]/.test(url)) return "The URL cannot contain spaces.";
  if (/^(?:file|ext|fd)::?/i.test(url) || /^[a-z]+::/i.test(url)) {
    return "Only https and ssh remotes are supported.";
  }
  if (/^https:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        return "Don't put credentials in the URL; use your git credential helper.";
      }
      if (!parsed.hostname) return "Not a repository URL.";
      return null;
    } catch {
      return "Not a repository URL.";
    }
  }
  if (/^ssh:\/\/[^\s/]+\/.+/i.test(url)) return null;
  // scp-style: user@host:path
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url)) return null;
  return "Only https and ssh remotes are supported.";
}

/** The URL with any user info removed, for logs and status. */
export function redactRemoteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/^[^@]+@/, "…@");
  }
}

export interface MemoryRepoSyncState {
  remoteUrl: string | null;
  lastPullAt: number | null;
  lastPushAt: number | null;
  ahead: number;
  behind: number;
  /** Set when a pull hit a conflict: sync is paused until the user resolves it. */
  conflict: string | null;
  lastError: string | null;
}

export function emptySyncState(): MemoryRepoSyncState {
  return {
    remoteUrl: null,
    lastPullAt: null,
    lastPushAt: null,
    ahead: 0,
    behind: 0,
    conflict: null,
    lastError: null,
  };
}

/** Make the managed remote match `url` (add, update or remove). */
export async function configureSyncRemote(
  git: GitRunner,
  root: string,
  url: string | null,
): Promise<void> {
  const remotes = (await git(root, ["remote"]).catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const has = remotes.includes(MEMORY_REPO_SYNC_REMOTE);
  if (!url) {
    if (has) await git(root, ["remote", "remove", MEMORY_REPO_SYNC_REMOTE]);
    return;
  }
  if (has) await git(root, ["remote", "set-url", MEMORY_REPO_SYNC_REMOTE, "--", url]);
  else await git(root, ["remote", "add", MEMORY_REPO_SYNC_REMOTE, "--", url]);
}

async function remoteBranchExists(git: GitRunner, root: string): Promise<boolean> {
  return git(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/${MEMORY_REPO_SYNC_REMOTE}/${BRANCH}`,
  ]).then(
    (out) => out.trim().length > 0,
    () => false,
  );
}

async function aheadBehind(
  git: GitRunner,
  root: string,
): Promise<{ ahead: number; behind: number }> {
  if (!(await remoteBranchExists(git, root))) {
    const count = Number(
      (await git(root, ["rev-list", "--count", "HEAD"]).catch(() => "0")).trim(),
    );
    return { ahead: Number.isFinite(count) ? count : 0, behind: 0 };
  }
  const out = (
    await git(root, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${MEMORY_REPO_SYNC_REMOTE}/${BRANCH}`,
    ]).catch(() => "0\t0")
  ).trim();
  const [ahead, behind] = out.split(/\s+/).map((n) => Number(n) || 0);
  return { ahead, behind };
}

/**
 * Fetch and rebase local commits onto the remote. Must run under the folder's write lock with
 * a clean work tree. Returns the new counts; a conflict aborts the rebase and is reported.
 */
export async function pullMemoryRepo(
  git: GitRunner,
  root: string,
): Promise<
  | { ok: true; ahead: number; behind: number; changed: boolean }
  | { ok: false; conflict?: string; error?: string }
> {
  try {
    await git(root, ["fetch", "--quiet", "--no-tags", MEMORY_REPO_SYNC_REMOTE, BRANCH]);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    // An empty remote has no main yet: nothing to pull.
    if (/couldn't find remote ref|not found in upstream/i.test(message)) {
      return { ok: true, ...(await aheadBehind(git, root)), changed: false };
    }
    return { ok: false, error: message.slice(0, 300) };
  }
  const before = (await git(root, ["rev-parse", "HEAD"])).trim();
  const counts = await aheadBehind(git, root);
  if (counts.behind > 0) {
    try {
      await git(root, ["rebase", "--quiet", `${MEMORY_REPO_SYNC_REMOTE}/${BRANCH}`]);
    } catch (error) {
      await git(root, ["rebase", "--abort"]).catch(() => undefined);
      return {
        ok: false,
        conflict: `Your memory changed here and on another machine in the same place (${String(
          error instanceof Error ? error.message : error,
        ).slice(0, 200)}).`,
      };
    }
  }
  const after = (await git(root, ["rev-parse", "HEAD"])).trim();
  return { ok: true, ...(await aheadBehind(git, root)), changed: before !== after };
}

/** Push main. `force` (after a confirmed compaction) uses --force-with-lease. */
export async function pushMemoryRepo(
  git: GitRunner,
  root: string,
  options: { force?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const lease = options.force
      ? (await remoteBranchExists(git, root))
        ? [`--force-with-lease=${BRANCH}:${MEMORY_REPO_SYNC_REMOTE}/${BRANCH}`]
        : ["--force"]
      : [];
    await git(root, [
      "push",
      "--quiet",
      ...lease,
      MEMORY_REPO_SYNC_REMOTE,
      `HEAD:refs/heads/${BRANCH}`,
    ]);
    await git(root, ["fetch", "--quiet", "--no-tags", MEMORY_REPO_SYNC_REMOTE, BRANCH]).catch(
      () => undefined,
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: String(error instanceof Error ? error.message : error).slice(0, 300),
    };
  }
}

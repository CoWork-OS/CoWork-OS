/**
 * Hardened git for the memory repo (docs/memory-repo-phase1-design.md §5.4), modelled on
 * `readOnlyGitOptions` / `commitStaged` in host/services/browser-git-methods.ts:
 *
 * - `execFile` without a shell; every inherited `GIT_*` variable removed;
 * - hooks never run (`core.hooksPath` points at an empty directory), no GPG signing, no
 *   fsmonitor, no line-ending conversion;
 * - CoWork's own author and committer, never the user's global identity;
 * - no network commands: this module has no fetch, pull or push.
 */
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MEMORY_REPO_GIT_NAME = "CoWork OS";
export const MEMORY_REPO_GIT_EMAIL = "memory@cowork.invalid";
const GIT_TIMEOUT_MS = 10_000;
/** fetch/push/pull talk to a remote (Phase 4 sync): longer timeout, never prompt. */
const NETWORK_COMMANDS: ReadonlySet<string> = new Set(["fetch", "push", "pull", "ls-remote"]);
const GIT_NETWORK_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export class MemoryRepoGitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = "MemoryRepoGitError";
  }
}

let emptyHooksDir: string | null = null;

function hooksDir(): string {
  if (!emptyHooksDir) emptyHooksDir = mkdtempSync(path.join(os.tmpdir(), "cowork-memory-hooks-"));
  return emptyHooksDir;
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_AUTHOR_NAME = MEMORY_REPO_GIT_NAME;
  env.GIT_AUTHOR_EMAIL = MEMORY_REPO_GIT_EMAIL;
  env.GIT_COMMITTER_NAME = MEMORY_REPO_GIT_NAME;
  env.GIT_COMMITTER_EMAIL = MEMORY_REPO_GIT_EMAIL;
  return env;
}

function hardeningArgs(): string[] {
  return [
    "-c",
    `core.hooksPath=${hooksDir()}`,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.quotepath=false",
    "-c",
    "init.defaultBranch=main",
    "-c",
    `user.name=${MEMORY_REPO_GIT_NAME}`,
    "-c",
    `user.email=${MEMORY_REPO_GIT_EMAIL}`,
  ];
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

/** Run git in `cwd` with the hardening options. Resolves stdout; rejects MemoryRepoGitError. */
export const runMemoryRepoGit: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...hardeningArgs(), ...args],
      {
        cwd,
        env: NETWORK_COMMANDS.has(args[0] ?? "")
          ? { ...scrubbedEnv(), GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }
          : scrubbedEnv(),
        shell: false,
        timeout: NETWORK_COMMANDS.has(args[0] ?? "") ? GIT_NETWORK_TIMEOUT_MS : GIT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new MemoryRepoGitError(
              `git ${args[0] ?? ""} failed: ${String(stderr || error.message)
                .trim()
                .slice(0, 500)}`,
              args,
              String(stderr || ""),
            ),
          );
          return;
        }
        resolve(String(stdout));
      },
    );
  });

let gitAvailable: Promise<boolean> | null = null;

/** Whether a `git` executable answers `--version` (cached per process). */
export function isGitAvailable(run: GitRunner = runMemoryRepoGit): Promise<boolean> {
  if (!gitAvailable) {
    gitAvailable = run(os.tmpdir(), ["--version"]).then(
      () => true,
      () => false,
    );
  }
  return gitAvailable;
}

export function resetGitAvailabilityForTests(): void {
  gitAvailable = null;
}

/** One `git status --porcelain=v1 -z` record. */
export interface GitStatusEntry {
  /** Two status letters, e.g. ` M`, `??`, `UU`. */
  code: string;
  path: string;
}

export function parsePorcelainZ(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  const parts = output.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    entries.push({ code, path: record.slice(3) });
    // Renames and copies carry the original path as the next record.
    if (code[0] === "R" || code[0] === "C") i += 1;
  }
  return entries;
}

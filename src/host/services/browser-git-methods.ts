import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { HostCapabilities } from "../../shared/host-api/contracts";
import { isTempWorkspaceId, type Workspace } from "../../shared/types";
import { GitService } from "../../electron/git/GitService";
import {
  evaluateWorkspaceFilesystemAccess,
  resolveAccessControlledPath,
} from "../../electron/security/access-profile-paths";
import {
  WebApplicationError,
  type WebRequestContext,
  type WebRpcMethod,
} from "../web/WebApplication";

const DEFAULT_MAX_DIFF_BYTES = 64 * 1024;
const MAX_CONFIGURED_DIFF_BYTES = 256 * 1024;
const MAX_RELATIVE_PATH_CHARS = 4_096;
const MAX_BRANCH_CHARS = 256;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

export interface BrowserGitStatusSummary {
  workspaceId: string;
  isRepository: boolean;
  branch: string | null;
  clean: boolean;
  changedFiles: number;
  stagedChanges: number;
  unstagedChanges: number;
  untrackedFiles: number;
  conflictedFiles: number;
  truncated: boolean;
}

export interface BrowserGitDiffSummary {
  workspaceId: string;
  isRepository: boolean;
  staged: boolean;
  relativePath: string | null;
  diff: string;
  truncated: boolean;
}

export interface BrowserGitOperations {
  isGitRepo: (directoryPath: string) => Promise<boolean>;
  getRepoRoot: (directoryPath: string) => Promise<string>;
  getCurrentBranch: (repositoryPath: string) => Promise<string>;
  getStatus: (repositoryPath: string) => Promise<string>;
  getDiff: (
    repositoryPath: string,
    options?: { staged?: boolean; file?: string },
  ) => Promise<string>;
}

export interface BrowserGitSources {
  /** Must return the workspace with the caller's current effective access profile applied. */
  resolveWorkspace: (
    workspaceId: string,
    context: WebRequestContext,
  ) => Workspace | null | undefined | Promise<Workspace | null | undefined>;
  getCapabilities: (
    context: WebRequestContext,
  ) => Pick<HostCapabilities, "git.read"> | Promise<Pick<HostCapabilities, "git.read">>;
  git?: BrowserGitOperations;
  maxDiffBytes?: number;
}

interface WorkspaceParams {
  workspaceId: string;
}

interface DiffParams extends WorkspaceParams {
  staged: boolean;
  relativePath: string | null;
}

/** Read-only browser Git views scoped to a single authorized workspace. */
export function createBrowserGitMethods(sources: BrowserGitSources): Record<string, WebRpcMethod> {
  const git = sources.git ?? defaultGitOperations;
  return {
    "git.status": {
      capability: "git.read",
      validateParams: parseWorkspaceParams,
      handler: async (context, params) => {
        const request = params as WorkspaceParams;
        const workspace = await resolveAuthorizedWorkspace(sources, context, request.workspaceId);
        const repository = await resolveRepository(workspace, git);
        if (!repository) return emptyStatus(request.workspaceId);
        if (!canReadWholeRepository(workspace, repository.rootPath)) throw wholeRepositoryDenied();

        try {
          await assertStableWorkspaceRoot(workspace.path, repository);
          const [branch, status] = await Promise.all([
            git.getCurrentBranch(repository.rootPath),
            git.getStatus(repository.rootPath),
          ]);
          await assertStableWorkspaceRoot(workspace.path, repository);
          return summarizeStatus(request.workspaceId, branch, status);
        } catch (error) {
          if (error instanceof WebApplicationError) throw error;
          throw gitUnavailable();
        }
      },
    },
    "git.diff": {
      capability: "git.read",
      validateParams: parseDiffParams,
      handler: async (context, params) => {
        const request = params as DiffParams;
        const workspace = await resolveAuthorizedWorkspace(sources, context, request.workspaceId);
        const repository = await resolveRepository(workspace, git);
        if (!repository) return emptyDiff(request);

        let gitFilePath: string | undefined;
        if (request.relativePath !== null) {
          await assertAuthorizedRelativeFile(workspace, repository.rootPath, request.relativePath);
          gitFilePath = request.relativePath;
        } else if (!canReadWholeRepository(workspace, repository.rootPath)) {
          throw wholeRepositoryDenied();
        }

        try {
          await assertStableWorkspaceRoot(workspace.path, repository);
          const diff = await git.getDiff(repository.rootPath, {
            staged: request.staged,
            file: gitFilePath,
          });
          await assertStableWorkspaceRoot(workspace.path, repository);
          return summarizeDiff(request, diff, boundedInteger(sources.maxDiffBytes));
        } catch (error) {
          if (error instanceof WebApplicationError) throw error;
          throw gitUnavailable();
        }
      },
    },
  };
}

const defaultGitOperations: BrowserGitOperations = {
  isGitRepo: (directoryPath) => GitService.isGitRepo(directoryPath),
  getRepoRoot: (directoryPath) => GitService.getRepoRoot(directoryPath),
  getCurrentBranch: async (repositoryPath) => {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
        readOnlyGitOptions(repositoryPath),
      );
      return stdout.trim();
    } catch {
      const { stdout } = await execFileAsync(
        "git",
        ["--no-optional-locks", "rev-parse", "--abbrev-ref", "HEAD"],
        readOnlyGitOptions(repositoryPath),
      );
      return stdout.trim();
    }
  },
  getStatus: async (repositoryPath) => {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", "status", "--short"],
      readOnlyGitOptions(repositoryPath),
    );
    return stdout;
  },
  getDiff: async (repositoryPath, options) => {
    const args = [
      "--no-optional-locks",
      "--no-pager",
      "--literal-pathspecs",
      "-c",
      "diff.external=",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
    ];
    if (options?.staged) args.push("--cached");
    if (options?.file) args.push("--", options.file);
    const { stdout } = await execFileAsync("git", args, readOnlyGitOptions(repositoryPath));
    return stdout;
  },
};

function readOnlyGitOptions(cwd: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return {
    cwd,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    shell: false,
    env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
  };
}

async function resolveAuthorizedWorkspace(
  sources: BrowserGitSources,
  context: WebRequestContext,
  workspaceId: string,
): Promise<Workspace> {
  if (!context.sessionId || !context.identity.profileId || isTempWorkspaceId(workspaceId)) {
    throw workspaceUnavailable();
  }
  let capabilities: Pick<HostCapabilities, "git.read">;
  let workspace: Workspace | null | undefined;
  try {
    [capabilities, workspace] = await Promise.all([
      sources.getCapabilities(context),
      sources.resolveWorkspace(workspaceId, context),
    ]);
  } catch {
    throw workspaceUnavailable();
  }
  if (capabilities["git.read"]?.available !== true) {
    throw new WebApplicationError("UNSUPPORTED_CAPABILITY", "Git read is unavailable.", 403);
  }
  if (
    !workspace ||
    workspace.id !== workspaceId ||
    workspace.isTemp === true ||
    isTempWorkspaceId(workspace.id) ||
    !workspace.path ||
    !workspace.permissions ||
    workspace.permissions.read !== true
  ) {
    throw workspaceUnavailable();
  }
  return workspace;
}

async function resolveRepository(
  workspace: Workspace,
  git: BrowserGitOperations,
): Promise<{ rootPath: string; device: number; inode: number } | null> {
  let rootPath: string;
  let rootStats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    rootPath = await fs.realpath(workspace.path);
    rootStats = await fs.stat(rootPath);
  } catch {
    throw workspaceUnavailable();
  }
  if (!rootStats.isDirectory()) throw workspaceUnavailable();
  if (!isWorkspacePathReadable(workspace, rootPath)) throw workspaceUnavailable();

  let isRepository = false;
  try {
    isRepository = await git.isGitRepo(rootPath);
  } catch {
    throw gitUnavailable();
  }
  if (!isRepository) return null;

  let canonicalGitRoot: string;
  try {
    canonicalGitRoot = await fs.realpath(await git.getRepoRoot(rootPath));
  } catch {
    throw gitUnavailable();
  }
  // A workspace nested inside a larger repository must not expose the parent repo.
  if (canonicalGitRoot !== rootPath) throw workspaceUnavailable();
  return { rootPath, device: rootStats.dev, inode: rootStats.ino };
}

function canReadWholeRepository(workspace: Workspace, rootPath: string): boolean {
  try {
    if (workspace.permissions.read !== true || !isWorkspacePathReadable(workspace, rootPath)) {
      return false;
    }
    // A denied descendant could appear in status or whole-repository diff output.
    return !(workspace.permissions.accessFilesystemRules || []).some((rule) => {
      if (rule.access !== "deny") return false;
      const deniedPath = resolveAccessControlledPath(workspace.path, rule.path);
      return isWithin(rootPath, deniedPath) || isWithin(deniedPath, rootPath);
    });
  } catch {
    return false;
  }
}

async function assertAuthorizedRelativeFile(
  workspace: Workspace,
  rootPath: string,
  relativePath: string,
): Promise<void> {
  const segments = relativePath.split("/");
  let currentPath = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    const stats = await fs.lstat(currentPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && index === segments.length - 1) return null;
      throw workspaceUnavailable();
    });
    if (!stats) continue;
    if (stats.isSymbolicLink()) throw workspaceUnavailable();
    if (index < segments.length - 1 && !stats.isDirectory()) throw workspaceUnavailable();
    if (index === segments.length - 1 && !stats.isFile()) throw workspaceUnavailable();
  }
  if (!isWithin(rootPath, currentPath) || !isWorkspacePathReadable(workspace, currentPath)) {
    throw workspaceUnavailable();
  }
}

function isWorkspacePathReadable(workspace: Workspace, candidatePath: string): boolean {
  try {
    return evaluateWorkspaceFilesystemAccess(workspace, candidatePath, "read").decision === "allow";
  } catch {
    return false;
  }
}

async function assertStableWorkspaceRoot(
  workspacePath: string,
  expected: { rootPath: string; device: number; inode: number },
): Promise<void> {
  try {
    const [canonicalPath, stats] = await Promise.all([
      fs.realpath(workspacePath),
      fs.stat(expected.rootPath),
    ]);
    if (
      canonicalPath !== expected.rootPath ||
      !stats.isDirectory() ||
      stats.dev !== expected.device ||
      stats.ino !== expected.inode
    ) {
      throw workspaceUnavailable();
    }
  } catch (error) {
    if (error instanceof WebApplicationError) throw error;
    throw workspaceUnavailable();
  }
}

function summarizeStatus(
  workspaceId: string,
  rawBranch: string,
  rawStatus: string,
): BrowserGitStatusSummary {
  const lines = rawStatus.split(/\r?\n/).filter((line) => line.length >= 3 && line[2] === " ");
  let stagedChanges = 0;
  let unstagedChanges = 0;
  let untrackedFiles = 0;
  let conflictedFiles = 0;
  for (const line of lines) {
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedFiles += 1;
      continue;
    }
    if (indexStatus !== " ") stagedChanges += 1;
    if (worktreeStatus !== " ") unstagedChanges += 1;
    if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(`${indexStatus}${worktreeStatus}`)) {
      conflictedFiles += 1;
    }
  }
  return {
    workspaceId,
    isRepository: true,
    branch: sanitizeBranch(rawBranch),
    clean: lines.length === 0,
    changedFiles: lines.length,
    stagedChanges,
    unstagedChanges,
    untrackedFiles,
    conflictedFiles,
    truncated: false,
  };
}

function summarizeDiff(
  request: DiffParams,
  rawDiff: string,
  maxBytes: number,
): BrowserGitDiffSummary {
  const buffer = Buffer.from(rawDiff, "utf8");
  const truncated = buffer.byteLength > maxBytes;
  let diff = rawDiff;
  if (truncated) {
    let end = maxBytes;
    while (end > 0) {
      try {
        diff = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
        break;
      } catch {
        end -= 1;
      }
    }
    if (end === 0) diff = "";
  }
  return {
    workspaceId: request.workspaceId,
    isRepository: true,
    staged: request.staged,
    relativePath: request.relativePath,
    diff,
    truncated,
  };
}

function emptyStatus(workspaceId: string): BrowserGitStatusSummary {
  return {
    workspaceId,
    isRepository: false,
    branch: null,
    clean: true,
    changedFiles: 0,
    stagedChanges: 0,
    unstagedChanges: 0,
    untrackedFiles: 0,
    conflictedFiles: 0,
    truncated: false,
  };
}

function emptyDiff(request: DiffParams): BrowserGitDiffSummary {
  return {
    workspaceId: request.workspaceId,
    isRepository: false,
    staged: request.staged,
    relativePath: request.relativePath,
    diff: "",
    truncated: false,
  };
}

function parseWorkspaceParams(value: unknown): WorkspaceParams {
  if (!isRecord(value)) throw invalidParams();
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId.trim() : "";
  if (!workspaceId || workspaceId.length > 128) throw invalidParams();
  return { workspaceId };
}

function parseDiffParams(value: unknown): DiffParams {
  if (!isRecord(value)) throw invalidParams();
  const workspace = parseWorkspaceParams(value);
  const staged = value.staged === undefined ? false : value.staged;
  const rawRelativePath = value.relativePath;
  if (typeof staged !== "boolean") throw invalidParams();
  if (rawRelativePath === undefined || rawRelativePath === null || rawRelativePath === "") {
    return { ...workspace, staged, relativePath: null };
  }
  if (typeof rawRelativePath !== "string") throw invalidParams();
  const relativePath = normalizeRelativeFilePath(rawRelativePath);
  return { ...workspace, staged, relativePath };
}

function normalizeRelativeFilePath(value: string): string {
  if (
    !value ||
    value.length > MAX_RELATIVE_PATH_CHARS ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:/.test(value)
  ) {
    throw invalidParams();
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw invalidParams();
  }
  return segments.join("/");
}

function sanitizeBranch(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_BRANCH_CHARS);
}

function boundedInteger(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_DIFF_BYTES;
  return Math.max(1, Math.min(MAX_CONFIGURED_DIFF_BYTES, Math.floor(value!)));
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidParams(): WebApplicationError {
  return new WebApplicationError("INVALID_REQUEST", "Invalid browser Git parameters.", 400);
}

function workspaceUnavailable(): WebApplicationError {
  return new WebApplicationError("UNSUPPORTED_CAPABILITY", "Workspace Git is unavailable.", 404);
}

function wholeRepositoryDenied(): WebApplicationError {
  return new WebApplicationError(
    "FORBIDDEN",
    "The effective access profile limits this Git view.",
    403,
  );
}

function gitUnavailable(): WebApplicationError {
  return new WebApplicationError(
    "HOST_UNAVAILABLE",
    "Git repository data is unavailable.",
    503,
    true,
  );
}

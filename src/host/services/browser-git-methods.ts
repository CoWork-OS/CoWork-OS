import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  BrowserGitAction,
  BrowserGitDiffSummary as SharedBrowserGitDiffSummary,
  BrowserGitFileStatus,
  BrowserGitMutationInput,
  BrowserGitMutationIntent,
  BrowserGitMutationReceipt,
  BrowserGitMutationReceipts,
  BrowserGitMutationResult,
  BrowserGitStatusSummary as SharedBrowserGitStatusSummary,
} from "../../shared/host-api/git";
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
const MAX_STATUS_FILES = 500;
const MAX_MUTATION_PATHS = 100;
const MAX_COMMIT_MESSAGE_CHARS = 4_000;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

export type BrowserGitStatusSummary = SharedBrowserGitStatusSummary;
export type BrowserGitDiffSummary = SharedBrowserGitDiffSummary;

export interface BrowserGitOperations {
  isGitRepo: (directoryPath: string) => Promise<boolean>;
  getRepoRoot: (directoryPath: string) => Promise<string>;
  getCurrentBranch: (repositoryPath: string) => Promise<string>;
  getStatus: (repositoryPath: string) => Promise<string>;
  getDiff: (
    repositoryPath: string,
    options?: { staged?: boolean; file?: string },
  ) => Promise<string>;
  getHead?: (repositoryPath: string) => Promise<string | null>;
  getIndexState?: (repositoryPath: string) => Promise<string>;
  getIndexTree?: (repositoryPath: string) => Promise<string>;
  stagePaths?: (repositoryPath: string, paths: string[]) => Promise<void>;
  unstagePaths?: (repositoryPath: string, paths: string[], hasHead: boolean) => Promise<void>;
  commitStaged?: (repositoryPath: string, message: string) => Promise<void>;
  getCommitSummary?: (repositoryPath: string) => Promise<{
    sha: string;
    parent: string | null;
    tree: string;
    message: string;
    filesChanged: number;
  }>;
}

export interface BrowserGitSources {
  /** Must return the workspace with the caller's current effective access profile applied. */
  resolveWorkspace: (
    workspaceId: string,
    context: WebRequestContext,
  ) => Workspace | null | undefined | Promise<Workspace | null | undefined>;
  getCapabilities: (
    context: WebRequestContext,
  ) =>
    | Partial<Pick<HostCapabilities, "git.read" | "git.write">>
    | Promise<Partial<Pick<HostCapabilities, "git.read" | "git.write">>>;
  receipts?: BrowserGitMutationReceipts;
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

/** Browser Git methods scoped to one authorized workspace and selected paths. */
export function createBrowserGitMethods(sources: BrowserGitSources): Record<string, WebRpcMethod> {
  const git = sources.git ?? defaultGitOperations;
  const workspaceMutationTails = new Map<string, Promise<unknown>>();
  const methods: Record<string, WebRpcMethod> = {
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
          const [branch, snapshot] = await Promise.all([
            git.getCurrentBranch(repository.rootPath),
            getRepositorySnapshot(workspace, repository, git),
          ]);
          await assertStableWorkspaceRoot(workspace.path, repository);
          return summarizeStatus(
            request.workspaceId,
            branch,
            snapshot.rawStatus,
            snapshot.revision,
          );
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
  if (sources.receipts) {
    Object.assign(methods, createBrowserGitMutationMethods(sources, git, workspaceMutationTails));
  }
  return methods;
}

interface MutationParams extends WorkspaceParams {
  expectedRevision: string;
  relativePaths?: string[];
  message?: string;
}

interface GitRepositorySnapshot {
  rawStatus: string;
  entries: BrowserGitFileStatus[];
  revision: string;
  head: string | null;
  indexState: string;
}

function createBrowserGitMutationMethods(
  sources: BrowserGitSources,
  git: BrowserGitOperations,
  workspaceMutationTails: Map<string, Promise<unknown>>,
): Record<string, WebRpcMethod> {
  const createMethod = (action: BrowserGitAction): WebRpcMethod => ({
    capability: "git.write",
    mutation: true,
    validateParams: (value) => parseMutationParams(action, value),
    handler: async (context, params) => {
      if (!sources.receipts) throw gitWriteUnavailable();
      const request = params as MutationParams;
      const operationKey = requireOperationKey(context.operationKey);
      const workspace = await resolveAuthorizedWorkspace(
        sources,
        context,
        request.workspaceId,
        true,
      );
      const repository = await resolveRepository(workspace, git);
      if (!repository) throw workspaceUnavailable();
      if (!canReadWholeRepository(workspace, repository.rootPath)) throw wholeRepositoryDenied();

      const relativePaths = request.relativePaths ?? [];
      if (action !== "commit") {
        for (const relativePath of relativePaths) {
          await assertAuthorizedMutationPath(workspace, repository.rootPath, relativePath);
        }
      }

      const lockKey = JSON.stringify([
        context.identity.installationId,
        context.identity.profileId,
        workspace.id,
      ]);
      return serializeByKey(workspaceMutationTails, lockKey, () =>
        mutateGitRepository(
          sources,
          git,
          context,
          workspace,
          repository,
          action,
          request,
          operationKey,
        ),
      );
    },
  });

  return {
    "git.stage": createMethod("stage"),
    "git.unstage": createMethod("unstage"),
    "git.commit": createMethod("commit"),
  };
}

async function mutateGitRepository(
  sources: BrowserGitSources,
  git: BrowserGitOperations,
  context: WebRequestContext,
  workspace: Workspace,
  repository: { rootPath: string; device: number; inode: number },
  action: BrowserGitAction,
  request: MutationParams,
  operationKey: string,
): Promise<BrowserGitMutationResult> {
  const receipts = sources.receipts;
  if (!receipts) throw gitWriteUnavailable();
  const fingerprint = hashPayload({ method: `git.${action}`, params: request });
  const scopedKey = getScopedOperationKey(context, operationKey);
  const existing = await receipts.get(scopedKey);
  if (existing) {
    assertReceiptMatches(existing, fingerprint, request, action);
    if (existing.state === "completed" && existing.result) {
      return { ...existing.result, outcome: "reconciled" };
    }
    const reconciled = await tryReconcileGitMutation(
      git,
      workspace,
      repository,
      existing.intent,
      action,
    );
    if (reconciled) {
      await receipts.complete(scopedKey, reconciled);
      return reconciled;
    }
    const current = await getRepositorySnapshot(workspace, repository, git);
    if (!matchesExpectedState(existing.intent, current, action)) throw outcomeUnknown();
    return runAndCompleteGitMutation(
      sources,
      git,
      workspace,
      repository,
      scopedKey,
      existing.intent,
      action,
    );
  }

  const snapshot = await getRepositorySnapshot(workspace, repository, git);
  if (snapshot.revision !== request.expectedRevision) throw staleGitState();
  const intent: BrowserGitMutationIntent = {
    ...request,
    action,
    expectedHead: snapshot.head,
    expectedTree: action === "commit" ? await getIndexTree(git, repository.rootPath) : "",
  };
  if (action === "commit") {
    if (snapshot.entries.length > MAX_STATUS_FILES) throw tooManyGitChanges();
    if (snapshot.entries.some((entry) => entry.conflicted)) throw unresolvedGitConflict();
    if (!snapshot.entries.some((entry) => entry.staged)) throw nothingToCommit();
    await authorizeStagedPaths(workspace, repository.rootPath, snapshot.entries);
  } else {
    assertRequestedPathsAreChanged(snapshot.entries, intent.relativePaths ?? []);
  }

  const reserved = await receipts.reserve(scopedKey, fingerprint, intent);
  assertReceiptMatches(reserved.receipt, fingerprint, request, action);
  if (!reserved.created) {
    if (reserved.receipt.state === "completed" && reserved.receipt.result) {
      return { ...reserved.receipt.result, outcome: "reconciled" };
    }
    const replayResult = await tryReconcileGitMutation(
      git,
      workspace,
      repository,
      reserved.receipt.intent,
      action,
    );
    if (replayResult) {
      await receipts.complete(scopedKey, replayResult);
      return replayResult;
    }
    const current = await getRepositorySnapshot(workspace, repository, git);
    if (!matchesExpectedState(reserved.receipt.intent, current, action)) throw outcomeUnknown();
    return runAndCompleteGitMutation(
      sources,
      git,
      workspace,
      repository,
      scopedKey,
      reserved.receipt.intent,
      action,
    );
  }

  return runAndCompleteGitMutation(sources, git, workspace, repository, scopedKey, intent, action);
}

async function runAndCompleteGitMutation(
  sources: BrowserGitSources,
  git: BrowserGitOperations,
  workspace: Workspace,
  repository: { rootPath: string; device: number; inode: number },
  scopedKey: string,
  intent: BrowserGitMutationIntent,
  action: BrowserGitAction,
): Promise<BrowserGitMutationResult> {
  const receipts = sources.receipts;
  if (!receipts) throw gitWriteUnavailable();
  try {
    await assertStableWorkspaceRoot(workspace.path, repository);
    const before = await getRepositorySnapshot(workspace, repository, git);
    if (!matchesExpectedState(intent, before, action)) throw staleGitState();

    if (action === "stage") {
      const stagePaths = requireGitOperation(git.stagePaths);
      for (const relativePath of intent.relativePaths ?? []) {
        await assertAuthorizedMutationPath(workspace, repository.rootPath, relativePath);
      }
      await stagePaths(repository.rootPath, intent.relativePaths ?? []);
    } else if (action === "unstage") {
      const unstagePaths = requireGitOperation(git.unstagePaths);
      for (const relativePath of intent.relativePaths ?? []) {
        await assertAuthorizedMutationPath(workspace, repository.rootPath, relativePath);
      }
      await unstagePaths(
        repository.rootPath,
        intent.relativePaths ?? [],
        intent.expectedHead !== null,
      );
    } else {
      const stagedPaths = before.entries.filter((entry) => entry.staged);
      if (stagedPaths.some((entry) => entry.conflicted)) throw unresolvedGitConflict();
      await authorizeStagedPaths(workspace, repository.rootPath, stagedPaths);
      await requireGitOperation(git.commitStaged)(repository.rootPath, intent.message ?? "");
    }

    await assertStableWorkspaceRoot(workspace.path, repository);
    const result = await buildGitMutationResult(
      git,
      workspace,
      repository,
      intent,
      action,
      "applied",
    );
    if (
      !isGitMutationApplied(
        intent,
        action,
        result,
        await getRepositorySnapshot(workspace, repository, git),
        git,
        repository.rootPath,
      )
    ) {
      throw outcomeUnknown();
    }
    await receipts.complete(scopedKey, result);
    return result;
  } catch (error) {
    if (error instanceof WebApplicationError) throw error;
    const reconciled = await tryReconcileGitMutation(
      git,
      workspace,
      repository,
      intent,
      action,
    ).catch(() => null);
    if (reconciled) {
      await receipts.complete(scopedKey, reconciled).catch(() => undefined);
      return reconciled;
    }
    const current = await getRepositorySnapshot(workspace, repository, git).catch(() => null);
    if (current && matchesExpectedState(intent, current, action)) throw gitUnavailable();
    throw outcomeUnknown();
  }
}

async function buildGitMutationResult(
  git: BrowserGitOperations,
  workspace: Workspace,
  repository: { rootPath: string; device: number; inode: number },
  intent: BrowserGitMutationIntent,
  action: BrowserGitAction,
  outcome: "applied" | "reconciled",
): Promise<BrowserGitMutationResult> {
  const [branch, snapshot] = await Promise.all([
    git.getCurrentBranch(repository.rootPath),
    getRepositorySnapshot(workspace, repository, git),
  ]);
  const result: BrowserGitMutationResult = {
    workspaceId: workspace.id,
    action,
    outcome,
    revision: snapshot.revision,
    branch: sanitizeBranch(branch),
    changedFiles: snapshot.entries.length,
    stagedChanges: snapshot.entries.filter((entry) => entry.staged).length,
  };
  if (action === "commit") {
    const summary = await requireGitOperation(git.getCommitSummary)(repository.rootPath);
    if (
      summary.parent !== intent.expectedHead ||
      summary.tree !== intent.expectedTree ||
      summary.message !== intent.message
    ) {
      throw outcomeUnknown();
    }
    result.commitSha = summary.sha;
    result.filesChanged = summary.filesChanged;
  }
  return result;
}

async function isGitMutationApplied(
  intent: BrowserGitMutationIntent,
  action: BrowserGitAction,
  result: BrowserGitMutationResult,
  snapshot: GitRepositorySnapshot,
  git: BrowserGitOperations,
  repositoryPath: string,
): Promise<boolean> {
  if (action === "commit") {
    if (!result.commitSha) return false;
    const summary = await requireGitOperation(git.getCommitSummary)(repositoryPath);
    return (
      summary.sha === result.commitSha &&
      summary.parent === intent.expectedHead &&
      summary.tree === intent.expectedTree &&
      summary.message === intent.message
    );
  }
  const requested = new Set(intent.relativePaths ?? []);
  const affected = snapshot.entries.filter(
    (entry) => requested.has(entry.path) || (entry.oldPath && requested.has(entry.oldPath)),
  );
  if (action === "stage") return affected.every((entry) => !entry.unstaged && !entry.untracked);
  return affected.every((entry) => !entry.staged);
}

async function tryReconcileGitMutation(
  git: BrowserGitOperations,
  workspace: Workspace,
  repository: { rootPath: string; device: number; inode: number },
  intent: BrowserGitMutationIntent,
  action: BrowserGitAction,
): Promise<BrowserGitMutationResult | null> {
  if (action === "commit") {
    const summary = await requireGitOperation(git.getCommitSummary)(repository.rootPath).catch(
      () => null,
    );
    if (
      !summary ||
      summary.parent !== intent.expectedHead ||
      summary.tree !== intent.expectedTree ||
      summary.message !== intent.message
    ) {
      return null;
    }
    const result = await buildGitMutationResult(
      git,
      workspace,
      repository,
      intent,
      action,
      "reconciled",
    );
    result.commitSha = summary.sha;
    result.filesChanged = summary.filesChanged;
    return result;
  }
  const snapshot = await getRepositorySnapshot(workspace, repository, git);
  if (snapshot.head !== intent.expectedHead) return null;
  const affected = snapshot.entries.filter(
    (entry) =>
      (intent.relativePaths ?? []).includes(entry.path) ||
      (entry.oldPath !== undefined && (intent.relativePaths ?? []).includes(entry.oldPath)),
  );
  if (
    action === "stage"
      ? affected.some((entry) => entry.unstaged || entry.untracked)
      : affected.some((entry) => entry.staged)
  ) {
    return null;
  }
  return buildGitMutationResult(git, workspace, repository, intent, action, "reconciled");
}

function matchesExpectedState(
  intent: BrowserGitMutationIntent,
  snapshot: GitRepositorySnapshot,
  _action: BrowserGitAction,
): boolean {
  // The revision already covers HEAD, the full index and the working-tree status.
  // expectedTree is kept separately to identify a commit after a lost reply.
  return snapshot.revision === intent.expectedRevision && snapshot.head === intent.expectedHead;
}

async function getRepositorySnapshot(
  workspace: Workspace,
  repository: { rootPath: string; device: number; inode: number },
  git: BrowserGitOperations,
): Promise<GitRepositorySnapshot> {
  const [rawStatus, head, indexState] = await Promise.all([
    git.getStatus(repository.rootPath),
    getHead(git, repository.rootPath),
    getIndexState(git, repository.rootPath),
  ]);
  const entries = parseGitStatus(rawStatus);
  const workingState: string[] = [];
  for (const entry of entries.slice(0, MAX_STATUS_FILES)) {
    for (const relativePath of [entry.path, entry.oldPath].filter(
      (value): value is string => typeof value === "string",
    )) {
      workingState.push(
        `${relativePath}\0${await hashWorkingPath(repository.rootPath, relativePath)}`,
      );
    }
  }
  const revision = hashPayload({ head, indexState, rawStatus, workingState });
  return { rawStatus, entries, revision, head, indexState };
}

async function hashWorkingPath(rootPath: string, relativePath: string): Promise<string> {
  const absolutePath = path.join(rootPath, ...relativePath.split("/"));
  const stats = await fs.lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return "missing";
  const metadata = `${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeMs}`;
  if (!stats.isFile() || stats.isSymbolicLink()) return `metadata:${metadata}`;
  const hash = createHash("sha256");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      opened.mtimeMs !== stats.mtimeMs
    ) {
      return `changed:${metadata}`;
    }
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close().catch(() => undefined);
  }
  const after = await fs.lstat(absolutePath).catch(() => null);
  if (
    !after ||
    after.isSymbolicLink() ||
    after.dev !== stats.dev ||
    after.ino !== stats.ino ||
    after.size !== stats.size ||
    after.mtimeMs !== stats.mtimeMs
  ) {
    return `changed:${metadata}`;
  }
  return `${metadata}:${hash.digest("hex")}`;
}

async function getHead(git: BrowserGitOperations, repositoryPath: string): Promise<string | null> {
  if (git.getHead) return git.getHead(repositoryPath);
  try {
    return await GitService.getHeadCommit(repositoryPath);
  } catch (error) {
    if (isGitRevisionMissing(error)) return null;
    throw error;
  }
}

async function getIndexState(git: BrowserGitOperations, repositoryPath: string): Promise<string> {
  if (git.getIndexState) return git.getIndexState(repositoryPath);
  const { stdout } = await execFileAsync(
    "git",
    ["--no-optional-locks", "--literal-pathspecs", "ls-files", "--stage", "-z"],
    readOnlyGitOptions(repositoryPath),
  );
  return stdout;
}

async function getIndexTree(git: BrowserGitOperations, repositoryPath: string): Promise<string> {
  const getTree = git.getIndexTree ?? defaultGitOperations.getIndexTree;
  if (!getTree) throw gitWriteUnavailable();
  try {
    return await getTree(repositoryPath);
  } catch {
    throw unresolvedGitConflict();
  }
}

function parseGitStatus(rawStatus: string): BrowserGitFileStatus[] {
  if (rawStatus.includes("\0")) {
    const records = rawStatus.split("\0");
    const entries: BrowserGitFileStatus[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.length < 4 || record[2] !== " ") continue;
      const status = record.slice(0, 2);
      const entry: BrowserGitFileStatus = createStatusEntry(status, record.slice(3));
      if (status.includes("R") || status.includes("C")) {
        const oldPath = records[index + 1];
        if (oldPath) {
          entry.oldPath = oldPath;
          index += 1;
        }
      }
      entries.push(entry);
    }
    return entries;
  }
  return rawStatus
    .split(/\r?\n/)
    .filter((line) => line.length >= 4 && line[2] === " ")
    .map((line) => {
      const status = line.slice(0, 2);
      let relativePath = line.slice(3);
      let oldPath: string | undefined;
      const renameSeparator = relativePath.lastIndexOf(" -> ");
      if (renameSeparator >= 0 && (status.includes("R") || status.includes("C"))) {
        oldPath = relativePath.slice(0, renameSeparator);
        relativePath = relativePath.slice(renameSeparator + 4);
      }
      return { ...createStatusEntry(status, relativePath), ...(oldPath ? { oldPath } : {}) };
    });
}

function createStatusEntry(status: string, relativePath: string): BrowserGitFileStatus {
  const untracked = status === "??";
  const conflicted = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status);
  return {
    path: relativePath,
    status,
    staged: !untracked && status[0] !== " ",
    unstaged: !untracked && status[1] !== " ",
    untracked,
    conflicted,
  };
}

function serializeByKey<T>(
  tails: Map<string, Promise<unknown>>,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const current = previous.then(action, action);
  tails.set(key, current);
  return current.finally(() => {
    if (tails.get(key) === current) tails.delete(key);
  });
}

function assertReceiptMatches(
  receipt: BrowserGitMutationReceipt,
  fingerprint: string,
  request: MutationParams,
  action: BrowserGitAction,
): void {
  if (
    receipt.fingerprint !== fingerprint ||
    receipt.intent.workspaceId !== request.workspaceId ||
    receipt.intent.action !== action ||
    receipt.intent.expectedRevision !== request.expectedRevision
  ) {
    throw operationConflict();
  }
}

function assertRequestedPathsAreChanged(
  entries: BrowserGitFileStatus[],
  relativePaths: string[],
): void {
  const knownPaths = new Set(
    entries.flatMap((entry) => [entry.path, entry.oldPath].filter(Boolean)),
  );
  if (relativePaths.some((relativePath) => !knownPaths.has(relativePath))) {
    throw staleGitState();
  }
}

async function authorizeStagedPaths(
  workspace: Workspace,
  rootPath: string,
  entries: BrowserGitFileStatus[],
): Promise<void> {
  const paths = new Set<string>();
  for (const entry of entries) {
    paths.add(entry.path);
    if (entry.oldPath) paths.add(entry.oldPath);
  }
  for (const relativePath of paths) {
    await assertAuthorizedMutationPath(workspace, rootPath, relativePath);
  }
}

async function assertAuthorizedMutationPath(
  workspace: Workspace,
  rootPath: string,
  relativePath: string,
): Promise<void> {
  const normalized = normalizeRelativeFilePath(relativePath);
  if (normalized.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    throw workspaceUnavailable();
  }
  const segments = normalized.split("/");
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
  if (
    !isWithin(rootPath, currentPath) ||
    !isWorkspacePathReadable(workspace, currentPath) ||
    !isWorkspacePathWritable(workspace, currentPath)
  ) {
    throw wholeRepositoryDenied();
  }
}

function isWorkspacePathWritable(workspace: Workspace, candidatePath: string): boolean {
  try {
    return (
      evaluateWorkspaceFilesystemAccess(workspace, candidatePath, "write").decision === "allow"
    );
  } catch {
    return false;
  }
}

function requireOperationKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    throw invalidParams();
  }
  return value;
}

function getScopedOperationKey(context: WebRequestContext, operationKey: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        context.identity.installationId,
        context.identity.profileId,
        context.audience,
        operationKey,
      ]),
    )
    .digest("hex");
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireGitOperation<Args extends unknown[], Result>(
  operation: ((...args: Args) => Result) | undefined,
): (...args: Args) => Result {
  if (!operation) throw gitWriteUnavailable();
  return operation;
}

function mutationGitOptions(cwd: string) {
  return readOnlyGitOptions(cwd);
}

function isGitRevisionMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; stderr?: unknown };
  return (
    value.code === 128 &&
    typeof value.stderr === "string" &&
    value.stderr.includes("Needed a single revision")
  );
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
      [
        "--no-optional-locks",
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
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
  getHead: async (repositoryPath) => {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["--no-optional-locks", "rev-parse", "--verify", "HEAD"],
        readOnlyGitOptions(repositoryPath),
      );
      return stdout.trim();
    } catch (error) {
      if (isGitRevisionMissing(error)) return null;
      throw error;
    }
  },
  getIndexState: async (repositoryPath) => {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "--literal-pathspecs", "ls-files", "--stage", "-z"],
      readOnlyGitOptions(repositoryPath),
    );
    return stdout;
  },
  getIndexTree: async (repositoryPath) => {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-optional-locks", "write-tree"],
      readOnlyGitOptions(repositoryPath),
    );
    return stdout.trim();
  },
  stagePaths: async (repositoryPath, relativePaths) => {
    await execFileAsync(
      "git",
      ["--no-optional-locks", "--literal-pathspecs", "add", "-A", "--", ...relativePaths],
      mutationGitOptions(repositoryPath),
    );
  },
  unstagePaths: async (repositoryPath, relativePaths, hasHead) => {
    const args = hasHead
      ? [
          "--no-optional-locks",
          "--literal-pathspecs",
          "restore",
          "--staged",
          "--",
          ...relativePaths,
        ]
      : [
          "--no-optional-locks",
          "--literal-pathspecs",
          "rm",
          "--cached",
          "--ignore-unmatch",
          "--",
          ...relativePaths,
        ];
    await execFileAsync("git", args, mutationGitOptions(repositoryPath));
  },
  commitStaged: async (repositoryPath, message) => {
    const hooksPath = await fs.mkdtemp(path.join(tmpdir(), "cowork-git-hooks-disabled-"));
    try {
      await execFileAsync(
        "git",
        [
          "--no-optional-locks",
          "-c",
          `core.hooksPath=${hooksPath}`,
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          message,
        ],
        mutationGitOptions(repositoryPath),
      );
    } finally {
      await fs.rm(hooksPath, { recursive: true, force: true });
    }
  },
  getCommitSummary: async (repositoryPath) => {
    const [{ stdout: parents }, { stdout: tree }, { stdout: message }, { stdout: files }] =
      await Promise.all([
        execFileAsync(
          "git",
          ["--no-optional-locks", "rev-list", "--parents", "-n", "1", "HEAD"],
          readOnlyGitOptions(repositoryPath),
        ),
        execFileAsync(
          "git",
          ["--no-optional-locks", "show", "-s", "--format=%T", "HEAD"],
          readOnlyGitOptions(repositoryPath),
        ),
        execFileAsync(
          "git",
          ["--no-optional-locks", "show", "-s", "--format=%B", "HEAD"],
          readOnlyGitOptions(repositoryPath),
        ),
        execFileAsync(
          "git",
          [
            "--no-optional-locks",
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            "HEAD",
          ],
          readOnlyGitOptions(repositoryPath),
        ),
      ]);
    const [sha, parent] = parents.trim().split(/\s+/, 2);
    if (!sha || !tree.trim()) throw new Error("Git commit is unavailable");
    return {
      sha,
      parent: parent || null,
      tree: tree.trim(),
      message: message.replace(/\n+$/, ""),
      filesChanged: files.split("\0").filter(Boolean).length,
    };
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
  mutation = false,
): Promise<Workspace> {
  if (!context.sessionId || !context.identity.profileId || isTempWorkspaceId(workspaceId)) {
    throw workspaceUnavailable();
  }
  let capabilities: Partial<Pick<HostCapabilities, "git.read" | "git.write">>;
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
  if (mutation && capabilities["git.write"]?.available !== true) {
    throw new WebApplicationError("UNSUPPORTED_CAPABILITY", "Git writes are unavailable.", 403);
  }
  if (
    !workspace ||
    workspace.id !== workspaceId ||
    workspace.isTemp === true ||
    isTempWorkspaceId(workspace.id) ||
    !workspace.path ||
    !workspace.permissions ||
    workspace.permissions.read !== true ||
    (mutation && workspace.permissions.write !== true)
  ) {
    if (mutation && workspace?.permissions?.write !== true) {
      throw new WebApplicationError("FORBIDDEN", "This workspace does not allow Git changes.", 403);
    }
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
  revision: string,
): BrowserGitStatusSummary {
  const entries = parseGitStatus(rawStatus);
  const visibleEntries = entries.slice(0, MAX_STATUS_FILES);
  let stagedChanges = 0;
  let unstagedChanges = 0;
  let untrackedFiles = 0;
  let conflictedFiles = 0;
  for (const entry of entries) {
    if (entry.untracked) {
      untrackedFiles += 1;
      continue;
    }
    if (entry.staged) stagedChanges += 1;
    if (entry.unstaged) unstagedChanges += 1;
    if (entry.conflicted) conflictedFiles += 1;
  }
  return {
    workspaceId,
    isRepository: true,
    branch: sanitizeBranch(rawBranch),
    revision,
    clean: entries.length === 0,
    changedFiles: entries.length,
    stagedChanges,
    unstagedChanges,
    untrackedFiles,
    conflictedFiles,
    files: visibleEntries,
    filesTruncated: entries.length > visibleEntries.length,
    truncated: entries.length > visibleEntries.length,
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
    revision: null,
    clean: true,
    changedFiles: 0,
    stagedChanges: 0,
    unstagedChanges: 0,
    untrackedFiles: 0,
    conflictedFiles: 0,
    files: [],
    filesTruncated: false,
    truncated: false,
  };
}

function parseMutationParams(action: BrowserGitAction, value: unknown): MutationParams {
  if (!isRecord(value)) throw invalidParams();
  const workspace = parseWorkspaceParams(value);
  const expectedRevision =
    typeof value.expectedRevision === "string" ? value.expectedRevision.trim() : "";
  if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw invalidParams();

  if (action === "commit") {
    const message = typeof value.message === "string" ? value.message.trim() : "";
    if (
      !message ||
      message.length > MAX_COMMIT_MESSAGE_CHARS ||
      message.includes("\0") ||
      (value.relativePaths !== undefined &&
        (!Array.isArray(value.relativePaths) || value.relativePaths.length > 0))
    ) {
      throw invalidParams();
    }
    return { ...workspace, expectedRevision, message };
  }

  if (
    !Array.isArray(value.relativePaths) ||
    value.relativePaths.length === 0 ||
    value.relativePaths.length > MAX_MUTATION_PATHS ||
    value.message !== undefined
  ) {
    throw invalidParams();
  }
  const relativePaths = value.relativePaths.map((relativePath) => {
    if (typeof relativePath !== "string") throw invalidParams();
    return normalizeRelativeFilePath(relativePath);
  });
  if (new Set(relativePaths).size !== relativePaths.length) throw invalidParams();
  return { ...workspace, expectedRevision, relativePaths };
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

function gitWriteUnavailable(): WebApplicationError {
  return new WebApplicationError(
    "UNSUPPORTED_CAPABILITY",
    "Git changes are unavailable in this browser session.",
    403,
  );
}

function staleGitState(): WebApplicationError {
  return new WebApplicationError(
    "STALE_STATE",
    "The repository changed. Refresh Git Changes and try again.",
    409,
  );
}

function operationConflict(): WebApplicationError {
  return new WebApplicationError(
    "CONFLICT",
    "This browser request key belongs to a different Git action.",
    409,
  );
}

function outcomeUnknown(): WebApplicationError {
  return new WebApplicationError(
    "OUTCOME_UNKNOWN",
    "Git may have changed before the connection was lost. Retry this exact action to reconcile it.",
    503,
    true,
  );
}

function unresolvedGitConflict(): WebApplicationError {
  return new WebApplicationError(
    "CONFLICT",
    "Resolve the repository's merge conflicts before staging or committing these changes.",
    409,
  );
}

function nothingToCommit(): WebApplicationError {
  return new WebApplicationError("CONFLICT", "Stage at least one file before committing.", 409);
}

function tooManyGitChanges(): WebApplicationError {
  return new WebApplicationError(
    "CONFLICT",
    `This repository has more than ${MAX_STATUS_FILES} changed files. Reduce the change set before committing from the browser.`,
    409,
  );
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

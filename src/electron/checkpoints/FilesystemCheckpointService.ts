import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import type {
  FilesystemCheckpoint,
  FilesystemCheckpointDiff,
  FilesystemCheckpointDiffEntry,
  FilesystemCheckpointRollbackResult,
} from "../../shared/types";
import { getUserDataDir } from "../utils/user-data-dir";

const CHECKPOINT_ROOT_NAME = "filesystem-checkpoints";
const MAX_FILES = 50_000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_CHECKPOINTS_PER_WORKSPACE = 50;
const MAX_TOTAL_STORE_BYTES = 500 * 1024 * 1024;
const PROCESS_LOCK_TIMEOUT_MS = 30_000;
const STALE_PROCESS_LOCK_MS = 2 * 60 * 1000;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cowork",
  ".cowork-worktrees",
  "filesystem-checkpoints",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
]);

const EXCLUDED_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|secret)$/i,
  /\.(?:log|tmp|cache)$/i,
  /\.(?:mp4|mov|mkv|webm|zip|tar|gz|7z|iso)$/i,
];

const SENSITIVE_CONTENT_PATTERNS = [
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
];

type StoredFile = {
  hash: string;
  size: number;
  mode: number;
  mtimeMs?: number;
  ctimeMs?: number;
};

type ScanResult = {
  files: Map<string, StoredFile & { absolutePath: string }>;
  directories: Set<string>;
  symlinks: Record<string, string>;
  skippedCount: number;
};

type StoredCheckpoint = FilesystemCheckpoint & {
  files: Record<string, StoredFile>;
  directories: string[];
  symlinks: Record<string, string>;
  /** State immediately after the agent mutation, keyed by relative path. */
  agentStates?: Record<string, string | null>;
  /** State observed before this checkpoint that diverged from the last agent state. */
  manualPaths?: Record<string, string | null>;
};

type ProjectIndex = {
  workspacePath: string;
  nextSequence: number;
  checkpoints: FilesystemCheckpoint[];
  lastAgentStates?: Record<string, string | null>;
};

type PathState = string | null;

function canonicalWorkspacePath(workspacePath: string): string {
  return path.resolve(workspacePath);
}

function projectKey(workspacePath: string): string {
  return createHash("sha256")
    .update(canonicalWorkspacePath(workspacePath))
    .digest("hex")
    .slice(0, 24);
}

function isExcludedFile(name: string): boolean {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function hasSensitiveContent(content: Buffer): boolean {
  const sample = content.subarray(0, 2 * 1024 * 1024).toString("utf8");
  return SENSITIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(sample));
}

function isWithinWorkspace(workspacePath: string, relativePath: string): boolean {
  const root = canonicalWorkspacePath(workspacePath);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]+/).join("/").replace(/^\.\//, "");
}

function stateForPath(scan: ScanResult, relativePath: string): PathState {
  const file = scan.files.get(relativePath);
  if (file) return `file:${file.hash}:${file.mode}`;
  if (scan.directories.has(relativePath)) return "directory";
  if (scan.symlinks[relativePath] !== undefined) return `symlink:${scan.symlinks[relativePath]}`;
  return null;
}

function stateForStoredPath(checkpoint: StoredCheckpoint, relativePath: string): PathState {
  const file = checkpoint.files[relativePath];
  if (file) return `file:${file.hash}:${file.mode}`;
  if (checkpoint.directories.includes(relativePath)) return "directory";
  if (checkpoint.symlinks[relativePath] !== undefined) {
    return `symlink:${checkpoint.symlinks[relativePath]}`;
  }
  return null;
}

function collectPaths(scan: ScanResult): Set<string> {
  return new Set([
    ...scan.files.keys(),
    ...scan.directories,
    ...Object.keys(scan.symlinks),
  ]);
}

function collectStoredPaths(checkpoint: StoredCheckpoint): Set<string> {
  return new Set([
    ...Object.keys(checkpoint.files),
    ...checkpoint.directories,
    ...Object.keys(checkpoint.symlinks),
  ]);
}

function manifestsEqual(left: StoredCheckpoint, scan: ScanResult): boolean {
  const paths = new Set([...collectStoredPaths(left), ...collectPaths(scan)]);
  if (left.skippedCount !== scan.skippedCount) return false;
  for (const relativePath of paths) {
    if (stateForStoredPath(left, relativePath) !== stateForPath(scan, relativePath)) return false;
  }
  return true;
}

function summaryOf(checkpoint: StoredCheckpoint): FilesystemCheckpoint {
  return {
    id: checkpoint.id,
    sequence: checkpoint.sequence,
    workspacePath: checkpoint.workspacePath,
    taskId: checkpoint.taskId,
    reason: checkpoint.reason,
    createdAt: checkpoint.createdAt,
    fileCount: checkpoint.fileCount,
    directoryCount: checkpoint.directoryCount,
    symlinkCount: checkpoint.symlinkCount,
    skippedCount: checkpoint.skippedCount,
  };
}

export class FilesystemCheckpointService {
  private static readonly locks = new Map<string, Promise<unknown>>();

  static isEnabled(workspace: { permissions?: { filesystemCheckpoints?: boolean } }): boolean {
    return workspace.permissions?.filesystemCheckpoints === true;
  }

  static isPathExcluded(relativePath: string, size?: number): string | null {
    const basename = path.basename(relativePath);
    if (isExcludedFile(basename)) return "secret-looking or transient filename";
    if (typeof size === "number" && size > MAX_FILE_SIZE_BYTES) return "file exceeds 10 MB";
    return null;
  }

  static isContentExcluded(content: string | Buffer): boolean {
    return hasSensitiveContent(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  }

  private static rootDir(): string {
    return path.join(getUserDataDir(), CHECKPOINT_ROOT_NAME);
  }

  private static projectDir(workspacePath: string): string {
    return path.join(this.rootDir(), projectKey(workspacePath));
  }

  private static indexPath(workspacePath: string): string {
    return path.join(this.projectDir(workspacePath), "index.json");
  }

  private static checkpointDir(workspacePath: string): string {
    return path.join(this.projectDir(workspacePath), "checkpoints");
  }

  private static checkpointPath(workspacePath: string, sequence: number): string {
    return path.join(this.checkpointDir(workspacePath), `${sequence}.json`);
  }

  private static lockPath(workspacePath: string): string {
    return path.join(this.projectDir(workspacePath), ".lock");
  }

  private static blobPath(hash: string): string {
    return path.join(this.rootDir(), "blobs", hash);
  }

  private static async acquireProcessLock(workspacePath: string): Promise<() => Promise<void>> {
    await fs.mkdir(this.projectDir(workspacePath), { recursive: true });
    await fs.mkdir(path.join(this.rootDir(), "blobs"), { recursive: true });
    const lockPath = this.lockPath(workspacePath);
    const startedAt = Date.now();

    while (Date.now() - startedAt < PROCESS_LOCK_TIMEOUT_MS) {
      try {
        const handle = await fs.open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        await handle.close();
        return async () => {
          await fs.unlink(lockPath).catch(() => undefined);
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_PROCESS_LOCK_MS) {
            await fs.unlink(lockPath).catch(() => undefined);
            continue;
          }
        } catch {
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error("Timed out waiting for the workspace checkpoint lock");
  }

  private static async withLock<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
    const key = canonicalWorkspacePath(workspacePath);
    const previous = this.locks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    let releaseProcessLock: () => Promise<void> = async () => {};
    try {
      releaseProcessLock = await this.acquireProcessLock(workspacePath);
      return await operation();
    } finally {
      await releaseProcessLock();
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  private static async writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporaryPath, "w");
      try {
        await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private static async scanWorkspace(
    workspacePath: string,
    previous?: Pick<StoredCheckpoint, "files">,
  ): Promise<ScanResult> {
    const root = canonicalWorkspacePath(workspacePath);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Workspace root must be a real directory");
    }
    const result: ScanResult = {
      files: new Map(),
      directories: new Set(),
      symlinks: {},
      skippedCount: 0,
    };
    let visitedFiles = 0;

    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (visitedFiles >= MAX_FILES) {
          throw new Error(`Workspace exceeds the ${MAX_FILES.toLocaleString()} file checkpoint limit`);
        }
        const absolutePath = path.join(directory, entry.name);
        const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
        if (entry.name === ".DS_Store") continue;
        if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
          result.skippedCount += 1;
          continue;
        }
        if (entry.isFile() && isExcludedFile(entry.name)) {
          result.skippedCount += 1;
          continue;
        }
        if (entry.isSymbolicLink()) {
          result.symlinks[relativePath] = await fs.readlink(absolutePath);
          result.skippedCount += 1;
          continue;
        }
        if (entry.isDirectory()) {
          result.directories.add(relativePath);
          await visit(absolutePath, relativePath);
          continue;
        }
        if (!entry.isFile()) continue;

        const stats = await fs.stat(absolutePath);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          result.skippedCount += 1;
          continue;
        }
        const previousFile = previous?.files[relativePath];
        if (
          previousFile &&
          previousFile.size === stats.size &&
          previousFile.mode === (stats.mode & 0o777) &&
          previousFile.mtimeMs === stats.mtimeMs &&
          previousFile.ctimeMs === stats.ctimeMs
        ) {
          result.files.set(relativePath, {
            ...previousFile,
            absolutePath,
          });
          visitedFiles += 1;
          continue;
        }
        const content = await fs.readFile(absolutePath);
        if (hasSensitiveContent(content)) {
          result.skippedCount += 1;
          continue;
        }
        const hash = createHash("sha256").update(content).digest("hex");
        result.files.set(relativePath, {
          hash,
          size: stats.size,
          mode: stats.mode & 0o777,
          mtimeMs: stats.mtimeMs,
          ctimeMs: stats.ctimeMs,
          absolutePath,
        });
        visitedFiles += 1;
      }
    };

    await visit(root, "");
    return result;
  }

  private static toFiles(scan: ScanResult): Record<string, StoredFile> {
    return Object.fromEntries(
      Array.from(scan.files.entries()).map(([relativePath, entry]) => [relativePath, {
        hash: entry.hash,
        size: entry.size,
        mode: entry.mode,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs,
      }]),
    );
  }

  private static async persistBlobs(scan: ScanResult): Promise<void> {
    for (const entry of scan.files.values()) {
      const blobPath = this.blobPath(entry.hash);
      try {
        await fs.access(blobPath);
      } catch {
        const temporaryPath = `${blobPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.copyFile(entry.absolutePath, temporaryPath);
          await fs.rename(temporaryPath, blobPath);
        } catch (error) {
          await fs.unlink(temporaryPath).catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    }
  }

  private static emptyIndex(workspacePath: string): ProjectIndex {
    return {
      workspacePath: canonicalWorkspacePath(workspacePath),
      nextSequence: 1,
      checkpoints: [],
    };
  }

  private static async recoverIndex(workspacePath: string): Promise<ProjectIndex> {
    const index = this.emptyIndex(workspacePath);
    let entries;
    try {
      entries = await fs.readdir(this.checkpointDir(workspacePath), { withFileTypes: true });
    } catch {
      return index;
    }
    const recovered: StoredCheckpoint[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
      try {
        const parsed = JSON.parse(
          await fs.readFile(path.join(this.checkpointDir(workspacePath), entry.name), "utf8"),
        ) as StoredCheckpoint;
        if (parsed.workspacePath === index.workspacePath && parsed.files) recovered.push(parsed);
      } catch {
        // Keep recoverable checkpoint files; ignore an individual corrupt record.
      }
    }
    recovered.sort((left, right) => left.sequence - right.sequence);
    index.checkpoints = recovered.map(summaryOf);
    index.nextSequence = (recovered[recovered.length - 1]?.sequence || 0) + 1;
    return index;
  }

  private static async loadIndex(workspacePath: string): Promise<ProjectIndex> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath(workspacePath), "utf8")) as Partial<ProjectIndex>;
      if (!Array.isArray(parsed.checkpoints)) throw new Error("Invalid checkpoint index");
      return {
        workspacePath: canonicalWorkspacePath(workspacePath),
        nextSequence:
          typeof parsed.nextSequence === "number" && parsed.nextSequence > 0
            ? Math.floor(parsed.nextSequence)
            : 1,
        checkpoints: parsed.checkpoints,
        lastAgentStates: parsed.lastAgentStates,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.emptyIndex(workspacePath);
      return this.recoverIndex(workspacePath);
    }
  }

  private static async saveIndex(workspacePath: string, index: ProjectIndex): Promise<void> {
    await this.writeJsonAtomic(this.indexPath(workspacePath), index);
  }

  private static async loadCheckpoint(
    workspacePath: string,
    sequence: number,
  ): Promise<StoredCheckpoint> {
    const raw = JSON.parse(await fs.readFile(this.checkpointPath(workspacePath, sequence), "utf8")) as StoredCheckpoint;
    if (
      !raw ||
      raw.workspacePath !== canonicalWorkspacePath(workspacePath) ||
      !raw.files ||
      typeof raw.files !== "object"
    ) {
      throw new Error("Checkpoint does not belong to this workspace");
    }
    return {
      ...raw,
      directories: Array.isArray(raw.directories) ? raw.directories : [],
      symlinks: raw.symlinks && typeof raw.symlinks === "object" ? raw.symlinks : {},
      agentStates: raw.agentStates || (raw as StoredCheckpoint & { agentHashes?: Record<string, string | null> }).agentHashes,
      manualPaths: raw.manualPaths || {},
    };
  }

  private static async pruneWorkspace(workspacePath: string, index: ProjectIndex): Promise<void> {
    let changed = false;
    while (
      index.checkpoints.length > MAX_CHECKPOINTS_PER_WORKSPACE ||
      (index.checkpoints.length > 1 && (await this.storeSizeBytes()) > MAX_TOTAL_STORE_BYTES)
    ) {
      const removed = index.checkpoints.shift();
      if (!removed) break;
      await fs.unlink(this.checkpointPath(workspacePath, removed.sequence)).catch(() => undefined);
      changed = true;
      await this.pruneUnreferencedBlobs();
    }
    if (changed) await this.saveIndex(workspacePath, index);
    if (changed || (await this.storeSizeBytes()) > MAX_TOTAL_STORE_BYTES) {
      await this.pruneUnreferencedBlobs();
    }
  }

  private static async storeSizeBytes(): Promise<number> {
    let totalBytes = 0;
    try {
      const blobs = await fs.readdir(path.join(this.rootDir(), "blobs"));
      for (const blob of blobs) {
        totalBytes += (await fs.stat(path.join(this.rootDir(), "blobs", blob))).size;
      }
    } catch {
      // An empty checkpoint store has no blobs directory yet.
    }
    return totalBytes;
  }

  private static async pruneUnreferencedBlobs(): Promise<void> {
    const referenced = new Set<string>();
    let projects;
    try {
      projects = await fs.readdir(this.rootDir(), { withFileTypes: true });
    } catch {
      return;
    }
    for (const project of projects) {
      if (!project.isDirectory() || project.name === "blobs") continue;
      let checkpoints;
      try {
        checkpoints = await fs.readdir(path.join(this.rootDir(), project.name, "checkpoints"));
      } catch {
        continue;
      }
      for (const checkpoint of checkpoints) {
        if (!checkpoint.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(
            await fs.readFile(path.join(this.rootDir(), project.name, "checkpoints", checkpoint), "utf8"),
          ) as StoredCheckpoint;
          for (const file of Object.values(parsed.files || {})) referenced.add(file.hash);
        } catch {
          // A corrupt checkpoint is retained for recovery diagnostics.
        }
      }
    }
    let blobs;
    try {
      blobs = await fs.readdir(path.join(this.rootDir(), "blobs"), { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      blobs
        .filter((blob) => blob.isFile() && !referenced.has(blob.name))
        .map((blob) => fs.unlink(path.join(this.rootDir(), "blobs", blob.name)).catch(() => undefined)),
    );
  }

  private static async createSnapshot(
    workspacePath: string,
    reason: string,
    taskId?: string,
  ): Promise<FilesystemCheckpoint | null> {
    const index = await this.loadIndex(workspacePath);
    const latest = index.checkpoints[index.checkpoints.length - 1];
    const latestStored = latest
      ? await this.loadCheckpoint(workspacePath, latest.sequence)
      : undefined;
    const refreshedScan = await this.scanWorkspace(workspacePath, latestStored);
    if (latest) {
      if (manifestsEqual(latestStored!, refreshedScan)) return null;
    }

    const manualPaths: Record<string, string | null> = {};
    if (index.lastAgentStates) {
      const paths = new Set([
        ...Object.keys(index.lastAgentStates),
        ...collectPaths(refreshedScan),
      ]);
      for (const relativePath of paths) {
        const currentState = stateForPath(refreshedScan, relativePath);
        if (index.lastAgentStates[relativePath] !== currentState) {
          manualPaths[relativePath] = currentState;
        }
      }
    }

    await this.persistBlobs(refreshedScan);
    const checkpoint: StoredCheckpoint = {
      id: String(index.nextSequence),
      sequence: index.nextSequence,
      workspacePath: canonicalWorkspacePath(workspacePath),
      taskId,
      reason,
      createdAt: Date.now(),
      fileCount: refreshedScan.files.size,
      directoryCount: refreshedScan.directories.size,
      symlinkCount: Object.keys(refreshedScan.symlinks).length,
      skippedCount: refreshedScan.skippedCount,
      files: this.toFiles(refreshedScan),
      directories: [...refreshedScan.directories].sort(),
      symlinks: refreshedScan.symlinks,
      manualPaths,
    };
    await this.writeJsonAtomic(this.checkpointPath(workspacePath, checkpoint.sequence), checkpoint);
    index.nextSequence += 1;
    index.checkpoints.push(summaryOf(checkpoint));
    await this.saveIndex(workspacePath, index);
    await this.pruneWorkspace(workspacePath, index);
    return summaryOf(checkpoint);
  }

  static async ensureCheckpoint(params: {
    workspacePath: string;
    taskId?: string;
    reason: string;
  }): Promise<FilesystemCheckpoint | null> {
    return this.withLock(params.workspacePath, () =>
      this.createSnapshot(params.workspacePath, params.reason, params.taskId),
    );
  }

  static async recordMutation(params: {
    workspacePath: string;
    checkpoint: FilesystemCheckpoint | null;
    paths?: string[];
  }): Promise<void> {
    if (!params.checkpoint) return;
    return this.withLock(params.workspacePath, async () => {
      const stored = await this.loadCheckpoint(params.workspacePath, params.checkpoint!.sequence);
      const scan = await this.scanWorkspace(params.workspacePath, stored);
      const requestedPaths = (params.paths || [])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => {
          const normalized = normalizeRelativePath(
            path.isAbsolute(value)
              ? path.relative(canonicalWorkspacePath(params.workspacePath), value)
              : value,
          );
          if (!isWithinWorkspace(params.workspacePath, normalized)) {
            throw new Error(`Checkpoint path escapes workspace: ${value}`);
          }
          return normalized;
        });
      const shouldInclude = (relativePath: string): boolean =>
        requestedPaths.length === 0 ||
        requestedPaths.some(
          (requested) =>
            relativePath === requested || relativePath.startsWith(`${requested}/`),
        );
      const allPaths = new Set([
        ...collectStoredPaths(stored),
        ...collectPaths(scan),
      ]);
      const agentStates: Record<string, string | null> = { ...(stored.agentStates || {}) };
      for (const relativePath of allPaths) {
        if (!shouldInclude(relativePath)) continue;
        const beforeState = stateForStoredPath(stored, relativePath);
        const currentState = stateForPath(scan, relativePath);
        if (beforeState !== currentState) agentStates[relativePath] = currentState;
      }
      if (Object.keys(agentStates).length === 0) return;
      stored.agentStates = agentStates;
      await this.writeJsonAtomic(this.checkpointPath(params.workspacePath, params.checkpoint!.sequence), stored);
      const index = await this.loadIndex(params.workspacePath);
      index.lastAgentStates = { ...(index.lastAgentStates || {}), ...agentStates };
      await this.saveIndex(params.workspacePath, index);
    });
  }

  static async list(workspacePath: string): Promise<FilesystemCheckpoint[]> {
    return this.withLock(workspacePath, async () => (await this.loadIndex(workspacePath)).checkpoints);
  }

  static async diff(workspacePath: string, sequence: number): Promise<FilesystemCheckpointDiff> {
    return this.withLock(workspacePath, async () => {
      const checkpoint = await this.loadCheckpoint(workspacePath, sequence);
      const current = await this.scanWorkspace(workspacePath, checkpoint);
      const entries: FilesystemCheckpointDiffEntry[] = [];
      const paths = new Set([...collectStoredPaths(checkpoint), ...collectPaths(current)]);
      for (const relativePath of paths) {
        const before = checkpoint.files[relativePath];
        const after = current.files.get(relativePath);
        const beforeState = stateForStoredPath(checkpoint, relativePath);
        const afterState = stateForPath(current, relativePath);
        if (beforeState === afterState) continue;
        const kind = after
          ? "file"
          : current.directories.has(relativePath)
            ? "directory"
            : current.symlinks[relativePath] !== undefined
              ? "symlink"
              : before
                ? "file"
                : checkpoint.directories.includes(relativePath)
                  ? "directory"
                  : "symlink";
        const entry: FilesystemCheckpointDiffEntry = {
          path: relativePath,
          status: beforeState === null ? "added" : afterState === null ? "deleted" : "modified",
          kind,
        };
        if (before) {
          entry.previousSize = before.size;
          entry.previousMode = before.mode;
        }
        if (after) {
          entry.currentSize = after.size;
          entry.currentMode = after.mode;
        }
        entries.push(entry);
      }
      return {
        checkpoint: summaryOf(checkpoint),
        entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
      };
    });
  }

  private static async assertSafeParentPath(workspacePath: string, relativePath: string): Promise<void> {
    if (!isWithinWorkspace(workspacePath, relativePath)) {
      throw new Error(`Checkpoint path escapes workspace: ${relativePath}`);
    }
    const root = canonicalWorkspacePath(workspacePath);
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Workspace root is not a safe directory");
    }
    const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error(`Refusing to traverse symlink: ${relativePath}`);
        if (!stat.isDirectory()) throw new Error(`Checkpoint parent is not a directory: ${relativePath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  private static async removeExistingPath(absolutePath: string): Promise<boolean> {
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (stat.isSymbolicLink() || stat.isFile()) {
      await fs.unlink(absolutePath);
      return true;
    }
    if (stat.isDirectory()) {
      try {
        await fs.rmdir(absolutePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return false;
        throw error;
      }
    }
    return false;
  }

  private static async restorePath(
    workspacePath: string,
    relativePath: string,
    target: StoredCheckpoint,
  ): Promise<boolean> {
    await this.assertSafeParentPath(workspacePath, relativePath);
    const absolutePath = path.resolve(canonicalWorkspacePath(workspacePath), relativePath);
    const targetFile = target.files[relativePath];
    const targetDirectory = target.directories.includes(relativePath);
    const targetSymlink = target.symlinks[relativePath];

    if (targetFile) {
      const existing = await fs.lstat(absolutePath).catch(() => null);
      if (existing?.isDirectory() && !existing.isSymbolicLink()) {
        throw new Error(`Refusing to replace directory with file: ${relativePath}`);
      }
      if (existing?.isSymbolicLink()) await fs.unlink(absolutePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.copyFile(this.blobPath(targetFile.hash), temporaryPath);
        await fs.chmod(temporaryPath, targetFile.mode).catch(() => undefined);
        await fs.rename(temporaryPath, absolutePath);
      } catch (error) {
        await fs.unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
      return true;
    }

    if (targetDirectory) {
      const existing = await fs.lstat(absolutePath).catch(() => null);
      if (existing?.isSymbolicLink()) await fs.unlink(absolutePath);
      else if (existing?.isFile()) throw new Error(`Refusing to replace file with directory: ${relativePath}`);
      await fs.mkdir(absolutePath, { recursive: true });
      return true;
    }

    if (targetSymlink !== undefined) {
      const existing = await fs.lstat(absolutePath).catch(() => null);
      if (existing) {
        if (existing.isDirectory() && !existing.isSymbolicLink()) {
          throw new Error(`Refusing to replace directory with symlink: ${relativePath}`);
        }
        await fs.unlink(absolutePath);
      }
      await fs.symlink(targetSymlink, absolutePath);
      return true;
    }

    return this.removeExistingPath(absolutePath);
  }

  static async rollback(params: {
    workspacePath: string;
    sequence: number;
    restoreAll?: boolean;
    paths?: string[];
  }): Promise<FilesystemCheckpointRollbackResult> {
    return this.withLock(params.workspacePath, async () => {
      const index = await this.loadIndex(params.workspacePath);
      const target = await this.loadCheckpoint(params.workspacePath, params.sequence);
      const current = await this.scanWorkspace(params.workspacePath, target);
      const preRollback = await this.createSnapshot(
        params.workspacePath,
        `before rollback to checkpoint ${params.sequence}`,
      );
      const expectedAgentStates: Record<string, string | null> = {};
      const manualPaths = new Set<string>();
      Object.assign(expectedAgentStates, target.agentStates || {});
      for (const summary of index.checkpoints.filter((item) => item.sequence > params.sequence)) {
        const later = await this.loadCheckpoint(params.workspacePath, summary.sequence);
        Object.assign(expectedAgentStates, later.agentStates || {});
        for (const relativePath of Object.keys(later.manualPaths || {})) manualPaths.add(relativePath);
      }
      if (preRollback) {
        const preRollbackStored = await this.loadCheckpoint(
          params.workspacePath,
          preRollback.sequence,
        );
        for (const relativePath of Object.keys(preRollbackStored.manualPaths || {})) {
          manualPaths.add(relativePath);
        }
      }

      const requestedPaths = (params.paths || []).map((value) => {
        const normalized = normalizeRelativePath(value);
        if (!isWithinWorkspace(params.workspacePath, normalized)) {
          throw new Error(`Checkpoint path escapes workspace: ${value}`);
        }
        return normalized;
      });
      const shouldInclude = (relativePath: string): boolean =>
        requestedPaths.length === 0 ||
        requestedPaths.some(
          (requested) =>
            relativePath === requested || relativePath.startsWith(`${requested}/`),
        );
      const allPaths = new Set([
        ...collectStoredPaths(target),
        ...collectPaths(current),
      ]);
      const restored: string[] = [];
      const kept: string[] = [];
      for (const relativePath of allPaths) {
        if (!shouldInclude(relativePath)) continue;
        const currentState = stateForPath(current, relativePath);
        const targetState = stateForStoredPath(target, relativePath);
        if (currentState === targetState) continue;
        if (!params.restoreAll && manualPaths.has(relativePath)) {
          kept.push(relativePath);
          continue;
        }
        const expectedAgentState = expectedAgentStates[relativePath];
        if (
          !params.restoreAll &&
          (expectedAgentState === undefined || expectedAgentState !== currentState)
        ) {
          kept.push(relativePath);
          continue;
        }
        const restoredPath = await this.restorePath(params.workspacePath, relativePath, target);
        if (restoredPath) restored.push(relativePath);
        else kept.push(relativePath);
      }

      return {
        checkpoint: summaryOf(target),
        preRollbackCheckpoint: preRollback,
        restored: restored.sort(),
        kept: kept.sort(),
      };
    });
  }

  static async status(workspacePath: string): Promise<{
    checkpoints: number;
    totalBytes: number;
    storeBytes: number;
    maxCheckpoints: number;
  }> {
    return this.withLock(workspacePath, async () => {
      const index = await this.loadIndex(workspacePath);
      const workspaceHashes = new Set<string>();
      for (const summary of index.checkpoints) {
        const checkpoint = await this.loadCheckpoint(workspacePath, summary.sequence);
        for (const file of Object.values(checkpoint.files)) workspaceHashes.add(file.hash);
      }
      let workspaceBytes = 0;
      for (const hash of workspaceHashes) {
        workspaceBytes += await fs
          .stat(this.blobPath(hash))
          .then((stat) => stat.size)
          .catch(() => 0);
      }
      return {
        checkpoints: index.checkpoints.length,
        totalBytes: workspaceBytes,
        storeBytes: await this.storeSizeBytes(),
        maxCheckpoints: MAX_CHECKPOINTS_PER_WORKSPACE,
      };
    });
  }
}

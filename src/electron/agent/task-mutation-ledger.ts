import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { TaskImpactMetric } from "../../shared/types";
import { getUserDataDir } from "../utils/user-data-dir";

const MAX_BASELINE_BYTES = 20 * 1024 * 1024;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

interface MutationBaselineRecord {
  relativePath: string;
  absolutePath: string;
  baselinePath?: string;
  existed: boolean;
  captured: boolean;
  binary: boolean;
  baselineWasFile?: boolean;
  originalHash?: string;
  sourceEventIds: string[];
}

interface PersistedMutationLedger {
  taskId: string;
  workspaceRoot: string;
  isolatedWorktree?: boolean;
  baselineGitHead?: string;
  revision: number;
  updatedAt: number;
  records: MutationBaselineRecord[];
}

interface TaskMutationLedgerOptions {
  storageRoot?: string;
  now?: () => number;
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8_192);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function safeTaskKey(taskId: string): string {
  return crypto.createHash("sha256").update(taskId).digest("hex").slice(0, 24);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", workspaceRoot, ...args],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout || ""));
      },
    );
  });
}

export class TaskMutationLedger {
  private readonly storageRoot: string;
  private readonly now: () => number;
  private readonly cache = new Map<string, PersistedMutationLedger>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: TaskMutationLedgerOptions = {}) {
    this.storageRoot = options.storageRoot ?? path.join(getUserDataDir(), "task-mutation-ledgers");
    this.now = options.now ?? Date.now;
    fs.mkdirSync(this.storageRoot, { recursive: true, mode: 0o700 });
    this.pruneExpiredLedgers();
  }

  private taskDirectory(taskId: string): string {
    return path.join(this.storageRoot, safeTaskKey(taskId));
  }

  private metadataPath(taskId: string): string {
    return path.join(this.taskDirectory(taskId), "ledger.json");
  }

  private async exclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(taskId, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(taskId) === current) this.queues.delete(taskId);
    }
  }

  private load(taskId: string, workspaceRoot: string): PersistedMutationLedger {
    const cached = this.cache.get(taskId);
    if (cached) return cached;
    const metadataPath = this.metadataPath(taskId);
    try {
      const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as PersistedMutationLedger;
      if (
        parsed.taskId === taskId &&
        path.resolve(parsed.workspaceRoot) === path.resolve(workspaceRoot)
      ) {
        const ledger = {
          ...parsed,
          records: Array.isArray(parsed.records) ? parsed.records : [],
        };
        this.cache.set(taskId, ledger);
        return ledger;
      }
    } catch {
      // Missing or invalid ledgers start conservatively from the next captured mutation.
    }
    const ledger: PersistedMutationLedger = {
      taskId,
      workspaceRoot: path.resolve(workspaceRoot),
      revision: 0,
      updatedAt: this.now(),
      records: [],
    };
    this.cache.set(taskId, ledger);
    return ledger;
  }

  private persist(ledger: PersistedMutationLedger): void {
    const directory = this.taskDirectory(ledger.taskId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = this.metadataPath(ledger.taskId);
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, destination);
  }

  private resolveCandidate(
    workspaceRoot: string,
    candidatePath: string,
  ): {
    absolutePath: string;
    relativePath: string;
  } | null {
    const root = path.resolve(workspaceRoot);
    const absolutePath = path.isAbsolute(candidatePath)
      ? path.resolve(candidatePath)
      : path.resolve(root, candidatePath);
    if (!isWithinRoot(root, absolutePath)) return null;
    return {
      absolutePath,
      relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
    };
  }

  async initializeTask(
    taskId: string,
    workspaceRoot: string,
    options: { isolatedWorktree?: boolean } = {},
  ): Promise<void> {
    await this.exclusive(taskId, async () => {
      const ledger = this.load(taskId, workspaceRoot);
      if (!options.isolatedWorktree || ledger.baselineGitHead) return;
      try {
        ledger.baselineGitHead = (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).trim();
        ledger.isolatedWorktree = Boolean(ledger.baselineGitHead);
        ledger.updatedAt = this.now();
        this.persist(ledger);
      } catch {
        // Per-file baselines remain the conservative fallback.
      }
    });
  }

  async captureBaseline(
    taskId: string,
    workspaceRoot: string,
    candidatePath: string,
    options: { isolatedWorktree?: boolean } = {},
  ): Promise<void> {
    await this.exclusive(taskId, async () => {
      const resolved = this.resolveCandidate(workspaceRoot, candidatePath);
      if (!resolved) return;
      const ledger = this.load(taskId, workspaceRoot);
      if (options.isolatedWorktree && !ledger.baselineGitHead) {
        try {
          ledger.baselineGitHead = (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).trim();
          ledger.isolatedWorktree = Boolean(ledger.baselineGitHead);
        } catch {
          // Per-file baseline below remains authoritative.
        }
      }
      if (ledger.records.some((record) => record.relativePath === resolved.relativePath)) return;
      const directory = this.taskDirectory(taskId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      let record: MutationBaselineRecord;
      try {
        const stat = fs.statSync(resolved.absolutePath);
        if (!stat.isFile() || stat.size > MAX_BASELINE_BYTES) {
          record = {
            ...resolved,
            existed: true,
            captured: false,
            binary: !stat.isFile(),
            baselineWasFile: stat.isFile(),
            sourceEventIds: [],
          };
        } else {
          const buffer = fs.readFileSync(resolved.absolutePath);
          const baselinePath = path.join(
            directory,
            `${crypto.createHash("sha256").update(resolved.relativePath).digest("hex")}.baseline`,
          );
          fs.writeFileSync(baselinePath, buffer, { mode: 0o600 });
          record = {
            ...resolved,
            baselinePath,
            existed: true,
            captured: true,
            binary: isBinaryBuffer(buffer),
            baselineWasFile: true,
            originalHash: hashBuffer(buffer),
            sourceEventIds: [],
          };
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        record = {
          ...resolved,
          existed: false,
          captured: code === "ENOENT",
          binary: false,
          baselineWasFile: true,
          sourceEventIds: [],
        };
      }
      ledger.records.push(record);
      ledger.updatedAt = this.now();
      this.persist(ledger);
    });
  }

  private async diffNumstat(
    beforePath: string,
    afterPath: string,
  ): Promise<{
    added: number;
    removed: number;
    attributable: boolean;
  }> {
    return new Promise((resolve) => {
      execFile(
        "git",
        ["diff", "--no-index", "--numstat", "--", beforePath, afterPath],
        { maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => {
          const exitCode = Number((error as { code?: unknown } | null)?.code ?? 0);
          if (error && exitCode !== 1) {
            resolve({ added: 0, removed: 0, attributable: false });
            return;
          }
          let added = 0;
          let removed = 0;
          let attributable = true;
          for (const line of String(stdout || "")
            .trim()
            .split("\n")) {
            if (!line) continue;
            const [rawAdded, rawRemoved] = line.split("\t");
            if (rawAdded === "-" || rawRemoved === "-") continue;
            const nextAdded = Number(rawAdded);
            const nextRemoved = Number(rawRemoved);
            if (!Number.isFinite(nextAdded) || !Number.isFinite(nextRemoved)) {
              attributable = false;
              continue;
            }
            added += nextAdded;
            removed += nextRemoved;
          }
          resolve({ added, removed, attributable });
        },
      );
    });
  }

  private currentState(record: MutationBaselineRecord): {
    exists: boolean;
    file: boolean;
    binary: boolean;
    hash?: string;
  } {
    try {
      const stat = fs.statSync(record.absolutePath);
      if (!stat.isFile()) return { exists: true, file: false, binary: true };
      if (stat.size > MAX_BASELINE_BYTES) return { exists: true, file: true, binary: true };
      const buffer = fs.readFileSync(record.absolutePath);
      return {
        exists: true,
        file: true,
        binary: isBinaryBuffer(buffer),
        hash: hashBuffer(buffer),
      };
    } catch {
      return { exists: false, file: false, binary: false };
    }
  }

  private async diffIsolatedWorktree(
    workspaceRoot: string,
    baselineGitHead: string,
  ): Promise<{
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    lineAttributionComplete: boolean;
  } | null> {
    try {
      const changedPaths = new Set<string>();
      let linesAdded = 0;
      let linesRemoved = 0;
      const tracked = await runGit(workspaceRoot, [
        "diff",
        "--numstat",
        baselineGitHead,
        "--",
        ".",
      ]);
      for (const line of tracked.trim().split("\n")) {
        if (!line) continue;
        const [rawAdded, rawRemoved, rawPath] = line.split("\t");
        if (rawPath) changedPaths.add(rawPath);
        if (rawAdded === "-" || rawRemoved === "-") continue;
        const added = Number(rawAdded);
        const removed = Number(rawRemoved);
        if (!Number.isFinite(added) || !Number.isFinite(removed)) return null;
        linesAdded += added;
        linesRemoved += removed;
      }

      let lineAttributionComplete = true;
      const untracked = await runGit(workspaceRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      const emptyPath = path.join(this.storageRoot, ".empty");
      if (!fs.existsSync(emptyPath)) fs.writeFileSync(emptyPath, "", { mode: 0o600 });
      for (const relativePath of untracked.split("\0").filter(Boolean)) {
        const resolved = this.resolveCandidate(workspaceRoot, relativePath);
        if (!resolved) continue;
        changedPaths.add(relativePath);
        const stat = fs.statSync(resolved.absolutePath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_BASELINE_BYTES) {
          lineAttributionComplete = false;
          continue;
        }
        const current = this.currentState({
          relativePath,
          absolutePath: resolved.absolutePath,
          existed: false,
          captured: true,
          binary: false,
          baselineWasFile: true,
          sourceEventIds: [],
        });
        if (current.binary) continue;
        const stats = await this.diffNumstat(emptyPath, resolved.absolutePath);
        if (!stats.attributable) lineAttributionComplete = false;
        linesAdded += stats.added;
        linesRemoved += stats.removed;
      }
      return {
        filesChanged: changedPaths.size,
        linesAdded,
        linesRemoved,
        lineAttributionComplete,
      };
    } catch {
      return null;
    }
  }

  async recordMutation(args: {
    taskId: string;
    workspaceRoot: string;
    candidatePaths: string[];
    sourceEventId: string;
    final?: boolean;
  }): Promise<TaskImpactMetric[]> {
    return this.exclusive(args.taskId, async () => {
      const ledger = this.load(args.taskId, args.workspaceRoot);
      for (const candidatePath of args.candidatePaths) {
        const resolved = this.resolveCandidate(args.workspaceRoot, candidatePath);
        if (!resolved) continue;
        let record = ledger.records.find((entry) => entry.relativePath === resolved.relativePath);
        if (!record) {
          record = {
            ...resolved,
            existed: true,
            captured: false,
            binary: false,
            baselineWasFile: true,
            sourceEventIds: [],
          };
          ledger.records.push(record);
        }
        record.sourceEventIds = unique([...record.sourceEventIds, args.sourceEventId]);
      }

      let filesChanged = 0;
      let linesAdded = 0;
      let linesRemoved = 0;
      let lineAttributionComplete = true;
      const sourceEventIds: string[] = [];
      const emptyPath = path.join(this.storageRoot, ".empty");
      if (!fs.existsSync(emptyPath)) fs.writeFileSync(emptyPath, "", { mode: 0o600 });

      const isolatedStats =
        ledger.isolatedWorktree && ledger.baselineGitHead
          ? await this.diffIsolatedWorktree(args.workspaceRoot, ledger.baselineGitHead)
          : null;

      for (const record of isolatedStats ? [] : ledger.records) {
        if (record.baselineWasFile === false) continue;
        const current = this.currentState(record);
        const changed = !record.captured
          ? record.sourceEventIds.length > 0
          : record.existed !== current.exists ||
            (record.existed && current.exists && record.originalHash !== current.hash);
        if (!changed) continue;
        filesChanged += 1;
        sourceEventIds.push(...record.sourceEventIds);
        if (!record.captured) {
          lineAttributionComplete = false;
          continue;
        }
        if (record.binary || current.binary || (!current.file && current.exists)) continue;
        const beforePath = record.existed ? record.baselinePath : emptyPath;
        const afterPath = current.exists ? record.absolutePath : emptyPath;
        if (!beforePath || !fs.existsSync(beforePath)) {
          lineAttributionComplete = false;
          continue;
        }
        const stats = await this.diffNumstat(beforePath, afterPath);
        if (!stats.attributable) lineAttributionComplete = false;
        linesAdded += stats.added;
        linesRemoved += stats.removed;
      }

      if (isolatedStats) {
        filesChanged = isolatedStats.filesChanged;
        linesAdded = isolatedStats.linesAdded;
        linesRemoved = isolatedStats.linesRemoved;
        lineAttributionComplete = isolatedStats.lineAttributionComplete;
      }

      ledger.revision += 1;
      ledger.updatedAt = this.now();
      this.persist(ledger);
      const status: TaskImpactMetric["status"] = args.final ? "final" : "active";
      const eventIds = unique(sourceEventIds);
      const base = {
        provenance: "task_mutation_ledger" as const,
        sourceEventIds: eventIds.length > 0 ? eventIds : [args.sourceEventId],
        revision: ledger.revision,
        updatedAt: ledger.updatedAt,
        status,
      };
      const metrics: TaskImpactMetric[] = [
        {
          ...base,
          id: `${args.taskId}:mutation:files_changed`,
          kind: "files_changed",
          value: filesChanged,
        },
      ];
      if (lineAttributionComplete) {
        metrics.push(
          {
            ...base,
            id: `${args.taskId}:mutation:lines_added`,
            kind: "lines_added",
            value: linesAdded,
          },
          {
            ...base,
            id: `${args.taskId}:mutation:lines_removed`,
            kind: "lines_removed",
            value: linesRemoved,
          },
        );
      }
      return metrics;
    });
  }

  private pruneExpiredLedgers(): void {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.storageRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = this.now() - RETENTION_MS;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(this.storageRoot, entry.name);
      try {
        if (fs.statSync(target).mtimeMs < cutoff) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } catch {
        // Cleanup is best effort and never affects task execution.
      }
    }
  }
}

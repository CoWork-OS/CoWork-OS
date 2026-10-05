/**
 * MemoryRetentionService — one daily job that bounds background-loop history (audit LIFE-3).
 *
 * Steps (each independent: a failure is logged and the next step still runs):
 *   - core learning-loop telemetry older than 30 days (memory-retention-sql.ts rules)
 *   - Dreaming runs/candidates older than 90 days (pending proposals kept)
 *   - Workflow Intelligence (subconscious) rows older than 90 days
 *   - WI run artifact directories and journal files older than `artifactRetentionDays`,
 *     and rotation of WI `memory.jsonl` files that grew past a size cap
 *   - kit `.history/` snapshots: newest 20 per file, at most 90 days old
 *   - weekly feedback files older than 90 days
 *   - heartbeat run history (the Heartbeat store's own prune rules)
 *   - agent working-state history (newest 50 non-current states per agent and workspace)
 *   - proactive suggestions expired or closed more than 30 days ago, suggestion feedback
 *     older than 90 days
 *   - Playbook entries older than 180 days that no longer back active success evidence
 *   - memory items that were forgotten (deleted tombstones) or are past their `expires_at`
 *   - superseded memory item revisions superseded more than 180 days ago, except the
 *     newest 5 of each item and revisions an undoable curation change still needs
 *   - settled memory-write approvals (applied, rejected, failed) older than 30 days
 *   - once per profile (marker in `maintenance_state`): markdown index rows of excluded
 *     paths in every workspace, including workspaces whose index never syncs again
 *
 * Transcript retention is not repeated here: daemon DB maintenance runs
 * `TranscriptStore.pruneRetention` with the user's task retention window.
 *
 * File deletes use the confined internal pattern: every path is resolved with realpath and
 * must stay under `<root>/.cowork/<area>`, only expected names are touched, symlinks are
 * never followed, and a folder that no longer exists is never recreated. For registered
 * workspaces the workspace access profile must also allow deletes there.
 */
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { Workspace } from "../../shared/types";
import { createLogger } from "../utils/logger";
import { getUserDataDir } from "../utils/user-data-dir";
import { evaluateWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import { pruneKitSnapshots } from "../context/kit-revisions";
import { SubconsciousSettingsManager } from "../subconscious/SubconsciousSettingsManager";
import { pruneHeartbeatRunHistory } from "../agents/HeartbeatRunRepository";
import { cleanupOldWorkingStates } from "../agents/WorkingStateRepository";
import {
  CORE_RETENTION_RULES,
  DREAMING_RETENTION_RULES,
  MEMORY_ITEM_RETENTION_RULES,
  MEMORY_ITEM_REVISION_RETENTION_RULES,
  PENDING_MEMORY_WRITE_RETENTION_RULES,
  PLAYBOOK_RETENTION_RULES,
  SUBCONSCIOUS_RETENTION_RULES,
  SUGGESTION_FEEDBACK_RETENTION_RULES,
  SUGGESTION_RETENTION_RULES,
  deleteMarkdownIndexPaths,
  deleteRetentionBatch,
  listMarkdownIndexPurgeCandidates,
  listRetentionWorkspaces,
  listSubconsciousArtifactRoots,
  loadHostMemoryDatabase,
  markdownIndexPurgeDone,
  recordMarkdownIndexPurge,
  type MarkdownIndexPathRow,
  type RetentionRule,
  type RetentionWorkspaceRow,
} from "./memory-retention-sql";
import { isExcludedMarkdownIndexPath } from "./markdown-index-exclusions";

const logger = createLogger("MemoryRetentionService");

const DAY_MS = 24 * 60 * 60 * 1000;

export const MEMORY_RETENTION_DEFAULTS = {
  coreRetentionDays: 30,
  dreamingRetentionDays: 90,
  subconsciousRetentionDays: 90,
  feedbackRetentionDays: 90,
  suggestionRetentionDays: 30,
  suggestionFeedbackRetentionDays: 90,
  playbookRetentionDays: 180,
  pendingWriteRetentionDays: 30,
  /** Superseded memory item revisions (beyond the newest few per item). */
  supersededRevisionRetentionDays: 180,
  /** Indexed paths checked per page of the one-time markdown index purge. */
  markdownPurgePageSize: 500,
  /** Delay before the first run, so startup work is not slowed down. */
  initialDelayMs: 10 * 60 * 1000,
  intervalMs: DAY_MS,
  /** Rows deleted per statement; the job yields to the event loop between batches. */
  batchSize: 2000,
  /** WI memory.jsonl files above this size keep only their newest lines. */
  jsonlMaxBytes: 1024 * 1024,
  jsonlKeepLines: 2000,
} as const;

export type MemoryRetentionStep =
  | "core"
  | "dreaming"
  | "subconsciousRows"
  | "subconsciousArtifacts"
  | "kitSnapshots"
  | "feedbackFiles"
  | "heartbeatRuns"
  | "workingStates"
  | "suggestions"
  | "playbookEntries"
  | "memoryItems"
  | "memoryItemRevisions"
  | "pendingWrites"
  | "markdownIndexPurge";

export interface MemoryRetentionResult {
  startedAt: number;
  durationMs: number;
  counts: Partial<Record<MemoryRetentionStep, number>>;
  errors: Partial<Record<MemoryRetentionStep, string>>;
}

export interface MemoryRetentionDeps {
  /** The connection to prune; defaults to the memory services' host connection. */
  database?: () => Database.Database | null | Promise<Database.Database | null>;
  now?: () => number;
  artifactRetentionDays?: () => number;
  /** Extra roots that hold `.cowork/subconscious` (the WI global root). */
  extraArtifactRoots?: () => string[];
  /** Yield between batches; defaults to setImmediate. */
  pause?: () => Promise<void>;
}

interface RetentionRoot {
  path: string;
  /** The registered workspace, when the root is one; its access profile is enforced. */
  workspace?: Pick<Workspace, "path" | "permissions" | "isTemp">;
}

function realpathOrNull(target: string): string | null {
  try {
    return fsSync.realpathSync(target);
  } catch {
    return null;
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Canonical `<root>/<relativeDir>` when it exists as a real directory inside `<root>/.cowork`. */
function resolveConfinedDir(rootPath: string, relativeDir: string): string | null {
  const rootReal = realpathOrNull(rootPath);
  const coworkReal = realpathOrNull(path.join(rootPath, ".cowork"));
  const dirReal = realpathOrNull(path.join(rootPath, relativeDir));
  if (!rootReal || !coworkReal || !dirReal) return null;
  if (!isWithin(rootReal, coworkReal)) return null;
  if (dirReal !== coworkReal && !isWithin(coworkReal, dirReal)) return null;
  return dirReal;
}

async function listEntries(dir: string): Promise<fsSync.Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => [] as fsSync.Dirent[]);
}

async function mtimeMs(target: string): Promise<number | null> {
  try {
    return (await fs.lstat(target)).mtimeMs;
  } catch {
    return null;
  }
}

function parsePermissions(raw: string | null): Workspace["permissions"] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Workspace["permissions"];
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The root prefix of a WI run artifact path (`<root>/.cowork/subconscious/...`). */
function artifactRootPrefix(artifactRoot: string): string | null {
  const marker = `${path.sep}.cowork${path.sep}subconscious${path.sep}`;
  const index = artifactRoot.indexOf(marker);
  return index > 0 ? artifactRoot.slice(0, index) : null;
}

export class MemoryRetentionService {
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<MemoryRetentionResult> | null = null;
  private stopped = false;

  constructor(private readonly deps: MemoryRetentionDeps = {}) {}

  /** Schedule the job: once after `initialDelayMs`, then every `intervalMs`. */
  start(options: { initialDelayMs?: number; intervalMs?: number } = {}): void {
    if (this.initialTimer || this.intervalTimer) return;
    this.stopped = false;
    const initialDelayMs = options.initialDelayMs ?? MEMORY_RETENTION_DEFAULTS.initialDelayMs;
    const intervalMs = options.intervalMs ?? MEMORY_RETENTION_DEFAULTS.intervalMs;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.runSafely();
      this.intervalTimer = setInterval(() => void this.runSafely(), intervalMs);
      this.intervalTimer.unref?.();
    }, initialDelayMs);
    this.initialTimer.unref?.();
  }

  /** Cancel scheduled runs; a run in progress stops before its next step. */
  stop(): void {
    this.stopped = true;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }

  private async runSafely(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      logger.warn("Memory retention run failed:", error);
    }
  }

  /** Run every step once. Concurrent calls share the run in progress. */
  runOnce(): Promise<MemoryRetentionResult> {
    if (!this.running) {
      this.running = this.runSteps().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async pause(): Promise<void> {
    if (this.deps.pause) return this.deps.pause();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private async runSteps(): Promise<MemoryRetentionResult> {
    const startedAt = this.now();
    const result: MemoryRetentionResult = { startedAt, durationMs: 0, counts: {}, errors: {} };
    const db = await Promise.resolve(
      this.deps.database ? this.deps.database() : loadHostMemoryDatabase(),
    ).catch(() => null);
    if (!db) {
      logger.debug("Memory retention skipped: database unavailable");
      return result;
    }

    // Collected before rows are pruned: run rows name the roots their artifacts live in.
    let roots: RetentionRoot[] = [];
    try {
      roots = this.collectRoots(db);
    } catch (error) {
      logger.warn("Memory retention could not list artifact roots:", error);
    }

    const step = async (name: MemoryRetentionStep, action: () => Promise<number>) => {
      if (this.stopped) return;
      try {
        result.counts[name] = await action();
      } catch (error) {
        result.errors[name] = error instanceof Error ? error.message : String(error);
        logger.warn(`Memory retention step ${name} failed:`, error);
      }
    };

    await step("core", () =>
      this.pruneRows(
        db,
        CORE_RETENTION_RULES,
        startedAt - MEMORY_RETENTION_DEFAULTS.coreRetentionDays * DAY_MS,
      ),
    );
    await step("dreaming", () =>
      this.pruneRows(
        db,
        DREAMING_RETENTION_RULES,
        startedAt - MEMORY_RETENTION_DEFAULTS.dreamingRetentionDays * DAY_MS,
      ),
    );
    await step("subconsciousRows", () =>
      this.pruneRows(
        db,
        SUBCONSCIOUS_RETENTION_RULES,
        startedAt - MEMORY_RETENTION_DEFAULTS.subconsciousRetentionDays * DAY_MS,
      ),
    );
    await step("subconsciousArtifacts", () => this.pruneSubconsciousArtifacts(roots, startedAt));
    await step("kitSnapshots", () => this.pruneKitHistory(roots, startedAt));
    await step("feedbackFiles", () => this.pruneFeedbackFiles(roots, startedAt));
    await step("heartbeatRuns", async () => {
      const pruned = pruneHeartbeatRunHistory(db, { now: startedAt });
      return pruned.runsDeleted;
    });
    await step("workingStates", async () => cleanupOldWorkingStates(db));
    await step(
      "suggestions",
      async () =>
        (await this.pruneRows(
          db,
          SUGGESTION_RETENTION_RULES,
          startedAt - MEMORY_RETENTION_DEFAULTS.suggestionRetentionDays * DAY_MS,
        )) +
        (await this.pruneRows(
          db,
          SUGGESTION_FEEDBACK_RETENTION_RULES,
          startedAt - MEMORY_RETENTION_DEFAULTS.suggestionFeedbackRetentionDays * DAY_MS,
        )),
    );
    await step("playbookEntries", () =>
      this.pruneRows(
        db,
        PLAYBOOK_RETENTION_RULES,
        startedAt - MEMORY_RETENTION_DEFAULTS.playbookRetentionDays * DAY_MS,
      ),
    );
    await step("memoryItems", () => this.pruneRows(db, MEMORY_ITEM_RETENTION_RULES, startedAt));
    await step("memoryItemRevisions", () =>
      this.pruneRows(
        db,
        MEMORY_ITEM_REVISION_RETENTION_RULES,
        startedAt - MEMORY_RETENTION_DEFAULTS.supersededRevisionRetentionDays * DAY_MS,
      ),
    );
    await step("pendingWrites", () =>
      this.pruneRows(
        db,
        PENDING_MEMORY_WRITE_RETENTION_RULES,
        startedAt - MEMORY_RETENTION_DEFAULTS.pendingWriteRetentionDays * DAY_MS,
      ),
    );
    await step("markdownIndexPurge", () => this.purgeExcludedMarkdownIndexOnce(db, startedAt));

    result.durationMs = this.now() - startedAt;
    logger.info("Memory retention finished", {
      counts: result.counts,
      errors: Object.keys(result.errors),
      durationMs: result.durationMs,
    });
    return result;
  }

  private async pruneRows(
    db: Database.Database,
    rules: RetentionRule[],
    cutoff: number,
  ): Promise<number> {
    let total = 0;
    for (const rule of rules) {
      let ruleTotal = 0;
      for (;;) {
        if (this.stopped) return total;
        const deleted = deleteRetentionBatch(db, rule, cutoff, MEMORY_RETENTION_DEFAULTS.batchSize);
        ruleTotal += deleted;
        if (deleted < MEMORY_RETENTION_DEFAULTS.batchSize) break;
        await this.pause();
      }
      if (ruleTotal > 0) logger.debug(`Memory retention removed ${ruleTotal} ${rule.name} rows`);
      total += ruleTotal;
    }
    return total;
  }

  /**
   * One-time purge of markdown index rows (files, chunks, chunk FTS) whose path the index
   * no longer covers, in every workspace. Recorded in `maintenance_state` when complete;
   * an interrupted run (stop, error) is repeated on the next run. Deletes are idempotent,
   * so a desktop app and a daemon running it at once only repeat work.
   */
  private async purgeExcludedMarkdownIndexOnce(
    db: Database.Database,
    now: number,
  ): Promise<number> {
    if (markdownIndexPurgeDone(db)) return 0;
    let removed = 0;
    let after: MarkdownIndexPathRow | null = null;
    for (;;) {
      if (this.stopped) return removed;
      const page = listMarkdownIndexPurgeCandidates(
        db,
        after,
        MEMORY_RETENTION_DEFAULTS.markdownPurgePageSize,
      );
      if (page.length === 0) break;
      after = page[page.length - 1];
      removed += deleteMarkdownIndexPaths(
        db,
        page.filter((row) => isExcludedMarkdownIndexPath(row.path)),
      );
      await this.pause();
    }
    recordMarkdownIndexPurge(db, now, removed);
    if (removed > 0) logger.info(`Removed ${removed} excluded markdown index path(s)`);
    return removed;
  }

  private collectRoots(db: Database.Database): RetentionRoot[] {
    const roots = new Map<string, RetentionRoot>();
    const add = (rootPath: string, workspace?: RetentionWorkspaceRow) => {
      const real = realpathOrNull(rootPath);
      if (!real) return;
      const permissions = workspace ? parsePermissions(workspace.permissions) : null;
      const existing = roots.get(real);
      if (existing?.workspace) return;
      roots.set(real, {
        path: real,
        ...(workspace && permissions
          ? { workspace: { path: workspace.path, permissions, isTemp: workspace.isTemp } }
          : {}),
      });
    };
    for (const workspace of listRetentionWorkspaces(db)) add(workspace.path, workspace);
    for (const artifactRoot of listSubconsciousArtifactRoots(db)) {
      const prefix = artifactRootPrefix(artifactRoot);
      if (prefix) add(prefix);
    }
    try {
      add(getUserDataDir());
    } catch {
      // No user data dir outside Electron; nothing to add.
    }
    for (const extra of this.deps.extraArtifactRoots?.() ?? []) add(extra);
    return [...roots.values()];
  }

  /** False when the root is a registered workspace whose access profile forbids the delete. */
  private canDelete(root: RetentionRoot, target: string): boolean {
    if (!root.workspace) return true;
    try {
      return (
        evaluateWorkspaceFilesystemAccess(root.workspace, target, "delete").decision === "allow"
      );
    } catch {
      return false;
    }
  }

  private async pruneSubconsciousArtifacts(roots: RetentionRoot[], now: number): Promise<number> {
    const days =
      this.deps.artifactRetentionDays?.() ??
      SubconsciousSettingsManager.loadSettings().artifactRetentionDays;
    const retentionDays = Math.min(Math.max(Number(days) || 30, 1), 365);
    const cutoff = now - retentionDays * DAY_MS;
    let removed = 0;
    for (const root of roots) {
      if (this.stopped) break;
      const targetsDir = resolveConfinedDir(
        root.path,
        path.join(".cowork", "subconscious", "targets"),
      );
      if (targetsDir && this.canDelete(root, targetsDir)) {
        for (const target of await listEntries(targetsDir)) {
          if (!target.isDirectory()) continue;
          const targetDir = path.join(targetsDir, target.name);
          const runsDir = path.join(targetDir, "runs");
          for (const run of await listEntries(runsDir)) {
            // Only real directories; a planted symlink is never followed.
            if (!run.isDirectory()) continue;
            const runDir = path.join(runsDir, run.name);
            const modified = await mtimeMs(runDir);
            if (modified === null || modified >= cutoff) continue;
            await fs.rm(runDir, { recursive: true, force: true });
            removed += 1;
          }
          await this.rotateJsonl(path.join(targetDir, "memory.jsonl"));
        }
      }

      const journalDir = resolveConfinedDir(
        root.path,
        path.join(".cowork", "subconscious", "journal"),
      );
      if (journalDir && this.canDelete(root, journalDir)) {
        for (const entry of await listEntries(journalDir)) {
          if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
          const filePath = path.join(journalDir, entry.name);
          const modified = await mtimeMs(filePath);
          if (modified === null || modified >= cutoff) continue;
          await fs.rm(filePath, { force: true });
          removed += 1;
        }
      }

      const brainDir = resolveConfinedDir(root.path, path.join(".cowork", "subconscious", "brain"));
      if (brainDir && this.canDelete(root, brainDir)) {
        await this.rotateJsonl(path.join(brainDir, "memory.jsonl"));
      }
      await this.pause();
    }
    return removed;
  }

  /** Keep only the newest lines of an append-only JSONL file that grew past the cap. */
  private async rotateJsonl(filePath: string): Promise<void> {
    let stat: fsSync.Stats;
    try {
      stat = await fs.lstat(filePath);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size <= MEMORY_RETENTION_DEFAULTS.jsonlMaxBytes) return;
    const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean);
    const kept = lines.slice(-MEMORY_RETENTION_DEFAULTS.jsonlKeepLines);
    const tempPath = `${filePath}.rotate-${process.pid}-${Date.now()}`;
    await fs.writeFile(tempPath, kept.length ? `${kept.join("\n")}\n` : "", {
      encoding: "utf8",
      flag: "wx",
    });
    await fs.rename(tempPath, filePath);
  }

  private async pruneKitHistory(roots: RetentionRoot[], now: number): Promise<number> {
    let removed = 0;
    for (const root of roots) {
      if (this.stopped || !root.workspace) continue;
      const coworkDir = resolveConfinedDir(root.path, ".cowork");
      if (!coworkDir) continue;
      // Kit files live in .cowork/ and one level below; each keeps .history/<file>/.
      const historyDirs = [path.join(".cowork", ".history")];
      for (const entry of await listEntries(coworkDir)) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "policy") {
          historyDirs.push(path.join(".cowork", entry.name, ".history"));
        }
      }
      for (const relativeDir of historyDirs) {
        const historyDir = resolveConfinedDir(root.path, relativeDir);
        if (!historyDir || !this.canDelete(root, historyDir)) continue;
        for (const fileHistory of await listEntries(historyDir)) {
          if (!fileHistory.isDirectory()) continue;
          removed += pruneKitSnapshots(path.join(historyDir, fileHistory.name), { now });
        }
      }
      await this.pause();
    }
    return removed;
  }

  private async pruneFeedbackFiles(roots: RetentionRoot[], now: number): Promise<number> {
    const cutoff = now - MEMORY_RETENTION_DEFAULTS.feedbackRetentionDays * DAY_MS;
    let removed = 0;
    for (const root of roots) {
      if (this.stopped || !root.workspace) continue;
      const feedbackDir = resolveConfinedDir(root.path, path.join(".cowork", "feedback"));
      if (!feedbackDir || !this.canDelete(root, feedbackDir)) continue;
      for (const entry of await listEntries(feedbackDir)) {
        if (!entry.isFile() || !/^feedback-\d{4}-W\d{2}\.json$/.test(entry.name)) continue;
        const filePath = path.join(feedbackDir, entry.name);
        const modified = await mtimeMs(filePath);
        if (modified === null || modified >= cutoff) continue;
        await fs.rm(filePath, { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}

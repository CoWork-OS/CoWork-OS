import { ensureWorkspaceDirectory } from "../utils/workspace-directory";
import fsSync from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { DatabaseManager } from "../database/schema";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";
import { signCheckpointBody, verifyCheckpointSignature } from "./checkpoint-signing";
import { DurableContextService } from "./DurableContextService";

/**
 * Transcript files of a task: signed resume checkpoints under
 * `.cowork/memory/transcripts/checkpoints`, and the deletion and retention of
 * everything stored about a task's conversation.
 *
 * Conversation search is the conversation index (`DurableContextService`). Transcript
 * spans (the `transcript_spans` table and the JSONL files under `spans/`) are no longer
 * written; existing rows are moved into the index by a one-time migration, and existing
 * JSONL files are removed by task deletion, workspace purge and retention.
 */

type TranscriptDatabase = Pick<import("better-sqlite3").Database, "exec" | "prepare">;

export type TranscriptReadGuard = (candidatePath: string) => boolean;

export type TranscriptCheckpointKind = "snapshot" | "pre_compaction" | "periodic" | "completion";

export interface TranscriptCheckpointStructuredSummary {
  source: "snapshot" | "compaction_summary" | "completion" | "fallback";
  rawText?: string;
  decisions: string[];
  openLoops: string[];
  nextActions: string[];
  keyFindings: string[];
}

export interface TranscriptCheckpointEvidenceSpan {
  sourceType: "transcript_span" | "task_message";
  objectId: string;
  taskId: string;
  timestamp: number;
  type: string;
  excerpt: string;
  eventId?: string;
  seq?: number;
}

export interface TranscriptCheckpointEvidencePacket {
  generatedAt: number;
  spanHash: string;
  spanCount: number;
  spans: TranscriptCheckpointEvidenceSpan[];
}

export interface TranscriptCheckpointIntegrity {
  /**
   * `hmac-sha256` is keyed with the profile's checkpoint key (see
   * `checkpoint-signing.ts`). Legacy unkeyed `sha256` blocks are no longer accepted.
   */
  algorithm: "hmac-sha256" | "sha256";
  generation: number;
  checksum: string;
}

export interface TranscriptCheckpointPayload {
  checkpointKind?: TranscriptCheckpointKind;
  conversationHistory?: unknown[];
  trackerState?: unknown;
  planSummary?: unknown;
  explicitChatSummaryBlock?: string;
  explicitChatSummaryCreatedAt?: number;
  explicitChatSummarySourceMessageCount?: number;
  usageTotals?: unknown;
  timestamp?: number;
  messageCount?: number;
  sourceEventId?: string;
  sourceTimestamp?: number;
  resumeStrategy?: "snapshot" | "checkpoint" | "transcript";
  structuredSummary?: TranscriptCheckpointStructuredSummary;
  evidencePacket?: TranscriptCheckpointEvidencePacket;
  dedupeHash?: string;
  checkpointIntegrity?: TranscriptCheckpointIntegrity;
  sourceMetadata?: {
    triggerEventType?: string;
    meaningfulExchangeCount?: number;
  };
}

function rootDir(workspacePath: string): string {
  return path.join(workspacePath, ".cowork", "memory", "transcripts");
}

function spansDir(workspacePath: string): string {
  return path.join(rootDir(workspacePath), "spans");
}

function checkpointsDir(workspacePath: string): string {
  return path.join(rootDir(workspacePath), "checkpoints");
}

function taskSpanPath(workspacePath: string, taskId: string): string {
  return path.join(spansDir(workspacePath), `${taskId}.jsonl`);
}

function taskCheckpointPath(workspacePath: string, taskId: string): string {
  return path.join(checkpointsDir(workspacePath), `${taskId}.json`);
}

function taskPreviousCheckpointPath(workspacePath: string, taskId: string): string {
  return path.join(checkpointsDir(workspacePath), `${taskId}.previous.json`);
}

const CHECKPOINT_LOCK_ROOT_ENV = "COWORK_CHECKPOINT_LOCK_ROOT";

function configuredCheckpointLockRoot(): string {
  const override = process.env[CHECKPOINT_LOCK_ROOT_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".cowork", "checkpoint-locks");
}

async function taskCheckpointLockPath(workspacePath: string, taskId: string): Promise<string> {
  const lockRoot = configuredCheckpointLockRoot();
  await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  // Keep the lock root private even when it was created by an older client.
  await fs.chmod(lockRoot, 0o700).catch(() => undefined);
  let canonicalWorkspacePath: string;
  try {
    canonicalWorkspacePath = await fs.realpath(workspacePath);
  } catch {
    canonicalWorkspacePath = normalizeWorkspacePath(workspacePath);
  }
  const lockKey = createHash("sha256")
    .update(`${canonicalWorkspacePath}\u0000${taskId}`)
    .digest("hex");
  return path.join(lockRoot, `${lockKey}.sqlite`);
}

const CHECKPOINT_LOCK_RETRY_MS = 25;
const CHECKPOINT_LOCK_MAX_WAIT_MS = 30_000;

interface CheckpointLockHandle {
  db: import("better-sqlite3").Database;
}

interface CheckpointCandidate {
  path: string;
  checkpoint: TranscriptCheckpointPayload;
  generation: number;
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireCheckpointLock(lockPath: string): Promise<CheckpointLockHandle> {
  const deadline = Date.now() + CHECKPOINT_LOCK_MAX_WAIT_MS;
  for (;;) {
    let db: import("better-sqlite3").Database | undefined;
    try {
      db = new BetterSqlite3(lockPath);
      // BEGIN IMMEDIATE obtains an OS-backed SQLite write reservation.  A
      // killed holder closes its descriptor and releases the reservation.
      db.pragma("busy_timeout = 0");
      db.exec(
        "CREATE TABLE IF NOT EXISTS checkpoint_lock (id INTEGER PRIMARY KEY CHECK (id = 1));",
      );
      db.exec("BEGIN IMMEDIATE");
      // Record use so the age-based lock sweep never removes a lock in active use.
      const now = new Date();
      await fs.utimes(lockPath, now, now).catch(() => undefined);
      return { db };
    } catch (error: unknown) {
      if (db) {
        try {
          db.close();
        } catch {
          // A failed BEGIN/DDL attempt is discarded before retrying.
        }
      }
      const code = String((error as { code?: unknown })?.code || "");
      if (!code.startsWith("SQLITE_BUSY") && !code.startsWith("SQLITE_LOCKED")) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring checkpoint lock: ${lockPath}`);
      }
      await sleepFor(CHECKPOINT_LOCK_RETRY_MS);
    }
  }
}

async function releaseCheckpointLock(lock: CheckpointLockHandle): Promise<void> {
  try {
    // Rollback releases BEGIN IMMEDIATE before close.  The database file is
    // deliberately retained so future writers share the same OS lock object.
    lock.db.exec("ROLLBACK");
  } catch {
    // The process may already have left the transaction after a failed write.
  }
  try {
    lock.db.close();
  } catch {
    // Closing an already-closed handle is harmless during error unwinding.
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    // Directory fsync is supported by the local filesystems used by Electron.
    // Some platforms/filesystems reject opening a directory; file durability
    // remains valid there and the directory sync is best effort.
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch {
    // Best effort: do not make a valid atomic checkpoint write fail solely
    // because directory handles cannot be synced on the target filesystem.
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function copyCheckpointDurably(
  sourcePath: string,
  destinationPath: string,
  directoryPath: string,
): Promise<void> {
  const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await fs.copyFile(sourcePath, tempPath);
    handle = await fs.open(tempPath, "r");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, destinationPath);
    await syncDirectory(directoryPath);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function checkpointTimestamp(checkpoint: TranscriptCheckpointPayload): number | null {
  if (
    typeof checkpoint.sourceTimestamp === "number" &&
    Number.isFinite(checkpoint.sourceTimestamp)
  ) {
    return checkpoint.sourceTimestamp;
  }
  return typeof checkpoint.timestamp === "number" && Number.isFinite(checkpoint.timestamp)
    ? checkpoint.timestamp
    : null;
}

/**
 * How far ahead of the local clock a checkpoint timestamp may be before it is
 * treated as untrustworthy. Checkpoints live in the workspace, so a forged
 * file could claim a far-future `sourceTimestamp` to win every freshness
 * comparison and block legitimate writes. Small skew is tolerated.
 */
const CHECKPOINT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function isFarFutureCheckpointTimestamp(value: unknown, now = Date.now()): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > now + CHECKPOINT_MAX_FUTURE_SKEW_MS
  );
}

function isFarFutureCheckpoint(checkpoint: TranscriptCheckpointPayload): boolean {
  const now = Date.now();
  return (
    isFarFutureCheckpointTimestamp(checkpoint.sourceTimestamp, now) ||
    isFarFutureCheckpointTimestamp(checkpoint.timestamp, now)
  );
}

function checkpointMeaningfulExchangeCount(checkpoint: TranscriptCheckpointPayload): number | null {
  const raw = checkpoint.sourceMetadata?.meaningfulExchangeCount;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function checkpointMessageCount(checkpoint: TranscriptCheckpointPayload): number | null {
  const raw = checkpoint.messageCount;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function compareCheckpointFreshness(
  left: TranscriptCheckpointPayload,
  right: TranscriptCheckpointPayload,
): number {
  // A checkpoint dated far in the future is never fresher than one with a
  // plausible clock, whatever its other counters claim.
  const leftFarFuture = isFarFutureCheckpoint(left);
  const rightFarFuture = isFarFutureCheckpoint(right);
  if (leftFarFuture !== rightFarFuture) return leftFarFuture ? -1 : 1;

  const leftTimestamp = checkpointTimestamp(left);
  const rightTimestamp = checkpointTimestamp(right);
  if (leftTimestamp !== null && rightTimestamp !== null && leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }

  const leftExchangeCount = checkpointMeaningfulExchangeCount(left);
  const rightExchangeCount = checkpointMeaningfulExchangeCount(right);
  if (
    leftExchangeCount !== null &&
    rightExchangeCount !== null &&
    leftExchangeCount !== rightExchangeCount
  ) {
    return leftExchangeCount - rightExchangeCount;
  }

  const leftMessageCount = checkpointMessageCount(left);
  const rightMessageCount = checkpointMessageCount(right);
  if (
    leftMessageCount !== null &&
    rightMessageCount !== null &&
    leftMessageCount !== rightMessageCount
  ) {
    return leftMessageCount - rightMessageCount;
  }
  return 0;
}

function compareCheckpointCandidates(
  left: CheckpointCandidate,
  right: CheckpointCandidate,
): number {
  return (
    compareCheckpointFreshness(left.checkpoint, right.checkpoint) ||
    left.generation - right.generation
  );
}

async function readCheckpointCandidate(
  candidatePath: string,
  taskId: string,
): Promise<CheckpointCandidate | null> {
  try {
    const checkpoint = parseCheckpoint(await fs.readFile(candidatePath, "utf8"), taskId);
    return checkpoint
      ? { path: candidatePath, checkpoint, generation: checkpointGeneration(checkpoint) }
      : null;
  } catch {
    return null;
  }
}

/**
 * Parse a checkpoint file and verify its keyed signature. Checkpoints without an
 * `hmac-sha256` integrity block (including legacy unkeyed `sha256` ones), with a
 * signature for another task, or with a signature made under another key are
 * rejected; restore then falls back to the snapshot in the task database.
 */
function parseCheckpoint(raw: string, taskId: string): TranscriptCheckpointPayload | null {
  try {
    const parsed = JSON.parse(raw) as TranscriptCheckpointPayload;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const integrity = parsed.checkpointIntegrity;
    if (
      !integrity ||
      typeof integrity !== "object" ||
      integrity.algorithm !== "hmac-sha256" ||
      typeof integrity.checksum !== "string" ||
      typeof integrity.generation !== "number" ||
      !Number.isInteger(integrity.generation) ||
      integrity.generation < 1
    ) {
      return null;
    }
    const withoutIntegrity = { ...(parsed as Any) };
    delete withoutIntegrity.checkpointIntegrity;
    if (
      !verifyCheckpointSignature(
        taskId,
        integrity.generation,
        JSON.stringify(withoutIntegrity),
        integrity.checksum,
      )
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function checkpointGeneration(checkpoint: TranscriptCheckpointPayload | null): number {
  const generation = checkpoint?.checkpointIntegrity?.generation;
  return typeof generation === "number" && Number.isFinite(generation)
    ? Math.max(0, Math.floor(generation))
    : 0;
}

function isSafeTaskId(taskId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(taskId);
}

function allowsRead(readGuard: TranscriptReadGuard | undefined, candidatePath: string): boolean {
  if (!readGuard) return true;
  try {
    return readGuard(candidatePath) === true;
  } catch {
    return false;
  }
}

function normalizeWorkspacePath(workspacePath: string): string {
  return path.resolve(workspacePath);
}

export interface TranscriptDeletionResult {
  /** Tasks selected by retention (0 for direct deletes). */
  tasks: number;
  /** Conversation index and durable history rows removed. */
  indexRows: number;
  /** Legacy `transcript_spans` rows removed (only before the one-time migration ran). */
  spanRows: number;
  spanFiles: number;
  checkpointFiles: number;
  lockFiles: number;
  bytesFreed: number;
}

/** Mirrors `PRUNE_TASK_EVENTS_BATCH_SQL` so span retention follows task-event retention. */
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_RETENTION_DAYS = 90;

function emptyDeletionResult(): TranscriptDeletionResult {
  return {
    tasks: 0,
    indexRows: 0,
    spanRows: 0,
    spanFiles: 0,
    checkpointFiles: 0,
    lockFiles: 0,
    bytesFreed: 0,
  };
}

function mergeDeletionResult(
  target: TranscriptDeletionResult,
  source: TranscriptDeletionResult,
): void {
  target.tasks += source.tasks;
  target.indexRows += source.indexRows;
  target.spanRows += source.spanRows;
  target.spanFiles += source.spanFiles;
  target.checkpointFiles += source.checkpointFiles;
  target.lockFiles += source.lockFiles;
  target.bytesFreed += source.bytesFreed;
}

function retentionCutoff(options: { retentionDays?: number; now?: number }): number {
  const days =
    typeof options.retentionDays === "number" && Number.isFinite(options.retentionDays)
      ? Math.max(0, options.retentionDays)
      : DEFAULT_RETENTION_DAYS;
  return (options.now ?? Date.now()) - days * 24 * 60 * 60 * 1000;
}

/**
 * Resolve a transcripts subdirectory only when it is a real directory inside the
 * workspace, so a symlinked `.cowork/memory/transcripts` cannot redirect deletes.
 */
async function resolveOwnedDirectory(
  workspacePath: string,
  directoryPath: string,
): Promise<string | null> {
  try {
    const [workspaceReal, directoryReal] = await Promise.all([
      fs.realpath(workspacePath),
      fs.realpath(directoryPath),
    ]);
    const relative = path.relative(workspaceReal, directoryReal);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const stat = await fs.lstat(directoryPath);
    return stat.isDirectory() ? directoryPath : null;
  } catch {
    return null;
  }
}

/** Remove a regular file (never follows symlinks); returns its size or -1 when absent. */
async function removeOwnedFile(filePath: string): Promise<number> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() && !stat.isSymbolicLink()) return -1;
    await fs.rm(filePath, { force: true });
    return stat.isFile() ? stat.size : 0;
  } catch {
    return -1;
  }
}

async function listTranscriptFileTaskIds(workspacePath: string): Promise<string[]> {
  const ids = new Set<string>();
  const spans = await resolveOwnedDirectory(workspacePath, spansDir(workspacePath));
  if (spans) {
    for (const name of await fs.readdir(spans).catch(() => [] as string[])) {
      if (name.endsWith(".jsonl")) ids.add(name.slice(0, -".jsonl".length));
    }
  }
  const checkpoints = await resolveOwnedDirectory(workspacePath, checkpointsDir(workspacePath));
  if (checkpoints) {
    for (const name of await fs.readdir(checkpoints).catch(() => [] as string[])) {
      if (name.endsWith(".previous.json")) ids.add(name.slice(0, -".previous.json".length));
      else if (name.endsWith(".json")) ids.add(name.slice(0, -".json".length));
    }
  }
  return [...ids].filter(isSafeTaskId);
}

async function taskFilesOlderThan(
  workspacePath: string,
  taskId: string,
  cutoff: number,
): Promise<boolean> {
  const candidates = [
    taskSpanPath(workspacePath, taskId),
    taskCheckpointPath(workspacePath, taskId),
    taskPreviousCheckpointPath(workspacePath, taskId),
  ];
  let found = false;
  for (const candidate of candidates) {
    try {
      const stat = await fs.lstat(candidate);
      found = true;
      if (stat.mtimeMs >= cutoff) return false;
    } catch {
      // Missing generation.
    }
  }
  return found;
}

async function deleteTaskFiles(
  workspacePath: string,
  taskId: string,
): Promise<TranscriptDeletionResult> {
  const result = emptyDeletionResult();
  const spans = await resolveOwnedDirectory(workspacePath, spansDir(workspacePath));
  if (spans) {
    const size = await removeOwnedFile(taskSpanPath(workspacePath, taskId));
    if (size >= 0) {
      result.spanFiles += 1;
      result.bytesFreed += size;
    }
  }
  const checkpoints = await resolveOwnedDirectory(workspacePath, checkpointsDir(workspacePath));
  if (checkpoints) {
    const names = await fs.readdir(checkpoints).catch(() => [] as string[]);
    for (const name of names) {
      const isCheckpoint =
        name === `${taskId}.json` ||
        name === `${taskId}.previous.json` ||
        ((name.startsWith(`${taskId}.json.`) || name.startsWith(`${taskId}.previous.json.`)) &&
          name.endsWith(".tmp"));
      if (!isCheckpoint) continue;
      const size = await removeOwnedFile(path.join(checkpoints, name));
      if (size >= 0) {
        result.checkpointFiles += 1;
        result.bytesFreed += size;
      }
    }
  }
  if (await removeCheckpointLockFile(await existingCheckpointLockPath(workspacePath, taskId))) {
    result.lockFiles += 1;
  }
  return result;
}

/** The lock path for a task without creating the lock directory. */
async function existingCheckpointLockPath(workspacePath: string, taskId: string): Promise<string> {
  let canonicalWorkspacePath: string;
  try {
    canonicalWorkspacePath = await fs.realpath(workspacePath);
  } catch {
    canonicalWorkspacePath = normalizeWorkspacePath(workspacePath);
  }
  const lockKey = createHash("sha256")
    .update(`${canonicalWorkspacePath}\u0000${taskId}`)
    .digest("hex");
  return path.join(configuredCheckpointLockRoot(), `${lockKey}.sqlite`);
}

/**
 * Remove a checkpoint lock database only when no writer holds it: the reservation
 * is taken first (without waiting), the file is unlinked while held, then released.
 */
async function removeCheckpointLockFile(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(lockPath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  let db: Database.Database | undefined;
  try {
    db = new BetterSqlite3(lockPath, { fileMustExist: true });
    db.pragma("busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
  } catch {
    try {
      db?.close();
    } catch {
      // Ignore close failures; the lock is in use or unreadable.
    }
    return false;
  }
  let removed = false;
  try {
    await fs.rm(lockPath, { force: true });
    removed = true;
  } catch {
    removed = false;
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already outside the transaction.
    }
    try {
      db.close();
    } catch {
      // Closing a released handle is harmless.
    }
  }
  if (!removed) {
    // Platforms that refuse to unlink an open file: retry once the handle is closed.
    removed = await fs
      .rm(lockPath, { force: true })
      .then(() => true)
      .catch(() => false);
  }
  await Promise.all(
    ["-journal", "-wal", "-shm"].map((suffix) =>
      fs.rm(`${lockPath}${suffix}`, { force: true }).catch(() => undefined),
    ),
  );
  return removed;
}

/** Remove lock files not used since the cutoff (each use refreshes the mtime). */
async function sweepStaleCheckpointLocks(cutoff: number): Promise<number> {
  const lockRoot = configuredCheckpointLockRoot();
  const names = await fs.readdir(lockRoot).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.sqlite$/.test(name)) continue;
    const lockPath = path.join(lockRoot, name);
    try {
      const stat = await fs.lstat(lockPath);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
    } catch {
      continue;
    }
    if (await removeCheckpointLockFile(lockPath)) removed += 1;
  }
  return removed;
}

export class TranscriptStore {
  private static dbOverride: TranscriptDatabase | null | undefined;
  private static statements: { db: TranscriptDatabase; port: MemoryStatementPort } | null = null;
  private static readonly checkpointWriteTails = new Map<string, Promise<void>>();

  static setDatabaseForTests(db: TranscriptDatabase | null): void {
    this.dbOverride = db;
    this.statements = null;
  }

  static async ensureLayout(workspacePath: string): Promise<void> {
    await ensureWorkspaceDirectory(workspacePath, checkpointsDir(workspacePath));
  }

  static async writeCheckpoint(
    workspacePath: string,
    taskId: string,
    checkpoint: TranscriptCheckpointPayload,
  ): Promise<void> {
    if (!workspacePath || !taskId || !isSafeTaskId(taskId)) return;
    // Capture the request's logical time before waiting for another writer.
    // This lets the freshness check reject an older async snapshot that only
    // reaches the filesystem after a newer snapshot has committed.
    const basePayload: Record<string, unknown> = {
      ...checkpoint,
      timestamp: checkpoint.timestamp ?? Date.now(),
      resumeStrategy: checkpoint.resumeStrategy ?? "checkpoint",
    };
    delete basePayload.checkpointIntegrity;

    const lockKey = `${normalizeWorkspacePath(workspacePath)}\u0000${taskId}`;
    const previous = this.checkpointWriteTails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => gate);
    this.checkpointWriteTails.set(lockKey, queued);

    await previous;
    let checkpointLock: CheckpointLockHandle | undefined;
    try {
      await this.ensureLayout(workspacePath);
      checkpointLock = await acquireCheckpointLock(
        await taskCheckpointLockPath(workspacePath, taskId),
      );

      const currentPath = taskCheckpointPath(workspacePath, taskId);
      const previousPath = taskPreviousCheckpointPath(workspacePath, taskId);
      const existingCandidates = (
        await Promise.all(
          [currentPath, previousPath].map((candidatePath) =>
            readCheckpointCandidate(candidatePath, taskId),
          ),
        )
      ).filter((candidate): candidate is CheckpointCandidate => candidate !== null);
      const latestCandidate = existingCandidates.reduce<CheckpointCandidate | null>(
        (latest, candidate) =>
          !latest || compareCheckpointCandidates(candidate, latest) > 0 ? candidate : latest,
        null,
      );

      // A late writer may hold an older event snapshot.  Preserve the newer
      // committed state and leave its generation untouched when freshness is
      // known.  Equal/unknown freshness retains legacy write-through behavior.
      if (
        latestCandidate &&
        compareCheckpointFreshness(
          basePayload as TranscriptCheckpointPayload,
          latestCandidate.checkpoint,
        ) < 0
      ) {
        return;
      }

      const generation =
        Math.max(0, ...existingCandidates.map((candidate) => candidate.generation)) + 1;
      const payload: TranscriptCheckpointPayload = {
        ...(basePayload as TranscriptCheckpointPayload),
        checkpointIntegrity: {
          algorithm: "hmac-sha256",
          generation,
          checksum: signCheckpointBody(taskId, generation, JSON.stringify(basePayload)),
        },
      };
      const serialized = JSON.stringify(payload, null, 2);
      const tempPath = `${currentPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(tempPath, "w");
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;

        // Preserve the freshest known-good generation before replacing the
        // current file.  If current is corrupt while previous is valid, do not
        // copy the corrupt bytes over the only recovery generation.
        if (latestCandidate?.path === currentPath) {
          await copyCheckpointDurably(currentPath, previousPath, checkpointsDir(workspacePath));
        }
        await fs.rename(tempPath, currentPath);
        await syncDirectory(checkpointsDir(workspacePath));
      } finally {
        if (handle) {
          await handle.close().catch(() => undefined);
        }
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
    } finally {
      if (checkpointLock) await releaseCheckpointLock(checkpointLock);
      release();
      if (this.checkpointWriteTails.get(lockKey) === queued) {
        this.checkpointWriteTails.delete(lockKey);
      }
    }
  }

  static async loadCheckpoint(
    workspacePath: string,
    taskId: string,
    readGuard?: TranscriptReadGuard,
  ): Promise<TranscriptCheckpointPayload | null> {
    if (!isSafeTaskId(taskId)) return null;
    const candidates = [
      taskCheckpointPath(workspacePath, taskId),
      taskPreviousCheckpointPath(workspacePath, taskId),
    ];
    const validCandidates: CheckpointCandidate[] = [];
    for (const candidatePath of candidates) {
      if (!allowsRead(readGuard, candidatePath)) continue;
      const candidate = await readCheckpointCandidate(candidatePath, taskId);
      if (candidate) validCandidates.push(candidate);
    }
    validCandidates.sort((a, b) => compareCheckpointCandidates(b, a));
    return validCandidates[0]?.checkpoint || null;
  }

  static loadCheckpointSync(
    workspacePath: string,
    taskId: string,
    readGuard?: TranscriptReadGuard,
  ): TranscriptCheckpointPayload | null {
    if (!isSafeTaskId(taskId)) return null;
    const candidates = [
      taskCheckpointPath(workspacePath, taskId),
      taskPreviousCheckpointPath(workspacePath, taskId),
    ];
    const validCandidates: CheckpointCandidate[] = [];
    for (const candidatePath of candidates) {
      if (!allowsRead(readGuard, candidatePath)) continue;
      try {
        const parsed = parseCheckpoint(fsSync.readFileSync(candidatePath, "utf8"), taskId);
        if (parsed) {
          validCandidates.push({
            path: candidatePath,
            checkpoint: parsed,
            generation: checkpointGeneration(parsed),
          });
        }
      } catch {
        // Try the previous generation when the newest file is truncated or
        // otherwise unreadable.
      }
    }
    validCandidates.sort((a, b) => compareCheckpointCandidates(b, a));
    return validCandidates[0]?.checkpoint || null;
  }

  // ---------------------------------------------------------------------------
  // Deletion and retention
  // ---------------------------------------------------------------------------

  /**
   * Delete everything stored for one task's conversation: its conversation index rows,
   * legacy span rows, the legacy JSONL span file, both checkpoint generations, leftover
   * temp files and the checkpoint lock file. Safe to call for tasks that never wrote
   * transcripts.
   *
   * `workspacePath` names the workspace whose files are removed. Without it, files are
   * removed in every workspace that held legacy spans for the task.
   */
  static async deleteTask(
    taskId: string,
    options: { workspacePath?: string } = {},
  ): Promise<TranscriptDeletionResult> {
    const result = emptyDeletionResult();
    if (!taskId || !isSafeTaskId(taskId)) return result;
    try {
      result.indexRows += await DurableContextService.deleteTaskConversation(taskId);
    } catch {
      // Files below are still removed when the index is unavailable.
    }
    const sql = this.getStatements();
    const workspacePaths = new Set<string>();
    if (options.workspacePath) workspacePaths.add(normalizeWorkspacePath(options.workspacePath));
    if (sql) {
      try {
        if (options.workspacePath) {
          result.spanRows += (
            await sql.run("transcript_deleteTaskSpans", [
              normalizeWorkspacePath(options.workspacePath),
              taskId,
            ])
          ).changes;
        } else {
          const rows = await sql.all<{ workspace_path?: string }>("transcript_taskWorkspaces", [
            taskId,
          ]);
          for (const row of rows) {
            if (typeof row.workspace_path === "string" && row.workspace_path) {
              workspacePaths.add(row.workspace_path);
            }
          }
          result.spanRows += (await sql.run("transcript_deleteTaskSpansAnyWorkspace", [taskId]))
            .changes;
        }
      } catch {
        // The files below are still removed when the index is unavailable.
      }
    }
    for (const workspacePath of workspacePaths) {
      mergeDeletionResult(result, await deleteTaskFiles(workspacePath, taskId));
    }
    return result;
  }

  /**
   * Delete all transcript data of a workspace: legacy span rows, the transcripts
   * directory (spans and checkpoints) and the checkpoint lock files of its tasks. With
   * `workspaceId`, the workspace's conversation index and durable history go too (the
   * memory purge clears those itself through `DurableContextService.clearWorkspace`).
   */
  static async deleteWorkspace(
    workspacePath: string,
    options: { workspaceId?: string } = {},
  ): Promise<TranscriptDeletionResult> {
    const result = emptyDeletionResult();
    if (!workspacePath) return result;
    if (options.workspaceId) {
      try {
        result.indexRows += await DurableContextService.clearWorkspace(options.workspaceId);
      } catch {
        // Continue with the legacy rows and files.
      }
    }
    const normalized = normalizeWorkspacePath(workspacePath);
    const taskIds = new Set<string>(await listTranscriptFileTaskIds(normalized));
    const sql = this.getStatements();
    if (sql) {
      try {
        const rows = await sql.all<{ task_id?: string }>("transcript_workspaceTaskIds", [
          normalized,
        ]);
        for (const row of rows) {
          if (typeof row.task_id === "string") taskIds.add(row.task_id);
        }
        result.spanRows += (await sql.run("transcript_deleteWorkspaceSpans", [normalized])).changes;
      } catch {
        // Continue with file cleanup.
      }
    }
    for (const taskId of taskIds) {
      if (isSafeTaskId(taskId)) {
        mergeDeletionResult(result, await deleteTaskFiles(normalized, taskId));
      }
    }
    return result;
  }

  /**
   * Retention for one workspace, aligned with task-event pruning: transcripts of
   * terminal tasks created before the cutoff are deleted, as are rows whose task no
   * longer exists. Files whose task is unknown to this database are deleted only
   * when they are older than the cutoff (another profile may own them).
   */
  static async pruneWorkspace(
    workspacePath: string,
    options: { retentionDays?: number; now?: number } = {},
  ): Promise<TranscriptDeletionResult> {
    const result = emptyDeletionResult();
    if (!workspacePath) return result;
    const normalized = normalizeWorkspacePath(workspacePath);
    const cutoff = retentionCutoff(options);
    const sql = this.getStatements();
    const rowTaskIds = new Set<string>();
    if (sql) {
      try {
        const rows = await sql.all<{ task_id?: string }>("transcript_workspaceTaskIds", [
          normalized,
        ]);
        for (const row of rows) {
          if (typeof row.task_id === "string") rowTaskIds.add(row.task_id);
        }
      } catch {
        // Fall through to file-based pruning.
      }
    }
    const fileTaskIds = await listTranscriptFileTaskIds(normalized);
    const candidates = new Set<string>([...rowTaskIds, ...fileTaskIds]);
    for (const taskId of candidates) {
      const verdict = await this.retentionVerdict(sql, taskId, cutoff);
      if (verdict === "keep") continue;
      if (verdict === "missing" && !rowTaskIds.has(taskId)) {
        // Only files exist and the task is unknown here: require them to be old.
        if (!(await taskFilesOlderThan(normalized, taskId, cutoff))) continue;
      }
      mergeDeletionResult(result, await this.deleteTask(taskId, { workspacePath: normalized }));
      result.tasks += 1;
    }
    return result;
  }

  /**
   * Retention with the task-event retention window: the conversation index and durable
   * history of expired and deleted tasks, then every workspace's transcript files (and
   * legacy span rows), followed by a sweep of stale checkpoint lock files. Call it after
   * task-event pruning with the same retention window.
   */
  static async pruneRetention(
    options: { retentionDays?: number; now?: number } = {},
  ): Promise<TranscriptDeletionResult> {
    const result = emptyDeletionResult();
    const sql = this.getStatements();
    // Without the database nothing is known about task state; keep everything.
    if (!sql) return result;
    try {
      const pruned = await DurableContextService.pruneConversationRetention(options);
      result.tasks += pruned.tasks;
      result.indexRows += pruned.rows;
    } catch {
      // File retention below still runs.
    }
    const workspacePaths = new Set<string>();
    {
      try {
        for (const row of await sql.all<{ path?: string }>("transcript_workspacePaths", [])) {
          if (typeof row.path === "string" && row.path) {
            workspacePaths.add(normalizeWorkspacePath(row.path));
          }
        }
      } catch {
        // No workspaces table (tests or a partial schema).
      }
      try {
        for (const row of await sql.all<{ workspace_path?: string }>(
          "transcript_spanWorkspacePaths",
          [],
        )) {
          if (typeof row.workspace_path === "string" && row.workspace_path) {
            workspacePaths.add(row.workspace_path);
          }
        }
      } catch {
        // Index unavailable.
      }
    }
    for (const workspacePath of workspacePaths) {
      mergeDeletionResult(result, await this.pruneWorkspace(workspacePath, options));
    }
    result.lockFiles += await sweepStaleCheckpointLocks(retentionCutoff(options));
    return result;
  }

  private static async retentionVerdict(
    sql: MemoryStatementPort | null,
    taskId: string,
    cutoff: number,
  ): Promise<"keep" | "expired" | "missing"> {
    if (!sql) return "keep";
    try {
      const row = await sql.get<{ status?: string; created_at?: number }>(
        "transcript_taskRetention",
        [taskId],
      );
      if (!row) return "missing";
      const terminal = TERMINAL_TASK_STATUSES.has(String(row.status || ""));
      return terminal && Number(row.created_at || 0) < cutoff ? "expired" : "keep";
    } catch {
      // Without a readable tasks table nothing is known to be expired.
      return "keep";
    }
  }

  private static getDatabase(): TranscriptDatabase | null {
    if (this.dbOverride !== undefined) return this.dbOverride;
    try {
      return DatabaseManager.getInstance().getDatabase();
    } catch {
      return null;
    }
  }

  /**
   * The memory statement port for the current database. The legacy span table is not
   * created: its statements fail (and are skipped) on databases that never had spans.
   */
  private static getStatements(): MemoryStatementPort | null {
    const db = this.getDatabase();
    if (!db) return null;
    if (this.statements?.db !== db) {
      this.statements = { db, port: createMemoryStatementPort(db as Database.Database) };
    }
    return this.statements.port;
  }
}

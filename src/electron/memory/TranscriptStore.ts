import { ensureWorkspaceDirectory } from "../utils/workspace-directory";
import fsSync from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import type { TaskEvent } from "../../shared/types";
import { DatabaseManager } from "../database/schema";
import { createMemoryStatementPort, type MemoryStatementPort } from "./memory-statement-port";
import { signCheckpointBody, verifyCheckpointSignature } from "./checkpoint-signing";
import {
  TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS,
  TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS,
  ensureTranscriptSchema,
} from "./transcript-sql";

export interface TranscriptSpanRecord {
  taskId: string;
  timestamp: number;
  type: string;
  payload: unknown;
  eventId?: string;
  seq?: number;
}

export interface TranscriptSearchResult {
  taskId: string;
  timestamp: number;
  type: string;
  payload: unknown;
  eventId?: string;
  seq?: number;
  rawLine: string;
}

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

function compareSearchResults(a: TranscriptSearchResult, b: TranscriptSearchResult): number {
  return (
    b.timestamp - a.timestamp ||
    a.taskId.localeCompare(b.taskId) ||
    (typeof b.seq === "number" ? b.seq : -1) - (typeof a.seq === "number" ? a.seq : -1) ||
    a.type.localeCompare(b.type)
  );
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

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function buildSpanId(workspacePath: string, record: TranscriptSpanRecord, rawLine: string): string {
  const stablePart =
    record.eventId ||
    (typeof record.seq === "number"
      ? `seq:${record.seq}`
      : `ts:${record.timestamp}:${record.type}:${hashText(rawLine)}`);
  return `${hashText(normalizeWorkspacePath(workspacePath))}:${record.taskId}:${stablePart}`;
}

function payloadToSearchText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload) ?? "";
  } catch {
    return "";
  }
}

export { TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS, TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS };

const SPAN_PAYLOAD_FIELD_MAX_CHARS = 512;

function buildSpanSearchText(type: string, payload: unknown): string {
  return `${type} ${payloadToSearchText(payload)}`.slice(0, TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS);
}

/** Replace an oversized payload with its small scalar fields plus a bounded preview. */
export function boundTranscriptSpanPayload(payload: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload ?? null) ?? "null";
  } catch {
    return { spanPayloadTruncated: true, preview: "" };
  }
  if (serialized.length <= TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS) return payload;

  const bounded: Record<string, unknown> = {};
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        const fieldText = typeof value === "string" ? value : String(value);
        if (fieldText.length <= SPAN_PAYLOAD_FIELD_MAX_CHARS) bounded[key] = value;
      }
    }
  }
  const preview =
    typeof payload === "string"
      ? payload.slice(0, TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS)
      : serialized.slice(0, TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS);
  return {
    ...bounded,
    spanPayloadTruncated: true,
    originalChars: serialized.length,
    preview: `${preview}\n[... truncated; the full event is kept in the task event log ...]`,
  };
}

function buildFtsQuery(query: string): string {
  return (query.toLowerCase().match(/[a-z0-9_]{2,}/g) || []).slice(0, 12).join(" ");
}

function shouldPersistSpan(type: string): boolean {
  return [
    "task_created",
    "user_message",
    "assistant_message",
    "timeline_group_started",
    "timeline_group_finished",
    "timeline_step_started",
    "timeline_step_updated",
    "timeline_step_finished",
    "timeline_evidence_attached",
    "timeline_artifact_emitted",
    "timeline_command_output",
    "timeline_error",
    "tool_call",
    "tool_result",
    "tool_error",
    "step_feedback",
    "task_completed",
    "task_status",
    "task_paused",
    "task_resumed",
    "context_compaction_started",
    "context_compaction_completed",
    "context_compaction_failed",
    "context_summarized",
    // `conversation_snapshot` is deliberately absent: each one carries the whole
    // history, task_events keeps the latest and checkpoints hold resume state.
  ].includes(type);
}

const TAIL_READ_CHUNK_BYTES = 256 * 1024;
const TAIL_READ_MAX_BYTES = 16 * 1024 * 1024;

/** Read up to `limit` trailing lines without loading a large span file whole. */
async function readTailLines(filePath: string, limit: number): Promise<string[]> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    let position = size;
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let newlines = 0;
    while (position > 0 && bytesRead < TAIL_READ_MAX_BYTES) {
      const length = Math.min(TAIL_READ_CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      bytesRead += length;
      chunks.unshift(buffer);
      for (const byte of buffer) {
        if (byte === 10) newlines += 1;
      }
      // One extra newline guarantees the first kept line is complete.
      if (newlines > limit + 1) break;
    }
    let lines = Buffer.concat(chunks).toString("utf8").split("\n");
    // Drop a partial leading line when the read did not reach the file start.
    if (position > 0) lines = lines.slice(1);
    return lines.filter(Boolean).slice(-limit);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function safeParseLine(line: string): TranscriptSpanRecord | null {
  try {
    const parsed = JSON.parse(line) as TranscriptSpanRecord;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.taskId !== "string" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface TranscriptDeletionResult {
  /** Tasks selected by retention (0 for direct deletes). */
  tasks: number;
  spanRows: number;
  spanFiles: number;
  checkpointFiles: number;
  lockFiles: number;
  bytesFreed: number;
}

export interface TranscriptStorageCleanupResult {
  status: "completed" | "already_done" | "unavailable";
  deletedSnapshotRows: number;
  rewrittenRows: number;
  /** Approximate characters of row text released (snapshots, duplicates, oversize). */
  reclaimedChars: number;
  reindexedRows: number;
  incrementalVacuum: boolean;
  freelistBytes?: number;
}

/** Mirrors `PRUNE_TASK_EVENTS_BATCH_SQL` so span retention follows task-event retention. */
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_RETENTION_DAYS = 90;

function emptyDeletionResult(): TranscriptDeletionResult {
  return { tasks: 0, spanRows: 0, spanFiles: 0, checkpointFiles: 0, lockFiles: 0, bytesFreed: 0 };
}

function mergeDeletionResult(
  target: TranscriptDeletionResult,
  source: TranscriptDeletionResult,
): void {
  target.tasks += source.tasks;
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

function yieldToEventLoop(pauseMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, pauseMs));
}

export class TranscriptStore {
  private static dbOverride: TranscriptDatabase | null | undefined;
  private static dbSchemaReady = false;
  private static statements: { db: TranscriptDatabase; port: MemoryStatementPort } | null = null;
  private static readonly checkpointWriteTails = new Map<string, Promise<void>>();

  static setDatabaseForTests(db: TranscriptDatabase | null): void {
    this.dbOverride = db;
    this.dbSchemaReady = false;
  }

  static async ensureLayout(workspacePath: string): Promise<void> {
    await Promise.all([
      ensureWorkspaceDirectory(workspacePath, spansDir(workspacePath)),
      ensureWorkspaceDirectory(workspacePath, checkpointsDir(workspacePath)),
    ]);
  }

  static async appendEvent(workspacePath: string, event: TaskEvent): Promise<void> {
    if (!workspacePath || !shouldPersistSpan(event.type)) {
      return;
    }
    await this.ensureLayout(workspacePath);
    if (!isSafeTaskId(event.taskId)) return;
    const record: TranscriptSpanRecord = {
      taskId: event.taskId,
      timestamp: typeof event.ts === "number" ? event.ts : event.timestamp,
      type: event.type,
      payload: boundTranscriptSpanPayload(event.payload),
      ...(event.eventId ? { eventId: event.eventId } : {}),
      ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
    };
    const rawLine = JSON.stringify(record);
    await fs.appendFile(taskSpanPath(workspacePath, event.taskId), `${rawLine}\n`, "utf8");
    await this.indexSpan(workspacePath, record, rawLine);
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

  static async loadRecentSpans(
    workspacePath: string,
    taskId: string,
    limit = 40,
    readGuard?: TranscriptReadGuard,
  ): Promise<TranscriptSpanRecord[]> {
    if (!isSafeTaskId(taskId)) return [];
    const spanPath = taskSpanPath(workspacePath, taskId);
    if (!allowsRead(readGuard, spanPath)) return [];
    try {
      const lines = await readTailLines(spanPath, Math.max(1, limit));
      return lines
        .map((line) => safeParseLine(line))
        .filter((entry): entry is TranscriptSpanRecord => entry !== null)
        .slice(-Math.max(1, limit));
    } catch {
      return [];
    }
  }

  static async searchSpans(params: {
    workspacePath: string;
    query: string;
    taskId?: string;
    limit?: number;
    readGuard?: TranscriptReadGuard;
  }): Promise<TranscriptSearchResult[]> {
    const query = params.query.trim().toLowerCase();
    if (!query) return [];
    if (params.taskId && !isSafeTaskId(params.taskId)) return [];

    const limit = Math.max(1, params.limit ?? 10);
    const indexedResults = await this.searchIndexedSpans({
      workspacePath: params.workspacePath,
      query,
      taskId: params.taskId,
      limit: params.readGuard ? Math.min(limit * 4, 120) : limit,
      readGuard: params.readGuard,
    });
    if (indexedResults.length >= limit) {
      return indexedResults.slice(0, limit);
    }

    const results: TranscriptSearchResult[] = [];
    const spansDirectory = spansDir(params.workspacePath);
    if (!params.taskId && !allowsRead(params.readGuard, spansDirectory)) {
      return indexedResults.slice(0, limit);
    }
    const files = params.taskId
      ? [taskSpanPath(params.workspacePath, params.taskId)]
      : (await fs.readdir(spansDir(params.workspacePath)).catch(() => []))
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => path.join(spansDir(params.workspacePath), name));

    for (const file of files) {
      if (!allowsRead(params.readGuard, file)) continue;
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      if (!raw) continue;
      const lines = raw.split("\n").filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.toLowerCase().includes(query)) continue;
        const parsed = safeParseLine(line);
        if (!parsed) continue;
        results.push({ ...parsed, rawLine: line });
        if (results.length > limit) {
          results.sort(compareSearchResults);
          results.length = limit;
        }
        if (params.taskId && results.length >= limit) {
          break;
        }
      }
    }

    return [...indexedResults, ...results]
      .filter((entry, index, all) => {
        const key = `${entry.taskId}:${entry.eventId || ""}:${entry.seq ?? ""}:${entry.timestamp}:${entry.rawLine}`;
        return (
          all.findIndex(
            (other) =>
              `${other.taskId}:${other.eventId || ""}:${other.seq ?? ""}:${other.timestamp}:${other.rawLine}` ===
              key,
          ) === index
        );
      })
      .sort(compareSearchResults)
      .slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Deletion and retention
  // ---------------------------------------------------------------------------

  /**
   * Delete everything stored for one task: span rows (and their FTS entries), the
   * JSONL span file, both checkpoint generations, leftover temp files and the
   * checkpoint lock file. Safe to call for tasks that never wrote transcripts.
   *
   * `workspacePath` scopes the row delete and names the workspace whose files are
   * removed. Without it, rows are deleted by task id and files are removed in every
   * workspace that held spans for the task.
   */
  static async deleteTask(
    taskId: string,
    options: { workspacePath?: string } = {},
  ): Promise<TranscriptDeletionResult> {
    const result = emptyDeletionResult();
    if (!taskId || !isSafeTaskId(taskId)) return result;
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
   * Delete all transcript data of a workspace: span rows, the transcripts directory
   * (spans and checkpoints) and the checkpoint lock files of its tasks.
   */
  static async deleteWorkspace(workspacePath: string): Promise<TranscriptDeletionResult> {
    const result = emptyDeletionResult();
    if (!workspacePath) return result;
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
   * Retention across every workspace known to the database or present in the span
   * index, followed by a sweep of stale checkpoint lock files. Call it after
   * task-event pruning with the same retention window.
   */
  static async pruneRetention(
    options: { retentionDays?: number; now?: number } = {},
  ): Promise<TranscriptDeletionResult> {
    const result = emptyDeletionResult();
    const sql = this.getStatements();
    // Without the database nothing is known about task state; keep everything.
    if (!sql) return result;
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

  // ---------------------------------------------------------------------------
  // One-time storage cleanup (span storage diet)
  // ---------------------------------------------------------------------------

  private static storageCleanupRun: Promise<TranscriptStorageCleanupResult> | null = null;

  /**
   * Reclaim space held by spans written before the storage diet. Idempotent and
   * resumable: progress and completion are recorded in the database, so it can be
   * interrupted at any batch. Work is done in short transactions with the event loop
   * yielding in between; call it from deferred maintenance, never on the startup path.
   *
   * 1. Empties the span FTS index (the triggers skip rows still waiting for backfill).
   * 2. Deletes `conversation_snapshot` spans, clears the duplicate `raw_line`, bounds
   *    `search_text` and truncates oversized payloads.
   * 3. Rebuilds the FTS index from the bounded text in batches.
   * 4. Runs `PRAGMA incremental_vacuum` when the database uses incremental
   *    auto-vacuum. Otherwise the freed pages stay on the freelist until a VACUUM
   *    (the idle VACUUM in daemon maintenance).
   *
   * JSONL span files are not rewritten; they age out through retention.
   */
  static runStorageCleanup(
    options: { batchSize?: number; pauseMs?: number; log?: (message: string) => void } = {},
  ): Promise<TranscriptStorageCleanupResult> {
    if (!this.storageCleanupRun) {
      this.storageCleanupRun = this.runStorageCleanupOnce(options).finally(() => {
        this.storageCleanupRun = null;
      });
    }
    return this.storageCleanupRun;
  }

  private static async runStorageCleanupOnce(options: {
    batchSize?: number;
    pauseMs?: number;
    log?: (message: string) => void;
  }): Promise<TranscriptStorageCleanupResult> {
    const result: TranscriptStorageCleanupResult = {
      status: "unavailable",
      deletedSnapshotRows: 0,
      rewrittenRows: 0,
      reclaimedChars: 0,
      reindexedRows: 0,
      incrementalVacuum: false,
    };
    const sql = this.getStatements();
    if (!sql) return result;
    const start = await sql.unit("transcript_storageCleanupStart", { now: Date.now() });
    if (start.status === "already_done") {
      result.status = "already_done";
      return result;
    }
    const batch = Math.max(1, Math.floor(options.batchSize ?? 200));
    const pauseMs = Math.max(0, Math.floor(options.pauseMs ?? 10));
    const log = options.log ?? (() => undefined);

    // Phase 1 (in the start unit): open the gap and empty the index in one transaction.
    const gap = start.gap;

    // Phase 2: delete snapshot spans and shrink the remaining rows, window by window.
    if (gap) {
      let cursor = start.cursor;
      while (cursor < gap.maxRowid) {
        const upper = Math.min(cursor + batch, gap.maxRowid);
        const rewritten = await sql.unit("transcript_storageCleanupRewrite", {
          lower: cursor,
          upper,
          now: Date.now(),
        });
        result.deletedSnapshotRows += rewritten.deletedSnapshotRows;
        result.rewrittenRows += rewritten.rewrittenRows;
        result.reclaimedChars += rewritten.reclaimedChars;
        cursor = upper;
        await yieldToEventLoop(pauseMs);
      }

      // Phase 3: rebuild the index for the gap from the bounded text.
      let done = gap.doneUpto;
      while (done < gap.maxRowid) {
        const upper = Math.min(done + batch * 4, gap.maxRowid);
        result.reindexedRows += await sql.unit("transcript_storageCleanupBackfill", {
          lower: done,
          upper,
        });
        done = upper;
        await yieldToEventLoop(pauseMs);
      }
    }

    // Phase 4: close the gap, add the task-id index, incremental vacuum, completion marker.
    const finished = await sql.unit("transcript_storageCleanupFinish", {
      closeGap: gap !== null,
      now: Date.now(),
      deletedSnapshotRows: result.deletedSnapshotRows,
      rewrittenRows: result.rewrittenRows,
      reclaimedChars: result.reclaimedChars,
    });
    result.incrementalVacuum = finished.incrementalVacuum;
    if (typeof finished.freelistBytes === "number") result.freelistBytes = finished.freelistBytes;
    result.status = "completed";
    log(
      `[TranscriptStore] Span storage cleanup: deleted ${result.deletedSnapshotRows} ` +
        `snapshot span(s), rewrote ${result.rewrittenRows} span(s), ` +
        `reclaimed ~${Math.round(result.reclaimedChars / 1048576)} MB of text, ` +
        `reindexed ${result.reindexedRows} span(s)` +
        (typeof result.freelistBytes === "number"
          ? `, ${Math.round(result.freelistBytes / 1048576)} MB free in the database file`
          : ""),
    );
    return result;
  }

  private static getDatabase(): TranscriptDatabase | null {
    if (this.dbOverride !== undefined) return this.dbOverride;
    try {
      return DatabaseManager.getInstance().getDatabase();
    } catch {
      return null;
    }
  }

  private static ensureDbSchema(db: TranscriptDatabase): boolean {
    if (this.dbSchemaReady) return true;
    try {
      ensureTranscriptSchema(db);
      this.dbSchemaReady = true;
      return true;
    } catch {
      return false;
    }
  }

  /** The memory statement port for the current database, schema created on first use. */
  private static getStatements(): MemoryStatementPort | null {
    const db = this.getDatabase();
    if (!db || !this.ensureDbSchema(db)) return null;
    if (this.statements?.db !== db) {
      this.statements = { db, port: createMemoryStatementPort(db as Database.Database) };
    }
    return this.statements.port;
  }

  private static async indexSpan(
    workspacePath: string,
    record: TranscriptSpanRecord,
    rawLine: string,
  ): Promise<void> {
    const sql = this.getStatements();
    if (!sql) return;

    try {
      await sql.run("transcript_indexSpan", [
        buildSpanId(workspacePath, record, rawLine),
        normalizeWorkspacePath(workspacePath),
        record.taskId,
        record.timestamp,
        record.type,
        JSON.stringify(record.payload ?? null),
        record.eventId ?? null,
        typeof record.seq === "number" ? record.seq : null,
        // The payload is stored once; `raw_line` stays empty for new rows.
        "",
        buildSpanSearchText(record.type, record.payload),
        Date.now(),
      ]);
    } catch {
      // Search falls back to JSONL scans when SQLite/FTS is unavailable.
    }
  }

  private static async searchIndexedSpans(params: {
    workspacePath: string;
    query: string;
    taskId?: string;
    limit: number;
    readGuard?: TranscriptReadGuard;
  }): Promise<TranscriptSearchResult[]> {
    const sql = this.getStatements();
    if (!sql) return [];

    const ftsQuery = buildFtsQuery(params.query);
    if (!ftsQuery) return [];

    try {
      const rows = await sql.all<Record<string, unknown>>("transcript_searchSpans", [
        ftsQuery,
        normalizeWorkspacePath(params.workspacePath),
        params.taskId ?? null,
        params.taskId ?? null,
        params.limit,
      ]);

      return rows
        .map((row) => {
          const item = row as Record<string, unknown>;
          let payload: unknown = null;
          try {
            payload = JSON.parse(String(item.payload_json || "null"));
          } catch {
            payload = item.payload_json;
          }
          const entry = {
            taskId: String(item.task_id || ""),
            timestamp: Number(item.timestamp || 0),
            type: String(item.type || ""),
            payload,
            ...(typeof item.event_id === "string" && item.event_id
              ? { eventId: item.event_id }
              : {}),
            ...(typeof item.seq === "number" ? { seq: item.seq } : {}),
          };
          // Spans written before the storage diet kept a copy of the JSONL line;
          // newer rows store the payload once and the line is rebuilt from it.
          const rawLine = String(item.raw_line || "") || JSON.stringify(entry);
          return { ...entry, rawLine };
        })
        .filter(
          (entry) =>
            entry.taskId &&
            entry.type &&
            entry.rawLine &&
            allowsRead(params.readGuard, taskSpanPath(params.workspacePath, entry.taskId)),
        );
    } catch {
      return [];
    }
  }
}

import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import { setMaintenanceStateValue } from "./post-startup-maintenance";

/**
 * Profile database lifecycle shared by every runtime (async SQLite migration plan, DB6):
 * cross-process migration serialization, the schema version gate, run records that let
 * the next start report an incomplete shutdown, and a bounded shutdown checkpoint.
 * Free of Electron imports so the daemon, the CLI and workers can load it.
 */

/**
 * Schema version this build creates and understands, stored in `PRAGMA user_version`.
 * Profiles from before versioning read 0 and are brought to this version by the
 * idempotent schema initialization. Raise it with any migration an older build must not
 * run against; an older build then refuses the profile instead of running on it.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export class UnsupportedSchemaVersionError extends Error {
  readonly code = "unsupported_schema_version";
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `This profile's database was upgraded by a newer CoWork OS (schema version ${found}); ` +
        `this version supports up to ${supported}. Update CoWork OS to open it.`,
    );
  }
}

export function readSchemaVersion(db: Database.Database): number {
  return Number(db.pragma("user_version", { simple: true }) ?? 0);
}

/** Fail clearly on a schema this build does not know. */
export function assertSupportedSchemaVersion(db: Database.Database): number {
  const found = readSchemaVersion(db);
  if (found > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(found, CURRENT_SCHEMA_VERSION);
  }
  return found;
}

/** Record that initialization brought the schema to this build's version. */
export function stampSchemaVersion(db: Database.Database): void {
  if (readSchemaVersion(db) < CURRENT_SCHEMA_VERSION) {
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  }
}

export interface MigrationLockOptions {
  /** How long to wait for another process's migration before giving up. */
  timeoutMs?: number;
  /** A lock older than this is abandoned, whatever its holder. */
  staleMs?: number;
  /** Sleep between attempts; tests pass a fake. */
  sleep?: (ms: number) => void;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

interface LockRecord {
  pid: number;
  host: string;
  acquiredAt: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 50;

function sleepSync(ms: number): void {
  // A synchronous wait: schema initialization runs in constructors that callers do not
  // await. Atomics.wait blocks without spinning.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class MigrationLockTimeoutError extends Error {
  readonly code = "migration_lock_timeout";
  constructor(
    readonly lockPath: string,
    readonly holder: LockRecord | null,
  ) {
    super(
      `Another CoWork OS process (pid ${holder?.pid ?? "unknown"}) is still preparing this profile's database; try again shortly.`,
    );
  }
}

/**
 * Serialize schema initialization across processes that open one profile (desktop,
 * daemon, CLI). The lock is a file created exclusively next to the database. It survives
 * a crash, so a lock whose holder is gone, or that is older than `staleMs`, is broken.
 * Returns the release function.
 */
export function acquireMigrationLock(
  dbPath: string,
  options: MigrationLockOptions = {},
): () => void {
  const lockPath = `${dbPath}.migration.lock`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const sleep = options.sleep ?? sleepSync;
  const alive = options.isProcessAlive ?? isProcessAlive;
  const now = options.now ?? Date.now;
  const host = os.hostname();
  const deadline = now() + timeoutMs;
  let holder: LockRecord | null = null;
  for (;;) {
    const record: LockRecord = { pid: process.pid, host, acquiredAt: now() };
    try {
      fs.writeFileSync(lockPath, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockRecord;
          if (current.pid === record.pid && current.acquiredAt === record.acquiredAt) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // Already gone, or broken as stale by another process.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    holder = readLock(lockPath);
    const abandoned =
      !holder ||
      now() - holder.acquiredAt > staleMs ||
      (holder.host === host && holder.pid !== process.pid && !alive(holder.pid));
    if (abandoned) {
      // The holder crashed or the file is unreadable: break it and retry at once.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Another process broke it first.
      }
      continue;
    }
    if (now() >= deadline) throw new MigrationLockTimeoutError(lockPath, holder);
    sleep(LOCK_POLL_MS);
  }
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockRecord;
    return typeof parsed.pid === "number" && typeof parsed.acquiredAt === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export type RuntimeName = "desktop" | "daemon" | "cli" | "test";

export interface IncompleteRun {
  runtime: string;
  pid: number;
  startedAt: number;
  /** "running": the process died or was killed; "incomplete": shutdown ran but did not drain. */
  state: "running" | "incomplete";
}

/** One `maintenance_state` value, or `null`. */
export function getMaintenanceStateValue(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM maintenance_state WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

function listMaintenanceState(
  db: Database.Database,
  prefix: string,
): Array<{ key: string; value: string }> {
  return db
    .prepare("SELECT key, value FROM maintenance_state WHERE key LIKE ?")
    .all(`${prefix}%`) as Array<{ key: string; value: string }>;
}

function deleteMaintenanceState(db: Database.Database, keys: string[]): void {
  if (keys.length === 0) return;
  db.prepare("DELETE FROM maintenance_state WHERE key IN (SELECT value FROM json_each(?))").run(
    JSON.stringify(keys),
  );
}

const RUN_KEY_PREFIX = "runtime_run:";
const LAST_INCOMPLETE_KEY = "last_incomplete_shutdown";

/**
 * Record this run and collect earlier runs that never finished a clean shutdown: their
 * process is gone but their record remains. Those records are cleared and the latest is
 * kept under `last_incomplete_shutdown` for diagnostics. Requires `maintenance_state`.
 */
export function beginRuntimeRun(
  db: Database.Database,
  runtime: RuntimeName,
  options: { pid?: number; now?: number; isProcessAlive?: (pid: number) => boolean } = {},
): IncompleteRun[] {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now();
  const alive = options.isProcessAlive ?? isProcessAlive;
  const host = os.hostname();
  return db
    .transaction(() => {
      const incomplete: IncompleteRun[] = [];
      const finished: string[] = [];
      for (const row of listMaintenanceState(db, RUN_KEY_PREFIX)) {
        let record: {
          runtime: string;
          pid: number;
          host: string;
          startedAt: number;
          state: string;
        };
        try {
          record = JSON.parse(row.value);
        } catch {
          finished.push(row.key);
          continue;
        }
        const finishedBadly = record.state === "incomplete";
        const gone = record.host === host && !alive(record.pid);
        if (!finishedBadly && !gone) continue;
        incomplete.push({
          runtime: record.runtime,
          pid: record.pid,
          startedAt: record.startedAt,
          state: finishedBadly ? "incomplete" : "running",
        });
        finished.push(row.key);
      }
      deleteMaintenanceState(db, finished);
      if (incomplete.length > 0) {
        setMaintenanceStateValue(
          db,
          LAST_INCOMPLETE_KEY,
          JSON.stringify({ detectedAt: now, runs: incomplete }),
        );
      }
      setMaintenanceStateValue(
        db,
        `${RUN_KEY_PREFIX}${runtime}:${pid}`,
        JSON.stringify({ runtime, pid, host, startedAt: now, state: "running" }),
      );
      return incomplete;
    })
    .immediate();
}

/**
 * Close this run's record: removed after a clean shutdown, marked incomplete otherwise so
 * the next start reports it.
 */
export function endRuntimeRun(
  db: Database.Database,
  runtime: RuntimeName,
  options: { clean: boolean; pid?: number; now?: number },
): void {
  const key = `${RUN_KEY_PREFIX}${runtime}:${options.pid ?? process.pid}`;
  if (options.clean) {
    deleteMaintenanceState(db, [key]);
    return;
  }
  const now = options.now ?? Date.now();
  const stored = getMaintenanceStateValue(db, key);
  const record = stored ? JSON.parse(stored) : { runtime, pid: options.pid ?? process.pid };
  setMaintenanceStateValue(
    db,
    key,
    JSON.stringify({ ...record, state: "incomplete", endedAt: now }),
  );
}

/**
 * A PASSIVE checkpoint: copies what it can without waiting for readers or writers, so it
 * never blocks shutdown. A busy result only means the WAL keeps some frames; committed
 * data is in the WAL either way.
 */
export function checkpointBounded(db: Database.Database): {
  busy: boolean;
  logFrames: number;
  checkpointedFrames: number;
} {
  const [row] = db.pragma("wal_checkpoint(PASSIVE)") as Array<{
    busy: number;
    log: number;
    checkpointed: number;
  }>;
  return {
    busy: Boolean(row?.busy),
    logFrames: Number(row?.log ?? 0),
    checkpointedFrames: Number(row?.checkpointed ?? 0),
  };
}

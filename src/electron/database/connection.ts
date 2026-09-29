import type Database from "better-sqlite3";
import path from "path";

/**
 * Connection setup shared by the host `DatabaseManager` and the database worker
 * (async SQLite migration plan, DB2). Kept free of Electron and settings imports so
 * the worker can load it.
 */

export const DATABASE_FILE_NAME = "cowork-os.db";

/** Busy timeout for the host connection, which has no scheduler to retry lock conflicts. */
export const HOST_BUSY_TIMEOUT_MS = 5_000;

export function resolveDatabasePath(userDataDir: string): string {
  return path.join(userDataDir, DATABASE_FILE_NAME);
}

/**
 * Apply the connection-local settings every writable connection needs. Pragmas are
 * per connection, so a worker must call this for its own handle.
 */
export function applyConnectionPragmas(
  db: Database.Database,
  options: { busyTimeoutMs: number },
): void {
  // The lock wait first (DB6): switching the journal mode needs a lock, and without a
  // busy timeout a second process opening the profile at the same moment fails at once
  // with SQLITE_BUSY instead of waiting.
  db.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))}`);
  db.pragma("journal_mode = WAL");
  // Explicit durability level (async SQLite plan, decision 9). Without it the level
  // depends on history: FULL for the run that creates the database, NORMAL afterwards.
  // NORMAL in WAL mode survives process crashes; power loss can drop the latest commits.
  db.pragma("synchronous = NORMAL");
}

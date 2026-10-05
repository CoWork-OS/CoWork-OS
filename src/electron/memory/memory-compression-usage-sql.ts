import type Database from "better-sqlite3";
import { defineUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import { fields, int, nullableStr } from "../database/statements/unit-args";

/**
 * Token ledger of the AI memory compression (audit DATA-7): one row per model call with
 * the tokens it used, so the daily budget holds across restarts and between the desktop
 * app and the node daemon. Rows carry no memory text. Rows older than a week are pruned
 * on every write.
 */

const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function ensureLedger(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_compression_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT,
      used_at INTEGER NOT NULL,
      tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_compression_usage_used_at
      ON memory_compression_usage(used_at);
  `);
}

export function compressionTokensSince(db: Database.Database, since: number): number {
  ensureLedger(db);
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(tokens), 0) AS total FROM memory_compression_usage WHERE used_at >= ?",
    )
    .get(since) as { total?: number } | undefined;
  const total = Number(row?.total || 0);
  return Number.isFinite(total) ? total : 0;
}

export function recordCompressionUsage(
  db: Database.Database,
  entry: { workspaceId: string | null; usedAt: number; tokens: number },
): void {
  ensureLedger(db);
  db.prepare(
    "INSERT INTO memory_compression_usage (workspace_id, used_at, tokens) VALUES (?, ?, ?)",
  ).run(entry.workspaceId, entry.usedAt, entry.tokens);
  db.prepare("DELETE FROM memory_compression_usage WHERE used_at < ?").run(
    entry.usedAt - LEDGER_RETENTION_MS,
  );
}

export const MEMORY_COMPRESSION_USAGE_UNITS = {
  // Not read-only: the first read creates the ledger table.
  memoryCompression_tokensSince: defineUnit(
    fields({ since: (value: unknown, path: string) => int(value, path) }),
    (db: Database.Database, args) => compressionTokensSince(db, args.since),
  ),
  memoryCompression_recordUsage: defineUnit(
    fields({
      workspaceId: (value: unknown, path: string) => nullableStr(value, path, 200),
      usedAt: (value: unknown, path: string) => int(value, path),
      tokens: (value: unknown, path: string) => int(value, path, 0, 10_000_000),
    }),
    (db: Database.Database, args) => recordCompressionUsage(db, args),
  ),
} satisfies UnitCatalog;

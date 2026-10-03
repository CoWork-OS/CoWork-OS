import type Database from "better-sqlite3";
import { MAX_PRUNE_BATCH_SIZE, PRUNE_TASK_EVENTS_BATCH_SQL } from "../maintenance-sql";
import { InvalidCommandArgumentsError } from "./command-errors";
import type { DatabaseCommandKind } from "./protocol";
import { TIMELINE_COMMANDS } from "./timeline-commands";
import { USAGE_COMMANDS } from "./usage-commands";
import { SETTINGS_COMMANDS } from "./settings-commands";
import { STATEMENT_COMMANDS } from "./statement-commands";
import {
  backfillTaskRunDurationsChunk,
  CONTROL_PLANE_ORPHAN_REPAIRS,
  deleteOrphanTaskEventsChunk,
  MAX_MAINTENANCE_CHUNK,
  repairControlPlaneOrphan,
  sanitizeLargeTaskEventPayloadsRange,
  setMaintenanceStateValue,
} from "../post-startup-maintenance";
import {
  type CapturedMemoryResult,
  type CapturedMemoryWrite,
  insertCapturedMemory,
} from "../../memory/memory-capture-sql";
import {
  MAX_EMBEDDING_UPSERT_ROWS,
  type MemoryEmbeddingRow,
  upsertMemoryEmbeddingRows,
} from "../memory-embedding-sql";
import {
  getSqliteInstrumentationSnapshot,
  type SqliteInstrumentationSnapshot,
} from "../sqlite-instrumentation";

/**
 * Commands the database worker can run (async SQLite migration plan, DB2). Each one
 * validates its own arguments and has bounded cost by construction, because a running
 * statement cannot be interrupted (decision 8). Write commands run inside an IMMEDIATE
 * transaction opened by the worker; they must not call the host, network, or timers.
 */
export interface DatabaseCommandDefinition<Args, Result> {
  kind: DatabaseCommandKind;
  /** Tables the command touches; the worker refuses to start if any is missing. */
  tables: readonly string[];
  run(db: Database.Database, args: Args): Result;
}

export { InvalidCommandArgumentsError };

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidCommandArgumentsError(`${name} must be a finite number`);
  }
  return value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCommandArgumentsError("arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requireIntegerInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidCommandArgumentsError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireEmbeddingRows(value: unknown): MemoryEmbeddingRow[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EMBEDDING_UPSERT_ROWS) {
    throw new InvalidCommandArgumentsError(
      `rows must be a non-empty array of at most ${MAX_EMBEDDING_UPSERT_ROWS} embeddings`,
    );
  }
  return value.map((raw) => {
    const row = requireObject(raw);
    if (
      typeof row.memoryId !== "string" ||
      !row.memoryId ||
      typeof row.workspaceId !== "string" ||
      !row.workspaceId ||
      typeof row.updatedAt !== "number" ||
      !Number.isFinite(row.updatedAt) ||
      !Array.isArray(row.embedding) ||
      row.embedding.length === 0 ||
      row.embedding.length > 4_096 ||
      !row.embedding.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new InvalidCommandArgumentsError(
        "each row needs memoryId, workspaceId, a finite updatedAt and a numeric embedding",
      );
    }
    return {
      memoryId: row.memoryId,
      workspaceId: row.workspaceId,
      updatedAt: row.updatedAt,
      embedding: row.embedding as number[],
    };
  });
}

const MAX_MEMORY_CONTENT_CHARS = 64 * 1024;

function requireText(value: unknown, name: string, max: number, optional = false): string | null {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || (!optional && value.length === 0) || value.length > max) {
    throw new InvalidCommandArgumentsError(`${name} must be a string of at most ${max} chars`);
  }
  return value;
}

function requireFinite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidCommandArgumentsError(`${name} must be a finite number`);
  }
  return value;
}

function requireCapturedMemory(raw: unknown): CapturedMemoryWrite {
  const write = requireObject(raw);
  const memory = requireObject(write.memory);
  const result: CapturedMemoryWrite = {
    memory: {
      id: requireText(memory.id, "memory.id", 128) as string,
      workspaceId: requireText(memory.workspaceId, "memory.workspaceId", 128) as string,
      taskId: requireText(memory.taskId, "memory.taskId", 128, true),
      type: requireText(memory.type, "memory.type", 64) as string,
      content: requireText(memory.content, "memory.content", MAX_MEMORY_CONTENT_CHARS) as string,
      summary: requireText(memory.summary, "memory.summary", MAX_MEMORY_CONTENT_CHARS, true),
      tokens: requireFinite(memory.tokens, "memory.tokens"),
      isCompressed: memory.isCompressed === true,
      isPrivate: memory.isPrivate === true,
      createdAt: requireFinite(memory.createdAt, "memory.createdAt"),
      updatedAt: requireFinite(memory.updatedAt, "memory.updatedAt"),
    },
  };
  if (write.embedding !== undefined) {
    const embedding = requireObject(write.embedding);
    const values = embedding.values;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 4_096 ||
      !values.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new InvalidCommandArgumentsError("embedding.values must be a numeric vector");
    }
    result.embedding = {
      values: values as number[],
      updatedAt: requireFinite(embedding.updatedAt, "embedding.updatedAt"),
    };
  }
  if (write.observation !== undefined) {
    const observation = requireObject(write.observation);
    if (observation.memoryId !== result.memory.id) {
      throw new InvalidCommandArgumentsError("observation.memoryId must match the memory");
    }
    result.observation = observation as unknown as CapturedMemoryWrite["observation"];
  }
  if (write.dedupe !== undefined) {
    const dedupe = requireObject(write.dedupe);
    result.dedupe = {
      contentHash: requireText(dedupe.contentHash, "dedupe.contentHash", 128) as string,
      since: requireFinite(dedupe.since, "dedupe.since"),
    };
  }
  return result;
}

const MAINTENANCE_STATE_KEY_PATTERN = /^[a-z0-9_.:-]{1,128}$/;

export interface PruneTaskEventsBatchArgs {
  /** Events of terminal tasks created before this epoch-ms cutoff are deleted. */
  cutoff: number;
  batchSize: number;
}

export interface StorageStats {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  freelistBytes: number;
}

function pragmaNumber(db: Database.Database, name: string): number {
  const value = db.pragma(name, { simple: true });
  return typeof value === "number" ? value : Number(value) || 0;
}

export const DATABASE_COMMANDS = {
  /** One bounded, idempotent pruning batch; callers repeat until `deleted < batchSize`. */
  "maintenance.pruneTaskEventsBatch": {
    kind: "write",
    tables: ["tasks", "task_events"],
    run(db: Database.Database, rawArgs: PruneTaskEventsBatchArgs): { deleted: number } {
      const args = requireObject(rawArgs);
      const cutoff = requireFiniteNumber(args.cutoff, "cutoff");
      const batchSize = Math.floor(requireFiniteNumber(args.batchSize, "batchSize"));
      if (batchSize < 1 || batchSize > MAX_PRUNE_BATCH_SIZE) {
        throw new InvalidCommandArgumentsError(
          `batchSize must be between 1 and ${MAX_PRUNE_BATCH_SIZE}`,
        );
      }
      return { deleted: db.prepare(PRUNE_TASK_EVENTS_BATCH_SQL).run(cutoff, batchSize).changes };
    },
  },
  /** Page and freelist sizes, used to decide whether an idle-window VACUUM is due. */
  "maintenance.storageStats": {
    kind: "read",
    tables: [],
    run(db: Database.Database): StorageStats {
      const pageSize = pragmaNumber(db, "page_size");
      const freelistCount = pragmaNumber(db, "freelist_count");
      return {
        pageSize,
        pageCount: pragmaNumber(db, "page_count"),
        freelistCount,
        freelistBytes: pageSize * freelistCount,
      };
    },
  },
  /** The worker connection's statement timings (DB0 instrumentation), optionally resetting them. */
  "diagnostics.sqliteSnapshot": {
    kind: "read",
    tables: [],
    run(
      _db: Database.Database,
      args?: { reset?: boolean; topLabels?: number },
    ): SqliteInstrumentationSnapshot {
      return getSqliteInstrumentationSnapshot({
        reset: args?.reset === true,
        topLabels: Math.min(100, Math.max(0, Math.floor(Number(args?.topLabels ?? 20)))),
      });
    },
  },
  /** Post-startup maintenance chunks (DB4); see post-startup-maintenance.ts. */
  "maintenance.backfillRunDurationsChunk": {
    kind: "write",
    tables: ["tasks", "task_events"],
    run(db: Database.Database, rawArgs: { limit: number }): { updated: number; done: boolean } {
      const args = requireObject(rawArgs);
      return backfillTaskRunDurationsChunk(
        db,
        requireIntegerInRange(args.limit, "limit", 1, MAX_MAINTENANCE_CHUNK),
      );
    },
  },
  "maintenance.sanitizePayloadsRange": {
    kind: "write",
    tables: ["task_events"],
    run(
      db: Database.Database,
      rawArgs: { afterRowid: number; span: number },
    ): { updated: number; nextRowid: number; done: boolean } {
      const args = requireObject(rawArgs);
      return sanitizeLargeTaskEventPayloadsRange(
        db,
        requireIntegerInRange(args.afterRowid, "afterRowid", 0, Number.MAX_SAFE_INTEGER),
        requireIntegerInRange(args.span, "span", 1, MAX_MAINTENANCE_CHUNK),
      );
    },
  },
  "maintenance.setState": {
    kind: "write",
    tables: ["maintenance_state"],
    run(db: Database.Database, rawArgs: { key: string; value: string }): { ok: true } {
      const args = requireObject(rawArgs);
      if (typeof args.key !== "string" || !MAINTENANCE_STATE_KEY_PATTERN.test(args.key)) {
        throw new InvalidCommandArgumentsError("key must be a short lowercase identifier");
      }
      if (typeof args.value !== "string" || args.value.length > 1_024) {
        throw new InvalidCommandArgumentsError("value must be a string of at most 1024 chars");
      }
      setMaintenanceStateValue(db, args.key, args.value);
      return { ok: true };
    },
  },
  "maintenance.repairOrphan": {
    kind: "write",
    // Each repair skips itself when one of its tables is missing.
    tables: [],
    run(
      db: Database.Database,
      rawArgs: { index: number },
    ): { label: string; changes: number; done: boolean } {
      const args = requireObject(rawArgs);
      return repairControlPlaneOrphan(
        db,
        requireIntegerInRange(args.index, "index", 0, CONTROL_PLANE_ORPHAN_REPAIRS.length - 1),
      );
    },
  },
  "maintenance.deleteOrphanTaskEventsChunk": {
    kind: "write",
    tables: ["tasks", "task_events"],
    run(
      db: Database.Database,
      rawArgs: { afterRowid: number; limit: number },
    ): { deleted: number; nextRowid: number; done: boolean } {
      const args = requireObject(rawArgs);
      return deleteOrphanTaskEventsChunk(
        db,
        requireIntegerInRange(args.afterRowid, "afterRowid", 0, Number.MAX_SAFE_INTEGER),
        requireIntegerInRange(args.limit, "limit", 1, MAX_MAINTENANCE_CHUNK),
      );
    },
  },
  /**
   * A memory-embedding backfill batch (DB4). Rows whose memory moved on are skipped;
   * returns the ids written, which the host must also report to the FTS worker's cache
   * because this write bypasses the repository's change notification.
   */
  "memory.upsertEmbeddings": {
    kind: "write",
    tables: ["memories", "memory_embeddings"],
    run(db: Database.Database, rawArgs: { rows: MemoryEmbeddingRow[] }): { written: string[] } {
      const rows = requireEmbeddingRows(requireObject(rawArgs).rows);
      return { written: upsertMemoryEmbeddingRows(db, rows, { ifCurrent: true }) };
    },
  },
  /**
   * One memory capture (DB6): the memory row, its embedding and its observation in one
   * transaction. The host computed every value; worker writes bypass the repositories'
   * change notifications, so the host also reports the new embedding to the FTS worker.
   */
  "memory.capture": {
    kind: "write",
    tables: ["memories", "memory_embeddings", "memory_observation_metadata"],
    run(db: Database.Database, rawArgs: { write: CapturedMemoryWrite }): CapturedMemoryResult {
      return insertCapturedMemory(db, requireCapturedMemory(requireObject(rawArgs).write));
    },
  },
  ...TIMELINE_COMMANDS,
  ...USAGE_COMMANDS,
  ...SETTINGS_COMMANDS,
  ...STATEMENT_COMMANDS,
} satisfies Record<string, DatabaseCommandDefinition<never, unknown>>;

export type DatabaseCommandName = keyof typeof DATABASE_COMMANDS;
export type DatabaseCommandArgs<Name extends DatabaseCommandName> = Parameters<
  (typeof DATABASE_COMMANDS)[Name]["run"]
>[1];
export type DatabaseCommandResult<Name extends DatabaseCommandName> = ReturnType<
  (typeof DATABASE_COMMANDS)[Name]["run"]
>;

export function requiredTablesFor(
  commands: Record<string, { tables: readonly string[] }>,
): string[] {
  return [...new Set(Object.values(commands).flatMap((command) => command.tables))].sort();
}

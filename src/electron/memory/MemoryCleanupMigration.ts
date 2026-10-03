/**
 * One-time cleanup of the memory archive (audit DATA-1, DATA-2, SEC follow-ups).
 *
 * Runs once per profile database, off the startup hot path (MemoryService schedules it
 * after initialization), and records a marker in `maintenance_state` so it never runs
 * again. Every phase is idempotent, so an interrupted run is simply repeated.
 *
 *   (a) delete archive rows that are raw task telemetry ("Tool called:", "Tool result
 *       for ", "Step started:", "Step completed:", raw plan / step JSON payloads), with
 *       their embeddings and observation metadata (FTS rows go via the delete triggers);
 *   (b) collapse exact duplicates (same workspace, type and content), keeping the oldest
 *       row and adding the collapsed rows' references to it;
 *   (c) redact secret values left in stored content, summaries and observation text;
 *   (d) neutralize a spoofed `[Imported from …]` prefix on rows that were written by a
 *       non-import capture (observation `generated_by = 'capture'` with an origin other
 *       than `import`). Rows without such provenance are ambiguous and left alone;
 *   (e) delete embeddings and observation metadata whose memory no longer exists.
 *
 * Rows that retention protects (imports, Playbook rows, explicit saves, curated
 * promotions) are never deleted by (a) or (b); rows referenced by Playbook evidence or a
 * Box Brain item are never collapsed by (b).
 */

import type Database from "better-sqlite3";
import { createMemoryStatementPort } from "./memory-statement-port";
import { withMaintenanceClaim } from "./maintenance-claim-sql";
import {
  MEMORY_CLEANUP_MIGRATION_KEY,
  MEMORY_CLEANUP_PHASES,
  emptyMemoryCleanupCounts,
  type MemoryCleanupCounts,
} from "./memory-cleanup-sql";

export {
  MEMORY_CLEANUP_MIGRATION_KEY,
  RAW_TELEMETRY_CONTENT_PATTERNS,
  type MemoryCleanupCounts,
} from "./memory-cleanup-sql";

export interface MemoryCleanupResult {
  ran: boolean;
  counts: MemoryCleanupCounts;
  /** Workspaces whose rows changed, so callers can drop their caches. */
  workspaceIds: string[];
  /** Memories deleted or rewritten. */
  memoryIds: string[];
}

export interface MemoryCleanupOptions {
  /** Yield between phases (to the event loop) so a large archive does not block. */
  yieldBetweenPhases?: () => Promise<void>;
}

/**
 * Run the cleanup once. Returns `ran: false` (and changes nothing) when the marker
 * already exists or the database has no memories table.
 *
 * The SQL lives in memory-cleanup-sql.ts; each phase runs as a memory-domain transaction
 * unit through the memory statement port (in the database worker when memory is routed
 * there).
 */
export async function runMemoryCleanupMigration(
  db: Database.Database,
  options: MemoryCleanupOptions = {},
): Promise<MemoryCleanupResult> {
  const sql = createMemoryStatementPort(db);
  const counts = emptyMemoryCleanupCounts();
  const notRun: MemoryCleanupResult = { ran: false, counts, workspaceIds: [], memoryIds: [] };
  if (!(await sql.unit("memoryCleanup_pending", {}))) return notRun;
  // The desktop app and the node daemon may share the profile: only the process that
  // claims the run executes it (the claim re-checks the marker atomically).
  const result = await withMaintenanceClaim(sql, MEMORY_CLEANUP_MIGRATION_KEY, () =>
    runCleanupPhases(sql, counts, options),
  );
  return result ?? notRun;
}

async function runCleanupPhases(
  sql: ReturnType<typeof createMemoryStatementPort>,
  counts: MemoryCleanupCounts,
  options: MemoryCleanupOptions,
): Promise<MemoryCleanupResult> {
  const workspaceIds = new Set<string>();
  const memoryIds = new Set<string>();
  const pause = options.yieldBetweenPhases ?? (async () => undefined);
  for (const [index, phase] of MEMORY_CLEANUP_PHASES.entries()) {
    if (index > 0) await pause();
    const result = await sql.unit("memoryCleanup_phase", { phase, now: Date.now() });
    for (const key of Object.keys(counts) as Array<keyof MemoryCleanupCounts>) {
      counts[key] += result.counts[key];
    }
    for (const id of result.workspaceIds) workspaceIds.add(id);
    for (const id of result.memoryIds) memoryIds.add(id);
  }

  await sql.unit("memoryCleanup_complete", { counts, now: Date.now() });

  return {
    ran: true,
    counts,
    workspaceIds: [...workspaceIds],
    memoryIds: [...memoryIds],
  };
}

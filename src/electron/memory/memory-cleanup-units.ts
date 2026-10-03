import type Database from "better-sqlite3";
import { defineUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import { int, oneOf, record } from "../database/statements/unit-args";
import {
  MEMORY_CLEANUP_PHASES,
  type MemoryCleanupCounts,
  isMemoryCleanupMigrationPending,
  recordMemoryCleanupMigration,
  runMemoryCleanupPhase,
} from "./memory-cleanup-sql";

/**
 * Units of the one-time memory archive cleanup (MemoryCleanupMigration.ts), part of the
 * memory domain. Each phase is one unit, so the caller can yield between phases.
 */

const COUNT_KEYS = [
  "telemetryDeleted",
  "duplicatesCollapsed",
  "memoriesRedacted",
  "observationsRedacted",
  "importPrefixesNeutralized",
  "orphanEmbeddingsDeleted",
  "orphanObservationsDeleted",
] as const satisfies ReadonlyArray<keyof MemoryCleanupCounts>;

function cleanupCounts(value: unknown, path: string): MemoryCleanupCounts {
  const input = record(value, path);
  const counts = {} as MemoryCleanupCounts;
  for (const key of COUNT_KEYS) counts[key] = int(input[key], `${path}.${key}`);
  return counts;
}

export const MEMORY_CLEANUP_UNITS = {
  // Not read-only: checking the marker creates its table when missing.
  memoryCleanup_pending: defineUnit(
    () => ({}),
    (db: Database.Database) => isMemoryCleanupMigrationPending(db),
  ),
  memoryCleanup_phase: defineUnit(
    (args: unknown) => {
      const input = record(args);
      return {
        phase: oneOf(input.phase, "args.phase", MEMORY_CLEANUP_PHASES),
        now: int(input.now, "args.now"),
      };
    },
    (db: Database.Database, args) => runMemoryCleanupPhase(db, args.phase, args.now),
  ),
  memoryCleanup_complete: defineUnit(
    (args: unknown) => {
      const input = record(args);
      return {
        counts: cleanupCounts(input.counts, "args.counts"),
        now: int(input.now, "args.now"),
      };
    },
    (db: Database.Database, args) => recordMemoryCleanupMigration(db, args.counts, args.now),
  ),
} satisfies UnitCatalog;

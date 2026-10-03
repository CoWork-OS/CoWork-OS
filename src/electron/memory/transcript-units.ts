import type Database from "better-sqlite3";
import { defineUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import { bool, int, record } from "../database/statements/unit-args";
import {
  backfillSpanIndexWindow,
  finishSpanStorageCleanup,
  rewriteSpanStorageWindow,
  startSpanStorageCleanup,
} from "./transcript-sql";

/**
 * Units of the one-time transcript span storage cleanup (TranscriptStore.runStorageCleanup),
 * part of the memory domain. Each step is one unit, so the caller yields between windows.
 */

function window(args: unknown) {
  const input = record(args);
  return {
    lower: int(input.lower, "args.lower"),
    upper: int(input.upper, "args.upper"),
  };
}

export const TRANSCRIPT_UNITS = {
  transcript_storageCleanupStart: defineUnit(
    (args: unknown) => ({ now: int(record(args).now, "args.now") }),
    (db: Database.Database, args) => startSpanStorageCleanup(db, args.now),
  ),
  transcript_storageCleanupRewrite: defineUnit(
    (args: unknown) => ({ ...window(args), now: int(record(args).now, "args.now") }),
    (db: Database.Database, args) => rewriteSpanStorageWindow(db, args.lower, args.upper, args.now),
  ),
  transcript_storageCleanupBackfill: defineUnit(window, (db: Database.Database, args) =>
    backfillSpanIndexWindow(db, args.lower, args.upper),
  ),
  transcript_storageCleanupFinish: defineUnit(
    (args: unknown) => {
      const input = record(args);
      return {
        closeGap: bool(input.closeGap, "args.closeGap"),
        now: int(input.now, "args.now"),
        deletedSnapshotRows: int(input.deletedSnapshotRows, "args.deletedSnapshotRows"),
        rewrittenRows: int(input.rewrittenRows, "args.rewrittenRows"),
        reclaimedChars: int(input.reclaimedChars, "args.reclaimedChars"),
      };
    },
    (db: Database.Database, args) => finishSpanStorageCleanup(db, args),
  ),
} satisfies UnitCatalog;

import type Database from "better-sqlite3";
import { defineUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import { int, record } from "../database/statements/unit-args";
import { KNOWLEDGE_GRAPH_UNITS } from "../knowledge-graph/knowledge-graph-units";
import { PLAYBOOK_EVIDENCE_UNITS } from "./playbook-evidence-units";
import { DREAMING_UNITS } from "./dreaming-units";
import { BOX_BRAIN_UNITS } from "./box-brain-units";
import { MEMORY_OBSERVATION_UNITS } from "./memory-observation-units";
import { DURABLE_CONTEXT_UNITS } from "./durable-context-units";
import { MARKDOWN_INDEX_UNITS } from "./markdown-index-units";
import { MEMORY_CLEANUP_UNITS } from "./memory-cleanup-units";
import { TRANSCRIPT_UNITS } from "./transcript-units";

/**
 * Transaction units of the memory domain (async SQLite migration plan, DB6): each runs
 * its statements in one IMMEDIATE transaction, on the host or in the database worker.
 * Units take validated arguments, use only the connection they are given, and never
 * call the keychain, the network or a timer.
 */

export interface PromotionPassResult {
  promoted: number;
  evicted: number;
}

/**
 * Tier promotion only. There is no tier-based expiry (audit DATA-1): a hidden 7-day TTL
 * on `short` rows used to override the workspace's `retention_days`. Retention and the
 * storage cap (MemoryService.runCleanup) are now the only paths that remove rows, and
 * they never remove imported, Playbook, explicitly saved or curated rows.
 */
const tierPromotionPass = defineUnit(
  (args: unknown) => {
    const input = record(args);
    return {
      shortToMediumAt: int(input.shortToMediumAt, "args.shortToMediumAt"),
      mediumToLongAt: int(input.mediumToLongAt, "args.mediumToLongAt"),
    };
  },
  (db: Database.Database, args): PromotionPassResult => {
    const promotedShort = db
      .prepare(
        `UPDATE memories SET tier = 'medium'
         WHERE COALESCE(tier, 'short') = 'short' AND COALESCE(reference_count, 0) >= ?`,
      )
      .run(args.shortToMediumAt).changes;
    const promotedMedium = db
      .prepare(
        `UPDATE memories SET tier = 'long'
         WHERE COALESCE(tier, 'short') = 'medium' AND COALESCE(reference_count, 0) >= ?`,
      )
      .run(args.mediumToLongAt).changes;
    return { promoted: promotedShort + promotedMedium, evicted: 0 };
  },
);

export const MEMORY_UNITS = {
  ...KNOWLEDGE_GRAPH_UNITS,
  ...PLAYBOOK_EVIDENCE_UNITS,
  ...DREAMING_UNITS,
  ...BOX_BRAIN_UNITS,
  ...MEMORY_OBSERVATION_UNITS,
  ...DURABLE_CONTEXT_UNITS,
  ...MARKDOWN_INDEX_UNITS,
  ...MEMORY_CLEANUP_UNITS,
  ...TRANSCRIPT_UNITS,
  tier_promotionPass: tierPromotionPass,
} satisfies UnitCatalog;

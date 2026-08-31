/**
 * Memory Tier Service
 *
 * Manages three-tier memory promotion and TTL-based eviction.
 *
 * Tiers:
 *   short  → new memories; evicted after 7 days if reference_count < 2
 *   medium → promoted when reference_count >= 3
 *   long   → promoted when reference_count >= 10 (never auto-evicted)
 *
 * Usage:
 *   Call MemoryTierService.recordReference(db, memoryId) whenever a memory
 *   is returned from search results.
 *
 *   Call MemoryTierService.runPromotionPass(db) periodically (e.g., from
 *   MemoryService's cleanup interval) to promote/evict memories.
 */

import Database from "better-sqlite3";
import type { MemoryTier } from "../../shared/types";
import { createLogger } from "../utils/logger";

const logger = createLogger("MemoryTierService");

export interface TierPromotionRule {
  fromTier: MemoryTier;
  toTier: MemoryTier;
  minReferenceCount: number;
}

export interface PromotionPassResult {
  promoted: number;
  evicted: number;
}

/** Days before a short-tier memory is evicted if underreferenced */
const SHORT_TIER_TTL_DAYS = 7;
/** Minimum references required to avoid short-tier eviction */
const SHORT_TIER_EVICTION_THRESHOLD = 2;

export class MemoryTierService {
  static readonly PROMOTION_RULES: TierPromotionRule[] = [
    { fromTier: "short", toTier: "medium", minReferenceCount: 3 },
    { fromTier: "medium", toTier: "long", minReferenceCount: 10 },
  ];

  /**
   * Record that a memory was accessed (returned from search).
   * Increments reference_count and updates last_referenced_at.
   */
  static recordReference(db: Database.Database, memoryId: string): void {
    try {
      db.prepare(
        `UPDATE memories
         SET reference_count = COALESCE(reference_count, 0) + 1,
             last_referenced_at = ?
         WHERE id = ?`,
      ).run(Date.now(), memoryId);
    } catch (err) {
      // Non-fatal: column may not exist in very old schemas
      logger.warn("[MemoryTierService] recordReference failed:", err);
    }
  }

  /**
   * Batch variant — single UPDATE instead of N round-trips.
   */
  static recordReferenceBatch(db: Database.Database, memoryIds: string[]): void {
    if (memoryIds.length === 0) return;
    try {
      const placeholders = memoryIds.map(() => "?").join(", ");
      db.prepare(
        `UPDATE memories
         SET reference_count = COALESCE(reference_count, 0) + 1,
             last_referenced_at = ?
         WHERE id IN (${placeholders})`,
      ).run(Date.now(), ...memoryIds);
    } catch (err) {
      logger.warn("[MemoryTierService] recordReferenceBatch failed:", err);
    }
  }

  /**
   * Run a full promotion + eviction pass across all memories.
   * Intended to be called from MemoryService's hourly cleanup interval.
   */
  static runPromotionPass(db: Database.Database): PromotionPassResult {
    let promoted = 0;
    let evicted = 0;

    try {
      // Promote short → medium
      const shortToMedium = db
        .prepare(
          `UPDATE memories
           SET tier = 'medium'
           WHERE COALESCE(tier, 'short') = 'short'
             AND COALESCE(reference_count, 0) >= ?`,
        )
        .run(this.PROMOTION_RULES[0].minReferenceCount);
      promoted += shortToMedium.changes;

      // Promote medium → long
      const mediumToLong = db
        .prepare(
          `UPDATE memories
           SET tier = 'long'
           WHERE COALESCE(tier, 'short') = 'medium'
             AND COALESCE(reference_count, 0) >= ?`,
        )
        .run(this.PROMOTION_RULES[1].minReferenceCount);
      promoted += mediumToLong.changes;

      // Evict stale short-tier memories older than TTL with low reference count
      const cutoff = Date.now() - SHORT_TIER_TTL_DAYS * 24 * 60 * 60 * 1000;
      // Delete child rows first to avoid FK constraint violation (memory_embeddings references memories)
      db.prepare(
        `DELETE FROM memory_embeddings
         WHERE memory_id IN (
           SELECT id FROM memories
           WHERE COALESCE(tier, 'short') = 'short'
             AND created_at < ?
             AND COALESCE(reference_count, 0) < ?
         )`,
      ).run(cutoff, SHORT_TIER_EVICTION_THRESHOLD);
      const evictResult = db
        .prepare(
          `DELETE FROM memories
           WHERE COALESCE(tier, 'short') = 'short'
             AND created_at < ?
             AND COALESCE(reference_count, 0) < ?`,
        )
        .run(cutoff, SHORT_TIER_EVICTION_THRESHOLD);
      evicted += evictResult.changes;
    } catch (err) {
      logger.warn("[MemoryTierService] Promotion pass failed:", err);
    }

    if (promoted > 0 || evicted > 0) {
      logger.info(`[MemoryTierService] Promotion pass: promoted=${promoted}, evicted=${evicted}`);
    }

    return { promoted, evicted };
  }

  /**
   * Query memories by tier for a given workspace.
   */
  static getByTier(
    db: Database.Database,
    workspaceId: string,
    tier: MemoryTier,
    limit = 100,
  ): Array<{ id: string; content: string; referenceCount: number; createdAt: number }> {
    try {
      return (
        db
          .prepare(
            `SELECT id, content, COALESCE(reference_count, 0) AS reference_count, created_at
             FROM memories
             WHERE workspace_id = ?
               AND COALESCE(tier, 'short') = ?
             ORDER BY reference_count DESC, created_at DESC
             LIMIT ?`,
          )
          .all(workspaceId, tier, limit) as Array<{
          id: string;
          content: string;
          reference_count: number;
          created_at: number;
        }>
      ).map((row) => ({
        id: row.id,
        content: row.content,
        referenceCount: row.reference_count,
        createdAt: row.created_at,
      }));
    } catch {
      return [];
    }
  }
}

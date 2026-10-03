/**
 * Memory Tier Service
 *
 * Manages three-tier memory promotion. Tiers never expire rows: removal is governed
 * only by the workspace's `retention_days` and storage cap (MemoryService.runCleanup).
 *
 * Tiers:
 *   short  → new memories
 *   medium → promoted when reference_count >= 3
 *   long   → promoted when reference_count >= 10
 *
 * Usage:
 *   Call MemoryTierService.recordReference(sql, memoryId) whenever a memory
 *   is returned from search results or injected into a prompt.
 *
 *   Call MemoryTierService.runPromotionPass(sql) periodically (e.g., from
 *   MemoryService's cleanup interval) to promote memories.
 *
 *   `sql` is the memory statement port (DB6): the database worker when memory is
 *   routed there, the host connection otherwise.
 */

import type { MemoryTier } from "../../shared/types";
import { createLogger } from "../utils/logger";
import type { MemoryStatementPort } from "./memory-statement-port";
import type { PromotionPassResult } from "./memory-units";

export type { PromotionPassResult } from "./memory-units";

const logger = createLogger("MemoryTierService");

export interface TierPromotionRule {
  fromTier: MemoryTier;
  toTier: MemoryTier;
  minReferenceCount: number;
}

export class MemoryTierService {
  static readonly PROMOTION_RULES: TierPromotionRule[] = [
    { fromTier: "short", toTier: "medium", minReferenceCount: 3 },
    { fromTier: "medium", toTier: "long", minReferenceCount: 10 },
  ];

  /**
   * Record that a memory was accessed (returned from search).
   * Increments reference_count and updates last_referenced_at.
   */
  static async recordReference(sql: MemoryStatementPort, memoryId: string): Promise<void> {
    try {
      await sql.run("tier_recordReference", [Date.now(), memoryId]);
    } catch (err) {
      // Non-fatal: column may not exist in very old schemas
      logger.warn("[MemoryTierService] recordReference failed:", err);
    }
  }

  /**
   * Batch variant — single UPDATE instead of N round-trips.
   */
  static async recordReferenceBatch(sql: MemoryStatementPort, memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    try {
      await sql.run("tier_recordReferenceBatch", [Date.now(), JSON.stringify(memoryIds)]);
    } catch (err) {
      logger.warn("[MemoryTierService] recordReferenceBatch failed:", err);
    }
  }

  /**
   * Run a full promotion pass across all memories, in one transaction. It never deletes
   * (`evicted` is always 0); retention lives in MemoryService.runCleanup.
   * Intended to be called from MemoryService's hourly cleanup interval.
   */
  static async runPromotionPass(sql: MemoryStatementPort): Promise<PromotionPassResult> {
    let result: PromotionPassResult = { promoted: 0, evicted: 0 };
    try {
      result = await sql.unit("tier_promotionPass", {
        shortToMediumAt: this.PROMOTION_RULES[0].minReferenceCount,
        mediumToLongAt: this.PROMOTION_RULES[1].minReferenceCount,
      });
    } catch (err) {
      logger.warn("[MemoryTierService] Promotion pass failed:", err);
    }

    if (result.promoted > 0 || result.evicted > 0) {
      logger.info(
        `[MemoryTierService] Promotion pass: promoted=${result.promoted}, evicted=${result.evicted}`,
      );
    }

    return result;
  }

  /**
   * Query memories by tier for a given workspace.
   */
  static async getByTier(
    sql: MemoryStatementPort,
    workspaceId: string,
    tier: MemoryTier,
    limit = 100,
  ): Promise<Array<{ id: string; content: string; referenceCount: number; createdAt: number }>> {
    try {
      const rows = await sql.all<{
        id: string;
        content: string;
        reference_count: number;
        created_at: number;
      }>("tier_getByTier", [workspaceId, tier, limit]);
      return rows.map((row) => ({
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

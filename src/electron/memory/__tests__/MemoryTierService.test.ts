import { describe, it, expect, beforeEach } from "vitest";
import { MemoryTierService } from "../MemoryTierService";
import type { MemoryTier } from "../../../shared/types";

// Minimal in-memory DB mock for the tier service
function makeDb(rows: Record<string, unknown>[] = []) {
  const store = new Map<string, Record<string, unknown>>(
    rows.map((r) => [r["id"] as string, { ...r }]),
  );

  return {
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        // Normalize whitespace so multi-line SQL matches inline checks
        const sqlLower = sql.toLowerCase().replace(/\s+/g, " ");
        if (sqlLower.includes("update memories") && sqlLower.includes("last_referenced_at")) {
          const id = args[1] as string;
          const row = store.get(id);
          if (row) {
            row["reference_count"] = ((row["reference_count"] as number) ?? 0) + 1;
            row["last_referenced_at"] = args[0];
            return { changes: 1 };
          }
          return { changes: 0 };
        } else if (sqlLower.includes("update memories") && sqlLower.includes("tier = 'medium'")) {
          const minRef = args[0] as number;
          let changed = 0;
          for (const row of store.values()) {
            if ((row["tier"] ?? "short") === "short" && (row["reference_count"] as number) >= minRef) {
              row["tier"] = "medium";
              changed++;
            }
          }
          return { changes: changed };
        } else if (sqlLower.includes("update memories") && sqlLower.includes("tier = 'long'")) {
          const minRef = args[0] as number;
          let changed = 0;
          for (const row of store.values()) {
            if ((row["tier"] ?? "short") === "medium" && (row["reference_count"] as number) >= minRef) {
              row["tier"] = "long";
              changed++;
            }
          }
          return { changes: changed };
        } else if (sqlLower.includes("delete from memories")) {
          const cutoff = args[0] as number;
          const threshold = args[1] as number;
          let deleted = 0;
          for (const [id, row] of store.entries()) {
            if (
              (row["tier"] ?? "short") === "short" &&
              (row["created_at"] as number) < cutoff &&
              (row["reference_count"] as number) < threshold
            ) {
              store.delete(id);
              deleted++;
            }
          }
          return { changes: deleted };
        }
        return { changes: 0 };
      },
      all: (...args: unknown[]) => {
        const tier = args[1] as MemoryTier;
        return Array.from(store.values()).filter((r) => (r["tier"] ?? "short") === tier);
      },
    }),
    _store: store,
  } as unknown as import("better-sqlite3").Database & { _store: Map<string, Record<string, unknown>> };
}

describe("MemoryTierService", () => {
  describe("recordReference", () => {
    it("increments reference count for an existing memory", () => {
      const db = makeDb([{ id: "m1", tier: "short", reference_count: 2, created_at: Date.now() }]);
      MemoryTierService.recordReference(db, "m1");
      const row = (db as unknown as { _store: Map<string, Record<string, unknown>> })._store.get("m1");
      expect(row?.["reference_count"]).toBe(3);
    });
  });

  describe("PROMOTION_RULES", () => {
    it("has two promotion rules", () => {
      expect(MemoryTierService.PROMOTION_RULES).toHaveLength(2);
    });

    it("promotes short to medium at 3 references", () => {
      expect(MemoryTierService.PROMOTION_RULES[0].fromTier).toBe("short");
      expect(MemoryTierService.PROMOTION_RULES[0].toTier).toBe("medium");
      expect(MemoryTierService.PROMOTION_RULES[0].minReferenceCount).toBe(3);
    });

    it("promotes medium to long at 10 references", () => {
      expect(MemoryTierService.PROMOTION_RULES[1].fromTier).toBe("medium");
      expect(MemoryTierService.PROMOTION_RULES[1].toTier).toBe("long");
      expect(MemoryTierService.PROMOTION_RULES[1].minReferenceCount).toBe(10);
    });
  });

  describe("runPromotionPass", () => {
    it("promotes short-tier memory with high reference count to medium", () => {
      const now = Date.now();
      const db = makeDb([
        { id: "m1", tier: "short", reference_count: 5, created_at: now },
        { id: "m2", tier: "short", reference_count: 1, created_at: now },
      ]);
      const result = MemoryTierService.runPromotionPass(db);
      expect(result.promoted).toBeGreaterThanOrEqual(1);
    });

    it("evicts stale short-tier memory with low reference count", () => {
      const oldDate = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days old
      const db = makeDb([
        { id: "stale", tier: "short", reference_count: 0, created_at: oldDate },
        { id: "fresh", tier: "short", reference_count: 0, created_at: Date.now() },
      ]);
      const result = MemoryTierService.runPromotionPass(db);
      expect(result.evicted).toBe(1);
    });

    it("returns zero counts when no memories match", () => {
      const db = makeDb([]);
      const result = MemoryTierService.runPromotionPass(db);
      expect(result.promoted).toBe(0);
      expect(result.evicted).toBe(0);
    });
  });
});

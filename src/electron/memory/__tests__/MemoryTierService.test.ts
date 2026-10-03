import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryTierService } from "../MemoryTierService";
import { createMemoryStatementPort } from "../memory-statement-port";

type Row = { id: string; tier: string; reference_count: number; created_at: number };

function makeDb(rows: Row[]) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'ws', content TEXT NOT NULL DEFAULT '',
      tier TEXT, reference_count INTEGER, last_referenced_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE memory_embeddings (memory_id TEXT PRIMARY KEY REFERENCES memories(id));
  `);
  const insert = db.prepare(
    "INSERT INTO memories (id, tier, reference_count, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const row of rows) insert.run(row.id, row.tier, row.reference_count, row.created_at);
  const read = (id: string) =>
    db.prepare("SELECT tier, reference_count FROM memories WHERE id = ?").get(id) as
      | { tier: string; reference_count: number }
      | undefined;
  return { db, sql: createMemoryStatementPort(db), read };
}

describe("MemoryTierService", () => {
  describe("recordReference", () => {
    it("increments reference count for an existing memory", async () => {
      const { sql, read } = makeDb([
        { id: "m1", tier: "short", reference_count: 2, created_at: Date.now() },
      ]);
      await MemoryTierService.recordReference(sql, "m1");
      expect(read("m1")?.reference_count).toBe(3);
    });

    it("increments every memory of a batch once", async () => {
      const now = Date.now();
      const { sql, read } = makeDb([
        { id: "m1", tier: "short", reference_count: 0, created_at: now },
        { id: "m2", tier: "short", reference_count: 4, created_at: now },
        { id: "m3", tier: "short", reference_count: 1, created_at: now },
      ]);
      await MemoryTierService.recordReferenceBatch(sql, ["m1", "m2"]);
      expect([read("m1"), read("m2"), read("m3")].map((row) => row?.reference_count)).toEqual([
        1, 5, 1,
      ]);
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
    it("promotes short-tier memory with high reference count to medium", async () => {
      const now = Date.now();
      const { sql, read } = makeDb([
        { id: "m1", tier: "short", reference_count: 5, created_at: now },
        { id: "m2", tier: "short", reference_count: 1, created_at: now },
        { id: "m3", tier: "medium", reference_count: 12, created_at: now },
      ]);
      const result = await MemoryTierService.runPromotionPass(sql);
      expect(result).toEqual({ promoted: 2, evicted: 0 });
      expect([read("m1")?.tier, read("m2")?.tier, read("m3")?.tier]).toEqual([
        "medium",
        "short",
        "long",
      ]);
    });

    it("never evicts: tiers do not expire rows (retention_days governs removal)", async () => {
      const oldDate = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days old
      const { db, sql, read } = makeDb([
        { id: "stale", tier: "short", reference_count: 0, created_at: oldDate },
        { id: "fresh", tier: "short", reference_count: 0, created_at: Date.now() },
      ]);
      db.prepare("INSERT INTO memory_embeddings (memory_id) VALUES ('stale')").run();
      const result = await MemoryTierService.runPromotionPass(sql);
      expect(result.evicted).toBe(0);
      expect(read("stale")).toBeDefined();
      expect(read("fresh")).toBeDefined();
    });

    it("returns zero counts when no memories match", async () => {
      const { sql } = makeDb([]);
      expect(await MemoryTierService.runPromotionPass(sql)).toEqual({ promoted: 0, evicted: 0 });
    });
  });

  it("lists memories of a tier by reference count", async () => {
    const now = Date.now();
    const { sql } = makeDb([
      { id: "a", tier: "medium", reference_count: 3, created_at: now },
      { id: "b", tier: "medium", reference_count: 7, created_at: now },
      { id: "c", tier: "short", reference_count: 9, created_at: now },
    ]);
    const rows = await MemoryTierService.getByTier(sql, "ws", "medium");
    expect(rows.map((row) => [row.id, row.referenceCount])).toEqual([
      ["b", 7],
      ["a", 3],
    ]);
  });
});

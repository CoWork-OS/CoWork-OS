import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureFirstTaskTables } from "../attempt-schema";
import {
  readLocalRealWork,
  recordLocalRealWorkInspection,
  recordLocalRealWorkUseful,
} from "../real-work-state";

describe("local real-work signals", () => {
  it("requires inspection and an explicit useful answer, then detects later-day return", () => {
    const db = new Database(":memory:");
    try {
      ensureFirstTaskTables(db);
      expect(() => recordLocalRealWorkUseful(db, "task-a", 1)).toThrow("Open the task output");
      expect(recordLocalRealWorkInspection(db, "task-a", 1).usefulAt).toBeNull();
      expect(recordLocalRealWorkUseful(db, "task-a", 2).returnUse).toBe(false);
      expect(recordLocalRealWorkUseful(db, "task-a", 3).usefulAt).toBe(2);
      recordLocalRealWorkInspection(db, "task-b", 86_400_001);
      expect(recordLocalRealWorkUseful(db, "task-b", 86_400_002).returnUse).toBe(true);
      expect(readLocalRealWork(db, "task-a").returnUse).toBe(false);
    } finally {
      db.close();
    }
  });
});

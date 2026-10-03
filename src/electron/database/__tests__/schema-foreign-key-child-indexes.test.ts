import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Probe = module.default;
      const probe = new Probe(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("DatabaseManager foreign key child indexes", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-fk-indexes-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes the child side of hot foreign keys so parent deletes do not scan", async () => {
    const { DatabaseManager } = await import("../schema");
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    try {
      const plan = (sql: string) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
          .map((row) => row.detail)
          .join(" ");

      expect(plan("SELECT 1 FROM work_session_items WHERE causal_parent_item_id = 'x'")).toMatch(
        /USING (COVERING )?INDEX/,
      );
      expect(plan("SELECT 1 FROM work_session_evidence WHERE item_id = 'x'")).toMatch(
        /USING (COVERING )?INDEX/,
      );
      expect(plan("SELECT 1 FROM activity_feed WHERE task_id = 'x'")).toMatch(
        /USING (COVERING )?INDEX/,
      );
      expect(plan("SELECT 1 FROM tasks WHERE branch_from_task_id = 'x'")).toMatch(
        /USING (COVERING )?INDEX/,
      );

      // Every foreign key in the schema whose child table is large in practice has an
      // index whose leading column is the child column.
      const unindexed = (
        db
          .prepare(
            `SELECT m.name AS child, f."from" AS col
               FROM sqlite_master m, pragma_foreign_key_list(m.name) f
              WHERE m.type = 'table'
                AND m.name IN ('work_session_items','work_session_constraints','work_session_evidence',
                               'activity_feed','llm_call_events','pending_memory_writes',
                               'heartbeat_runs','work_session_turns','core_failure_cluster_members')
                AND f."table" IN ('tasks','work_session_items','work_session_turns',
                                  'heartbeat_runs','core_failure_records')
                AND NOT EXISTS (
                  SELECT 1 FROM pragma_index_list(m.name) il, pragma_index_info(il.name) ii
                   WHERE ii.seqno = 0 AND ii.name = f."from")
                AND NOT EXISTS (
                  SELECT 1 FROM pragma_table_info(m.name) t WHERE t.pk = 1 AND t.name = f."from")`,
          )
          .all() as Array<{ child: string; col: string }>
      ).map((row) => `${row.child}.${row.col}`);
      expect(unindexed).toEqual([]);
    } finally {
      manager.close();
    }
  });
});

import { createRequire } from "module";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS,
  TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS,
  TranscriptStore,
  boundTranscriptSpanPayload,
} from "../TranscriptStore";
import { setCheckpointSigningKeyForTests } from "../checkpoint-signing";

const require = createRequire(import.meta.url);
const BetterSqlite3 = (() => {
  try {
    const Module = require("better-sqlite3") as typeof import("better-sqlite3");
    new Module(":memory:").close();
    return Module;
  } catch {
    return null;
  }
})();
const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;

const createdDirs: string[] = [];
const databases: Array<import("better-sqlite3").Database> = [];
const originalLockRoot = process.env.COWORK_CHECKPOINT_LOCK_ROOT;
let lockRoot = "";

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-transcript-storage-"));
  createdDirs.push(dir);
  return dir;
}

function openDb(): import("better-sqlite3").Database {
  if (!BetterSqlite3) throw new Error("native sqlite unavailable");
  const db = new BetterSqlite3(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE);
  `);
  return db;
}

function checkpointDir(workspacePath: string): string {
  return path.join(workspacePath, ".cowork", "memory", "transcripts", "checkpoints");
}

function spanFile(workspacePath: string, taskId: string): string {
  return path.join(workspacePath, ".cowork", "memory", "transcripts", "spans", `${taskId}.jsonl`);
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function lockFileFor(workspacePath: string, taskId: string): Promise<string> {
  const canonical = await fs.realpath(workspacePath);
  const key = createHash("sha256").update(`${canonical}\u0000${taskId}`).digest("hex");
  return path.join(lockRoot, `${key}.sqlite`);
}

function event(taskId: string, type: string, payload: unknown, seq: number) {
  return {
    id: `${taskId}-${seq}`,
    eventId: `${taskId}-${seq}`,
    seq,
    taskId,
    timestamp: 1_000 + seq,
    type,
    payload,
    schemaVersion: 2,
  } as Any;
}

beforeEach(async () => {
  lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-transcript-storage-locks-"));
  createdDirs.push(lockRoot);
  process.env.COWORK_CHECKPOINT_LOCK_ROOT = lockRoot;
  setCheckpointSigningKeyForTests("storage-test-key");
});

afterEach(async () => {
  setCheckpointSigningKeyForTests(null);
  TranscriptStore.setDatabaseForTests(null);
  if (originalLockRoot === undefined) delete process.env.COWORK_CHECKPOINT_LOCK_ROOT;
  else process.env.COWORK_CHECKPOINT_LOCK_ROOT = originalLockRoot;
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("TranscriptStore checkpoint signatures", () => {
  it("ignores unsigned and legacy unkeyed checkpoints", async () => {
    const workspacePath = await createWorkspace();
    await fs.mkdir(checkpointDir(workspacePath), { recursive: true });
    const legacyBody = { checkpointKind: "snapshot", conversationHistory: ["legacy"] };
    await fs.writeFile(
      path.join(checkpointDir(workspacePath), "task-legacy.json"),
      JSON.stringify({
        ...legacyBody,
        checkpointIntegrity: {
          algorithm: "sha256",
          generation: 1,
          checksum: createHash("sha256").update(JSON.stringify(legacyBody)).digest("hex"),
        },
      }),
    );
    await fs.writeFile(
      path.join(checkpointDir(workspacePath), "task-unsigned.json"),
      JSON.stringify(legacyBody),
    );

    expect(TranscriptStore.loadCheckpointSync(workspacePath, "task-legacy")).toBeNull();
    expect(await TranscriptStore.loadCheckpoint(workspacePath, "task-unsigned")).toBeNull();
  });

  it("rejects checkpoints signed with another key, copied to another task or re-numbered", async () => {
    const workspacePath = await createWorkspace();
    await TranscriptStore.writeCheckpoint(workspacePath, "task-a", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "a" }],
    });
    expect(TranscriptStore.loadCheckpointSync(workspacePath, "task-a")).not.toBeNull();

    const source = path.join(checkpointDir(workspacePath), "task-a.json");
    await fs.copyFile(source, path.join(checkpointDir(workspacePath), "task-b.json"));
    expect(TranscriptStore.loadCheckpointSync(workspacePath, "task-b")).toBeNull();

    const renumbered = JSON.parse(await fs.readFile(source, "utf8"));
    renumbered.checkpointIntegrity.generation = 99;
    await fs.writeFile(
      path.join(checkpointDir(workspacePath), "task-c.json"),
      JSON.stringify(renumbered),
    );
    expect(TranscriptStore.loadCheckpointSync(workspacePath, "task-c")).toBeNull();

    setCheckpointSigningKeyForTests("a-different-key");
    expect(TranscriptStore.loadCheckpointSync(workspacePath, "task-a")).toBeNull();
  });
});

describe("TranscriptStore span storage", () => {
  it("does not persist conversation_snapshot spans", async () => {
    const workspacePath = await createWorkspace();
    await TranscriptStore.appendEvent(
      workspacePath,
      event("task-snap", "conversation_snapshot", { conversationHistory: ["x"] }, 1),
    );
    expect(await exists(spanFile(workspacePath, "task-snap"))).toBe(false);
  });

  it("bounds oversized payloads with a truncation marker", () => {
    const huge = { tool: "read_file", success: true, output: "z".repeat(200_000) };
    const bounded = boundTranscriptSpanPayload(huge) as Record<string, unknown>;
    expect(bounded.spanPayloadTruncated).toBe(true);
    expect(bounded.tool).toBe("read_file");
    expect(bounded.success).toBe(true);
    expect(bounded.output).toBeUndefined();
    expect(JSON.stringify(bounded).length).toBeLessThan(TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS + 1024);
    expect(boundTranscriptSpanPayload({ small: 1 })).toEqual({ small: 1 });
  });

  it("reads recent spans from the tail of a large file", async () => {
    const workspacePath = await createWorkspace();
    for (let seq = 1; seq <= 400; seq += 1) {
      await TranscriptStore.appendEvent(
        workspacePath,
        event(
          "task-tail",
          "assistant_message",
          { message: `line ${seq} ${"p".repeat(2000)}` },
          seq,
        ),
      );
    }
    const recent = await TranscriptStore.loadRecentSpans(workspacePath, "task-tail", 3);
    expect(recent.map((span) => span.seq)).toEqual([398, 399, 400]);
  });

  describeWithNativeDb("with the span index", () => {
    it("stores each span once with bounded search text and still finds it", async () => {
      const db = openDb();
      TranscriptStore.setDatabaseForTests(db);
      const workspacePath = await createWorkspace();
      await TranscriptStore.appendEvent(
        workspacePath,
        event("task-once", "tool_result", { output: `needle ${"q ".repeat(40_000)}` }, 1),
      );
      const row = db
        .prepare(`SELECT raw_line, search_text, payload_json FROM transcript_spans`)
        .get() as { raw_line: string; search_text: string; payload_json: string };
      expect(row.raw_line).toBe("");
      expect(row.search_text.length).toBeLessThanOrEqual(TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS);
      expect(JSON.parse(row.payload_json).spanPayloadTruncated).toBe(true);

      await fs.rm(spanFile(workspacePath, "task-once"));
      const results = await TranscriptStore.searchSpans({
        workspacePath,
        query: "needle",
        limit: 5,
      });
      expect(results).toHaveLength(1);
      expect(JSON.parse(results[0]!.rawLine).taskId).toBe("task-once");
    });

    it("deletes a task's rows, span file, checkpoints and lock file", async () => {
      const db = openDb();
      TranscriptStore.setDatabaseForTests(db);
      const workspacePath = await createWorkspace();
      await TranscriptStore.appendEvent(
        workspacePath,
        event("task-del", "assistant_message", { message: "delete me" }, 1),
      );
      await TranscriptStore.appendEvent(
        workspacePath,
        event("task-keep", "assistant_message", { message: "keep me" }, 1),
      );
      await TranscriptStore.writeCheckpoint(workspacePath, "task-del", {
        conversationHistory: [1],
      });
      await TranscriptStore.writeCheckpoint(workspacePath, "task-del", {
        conversationHistory: [2],
      });
      expect(await exists(await lockFileFor(workspacePath, "task-del"))).toBe(true);

      const result = await TranscriptStore.deleteTask("task-del", { workspacePath });

      expect(result.spanRows).toBe(1);
      expect(result.spanFiles).toBe(1);
      expect(result.checkpointFiles).toBe(2);
      expect(result.lockFiles).toBe(1);
      expect(await exists(spanFile(workspacePath, "task-del"))).toBe(false);
      expect(await fs.readdir(checkpointDir(workspacePath))).toEqual([]);
      expect(await exists(spanFile(workspacePath, "task-keep"))).toBe(true);
      const remaining = db.prepare(`SELECT task_id FROM transcript_spans`).all();
      expect(remaining).toEqual([{ task_id: "task-keep" }]);
      expect(
        await TranscriptStore.searchSpans({ workspacePath, query: "delete", limit: 5 }),
      ).toEqual([]);
    });

    it("deletes by task id alone across workspaces and whole workspaces", async () => {
      const db = openDb();
      TranscriptStore.setDatabaseForTests(db);
      const first = await createWorkspace();
      const second = await createWorkspace();
      await TranscriptStore.appendEvent(
        first,
        event("task-x", "user_message", { message: "a" }, 1),
      );
      await TranscriptStore.appendEvent(
        second,
        event("task-y", "user_message", { message: "b" }, 1),
      );
      await TranscriptStore.appendEvent(
        second,
        event("task-z", "user_message", { message: "c" }, 1),
      );

      const byId = await TranscriptStore.deleteTask("task-x");
      expect(byId.spanRows).toBe(1);
      expect(await exists(spanFile(first, "task-x"))).toBe(false);

      const workspace = await TranscriptStore.deleteWorkspace(second);
      expect(workspace.spanRows).toBe(2);
      expect(workspace.spanFiles).toBe(2);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM transcript_spans`).get()).toEqual({ n: 0 });
    });

    it("prunes transcripts of expired, deleted and unknown tasks in line with task events", async () => {
      const db = openDb();
      TranscriptStore.setDatabaseForTests(db);
      const workspacePath = await createWorkspace();
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      db.prepare(`INSERT INTO workspaces (id, path) VALUES ('w1', ?)`).run(workspacePath);
      const insertTask = db.prepare(`INSERT INTO tasks (id, status, created_at) VALUES (?, ?, ?)`);
      insertTask.run("old-done", "completed", now - 200 * day);
      insertTask.run("old-running", "executing", now - 200 * day);
      insertTask.run("recent-done", "completed", now - day);

      for (const taskId of ["old-done", "old-running", "recent-done", "deleted-task"]) {
        await TranscriptStore.appendEvent(
          workspacePath,
          event(taskId, "assistant_message", { message: taskId }, 1),
        );
      }
      // A span file for a task this database never knew about, recently written.
      await fs.writeFile(spanFile(workspacePath, "foreign-task"), "{}\n");
      // A stale lock with no matching task.
      const staleLock = path.join(lockRoot, `${"a".repeat(64)}.sqlite`);
      await fs.writeFile(staleLock, "");
      const old = new Date(now - 200 * day);
      await fs.utimes(staleLock, old, old);

      const result = await TranscriptStore.pruneRetention({ retentionDays: 90, now });

      const remaining = (
        db.prepare(`SELECT task_id FROM transcript_spans ORDER BY task_id`).all() as Array<{
          task_id: string;
        }>
      ).map((row) => row.task_id);
      expect(remaining).toEqual(["old-running", "recent-done"]);
      expect(await exists(spanFile(workspacePath, "old-done"))).toBe(false);
      expect(await exists(spanFile(workspacePath, "deleted-task"))).toBe(false);
      expect(await exists(spanFile(workspacePath, "foreign-task"))).toBe(true);
      expect(await exists(staleLock)).toBe(false);
      expect(result.tasks).toBe(2);
    });
  });
});

describeWithNativeDb("TranscriptStore one-time storage cleanup", () => {
  function createLegacySpanTable(db: import("better-sqlite3").Database): void {
    db.exec(`
      CREATE TABLE transcript_spans (
        id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, task_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
        event_id TEXT, seq INTEGER, raw_line TEXT NOT NULL, search_text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE transcript_spans_fts USING fts5(
        search_text, raw_line, content='transcript_spans', content_rowid='rowid'
      );
      CREATE TRIGGER transcript_spans_fts_insert AFTER INSERT ON transcript_spans BEGIN
        INSERT INTO transcript_spans_fts(rowid, search_text, raw_line)
        VALUES (NEW.rowid, NEW.search_text, NEW.raw_line);
      END;
      CREATE TRIGGER transcript_spans_fts_delete AFTER DELETE ON transcript_spans BEGIN
        INSERT INTO transcript_spans_fts(transcript_spans_fts, rowid, search_text, raw_line)
        VALUES('delete', OLD.rowid, OLD.search_text, OLD.raw_line);
      END;
      CREATE TRIGGER transcript_spans_fts_update AFTER UPDATE ON transcript_spans BEGIN
        INSERT INTO transcript_spans_fts(transcript_spans_fts, rowid, search_text, raw_line)
        VALUES('delete', OLD.rowid, OLD.search_text, OLD.raw_line);
        INSERT INTO transcript_spans_fts(rowid, search_text, raw_line)
        VALUES (NEW.rowid, NEW.search_text, NEW.raw_line);
      END;
    `);
    const insert = db.prepare(`
      INSERT INTO transcript_spans (id, workspace_path, task_id, timestamp, type, payload_json,
        event_id, seq, raw_line, search_text, created_at)
      VALUES (?, ?, 'legacy-task', ?, ?, ?, NULL, ?, ?, ?, 0)
    `);
    for (let seq = 1; seq <= 12; seq += 1) {
      const type = seq % 3 === 0 ? "conversation_snapshot" : "assistant_message";
      const payload =
        type === "conversation_snapshot"
          ? { conversationHistory: "h".repeat(20_000) }
          : { message: `legacy marker${seq} ${"w ".repeat(seq === 1 ? 30_000 : 10)}` };
      const payloadJson = JSON.stringify(payload);
      const rawLine = JSON.stringify({ taskId: "legacy-task", type, payload });
      insert.run(
        `span-${seq}`,
        "/ws",
        seq,
        type,
        payloadJson,
        seq,
        rawLine,
        `${type} ${payloadJson}`,
      );
    }
  }

  it("removes snapshot spans and duplicates, rebuilds the index and runs only once", async () => {
    const db = openDb();
    createLegacySpanTable(db);
    TranscriptStore.setDatabaseForTests(db);
    const logs: string[] = [];

    const first = await TranscriptStore.runStorageCleanup({
      batchSize: 2,
      pauseMs: 0,
      log: (message) => logs.push(message),
    });

    expect(first.status).toBe("completed");
    expect(first.deletedSnapshotRows).toBe(4);
    expect(first.rewrittenRows).toBe(8);
    expect(first.reclaimedChars).toBeGreaterThan(80_000);
    expect(logs.join("\n")).toContain("deleted 4 snapshot span(s)");
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(length(raw_line)) AS raw, MAX(length(search_text)) AS search,
                MAX(length(payload_json)) AS payload
         FROM transcript_spans`,
      )
      .get() as { n: number; raw: number; search: number; payload: number };
    expect(stats.n).toBe(8);
    expect(stats.raw).toBe(0);
    expect(stats.search).toBeLessThanOrEqual(TRANSCRIPT_SPAN_SEARCH_TEXT_MAX_CHARS);
    expect(stats.payload).toBeLessThan(TRANSCRIPT_SPAN_PAYLOAD_MAX_CHARS + 1024);
    expect(() =>
      db.exec(
        `INSERT INTO transcript_spans_fts(transcript_spans_fts, rank) VALUES('integrity-check', 1)`,
      ),
    ).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transcript_span_index_gap`).get()).toEqual({
      n: 0,
    });

    const hits = await TranscriptStore.searchSpans({
      workspacePath: "/ws",
      query: "marker5",
      limit: 5,
    });
    expect(hits.map((hit) => hit.seq)).toEqual([5]);

    // Deletes after the cleanup keep the index consistent.
    db.prepare(`DELETE FROM transcript_spans WHERE seq = 5`).run();
    expect(() =>
      db.exec(
        `INSERT INTO transcript_spans_fts(transcript_spans_fts, rank) VALUES('integrity-check', 1)`,
      ),
    ).not.toThrow();

    const second = await TranscriptStore.runStorageCleanup({ pauseMs: 0 });
    expect(second.status).toBe("already_done");
  });

  it("keeps the index consistent when rows change while the backfill is pending", async () => {
    const db = openDb();
    createLegacySpanTable(db);
    TranscriptStore.setDatabaseForTests(db);
    await TranscriptStore.searchSpans({ workspacePath: "/ws", query: "warmup", limit: 1 });
    // Simulate an interrupted cleanup: index emptied, gap open, nothing rewritten.
    db.exec(`
      INSERT INTO transcript_span_index_gap (id, done_upto, max_rowid)
        VALUES (1, 0, (SELECT MAX(rowid) FROM transcript_spans));
      INSERT INTO transcript_spans_fts(transcript_spans_fts) VALUES('delete-all');
      INSERT INTO transcript_store_meta (key, value, updated_at)
        VALUES ('span_storage_cleanup_v1_cursor', '0', 0);
    `);
    // Concurrent deletes and new spans during the gap.
    db.prepare(`DELETE FROM transcript_spans WHERE seq IN (1, 2)`).run();
    await TranscriptStore.appendEvent(
      await createWorkspace(),
      event("fresh-task", "assistant_message", { message: "fresh span" }, 1),
    );

    const result = await TranscriptStore.runStorageCleanup({ batchSize: 3, pauseMs: 0 });

    expect(result.status).toBe("completed");
    expect(() =>
      db.exec(
        `INSERT INTO transcript_spans_fts(transcript_spans_fts, rank) VALUES('integrity-check', 1)`,
      ),
    ).not.toThrow();
    const indexed = db
      .prepare(
        `SELECT COUNT(*) AS n FROM transcript_spans_fts WHERE transcript_spans_fts MATCH 'fresh'`,
      )
      .get() as { n: number };
    expect(indexed.n).toBe(1);
  });

  it("migrates legacy triggers without touching existing rows", async () => {
    const db = openDb();
    createLegacySpanTable(db);
    TranscriptStore.setDatabaseForTests(db);
    const results = await TranscriptStore.searchSpans({
      workspacePath: "/ws",
      query: "marker4",
      limit: 5,
    });
    expect(results.map((hit) => hit.seq)).toEqual([4]);
    expect(results[0]?.rawLine).toContain("legacy-task");
    const trigger = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'transcript_spans_fts_delete'`)
      .get() as { sql: string };
    expect(trigger.sql).toContain("transcript_span_index_gap");
  });
});

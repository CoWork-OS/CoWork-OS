import { createRequire } from "module";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "../TranscriptStore";
import { DurableContextService } from "../DurableContextService";
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
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL,
      prompt TEXT, raw_prompt TEXT
    );
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE);
  `);
  TranscriptStore.setDatabaseForTests(db);
  DurableContextService.setDatabaseForTests(db);
  return db;
}

/** A legacy span row (written by older clients) plus its JSONL file. */
/** A legacy JSONL span file (the `transcript_spans` table is retired and dropped). */
async function writeLegacySpan(
  _db: import("better-sqlite3").Database,
  workspacePath: string,
  taskId: string,
  message: string,
): Promise<void> {
  const payload = JSON.stringify({ message });
  await fs.mkdir(path.dirname(spanFile(workspacePath, taskId)), { recursive: true });
  await fs.writeFile(spanFile(workspacePath, taskId), `${JSON.stringify({ taskId, payload })}\n`);
}

async function indexMessage(workspaceId: string, taskId: string, message: string): Promise<void> {
  DurableContextService.indexEvent({
    workspaceId,
    taskId,
    type: "assistant_message",
    payload: { message },
    timestamp: 1_000,
    eventId: `${taskId}-event`,
  });
  await DurableContextService.flushIndexQueue();
}

function indexedTasks(db: import("better-sqlite3").Database): string[] {
  return (
    db
      .prepare(`SELECT DISTINCT task_id FROM durable_context_events ORDER BY task_id`)
      .all() as Array<{
      task_id: string;
    }>
  ).map((row) => row.task_id);
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

beforeEach(async () => {
  lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-transcript-storage-locks-"));
  createdDirs.push(lockRoot);
  process.env.COWORK_CHECKPOINT_LOCK_ROOT = lockRoot;
  setCheckpointSigningKeyForTests("storage-test-key");
});

afterEach(async () => {
  setCheckpointSigningKeyForTests(null);
  TranscriptStore.setDatabaseForTests(null);
  DurableContextService.setDatabaseForTests(null);
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

describeWithNativeDb("TranscriptStore deletion and retention", () => {
  it("never creates the legacy span table on a fresh database", async () => {
    const db = openDb();
    const workspacePath = await createWorkspace();
    await TranscriptStore.deleteTask("task-fresh", { workspacePath });
    await TranscriptStore.pruneRetention({ retentionDays: 90 });
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'transcript_spans'`)
      .get();
    expect(table).toBeUndefined();
  });

  it("deletes a task's index rows, span file, checkpoints and lock file", async () => {
    const db = openDb();
    const workspacePath = await createWorkspace();
    await indexMessage("w1", "task-del", "delete me");
    await indexMessage("w1", "task-keep", "keep me");
    await writeLegacySpan(db, workspacePath, "task-del", "delete me");
    await writeLegacySpan(db, workspacePath, "task-keep", "keep me");
    await TranscriptStore.writeCheckpoint(workspacePath, "task-del", {
      conversationHistory: [1],
    });
    await TranscriptStore.writeCheckpoint(workspacePath, "task-del", {
      conversationHistory: [2],
    });
    expect(await exists(await lockFileFor(workspacePath, "task-del"))).toBe(true);

    const result = await TranscriptStore.deleteTask("task-del", { workspacePath });

    expect(result.indexRows).toBe(1);
    expect(result.spanFiles).toBe(1);
    expect(result.checkpointFiles).toBe(2);
    expect(result.lockFiles).toBe(1);
    expect(await exists(spanFile(workspacePath, "task-del"))).toBe(false);
    expect(await fs.readdir(checkpointDir(workspacePath))).toEqual([]);
    expect(await exists(spanFile(workspacePath, "task-keep"))).toBe(true);
    expect(indexedTasks(db)).toEqual(["task-keep"]);
    expect(
      await DurableContextService.searchConversation({ workspaceId: "w1", query: "delete" }),
    ).toEqual([]);
  });

  it("deletes by task id alone (index rows only) and whole workspaces", async () => {
    const db = openDb();
    const first = await createWorkspace();
    const second = await createWorkspace();
    await writeLegacySpan(db, first, "task-x", "a");
    await writeLegacySpan(db, second, "task-y", "b");
    await writeLegacySpan(db, second, "task-z", "c");
    await indexMessage("w1", "task-x", "a");
    await indexMessage("w2", "task-y", "b");

    const byId = await TranscriptStore.deleteTask("task-x");
    expect(byId.indexRows).toBe(1);
    // Without a workspace path no files are touched.
    expect(await exists(spanFile(first, "task-x"))).toBe(true);

    const workspace = await TranscriptStore.deleteWorkspace(second, { workspaceId: "w2" });
    expect(workspace.spanFiles).toBe(2);
    expect(workspace.indexRows).toBeGreaterThanOrEqual(1);
    expect(indexedTasks(db)).toEqual([]);
  });

  it("prunes the index and files of expired, deleted and unknown tasks in line with task events", async () => {
    const db = openDb();
    const workspacePath = await createWorkspace();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    db.prepare(`INSERT INTO workspaces (id, path) VALUES ('w1', ?)`).run(workspacePath);
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, 'w1', ?, ?)`,
    );
    insertTask.run("old-done", "completed", now - 200 * day);
    insertTask.run("old-running", "executing", now - 200 * day);
    insertTask.run("recent-done", "completed", now - day);

    for (const taskId of ["old-done", "old-running", "recent-done", "deleted-task"]) {
      await indexMessage("w1", taskId, taskId);
      await writeLegacySpan(db, workspacePath, taskId, taskId);
    }
    // A span file for a task this database never knew about, recently written.
    await fs.writeFile(spanFile(workspacePath, "foreign-task"), "{}\n");
    // A stale lock with no matching task.
    const staleLock = path.join(lockRoot, `${"a".repeat(64)}.sqlite`);
    await fs.writeFile(staleLock, "");
    const old = new Date(now - 200 * day);
    await fs.utimes(staleLock, old, old);

    const result = await TranscriptStore.pruneRetention({ retentionDays: 90, now });

    expect(indexedTasks(db)).toEqual(["old-running", "recent-done"]);
    expect(await exists(spanFile(workspacePath, "old-done"))).toBe(false);
    expect(await exists(spanFile(workspacePath, "old-running"))).toBe(true);
    expect(await exists(spanFile(workspacePath, "recent-done"))).toBe(true);
    // A recent file of a task this database no longer knows waits until it is old.
    expect(await exists(spanFile(workspacePath, "deleted-task"))).toBe(true);
    expect(await exists(spanFile(workspacePath, "foreign-task"))).toBe(true);
    expect(await exists(staleLock)).toBe(false);
    expect(result.indexRows).toBe(2);
  });
});

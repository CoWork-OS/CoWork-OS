import { createRequire } from "module";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "../TranscriptStore";
import {
  killCheckpointWriterMidFilesystemWrite,
  runCheckpointWriter,
  runConcurrentCheckpointWriters,
} from "../../../../tests/helpers/transcript-store-processes";

const createdDirs: string[] = [];
const databases: Array<import("better-sqlite3").Database> = [];
const originalCheckpointLockRoot = process.env.COWORK_CHECKPOINT_LOCK_ROOT;

const require = createRequire(import.meta.url);
const BetterSqlite3Module = (() => {
  try {
    return require("better-sqlite3") as typeof import("better-sqlite3");
  } catch {
    return null;
  }
})();

const BetterSqlite3 = (() => {
  if (!BetterSqlite3Module) return null;
  try {
    const probe = new BetterSqlite3Module(":memory:");
    probe.close();
    return BetterSqlite3Module;
  } catch {
    return null;
  }
})();

const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-transcript-store-"));
  const lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-checkpoint-locks-"));
  createdDirs.push(dir, lockRoot);
  process.env.COWORK_CHECKPOINT_LOCK_ROOT = lockRoot;
  return dir;
}

function checkpointLockRoot(): string {
  const root = process.env.COWORK_CHECKPOINT_LOCK_ROOT;
  if (!root) throw new Error("checkpoint test lock root was not configured");
  return root;
}

afterEach(async () => {
  TranscriptStore.setDatabaseForTests(null);
  if (originalCheckpointLockRoot === undefined) {
    delete process.env.COWORK_CHECKPOINT_LOCK_ROOT;
  } else {
    process.env.COWORK_CHECKPOINT_LOCK_ROOT = originalCheckpointLockRoot;
  }
  for (const db of databases.splice(0)) {
    db.close();
  }
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("TranscriptStore", () => {
  it("writes checkpoints and restores them synchronously", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.writeCheckpoint(workspacePath, "task-1", {
      checkpointKind: "completion",
      conversationHistory: [{ role: "user", content: "hello" }],
      trackerState: { filesRead: ["src/app.ts"] },
      structuredSummary: {
        source: "completion",
        decisions: ["Ship the migration fix"],
        openLoops: [],
        nextActions: ["Run the release checklist"],
        keyFindings: ["The installer was missing built artifacts"],
      },
      evidencePacket: {
        generatedAt: Date.now(),
        spanHash: "abc123",
        spanCount: 1,
        spans: [
          {
            sourceType: "task_message",
            objectId: "event-1",
            taskId: "task-1",
            timestamp: Date.now(),
            type: "assistant_message",
            excerpt: "Ship the migration fix.",
          },
        ],
      },
    });

    const restored = TranscriptStore.loadCheckpointSync(workspacePath, "task-1");
    expect(restored?.conversationHistory).toEqual([{ role: "user", content: "hello" }]);
    expect(restored?.checkpointKind).toBe("completion");
    expect(restored?.structuredSummary?.decisions).toContain("Ship the migration fix");
  });

  it("writes integrity metadata and keeps the previous generation for recovery", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.writeCheckpoint(workspacePath, "task-generations", {
      checkpointKind: "periodic",
      conversationHistory: [{ role: "user", content: "first" }],
    });
    await TranscriptStore.writeCheckpoint(workspacePath, "task-generations", {
      checkpointKind: "periodic",
      conversationHistory: [{ role: "user", content: "second" }],
    });

    const checkpointDir = path.join(
      workspacePath,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
    );
    const current = JSON.parse(
      await fs.readFile(path.join(checkpointDir, "task-generations.json"), "utf8"),
    );
    const previous = JSON.parse(
      await fs.readFile(path.join(checkpointDir, "task-generations.previous.json"), "utf8"),
    );

    expect(current.checkpointIntegrity.algorithm).toBe("sha256");
    expect(current.checkpointIntegrity.generation).toBe(2);
    expect(previous.conversationHistory).toEqual([{ role: "user", content: "first" }]);
    expect(previous.checkpointIntegrity.generation).toBe(1);
  });

  it("serializes concurrent writes so each checkpoint gets a distinct generation", async () => {
    const workspacePath = await createWorkspace();

    await Promise.all([
      TranscriptStore.writeCheckpoint(workspacePath, "task-concurrent", {
        checkpointKind: "snapshot",
        conversationHistory: [{ role: "user", content: "first concurrent write" }],
      }),
      TranscriptStore.writeCheckpoint(workspacePath, "task-concurrent", {
        checkpointKind: "snapshot",
        conversationHistory: [{ role: "user", content: "second concurrent write" }],
      }),
    ]);

    const checkpointDir = path.join(
      workspacePath,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
    );
    const current = JSON.parse(
      await fs.readFile(path.join(checkpointDir, "task-concurrent.json"), "utf8"),
    );
    const previous = JSON.parse(
      await fs.readFile(path.join(checkpointDir, "task-concurrent.previous.json"), "utf8"),
    );

    expect(current.checkpointIntegrity.generation).toBe(2);
    expect(previous.checkpointIntegrity.generation).toBe(1);
    expect(current.conversationHistory).toEqual([
      { role: "user", content: "second concurrent write" },
    ]);
    expect(previous.conversationHistory).toEqual([
      { role: "user", content: "first concurrent write" },
    ]);
  });

  it("serializes concurrent writers in independent OS processes", async () => {
    const workspacePath = await createWorkspace();

    await runConcurrentCheckpointWriters({
      workspacePath,
      taskId: "task-process-concurrent",
      contents: ["process writer 1", "process writer 2", "process writer 3", "process writer 4"],
      sourceTimestamp: 100,
      lockRoot: checkpointLockRoot(),
    });

    const checkpointDir = path.join(
      workspacePath,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
    );
    const current = JSON.parse(
      await fs.readFile(path.join(checkpointDir, "task-process-concurrent.json"), "utf8"),
    );
    const previous = JSON.parse(
      await fs.readFile(path.join(checkpointDir, "task-process-concurrent.previous.json"), "utf8"),
    );

    expect(current.checkpointIntegrity.generation).toBe(4);
    expect(previous.checkpointIntegrity.generation).toBe(3);
    expect(current.conversationHistory[0]?.content).toMatch(/^process writer [1-4]$/);
    expect(previous.conversationHistory[0]?.content).toMatch(/^process writer [1-4]$/);
    const lockFiles = (await fs.readdir(checkpointLockRoot())).filter((name) =>
      name.endsWith(".sqlite"),
    );
    expect(lockFiles).toHaveLength(1);
  });

  it("does not follow a workspace-preseeded checkpoint lock symlink", async () => {
    const workspacePath = await createWorkspace();
    if (!BetterSqlite3) throw new Error("better-sqlite3 is required for this regression");
    const targetDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cowork-checkpoint-lock-symlink-target-"),
    );
    createdDirs.push(targetDirectory);
    const checkpointDir = path.join(
      workspacePath,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
    );
    await TranscriptStore.ensureLayout(workspacePath);
    const targetPath = path.join(targetDirectory, "lock.sqlite");
    const linkPath = path.join(checkpointDir, "task-symlink.json.lock.sqlite");
    const targetDb = new BetterSqlite3(targetPath);
    targetDb.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
    targetDb.prepare("INSERT INTO sentinel (id, value) VALUES (?, ?)").run(1, "sentinel");
    targetDb.close();
    await fs.symlink(targetPath, linkPath);

    await TranscriptStore.writeCheckpoint(workspacePath, "task-symlink", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "safe lock path" }],
    });

    const untouchedTargetDb = new BetterSqlite3(targetPath);
    const tables = untouchedTargetDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    const sentinel = untouchedTargetDb
      .prepare("SELECT value FROM sentinel WHERE id = 1")
      .pluck()
      .get();
    untouchedTargetDb.close();
    expect(tables).toEqual(["sentinel"]);
    expect(sentinel).toBe("sentinel");
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("recovers when an independent process is killed while holding the lock mid-write", async () => {
    const workspacePath = await createWorkspace();
    await TranscriptStore.writeCheckpoint(workspacePath, "task-killed-holder", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "durable state before crash" }],
      sourceTimestamp: 100,
    });
    const releasePath = path.join(workspacePath, "release-killed-writer");
    await killCheckpointWriterMidFilesystemWrite({
      workspacePath,
      taskId: "task-killed-holder",
      content: "interrupted state",
      sourceTimestamp: 200,
      lockRoot: checkpointLockRoot(),
      releasePath,
    });

    expect(
      TranscriptStore.loadCheckpointSync(workspacePath, "task-killed-holder")?.conversationHistory,
    ).toEqual([{ role: "user", content: "durable state before crash" }]);

    await runCheckpointWriter({
      workspacePath,
      taskId: "task-killed-holder",
      content: "writer after killed holder",
      sourceTimestamp: 300,
      lockRoot: checkpointLockRoot(),
    });

    const restored = TranscriptStore.loadCheckpointSync(workspacePath, "task-killed-holder");
    expect(restored?.conversationHistory).toEqual([
      { role: "user", content: "writer after killed holder" },
    ]);
    const checkpointDir = path.join(
      workspacePath,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
    );
    const previous = JSON.parse(
      await fs.readFile(path.join(checkpointDir, "task-killed-holder.previous.json"), "utf8"),
    );
    expect(previous.conversationHistory).toEqual([
      { role: "user", content: "durable state before crash" },
    ]);
  });

  it("does not let a late older process roll back a newer checkpoint", async () => {
    const workspacePath = await createWorkspace();

    await runCheckpointWriter({
      workspacePath,
      taskId: "task-process-freshness",
      content: "newer process state",
      sourceTimestamp: 200,
      lockRoot: checkpointLockRoot(),
    });
    await runCheckpointWriter({
      workspacePath,
      taskId: "task-process-freshness",
      content: "older process state",
      sourceTimestamp: 100,
      lockRoot: checkpointLockRoot(),
    });

    const restored = TranscriptStore.loadCheckpointSync(workspacePath, "task-process-freshness");
    expect(restored?.conversationHistory).toEqual([
      { role: "user", content: "newer process state" },
    ]);
    expect(restored?.checkpointIntegrity?.generation).toBe(1);
  });

  it("keeps the freshest snapshot when older and newer processes race", async () => {
    const workspacePath = await createWorkspace();

    await runConcurrentCheckpointWriters({
      workspacePath,
      taskId: "task-process-freshness-race",
      contents: ["older process state", "newer process state"],
      sourceTimestamps: [100, 200],
      lockRoot: checkpointLockRoot(),
    });

    const restored = TranscriptStore.loadCheckpointSync(
      workspacePath,
      "task-process-freshness-race",
    );
    expect(restored?.conversationHistory).toEqual([
      { role: "user", content: "newer process state" },
    ]);
    expect(restored?.sourceTimestamp).toBe(200);
  });

  it("keeps the valid previous generation when current is corrupt before a new write", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.writeCheckpoint(workspacePath, "task-partial-current", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "valid fallback" }],
      sourceTimestamp: 100,
    });
    await TranscriptStore.writeCheckpoint(workspacePath, "task-partial-current", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "second generation" }],
      sourceTimestamp: 200,
    });

    const checkpointDir = path.join(
      workspacePath,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
    );
    await fs.writeFile(
      path.join(checkpointDir, "task-partial-current.json"),
      '{"partial":',
      "utf8",
    );

    await TranscriptStore.writeCheckpoint(workspacePath, "task-partial-current", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "repaired generation" }],
      sourceTimestamp: 300,
    });

    const current = JSON.parse(
      await fs.readFile(path.join(checkpointDir, "task-partial-current.json"), "utf8"),
    );
    const previous = JSON.parse(
      await fs.readFile(path.join(checkpointDir, "task-partial-current.previous.json"), "utf8"),
    );
    expect(current.conversationHistory).toEqual([{ role: "user", content: "repaired generation" }]);
    expect(previous.conversationHistory).toEqual([{ role: "user", content: "valid fallback" }]);
    expect(current.checkpointIntegrity.generation).toBe(2);
    expect(previous.checkpointIntegrity.generation).toBe(1);
  });

  it("falls back to the previous checkpoint when the current generation is corrupt", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.writeCheckpoint(workspacePath, "task-recovery", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "recover me" }],
    });
    await TranscriptStore.writeCheckpoint(workspacePath, "task-recovery", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "newer" }],
    });

    const checkpointPath = path.join(
      workspacePath,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
      "task-recovery.json",
    );
    await fs.writeFile(checkpointPath, '{"truncated":', "utf8");

    const restored = await TranscriptStore.loadCheckpoint(workspacePath, "task-recovery");
    expect(restored?.conversationHistory).toEqual([{ role: "user", content: "recover me" }]);
    expect(
      TranscriptStore.loadCheckpointSync(workspacePath, "task-recovery")?.conversationHistory,
    ).toEqual([{ role: "user", content: "recover me" }]);
  });

  it("rejects a checkpoint when both generations fail integrity validation", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.writeCheckpoint(workspacePath, "task-invalid", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "first" }],
    });
    await TranscriptStore.writeCheckpoint(workspacePath, "task-invalid", {
      checkpointKind: "snapshot",
      conversationHistory: [{ role: "user", content: "second" }],
    });

    const checkpointDir = path.join(
      workspacePath,
      ".cowork",
      "memory",
      "transcripts",
      "checkpoints",
    );
    for (const name of ["task-invalid.json", "task-invalid.previous.json"]) {
      const filePath = path.join(checkpointDir, name);
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      parsed.conversationHistory = [{ role: "user", content: "tampered" }];
      await fs.writeFile(filePath, JSON.stringify(parsed), "utf8");
    }

    expect(await TranscriptStore.loadCheckpoint(workspacePath, "task-invalid")).toBeNull();
    expect(TranscriptStore.loadCheckpointSync(workspacePath, "task-invalid")).toBeNull();
  });

  it("appends searchable transcript spans", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.appendEvent(workspacePath, {
      id: "event-1",
      taskId: "task-1",
      timestamp: Date.now(),
      type: "assistant_message",
      payload: { message: "Layered memory is ready" },
      schemaVersion: 2,
    });

    const results = await TranscriptStore.searchSpans({
      workspacePath,
      taskId: "task-1",
      query: "layered memory",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("assistant_message");
  });

  it("persists correlated compaction lifecycle events for replay and search", async () => {
    const workspacePath = await createWorkspace();

    for (const [index, type] of [
      "context_compaction_started",
      "context_compaction_completed",
    ].entries()) {
      await TranscriptStore.appendEvent(workspacePath, {
        id: `compaction-event-${index}`,
        taskId: "task-compaction",
        timestamp: Date.now() + index,
        type,
        payload: {
          compactionId: "compact-1",
          attemptId: "attempt-1",
          status: index === 0 ? "started" : "completed",
          trigger: "automatic",
          phase: "pre_turn",
          historyGenerationBefore: 3,
          ...(index === 1 ? { historyGenerationAfter: 4 } : {}),
        },
        schemaVersion: 2,
      });
    }

    expect(await TranscriptStore.loadRecentSpans(workspacePath, "task-compaction")).toHaveLength(2);

    const results = await TranscriptStore.searchSpans({
      workspacePath,
      taskId: "task-compaction",
      query: "automatic",
      limit: 5,
    });

    expect(results.map((result) => result.type)).toEqual([
      "context_compaction_completed",
      "context_compaction_started",
    ]);
  });

  it("persists user messages so verbatim recall can capture both sides of the exchange", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.appendEvent(workspacePath, {
      id: "event-user-1",
      taskId: "task-1",
      timestamp: Date.now(),
      type: "user_message",
      payload: { message: "Never mutate the production DB directly." },
      schemaVersion: 2,
    });

    const results = await TranscriptStore.searchSpans({
      workspacePath,
      taskId: "task-1",
      query: "production db directly",
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.type).toBe("user_message");
  });

  it("caps task-scoped search results without scanning every older matching line", async () => {
    const workspacePath = await createWorkspace();

    for (let index = 0; index < 6; index += 1) {
      await TranscriptStore.appendEvent(workspacePath, {
        id: `event-${index}`,
        taskId: "task-limit",
        timestamp: Date.now() + index,
        type: "assistant_message",
        payload: { message: `Layered memory result ${index}` },
        schemaVersion: 2,
      });
    }

    const results = await TranscriptStore.searchSpans({
      workspacePath,
      taskId: "task-limit",
      query: "layered memory",
      limit: 3,
    });

    expect(results).toHaveLength(3);
    expect(results[0]?.timestamp).toBeGreaterThan(results[2]?.timestamp || 0);
  });
});

describeWithNativeDb("TranscriptStore SQLite FTS", () => {
  function createDb(): import("better-sqlite3").Database {
    if (!BetterSqlite3) throw new Error("better-sqlite3 unavailable");
    const db = new BetterSqlite3(":memory:");
    databases.push(db);
    return db;
  }

  it("indexes appended spans in SQLite FTS and falls back to JSONL for misses", async () => {
    const workspacePath = await createWorkspace();
    TranscriptStore.setDatabaseForTests(createDb());

    await TranscriptStore.appendEvent(workspacePath, {
      id: "event-db-1",
      eventId: "event-db-1",
      taskId: "task-db",
      timestamp: Date.now(),
      type: "assistant_message",
      payload: { message: "SQLite transcript recall is indexed" },
      schemaVersion: 2,
    });

    const indexed = await TranscriptStore.searchSpans({
      workspacePath,
      query: "sqlite transcript",
      limit: 5,
    });

    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.eventId).toBe("event-db-1");

    TranscriptStore.setDatabaseForTests(null);
    const fallback = await TranscriptStore.searchSpans({
      workspacePath,
      query: "sqlite transcript",
      limit: 5,
    });

    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.eventId).toBe("event-db-1");
  });
});

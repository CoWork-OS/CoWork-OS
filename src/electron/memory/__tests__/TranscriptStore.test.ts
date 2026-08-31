import { createRequire } from "module";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "../TranscriptStore";

const createdDirs: string[] = [];
const databases: Array<import("better-sqlite3").Database> = [];

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
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  TranscriptStore.setDatabaseForTests(null);
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

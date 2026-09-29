import Database from "better-sqlite3";
import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseClient, type DatabaseClientOptions } from "../DatabaseClient";
import { DatabaseRequestError } from "../protocol";
import { pruneTaskEventsWithWorker, readStorageStats } from "../maintenance";
import { DATABASE_COMMANDS, requiredTablesFor } from "../commands";
import { DatabaseManager } from "../../schema";
import { TaskEventRepository, TaskStore, WorkspaceStore } from "../../repositories";

// Real worker, real SQLite, real messages. There is deliberately no native-module skip
// guard: if better-sqlite3 cannot load, these durability tests must fail, not pass.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;
let testCommandsModule: string;

// Commands used only by these tests; loaded through `testCommandsModule`.
const TEST_COMMANDS_SOURCE = `
exports.commands = {
  "test.insertMarker": {
    kind: "write",
    tables: [],
    run(db, args) {
      db.prepare("INSERT INTO worker_test_markers (name) VALUES (?)").run(args.name);
      return { inserted: args.name };
    },
  },
  "test.insertThenFail": {
    kind: "write",
    tables: [],
    run(db, args) {
      db.prepare("INSERT INTO worker_test_markers (name) VALUES (?)").run(args.name);
      throw new Error("failed after insert");
    },
  },
  "test.listMarkers": {
    kind: "read",
    tables: [],
    run(db) {
      return db.prepare("SELECT name FROM worker_test_markers ORDER BY rowid").all().map((row) => row.name);
    },
  },
  "test.sleep": {
    kind: "read",
    tables: [],
    run(db, args) {
      const end = Date.now() + args.ms;
      while (Date.now() < end) {}
      return { slept: args.ms };
    },
  },
  "test.commitThenExit": {
    kind: "write",
    tables: [],
    run(db, args) {
      db.prepare("INSERT INTO worker_test_markers (name) VALUES (?)").run(args.name);
      db.exec("COMMIT");
      process.exit(0);
    },
  },
};
`;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-${process.pid}.js`);
  testCommandsModule = path.join(BUILD_DIR, `test-commands-${process.pid}.js`);
  buildSync({
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: workerPath,
    external: ["better-sqlite3"],
    logLevel: "silent",
  });
  fs.writeFileSync(testCommandsModule, TEST_COMMANDS_SOURCE);
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
  fs.rmSync(testCommandsModule, { force: true });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const expectDatabaseError = async (
  promise: Promise<unknown>,
  expected: Partial<Pick<DatabaseRequestError, "code" | "outcome">>,
) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DatabaseRequestError);
  expect(error).toMatchObject(expected);
};

/** Measure the longest gap between host timer ticks while `work` runs. */
const maxHostStall = async (work: () => Promise<unknown>) => {
  let last = Date.now();
  let maxGap = 0;
  const ticker = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  try {
    await work();
  } finally {
    clearInterval(ticker);
  }
  return maxGap;
};

describe("DatabaseClient with a real worker", () => {
  let tmpDir: string;
  let dbPath: string;
  let clients: DatabaseClient[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-db-worker-"));
    dbPath = path.join(tmpDir, "cowork-os.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE worker_test_markers (name TEXT NOT NULL)");
    db.close();
    clients = [];
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close(2_000)));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const start = async (options: Partial<DatabaseClientOptions> = {}) => {
    const client = await DatabaseClient.start({
      dbPath,
      requiredTables: ["worker_test_markers"],
      workerPath,
      testCommandsModule,
      ...options,
    });
    clients.push(client);
    return client;
  };

  const markers = () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (
        db.prepare("SELECT name FROM worker_test_markers ORDER BY rowid").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
    } finally {
      db.close();
    }
  };

  it("resolves writes after commit and keeps request order", async () => {
    const client = await start();
    const results = await Promise.all([
      client.executeCommand("test.insertMarker", { name: "a" }),
      client.executeCommand("test.insertMarker", { name: "b" }),
      client.executeCommand("test.listMarkers", undefined),
      client.executeCommand("test.insertMarker", { name: "c" }),
    ]);
    expect(results[2]).toEqual(["a", "b"]);
    expect(markers()).toEqual(["a", "b", "c"]);
  });

  it("rolls back a failed write and reports it as not committed", async () => {
    const client = await start();
    await expectDatabaseError(client.executeCommand("test.insertThenFail", { name: "x" }), {
      code: "command_failed",
      outcome: "not_committed",
    });
    expect(markers()).toEqual([]);
  });

  it("rejects unknown commands and invalid arguments without committing", async () => {
    const client = await start({ requiredTables: requiredTablesFor(DATABASE_COMMANDS) }).catch(
      () => null,
    );
    // The markers fixture has no tasks table, so the pilot commands' schema check fails.
    expect(client).toBeNull();
    const markersClient = await start();
    await expectDatabaseError(markersClient.executeCommand("test.nope", {}), {
      code: "invalid_request",
    });
  });

  it("keeps the host responsive while the worker runs a long statement", async () => {
    const client = await start();
    const stall = await maxHostStall(() => client.executeCommand("test.sleep", { ms: 300 }));
    expect(stall).toBeLessThan(100);
  });

  it("parks writes behind another process's write lock while reads keep running", async () => {
    const client = await start();
    const holder = new Database(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    let writeSettledAt = 0;
    const write = client.executeCommand("test.insertMarker", { name: "parked" }).then((result) => {
      writeSettledAt = Date.now();
      return result;
    });

    const stall = await maxHostStall(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const readStartedAt = Date.now();
      await expect(client.executeCommand("test.listMarkers", undefined)).resolves.toEqual([]);
      // The read is not stuck behind the parked write or a long busy wait.
      expect(Date.now() - readStartedAt).toBeLessThan(150);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(writeSettledAt).toBe(0);
    const releasedAt = Date.now();
    holder.exec("COMMIT");
    holder.close();

    await expect(write).resolves.toEqual({ inserted: "parked" });
    expect(writeSettledAt).toBeGreaterThanOrEqual(releasedAt);
    expect(stall).toBeLessThan(100);
    expect(markers()).toEqual(["parked"]);
  });

  it("fails a parked write at its deadline without committing", async () => {
    const client = await start();
    const holder = new Database(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    try {
      await expectDatabaseError(
        client.executeCommand("test.insertMarker", { name: "late" }, { deadlineMs: 150 }),
        { code: "busy_timeout", outcome: "not_committed" },
      );
    } finally {
      holder.exec("COMMIT");
      holder.close();
    }
    expect(markers()).toEqual([]);
  });

  it("rejects queued work whose deadline passed before it started", async () => {
    const client = await start();
    const long = client.executeCommand("test.sleep", { ms: 300 });
    await expectDatabaseError(
      client.executeCommand("test.insertMarker", { name: "expired" }, { deadlineMs: 50 }),
      { code: "deadline_exceeded", outcome: "not_committed" },
    );
    await long;
    expect(markers()).toEqual([]);
  });

  it("bounds pending work and rejects the overflow explicitly", async () => {
    const client = await start({ maxPending: 2 });
    const first = client.executeCommand("test.sleep", { ms: 150 });
    const second = client.executeCommand("test.listMarkers", undefined);
    await expectDatabaseError(client.executeCommand("test.listMarkers", undefined), {
      code: "overloaded",
      outcome: "not_committed",
    });
    await Promise.all([first, second]);
  });

  it("reports a commit before an exit as unknown, restarts, and reconciles", async () => {
    const client = await start();
    await expectDatabaseError(client.executeCommand("test.commitThenExit", { name: "committed" }), {
      code: "worker_exited",
      outcome: "unknown",
    });
    await waitFor(() => client.getState() === "ready");
    expect(client.getStatus().generation).toBe(2);
    // Reconcile against durable state instead of retrying the write.
    await expect(client.executeCommand("test.listMarkers", undefined)).resolves.toEqual([
      "committed",
    ]);
  });

  it("stays failed after exhausting restarts", async () => {
    const client = await start({ maxRestarts: 0 });
    await expectDatabaseError(client.executeCommand("test.commitThenExit", { name: "one" }), {
      code: "worker_exited",
    });
    expect(client.getState()).toBe("failed");
    await expectDatabaseError(client.executeCommand("test.listMarkers", undefined), {
      code: "worker_unavailable",
      outcome: "not_committed",
    });
  });

  it("fails startup clearly for a missing database or missing tables", async () => {
    await expect(start({ dbPath: path.join(tmpDir, "missing.db") })).rejects.toThrow(
      /failed to start/,
    );
    await expect(start({ requiredTables: ["worker_test_markers", "absent"] })).rejects.toThrow(
      /missing tables: absent/,
    );
    expect(fs.existsSync(path.join(tmpDir, "missing.db"))).toBe(false);
  });

  it("reports ready only for the schema version the host initialized", async () => {
    await expect(start({ expectedSchemaVersion: 1 })).rejects.toThrow(
      "Database schema version is 0; this worker expects 1",
    );
    const db = new Database(dbPath);
    db.pragma("user_version = 1");
    db.close();
    const client = await start({ expectedSchemaVersion: 1 });
    expect(client.getState()).toBe("ready");
  });

  it("drains accepted work on close and rejects new requests afterwards", async () => {
    const client = await start();
    const writes = ["x", "y", "z"].map((name) =>
      client.executeCommand("test.insertMarker", { name }),
    );
    const closed = client.close();
    await expect(Promise.all(writes)).resolves.toHaveLength(3);
    await expect(closed).resolves.toEqual({ drained: true });
    expect(markers()).toEqual(["x", "y", "z"]);
    await expectDatabaseError(client.executeCommand("test.listMarkers", undefined), {
      code: "closed",
    });
  });

  it("reports an incomplete drain when the close deadline passes", async () => {
    const client = await start();
    const long = client.executeCommand("test.sleep", { ms: 500 });
    const longError = expectDatabaseError(long, { code: "closed", outcome: "not_committed" });
    await expect(client.close(50)).resolves.toEqual({ drained: false });
    await longError;
  });
});

describe("maintenance pilot through the worker", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let client: DatabaseClient | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-db-worker-pilot-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
  });

  afterEach(async () => {
    await client?.close(2_000);
    client = null;
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prunes the same events as the host repository and reads storage stats", async () => {
    const db = manager.getDatabase();
    const workspaces = new WorkspaceStore(db);
    const tasks = new TaskStore(db);
    const events = new TaskEventRepository(db);
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
    const seed = (
      name: string,
      status: "completed" | "executing",
      createdAt: number,
      count: number,
    ) => {
      const workspace = workspaces.create(name, path.join(tmpDir, name), {
        read: true,
        write: true,
        delete: false,
        network: false,
        shell: false,
      });
      const task = tasks.create({ title: name, prompt: name, status, workspaceId: workspace.id });
      db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(createdAt, task.id);
      for (let i = 0; i < count; i += 1) {
        events.create({ taskId: task.id, timestamp: createdAt + i, type: "log", payload: { i } });
      }
      return task.id;
    };
    const oldDone = seed("old-done", "completed", old, 23);
    const oldRunning = seed("old-running", "executing", old, 4);
    const recentDone = seed("recent-done", "completed", Date.now(), 6);

    client = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
    });
    await expect(pruneTaskEventsWithWorker(client, 90, 10)).resolves.toBe(23);

    const remaining = (taskId: string) =>
      (
        db.prepare("SELECT COUNT(*) AS total FROM task_events WHERE task_id = ?").get(taskId) as {
          total: number;
        }
      ).total;
    expect([remaining(oldDone), remaining(oldRunning), remaining(recentDone)]).toEqual([0, 4, 6]);

    const stats = await readStorageStats(client);
    expect(stats.pageSize).toBeGreaterThan(0);
    expect(stats.pageCount).toBeGreaterThan(0);
    expect(stats.freelistBytes).toBe(stats.freelistCount * stats.pageSize);
  });

  it("rejects invalid pilot arguments inside the worker", async () => {
    client = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
    });
    await expectDatabaseError(
      client.execute("maintenance.pruneTaskEventsBatch", { cutoff: Date.now(), batchSize: 0 }),
      { code: "invalid_request", outcome: "not_committed" },
    );
  });
});

import Database from "better-sqlite3";
import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../commands";
import { DatabaseRequestError } from "../protocol";
import { DatabaseManager } from "../../schema";

// Recovery matrix cases the DB7 rollout gate adds to the worker suites (async SQLite
// migration plan, "Verification and release checks"): a full disk, the read-then-write
// snapshot race, two runtimes on one profile, and integrity after a crash. Real worker,
// real SQLite, real messages; no native-module skip guard.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;
let testCommandsModule: string;

const TEST_COMMANDS_SOURCE = `
exports.commands = {
  "test.fillDisk": {
    kind: "write",
    tables: [],
    run(db, args) {
      // Cap the file at its current size, then write past it: SQLITE_FULL mid-transaction.
      const pages = db.pragma("page_count", { simple: true });
      db.pragma("max_page_count = " + pages);
      const insert = db.prepare("INSERT INTO recovery_markers (name, payload) VALUES (?, ?)");
      for (let i = 0; i < args.rows; i += 1) insert.run(args.name + ":" + i, "x".repeat(8192));
      return { inserted: args.rows };
    },
  },
  "test.releaseDisk": {
    kind: "write",
    tables: [],
    run(db) {
      db.pragma("max_page_count = 1073741823");
      return { released: true };
    },
  },
  "test.increment": {
    kind: "write",
    tables: [],
    run(db) {
      // Read, then write from what was read: correct only because a write command runs in
      // an IMMEDIATE transaction, so no other writer commits between the two.
      const row = db.prepare("SELECT value FROM recovery_counter WHERE id = 1").get();
      db.prepare("UPDATE recovery_counter SET value = ? WHERE id = 1").run(row.value + 1);
      return row.value + 1;
    },
  },
  "test.commitThenExit": {
    kind: "write",
    tables: [],
    run(db, args) {
      db.prepare("INSERT INTO recovery_markers (name, payload) VALUES (?, '')").run(args.name);
      db.exec("COMMIT");
      process.exit(0);
    },
  },
};
`;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-recovery-${process.pid}.js`);
  testCommandsModule = path.join(BUILD_DIR, `recovery-commands-${process.pid}.js`);
  buildSync({
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: workerPath,
    external: ["better-sqlite3", "electron"],
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

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("worker recovery matrix", () => {
  let tmpDir: string;
  let dbPath: string;
  let manager: DatabaseManager | null;
  let clients: DatabaseClient[];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-recovery-")));
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    // A real profile: the application schema plus the tables these commands use.
    manager = new DatabaseManager();
    dbPath = manager.getDatabasePath();
    manager.getDatabase().exec(`
      CREATE TABLE recovery_markers (name TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE recovery_counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO recovery_counter (id, value) VALUES (1, 0);
    `);
    clients = [];
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close(2_000)));
    manager?.close();
    manager = null;
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const start = async (options: Partial<Parameters<typeof DatabaseClient.start>[0]> = {}) => {
    const client = await DatabaseClient.start({
      dbPath,
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
      testCommandsModule,
      ...options,
    });
    clients.push(client);
    return client;
  };

  const markerCount = () =>
    (
      manager!.getDatabase().prepare("SELECT COUNT(*) AS n FROM recovery_markers").get() as {
        n: number;
      }
    ).n;

  it("rolls back a write that fills the disk and reports it as not committed", async () => {
    const client = await start();
    const error = await failure(
      client.executeCommand("test.fillDisk" as never, { name: "full", rows: 200 } as never),
    );
    expect(error).toBeInstanceOf(DatabaseRequestError);
    expect(error).toMatchObject({ outcome: "not_committed" });
    expect(String((error as Error).message)).toMatch(/full/i);
    expect(markerCount()).toBe(0);
    // The worker keeps serving once space is available again.
    await client.executeCommand("test.releaseDisk" as never, {} as never);
    await expect(client.executeCommand("test.increment" as never, {} as never)).resolves.toBe(1);
  });

  it("never loses a read-then-write update, even across two runtimes on one profile", async () => {
    const desktop = await start();
    const daemon = await start();
    const increments = Array.from({ length: 60 }, (_value, index) =>
      (index % 2 === 0 ? desktop : daemon).executeCommand("test.increment" as never, {} as never),
    );
    const results = (await Promise.all(increments)) as number[];
    // Every increment saw the previous one: 1..60 exactly once each.
    expect([...results].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 60 }, (_value, index) => index + 1),
    );
    expect(
      manager!.getDatabase().prepare("SELECT value FROM recovery_counter WHERE id = 1").get(),
    ).toEqual({ value: 60 });
  });

  it("shows why writes begin IMMEDIATE: a deferred read-then-write loses to a concurrent commit", async () => {
    const worker = await start();
    const host = new Database(dbPath);
    host.pragma("busy_timeout = 0");
    try {
      host.exec("BEGIN DEFERRED");
      const before = host.prepare("SELECT value FROM recovery_counter WHERE id = 1").get() as {
        value: number;
      };
      await worker.executeCommand("test.increment" as never, {} as never);
      // The snapshot is stale; SQLite refuses the upgrade instead of overwriting the commit.
      expect(() =>
        host.prepare("UPDATE recovery_counter SET value = ? WHERE id = 1").run(before.value + 1),
      ).toThrow(/SQLITE_BUSY|database is locked/);
    } finally {
      if (host.inTransaction) host.exec("ROLLBACK");
      host.close();
    }
    expect(
      manager!.getDatabase().prepare("SELECT value FROM recovery_counter WHERE id = 1").get(),
    ).toEqual({ value: 1 });
  });

  it("runs services units from two runtimes on one profile without double-granting a lock", async () => {
    const desktop = await start();
    const daemon = await start();
    const attempts = Array.from({ length: 20 }, (_value, index) =>
      (index % 2 === 0 ? desktop : daemon).execute("statements.unit", {
        domain: "services",
        name: "hookSession_acquireLock",
        args: ["hook:shared"],
      }),
    );
    const granted = ((await Promise.all(attempts)) as boolean[]).filter(Boolean);
    expect(granted).toHaveLength(1);
  });

  it("keeps the profile consistent after a worker dies right after a commit", async () => {
    const client = await start();
    const error = await failure(
      client.executeCommand("test.commitThenExit" as never, { name: "committed" } as never),
    );
    expect(error).toMatchObject({ code: "worker_exited", outcome: "unknown" });
    await waitFor(() => client.getState() === "ready");
    // Reconcile against durable state, then check the file itself.
    expect(markerCount()).toBe(1);
    const db = manager!.getDatabase();
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

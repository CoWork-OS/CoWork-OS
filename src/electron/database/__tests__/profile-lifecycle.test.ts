import Database from "better-sqlite3";
import { spawn } from "child_process";
import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireMigrationLock,
  beginRuntimeRun,
  CURRENT_SCHEMA_VERSION,
  endRuntimeRun,
  MigrationLockTimeoutError,
  readSchemaVersion,
  UnsupportedSchemaVersionError,
} from "../profile-lifecycle";
import { DatabaseManager } from "../schema";

// Profile lifecycle (async SQLite migration plan, DB6): migration serialization across
// processes, the schema version gate, and run records for incomplete shutdowns.

describe("profile lifecycle", () => {
  let dir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-profile-lifecycle-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = dir;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("migration lock", () => {
    it("is exclusive, and released for the next holder", () => {
      const dbPath = path.join(dir, "p.db");
      const release = acquireMigrationLock(dbPath);
      expect(fs.existsSync(`${dbPath}.migration.lock`)).toBe(true);
      let clock = 0;
      expect(() =>
        acquireMigrationLock(dbPath, {
          timeoutMs: 200,
          now: () => clock,
          sleep: (ms) => {
            clock += ms;
          },
        }),
      ).toThrow(MigrationLockTimeoutError);
      release();
      expect(fs.existsSync(`${dbPath}.migration.lock`)).toBe(false);
      acquireMigrationLock(dbPath)();
    });

    it("breaks a lock whose holder crashed, or that is stale", () => {
      const dbPath = path.join(dir, "p.db");
      const lockPath = `${dbPath}.migration.lock`;
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999_999_999, host: os.hostname(), acquiredAt: Date.now() }),
      );
      acquireMigrationLock(dbPath)();
      // A live holder elsewhere, but older than the stale limit.
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, host: "another-host", acquiredAt: 0 }),
      );
      acquireMigrationLock(dbPath, { staleMs: 1_000 })();
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  describe("schema version", () => {
    it("stamps a new profile and upgrades a pre-versioning one", () => {
      new DatabaseManager().close();
      const dbPath = path.join(dir, "cowork-os.db");
      const probe = new Database(dbPath);
      expect(readSchemaVersion(probe)).toBe(CURRENT_SCHEMA_VERSION);
      probe.pragma("user_version = 0");
      probe.close();
      new DatabaseManager().close();
      const after = new Database(dbPath, { readonly: true });
      expect(readSchemaVersion(after)).toBe(CURRENT_SCHEMA_VERSION);
      after.close();
    });

    it("refuses a newer schema clearly, without touching it or leaving a lock", () => {
      const dbPath = path.join(dir, "cowork-os.db");
      const newer = new Database(dbPath);
      newer.exec("CREATE TABLE from_the_future (id INTEGER)");
      newer.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
      newer.close();
      expect(() => new DatabaseManager()).toThrow(UnsupportedSchemaVersionError);
      const check = new Database(dbPath, { readonly: true });
      const tables = check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(["from_the_future"]);
      check.close();
      expect(fs.existsSync(`${dbPath}.migration.lock`)).toBe(false);
    });
  });

  describe("run records", () => {
    it("reports a run that died and a run whose shutdown did not drain", () => {
      const manager = new DatabaseManager();
      const db = manager.getDatabase();
      try {
        expect(beginRuntimeRun(db, "daemon", { pid: 111, isProcessAlive: () => true })).toEqual([]);
        expect(beginRuntimeRun(db, "cli", { pid: 222, isProcessAlive: () => true })).toEqual([]);
        endRuntimeRun(db, "cli", { clean: false, pid: 222 });
        // Next start: the daemon (111) is gone, the CLI (222) ended incompletely.
        const reported = beginRuntimeRun(db, "desktop", {
          pid: 333,
          isProcessAlive: (pid) => pid === 333,
        });
        expect(reported.map((run) => [run.runtime, run.pid, run.state]).sort()).toEqual([
          ["cli", 222, "incomplete"],
          ["daemon", 111, "running"],
        ]);
        // Reported once.
        expect(beginRuntimeRun(db, "desktop", { pid: 333, isProcessAlive: () => true })).toEqual(
          [],
        );
        endRuntimeRun(db, "desktop", { clean: true, pid: 333 });
        expect(
          db
            .prepare("SELECT COUNT(*) AS n FROM maintenance_state WHERE key LIKE 'runtime_run:%'")
            .get(),
        ).toEqual({ n: 0 });
      } finally {
        manager.close();
      }
    });

    it("closes a run cleanly, or leaves it for the next start to report", () => {
      const first = new DatabaseManager();
      first.beginRun("test");
      first.close({ clean: false });
      const second = new DatabaseManager();
      expect(second.beginRun("test")).toEqual([
        expect.objectContaining({ runtime: "test", pid: process.pid, state: "incomplete" }),
      ]);
      second.close();
      const third = new DatabaseManager();
      expect(third.beginRun("test")).toEqual([]);
      third.close();
    });
  });
});

// Schema initialization in the bootstrap worker (DB6).
describe("schema bootstrap worker", () => {
  const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
  let workerPath: string;
  let dir: string;
  let previousUserDataDir: string | undefined;

  beforeAll(() => {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    workerPath = path.join(BUILD_DIR, `schema-bootstrap-worker-${process.pid}.js`);
    buildSync({
      entryPoints: [path.resolve("src/electron/database/schema-bootstrap-worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: workerPath,
      external: ["better-sqlite3", "electron"],
      logLevel: "silent",
    });
  });

  afterAll(() => {
    fs.rmSync(workerPath, { force: true });
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bootstrap-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = dir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("initializes the schema in the worker, then opens without initializing on the host", async () => {
    const hostInit = vi.spyOn(
      DatabaseManager.prototype as unknown as { initializeSchema: () => void },
      "initializeSchema",
    );
    const manager = await DatabaseManager.open({ bootstrapWorkerPath: workerPath });
    try {
      expect(hostInit).not.toHaveBeenCalled();
      const db = manager.getDatabase();
      expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      manager.close();
    }
  });

  it("carries an unsupported schema version back as its own error", async () => {
    const newer = new Database(path.join(dir, "cowork-os.db"));
    newer.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    newer.close();
    await expect(DatabaseManager.open({ bootstrapWorkerPath: workerPath })).rejects.toBeInstanceOf(
      UnsupportedSchemaVersionError,
    );
  });

  it("initializes in this thread when the worker entry is missing from the build", async () => {
    const manager = await DatabaseManager.open({
      bootstrapWorkerPath: path.join(dir, "missing-worker.js"),
    });
    try {
      expect(readSchemaVersion(manager.getDatabase())).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      manager.close();
    }
  });
});

// Several runtimes opening one fresh profile at the same moment, as separate processes.
describe("simultaneous runtime startup", () => {
  const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
  let entry: string;

  beforeAll(() => {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    const source = path.join(BUILD_DIR, `open-profile-${process.pid}.ts`);
    fs.writeFileSync(
      source,
      `import { DatabaseManager } from ${JSON.stringify(path.resolve("src/electron/database/schema.ts"))};
const manager = new DatabaseManager();
const runs = manager.beginRun("test");
const version = manager.getDatabase().pragma("user_version", { simple: true });
manager.close();
process.stdout.write(JSON.stringify({ version, reported: runs.length }));`,
    );
    entry = path.join(BUILD_DIR, `open-profile-${process.pid}.js`);
    buildSync({
      entryPoints: [source],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: entry,
      external: ["better-sqlite3", "electron"],
      logLevel: "silent",
    });
    fs.rmSync(source, { force: true });
  });

  afterAll(() => {
    fs.rmSync(entry, { force: true });
  });

  it("initializes the schema once at a time and every process opens it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-simultaneous-"));
    try {
      const run = () =>
        new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
          const child = spawn(process.execPath, [entry], {
            env: { ...process.env, COWORK_USER_DATA_DIR: dir, COWORK_LOG_LEVEL: "error" },
            cwd: path.resolve("."),
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.stderr.on("data", (chunk) => (err += chunk));
          child.on("exit", (code) => resolve({ code, out, err }));
        });
      const results = await Promise.all(Array.from({ length: 4 }, run));
      for (const result of results) {
        expect(result.code, result.err).toBe(0);
        expect(JSON.parse(result.out)).toEqual({ version: CURRENT_SCHEMA_VERSION, reported: 0 });
      }
      expect(fs.existsSync(path.join(dir, "cowork-os.db.migration.lock"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

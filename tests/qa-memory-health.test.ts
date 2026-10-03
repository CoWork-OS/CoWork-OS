import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/qa/memory-health.mjs (audit §8.5): Appendix A as a read-only health check. The
// fixture is a real profile DB (DatabaseManager schema) seeded with known rows; the script
// runs as a child process and must never modify the database file.

const SCRIPT = path.resolve("scripts/qa/memory-health.mjs");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

let sqliteLoads = true;
try {
  const Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  sqliteLoads = false;
}

const { DatabaseManager } = sqliteLoads
  ? await import("../src/electron/database/schema")
  : ({} as typeof import("../src/electron/database/schema"));
const { WorkspaceStore } = sqliteLoads
  ? await import("../src/electron/database/repositories")
  : ({} as typeof import("../src/electron/database/repositories"));

type Db = import("better-sqlite3").Database;

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function fingerprint(dbPath: string) {
  const stat = fs.statSync(dbPath);
  return {
    sha: sha256(dbPath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    siblings: fs.readdirSync(path.dirname(dbPath)).sort(),
  };
}

function runScript(args: string[], env: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, COWORK_DB_PATH: "", ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runJson(args: string[]) {
  const result = runScript([...args, "--json"]);
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

describe.skipIf(!sqliteLoads)("qa memory-health script", () => {
  const cleanups: Array<() => void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  /** Create a real profile DB, seed it, close it, and return its path. */
  function buildProfile(seed: (db: Db, workspaceId: string, now: number) => void): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-health-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("W", path.join(dir, "w"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    seed(db, workspace.id, Date.now());
    manager.close();
    return path.join(dir, "cowork-os.db");
  }

  let seq = 0;
  const addMemory = (db: Db, workspaceId: string, content: string, createdAt: number) => {
    seq += 1;
    db.prepare(
      `INSERT INTO memories (id, workspace_id, type, content, tokens, created_at, updated_at)
       VALUES (?, ?, 'observation', ?, 1, ?, ?)`,
    ).run(`m${seq}`, workspaceId, content, createdAt, createdAt);
    return `m${seq}`;
  };
  const addItem = (
    db: Db,
    workspaceId: string,
    item: { kind: string; hash: string; status?: string; pinned?: number; source?: string },
    now: number,
  ) => {
    seq += 1;
    db.prepare(
      `INSERT INTO memory_items (id, workspace_id, scope, scope_ref, kind, subject_key, content,
         source, trust, status, pinned, content_hash, created_at, updated_at)
       VALUES (?, ?, 'workspace', NULL, ?, ?, 'x', ?, 1, ?, ?, ?, ?, ?)`,
    ).run(
      `i${seq}`,
      workspaceId,
      item.kind,
      `${item.kind}:${item.hash}:${seq}`,
      item.source ?? "user_stated",
      item.status ?? "active",
      item.pinned ?? 0,
      item.hash,
      now,
      now,
    );
  };
  const addHeartbeat = (db: Db, runType: string, status: string, startedAt: number) => {
    seq += 1;
    db.prepare(
      `INSERT INTO heartbeat_runs (id, run_type, status, created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`h${seq}`, runType, status, startedAt, startedAt, startedAt);
  };

  function dirtyProfile() {
    return buildProfile((db, ws, now) => {
      const old = now - 8 * DAY;
      // 10 archive rows: 4 raw_event + 1 core_trace = 50% telemetry; 2 duplicate rows.
      const first = addMemory(db, ws, "Tool called: read_file", old);
      addMemory(db, ws, "Tool called: read_file", now);
      addMemory(db, ws, "Step completed: build", old);
      addMemory(db, ws, '{"taskId":"t1","event":"x"}', now);
      addMemory(db, ws, "[core-trace:abc] trace", now);
      addMemory(db, ws, "[SUGGESTION] {}", now);
      addMemory(db, ws, "[PLAYBOOK] deploy", old);
      addMemory(db, ws, "User prefers tabs", now);
      addMemory(db, ws, "  user prefers TABS ", now);
      addMemory(db, ws, "Deploys happen on Fridays", now);

      db.prepare(
        "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES (?, ?, '[]', ?)",
      ).run(first, ws, now);
      db.pragma("foreign_keys = OFF");
      db.prepare(
        "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES ('gone', ?, '[]', ?)",
      ).run(ws, now);
      db.pragma("foreign_keys = ON");

      addHeartbeat(db, "dispatch", "running", now - 2 * HOUR); // stuck
      addHeartbeat(db, "dispatch", "running", now - 5 * 60 * 1000); // still fresh
      addHeartbeat(db, "pulse", "completed", now - 3 * HOUR);

      addItem(db, ws, { kind: "preference", hash: "a", pinned: 1 }, now);
      addItem(db, ws, { kind: "preference", hash: "b", source: "inferred" }, now);
      addItem(db, ws, { kind: "rule", hash: "a" }, now);
      addItem(db, ws, { kind: "preference", hash: "a", status: "superseded" }, now);

      for (const [i, status] of ["rejected", "rejected", "pending"].entries()) {
        db.prepare(
          `INSERT INTO pending_memory_writes (id, workspace_id, target, action, origin, summary,
             payload_json, status, created_at)
           VALUES (?, ?, 'memory', 'add', 'auto_capture', 's', '{}', ?, ?)`,
        ).run(`p${i}`, ws, status, now);
      }
      db.prepare(
        `INSERT INTO memory_markdown_files (workspace_id, path, content_hash, mtime, size, updated_at)
         VALUES (?, '.cowork/.history/a.md', 'h', 0, 1, 0), (?, '.cowork/.history/b.md', 'h', 0, 1, 0),
                (?, '.cowork/memory/MEMORY.md', 'h', 0, 1, 0), (?, 'notes/x.md', 'h', 0, 1, 0),
                (?, 'LORE.md', 'h', 0, 1, 0)`,
      ).run(ws, ws, ws, ws, ws);
    });
  }

  function cleanProfile() {
    return buildProfile((db, ws, now) => {
      addMemory(db, ws, "User prefers tabs", now);
      addMemory(db, ws, "Deploys happen on Fridays", now);
      addItem(db, ws, { kind: "preference", hash: "a" }, now);
      addItem(db, ws, { kind: "rule", hash: "b" }, now);
      addHeartbeat(db, "pulse", "completed", now - 3 * HOUR);
    });
  }

  it("reports the seeded numbers and never writes the database", () => {
    const dbPath = dirtyProfile();
    const before = fingerprint(dbPath);

    const { status, json, stderr } = runJson(["--db", dbPath]);
    expect(stderr).toBe("");
    expect(status).toBe(0); // report only: no thresholds
    expect(json.db.mode).toBe("snapshot");
    expect(json.checks).toEqual([]);

    const { report } = json;
    expect(report.stores.totalBytes).toBe(before.size);
    expect(["ok", "unavailable"]).toContain(report.stores.dbstat);
    expect(report.archive).toMatchObject({
      total: 10,
      olderThan7d: 3,
      last7d: 7,
      kinds: { raw_event: 4, core_trace: 1, suggestion: 1, playbook: 1, other: 3 },
      telemetryRows: 5,
      telemetryRatio: 0.5,
      duplicateRows: 2,
      duplicateRate: 0.2,
    });
    expect(report.memoryItems).toMatchObject({
      total: 4,
      active: 3,
      pinned: 1,
      duplicateRows: 0,
      duplicateRate: 0,
    });
    expect(report.memoryItems.activeByKind).toEqual([
      { value: "preference", n: 2 },
      { value: "rule", n: 1 },
    ]);
    expect(report.embeddings).toMatchObject({ total: 2, orphans: 1, orphanRate: 0.5 });
    expect(report.heartbeat.stuck).toBe(1);
    expect(report.heartbeat.stuckByType).toEqual([{ runType: "dispatch", n: 1 }]);
    expect(report.pendingWrites).toMatchObject({ total: 3, pending: 1 });
    expect(report.markdownFiles.total).toBe(5);
    expect(report.markdownFiles.byTopSegment).toEqual([
      { segment: ".cowork/.history/", n: 2 },
      expect.anything(),
      expect.anything(),
      expect.anything(),
    ]);
    expect(
      Object.fromEntries(
        report.markdownFiles.byTopSegment.map((r: { segment: string; n: number }) => [
          r.segment,
          r.n,
        ]),
      ),
    ).toEqual({ ".cowork/.history/": 2, ".cowork/memory/": 1, "notes/": 1, "(files)": 1 });
    expect(report.curated.status).toBe("ok");
    expect(report.maintenance.markers.map((m: { key: string }) => m.key)).toContain(
      "memory_items_lane_migration_v1",
    );

    // Human output prints the same figures.
    const human = runScript(["--db", dbPath]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("telemetry ratio 50.0%");
    expect(human.stdout).toContain("stuck running 1");

    expect(fingerprint(dbPath)).toEqual(before);
  });

  it("exits 1 and names the failed checks when a threshold is breached", () => {
    const dbPath = dirtyProfile();
    const before = fingerprint(dbPath);

    const ci = runJson(["--db", dbPath, "--ci"]);
    expect(ci.status).toBe(1);
    expect(ci.json.ok).toBe(false);
    const byName = Object.fromEntries(
      ci.json.checks.map((c: { name: string; status: string }) => [c.name, c.status]),
    );
    expect(byName).toEqual({
      "archive telemetry ratio": "fail",
      "archive duplicate rate": "fail",
      "memory_items duplicate rate": "pass",
      "stuck heartbeat runs": "fail",
    });

    const human = runScript([
      "--db",
      dbPath,
      "--max-orphan-embeddings",
      "0",
      "--min-memory-items=5",
    ]);
    expect(human.status).toBe(1);
    expect(human.stdout).toContain("FAILED: orphan embeddings, active memory_items");

    // A longer stuck window and looser limits pass.
    const loose = runJson([
      "--db",
      dbPath,
      "--stuck-after",
      "3h",
      "--max-stuck-heartbeat",
      "0",
      "--max-telemetry-ratio",
      "0.5",
      "--max-orphan-embeddings",
      "1",
    ]);
    expect(loose.status).toBe(0);
    expect(loose.json.report.heartbeat.stuck).toBe(0);

    expect(fingerprint(dbPath)).toEqual(before);
  });

  it("exits 0 with --ci on a clean profile", () => {
    const dbPath = cleanProfile();
    const before = fingerprint(dbPath);
    const { status, json } = runJson(["--db", dbPath, "--ci", "--min-memory-items", "2"]);
    expect(status).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.checks.every((c: { status: string }) => c.status === "pass")).toBe(true);
    expect(fingerprint(dbPath)).toEqual(before);
  });

  it("opens the file directly without writing it", () => {
    const dbPath = dirtyProfile();
    const before = fingerprint(dbPath);
    const { status, json } = runJson(["--db", dbPath, "--snapshot-limit-mb", "0"]);
    expect(status).toBe(0);
    expect(json.db.mode).toBe("readonly");
    expect(json.report.archive.total).toBe(10);
    const after = fingerprint(dbPath);
    expect({ ...after, siblings: undefined }).toEqual({ ...before, siblings: undefined });
    // SQLite may create empty WAL side files for a reader; they are reported, left in place
    // (never deleted, which could race with the app) and stay empty.
    const created: string[] = json.db.sideFilesCreated;
    expect(after.siblings).toEqual([...before.siblings, ...created].sort());
    for (const name of created) {
      if (name.endsWith("-wal"))
        expect(fs.statSync(path.join(path.dirname(dbPath), name)).size).toBe(0);
    }
  });

  it("reads alongside a live writer without changing the database or its WAL", async () => {
    const dbPath = cleanProfile();
    const Database = (await import("better-sqlite3")).default;
    const writer = new Database(dbPath);
    cleanups.push(() => writer.close());
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_autocheckpoint = 0");
    const ws = (writer.prepare("SELECT id FROM workspaces LIMIT 1").get() as { id: string }).id;
    writer
      .prepare(
        `INSERT INTO memories (id, workspace_id, type, content, tokens, created_at, updated_at)
         VALUES ('live', ?, 'observation', 'Tool called: x', 1, ?, ?)`,
      )
      .run(ws, Date.now(), Date.now());
    const walPath = `${dbPath}-wal`;
    expect(fs.statSync(walPath).size).toBeGreaterThan(0);
    const mainBefore = sha256(dbPath);
    const walBefore = sha256(walPath);

    const { status, json } = runJson(["--db", dbPath]);
    expect(status).toBe(0);
    expect(json.db.mode).toBe("readonly");
    expect(json.report.archive.total).toBe(3); // includes the row that is only in the WAL
    expect(sha256(dbPath)).toBe(mainBefore);
    expect(sha256(walPath)).toBe(walBefore);
  });

  it("reports missing tables instead of failing, and skips their checks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-health-bare-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "bare.db");
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath);
    db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT, created_at INTEGER)");
    db.prepare("INSERT INTO memories VALUES ('a', 'Tool called: x', ?)").run(Date.now());
    db.close();
    const before = fingerprint(dbPath);

    const { status, json } = runJson(["--db", dbPath, "--ci", "--min-memory-items", "1"]);
    expect(json.report.memoryItems).toEqual({ status: "missing", table: "memory_items" });
    expect(json.report.heartbeat).toEqual({ status: "missing", table: "heartbeat_runs" });
    expect(json.report.archive).toMatchObject({
      total: 1,
      telemetryRatio: 1,
      byTierAge: "missing",
    });
    const skipped = json.checks
      .filter((c: { status: string }) => c.status === "skip")
      .map((c: { name: string }) => c.name);
    expect(skipped).toEqual([
      "memory_items duplicate rate",
      "stuck heartbeat runs",
      "active memory_items",
    ]);
    expect(status).toBe(1); // telemetry 100%
    expect(fingerprint(dbPath)).toEqual(before);
  });

  it("exits 2 on a missing database or bad usage", () => {
    const missing = runScript(["--db", path.join(os.tmpdir(), "no-such-cowork.db")]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("database not found");
    expect(runScript(["--max-telemetry-ratio", "2"]).status).toBe(2);
    expect(runScript(["--nope"]).status).toBe(2);
    const help = runScript(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--max-duplicate-rate");
  });
});

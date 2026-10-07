import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

/** Tables retired by LegacyMemoryRetirement.ts; a fresh profile must not create them. */
const RETIRED =
  /^(curated_memory_entries|memory_summaries|heartbeat_policies|improvement_.*|transcript_spans.*|transcript_span_index_gap|transcript_store_meta)$/;

describeWithSqlite("DatabaseManager schema without the retired legacy memory tables", () => {
  let tmpDir: string;
  let dbPath: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-legacy-memory-"));
    dbPath = path.join(tmpDir, "cowork-os.db");
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const schemaObjects = () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare("SELECT type, name FROM sqlite_master").all() as Array<{
        type: string;
        name: string;
      }>;
    } finally {
      db.close();
    }
  };

  it("does not create them on a fresh install, and a restart does not either", async () => {
    const { DatabaseManager } = await import("../schema");
    new DatabaseManager().close();
    new DatabaseManager().close();

    const objects = schemaObjects();
    expect(objects.filter((object) => RETIRED.test(object.name))).toEqual([]);
    expect(
      objects.filter(
        (object) =>
          object.type === "index" &&
          /curated_memory|memory_summaries|heartbeat_policies|improvement_/.test(object.name),
      ),
    ).toEqual([]);
    // Still created: the pending-write staging table (MemoryWriteGate) and automation profiles.
    expect(objects.map((object) => object.name)).toEqual(
      expect.arrayContaining(["pending_memory_writes", "automation_profiles", "memory_items"]),
    );
  });

  it("does not recreate them after they were dropped from an older profile", async () => {
    const { DatabaseManager } = await import("../schema");
    new DatabaseManager().close();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE curated_memory_entries (id TEXT PRIMARY KEY);
      CREATE TABLE improvement_candidates (id TEXT PRIMARY KEY);
    `);
    legacy.exec("DROP TABLE curated_memory_entries; DROP TABLE improvement_candidates;");
    legacy.close();

    new DatabaseManager().close();

    expect(schemaObjects().filter((object) => RETIRED.test(object.name))).toEqual([]);
  });

  it("gives roles an automation profile from their heartbeat columns, or a legacy policy row", async () => {
    const { DatabaseManager } = await import("../schema");
    new DatabaseManager().close();
    const db = new Database(dbPath);
    const insertRole = db.prepare(
      `INSERT INTO agent_roles (id, name, display_name, capabilities, heartbeat_enabled,
         heartbeat_pulse_every_minutes, heartbeat_profile, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?, 'observer', 1, 1)`,
    );
    insertRole.run("role-live", "live-role", "Live", 1, 30);
    insertRole.run("role-legacy", "legacy-role", "Legacy", 0, 15);
    insertRole.run("role-twin", "twin-sam", "Twin", 1, 15);
    db.exec(`
      CREATE TABLE heartbeat_policies (
        id TEXT PRIMARY KEY,
        agent_role_id TEXT NOT NULL UNIQUE REFERENCES agent_roles(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        cadence_minutes INTEGER NOT NULL DEFAULT 15,
        stagger_offset_minutes INTEGER NOT NULL DEFAULT 0,
        dispatch_cooldown_minutes INTEGER NOT NULL DEFAULT 120,
        max_dispatches_per_day INTEGER NOT NULL DEFAULT 6,
        profile TEXT NOT NULL DEFAULT 'observer',
        active_hours TEXT,
        primary_categories TEXT,
        proactive_tasks TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO heartbeat_policies (id, agent_role_id, enabled, cadence_minutes, profile,
        created_at, updated_at)
      VALUES ('hp-1', 'role-legacy', 1, 45, 'operator', 1, 1);
    `);
    db.prepare("DELETE FROM automation_profiles").run();
    db.close();

    new DatabaseManager().close();

    const reopened = new Database(dbPath, { readonly: true });
    const profiles = reopened
      .prepare(
        "SELECT agent_role_id, enabled, cadence_minutes, profile FROM automation_profiles ORDER BY agent_role_id",
      )
      .all();
    reopened.close();
    expect(profiles).toEqual([
      { agent_role_id: "role-legacy", enabled: 1, cadence_minutes: 45, profile: "operator" },
      { agent_role_id: "role-live", enabled: 1, cadence_minutes: 30, profile: "observer" },
    ]);
  });
});

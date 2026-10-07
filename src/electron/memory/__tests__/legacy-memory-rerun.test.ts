import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AwarenessBelief, UserFact } from "../../../shared/types";
import {
  LEGACY_MEMORY_RERUN_KEY,
  LEGACY_MEMORY_RETIREMENT_KEY,
  rearmLegacyMemoryRetirement,
  runLegacyMemoryRetirement,
  type LegacySettingsAccess,
  type LegacySettingsCategory,
} from "../LegacyMemoryRetirement";
import type { LegacyLaneSources } from "../MemoryItemsLaneMigration";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter } from "../MemoryWriter";
import { runMemoryItemsLaneMigrationNow } from "../memory-engine-bootstrap";
import { MEMORY_ITEMS_LANE_MIGRATION_KEY } from "../memory-items-sql";
import { createMemoryStatementPort, type MemoryStatementPort } from "../memory-statement-port";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const fact = (id: string, value: string, lastUpdatedAt: number): UserFact => ({
  id,
  category: "preference",
  value,
  confidence: 0.9,
  source: "manual",
  firstSeenAt: lastUpdatedAt,
  lastUpdatedAt,
});

const BELIEF: AwarenessBelief = {
  id: "b-1",
  beliefType: "user_preference",
  subject: "response_length",
  value: "Prefers concise responses.",
  confidence: 0.88,
  evidenceRefs: [],
  source: "conversation",
  promotionStatus: "promoted",
  createdAt: 5,
  updatedAt: 5,
};

/**
 * Settings blobs as the retirement and the lane migration read them, mirrored into a
 * `secure_settings` table (category only) the way the re-arm check sees them.
 */
class FakeSettings implements LegacySettingsAccess {
  values = new Map<string, unknown>();
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE secure_settings (id TEXT PRIMARY KEY, category TEXT NOT NULL UNIQUE,
      encrypted_data TEXT NOT NULL, checksum TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
  }
  set(category: string, value: unknown) {
    this.values.set(category, value);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO secure_settings (id, category, encrypted_data, checksum,
           created_at, updated_at) VALUES (?, ?, 'x', 'x', 1, 1)`,
      )
      .run(category, category);
  }
  load(category: LegacySettingsCategory) {
    return this.values.has(category)
      ? { status: "success", data: structuredClone(this.values.get(category)) }
      : { status: "not_found" };
  }
  deleteIfUnchanged(category: LegacySettingsCategory, expected: unknown) {
    if (!this.values.has(category)) return true;
    if (JSON.stringify(this.values.get(category)) !== JSON.stringify(expected)) return false;
    this.values.delete(category);
    this.db.prepare("DELETE FROM secure_settings WHERE category = ?").run(category);
    return true;
  }
  subconsciousMigrationDone() {
    return true;
  }
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text).toString("base64")}`),
  decryptString: (data: Buffer) => Buffer.from(data.toString().slice(4), "base64").toString("utf8"),
};

/** The curated table as the older release recreates it. */
function recreateCuratedTable(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS curated_memory_entries (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT, target TEXT NOT NULL,
    kind TEXT NOT NULL, content TEXT NOT NULL, normalized_key TEXT NOT NULL, source TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7, status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_confirmed_at INTEGER)`);
}

function insertCurated(db: Database.Database, id: string, content: string, at: number) {
  db.prepare(
    `INSERT INTO curated_memory_entries (id, workspace_id, task_id, target, kind, content,
       normalized_key, source, confidence, status, created_at, updated_at)
     VALUES (?, 'ws-1', NULL, 'workspace', 'project_fact', ?, ?, 'user_edit', 0.85, 'active', ?, ?)`,
  ).run(id, content, `k-${id}`, at, at);
}

function hasKey(db: Database.Database, key: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM maintenance_state WHERE key = ?").get(key));
}

function refRows(db: Database.Database, store: string, id: string) {
  return rowsOf(
    db,
    "json_extract(source_ref, '$.store') = ? AND json_extract(source_ref, '$.id') = ?",
    store,
    id,
  );
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

describeWithSqlite("legacy memory re-run after a downgrade", () => {
  let db: Database.Database;
  let port: MemoryStatementPort;
  let writer: MemoryWriter;
  let settings: FakeSettings;
  let tmpRoot: string;
  let backupDir: string;
  let clock: number;
  let beliefs: AwarenessBelief[];

  const sources = (): LegacyLaneSources => ({
    userProfileFacts: () =>
      (settings.load("user-profile").data as { facts?: UserFact[] } | undefined)?.facts ?? [],
    relationshipItems: () => [],
    awarenessBeliefs: () => beliefs,
    adaptiveResponseStyle: () => null,
    userName: () => undefined,
  });
  const migrateLanes = () =>
    runMemoryItemsLaneMigrationNow(writer, port, {
      waitMs: 0,
      loadSources: async () => sources(),
    });
  const retire = () =>
    runLegacyMemoryRetirement({
      port,
      writer,
      settings,
      encryption: fakeSafeStorage,
      backupDir,
      now: () => clock,
      owner: "test-owner",
    });
  const rearm = () => rearmLegacyMemoryRetirement(port, () => clock);
  const backups = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : []);

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1"]);
    port = createMemoryStatementPort(db);
    writer = new MemoryWriter({ repository: new MemoryItemsRepository(db) });
    settings = new FakeSettings(db);
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-legacy-rerun-"));
    backupDir = path.join(tmpRoot, "backups");
    clock = 1_700_000_000_000;
    beliefs = [BELIEF];

    // The first upgrade: migrate, then retire.
    insertCurated(db, "c-old", "The release train ships on Thursdays", 10);
    settings.set("user-profile", { facts: [fact("f-old", "Prefers metric units", 11)] });
    await migrateLanes();
    expect((await retire()).status).toBe("retired");
    expect(tableExists(db, "curated_memory_entries")).toBe(false);
    expect(settings.values.has("user-profile")).toBe(false);
    // The memory folder then held the belief and retired its row.
    const beliefRow = refRows(db, "awareness", "b-1")[0];
    await writer.setStatus(String(beliefRow.id), "deleted");
    clock += 60_000;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("does not re-run when no legacy data reappeared", async () => {
    // An older release recreates the table but stores nothing.
    recreateCuratedTable(db);
    expect(await rearm()).toEqual({ rearmed: false });
    expect(hasKey(db, MEMORY_ITEMS_LANE_MIGRATION_KEY)).toBe(true);
    expect(hasKey(db, LEGACY_MEMORY_RETIREMENT_KEY)).toBe(true);
    expect(hasKey(db, LEGACY_MEMORY_RERUN_KEY)).toBe(false);
    const before = rowsOf(db);
    await migrateLanes();
    expect((await retire()).status).toBe("done");
    expect(rowsOf(db)).toEqual(before);
    expect(backups()).toHaveLength(1);
  });

  it("migrates and retires reappeared facts once, without duplicating migrated ones", async () => {
    // The older release recreates its stores and writes to them.
    recreateCuratedTable(db);
    insertCurated(db, "c-new", "The QA lab moved to floor four", 20);
    settings.set("user-profile", {
      facts: [
        fact("f-old", "Prefers metric units", 11),
        fact("f-new", "Prefers tabs over spaces", 21),
      ],
    });

    const rearmed = await rearm();
    expect(rearmed).toMatchObject({
      rearmed: true,
      curatedRows: 1,
      settings: ["user-profile"],
    });
    expect(hasKey(db, MEMORY_ITEMS_LANE_MIGRATION_KEY)).toBe(false);
    expect(hasKey(db, LEGACY_MEMORY_RETIREMENT_KEY)).toBe(false);
    // Exactly one re-run: a second start (or the other process) finds nothing to re-arm.
    expect(await rearm()).toEqual({ rearmed: false });
    const request = await port.unit("legacyRetirement_rerunRequest", {});
    expect(request).toMatchObject({ requestedAt: clock, laneMigrationDone: false });

    await migrateLanes();
    expect(hasKey(db, MEMORY_ITEMS_LANE_MIGRATION_KEY)).toBe(true);
    expect(await port.unit("legacyRetirement_rerunRequest", {})).toMatchObject({
      token: rearmed.rearmed ? rearmed.token : "",
      laneMigrationDone: true,
    });
    // New facts arrive; migrated ones are not copied again.
    expect(refRows(db, "curated", "c-new").map((row) => row.status)).toEqual(["active"]);
    expect(refRows(db, "user_profile", "f-new").map((row) => row.status)).toEqual(["active"]);
    expect(refRows(db, "curated", "c-old")).toHaveLength(1);
    expect(refRows(db, "user_profile", "f-old")).toHaveLength(1);
    // Kept lanes are not re-read: the belief the folder retired stays retired.
    expect(refRows(db, "awareness", "b-1").map((row) => row.status)).toEqual(["deleted"]);
    expect(rowsOf(db, "content = ?", BELIEF.value)).toHaveLength(0);

    clock += 1000;
    const result = await retire();
    expect(result.status).toBe("retired");
    if (result.status !== "retired") return;
    expect(result.counts).toMatchObject({ curatedRows: 1, profileFacts: 2, missing: 0 });
    expect(result.settingsDeleted).toEqual(["user-profile"]);
    expect(tableExists(db, "curated_memory_entries")).toBe(false);
    expect(settings.values.has("user-profile")).toBe(false);
    // A fresh backup holds the reappeared facts; the first one is kept.
    const files = backups();
    expect(files).toHaveLength(2);
    const fresh = JSON.parse(
      fakeSafeStorage.decryptString(fs.readFileSync(path.join(backupDir, files[1]))),
    );
    expect(fresh.curatedMemoryEntries.map((row: { id: string }) => row.id)).toEqual(["c-new"]);

    // Markers are set again, and the next start re-arms nothing.
    expect(hasKey(db, MEMORY_ITEMS_LANE_MIGRATION_KEY)).toBe(true);
    expect(hasKey(db, LEGACY_MEMORY_RETIREMENT_KEY)).toBe(true);
    expect(await rearm()).toEqual({ rearmed: false });
    expect((await retire()).status).toBe("done");
  });

  it("re-arms on a reappeared settings blob alone and keeps nothing unreadable", async () => {
    settings.set("user-profile", { facts: [fact("f-new", "Prefers tabs over spaces", 21)] });
    expect(await rearm()).toMatchObject({ rearmed: true, curatedRows: 0 });
    // The retirement waits for the lane migration of the re-run.
    expect((await retire()).status).toBe("not_ready");
    await migrateLanes();
    settings.load = (category) =>
      category === "user-profile" ? { status: "decrypt_failed" } : { status: "not_found" };
    const aborted = await retire();
    expect(aborted).toMatchObject({ status: "aborted", reason: "settings_unreadable" });
    expect(settings.values.has("user-profile")).toBe(true);
    expect(hasKey(db, LEGACY_MEMORY_RETIREMENT_KEY)).toBe(false);
  });

  it("consumes only the request it read", async () => {
    settings.set("relationship-memory", { items: [] });
    const first = await rearm();
    if (!first.rearmed) throw new Error("expected a re-arm");
    expect(await port.unit("legacyRetirement_consumeRerun", { token: "other" })).toBe(false);
    expect(await port.unit("legacyRetirement_consumeRerun", { token: first.token })).toBe(true);
    expect(await port.unit("legacyRetirement_rerunRequest", {})).toBeNull();
  });
});

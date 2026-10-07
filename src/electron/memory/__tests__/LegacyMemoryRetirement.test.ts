import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_MEMORY_RETIREMENT_KEY,
  legacyProfileFacts,
  legacyRelationshipItems,
  runLegacyMemoryRetirement,
  type LegacyMemoryRetirementDeps,
  type LegacySettingsAccess,
  type LegacySettingsCategory,
} from "../LegacyMemoryRetirement";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter, type MemoryCandidate } from "../MemoryWriter";
import { maintenanceClaimKey } from "../maintenance-claim-sql";
import {
  curatedEntryCandidate,
  relationshipItemCandidate,
  userFactCandidate,
} from "../memory-items-lanes";
import { createMemoryStatementPort } from "../memory-statement-port";
import { LEGACY_TRANSCRIPT_SPANS_MIGRATED_KEY } from "../legacy-memory-retirement-sql";
import { ensureTranscriptSchema } from "../transcript-sql";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const PROFILE = {
  facts: [
    {
      id: "f-pin",
      category: "preference",
      value: "Prefers dark mode",
      confidence: 0.9,
      source: "manual",
      pinned: true,
      firstSeenAt: 10,
      lastUpdatedAt: 10,
    },
    {
      id: "f-name",
      category: "identity",
      value: "Preferred name: Sam",
      confidence: 0.8,
      source: "conversation",
      firstSeenAt: 11,
      lastUpdatedAt: 11,
    },
  ],
  updatedAt: 11,
};

const RELATIONSHIP = {
  items: [
    {
      id: "r-pref",
      layer: "preferences",
      text: "Likes morning meetings",
      confidence: 0.7,
      source: "conversation",
      createdAt: 20,
      updatedAt: 20,
    },
    {
      id: "r-history",
      layer: "history",
      text: "Finished the quarterly report",
      confidence: 0.7,
      source: "task",
      createdAt: 21,
      updatedAt: 21,
    },
    {
      // A legacy `task` commitment was mail text: it must stay third-party.
      id: "r-mail",
      layer: "commitments",
      text: "Send the contract to Dana",
      confidence: 0.7,
      source: "task",
      createdAt: 22,
      updatedAt: 22,
      status: "open",
    },
  ],
  updatedAt: 22,
};

const ADAPTIVE = { adaptationHistory: [{ reason: "short replies" }], weeklyAdaptationCount: 1 };
const AWARENESS = { beliefs: [{ id: "b1", beliefType: "user_preference", value: "Tea" }] };

class FakeSettings implements LegacySettingsAccess {
  values = new Map<string, unknown>();
  statuses = new Map<string, string>();
  subconsciousDone = true;
  load(category: LegacySettingsCategory) {
    const status = this.statuses.get(category);
    if (status) return { status };
    return this.values.has(category)
      ? { status: "success", data: structuredClone(this.values.get(category)) }
      : { status: "not_found" };
  }
  deleteIfUnchanged(category: LegacySettingsCategory, expected: unknown) {
    if (!this.values.has(category)) return true;
    if (JSON.stringify(this.values.get(category)) !== JSON.stringify(expected)) return false;
    this.values.delete(category);
    return true;
  }
  subconsciousMigrationDone() {
    return this.subconsciousDone;
  }
}

/** Reversible stand-in for safeStorage. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text).toString("base64")}`),
  decryptString: (data: Buffer) => Buffer.from(data.toString().slice(4), "base64").toString("utf8"),
};

function insertCurated(
  db: Database.Database,
  id: string,
  content: string,
  overrides: { status?: string; workspaceId?: string; updatedAt?: number } = {},
) {
  db.prepare(
    `INSERT INTO curated_memory_entries (id, workspace_id, task_id, target, kind, content,
       normalized_key, source, confidence, status, created_at, updated_at)
     VALUES (?, ?, NULL, 'workspace', 'workflow_rule', ?, ?, 'user_edit', 0.85, ?, 5, ?)`,
  ).run(
    id,
    overrides.workspaceId ?? "ws-1",
    content,
    `k-${id}`,
    overrides.status ?? "active",
    overrides.updatedAt ?? 5,
  );
}

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function marker(db: Database.Database): Record<string, unknown> | null {
  const row = db
    .prepare("SELECT value FROM maintenance_state WHERE key = ?")
    .get(LEGACY_MEMORY_RETIREMENT_KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
}

/** The legacy tables an older profile carries. */
function addLegacyTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE agent_roles (id TEXT PRIMARY KEY);
    INSERT INTO agent_roles (id) VALUES ('role-1');
    CREATE TABLE memory_summaries (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id));
    CREATE INDEX idx_memory_summaries_workspace ON memory_summaries(workspace_id);
    INSERT INTO memory_summaries (id, workspace_id) VALUES ('s1', 'ws-1');
    CREATE TABLE heartbeat_policies (id TEXT PRIMARY KEY,
      agent_role_id TEXT NOT NULL UNIQUE REFERENCES agent_roles(id) ON DELETE CASCADE);
    INSERT INTO heartbeat_policies (id, agent_role_id) VALUES ('hp1', 'role-1');
    CREATE TABLE improvement_candidates (id TEXT PRIMARY KEY);
    CREATE TABLE improvement_runs (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL,
      FOREIGN KEY (candidate_id) REFERENCES improvement_candidates(id) ON DELETE CASCADE);
    INSERT INTO improvement_candidates (id) VALUES ('c1');
    INSERT INTO improvement_runs (id, candidate_id) VALUES ('run1', 'c1');
    CREATE TABLE pending_memory_writes (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
      status TEXT NOT NULL);
    INSERT INTO pending_memory_writes VALUES ('p1', '{"secret":"x"}', 'pending');
    INSERT INTO pending_memory_writes VALUES ('p2', '{}', 'rejected');
    INSERT INTO pending_memory_writes VALUES ('p3', '{}', 'applied');
    CREATE TABLE durable_context_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at INTEGER NOT NULL);
    CREATE TRIGGER curated_touch_workspace AFTER DELETE ON workspaces BEGIN
      DELETE FROM curated_memory_entries WHERE workspace_id = OLD.id;
    END;
  `);
  ensureTranscriptSchema(db);
  db.prepare(
    `INSERT INTO transcript_spans (id, workspace_path, task_id, timestamp, type, payload_json,
       raw_line, search_text, created_at) VALUES ('sp1', '/w', 't1', 1, 'x', '{}', 'l', 's', 1)`,
  ).run();
}

describeWithSqlite("legacy memory retirement", () => {
  let db: Database.Database;
  let writer: MemoryWriter;
  let settings: FakeSettings;
  let backupDir: string;
  let tmpRoot: string;

  const deps = (
    overrides: Partial<LegacyMemoryRetirementDeps> = {},
  ): LegacyMemoryRetirementDeps => ({
    port: createMemoryStatementPort(db),
    writer,
    settings,
    encryption: fakeSafeStorage,
    backupDir,
    now: () => 1_700_000_000_000,
    owner: "test-owner",
    ...overrides,
  });

  const backups = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : []);

  /** What the lane migration would have written. */
  const migrateLanes = async (options: { skipCurated?: boolean } = {}) => {
    if (!options.skipCurated) {
      const rows = db
        .prepare("SELECT * FROM curated_memory_entries WHERE status = 'active'")
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        await writer.ingest(
          curatedEntryCandidate(
            {
              id: String(row.id),
              workspaceId: String(row.workspace_id),
              target: "workspace",
              kind: "workflow_rule",
              content: String(row.content),
              source: "user_edit",
              confidence: 0.85,
            },
            "migration",
          ),
        );
      }
    }
    for (const fact of legacyProfileFacts(settings.values.get("user-profile"))) {
      const candidate = userFactCandidate(fact, { mode: "migration" });
      if (candidate) await writer.ingest(candidate);
    }
    for (const item of legacyRelationshipItems(settings.values.get("relationship-memory"))) {
      const candidate = relationshipItemCandidate(item, "migration");
      if (candidate) await writer.ingest(candidate);
    }
  };
  const markLaneMigrationDone = () =>
    new MemoryItemsRepository(db).recordLaneMigration({ curatedWritten: 0 });

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1"]);
    writer = new MemoryWriter({ repository: new MemoryItemsRepository(db) });
    settings = new FakeSettings();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-legacy-retire-"));
    backupDir = path.join(tmpRoot, "backups");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("waits for the lane migration and changes nothing before it", async () => {
    insertCurated(db, "c1", "Run lint before commits");
    settings.values.set("user-profile", PROFILE);

    const result = await runLegacyMemoryRetirement(deps());

    expect(result.status).toBe("not_ready");
    expect(tableNames(db)).toContain("curated_memory_entries");
    expect(settings.values.has("user-profile")).toBe(true);
    expect(marker(db)).toBeNull();
    expect(backups()).toEqual([]);
  });

  it("completes on a fresh profile without writing a backup", async () => {
    db.exec("DROP TABLE curated_memory_entries");
    await markLaneMigrationDone();

    const result = await runLegacyMemoryRetirement(deps());

    expect(result.status).toBe("retired");
    expect(backups()).toEqual([]);
    expect(marker(db)).toMatchObject({ droppedTables: [], settingsDeleted: [] });
    // Idempotent: the second run sees the marker.
    expect((await runLegacyMemoryRetirement(deps())).status).toBe("done");
  });

  it("exports, verifies and retires a populated legacy profile", async () => {
    addLegacyTables(db);
    db.prepare("INSERT INTO durable_context_meta (key, value, updated_at) VALUES (?, '{}', 1)").run(
      LEGACY_TRANSCRIPT_SPANS_MIGRATED_KEY,
    );
    insertCurated(db, "c1", "Run lint before commits");
    insertCurated(db, "c2", "Old archived rule", { status: "archived" });
    settings.values.set("user-profile", PROFILE);
    settings.values.set("relationship-memory", RELATIONSHIP);
    settings.values.set("adaptive-style-engine", ADAPTIVE);
    settings.values.set("awareness-state", AWARENESS);
    await migrateLanes();
    await markLaneMigrationDone();
    const itemsBefore = rowsOf(db).length;

    const result = await runLegacyMemoryRetirement(deps());

    expect(result.status).toBe("retired");
    if (result.status !== "retired") return;
    expect(result.counts).toMatchObject({
      curatedRows: 2,
      curatedChecked: 1,
      profileFacts: 2,
      relationshipItems: 3,
      alreadyPresent: 5,
      reingested: 0,
      excluded: 1,
      missing: 0,
    });
    expect(rowsOf(db)).toHaveLength(itemsBefore);
    // The mail commitment stayed a private contact item.
    expect(
      rowsOf(db, "json_extract(source_ref, '$.id') = 'r-mail'").map((row) => [
        row.scope,
        row.privacy,
      ]),
    ).toEqual([["contact", "private"]]);

    const tables = tableNames(db);
    for (const dropped of [
      "curated_memory_entries",
      "memory_summaries",
      "heartbeat_policies",
      "improvement_candidates",
      "improvement_runs",
      "transcript_spans",
      "transcript_spans_fts",
      "transcript_span_index_gap",
      "transcript_store_meta",
    ]) {
      expect(tables).not.toContain(dropped);
    }
    expect(tables.some((name) => name.startsWith("transcript_spans_fts_"))).toBe(false);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'curated_touch_workspace'").get(),
    ).toBeUndefined();
    // Workspace deletes still work once the trigger and table are gone.
    expect(() => db.prepare("DELETE FROM workspaces WHERE id = 'nope'").run()).not.toThrow();
    expect(tables).toContain("pending_memory_writes");
    expect(db.prepare("SELECT id FROM pending_memory_writes").all()).toEqual([{ id: "p1" }]);
    expect(result.pendingWritesDeleted).toBe(2);

    expect([...settings.values.keys()].sort()).toEqual([
      "adaptive-style-engine",
      "awareness-state",
    ]);
    expect(result.settingsDeleted).toEqual(["user-profile", "relationship-memory"]);

    // Encrypted export, owner-only.
    const files = backups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^legacy-memory-.+\.json\.enc$/);
    const file = path.join(backupDir, files[0]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file);
    expect(raw.toString()).not.toContain("Run lint before commits");
    const exported = JSON.parse(fakeSafeStorage.decryptString(raw));
    expect(exported.curatedMemoryEntries.map((row: { id: string }) => row.id)).toEqual([
      "c1",
      "c2",
    ]);
    expect(exported.settings.userProfile).toEqual(PROFILE);
    expect(exported.settings.relationshipMemory).toEqual(RELATIONSHIP);
    expect(exported.settings.adaptiveStyle).toEqual(ADAPTIVE);
    expect(exported.settings.awarenessBeliefs).toEqual(AWARENESS.beliefs);
    expect(exported.pendingMemoryWrites).toEqual({ settledRows: 2 });
    expect(JSON.stringify(exported)).not.toContain("secret");
    expect(exported.tableCounts).toMatchObject({
      curated_memory_entries: 2,
      memory_summaries: 1,
      improvement_runs: 1,
      transcript_spans: 1,
    });

    // The marker holds counts, never content.
    const recorded = marker(db);
    expect(recorded).toMatchObject({
      counts: { alreadyPresent: 5 },
      backup: { written: true, encrypted: true, blobsOmitted: false },
      rowsDropped: { curated_memory_entries: 2, heartbeat_policies: 1 },
      pendingWritesDeleted: 2,
    });
    expect(JSON.stringify(recorded)).not.toMatch(/Run lint|dark mode|morning/);

    // Idempotent, and nothing comes back.
    expect((await runLegacyMemoryRetirement(deps())).status).toBe("done");
    expect(backups()).toHaveLength(1);
    expect(tableNames(db)).not.toContain("curated_memory_entries");
  });

  it("re-ingests records the lane migration missed before deleting", async () => {
    insertCurated(db, "c1", "Run lint before commits");
    insertCurated(db, "c-orphan", "Workspace is gone", { workspaceId: "ws-deleted" });
    settings.values.set("user-profile", PROFILE);
    settings.values.set("relationship-memory", RELATIONSHIP);
    await markLaneMigrationDone();

    const result = await runLegacyMemoryRetirement(deps());

    expect(result.status).toBe("retired");
    if (result.status !== "retired") return;
    expect(result.counts).toMatchObject({ alreadyPresent: 0, reingested: 5, missing: 0 });
    const ids = rowsOf(db).map((row) => JSON.parse(String(row.source_ref)).id);
    expect(ids).toEqual(expect.arrayContaining(["c1", "f-pin", "f-name", "r-pref", "r-mail"]));
    expect(ids).not.toContain("r-history");
    expect(ids).not.toContain("c-orphan");
    expect(tableNames(db)).not.toContain("curated_memory_entries");
  });

  it("aborts without deleting when a record cannot be written", async () => {
    insertCurated(db, "c1", "Run lint before commits");
    settings.values.set("user-profile", PROFILE);
    await markLaneMigrationDone();
    const failing = new MemoryWriter({ repository: new MemoryItemsRepository(db) });
    failing.ingest = async (candidate: MemoryCandidate) => {
      if ((candidate.sourceRef as { id?: string }).id === "f-pin") throw new Error("disk full");
      return writer.ingest(candidate);
    };

    const result = await runLegacyMemoryRetirement(deps({ writer: failing }));

    expect(result).toMatchObject({ status: "aborted", reason: "missing_rows" });
    expect(tableNames(db)).toContain("curated_memory_entries");
    expect(settings.values.has("user-profile")).toBe(true);
    expect(marker(db)).toBeNull();
    // The export of the aborted run is removed; the claim is released for the next start.
    expect(backups()).toEqual([]);
    expect(
      db
        .prepare("SELECT 1 FROM maintenance_state WHERE key = ?")
        .get(maintenanceClaimKey(LEGACY_MEMORY_RETIREMENT_KEY)),
    ).toBeUndefined();

    // The next start succeeds.
    expect((await runLegacyMemoryRetirement(deps())).status).toBe("retired");
  });

  it("writes a plaintext export without the settings blobs when OS encryption is unavailable", async () => {
    insertCurated(db, "c1", "Run lint before commits");
    settings.values.set("user-profile", PROFILE);
    await migrateLanes();
    await markLaneMigrationDone();

    const result = await runLegacyMemoryRetirement(deps({ encryption: null }));

    expect(result.status).toBe("retired");
    const files = backups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.json$/);
    const file = path.join(backupDir, files[0]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const exported = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(exported.settings).toEqual({ omitted: "os_encryption_unavailable" });
    expect(exported.curatedMemoryEntries).toHaveLength(1);
    expect(fs.readFileSync(file, "utf8")).not.toContain("dark mode");
    expect(marker(db)).toMatchObject({ backup: { encrypted: false, blobsOmitted: true } });
  });

  it("keeps a profile fact the writer declines unless the encrypted export holds it", async () => {
    settings.values.set("user-profile", {
      facts: [
        {
          id: "f-short",
          category: "preference",
          value: "ok",
          confidence: 0.5,
          source: "conversation",
          firstSeenAt: 1,
          lastUpdatedAt: 1,
        },
      ],
      updatedAt: 1,
    });
    await markLaneMigrationDone();

    const plain = await runLegacyMemoryRetirement(deps({ encryption: null }));
    expect(plain).toMatchObject({ status: "aborted", reason: "missing_rows" });
    expect(settings.values.has("user-profile")).toBe(true);
    expect(backups()).toEqual([]);

    const encrypted = await runLegacyMemoryRetirement(deps());
    expect(encrypted.status).toBe("retired");
    if (encrypted.status === "retired") expect(encrypted.counts.declined).toBe(1);
    expect(settings.values.has("user-profile")).toBe(false);
  });

  it("does not delete an unreadable settings blob", async () => {
    settings.statuses.set("relationship-memory", "decryption_failed");
    await markLaneMigrationDone();

    const result = await runLegacyMemoryRetirement(deps());

    expect(result).toMatchObject({ status: "aborted", reason: "settings_unreadable" });
    expect(tableNames(db)).toContain("curated_memory_entries");
    expect(marker(db)).toBeNull();
  });

  it("aborts when the curated table changes between the export and the drop", async () => {
    insertCurated(db, "c1", "Run lint before commits");
    await markLaneMigrationDone();
    const racing = new MemoryWriter({ repository: new MemoryItemsRepository(db) });
    racing.ingest = async (candidate: MemoryCandidate) => {
      insertCurated(db, "c-late", "Written by an older client", { updatedAt: 99 });
      return writer.ingest(candidate);
    };

    const result = await runLegacyMemoryRetirement(deps({ writer: racing }));

    expect(result).toMatchObject({ status: "aborted", reason: "curated_changed" });
    expect(tableNames(db)).toContain("curated_memory_entries");
    expect(marker(db)).toBeNull();
    // The export of this run is kept (settings may already be gone).
    expect(backups()).toHaveLength(1);
    expect((await runLegacyMemoryRetirement(deps())).status).toBe("retired");
  });

  it("skips while another process holds the claim", async () => {
    insertCurated(db, "c1", "Run lint before commits");
    await markLaneMigrationDone();
    db.prepare("INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, 1)").run(
      maintenanceClaimKey(LEGACY_MEMORY_RETIREMENT_KEY),
      JSON.stringify({ owner: "daemon:1:x", expiresAt: 1_700_000_000_000 + 60_000 }),
    );

    const result = await runLegacyMemoryRetirement(deps());

    expect(result.status).toBe("held");
    expect(tableNames(db)).toContain("curated_memory_entries");
    expect(backups()).toEqual([]);
  });

  it("keeps transcript and improvement tables until their own migrations finished", async () => {
    addLegacyTables(db);
    settings.subconsciousDone = false;
    await markLaneMigrationDone();

    const result = await runLegacyMemoryRetirement(deps());

    expect(result.status).toBe("retired");
    const tables = tableNames(db);
    expect(tables).toEqual(
      expect.arrayContaining(["transcript_spans", "improvement_candidates", "improvement_runs"]),
    );
    expect(tables).not.toContain("memory_summaries");
    expect(tables).not.toContain("heartbeat_policies");
  });

  it("does not drop a table that another table still references", async () => {
    db.exec(`
      CREATE TABLE curated_notes (id TEXT PRIMARY KEY, entry_id TEXT
        REFERENCES curated_memory_entries(id));
    `);
    await markLaneMigrationDone();

    const result = await runLegacyMemoryRetirement(deps());

    expect(result.status).toBe("retired");
    if (result.status === "retired") {
      expect(result.blockedTables).toEqual(["curated_memory_entries"]);
    }
    expect(tableNames(db)).toContain("curated_memory_entries");
  });
});

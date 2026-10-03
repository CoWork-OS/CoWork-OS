import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { WorkspaceStore } from "../../database/repositories";
import { PlaybookEvidenceLedger } from "../PlaybookEvidenceLedger";
import { hashMemoryContent, PlaybookEvidenceStore } from "../PlaybookEvidenceStore";
import { ProactiveSuggestionStore } from "../ProactiveSuggestionStore";
import {
  LEGACY_SUGGESTION_TTL_MS,
  MEMORY_PAYLOAD_MIGRATION_KEY,
  runMemoryPayloadMigration,
} from "../memory-payload-migration-sql";
import { purgeTaskDerivedRows, purgeWorkspaceMemoryRows } from "../memory-purge-sql";

// Phase 2 item 6: `[SUGGESTION]`, `[suggestion-feedback:…]` and generated `[PLAYBOOK]`
// rows move out of the memories archive into their own tables, once, on a real profile.

const DAY = 24 * 60 * 60 * 1000;

describe("memory payload table migration", () => {
  const cleanups: Array<() => void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  function openProfile(dir?: string) {
    const profileDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cowork-payload-migration-"));
    process.env.COWORK_USER_DATA_DIR = profileDir;
    const manager = new DatabaseManager();
    let closed = false;
    const close = () => {
      if (!closed) manager.close();
      closed = true;
    };
    cleanups.push(close);
    if (!dir) cleanups.push(() => fs.rmSync(profileDir, { recursive: true, force: true }));
    return { dir: profileDir, db: manager.getDatabase(), close };
  }

  function insertMemory(
    db: Database.Database,
    row: {
      id: string;
      workspaceId: string;
      content: string;
      taskId?: string;
      createdAt?: number;
      isPrivate?: boolean;
      privacyState?: string;
    },
  ) {
    const createdAt = row.createdAt ?? Date.now() - DAY;
    db.prepare(
      `INSERT INTO memories (id, workspace_id, task_id, type, content, tokens, is_private,
         created_at, updated_at)
       VALUES (?, ?, ?, 'insight', ?, 5, ?, ?, ?)`,
    ).run(
      row.id,
      row.workspaceId,
      row.taskId ?? null,
      row.content,
      row.isPrivate ? 1 : 0,
      createdAt,
      createdAt,
    );
    db.prepare(
      "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES (?, ?, '[0.1]', ?)",
    ).run(row.id, row.workspaceId, createdAt);
    db.prepare(
      `INSERT INTO memory_observation_metadata (memory_id, workspace_id, origin, observation_type,
         title, narrative, content_hash, privacy_state, created_at, updated_at)
       VALUES (?, ?, 'proactive', 'insight', 't', 'n', 'h', ?, ?, ?)`,
    ).run(row.id, row.workspaceId, row.privacyState ?? "normal", createdAt, createdAt);
  }

  const suggestionContent = (id: string, title: string) =>
    `[SUGGESTION] ${JSON.stringify({ id, type: "follow_up", title, description: "d", confidence: 0.7, urgency: "high" })}`;

  const successContent = (title: string) =>
    [
      `[PLAYBOOK] Task succeeded: "${title}"`,
      `Approach: approach for ${title}`,
      "Key tools: read_file, write_file",
      "Preferred destinations: notion",
      `Original request: ${title} please`,
    ].join("\n");

  /** A profile with legacy rows, as an older release left it, with the marker cleared. */
  function seedLegacyProfile() {
    const profile = openProfile();
    const { db } = profile;
    const workspace = new WorkspaceStore(db).create("W", path.join(profile.dir, "w"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const ws = workspace.id;
    db.pragma("foreign_keys = OFF");
    const created = Date.now() - 2 * DAY;
    insertMemory(db, {
      id: "m-sug",
      workspaceId: ws,
      content: suggestionContent("sug-1", "Write tests"),
      createdAt: created,
    });
    insertMemory(db, {
      id: "m-sug-private",
      workspaceId: ws,
      content: suggestionContent("sug-2", "Private one"),
      isPrivate: true,
    });
    insertMemory(db, {
      id: "m-sug-deleted",
      workspaceId: ws,
      content: suggestionContent("sug-3", "Deleted one"),
      privacyState: "suppressed",
    });
    insertMemory(db, {
      id: "m-sug-broken",
      workspaceId: ws,
      content: '[SUGGESTION] {"id":"sug-4","title":"trunc',
    });
    insertMemory(db, {
      id: "m-fb",
      workspaceId: ws,
      content: [
        '[suggestion-feedback:edited] edited suggestion "Write tests".',
        "Class: follow_up.",
        "Source: task-9.",
        "Suggested action: Write tests",
        "Edited action: Write integration tests",
        "for the importer",
      ].join("\n"),
    });
    insertMemory(db, {
      id: "m-pb-success",
      workspaceId: ws,
      taskId: "task-1",
      content: successContent("Reconcile invoices"),
    });
    insertMemory(db, {
      id: "m-pb-success-2",
      workspaceId: ws,
      taskId: "task-2",
      content: successContent("Reconcile vendor invoices"),
    });
    insertMemory(db, {
      id: "m-pb-failure",
      workspaceId: ws,
      taskId: "task-3",
      content:
        '[PLAYBOOK] Task failed: "Sync"\nCategory: user_correction\nAttempted approach: x\nError: [CORRECTION] wrong\nOriginal request: Sync',
    });
    insertMemory(db, {
      id: "m-pb-inbox",
      workspaceId: ws,
      content: '[PLAYBOOK] Inbox pattern: "Digest"\nSummary: weekly',
    });
    insertMemory(db, {
      id: "m-pb-legacy",
      workspaceId: ws,
      content: '[PLAYBOOK] Reinforced pattern: "x"\nconfirmed',
    });
    insertMemory(db, {
      id: "m-pb-deleted",
      workspaceId: ws,
      taskId: "task-4",
      content: successContent("Gone"),
      privacyState: "suppressed",
    });
    // User text that only looks like a payload stays memory.
    insertMemory(db, { id: "u-1", workspaceId: ws, content: "[PLAYBOOK] my launch notes" });
    insertMemory(db, { id: "u-2", workspaceId: ws, content: "[suggestion] call the bank" });
    insertMemory(db, { id: "u-3", workspaceId: ws, content: "Prefers tabs over spaces" });
    db.pragma("foreign_keys = ON");

    const evidence = new PlaybookEvidenceStore(db);
    const first = evidence.record({
      workspaceId: ws,
      taskId: "task-1",
      sourceEntryId: "m-pb-success",
      sourceContentHash: hashMemoryContent(successContent("Reconcile invoices")),
      patternKey: "tools:read_file,write_file|dest:notion",
    }).record;
    const second = evidence.record({
      workspaceId: ws,
      taskId: "task-2",
      sourceEntryId: "m-pb-success-2",
      sourceContentHash: hashMemoryContent(successContent("Reconcile vendor invoices")),
      patternKey: "tools:read_file,write_file|dest:notion",
    }).record;
    evidence.link(second.id, first.id);
    evidence.record({
      workspaceId: ws,
      taskId: "task-4",
      sourceEntryId: "m-pb-deleted",
      sourceContentHash: hashMemoryContent(successContent("Gone")),
      patternKey: "tools:read_file",
    });
    db.prepare("DELETE FROM maintenance_state WHERE key = ?").run(MEMORY_PAYLOAD_MIGRATION_KEY);
    return { ...profile, ws, created };
  }

  it("moves payload rows out of the archive when the profile opens", async () => {
    const seeded = seedLegacyProfile();
    seeded.close();
    const { db } = openProfile(seeded.dir);
    const ws = seeded.ws;

    // Only real memories remain, without orphaned child rows or FTS hits.
    expect(
      (db.prepare("SELECT id FROM memories ORDER BY id").all() as Array<{ id: string }>).map(
        (row) => row.id,
      ),
    ).toEqual(["u-1", "u-2", "u-3"]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id NOT LIKE 'u-%'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_observation_metadata WHERE memory_id NOT LIKE 'u-%'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'reconcile'")
        .get(),
    ).toEqual({ n: 0 });

    // Suggestions: id from the payload, privacy kept, user-deleted and broken rows dropped.
    const suggestions = db
      .prepare(
        "SELECT id, title, is_private, created_at, expires_at, status FROM suggestions ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    expect(suggestions.map((row) => [row.id, row.title, row.is_private, row.status])).toEqual([
      ["sug-1", "Write tests", 0, "active"],
      ["sug-2", "Private one", 1, "active"],
    ]);
    expect(suggestions[0].expires_at).toBe(seeded.created + LEGACY_SUGGESTION_TTL_MS);
    const store = ProactiveSuggestionStore.open(db);
    const [active] = await store.listActive(ws);
    expect(active.payload).toMatchObject({ id: "sug-1", urgency: "high" });
    expect(await store.listActive(ws)).toHaveLength(1);

    expect(db.prepare("SELECT * FROM suggestion_feedback").all()).toEqual([
      expect.objectContaining({
        id: "m-fb",
        workspace_id: ws,
        action: "edited",
        title: "Write tests",
        suggestion_class: "follow_up",
        source_entity: "task-9",
        action_prompt: "Write tests",
        edited_prompt: "Write integration tests\nfor the importer",
      }),
    ]);

    // Playbook entries keep the memory id, so evidence still resolves and still verifies.
    expect(
      db
        .prepare(
          "SELECT id, kind, task_id, status, reinforcement_count FROM playbook_entries ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "m-pb-failure",
        kind: "failure",
        task_id: "task-3",
        status: "active",
        reinforcement_count: 0,
      },
      { id: "m-pb-inbox", kind: "inbox", task_id: null, status: "active", reinforcement_count: 0 },
      {
        id: "m-pb-legacy",
        kind: "legacy_reinforcement",
        task_id: null,
        status: "active",
        reinforcement_count: 0,
      },
      {
        id: "m-pb-success",
        kind: "success",
        task_id: "task-1",
        status: "active",
        reinforcement_count: 1,
      },
      {
        id: "m-pb-success-2",
        kind: "success",
        task_id: "task-2",
        status: "active",
        reinforcement_count: 0,
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT title, approach, request, tools, destinations, pattern_key FROM playbook_entries WHERE id = 'm-pb-success'",
        )
        .get(),
    ).toEqual({
      title: "Reconcile invoices",
      approach: "approach for Reconcile invoices",
      request: "Reconcile invoices please",
      tools: JSON.stringify(["read_file", "write_file"]),
      destinations: JSON.stringify(["notion"]),
      pattern_key: "tools:read_file,write_file|dest:notion",
    });
    const ledger = PlaybookEvidenceLedger.open(db);
    expect((await ledger.listReadable(ws)).map(({ entry }) => entry.title).sort()).toEqual([
      "Reconcile invoices",
      "Reconcile vendor invoices",
    ]);
    expect(
      db
        .prepare(
          "SELECT invalidation_reason AS r FROM playbook_success_evidence WHERE task_id = 'task-4'",
        )
        .get(),
    ).toEqual({ r: "source_entry_deleted" });
    expect((await ledger.listCorrections(ws, 0)).map(({ taskId }) => taskId)).toEqual(["task-3"]);
  });

  it("is idempotent: a second run and a re-run without the marker change nothing", () => {
    const seeded = seedLegacyProfile();
    const first = runMemoryPayloadMigration(seeded.db, Date.now());
    expect(first.ran).toBe(true);
    expect(first.counts).toEqual({
      suggestionsMoved: 2,
      suggestionFeedbackMoved: 1,
      playbookEntriesMoved: 5,
      dropped: 3,
      memoriesDeleted: 11,
    });
    const snapshot = () =>
      JSON.stringify(
        [
          "memories",
          "suggestions",
          "suggestion_feedback",
          "playbook_entries",
          "playbook_success_evidence",
        ].map((table) => seeded.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      );
    const before = snapshot();

    expect(runMemoryPayloadMigration(seeded.db, Date.now()).ran).toBe(false);
    seeded.db
      .prepare("DELETE FROM maintenance_state WHERE key = ?")
      .run(MEMORY_PAYLOAD_MIGRATION_KEY);
    const rerun = runMemoryPayloadMigration(seeded.db, Date.now());
    expect(rerun.ran).toBe(true);
    expect(rerun.counts).toEqual({
      suggestionsMoved: 0,
      suggestionFeedbackMoved: 0,
      playbookEntriesMoved: 0,
      dropped: 0,
      memoriesDeleted: 0,
    });
    expect(snapshot()).toBe(before);
  });

  it("task delete and workspace clear reach the new tables", () => {
    const seeded = seedLegacyProfile();
    runMemoryPayloadMigration(seeded.db, Date.now());
    const { db, ws } = seeded;
    db.prepare(
      `INSERT INTO suggestions (id, workspace_id, title, source_task_id, payload, created_at, expires_at, updated_at)
       VALUES ('sug-task', ?, 'From task 1', 'task-1', '{}', 1, 9999999999999, 1)`,
    ).run(ws);
    db.prepare(
      `INSERT INTO suggestion_feedback (id, workspace_id, suggestion_id, action, created_at)
       VALUES ('fb-task', ?, 'sug-task', 'dismissed', 1)`,
    ).run(ws);

    const taskCounts = db.transaction(() =>
      purgeTaskDerivedRows(db, "task-1", { purgeDerivedMemory: true }),
    )();
    expect(taskCounts).toMatchObject({ playbookEntries: 1, playbookEvidence: 1, suggestions: 2 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM playbook_entries WHERE task_id = 'task-1'").get(),
    ).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE id = 'sug-task'").get()).toEqual(
      { n: 0 },
    );

    // Without purgeDerivedMemory the derived rows stay.
    expect(purgeTaskDerivedRows(db, "task-2")).toMatchObject({
      playbookEntries: 0,
      suggestions: 0,
    });

    const workspaceCounts = purgeWorkspaceMemoryRows(db, ws);
    expect(workspaceCounts.playbookEntries).toBe(4);
    expect(workspaceCounts.suggestions).toBe(3); // two suggestions and one feedback row
    for (const table of [
      "playbook_entries",
      "suggestions",
      "suggestion_feedback",
      "playbook_success_evidence",
    ]) {
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(ws),
      ).toEqual({ n: 0 });
    }
  });
});

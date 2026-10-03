import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DreamingRepository } from "../DreamingRepository";
import { DreamingService, MAX_AUTO_APPLY } from "../DreamingService";
import { MemoryCurationRepository } from "../MemoryCurationRepository";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryReviewService } from "../MemoryReviewService";
import { MemoryWriter, type MemoryCandidate } from "../MemoryWriter";
import { LEGACY_DREAMING_DISMISSAL, ensureMemoryCurationSchema } from "../memory-curation-log-sql";
import type { CurationLlmClient } from "../memory-curation-llm";
import type { MemoryFeaturesSettings } from "../../../shared/types";
import { createMemoryItemsTestDb, nativeSqliteAvailable } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

async function createCurationTestDb(): Promise<Database.Database> {
  const db = await createMemoryItemsTestDb(["ws-1", "ws-2"]);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT, type TEXT NOT NULL,
      content TEXT NOT NULL, summary TEXT, tokens INTEGER NOT NULL DEFAULT 0,
      is_compressed INTEGER NOT NULL DEFAULT 0, is_private INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE dreaming_runs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope_kind TEXT NOT NULL,
      scope_ref TEXT NOT NULL, status TEXT NOT NULL, trigger_source TEXT NOT NULL,
      trigger_heartbeat_run_id TEXT, source_task_id TEXT, instructions TEXT, summary TEXT,
      evidence_count INTEGER NOT NULL DEFAULT 0, candidate_count INTEGER NOT NULL DEFAULT 0,
      error TEXT, started_at INTEGER NOT NULL, completed_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE dreaming_candidates (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, workspace_id TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT NOT NULL, current_value TEXT, proposed_value TEXT NOT NULL,
      rationale TEXT NOT NULL, confidence REAL NOT NULL, evidence_refs TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL, created_at INTEGER NOT NULL, reviewed_at INTEGER, resolution TEXT
    );
  `);
  // A legacy boilerplate proposal, from before the curator.
  db.prepare(
    `INSERT INTO dreaming_runs (id, workspace_id, scope_kind, scope_ref, status, trigger_source,
       started_at, created_at) VALUES ('old-run', 'ws-1', 'workspace', 'ws-1', 'completed', 'heartbeat', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO dreaming_candidates (id, run_id, workspace_id, action, target, proposed_value,
       rationale, confidence, status, created_at)
     VALUES ('legacy', 'old-run', 'ws-1', 'correction', 'core_memory',
       'A recent correction should be reviewed for durable memory promotion.', 'x', 0.8, 'proposed', 1)`,
  ).run();
  ensureMemoryCurationSchema(db, 5);
  return db;
}

describeWithSqlite("memory curator (SQLite)", () => {
  let db: Database.Database;
  let writer: MemoryWriter;
  let items: MemoryItemsRepository;
  let curation: MemoryCurationRepository;
  let dreaming: DreamingRepository;
  let clock: number;
  let settings: Partial<MemoryFeaturesSettings>;

  const ingest = async (overrides: Partial<MemoryCandidate>) => {
    const result = await writer.ingest({
      content: "Prefers short status updates every morning",
      kind: "preference",
      scope: "workspace",
      workspaceId: "ws-1",
      source: "inferred",
      ...overrides,
    });
    if (result.status !== "written") throw new Error(`not written: ${result.reason}`);
    return result.item;
  };

  const service = (deps: Partial<ConstructorParameters<typeof DreamingService>[1]> = {}) =>
    new DreamingService(dreaming, {
      now: () => clock,
      getWriter: () => writer,
      curation,
      searchConversation: async () => [],
      getSettings: () => settings,
      ...deps,
    });

  const review = (syncKitFiles = vi.fn(async () => undefined)) =>
    new MemoryReviewService({
      dreaming,
      curation,
      getWriter: () => writer,
      getSettings: () => settings as MemoryFeaturesSettings,
      syncKitFiles,
      now: () => clock,
    });

  const runRequest = {
    workspaceId: "ws-1",
    workspacePath: "/tmp/ws-1",
    triggerSource: "manual" as const,
  };

  beforeEach(async () => {
    db = await createCurationTestDb();
    clock = 500 * DAY;
    settings = {};
    items = new MemoryItemsRepository(db);
    curation = new MemoryCurationRepository(db);
    dreaming = new DreamingRepository(db);
    writer = new MemoryWriter({
      repository: items,
      curation,
      now: () => (clock += 1),
    });
    await items.recordLaneMigration({ done: 1 });
  });

  afterEach(() => {
    db.close();
  });

  it("dismisses legacy boilerplate proposals once, at schema setup", async () => {
    const legacy = await dreaming.findCandidateById("legacy");
    expect(legacy).toMatchObject({ status: "dismissed", resolution: LEGACY_DREAMING_DISMISSAL });
  });

  it("applies a safe merge with an audit log row, and undo restores both items", async () => {
    const keep = await ingest({ content: "Prefers short status updates every morning" });
    await writer.ingest({
      content: "Prefers short status updates every morning",
      kind: "preference",
      scope: "workspace",
      workspaceId: "ws-1",
      source: "inferred",
    });
    const dup = await ingest({ content: "prefers SHORT status updates, every morning please" });
    const result = await service().run(runRequest);
    expect(result.run).toMatchObject({ status: "completed", appliedCount: 1, queuedCount: 0 });
    expect(result.appliedLogIds).toHaveLength(1);

    const keptAfter = await items.findById(keep.id);
    const dupAfter = await items.findById(dup.id);
    expect(keptAfter).toMatchObject({ status: "active", reinforcedCount: 2 });
    expect(dupAfter?.status).toBe("superseded");

    const [log] = await curation.listLog("ws-1");
    expect(log).toMatchObject({ op: "merge", origin: "auto", itemIds: [keep.id, dup.id] });
    expect(log.before.map((entry) => entry.status)).toEqual(["active", "active"]);

    const undone = await review().undo("ws-1", log.id);
    expect(undone).toMatchObject({ success: true });
    expect(await items.findById(keep.id)).toMatchObject({ status: "active", reinforcedCount: 1 });
    expect((await items.findById(dup.id))?.status).toBe("active");

    // The undone change is not applied again by the next run.
    clock += DAY;
    const again = await service().run(runRequest);
    expect(again.run.appliedCount).toBe(0);
    expect((await items.findById(dup.id))?.status).toBe("active");
  });

  it("never changes user-stated items automatically; they go to review", async () => {
    const stated = await ingest({
      source: "user_stated",
      content: "Prefers short status updates every morning",
    });
    const inferred = await ingest({ content: "prefers short status updates every morning!!" });
    // Same hash class: write a near-duplicate rather than an exact one.
    const near = await ingest({ content: "Prefers short status updates on every morning" });
    const result = await service().run(runRequest);
    expect(result.run.appliedCount).toBe(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      target: "memory_items",
      action: "memory_merge",
      status: "proposed",
    });
    for (const item of [stated, near]) {
      expect((await items.findById(item.id))?.status).toBe("active");
    }
    expect(inferred.id).toBe(stated.id); // exact duplicate was reinforced into the stated item

    // The store refuses an automatic change to a protected item even if asked directly.
    const refused = await writer.applyCuration({
      workspaceId: "ws-1",
      runId: null,
      candidateId: null,
      origin: "auto",
      fingerprint: "x",
      summary: "x",
      rationale: null,
      allowProtected: false,
      operation: { op: "decay", itemIds: [stated.id] },
    });
    expect(refused).toMatchObject({ status: "refused", reason: "protected" });
  });

  it("accepting a review proposal applies it through MemoryWriter; reject blocks it", async () => {
    const stated = await ingest({ source: "user_stated", content: "Prefers concise answers" });
    const inferred = await ingest({ content: "Prefers detailed answers" });
    const run = await service().run(runRequest);
    expect(run.candidates.map((candidate) => candidate.action)).toEqual([
      "memory_resolve_conflict",
    ]);

    const sync = vi.fn(async () => undefined);
    const hub = review(sync);
    const state = await hub.state("ws-1");
    expect(state.pendingCount).toBe(1);
    expect(state.pending[0]).toMatchObject({
      op: "resolve_conflict",
      keepId: stated.id,
      items: [
        expect.objectContaining({ id: stated.id }),
        expect.objectContaining({ id: inferred.id }),
      ],
    });
    expect(await hub.count("ws-1")).toBe(1);

    // Another workspace cannot see or accept it.
    await expect(hub.accept("ws-2", state.pending[0].id)).rejects.toThrow(/not found/);

    expect(await hub.accept("ws-1", state.pending[0].id)).toMatchObject({ success: true });
    expect((await items.findById(inferred.id))?.status).toBe("superseded");
    expect((await items.findById(stated.id))?.status).toBe("active");
    expect(sync).toHaveBeenCalledWith("ws-1");
    const after = await hub.state("ws-1");
    expect(after.pending).toHaveLength(0);
    expect(after.recent[0]).toMatchObject({
      op: "resolve_conflict",
      origin: "review",
      canUndo: true,
    });

    // A second accept of the same proposal is refused.
    expect(await hub.accept("ws-1", state.pending[0].id)).toMatchObject({
      success: false,
      reason: "reviewed",
    });
  });

  it("rejected proposals are not proposed again", async () => {
    await ingest({ content: "Prefers concise answers" });
    await ingest({ content: "Prefers detailed answers" });
    const first = await service().run(runRequest);
    expect(first.candidates).toHaveLength(1);
    expect(await review().reject("ws-1", first.candidates[0].id)).toMatchObject({ success: true });
    clock += DAY;
    const second = await service().run(runRequest);
    expect(second.candidates).toHaveLength(0);
    expect(second.run.stats).toMatchObject({ blocked: 1 });
  });

  it("promotes a recurring correction from two tasks, and undo tombstones the new item", async () => {
    const insert = db.prepare(
      `INSERT INTO memories (id, workspace_id, task_id, type, content, created_at, updated_at)
       VALUES (?, 'ws-1', ?, 'insight', ?, ?, ?)`,
    );
    insert.run(
      "m1",
      "t1",
      "[CORRECTION] User corrected agent\nUser said: always use pnpm instead of npm for installs here\nTask context: a",
      clock - DAY,
      clock - DAY,
    );
    insert.run(
      "m2",
      "t2",
      "[CORRECTION] User corrected agent\nUser said: use pnpm instead of npm for installs here\nTask context: b",
      clock - DAY,
      clock - DAY,
    );
    const result = await service().run(runRequest);
    expect(result.run.appliedCount).toBe(1);
    const [log] = await curation.listLog("ws-1");
    expect(log).toMatchObject({ op: "promote", createdIds: [expect.any(String)] });
    const created = await items.findById(log.createdIds[0]);
    expect(created).toMatchObject({
      kind: "correction",
      source: "inferred",
      scope: "workspace",
      status: "active",
    });
    expect(created?.sourceRef.aliases).toEqual(
      expect.arrayContaining(["archive:m1", "archive:m2"]),
    );

    expect(await review().undo("ws-1", log.id)).toMatchObject({ success: true });
    expect(await items.findById(log.createdIds[0])).toMatchObject({
      status: "deleted",
      content: "",
    });
    expect((await curation.findLog(log.id))?.undoneAt).toEqual(expect.any(Number));
    // An undone promotion is not learned again from the same evidence.
    clock += DAY;
    expect((await service().run(runRequest)).run.appliedCount).toBe(0);
  });

  it("refuses an undo after the item changed since", async () => {
    const old = await ingest({ content: "Enjoys jazz playlists while coding" });
    db.prepare(
      "UPDATE memory_items SET last_used_at = ?, updated_at = ?, created_at = ? WHERE id = ?",
    ).run(clock - 400 * DAY, clock - 400 * DAY, clock - 400 * DAY, old.id);
    const result = await service().run(runRequest);
    expect(result.run.appliedCount).toBe(1);
    expect((await items.findById(old.id))?.status).toBe("archived");
    const [log] = await curation.listLog("ws-1");
    // Reactivated by a new write of the same fact in the meantime.
    await ingest({ content: "Enjoys jazz playlists while coding" });
    const undone = await review().undo("ws-1", log.id);
    expect(undone).toMatchObject({ success: false, reason: "conflict" });
  });

  it("forgetting an item scrubs curation log rows that quote it", async () => {
    const old = await ingest({ content: "Enjoys jazz playlists while coding" });
    db.prepare(
      "UPDATE memory_items SET last_used_at = 1, updated_at = 1, created_at = 1 WHERE id = ?",
    ).run(old.id);
    await service().run(runRequest);
    expect(await curation.listLog("ws-1")).toHaveLength(1);
    await writer.setStatus(old.id, "deleted");
    expect(await curation.listLog("ws-1")).toHaveLength(0);
  });

  it("caps automatic changes per run and records counts", async () => {
    for (let index = 0; index < MAX_AUTO_APPLY + 3; index += 1) {
      const item = await ingest({
        content: `Unused fact alpha${index} bravo${index} charlie${index} delta${index}`,
      });
      db.prepare(
        "UPDATE memory_items SET last_used_at = 1, updated_at = 1, created_at = 1 WHERE id = ?",
      ).run(item.id);
    }
    const result = await service().run(runRequest);
    expect(result.run.appliedCount).toBe(MAX_AUTO_APPLY);
    expect(result.run.stats).toMatchObject({ deferred: 3, applied_decay: MAX_AUTO_APPLY });
  });

  it("skips while the lane migration has not finished", async () => {
    db.prepare("DELETE FROM maintenance_state").run();
    const result = await service().run(runRequest);
    expect(result.run.status).toBe("skipped");
  });

  describe("LLM synthesis", () => {
    const client = (text: string, onCall = vi.fn()): CurationLlmClient => ({
      async complete(request) {
        onCall(request);
        return { text, inputTokens: 300, outputTokens: 50 };
      },
    });

    it("is off by default", async () => {
      const onCall = vi.fn();
      await ingest({ content: "Keeps a dark editor theme" });
      await service({ llmClient: client('{"proposals":[]}', onCall) }).run(runRequest);
      expect(onCall).not.toHaveBeenCalled();
    });

    it("queues valid proposals for review, drops invalid ones, and records tokens", async () => {
      settings = { dreamingLlmEnabled: true, dreamingLlmDailyTokenBudget: 50_000 };
      await ingest({ content: "Keeps a dark editor theme" });
      await ingest({ content: "Uses a dark color scheme in the editor" });
      await ingest({ source: "user_stated", content: "Reads email only after lunch" });
      const onCall = vi.fn();
      const text = JSON.stringify({
        proposals: [
          { op: "merge", keep: "i1", merge: ["i2"], reason: "same preference" },
          // Touches a user-stated item: dropped.
          { op: "decay", item: "i3", reason: "old" },
          // Unknown alias: dropped.
          { op: "merge", keep: "i1", merge: ["i9"], reason: "x" },
        ],
      });
      const result = await service({ llmClient: client(text, onCall) }).run(runRequest);
      expect(onCall).toHaveBeenCalledOnce();
      // The prompt carries aliases, not ids, and marks text as untrusted.
      const request = onCall.mock.calls[0][0];
      expect(request.system).toMatch(/untrusted data/);
      expect(request.user).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(result.run).toMatchObject({ llmTokens: 350, llmCalls: 1 });
      expect(result.run.stats).toMatchObject({ llm_rejected: 2 });
      expect(result.candidates.filter((candidate) => candidate.origin === "llm")).toHaveLength(1);
      expect(result.run.appliedCount).toBe(0);
    });

    it("ignores malformed output and respects the daily budget", async () => {
      settings = { dreamingLlmEnabled: true, dreamingLlmDailyTokenBudget: 50_000 };
      await ingest({ content: "Keeps a dark editor theme" });
      await ingest({ content: "Reads the news at breakfast" });
      const bad = await service({
        llmClient: client('Sure! {"proposals":[{"op":"delete_everything"}]}'),
      }).run(runRequest);
      expect(bad.run.stats).toMatchObject({ llm_invalid_output: 1 });
      expect(bad.candidates).toHaveLength(0);

      settings = { dreamingLlmEnabled: true, dreamingLlmDailyTokenBudget: 100 };
      const onCall = vi.fn();
      clock += 1;
      const capped = await service({ llmClient: client('{"proposals":[]}', onCall) }).run(
        runRequest,
      );
      expect(onCall).not.toHaveBeenCalled();
      expect(capped.run.stats).toMatchObject({ llm_budget: 1 });
    });
  });

  it("lists workspaces due for the daily curation", async () => {
    db.prepare("INSERT INTO tasks VALUES ('t1', 'ws-1', 't', ?, ?)").run(clock, clock);
    db.prepare("INSERT INTO tasks VALUES ('t2', 'ws-2', 't', ?, ?)").run(
      clock - 60 * DAY,
      clock - 60 * DAY,
    );
    expect(await curation.dueWorkspaces(["ws-1", "ws-2"], clock - 14 * DAY, clock - DAY)).toEqual([
      "ws-1",
    ]);
    await service().run(runRequest);
    expect(await curation.dueWorkspaces(["ws-1", "ws-2"], clock - 14 * DAY, clock - DAY)).toEqual(
      [],
    );
  });
});

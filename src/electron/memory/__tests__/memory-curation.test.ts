import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitmentExpiryService } from "../CommitmentExpiryService";
import { MemoryCurationRepository } from "../MemoryCurationRepository";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryReviewService } from "../MemoryReviewService";
import { MemoryWriter, type MemoryCandidate } from "../MemoryWriter";
import type { ConversationHit } from "../conversation-index-sql";
import { LEGACY_DREAMING_DISMISSAL, ensureMemoryCurationSchema } from "../memory-curation-log-sql";
import { createMemoryItemsTestDb, nativeSqliteAvailable } from "./memory-items-test-db";

// Commitment expiry and the Review tab's undo over a real memory_items schema
// (docs/memory-repo-phase3-design.md §6).

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

async function createCurationTestDb(): Promise<Database.Database> {
  const db = await createMemoryItemsTestDb(["ws-1", "ws-2"]);
  db.exec(`
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
  db.prepare(
    `INSERT INTO dreaming_runs (id, workspace_id, scope_kind, scope_ref, status, trigger_source,
       started_at, created_at) VALUES ('old-run', 'ws-1', 'workspace', 'ws-1', 'completed', 'heartbeat', 1, 1)`,
  ).run();
  const candidate = db.prepare(
    `INSERT INTO dreaming_candidates (id, run_id, workspace_id, action, target, proposed_value,
       rationale, confidence, status, created_at)
     VALUES (?, 'old-run', 'ws-1', ?, ?, 'x', 'x', 0.8, ?, 1)`,
  );
  candidate.run("legacy", "correction", "core_memory", "proposed");
  candidate.run("curator", "memory_merge", "memory_items", "proposed");
  candidate.run("closed", "memory_decay", "memory_items", "rejected");
  ensureMemoryCurationSchema(db, 5);
  return db;
}

describeWithSqlite("commitment expiry (SQLite)", () => {
  let db: Database.Database;
  let writer: MemoryWriter;
  let items: MemoryItemsRepository;
  let curation: MemoryCurationRepository;
  let clock: number;
  let hits: Map<string, ConversationHit[]>;

  const commitment = async (overrides: Partial<MemoryCandidate> = {}) => {
    const result = await writer.ingest({
      content: "Send the quarterly report to finance",
      kind: "commitment",
      scope: "workspace",
      workspaceId: "ws-1",
      source: "inferred",
      sourceRef: { store: "test", id: String(Math.random()), dueAt: clock - 5 * DAY },
      ...overrides,
    });
    if (result.status !== "written") throw new Error(`not written: ${result.reason}`);
    return result.item;
  };

  const archiveRow = (id: string, workspaceId: string, content: string, at: number) =>
    db
      .prepare(
        `INSERT INTO memories (id, workspace_id, task_id, type, content, created_at, updated_at)
         VALUES (?, ?, 't1', 'decision', ?, ?, ?)`,
      )
      .run(id, workspaceId, content, at, at);

  const expiry = (deps: Partial<ConstructorParameters<typeof CommitmentExpiryService>[0]> = {}) =>
    new CommitmentExpiryService({
      now: () => clock,
      getWriter: () => writer,
      curation,
      searchConversation: async ({ workspaceId }) => hits.get(workspaceId) ?? [],
      listWorkspaceIds: () => ["ws-1", "ws-2"],
      ...deps,
    });

  const review = () => new MemoryReviewService({ curation, getWriter: () => writer });

  beforeEach(async () => {
    db = await createCurationTestDb();
    clock = 500 * DAY;
    hits = new Map();
    items = new MemoryItemsRepository(db);
    curation = new MemoryCurationRepository(db);
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

  it("dismisses every open Dreaming proposal once, at schema setup", () => {
    const rows = db
      .prepare("SELECT id, status, resolution FROM dreaming_candidates ORDER BY id")
      .all() as Array<{ id: string; status: string; resolution: string | null }>;
    expect(rows).toEqual([
      { id: "closed", status: "rejected", resolution: null },
      { id: "curator", status: "dismissed", resolution: LEGACY_DREAMING_DISMISSAL },
      { id: "legacy", status: "dismissed", resolution: LEGACY_DREAMING_DISMISSAL },
    ]);
  });

  it("closes a past-due commitment with archive evidence; undo reopens it for good", async () => {
    const item = await commitment();
    archiveRow("m1", "ws-1", "Quarterly report sent to finance, task completed", clock - 4 * DAY);

    const result = await expiry().sweep();
    expect(result).toMatchObject({ checked: 1, expired: 1, refused: {} });
    expect((await items.findById(item.id))?.status).toBe("archived");
    const [log] = await curation.listLog("ws-1");
    expect(log).toMatchObject({
      op: "expire_commitment",
      origin: "auto",
      fingerprint: `expire_commitment:${item.id}`,
      itemIds: [item.id],
    });
    expect(log.rationale).toContain("Quarterly report sent to finance");

    const hub = review();
    const state = await hub.state("ws-1");
    expect(state.recent).toEqual([
      expect.objectContaining({
        id: log.id,
        op: "expire_commitment",
        canUndo: true,
        items: [expect.objectContaining({ id: item.id, before: "active", after: "archived" })],
      }),
    ]);
    expect((await hub.state("ws-2")).recent).toEqual([]);
    await expect(hub.undo("ws-2", log.id)).rejects.toThrow(/not found/);

    expect(await hub.undo("ws-1", log.id)).toMatchObject({ success: true });
    expect((await items.findById(item.id))?.status).toBe("active");
    expect((await hub.state("ws-1")).recent[0]).toMatchObject({ undoneAt: expect.any(Number) });

    // The undone expiry is never applied again.
    expect(await expiry().sweep()).toMatchObject({ checked: 1, expired: 0 });
    expect((await items.findById(item.id))?.status).toBe("active");
  });

  it("leaves user-stated, undated, recent and unproven commitments open", async () => {
    const stated = await commitment({ source: "user_stated" });
    const undated = await commitment({
      content: "Send the quarterly budget to finance",
      sourceRef: { store: "test", id: "undated" },
    });
    const recent = await commitment({
      content: "Send the quarterly forecast to finance",
      sourceRef: { store: "test", id: "recent", dueAt: clock - DAY / 2 },
    });
    const unproven = await commitment({
      content: "Book the offsite venue",
      sourceRef: { store: "test", id: "venue", dueAt: clock - 60 * DAY },
    });
    archiveRow("m1", "ws-1", "Quarterly report sent to finance, task completed", clock - 4 * DAY);

    expect(await expiry().sweep()).toMatchObject({ checked: 1, expired: 0 });
    for (const item of [stated, undated, recent, unproven]) {
      expect((await items.findById(item.id))?.status).toBe("active");
    }
    expect(await curation.listLog("ws-1")).toEqual([]);

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
      operation: { op: "expire_commitment", itemIds: [stated.id] },
    });
    expect(refused).toMatchObject({ status: "refused", reason: "protected" });
  });

  it("closes a global commitment from conversation evidence in a recent workspace", async () => {
    const item = await commitment({ scope: "global", workspaceId: null });
    hits.set("ws-2", [
      {
        id: "h1",
        eventId: "e1",
        taskId: "t9",
        snippet: "The quarterly report was sent to finance this morning",
        timestamp: clock - 2 * DAY,
      } as ConversationHit,
    ]);

    expect(await expiry().sweep()).toMatchObject({ expired: 1 });
    expect((await items.findById(item.id))?.status).toBe("archived");
    expect(await curation.listLog("ws-1")).toEqual([]);
    const [log] = await curation.listLog("ws-2");
    expect(log).toMatchObject({ op: "expire_commitment", hasGlobal: true });
  });

  it("runs once a day per process and waits for the lane migration", async () => {
    const service = expiry();
    expect(await service.sweep()).toMatchObject({ expired: 0 });
    expect(await service.sweep()).toBe("cooldown");
    clock += DAY;
    expect(await service.sweep()).toMatchObject({ expired: 0 });
    expect(await service.sweep({ force: true })).toMatchObject({ expired: 0 });

    db.prepare("DELETE FROM maintenance_state").run();
    expect(await expiry().sweep()).toBe("unavailable");
    expect(await expiry({ getWriter: () => null }).sweep()).toBe("unavailable");
  });

  it("shares one in-flight sweep", async () => {
    await commitment();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const search = vi.fn(async () => {
      await gate;
      return [];
    });
    const service = expiry({ searchConversation: search });
    const first = service.sweep();
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    expect(await service.sweep({ force: true })).toBe("in_flight");
    release();
    expect(await first).toMatchObject({ checked: 1, expired: 0 });
  });

  it("lists and undoes only commitment expiries, and forgetting scrubs the log", async () => {
    const item = await commitment();
    archiveRow("m1", "ws-1", "Quarterly report sent to finance, task completed", clock - 4 * DAY);
    await expiry().sweep();
    const other = await writer.ingest({
      content: "Enjoys jazz playlists while coding",
      kind: "preference",
      scope: "workspace",
      workspaceId: "ws-1",
      source: "inferred",
    });
    if (other.status !== "written") throw new Error("not written");
    const decay = await writer.applyCuration({
      workspaceId: "ws-1",
      runId: null,
      candidateId: null,
      origin: "auto",
      fingerprint: "decay:x",
      summary: "Archived an unused item",
      rationale: null,
      allowProtected: false,
      operation: { op: "decay", itemIds: [other.item.id] },
    });
    if (decay.status !== "applied") throw new Error("not applied");

    const hub = review();
    expect((await hub.state("ws-1")).recent.map((change) => change.op)).toEqual([
      "expire_commitment",
    ]);
    await expect(hub.undo("ws-1", decay.log.id)).rejects.toThrow(/not found/);

    await writer.setStatus(item.id, "deleted");
    expect((await curation.listLog("ws-1")).map((log) => log.op)).toEqual(["decay"]);
  });
});

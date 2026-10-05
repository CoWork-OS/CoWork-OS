import fs from "fs/promises";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CuratedMemoryService } from "../CuratedMemoryService";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter, type MemoryCandidate } from "../MemoryWriter";
import { purgeTaskDerivedRows, purgeWorkspaceMemoryRows } from "../memory-purge-sql";
import {
  MEMORY_ITEM_RETENTION_RULES,
  MEMORY_ITEM_REVISION_RETENTION_RULES,
  SUPERSEDED_REVISIONS_KEPT,
  deleteRetentionBatch,
} from "../memory-retention-sql";
import { ensureMemoryCurationSchema } from "../memory-curation-log-sql";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("memory items lifecycle", () => {
  let db: Database.Database;
  let writer: MemoryWriter;
  let clock: number;

  const write = (overrides: Partial<MemoryCandidate>) =>
    writer.ingest({
      content: "A fact",
      kind: "project_fact",
      scope: "workspace",
      workspaceId: "ws-1",
      source: "curated",
      ...overrides,
    });

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1", "ws-2"]);
    clock = 1_000_000;
    writer = new MemoryWriter({ repository: new MemoryItemsRepository(db), now: () => clock });
  });

  afterEach(() => {
    MemoryWriter.setInstance(null);
    db.close();
  });

  describe("purge", () => {
    it("task delete removes task-scoped items, and derived ones only when asked", async () => {
      await write({ content: "Scratch note", scope: "task", scopeRef: "task-1", taskId: "task-1" });
      await write({ content: "Inferred in task", source: "inferred", taskId: "task-1" });
      await write({ content: "User said in task", source: "user_stated", taskId: "task-1" });
      await write({ content: "Other task", source: "inferred", taskId: "task-2" });

      const plain = purgeTaskDerivedRows(db, "task-1");
      expect(plain.memoryItems).toBe(1);
      expect(rowsOf(db).map((row) => row.content)).toEqual([
        "Inferred in task",
        "User said in task",
        "Other task",
      ]);
      // Every remaining link to the task is cleared, so nothing points at a deleted task.
      expect(rowsOf(db, "task_id = 'task-1'")).toHaveLength(0);

      await write({ content: "Inferred again", source: "inferred", taskId: "task-3" });
      await write({ content: "Stated again", source: "user_stated", taskId: "task-3" });
      const derived = purgeTaskDerivedRows(db, "task-3", { purgeDerivedMemory: true });
      expect(derived.memoryItems).toBe(1);
      expect(rowsOf(db, "content = 'Stated again'")[0]).toMatchObject({ task_id: null });
      expect(rowsOf(db, "content = 'Inferred again'")).toHaveLength(0);
    });

    it("Clear All Memories removes the workspace's items and keeps global and other workspaces", async () => {
      await write({ content: "Workspace one fact" });
      await write({ content: "Task fact", scope: "task", scopeRef: "task-1" });
      await write({ content: "Workspace two fact", workspaceId: "ws-2" });
      await write({ content: "Global fact", scope: "global", workspaceId: null });

      const counts = purgeWorkspaceMemoryRows(db, "ws-1");
      expect(counts.memoryItems).toBe(2);
      expect(rowsOf(db).map((row) => row.content)).toEqual(["Workspace two fact", "Global fact"]);
    });
  });

  describe("retention", () => {
    it("drops forgotten tombstones and expired items, and keeps the rest", async () => {
      await write({ content: "Forget me", sourceRef: { store: "s", id: "1" } });
      await writer.setStatusBySourceRef("s", "1", "deleted");
      await write({ content: "Expired", expiresAt: clock - 1 });
      await write({ content: "Not yet", expiresAt: clock + 60_000 });
      await write({ content: "Forever" });

      let deleted = 0;
      for (const rule of MEMORY_ITEM_RETENTION_RULES) {
        deleted += deleteRetentionBatch(db, rule, clock, 100);
      }
      expect(deleted).toBe(2);
      expect(rowsOf(db).map((row) => row.content)).toEqual(["Not yet", "Forever"]);
    });

    const DAY = 24 * 60 * 60 * 1000;
    const pruneRevisions = (cutoff: number) => {
      let deleted = 0;
      for (const rule of MEMORY_ITEM_REVISION_RETENTION_RULES) {
        deleted += deleteRetentionBatch(db, rule, cutoff, 100);
      }
      return deleted;
    };
    /** `count` revisions of one named subject, one day apart; returns the contents. */
    const writeRevisions = async (count: number, prefix = "Style") => {
      const contents: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const content = `${prefix} revision ${index + 1}`;
        await write({ content, kind: "preference", subjectKey: `response_style_${prefix}` });
        contents.push(content);
        clock += DAY;
      }
      return contents;
    };

    it("drops old superseded revisions but keeps the newest of each item", async () => {
      ensureMemoryCurationSchema(db, clock);
      const contents = await writeRevisions(SUPERSEDED_REVISIONS_KEPT + 4);
      // A second item with a short history: nothing of it goes.
      const short = await writeRevisions(3, "Tone");
      clock += 400 * DAY;

      // Not old enough yet: nothing is dropped.
      expect(pruneRevisions(clock - 1000 * DAY)).toBe(0);

      // Nine rows: the active one and eight superseded revisions, five of them kept.
      const deleted = pruneRevisions(clock - 180 * DAY);
      expect(deleted).toBe(3);
      const remaining = rowsOf(db).map((row) => row.content);
      // The active row and the newest SUPERSEDED_REVISIONS_KEPT revisions stay.
      expect(remaining).toEqual([...contents.slice(3), ...short]);
      expect(rowsOf(db, "status = 'active'")).toHaveLength(2);
      // A second run has nothing left to do.
      expect(pruneRevisions(clock - 180 * DAY)).toBe(0);
    });

    it("keeps revisions an undoable curation change still needs", async () => {
      ensureMemoryCurationSchema(db, clock);
      const contents = await writeRevisions(SUPERSEDED_REVISIONS_KEPT + 4);
      clock += 400 * DAY;
      const idOf = (content: string) => rowsOf(db, "content = ?", content)[0]?.id as string;
      const insertLog = (id: string, itemIds: string[], undoneAt: number | null) =>
        db
          .prepare(
            `INSERT INTO memory_curation_log
               (id, workspace_id, op, origin, fingerprint, item_ids, summary, applied_at, undone_at)
             VALUES (?, 'ws-1', 'merge', 'heuristic', ?, ?, 'merged', ?, ?)`,
          )
          .run(id, id, JSON.stringify(itemIds), clock, undoneAt);
      insertLog("log-open", [idOf(contents[0]!)], null);
      insertLog("log-undone", [idOf(contents[1]!)], clock);

      expect(pruneRevisions(clock - 180 * DAY)).toBe(2);
      const remaining = rowsOf(db).map((row) => row.content);
      expect(remaining).toContain(contents[0]);
      expect(remaining).not.toContain(contents[1]);
      expect(remaining).not.toContain(contents[2]);
    });

    it("skips revision retention until the curation log exists", async () => {
      await writeRevisions(SUPERSEDED_REVISIONS_KEPT + 3);
      clock += 400 * DAY;
      expect(pruneRevisions(clock - 180 * DAY)).toBe(0);
    });
  });

  describe("curated memory and kit view", () => {
    let workspacePath: string;

    beforeEach(async () => {
      workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-memory-items-kit-"));
      MemoryWriter.setInstance(writer);
      const internals = CuratedMemoryService as unknown as Record<string, unknown>;
      internals.workspaceRepo = { findById: () => ({ id: "ws-1", path: workspacePath }) };
      internals.initialized = true;
    });

    afterEach(async () => {
      (CuratedMemoryService as unknown as Record<string, unknown>).initialized = false;
      await fs.rm(workspacePath, { recursive: true, force: true });
    });

    const userMd = () => fs.readFile(path.join(workspacePath, ".cowork", "USER.md"), "utf8");
    const memoryMd = () => fs.readFile(path.join(workspacePath, ".cowork", "MEMORY.md"), "utf8");

    it("writes add, replace and remove to memory_items (a stale id follows the record)", async () => {
      const added = await CuratedMemoryService.curate({
        workspaceId: "ws-1",
        action: "add",
        target: "user",
        kind: "preference",
        content: "Prefers short commit messages",
      });
      expect(added.success).toBe(true);
      const id = added.entry!.id;
      expect(rowsOf(db, "status = 'active'")).toMatchObject([
        { content: "Prefers short commit messages", pinned: 1, source: "curated" },
      ]);

      await CuratedMemoryService.curate({
        workspaceId: "ws-1",
        action: "replace",
        target: "user",
        id,
        content: "Prefers conventional commit messages",
      });
      expect(rowsOf(db).map((row) => [row.content, row.status])).toEqual([
        ["Prefers short commit messages", "superseded"],
        ["Prefers conventional commit messages", "active"],
      ]);

      await CuratedMemoryService.curate({
        workspaceId: "ws-1",
        action: "remove",
        target: "user",
        id,
      });
      expect(rowsOf(db, "status = 'active'")).toHaveLength(0);
      expect(rowsOf(db, "status = 'archived'")).toHaveLength(1);
    });

    it("renders the kit blocks from memory_items only", async () => {
      // A row left in the retired table is never rendered.
      db.prepare(
        `INSERT INTO curated_memory_entries (id, workspace_id, target, kind, content,
           normalized_key, source, created_at, updated_at)
         VALUES ('legacy-1', 'ws-1', 'workspace', 'project_fact', 'Legacy table fact',
           'legacy table fact', 'agent_tool', 1, 1)`,
      ).run();
      await CuratedMemoryService.curate({
        workspaceId: "ws-1",
        action: "add",
        target: "workspace",
        kind: "workflow_rule",
        content: "Run the linter before commits",
      });
      await write({ content: "Decided to keep SQLite", kind: "decision" });
      await write({ content: "Private plan", kind: "project_fact", privacy: "private" });
      await write({ content: "Calls the user Sam", kind: "identity" });
      await CuratedMemoryService.syncWorkspaceFiles("ws-1");

      const memory = await memoryMd();
      expect(memory).toContain("Rule: Run the linter before commits");
      expect(memory).toContain("Decision: Decided to keep SQLite");
      expect(memory).not.toContain("Private plan");
      expect(memory).not.toContain("Legacy table fact");
      expect(await userMd()).toContain("identity: Calls the user Sam");
    });
  });
});

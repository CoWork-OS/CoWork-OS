import fs from "fs/promises";
import os from "os";
import path from "path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CuratedMemoryService } from "../CuratedMemoryService";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter, type MemoryCandidate } from "../MemoryWriter";
import { purgeTaskDerivedRows, purgeWorkspaceMemoryRows } from "../memory-purge-sql";
import { MEMORY_ITEM_RETENTION_RULES, deleteRetentionBatch } from "../memory-retention-sql";
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

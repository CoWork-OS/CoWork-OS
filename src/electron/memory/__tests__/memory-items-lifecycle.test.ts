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

  describe("curated dual write and kit view", () => {
    let workspacePath: string;
    const entries: Array<Record<string, unknown>> = [];

    beforeEach(async () => {
      workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-memory-items-kit-"));
      entries.length = 0;
      MemoryWriter.setInstance(writer);
      const curatedRepo = {
        findByNormalizedKey: () => undefined,
        findById: (id: string) => entries.find((entry) => entry.id === id),
        create(input: Record<string, unknown>) {
          const entry = {
            ...input,
            id: `curated-${entries.length + 1}`,
            createdAt: 1,
            updatedAt: 1,
          };
          entries.push(entry);
          return entry;
        },
        update(id: string, patch: Record<string, unknown>) {
          const entry = entries.find((item) => item.id === id);
          if (entry) Object.assign(entry, patch);
          return entry;
        },
        archive(id: string) {
          const entry = entries.find((item) => item.id === id);
          if (entry) entry.status = "archived";
          return entry;
        },
        list(params: Record<string, unknown>) {
          return entries.filter(
            (entry) =>
              entry.workspaceId === params.workspaceId &&
              (!params.target || entry.target === params.target) &&
              (!params.status || entry.status === params.status),
          );
        },
      };
      const internals = CuratedMemoryService as unknown as Record<string, unknown>;
      internals.curatedRepo = curatedRepo;
      internals.workspaceRepo = { findById: () => ({ id: "ws-1", path: workspacePath }) };
      internals.initialized = true;
    });

    afterEach(async () => {
      (CuratedMemoryService as unknown as Record<string, unknown>).initialized = false;
      await fs.rm(workspacePath, { recursive: true, force: true });
    });

    const userMd = () => fs.readFile(path.join(workspacePath, ".cowork", "USER.md"), "utf8");
    const memoryMd = () => fs.readFile(path.join(workspacePath, ".cowork", "MEMORY.md"), "utf8");

    it("mirrors add, replace and remove into memory_items", async () => {
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

    it("renders the kit blocks from memory_items once the lane migration is recorded", async () => {
      await CuratedMemoryService.curate({
        workspaceId: "ws-1",
        action: "add",
        target: "workspace",
        kind: "workflow_rule",
        content: "Run the linter before commits",
      });
      // Before the marker: the legacy curated table drives the files.
      expect(await memoryMd()).toContain("Workflow Rule: Run the linter before commits");

      await new MemoryItemsRepository(db).recordLaneMigration({});
      await write({ content: "Decided to keep SQLite", kind: "decision" });
      await write({ content: "Private plan", kind: "project_fact", privacy: "private" });
      await write({ content: "Calls the user Sam", kind: "identity" });
      await CuratedMemoryService.syncWorkspaceFiles("ws-1");

      const memory = await memoryMd();
      expect(memory).toContain("Rule: Run the linter before commits");
      expect(memory).toContain("Decision: Decided to keep SQLite");
      expect(memory).not.toContain("Private plan");
      expect(await userMd()).toContain("identity: Calls the user Sam");
    });
  });
});

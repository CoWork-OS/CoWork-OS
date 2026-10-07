import type Database from "better-sqlite3";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CuratedMemoryService,
  balanceCuratedPromptEntries,
  curatedKindOf,
  curatedTargetOf,
} from "../CuratedMemoryService";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter } from "../MemoryWriter";
import { curatedEntryCandidate } from "../memory-items-lanes";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;
const createdDirs: string[] = [];
const cleanups: Array<() => void> = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-curated-memory-"));
  createdDirs.push(dir);
  return dir;
}

/**
 * Curated memory is the workspace scope of memory_items: an in-memory profile database, a
 * writer, and a workspace directory (the retired generated kit files are never written).
 */
async function useMemoryItems(): Promise<{
  db: Database.Database;
  writer: MemoryWriter;
  workspacePath: string;
}> {
  const db = await createMemoryItemsTestDb(["ws1"]);
  const writer = new MemoryWriter({ repository: new MemoryItemsRepository(db) });
  MemoryWriter.setInstance(writer);
  cleanups.push(() => {
    MemoryWriter.setInstance(null);
    db.close();
  });
  const workspacePath = await createWorkspace();
  (CuratedMemoryService as Any).workspaceRepo = {
    findById: () => ({ id: "ws1", path: workspacePath }),
  };
  (CuratedMemoryService as Any).initialized = true;
  return { db, writer, workspacePath };
}

async function seed(
  writer: MemoryWriter,
  entries: Array<{ id: string; kind?: Any; target?: Any; content: string; source?: Any }>,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const entry of entries) {
    const result = await writer.ingest(
      curatedEntryCandidate({
        id: entry.id,
        workspaceId: "ws1",
        target: entry.target ?? "workspace",
        kind: entry.kind ?? "project_fact",
        content: entry.content,
        source: entry.source ?? "agent_tool",
        confidence: 0.85,
      }),
    );
    if (result.status === "written") ids[entry.id] = result.item.id;
  }
  return ids;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  (CuratedMemoryService as Any).initialized = false;
});

describeWithSqlite("CuratedMemoryService", () => {
  it("adds curated user memory as a workspace item without writing USER.md", async () => {
    const { db, workspacePath } = await useMemoryItems();
    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      taskId: "task-1",
      action: "add",
      target: "user",
      kind: "preference",
      content: "Prefers concise answers",
    });

    expect(result.success).toBe(true);
    expect(result.entry).toMatchObject({ target: "user", kind: "preference", status: "active" });
    expect(rowsOf(db)).toMatchObject([
      {
        id: result.entry?.id,
        scope: "workspace",
        workspace_id: "ws1",
        kind: "preference",
        source: "curated",
        pinned: 1,
        task_id: "task-1",
      },
    ]);
    await expect(fs.stat(path.join(workspacePath, ".cowork", "USER.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses id-based replace (a new revision) and truncates oversized content", async () => {
    const { db, writer } = await useMemoryItems();
    const ids = await seed(writer, [{ id: "c1", content: "Original fact" }]);

    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      action: "replace",
      id: ids.c1,
      target: "workspace",
      kind: "workflow_rule",
      content: "x".repeat(500),
    });

    expect(result.success).toBe(true);
    const rows = rowsOf(db);
    expect(rows.map((row) => row.status)).toEqual(["superseded", "active"]);
    expect(String(rows[1].content).length).toBeLessThanOrEqual(320);
    expect(rows[1].kind).toBe("rule");
    expect(result.entry?.kind).toBe("workflow_rule");
  });

  it("treats match strings literally and archives only the matching item", async () => {
    const { db, writer } = await useMemoryItems();
    await seed(writer, [
      { id: "c1", content: "Alpha_1 rollout plan" },
      { id: "c2", content: "AlphaX1 rollout plan" },
    ]);

    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      action: "remove",
      target: "workspace",
      match: "Alpha_1",
    });

    expect(result.success).toBe(true);
    expect(rowsOf(db).map((row) => [row.content, row.status])).toEqual([
      ["Alpha_1 rollout plan", "archived"],
      ["AlphaX1 rollout plan", "active"],
    ]);
  });

  it("fails when a non-id substring match is ambiguous", async () => {
    const { writer } = await useMemoryItems();
    await seed(writer, [
      { id: "c1", content: "Deploy billing service first" },
      { id: "c2", kind: "workflow_rule", content: "Deploy worker after migration" },
    ]);

    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      action: "remove",
      target: "workspace",
      match: "deploy",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/multiple memories matched/i);
  });

  it("refuses to rewrite or remove what the user stated", async () => {
    const { db, writer } = await useMemoryItems();
    const stated = await writer.ingest({
      content: "Releases ship on Tuesdays",
      kind: "project_fact",
      scope: "workspace",
      workspaceId: "ws1",
      source: "user_stated",
      sourceRef: { store: "memory_hub", id: "h1" },
    });
    const id = stated.status === "written" ? stated.item.id : "";
    for (const action of ["replace", "remove"] as const) {
      const result = await CuratedMemoryService.curate({
        workspaceId: "ws1",
        action,
        target: "workspace",
        id,
        content: "Releases ship on Fridays",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Memory Hub/);
    }
    expect(rowsOf(db).map((row) => [row.content, row.status])).toEqual([
      ["Releases ship on Tuesdays", "active"],
    ]);
  });

  it("refuses an id from another workspace", async () => {
    const { db, writer } = await useMemoryItems();
    db.prepare("INSERT INTO workspaces (id, name, path) VALUES ('ws2', 'ws2', '/tmp/ws2')").run();
    const other = await writer.ingest(
      curatedEntryCandidate({
        id: "o1",
        workspaceId: "ws2",
        target: "workspace",
        kind: "project_fact",
        content: "Another workspace's fact",
        source: "agent_tool",
        confidence: 0.85,
      }),
    );
    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      action: "remove",
      target: "workspace",
      id: other.status === "written" ? other.item.id : "",
    });
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/does not belong/);
  });

  it("lists curated entries from memory_items and maps lanes and kinds", async () => {
    const { writer } = await useMemoryItems();
    await seed(writer, [
      { id: "c1", target: "user", kind: "identity", content: "Goes by Sam" },
      { id: "c2", kind: "constraint", content: "Never force-push main" },
    ]);
    const all = await CuratedMemoryService.list("ws1");
    expect(all.map((entry) => [entry.content, entry.target, entry.kind]).sort()).toEqual([
      ["Goes by Sam", "user", "identity"],
      ["Never force-push main", "workspace", "constraint"],
    ]);
    expect(
      (await CuratedMemoryService.list("ws1", { target: "user" })).map((entry) => entry.content),
    ).toEqual(["Goes by Sam"]);
    expect(curatedKindOf({ kind: "rule", sourceRef: {} })).toBe("constraint");
    expect(curatedTargetOf({ kind: "decision", sourceRef: {} })).toBe("workspace");
  });

  it("promotes distilled entries as inferred items and reinforces a repeat", async () => {
    const { db } = await useMemoryItems();
    const first = await CuratedMemoryService.upsertDistilledEntry({
      workspaceId: "ws1",
      target: "workspace",
      kind: "workflow_rule",
      content: "Run the linter before committing",
      confidence: 0.8,
      skipMemoryWriteGate: true,
    });
    await CuratedMemoryService.upsertDistilledEntry({
      workspaceId: "ws1",
      target: "workspace",
      kind: "workflow_rule",
      content: "Run the linter before committing",
      confidence: 0.9,
      skipMemoryWriteGate: true,
    });
    expect(first).toMatchObject({ source: "distill", kind: "workflow_rule" });
    expect(rowsOf(db)).toMatchObject([
      { source: "inferred", kind: "rule", reinforced_count: 1, confidence: 0.9 },
    ]);
  });

  it("reports memory as unavailable without the memory engine", async () => {
    (CuratedMemoryService as Any).initialized = true;
    const result = await CuratedMemoryService.curate({
      workspaceId: "ws1",
      action: "add",
      target: "workspace",
      content: "Some fact",
    });
    expect(result).toEqual({ success: false, error: "Memory is not available yet." });
  });
});

describe("curated prompt entry balance", () => {
  const user = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
  const ws = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);

  it("keeps workspace rules when the user lane alone could fill the top 10", () => {
    expect(balanceCuratedPromptEntries(user(12), ws(8), 10)).toEqual([...user(6), ...ws(4)]);
  });

  it("lets either lane fill slots the other leaves unused", () => {
    expect(balanceCuratedPromptEntries(user(2), ws(12), 10)).toEqual([...user(2), ...ws(8)]);
    expect(balanceCuratedPromptEntries(user(12), ws(1), 10)).toEqual([...user(9), ...ws(1)]);
    expect(balanceCuratedPromptEntries(user(3), ws(2), 10)).toEqual([...user(3), ...ws(2)]);
  });

  it.skipIf(!nativeSqliteAvailable)(
    "balances the user and workspace lanes of memory_items for prompt entries",
    async () => {
      const { writer, db } = await useMemoryItems();
      for (let i = 0; i < 12; i += 1) {
        await writer.ingest(
          curatedEntryCandidate({
            id: `u${i}`,
            workspaceId: "ws1",
            target: "user",
            kind: "preference",
            content: `User preference number ${i}`,
            source: "agent_tool",
            confidence: 0.9,
          }),
        );
      }
      for (let i = 0; i < 8; i += 1) {
        await writer.ingest(
          curatedEntryCandidate({
            id: `w${i}`,
            workspaceId: "ws1",
            target: "workspace",
            kind: "workflow_rule",
            content: `Workspace rule number ${i}`,
            source: "agent_tool",
            confidence: 0.9,
          }),
        );
      }
      // Private items (strict privacy mode) never reach prompts.
      db.prepare("UPDATE memory_items SET privacy = 'private' WHERE content = ?").run(
        "Workspace rule number 7",
      );
      const entries = await CuratedMemoryService.getPromptEntries("ws1", 10);
      expect(entries.filter((entry) => entry.target === "user")).toHaveLength(6);
      expect(entries.filter((entry) => entry.target === "workspace")).toHaveLength(4);
      expect(entries.map((entry) => entry.content)).not.toContain("Workspace rule number 7");
    },
  );
});

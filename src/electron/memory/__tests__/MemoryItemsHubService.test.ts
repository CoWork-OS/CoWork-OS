import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRepoService } from "../repo/MemoryRepoService";
import { parseMemoryRepoEntries } from "../repo/memory-repo-format";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryHubError, MemoryItemsHubService } from "../MemoryItemsHubService";
import { MemoryWriter } from "../MemoryWriter";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("MemoryItemsHubService", () => {
  let db: Database.Database;
  let writer: MemoryWriter;
  let clock: number;
  let bumps: number;
  let hub: MemoryItemsHubService;

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1", "ws-2"]);
    clock = 1_000;
    bumps = 0;
    writer = new MemoryWriter({
      repository: new MemoryItemsRepository(db),
      now: () => (clock += 10),
      bumpHotMemoryVersion: () => {
        bumps += 1;
      },
    });
    hub = new MemoryItemsHubService({
      getWriter: () => writer,
      getTask: async (taskId) =>
        taskId === "task-1"
          ? { id: "task-1", title: "Plan the launch", workspaceId: "ws-1" }
          : taskId === "task-2"
            ? { id: "task-2", title: "Secret other task", workspaceId: "ws-2" }
            : undefined,
    });
  });

  afterEach(() => {
    db.close();
  });

  async function seed() {
    const global = await writer.ingest({
      content: "Prefers concise answers",
      kind: "preference",
      scope: "global",
      source: "user_stated",
      sourceRef: { store: "user_profile", id: "fact-1" },
      taskId: "task-2",
    });
    const local = await writer.ingest({
      content: "The API uses PostgreSQL 16",
      kind: "project_fact",
      scope: "workspace",
      workspaceId: "ws-1",
      source: "curated",
      sourceRef: { store: "curated", id: "entry-1", target: "workspace" },
      taskId: "task-1",
    });
    const foreign = await writer.ingest({
      content: "Other workspace deploys on Fridays",
      kind: "rule",
      scope: "workspace",
      workspaceId: "ws-2",
      source: "user_stated",
    });
    const contact = await writer.ingest({
      content: "Dana asked for the Q3 numbers",
      kind: "commitment",
      scope: "contact",
      scopeRef: "contact-dana",
      source: "third_party",
    });
    const ids = [global, local, foreign, contact].map((result) => {
      if (result.status !== "written") throw new Error("seed write skipped");
      return result.item.id;
    });
    return { globalId: ids[0], localId: ids[1], foreignId: ids[2], contactId: ids[3] };
  }

  it("lists the workspace's items with global and contact items, never another workspace's", async () => {
    const { foreignId, contactId } = await seed();
    const page = await hub.list({ workspaceId: "ws-1" });
    expect(page.items.map((item) => item.content).sort()).toEqual([
      "Dana asked for the Q3 numbers",
      "Prefers concise answers",
      "The API uses PostgreSQL 16",
    ]);
    expect(page.items.some((item) => item.id === foreignId)).toBe(false);
    const contact = page.items.find((item) => item.id === contactId);
    // Third-party text is private by default; the owner still sees it, flagged.
    expect(contact).toMatchObject({ scope: "contact", source: "third_party", private: true });
    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(false);
    // The renderer view carries no raw provenance.
    expect(Object.keys(page.items[0])).not.toContain("sourceRef");
  });

  it("filters by query, kind, source and pages through results", async () => {
    await seed();
    expect((await hub.list({ workspaceId: "ws-1", query: "postgres" })).items).toHaveLength(1);
    expect((await hub.list({ workspaceId: "ws-1", query: "100%_" })).items).toHaveLength(0);
    expect(
      (await hub.list({ workspaceId: "ws-1", kinds: ["preference"] })).items.map((i) => i.kind),
    ).toEqual(["preference"]);
    expect(
      (await hub.list({ workspaceId: "ws-1", sources: ["curated"] })).items.map((i) => i.source),
    ).toEqual(["curated"]);
    const first = await hub.list({ workspaceId: "ws-1", limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await hub.list({ workspaceId: "ws-1", limit: 2, offset: 2 });
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it("treats another workspace's item as missing for every operation", async () => {
    const { foreignId } = await seed();
    for (const run of [
      () => hub.get("ws-1", foreignId),
      () => hub.why("ws-1", foreignId),
      () => hub.update({ workspaceId: "ws-1", id: foreignId, content: "Hijacked" }),
      () => hub.setPinned({ workspaceId: "ws-1", id: foreignId, pinned: true }),
      () => hub.delete({ workspaceId: "ws-1", id: foreignId }),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(hub.get("ws-1", "missing")).rejects.toBeInstanceOf(MemoryHubError);
    expect(rowsOf(db, "id = ?", foreignId)[0]).toMatchObject({
      content: "Other workspace deploys on Fridays",
      status: "active",
      pinned: 0,
    });
  });

  it("adds user-stated facts globally or in the workspace", async () => {
    const added = await hub.add({
      workspaceId: "ws-1",
      content: "My timezone is Europe/Helsinki",
      kind: "identity",
      scope: "global",
      pinned: true,
    });
    expect(added).toMatchObject({
      success: true,
      item: { source: "user_stated", scope: "global", workspaceId: null, pinned: true },
    });

    const local = await hub.add({
      workspaceId: "ws-1",
      content: "Releases are cut on Tuesdays",
      kind: "rule",
      scope: "workspace",
    });
    expect(local).toMatchObject({ success: true, item: { workspaceId: "ws-1" } });
    const row = rowsOf(db, "content = ?", "Releases are cut on Tuesdays")[0];
    expect(JSON.parse(String(row.source_ref))).toMatchObject({ store: "memory_hub" });

    const rejected = await hub.add({
      workspaceId: "ws-1",
      content: "ok",
      kind: "preference",
      scope: "global",
    });
    expect(rejected).toMatchObject({ success: false, reason: "low_salience" });
  });

  it("edits as a new user-stated revision and keeps the chain", async () => {
    const { localId } = await seed();
    const result = await hub.update({
      workspaceId: "ws-1",
      id: localId,
      content: "The API uses PostgreSQL 17",
    });
    expect(result.success).toBe(true);
    if (!result.success || !result.item) throw new Error("edit failed");
    expect(result.item).toMatchObject({
      content: "The API uses PostgreSQL 17",
      source: "user_stated",
      supersedesId: localId,
      kind: "project_fact",
    });
    expect(rowsOf(db, "id = ?", localId)[0].status).toBe("superseded");

    const detail = await hub.get("ws-1", result.item.id);
    expect(detail.previous.map((item) => item.id)).toEqual([localId]);
    const old = await hub.get("ws-1", localId);
    expect(old.supersededBy?.id).toBe(result.item.id);

    // Editing a superseded revision is refused.
    expect(await hub.update({ workspaceId: "ws-1", id: localId, content: "x y z" })).toMatchObject({
      success: false,
      reason: "status",
    });
  });

  it("pins and bumps the hot-memory version", async () => {
    const { globalId } = await seed();
    const before = bumps;
    const result = await hub.setPinned({ workspaceId: "ws-1", id: globalId, pinned: true });
    expect(result).toMatchObject({ success: true, item: { pinned: true } });
    expect(bumps).toBeGreaterThan(before);
    await hub.setPinned({ workspaceId: "ws-1", id: globalId, pinned: false });
    expect(rowsOf(db, "id = ?", globalId)[0].pinned).toBe(0);
  });

  it("delete scrubs every revision", async () => {
    const { localId } = await seed();
    const edited = await hub.update({
      workspaceId: "ws-1",
      id: localId,
      content: "The API uses MySQL",
    });
    if (!edited.success || !edited.item) throw new Error("edit failed");
    const before = bumps;

    expect(await hub.delete({ workspaceId: "ws-1", id: edited.item.id })).toEqual({
      success: true,
      item: null,
    });
    const rows = rowsOf(db, "workspace_id = 'ws-1'");
    expect(rows.map((row) => [row.status, row.content])).toEqual([
      ["deleted", ""],
      ["deleted", ""],
    ]);
    expect(bumps).toBeGreaterThan(before);
    expect((await hub.list({ workspaceId: "ws-1" })).items.some((i) => i.id === localId)).toBe(
      false,
    );
  });

  it("explains where an item came from without leaking other workspaces' task titles", async () => {
    const { localId, globalId } = await seed();
    const local = await hub.why("ws-1", localId);
    expect(local).toMatchObject({
      source: "curated",
      store: "curated",
      summary: "Curated into .cowork/MEMORY.md.",
      task: { id: "task-1", title: "Plan the launch", available: true },
      details: { target: "workspace" },
    });
    const global = await hub.why("ws-1", globalId);
    expect(global.summary).toBe("You added this as a profile fact.");
    expect(global.task).toEqual({ id: "task-2", title: null, available: false });
  });

  it("clears global items only", async () => {
    const { globalId, localId, contactId } = await seed();
    const result = await hub.clearGlobal();
    expect(result).toEqual({ success: true, deleted: 1 });
    expect(rowsOf(db, "id = ?", globalId)).toHaveLength(0);
    expect(rowsOf(db, "id IN (?, ?)", localId, contactId)).toHaveLength(2);
  });

  describe("with the memory folder running", () => {
    let base: string;
    let repo: MemoryRepoService;
    let folderHub: MemoryItemsHubService;
    const lines = (file: string) =>
      parseMemoryRepoEntries(fs.readFileSync(path.join(repo.root, file), "utf8"));

    beforeEach(async () => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hub-folder-"));
      repo = new MemoryRepoService({ root: path.join(base, "memory"), runtime: "node" });
      await repo.start();
      folderHub = new MemoryItemsHubService({
        getWriter: () => writer,
        getMemoryRepo: () => repo,
        getWorkspaceName: async (id) => (id === "ws-1" ? "Billing" : null),
      });
    });

    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it("adds facts as the user's lines: me.md, the workspace file, MEMORY.md when pinned", async () => {
      const global = await folderHub.add({
        workspaceId: "ws-1",
        content: "Prefers concise answers",
        kind: "preference",
        scope: "global",
      });
      expect(global).toMatchObject({ success: true, item: null, ref: expect.stringMatching(/^repo:me\.md#L/) });
      await folderHub.add({ workspaceId: "ws-1", content: "The API uses Postgres", kind: "project_fact", scope: "workspace" });
      await folderHub.add({ workspaceId: "ws-1", content: "Answer in English", kind: "preference", scope: "global", pinned: true });
      expect(lines("me.md")).toEqual([expect.objectContaining({ text: "Prefers concise answers", by: "user" })]);
      expect(lines("workspaces/billing.md").map((entry) => entry.text)).toContain("The API uses Postgres");
      expect(lines("MEMORY.md").map((entry) => entry.text)).toEqual(["Answer in English"]);
      expect(rowsOf(db)).toHaveLength(0);
      const again = await folderHub.add({ workspaceId: "ws-1", content: "Prefers concise answers", kind: "preference", scope: "global" });
      expect(again).toMatchObject({ success: true, action: "reinforced" });
    });

    it("keeps commitments in memory_items", async () => {
      const result = await folderHub.add({
        workspaceId: "ws-1",
        content: "Send the Q3 report by Friday",
        kind: "commitment",
        scope: "workspace",
      });
      expect(result).toMatchObject({ success: true, item: expect.objectContaining({ kind: "commitment" }) });
      expect(rowsOf(db)).toHaveLength(1);
    });

    it("moves an edited or pinned fact item to the folder and deletes the item", async () => {
      const { globalId, localId } = await seed();
      const edited = await folderHub.update({ workspaceId: "ws-1", id: localId, content: "The API uses PostgreSQL 17" });
      expect(edited).toMatchObject({ success: true, action: "moved", ref: expect.stringMatching(/^repo:workspaces\/billing\.md#L/) });
      expect(rowsOf(db, "id = ? AND status = 'active'", localId)).toHaveLength(0);
      const pinned = await folderHub.setPinned({ workspaceId: "ws-1", id: globalId, pinned: true });
      expect(pinned).toMatchObject({ success: true, ref: expect.stringMatching(/^repo:MEMORY\.md#L/) });
      expect(lines("MEMORY.md").map((entry) => entry.text)).toEqual(["Prefers concise answers"]);
      expect(rowsOf(db, "id = ? AND status = 'active'", globalId)).toHaveLength(0);
    });

    it("reports a folder skip instead of falling back", async () => {
      const result = await folderHub.add({ workspaceId: "ws-1", content: "ok", kind: "preference", scope: "global" });
      expect(result).toMatchObject({ success: false });
      expect(rowsOf(db)).toHaveLength(0);
    });
  });

  it("reports the engine as unavailable before the writer starts", async () => {
    const idle = new MemoryItemsHubService({ getWriter: () => null });
    await expect(idle.list({ workspaceId: "ws-1" })).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

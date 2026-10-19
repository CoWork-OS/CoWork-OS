import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../schema";
import { ResourceClaimRepository } from "../repository-facades";
import { ResourceClaimStore, type ResourceClaimInput } from "../resource-claims-sql";
import { MissionControlIntelligenceStore } from "../../mission-control/MissionControlIntelligenceService";

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;
const NOW = 1_000_000_000;

describeWithSqlite("resource claims", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-claims-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
    manager
      .getDatabase()
      .prepare(
        "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ws-1", "Project", path.join(tmpDir, "project"), NOW, "{}");
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function task(
    id: string,
    options: {
      status?: string;
      worktree?: boolean;
      worktreeStatus?: string;
      updatedAt?: number;
    } = {},
  ) {
    manager
      .getDatabase()
      .prepare(
        `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at,
           worktree_path, worktree_status)
         VALUES (?, ?, ?, ?, 'ws-1', ?, ?, ?, ?)`,
      )
      .run(
        id,
        `Task ${id}`,
        "prompt",
        options.status ?? "executing",
        NOW,
        options.updatedAt ?? NOW,
        options.worktree ? `/repo/.cowork-worktrees/${id}` : null,
        options.worktree ? (options.worktreeStatus ?? "active") : null,
      );
  }

  const claim = (
    store: ResourceClaimStore,
    taskId: string,
    overrides: Partial<ResourceClaimInput> = {},
  ) =>
    store.claim({
      id: `claim-${taskId}-${overrides.resourceKey ?? "file:src/app.ts"}`,
      taskId,
      workspaceId: "ws-1",
      resourceKey: "file:src/app.ts",
      label: "src/app.ts",
      intent: `Task ${taskId}`,
      isolated: false,
      familyRoot: taskId,
      at: NOW,
      ...overrides,
    });

  it("refuses a second task in the same folder while the first is still running", () => {
    task("a");
    task("b");
    const store = new ResourceClaimStore(manager.getDatabase());
    expect(claim(store, "a")).toEqual({ claimed: true, others: [] });
    const refused = claim(store, "b");
    expect(refused.claimed).toBe(false);
    expect(refused.others).toEqual([
      { taskId: "a", title: "Task a", isolated: false, status: "executing" },
    ]);
    // A different file is free.
    expect(claim(store, "b", { resourceKey: "file:README.md", label: "README.md" }).claimed).toBe(
      true,
    );
  });

  it("frees the file when the first task stops, or has not moved for a day", () => {
    task("done", { status: "completed" });
    task("idle", { updatedAt: NOW - 25 * 60 * 60 * 1000 });
    task("b");
    const store = new ResourceClaimStore(manager.getDatabase());
    claim(store, "done");
    claim(store, "idle", { resourceKey: "file:README.md", label: "README.md" });
    expect(claim(store, "b").claimed).toBe(true);
    expect(claim(store, "b", { resourceKey: "file:README.md", label: "README.md" })).toMatchObject({
      claimed: true,
      others: [{ taskId: "idle" }],
    });
  });

  it("never blocks worktree tasks or tasks of one tree, and reports worktree overlaps", () => {
    task("lead");
    task("child");
    task("wt-1", { worktree: true });
    task("wt-2", { worktree: true, status: "completed" });
    const store = new ResourceClaimStore(manager.getDatabase());
    claim(store, "lead", { familyRoot: "lead" });
    expect(claim(store, "child", { familyRoot: "lead" }).claimed).toBe(true);
    expect(claim(store, "wt-1", { isolated: true }).claimed).toBe(true);
    expect(claim(store, "wt-2", { isolated: true }).claimed).toBe(true);

    const [overlap] = store.listOverlaps({ workspaceId: "ws-1" });
    expect(overlap.label).toBe("src/app.ts");
    expect(overlap.holders.map((holder) => holder.taskId).sort()).toEqual([
      "child",
      "lead",
      "wt-1",
      "wt-2",
    ]);
  });

  it("drops a worktree claim once its worktree is merged", () => {
    task("wt-1", { worktree: true, status: "completed", worktreeStatus: "merged" });
    task("wt-2", { worktree: true });
    const store = new ResourceClaimStore(manager.getDatabase());
    claim(store, "wt-1", { isolated: true });
    claim(store, "wt-2", { isolated: true });
    expect(store.listOverlaps()).toEqual([]);
    expect(store.listForTask("wt-1")).toEqual([
      { resourceKey: "file:src/app.ts", label: "src/app.ts", claimedAt: NOW },
    ]);
  });

  it("removes week-old claims that no longer count, and keeps the rest", () => {
    task("old-done", { status: "completed" });
    task("old-worktree", { worktree: true, status: "completed" });
    task("b");
    const store = new ResourceClaimStore(manager.getDatabase());
    const weekAgo = NOW - 8 * 24 * 60 * 60 * 1000;
    claim(store, "old-done", { at: weekAgo });
    claim(store, "old-worktree", { at: weekAgo, isolated: true, resourceKey: "file:b.txt" });
    claim(store, "b", { resourceKey: "file:c.txt", label: "c.txt" });
    expect(store.listForTask("old-done")).toEqual([]);
    // An unmerged worktree's claim still counts, however old.
    expect(store.listForTask("old-worktree")).toHaveLength(1);
  });

  it("puts overlaps in Mission Control and clears them when they end", async () => {
    task("a");
    task("b", { worktree: true });
    task("c", { worktree: true });
    const db = manager.getDatabase();
    const repository = new ResourceClaimRepository(db);
    await repository.claim({
      id: "1",
      taskId: "b",
      workspaceId: "ws-1",
      resourceKey: "file:src/app.ts",
      label: "src/app.ts",
      isolated: true,
      familyRoot: "b",
      at: NOW,
    });
    await repository.claim({
      id: "2",
      taskId: "c",
      workspaceId: "ws-1",
      resourceKey: "file:src/app.ts",
      label: "src/app.ts",
      isolated: true,
      familyRoot: "c",
      at: NOW,
    });

    const intelligence = new MissionControlIntelligenceStore(db);
    intelligence.refresh();
    const items = intelligence.listItems({}).filter((item) => item.title.includes("src/app.ts"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      category: "reviews",
      severity: "monitor_only",
      title: "2 tasks change src/app.ts",
      nextStep: "Review them together in Build > Merge review before merging either.",
    });

    db.prepare(
      "UPDATE tasks SET status = 'completed', worktree_status = 'merged' WHERE id = 'b'",
    ).run();
    intelligence.refresh();
    expect(intelligence.listItems({}).some((item) => item.title.includes("src/app.ts"))).toBe(
      false,
    );
  });
});

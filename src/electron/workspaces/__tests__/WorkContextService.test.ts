import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskRepository } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { WorkContextService } from "../WorkContextService";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("WorkContextService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let service: WorkContextService;
  let taskRepo: TaskRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-work-context-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    service = new WorkContextService(db);
    taskRepo = new TaskRepository(db);
    db.prepare(
      `
        INSERT INTO workspaces (id, name, path, created_at, permissions)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run("workspace-1", "Workspace", path.join(tmpDir, "workspace"), Date.now(), "{}");
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates one durable context per task and attaches forked tasks to it", () => {
    const primary = taskRepo.create({
      title: "Investigate release issue",
      prompt: "Investigate release issue",
      status: "pending",
      workspaceId: "workspace-1",
      source: "manual",
    });
    const context = service.ensureForTask(primary);
    const sameContext = service.ensureForTask(primary);
    const fork = taskRepo.create({
      title: "Investigate release issue (docs)",
      prompt: "Investigate release issue (docs)",
      status: "pending",
      workspaceId: "workspace-1",
      source: "manual",
    });

    expect(sameContext.id).toBe(context.id);
    expect(service.attachForkedTask(fork, primary.id)).toMatchObject({
      id: context.id,
      taskIds: [primary.id, fork.id],
    });
    expect(service.list({ workspaceId: "workspace-1" })).toHaveLength(1);
  });

  it("supports rename, state updates, and archive filtering", () => {
    const task = taskRepo.create({
      title: "Prepare briefing",
      prompt: "Prepare briefing",
      status: "pending",
      workspaceId: "workspace-1",
      source: "manual",
    });
    const context = service.ensureForTask(task);

    const updated = service.update({
      contextId: context.id,
      name: "Weekly briefing",
      status: "paused",
      state: { lastActivityKind: "checkpoint", lastCheckpointId: "checkpoint-1" },
    });
    expect(updated).toMatchObject({
      name: "Weekly briefing",
      status: "paused",
      state: {
        schemaVersion: 1,
        lastActivityKind: "checkpoint",
        lastCheckpointId: "checkpoint-1",
      },
    });

    expect(service.update({ contextId: context.id, status: "archived" })).toMatchObject({
      archivedAt: expect.any(Number),
      status: "archived",
    });
    expect(service.list({ workspaceId: "workspace-1" })).toEqual([]);
    expect(service.list({ workspaceId: "workspace-1", includeArchived: true })).toHaveLength(1);
  });

  it("rejects members from another workspace", () => {
    db.prepare(
      `
        INSERT INTO workspaces (id, name, path, created_at, permissions)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run("workspace-2", "Other", path.join(tmpDir, "other"), Date.now(), "{}");
    const context = service.create({ workspaceId: "workspace-1", name: "First" });
    const task = taskRepo.create({
      title: "Other task",
      prompt: "Other task",
      status: "pending",
      workspaceId: "workspace-2",
      source: "manual",
    });

    expect(() => service.addMember({ contextId: context.id, taskId: task.id })).toThrow(
      "Task does not belong to this WorkContext workspace",
    );
  });
});

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore } from "../../database/repositories";
import {
  SessionMembershipService,
  WorkContextService,
} from "../../workspaces/workspaces-repository-facades";
import { PrincipalCapabilityMiddleware } from "../../security/PrincipalCapabilityMiddleware";
import { createTaskReadHandler } from "../task-read-authorization";

const event = { sender: { id: 7 } } as IpcMainInvokeEvent;

describe("task read IPC boundary", () => {
  it.each(["task-1", { taskId: "task-1", eventId: "event-1" }])(
    "waits for task authorization for %j",
    async (request) => {
      let allow!: () => void;
      const permission = new Promise<void>((resolve) => {
        allow = resolve;
      });
      const authorization = {
        principalForClient: vi.fn(() => "guest"),
        authorizeTaskRead: vi.fn(() => permission),
      };
      const read = vi.fn((_event: IpcMainInvokeEvent, _request: unknown) => "private task data");
      const handle = createTaskReadHandler(authorization, read);
      const pending = handle(event, request);
      expect(read).not.toHaveBeenCalled();
      expect(authorization.authorizeTaskRead).toHaveBeenCalledWith("task-1", "guest");
      allow();
      await expect(pending).resolves.toBe("private task data");
    },
  );

  it("does not read after an asynchronous denial", async () => {
    const read = vi.fn();
    const handle = createTaskReadHandler(
      {
        principalForClient: () => "guest",
        authorizeTaskRead: async () => {
          throw new Error("Principal is not a member");
        },
      },
      read,
    );
    await expect(handle(event, "task-1")).rejects.toThrow("not a member");
    expect(read).not.toHaveBeenCalled();
  });
});

const sqliteAvailable = (() => {
  try {
    const db = new Database(":memory:");
    db.close();
    return true;
  } catch {
    return false;
  }
})();
const describeWithSqlite = sqliteAvailable ? describe : describe.skip;

describeWithSqlite("task read authorization with persisted membership", () => {
  let manager: DatabaseManager | undefined;
  let directory: string | undefined;
  let previousUserDataDir: string | undefined;

  afterEach(() => {
    manager?.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  it("limits guest detail/list/search reads to invited tasks and honors revocation", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-task-read-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = directory;
    manager = new DatabaseManager();
    const db = manager.getDatabase();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
    ).run("workspace-1", "Workspace", directory, Date.now(), "{}");
    const tasks = new TaskStore(db);
    const memberships = new SessionMembershipService(db);
    const contexts = new WorkContextService(db);
    const middleware = new PrincipalCapabilityMiddleware(db, memberships);
    const context = await contexts.create({ workspaceId: "workspace-1", name: "Shared" });
    const shared = tasks.create({
      title: "audit shared",
      prompt: "shared",
      status: "pending",
      workspaceId: "workspace-1",
    });
    const privateTask = tasks.create({
      title: "audit private",
      prompt: "private",
      status: "pending",
      workspaceId: "workspace-1",
    });
    db.prepare("UPDATE tasks SET created_at = 1, updated_at = 1 WHERE id = ?").run(shared.id);
    db.prepare("UPDATE tasks SET created_at = 2, updated_at = 2 WHERE id = ?").run(privateTask.id);
    await contexts.addMember({ contextId: context.id, taskId: shared.id });
    await memberships.ensureOwner(context.id);
    const invite = await memberships.createInvite({ contextId: context.id, role: "viewer" });
    const accepted = await memberships.acceptInvite({
      token: invite.token,
      displayName: "Guest",
      principalId: "guest-1",
    });
    memberships.registerClientPrincipal(7, accepted.principal.principalId);
    const read = vi.fn((_event, id: string) => tasks.findById(id));
    const handle = createTaskReadHandler(middleware, read);
    await expect(handle(event, privateTask.id)).rejects.toThrow("not a member");
    expect(read).not.toHaveBeenCalled();
    await expect(handle(event, shared.id)).resolves.toMatchObject({ id: shared.id });
    await expect(middleware.authorizeTask(shared.id, "contribute", "guest-1")).rejects.toThrow(
      "cannot contribute",
    );
    const visible = await middleware.filterAndPaginateTasks(
      async (limit, offset) => tasks.findAll(limit, offset),
      "view",
      "guest-1",
      1,
      0,
    );
    expect(visible.tasks.map((task) => task.id)).toEqual([shared.id]);
    const search = await middleware.filterAndPaginateTasks(
      async (limit, offset) => tasks.search("audit", { limit, offset }),
      "view",
      "guest-1",
      1,
      0,
    );
    expect(search.tasks.map((task) => task.id)).toEqual([shared.id]);
    expect(tasks.search("audit", { limit: 1, offset: 1 }).map((task) => task.id)).toEqual([
      shared.id,
    ]);
    const contributeInvite = await memberships.createInvite({
      contextId: context.id,
      role: "contributor",
    });
    await memberships.acceptInvite({
      token: contributeInvite.token,
      displayName: "Contributor",
      principalId: "contributor-1",
    });
    await expect(
      middleware.authorizeTask(shared.id, "contribute", "contributor-1"),
    ).resolves.toMatchObject({
      actor: { principalId: "contributor-1", role: "contributor" },
    });
    await memberships.updateMember({
      contextId: context.id,
      memberId: accepted.member.id,
      revoke: true,
    });
    await expect(handle(event, shared.id)).rejects.toThrow("revoked");
    const ownerEvent = { sender: { id: 99 } } as IpcMainInvokeEvent;
    await expect(handle(ownerEvent, "missing-task")).resolves.toBeUndefined();
  });
});

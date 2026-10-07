import { TaskStore } from "../../database/repositories";
import { ApprovalRepository } from "../../database/repository-facades";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";

import { SessionMembershipService, WorkContextService } from "../workspaces-repository-facades";

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

describeWithSqlite("SessionMembershipService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let service: SessionMembershipService;
  let taskRepo: TaskStore;
  let contextService: WorkContextService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-session-members-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    service = new SessionMembershipService(db);
    taskRepo = new TaskStore(db);
    contextService = new WorkContextService(db);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-1", "Workspace", path.join(tmpDir, "workspace"), Date.now(), "{}");
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createContext() {
    return await contextService.create({ workspaceId: "workspace-1", name: "Shared work" });
  }

  it("creates a local owner and restricts invites to owners", async () => {
    const context = await createContext();
    const principal = service.getLocalPrincipal();
    const snapshot = await service.getSnapshot(context.id);

    expect(snapshot.actor).toMatchObject({ principalId: principal.principalId, role: "owner" });
    expect(snapshot.members).toHaveLength(1);
    await expect(
      service.createInvite({ contextId: context.id, role: "viewer" }, "unknown-principal"),
    ).rejects.toThrow("Principal is not a member");
  });

  it("accepts one-use invites, enforces role capabilities, and records actions", async () => {
    const context = await createContext();
    const owner = service.getLocalPrincipal();
    await service.ensureOwner(context.id);
    const created = await service.createInvite({ contextId: context.id, role: "reviewer" });
    const accepted = await service.acceptInvite({
      token: created.token,
      displayName: "Review partner",
      principalId: "partner-1",
    });

    expect(accepted.member).toMatchObject({ role: "reviewer", status: "active" });
    await expect(
      service.acceptInvite({
        token: created.token,
        displayName: "Second partner",
        principalId: "partner-2",
      }),
    ).rejects.toThrow("already been used");
    await expect(
      service.authorizeTaskAction("missing-task", "view", accepted.principal.principalId),
    ).rejects.toThrow("Task not found");
    await expect(
      service.updateMember(
        {
          contextId: context.id,
          memberId: accepted.member.id,
          revoke: true,
        },
        accepted.principal.principalId,
      ),
    ).rejects.toThrow("cannot manage");

    const task = taskRepo.create({
      title: "Shared task",
      prompt: "Shared task",
      status: "pending",
      workspaceId: "workspace-1",
      source: "manual",
    });
    await contextService.addMember({ contextId: context.id, taskId: task.id });
    const approvalRepo = new ApprovalRepository(db);
    const approval = await approvalRepo.create({
      taskId: task.id,
      type: "run_command",
      description: "Run a command",
      details: {},
      status: "pending",
      requestedAt: Date.now(),
    });
    await approvalRepo.update(approval.id, "approved", {
      principalId: accepted.principal.principalId,
      role: accepted.member.role,
    });
    expect(await approvalRepo.findById(approval.id)).toMatchObject({
      resolvedByPrincipalId: accepted.principal.principalId,
      resolvedByRole: "reviewer",
    });
    await expect(
      service.authorizeTaskAction(task.id, "contribute", accepted.principal.principalId),
    ).rejects.toThrow("cannot contribute");
    await service.recordTaskAction(
      task.id,
      "review",
      "review_feedback",
      "step-1",
      undefined,
      accepted.principal.principalId,
    );
    expect(
      (await service.listAudit(context.id, owner.principalId)).map((entry) => entry.action),
    ).toEqual(
      expect.arrayContaining([
        "owner_created",
        "invite_created",
        "member_joined",
        "review_feedback",
      ]),
    );

    const revoked = await service.updateMember({
      contextId: context.id,
      memberId: accepted.member.id,
      revoke: true,
    });
    expect(revoked.status).toBe("revoked");
    await expect(
      service.authorizeTaskAction(task.id, "view", accepted.principal.principalId),
    ).rejects.toThrow("revoked");
  });

  it("keeps session membership separate from workspace membership", async () => {
    const context = await createContext();
    await expect(service.getSnapshot(context.id, "workspace-member")).rejects.toThrow(
      "Principal is not a member",
    );
  });

  it("only lists sessions granted to the active principal", async () => {
    const shared = await createContext();
    const privateContext = await contextService.create({
      workspaceId: "workspace-1",
      name: "Private work",
    });
    await service.ensureOwner(shared.id);
    const invite = await service.createInvite({ contextId: shared.id, role: "viewer" });
    const accepted = await service.acceptInvite({
      token: invite.token,
      displayName: "Read-only partner",
      principalId: "viewer-1",
    });

    const visible = await service.listAccessibleContexts({}, accepted.principal.principalId);
    expect(visible.map((context) => context.id)).toEqual([shared.id]);
    await expect(
      service.getSnapshot(privateContext.id, accepted.principal.principalId),
    ).rejects.toThrow("Principal is not a member");
  });
});

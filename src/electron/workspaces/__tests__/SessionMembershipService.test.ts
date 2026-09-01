import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { ApprovalRepository, TaskRepository } from "../../database/repositories";
import { SessionMembershipService } from "../SessionMembershipService";
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

describeWithSqlite("SessionMembershipService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let service: SessionMembershipService;
  let taskRepo: TaskRepository;
  let contextService: WorkContextService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-session-members-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    service = new SessionMembershipService(db);
    taskRepo = new TaskRepository(db);
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

  function createContext() {
    return contextService.create({ workspaceId: "workspace-1", name: "Shared work" });
  }

  it("creates a local owner and restricts invites to owners", () => {
    const context = createContext();
    const principal = service.getLocalPrincipal();
    const snapshot = service.getSnapshot(context.id);

    expect(snapshot.actor).toMatchObject({ principalId: principal.principalId, role: "owner" });
    expect(snapshot.members).toHaveLength(1);
    expect(() =>
      service.createInvite({ contextId: context.id, role: "viewer" }, "unknown-principal"),
    ).toThrow("Principal is not a member");
  });

  it("accepts one-use invites, enforces role capabilities, and records actions", () => {
    const context = createContext();
    const owner = service.getLocalPrincipal();
    service.ensureOwner(context.id);
    const created = service.createInvite({ contextId: context.id, role: "reviewer" });
    const accepted = service.acceptInvite({
      token: created.token,
      displayName: "Review partner",
      principalId: "partner-1",
    });

    expect(accepted.member).toMatchObject({ role: "reviewer", status: "active" });
    expect(() =>
      service.acceptInvite({
        token: created.token,
        displayName: "Second partner",
        principalId: "partner-2",
      }),
    ).toThrow("already been used");
    expect(() =>
      service.authorizeTaskAction("missing-task", "view", accepted.principal.principalId),
    ).toThrow("Task not found");
    expect(() =>
      service.updateMember(
        {
          contextId: context.id,
          memberId: accepted.member.id,
          revoke: true,
        },
        accepted.principal.principalId,
      ),
    ).toThrow("cannot manage");

    const task = taskRepo.create({
      title: "Shared task",
      prompt: "Shared task",
      status: "pending",
      workspaceId: "workspace-1",
      source: "manual",
    });
    contextService.addMember({ contextId: context.id, taskId: task.id });
    const approvalRepo = new ApprovalRepository(db);
    const approval = approvalRepo.create({
      taskId: task.id,
      type: "run_command",
      description: "Run a command",
      details: {},
      status: "pending",
      requestedAt: Date.now(),
    });
    approvalRepo.update(approval.id, "approved", {
      principalId: accepted.principal.principalId,
      role: accepted.member.role,
    });
    expect(approvalRepo.findById(approval.id)).toMatchObject({
      resolvedByPrincipalId: accepted.principal.principalId,
      resolvedByRole: "reviewer",
    });
    expect(() =>
      service.authorizeTaskAction(task.id, "contribute", accepted.principal.principalId),
    ).toThrow("cannot contribute");
    service.recordTaskAction(
      task.id,
      "review",
      "review_feedback",
      "step-1",
      undefined,
      accepted.principal.principalId,
    );
    expect(service.listAudit(context.id, owner.principalId).map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "owner_created",
        "invite_created",
        "member_joined",
        "review_feedback",
      ]),
    );

    const revoked = service.updateMember({
      contextId: context.id,
      memberId: accepted.member.id,
      revoke: true,
    });
    expect(revoked.status).toBe("revoked");
    expect(() =>
      service.authorizeTaskAction(task.id, "view", accepted.principal.principalId),
    ).toThrow("revoked");
  });

  it("keeps session membership separate from workspace membership", () => {
    const context = createContext();
    expect(() => service.getSnapshot(context.id, "workspace-member")).toThrow(
      "Principal is not a member",
    );
  });

  it("only lists sessions granted to the active principal", () => {
    const shared = createContext();
    const privateContext = contextService.create({
      workspaceId: "workspace-1",
      name: "Private work",
    });
    service.ensureOwner(shared.id);
    const invite = service.createInvite({ contextId: shared.id, role: "viewer" });
    const accepted = service.acceptInvite({
      token: invite.token,
      displayName: "Read-only partner",
      principalId: "viewer-1",
    });

    const visible = service.listAccessibleContexts({}, accepted.principal.principalId);
    expect(visible.map((context) => context.id)).toEqual([shared.id]);
    expect(() => service.getSnapshot(privateContext.id, accepted.principal.principalId)).toThrow(
      "Principal is not a member",
    );
  });
});

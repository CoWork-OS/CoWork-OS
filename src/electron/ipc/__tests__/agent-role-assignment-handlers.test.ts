import type Database from "better-sqlite3";
import type { IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type AgentRole, type Task } from "../../../shared/types";
import { AgentDaemon } from "../../agent/daemon";
import { ActivityRepository } from "../../activity/activity-repository-facades";
import { AgentRoleRepository } from "../../agents/agent-repository-facades";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { TaskRepository } from "../../database/repository-facades";
import { DatabaseManager } from "../../database/schema";
import {
  SessionMembershipService,
  WorkContextService,
} from "../../workspaces/workspaces-repository-facades";
import {
  createAgentRoleAssignmentHandler,
  describeAgentReassignmentAccessLimit,
} from "../agent-role-assignment-handlers";

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

const role = (accessProfileId?: string) =>
  ({ accessProfileId }) as Pick<AgentRole, "accessProfileId">;
const stamped = (accessCeilingProfileId?: string) =>
  ({ agentConfig: accessCeilingProfileId ? { accessCeilingProfileId } : {} }) as Pick<
    Task,
    "agentConfig"
  >;

describe("describeAgentReassignmentAccessLimit", () => {
  it("reports a limit the new agent lifts, adds, changes or keeps", () => {
    expect(
      describeAgentReassignmentAccessLimit(
        stamped("ask_for_approval"),
        role("ask_for_approval"),
        role(),
      ),
    ).toEqual({ previous: "ask_for_approval", change: "lifted" });
    expect(
      describeAgentReassignmentAccessLimit(stamped(), role(), role("ask_for_approval")),
    ).toEqual({
      next: "ask_for_approval",
      change: "added",
    });
    expect(
      describeAgentReassignmentAccessLimit(
        stamped(),
        role("ask_for_approval"),
        role("full_access"),
      ),
    ).toEqual({ previous: "ask_for_approval", next: "full_access", change: "changed" });
    expect(
      describeAgentReassignmentAccessLimit(
        stamped(),
        role(" ask_for_approval "),
        role("ask_for_approval"),
      ),
    ).toEqual({ previous: "ask_for_approval", next: "ask_for_approval", change: "unchanged" });
  });

  it("follows the role, not a stale stamp, while one is assigned", () => {
    // The daemon re-stamps from the role at the next start, so the role's limit is the one in force.
    expect(
      describeAgentReassignmentAccessLimit(
        stamped("full_access"),
        role("ask_for_approval"),
        role(),
      ),
    ).toEqual({ previous: "ask_for_approval", change: "lifted" });
  });

  it("keeps a stamped limit when the session is unassigned", () => {
    expect(
      describeAgentReassignmentAccessLimit(
        stamped("ask_for_approval"),
        role("ask_for_approval"),
        undefined,
      ),
    ).toEqual({ previous: "ask_for_approval", next: "ask_for_approval", change: "unchanged" });
    // Never started under its agent, so nothing is stamped and unassigning drops the limit.
    expect(
      describeAgentReassignmentAccessLimit(stamped(), role("ask_for_approval"), undefined),
    ).toEqual({ previous: "ask_for_approval", change: "lifted" });
  });

  it("matches the limit the daemon stamps at the session's next start", () => {
    const cases: Array<[string | undefined, string | undefined, string | undefined | null]> = [
      // [stamped limit, previous role's limit, next role's limit (null = unassigned)]
      ["ask_for_approval", "ask_for_approval", undefined],
      [undefined, undefined, "ask_for_approval"],
      [undefined, "ask_for_approval", "full_access"],
      ["full_access", "ask_for_approval", undefined],
      ["ask_for_approval", "ask_for_approval", null],
      [undefined, "ask_for_approval", null],
    ];
    for (const [stampedLimit, previousLimit, nextLimit] of cases) {
      const task = { id: "task-1", ...stamped(stampedLimit) } as Task;
      const nextRole =
        nextLimit === null ? undefined : { id: "role-next", accessProfileId: nextLimit };
      const daemonLike = {
        agentRoleRepo: { findById: vi.fn(() => nextRole) },
        taskRepo: { findById: vi.fn(() => task), update: vi.fn() },
      } as Any;
      const applied = (AgentDaemon.prototype as Any).applyAgentRoleOverrides.call(daemonLike, {
        ...task,
        assignedAgentRoleId: nextRole?.id,
      });
      const described = describeAgentReassignmentAccessLimit(
        task,
        role(previousLimit),
        nextRole && role(nextRole.accessProfileId),
      );
      expect(applied.task.agentConfig?.accessCeilingProfileId).toBe(described.next);
    }
  });
});

describeWithSqlite("agentRole:assignToTask", () => {
  const ownerEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
  const partnerEvent = { sender: { id: 2 } } as unknown as IpcMainInvokeEvent;
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let service: SessionMembershipService;
  let contextService: WorkContextService;
  let taskRepo: TaskRepository;
  let roles: AgentRoleStore;
  let send: ReturnType<typeof vi.fn>;
  let assign: ReturnType<typeof createAgentRoleAssignmentHandler>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-agent-assign-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    service = new SessionMembershipService(db);
    contextService = new WorkContextService(db);
    taskRepo = new TaskRepository(db);
    roles = new AgentRoleStore(db);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-1", "Workspace", path.join(tmpDir, "workspace"), Date.now(), "{}");
    send = vi.fn();
    assign = createAgentRoleAssignmentHandler({
      authorizeTask: (event, taskId, capability) =>
        service.authorizeTaskAction(
          taskId,
          capability,
          service.principalForClient(event.sender.id),
        ),
      sessionMembershipService: service,
      taskRepo,
      agentRoleRepo: new AgentRoleRepository(db),
      activityRepo: new ActivityRepository(db),
      getMainWindow: () => ({ webContents: { send } }) as never,
    });
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRole(name: string, accessProfileId?: string): AgentRole {
    const created = roles.create({ name, displayName: name, capabilities: ["code"] });
    return accessProfileId ? roles.update({ id: created.id, accessProfileId })! : created;
  }

  async function createTask(overrides: Partial<Task> = {}): Promise<Task> {
    return await taskRepo.create({
      title: "Ship the release notes",
      prompt: "Ship the release notes",
      status: "pending",
      workspaceId: "workspace-1",
      source: "manual",
      ...overrides,
    });
  }

  /** Shares the task's session with a contributor, who may approve but not manage it. */
  async function addContributor(task: Task): Promise<void> {
    const context = await contextService.create({ workspaceId: "workspace-1", name: "Shared" });
    await contextService.addMember({ contextId: context.id, taskId: task.id });
    await service.ensureOwner(context.id);
    const invite = await service.createInvite({ contextId: context.id, role: "contributor" });
    const accepted = await service.acceptInvite({
      token: invite.token,
      displayName: "Partner",
      principalId: "partner-1",
    });
    service.registerClientPrincipal(partnerEvent.sender.id, accepted.principal.principalId);
  }

  async function audit(taskId: string) {
    const { contextId } = await service.authorizeTaskAction(taskId, "view");
    return await service.listAudit(contextId);
  }

  it("lets the session's owner reassign it and audits the lifted access limit", async () => {
    const limited = createRole("limited-agent", "ask_for_approval");
    const open = createRole("open-agent");
    const task = await createTask({
      assignedAgentRoleId: limited.id,
      agentConfig: { accessCeilingProfileId: "ask_for_approval" },
    });

    await expect(assign(ownerEvent, task.id, open.id)).resolves.toEqual({ success: true });

    expect((await taskRepo.findById(task.id))?.assignedAgentRoleId).toBe(open.id);
    const entry = (await audit(task.id)).find((row) => row.action === "task_agent_assigned");
    expect(entry).toMatchObject({
      principalId: service.getLocalPrincipal().principalId,
      targetId: open.id,
      metadata: {
        previousAgentRoleId: limited.id,
        agentRoleId: open.id,
        accessLimitChange: "lifted",
        previousAccessLimit: "ask_for_approval",
        accessLimit: null,
      },
    });
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.ACTIVITY_EVENT, {
      type: "created",
      activity: expect.objectContaining({
        taskId: task.id,
        agentRoleId: open.id,
        activityType: "agent_assigned",
        title: "Assigned to open-agent",
      }),
    });
  });

  it("refuses a session member who may not manage it, before changing anything", async () => {
    const limited = createRole("limited-agent", "ask_for_approval");
    const open = createRole("open-agent");
    const task = await createTask({ assignedAgentRoleId: limited.id });
    await addContributor(task);

    await expect(assign(partnerEvent, task.id, open.id)).rejects.toThrow(
      "Session role 'contributor' cannot manage this session.",
    );
    await expect(assign(partnerEvent, task.id, null)).rejects.toThrow("cannot manage");

    expect((await taskRepo.findById(task.id))?.assignedAgentRoleId).toBe(limited.id);
    expect((await audit(task.id)).map((row) => row.action)).not.toContain("task_agent_assigned");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a principal outside the session", async () => {
    const limited = createRole("limited-agent", "ask_for_approval");
    const task = await createTask({ assignedAgentRoleId: limited.id });
    service.registerClientPrincipal(partnerEvent.sender.id, "stranger");
    await expect(assign(partnerEvent, task.id, null)).rejects.toThrow(
      "Principal is not a member of this session.",
    );
    expect((await taskRepo.findById(task.id))?.assignedAgentRoleId).toBe(limited.id);
  });

  it("validates both ids before authorizing or touching the session", async () => {
    const authorizeTask = vi.fn();
    const update = vi.fn();
    const strict = createAgentRoleAssignmentHandler({
      authorizeTask,
      sessionMembershipService: { recordTaskAction: vi.fn() },
      taskRepo: { findById: vi.fn(), update },
      agentRoleRepo: { findById: vi.fn() },
      activityRepo: { create: vi.fn() },
      getMainWindow: () => null,
    });
    const taskId = "11111111-1111-4111-8111-111111111111";
    for (const [rawTaskId, rawRoleId] of [
      ["not-a-task", null],
      [undefined, null],
      [{ id: taskId }, null],
      [taskId, "not-a-role"],
      [taskId, undefined],
      [taskId, ""],
      [taskId, 42],
    ] as const) {
      await expect(strict(ownerEvent, rawTaskId, rawRoleId)).rejects.toThrow(/Invalid/);
    }
    expect(authorizeTask).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects an unknown session or agent without changing the assignment", async () => {
    const limited = createRole("limited-agent", "ask_for_approval");
    const task = await createTask({ assignedAgentRoleId: limited.id });

    await expect(
      assign(ownerEvent, "22222222-2222-4222-8222-222222222222", limited.id),
    ).rejects.toThrow("Task not found");
    await expect(
      assign(ownerEvent, task.id, "33333333-3333-4333-8333-333333333333"),
    ).rejects.toThrow("Agent role not found");

    expect((await taskRepo.findById(task.id))?.assignedAgentRoleId).toBe(limited.id);
  });

  it("unassigns a session and audits whether its limit survives", async () => {
    const limited = createRole("limited-agent", "ask_for_approval");
    const started = await createTask({
      assignedAgentRoleId: limited.id,
      agentConfig: { accessCeilingProfileId: "ask_for_approval" },
    });
    const queued = await createTask({ assignedAgentRoleId: limited.id });

    await assign(ownerEvent, started.id, null);
    await assign(ownerEvent, queued.id, null);

    expect((await taskRepo.findById(started.id))?.assignedAgentRoleId).toBeUndefined();
    const metadataOf = async (taskId: string) =>
      (await audit(taskId)).find((row) => row.action === "task_agent_unassigned")?.metadata;
    expect(await metadataOf(started.id)).toMatchObject({
      previousAgentRoleId: limited.id,
      agentRoleId: null,
      accessLimitChange: "unchanged",
      accessLimit: "ask_for_approval",
    });
    expect(await metadataOf(queued.id)).toMatchObject({
      accessLimitChange: "lifted",
      previousAccessLimit: "ask_for_approval",
      accessLimit: null,
    });
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.ACTIVITY_EVENT, {
      type: "created",
      activity: expect.objectContaining({ taskId: started.id, title: "Task unassigned" }),
    });
  });
});

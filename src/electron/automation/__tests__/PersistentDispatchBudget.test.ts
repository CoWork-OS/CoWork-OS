import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { WorkspaceStore } from "../../database/repositories";
import { TaskRepository } from "../../database/repository-facades";
import { PersistentDispatchBudget } from "../PersistentDispatchBudget";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";

describe("durable background dispatch reservations", () => {
  let directory: string;
  let manager: DatabaseManager;
  let workspaceId: string;
  let now: number;
  let previousUserDataDir: string | undefined;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-dispatch-budget-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = directory;
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    workspaceId = new WorkspaceStore(manager.getDatabase()).create("Work", directory, {
      read: true,
      write: true,
      delete: false,
      shell: false,
      network: false,
    }).id;
    now = new Date("2026-10-06T09:00:00").getTime();
  });
  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const budget = () =>
    new PersistentDispatchBudget(manager.getDatabase(), {
      maxPerWorkspacePerDay: 1,
      now: () => now,
    });
  it("retains reservations, daily limits and entity cooldowns across reopen", async () => {
    const before = budget();
    await before.tryConsume({ workspaceId, source: "heartbeat", entityKey: "Loop:1" });
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    expect(
      await budget().tryConsume({ workspaceId, source: "workflow_intelligence" }),
    ).toMatchObject({
      allowed: false,
      reason: "workspace_budget_exhausted",
    });
    const cooldown = new PersistentDispatchBudget(manager.getDatabase(), {
      maxPerWorkspacePerDay: 10,
      now: () => now,
    });
    expect(
      await cooldown.tryConsume({ workspaceId, source: "strategic_planner", entityKey: "loop:1" }),
    ).toMatchObject({ allowed: false, reason: "entity_cooldown" });
    now += 24 * 60 * 60 * 1000;
    expect(
      (await budget().tryConsume({ workspaceId, source: "workflow_intelligence" })).allowed,
    ).toBe(true);
  });
  it("atomically allows one remaining ticket across independent database connections", async () => {
    const peer = new Database(path.join(directory, "test.db"));
    try {
      const other = new PersistentDispatchBudget(peer, {
        maxPerWorkspacePerDay: 1,
        now: () => now,
      });
      const results = await Promise.all([
        budget().tryConsume({ workspaceId, source: "heartbeat" }),
        other.tryConsume({ workspaceId, source: "workflow_intelligence" }),
      ]);
      expect(results.filter((r) => r.allowed)).toHaveLength(1);
      expect((await other.snapshot(workspaceId)).dispatchesToday).toBe(1);
    } finally {
      peer.close();
    }
  });
  it("deduplicates an occurrence across producers even for manual replay", async () => {
    const first = await budget().tryConsume({
      workspaceId,
      source: "heartbeat",
      occurrenceKey: "responsibility:1:rev:2:event:3",
    });
    expect(first).toMatchObject({ allowed: true, durable: true });
    expect(
      await budget().tryConsume({
        workspaceId,
        source: "workflow_intelligence",
        occurrenceKey: "responsibility:1:rev:2:event:3",
        manual: true,
      }),
    ).toMatchObject({ allowed: false, reason: "duplicate_occurrence" });
  });
  it("records manual runs beyond the automatic budget and refunds failed reservations once", async () => {
    const persistent = budget();
    const grant = await persistent.tryConsume({ workspaceId, source: "heartbeat" });
    await persistent.refund(grant.ticket);
    await persistent.refund(grant.ticket);
    expect((await persistent.snapshot(workspaceId)).dispatchesToday).toBe(0);
    await persistent.tryConsume({ workspaceId, source: "heartbeat" });
    expect(
      (await persistent.tryConsume({ workspaceId, source: "heartbeat", manual: true })).allowed,
    ).toBe(true);
    expect((await persistent.snapshot(workspaceId)).dispatchesToday).toBe(2);
  });
  it("commits a reservation with the task row and refuses refunds after task creation", async () => {
    const persistent = budget();
    const grant = await persistent.tryConsume({ workspaceId, source: "heartbeat" });
    const task = await new TaskRepository(manager.getDatabase()).create({
      title: "Dispatch",
      prompt: "Work",
      workspaceId,
      status: "pending",
      agentConfig: { backgroundDispatchTicket: grant.ticket },
    });
    const row = manager
      .getDatabase()
      .prepare("SELECT state,task_id FROM background_dispatch_reservations WHERE ticket = ?")
      .get(grant.ticket);
    expect(row).toEqual({ state: "committed", task_id: task.id });
    await persistent.refund(grant.ticket);
    expect((await persistent.snapshot(workspaceId)).dispatchesToday).toBe(1);
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    expect(
      (await new TaskRepository(manager.getDatabase()).findById(task.id))?.agentConfig
        ?.backgroundDispatchTicket,
    ).toBeUndefined();
    expect(
      manager
        .getDatabase()
        .prepare("SELECT task_id FROM background_dispatch_reservations WHERE ticket = ?")
        .get(grant.ticket),
    ).toEqual({ task_id: task.id });
  });
  it("rolls back task creation when a ticket is reused or comes from another workspace", async () => {
    const tasks = new TaskRepository(manager.getDatabase());
    const grant = await budget().tryConsume({ workspaceId, source: "heartbeat" });
    const other = new WorkspaceStore(manager.getDatabase()).create(
      "Other",
      path.join(directory, "other"),
      { read: true, write: true, delete: false, shell: false, network: false },
    ).id;
    await expect(
      tasks.create({
        title: "Wrong scope",
        prompt: "Work",
        workspaceId: other,
        status: "pending",
        agentConfig: { backgroundDispatchTicket: grant.ticket },
      }),
    ).rejects.toThrow("another workspace");
    expect(manager.getDatabase().prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
    await tasks.create({
      title: "First",
      prompt: "Work",
      workspaceId,
      status: "pending",
      agentConfig: { backgroundDispatchTicket: grant.ticket },
    });
    await expect(
      tasks.create({
        title: "Duplicate",
        prompt: "Work",
        workspaceId,
        status: "pending",
        agentConfig: { backgroundDispatchTicket: grant.ticket },
      }),
    ).rejects.toThrow();
    expect(manager.getDatabase().prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 1 });
  });
  it("adds the ledger to an older profile without changing custom bots or pending work", async () => {
    const roles = new AgentRoleStore(manager.getDatabase());
    const role = roles.create({
      name: "personal-custom-bot",
      displayName: "Renamed helper",
      systemPrompt: "My own instructions",
      capabilities: [],
    });
    roles.update(role.id, { isActive: false });
    const tasks = new TaskRepository(manager.getDatabase());
    const task = await tasks.create({
      title: "Pending approval",
      prompt: "My task",
      workspaceId,
      status: "blocked",
      assignedAgentRoleId: role.id,
    });
    const before = manager
      .getDatabase()
      .prepare("SELECT * FROM agent_roles WHERE id = ?")
      .get(role.id);
    manager.getDatabase().exec("DROP TABLE background_dispatch_reservations");
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    expect(
      manager.getDatabase().prepare("SELECT * FROM agent_roles WHERE id = ?").get(role.id),
    ).toEqual(before);
    expect((await new TaskRepository(manager.getDatabase()).findById(task.id))?.status).toBe(
      "blocked",
    );
    expect((await budget().tryConsume({ workspaceId, source: "heartbeat" })).allowed).toBe(true);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../AgentRoleRepository";
import { WorkSessionProtocolRepository } from "../../database/WorkSessionProtocolRepository";
import { OrchestrationGraphStore } from "../../agent/orchestration/OrchestrationGraphRepository";
import { BotWorkQueryService } from "../BotWorkQueryService";
import type { BotWorkQuery, Task } from "../../../shared/types";
import type { CronJob } from "../../cron/types";

describe("workspace-scoped bot work query", () => {
  let directory: string;
  let manager: DatabaseManager;
  let tasks: TaskStore;
  let workspaceId: string;
  let foreignWorkspaceId: string;
  let botId: string;
  let otherBotId: string;
  let service: BotWorkQueryService;
  let jobs: CronJob[];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bot-work-"));
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    const db = manager.getDatabase();
    tasks = new TaskStore(db);
    const workspaces = new WorkspaceStore(db);
    const permissions = { read: true, write: false, delete: false, network: false, shell: false };
    workspaceId = workspaces.create("Current", directory, permissions).id;
    foreignWorkspaceId = workspaces.create("Other", path.join(directory, "other"), permissions).id;
    const roles = new AgentRoleStore(db);
    botId = roles.create({
      name: randomUUID(),
      displayName: "My renamed bot",
      capabilities: [],
    }).id;
    otherBotId = roles.create({
      name: randomUUID(),
      displayName: "Another bot",
      capabilities: [],
    }).id;
    jobs = [];
    service = new BotWorkQueryService(db, async () => ({ jobs, state: "running" }));
  });
  afterEach(() => {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const query = (view: BotWorkQuery["view"] = "working"): BotWorkQuery => ({
    workspaceId,
    agentRoleId: botId,
    view,
  });
  function create(overrides: Partial<Task> = {}) {
    return tasks.create({
      title: "Assigned work",
      prompt: "PRIVATE PROMPT",
      workspaceId,
      status: "executing",
      assignedAgentRoleId: botId,
      ...overrides,
    });
  }
  function wait(task: Task, kind: string, expiresAt?: number) {
    const session = new WorkSessionProtocolRepository(manager.getDatabase()).ensureForTask({
      taskId: task.id,
      workspaceId,
      status: "active",
    });
    manager
      .getDatabase()
      .prepare(`INSERT INTO work_session_wait_states
      (id, session_id, task_id, kind, reason, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(
        randomUUID(),
        session.session.id,
        task.id,
        kind,
        `Waiting for ${kind}`,
        Date.now(),
        Date.now(),
        expiresAt ?? null,
      );
  }

  it("shows ordinary assignment without a conversation and deduplicates delegated descendants", async () => {
    const parent = create();
    const child = create({ parentTaskId: parent.id });
    const delegated = create({ parentTaskId: child.id, assignedAgentRoleId: otherBotId });
    create({ assignedAgentRoleId: otherBotId });
    const foreign = create({ workspaceId: foreignWorkspaceId, parentTaskId: parent.id });
    create({ parentTaskId: foreign.id, assignedAgentRoleId: otherBotId });
    const page = await service.list(query());
    expect(new Set(page.items.map((item) => item.taskId))).toEqual(
      new Set([parent.id, child.id, delegated.id]),
    );
    expect(page.items.find((item) => item.taskId === delegated.id)?.ownership).toBe("delegated");
    expect(page.counts.working).toBe(3);
    expect(JSON.stringify(page)).not.toContain("PRIVATE PROMPT");
  });

  it("includes local graph-linked work once and preserves workspace boundaries", async () => {
    const parent = create(),
      linked = create({ assignedAgentRoleId: otherBotId }),
      foreign = create({ workspaceId: foreignWorkspaceId, assignedAgentRoleId: otherBotId });
    new OrchestrationGraphStore(manager.getDatabase()).createRun({
      run: {
        id: randomUUID(),
        rootTaskId: parent.id,
        workspaceId,
        kind: "delegation",
        status: "running",
        maxParallel: 1,
      },
      nodes: [
        {
          id: randomUUID(),
          key: "local",
          title: "Local",
          prompt: "Private",
          kind: "child_task",
          status: "running",
          dispatchTarget: "local_role",
          taskId: linked.id,
        },
        {
          id: randomUUID(),
          key: "foreign",
          title: "Foreign",
          prompt: "Private",
          kind: "child_task",
          status: "running",
          dispatchTarget: "local_role",
          taskId: foreign.id,
        },
      ],
    });
    expect(new Set((await service.list(query())).items.map((item) => item.taskId))).toEqual(
      new Set([parent.id, linked.id]),
    );
  });
  it("terminates parent cycles and excludes archived tasks and their descendants", async () => {
    const a = create();
    const b = create({ parentTaskId: a.id, assignedAgentRoleId: otherBotId });
    tasks.update(a.id, { parentTaskId: b.id });
    const archived = create();
    create({ parentTaskId: archived.id, assignedAgentRoleId: otherBotId });
    manager
      .getDatabase()
      .prepare(
        "INSERT INTO task_session_metadata (session_id, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(archived.id, 1, 1, 1);
    expect((await service.list(query())).items.map((item) => item.taskId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });

  it("puts human decisions in Needs you and dependency waits in Working", async () => {
    const approval = create();
    wait(approval, "approval");
    const input = create();
    wait(input, "input");
    const child = create({ status: "blocked" });
    wait(child, "child");
    const external = create({ status: "paused" });
    wait(external, "external");
    const expired = create();
    wait(expired, "input", 1);
    expect(
      (await service.list(query("needs_you"))).items.map((item) => item.taskId).sort(),
    ).toEqual([approval.id, input.id].sort());
    expect((await service.list(query())).items.map((item) => item.taskId).sort()).toEqual(
      [child.id, external.id, expired.id].sort(),
    );
  });

  it("falls back to persisted requests without a WorkSession and never shares a session wait with another task", async () => {
    const approval = create();
    const input = create();
    const ordinary = create({ sessionId: "shared-lineage" });
    manager
      .getDatabase()
      .prepare(
        "INSERT INTO approvals (id, task_id, type, description, details, status, requested_at) VALUES (?, ?, 'network', 'Allow?', '{}', 'pending', 1)",
      )
      .run(randomUUID(), approval.id);
    manager
      .getDatabase()
      .prepare(
        "INSERT INTO input_requests (id, task_id, questions, status, requested_at) VALUES (?, ?, '[]', 'pending', 1)",
      )
      .run(randomUUID(), input.id);
    expect((await service.list(query("needs_you"))).items).toHaveLength(2);
    expect((await service.list(query())).items[0].taskId).toBe(ordinary.id);
  });

  it("does not import a wait from a foreign or superseded canonical session", async () => {
    const task = create();
    wait(task, "input");
    const db = manager.getDatabase();
    db.prepare("UPDATE work_sessions SET workspace_id = ? WHERE task_id = ?").run(
      foreignWorkspaceId,
      task.id,
    );
    expect((await service.list(query("needs_you"))).items).toHaveLength(0);
    db.prepare("UPDATE work_sessions SET workspace_id = ? WHERE task_id = ?").run(
      workspaceId,
      task.id,
    );
    const replacement = new WorkSessionProtocolRepository(db).createAggregate({ workspaceId });
    db.prepare("UPDATE work_session_task_bindings SET session_id = ? WHERE task_id = ?").run(
      replacement.session.id,
      task.id,
    );
    expect((await service.list(query("needs_you"))).items).toHaveLength(0);
  });

  it("keeps completion, verification and delivery distinct and omits idle conversations", async () => {
    const unverified = create({ status: "completed", resultSummary: "Report ready" });
    const verified = create({ status: "completed", verificationVerdict: "PASS" });
    create({ status: "completed", agentConfig: { botConversation: true } });
    const failed = create({ status: "failed" });
    wait(failed, "input");
    const page = await service.list(query("results"));
    expect(page.items).toHaveLength(3);
    expect(page.items.find((item) => item.taskId === unverified.id)?.verification).toBe(
      "unverified",
    );
    expect(page.items.find((item) => item.taskId === verified.id)?.verification).toBe("passed");
    expect(page.items.every((item) => item.delivery === "unknown")).toBe(true);
    expect((await service.list(query("needs_you"))).items).toHaveLength(0);
  });

  it("preserves the conversation lifecycle's legacy teammate-reply wait", async () => {
    const task = create({ status: "paused", agentConfig: { botConversation: true } });
    tasks.update(task.id, {
      error: "Waiting for My colleague to reply before finishing this conversation.",
    });
    expect((await service.list(query("needs_you"))).items).toHaveLength(0);
    expect((await service.list(query())).items).toMatchObject([
      { taskId: task.id, waitingKind: "child" },
    ]);
  });

  it("honors canonical lifecycle markers even when a stale writer left another raw status", async () => {
    const verified = create({ status: "completed" });
    const finished = create();
    const approval = create({ status: "queued" });
    const attachment = create({ status: "blocked" });
    const db = manager.getDatabase();
    db.prepare("UPDATE tasks SET terminal_status = 'awaiting_verification' WHERE id = ?").run(
      verified.id,
    );
    db.prepare("UPDATE tasks SET terminal_status = 'ok' WHERE id = ?").run(finished.id);
    db.prepare("UPDATE tasks SET terminal_status = 'awaiting_approval' WHERE id = ?").run(
      approval.id,
    );
    db.prepare(
      "UPDATE tasks SET awaiting_user_input_reason_code = 'queued_attachment_unavailable' WHERE id = ?",
    ).run(attachment.id);
    expect((await service.list(query())).items).toMatchObject([
      { taskId: verified.id, status: "blocked" },
    ]);
    expect((await service.list(query("results"))).items).toMatchObject([
      { taskId: finished.id, status: "completed" },
    ]);
    expect(
      (await service.list(query("needs_you"))).items.map((item) => item.taskId).sort(),
    ).toEqual([approval.id, attachment.id].sort());
  });

  it("uses stable keyset pagination across tied timestamps and scopes its cursor", async () => {
    for (let i = 0; i < 7; i++) {
      const task = create();
      manager.getDatabase().prepare("UPDATE tasks SET updated_at = 42 WHERE id = ?").run(task.id);
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list({ ...query(), limit: 2, cursor });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    const first = await service.list({ ...query(), limit: 1 });
    await expect(
      service.list({ ...query(), workspaceId: foreignWorkspaceId, cursor: first.nextCursor }),
    ).rejects.toThrow("another query");
    await expect(service.list({ ...query("results"), cursor: first.nextCursor })).rejects.toThrow(
      "another query",
    );
  });

  it("merges enabled scoped cron schedules with queued work and paginates both", async () => {
    const task = create({ status: "queued" });
    const job: CronJob = {
      id: randomUUID(),
      name: "Weekly report",
      enabled: true,
      workspaceId,
      assignedAgentRoleId: botId,
      taskPrompt: "PRIVATE CRON PROMPT",
      createdAtMs: 1,
      updatedAtMs: task.updatedAt,
      schedule: { kind: "every", everyMs: 1000 },
      state: { nextRunAtMs: 9000 },
    };
    jobs.push(
      job,
      { ...job, id: randomUUID(), workspaceId: foreignWorkspaceId },
      { ...job, id: randomUUID(), assignedAgentRoleId: otherBotId },
      { ...job, id: randomUUID(), enabled: false },
    );
    const first = await service.list({ ...query("scheduled"), limit: 1 });
    const second = await service.list({
      ...query("scheduled"),
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(first.counts.scheduled).toBe(2);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(2);
    expect([...first.items, ...second.items].find((item) => item.scheduleId)?.nextWakeAt).toBe(
      9000,
    );
    expect(JSON.stringify([first, second])).not.toContain("PRIVATE CRON PROMPT");
    expect(second.nextCursor).toBeUndefined();
  });

  it("lists schedules owned by the bot's responsibility routines", async () => {
    const db = manager.getDatabase();
    db.exec(`CREATE TABLE IF NOT EXISTS automation_routines (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      workspace_id TEXT NOT NULL, prompt TEXT NOT NULL, connectors_json TEXT NOT NULL,
      triggers_json TEXT NOT NULL, definition_json TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL)`);
    const routine = (id: string, jobId: string, ws = workspaceId) =>
      db
        .prepare(
          "INSERT INTO automation_routines VALUES (?, 'Routine', NULL, 1, ?, 'p', '[]', '[]', ?, 1, 1)",
        )
        .run(
          id,
          ws,
          JSON.stringify({ triggers: [{ id: "s", type: "schedule", managedCronJobId: jobId }] }),
        );
    const bind = (id: string, routineId: string, agentRoleId: string, ws = workspaceId) =>
      db
        .prepare(
          "INSERT INTO bot_responsibilities (id, workspace_id, agent_role_id, engine_kind, engine_id, revision, state, created_at, updated_at) VALUES (?, ?, ?, 'routine', ?, 1, 'active', 1, 1)",
        )
        .run(id, ws, agentRoleId, routineId);
    routine("mine", "job-mine");
    bind("r-mine", "mine", botId);
    routine("theirs", "job-theirs");
    bind("r-theirs", "theirs", otherBotId);
    const job = (id: string): CronJob => ({
      id,
      name: `Routine: ${id}`,
      enabled: true,
      workspaceId,
      taskPrompt: "PRIVATE ROUTINE PROMPT",
      createdAtMs: 1,
      updatedAtMs: 5,
      schedule: { kind: "cron", expr: "0 8 * * 1-5" },
      state: { nextRunAtMs: 7000 },
    });
    jobs.push(job("job-mine"), job("job-theirs"), { ...job("job-mine"), id: "job-unbound" });
    const page = await service.list(query("scheduled"));
    expect(page.items.map((item) => item.scheduleId)).toEqual(["job-mine"]);
    expect(page.items[0].nextWakeAt).toBe(7000);
    expect(page.counts.scheduled).toBe(1);
    expect(JSON.stringify(page)).not.toContain("PRIVATE ROUTINE PROMPT");
    expect(page.items[0].schedulePaused).toBeUndefined();
    db.prepare(
      "INSERT INTO bot_responsibility_future_controls (responsibility_id, paused, version) VALUES ('r-mine', 1, 1)",
    ).run();
    expect((await service.list(query("scheduled"))).items[0].schedulePaused).toBe("responsibility");
    db.prepare(
      "INSERT INTO bot_future_controls (workspace_id, agent_role_id, paused, version) VALUES (?, ?, 1, 1)",
    ).run(workspaceId, botId);
    expect((await service.list(query("scheduled"))).items[0].schedulePaused).toBe("bot");
  });

  it("rejects invalid scope/cursors/limits and reports an unavailable scheduler truthfully", async () => {
    for (const value of [0, 101, 1.5, Infinity, NaN])
      await expect(service.list({ ...query(), limit: value })).rejects.toThrow();
    await expect(service.list({ ...query(), workspaceId: "missing" })).rejects.toThrow(
      "Workspace not found",
    );
    await expect(service.list({ ...query(), agentRoleId: "missing" })).rejects.toThrow(
      "Bot not found",
    );
    await expect(service.list({ ...query(), cursor: "garbage" })).rejects.toThrow(
      "Invalid bot work cursor",
    );
    expect(
      (await new BotWorkQueryService(manager.getDatabase(), async () => null).list(query()))
        .scheduleAvailability,
    ).toBe("unavailable");
  });

  it("keeps assigned work readable when the scheduler fails", async () => {
    const task = create();
    const offline = new BotWorkQueryService(manager.getDatabase(), async () => {
      throw new Error("scheduler offline");
    });
    expect(await offline.list(query())).toMatchObject({
      items: [{ taskId: task.id }],
      scheduleAvailability: "unavailable",
      scheduleRuntime: "unavailable",
    });
  });

  it("is read-only, bounded and retains work after bot rename or deactivation", async () => {
    create({ title: "x".repeat(1000), resultSummary: "y".repeat(5000) });
    const db = manager.getDatabase();
    db.prepare("UPDATE agent_roles SET display_name = 'New name', is_active = 0 WHERE id = ?").run(
      botId,
    );
    const before = db.prepare("SELECT total_changes() changes").get();
    const page = await service.list(query());
    expect(db.prepare("SELECT total_changes() changes").get()).toEqual(before);
    expect(page.items[0].title.length).toBe(240);
    expect(page.items[0].resultSummary?.length).toBe(512);
    expect(db.prepare("SELECT COUNT(*) n FROM work_sessions").get()).toEqual({ n: 0 });
  });
});

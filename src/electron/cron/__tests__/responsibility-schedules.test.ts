import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { RoutineService } from "../../routines/service";
import { CronService } from "../service";
import { BotResponsibilityService } from "../../automation/BotResponsibilityService";
import { BotResponsibilityRepository } from "../../automation/BotResponsibilityRepository";
import { prepareResponsibilitySchedule } from "../../automation/responsibility-signals";
import { SchedulerLeaseStore } from "../../automation/scheduler-lease-store";
import type { BotResponsibilityScope } from "../../../shared/bot-responsibility";

describe("signal-aware scheduled responsibilities", () => {
  let dir: string, manager: DatabaseManager, cron: CronService, routines: RoutineService;
  let service: BotResponsibilityService, scope: BotResponsibilityScope, jobId: string;
  let createTask: ReturnType<typeof vi.fn>;
  async function services() {
    const db = manager.getDatabase();
    createTask = vi.fn(async (input) => ({
      id: new TaskStore(db).create({
        title: input.title,
        prompt: input.prompt,
        workspaceId: input.workspaceId,
        agentConfig: input.agentConfig,
        status: "completed",
      }).id,
    }));
    cron = new CronService({
      storePath: path.join(dir, "cron.json"),
      cronEnabled: true,
      createTask,
      beforeExecuteJob: async (job) => {
        await new BotResponsibilityRepository(db).assertCronJobMayExecute(job.id);
        return prepareResponsibilitySchedule(db, job);
      },
      getTaskStatus: async (id) => new TaskStore(db).findById(id) ?? null,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await cron.start();
    routines = new RoutineService({
      db,
      getCronService: () => cron,
      getEventTriggerService: () => null,
      loadHooksSettings: () => ({
        enabled: false,
        token: "fixture",
        path: "/hooks",
        maxBodyBytes: 1024,
        presets: [],
        mappings: [],
      }),
      saveHooksSettings: vi.fn(),
      createTask: async (input) => new TaskStore(db).create({ ...input, status: "queued" }),
    });
    const fence = new SchedulerLeaseStore(db).acquire({
      owner: "fixture",
      now: Date.now(),
      leaseMs: 300000,
    })!;
    service = new BotResponsibilityService(db, {
      runtime: () => "node",
      getRoutineService: () => routines,
      assertOwnership: async () => {},
      getSchedulerFence: () => fence,
    });
  }
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-responsibility-schedule-"));
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("Fixture", dir, {
      read: true,
      write: true,
      delete: false,
      shell: false,
      network: false,
    });
    const bot = new AgentRoleStore(db).create({
      name: "my-private-bot",
      displayName: "Private",
      description: "Fixture",
      systemPrompt: "Keep my private instructions",
      capabilities: [],
    });
    scope = { workspaceId: workspace.id, agentRoleId: bot.id };
    await services();
    const engine = await routines.create({
      name: "Scheduled evidence",
      enabled: false,
      workspaceId: scope.workspaceId,
      prompt: "Inspect",
      connectors: [],
      triggers: [
        {
          id: "schedule",
          type: "schedule",
          enabled: true,
          schedule: { kind: "every", everyMs: 60000 },
        },
      ],
    });
    const saved = await service.create({
      scope,
      definition: {
        objective: "Inspect selected evidence",
        engine: { kind: "routine", id: engine.id },
        mode: "observe",
        sources: [
          { connectorId: "workspace_files", method: "read_file", resourceId: "evidence.md" },
        ],
        permittedActions: [],
        expectedOutput: "Internal report",
        reviewBoundary: "all_effects",
        destination: { channel: "internal", id: "results" },
        backend: "node",
        budget: { maxTokens: 1000, maxCost: 0 },
      },
    });
    expect(
      (await service.preview({ scope, definition: saved.definition })).activationAvailable,
    ).toBe(true);
    await service.activate({
      scope,
      id: saved.id,
      expectedRevision: saved.revision,
      expectedControlVersion: saved.controlVersion,
    });
    jobId = (await cron.list())[0].id;
  });
  afterEach(async () => {
    await routines.stopWorkflowRuntime();
    await cron.stop();
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const taskCount = () =>
    manager.getDatabase().prepare("SELECT COUNT(*) AS count FROM tasks").get();
  it("skips an empty source and unchanged checks without creating work, including after restart", async () => {
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: true,
      ran: false,
      reason: "no-signal",
    });
    expect(createTask).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(dir, "evidence.md"), "Evidence A");
    expect(await cron.run(jobId, "force")).toMatchObject({ ok: true, ran: true });
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: true,
      ran: false,
      reason: "no-signal",
    });
    expect(taskCount()).toEqual({ count: 1 });
    expect((await cron.get(jobId))?.state.lastStatus).toBe("skipped");
    expect((await cron.get(jobId))?.state.lastError).toBeUndefined();
    await routines.stopWorkflowRuntime();
    await cron.stop();
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    await services();
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: true,
      ran: false,
      reason: "no-signal",
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(taskCount()).toEqual({ count: 1 });
  });
  it("admits each changed source version, including a reversion, without retaining a reusable proposal", async () => {
    for (const value of ["A", "B", "A"]) {
      fs.writeFileSync(path.join(dir, "evidence.md"), value);
      expect(await cron.run(jobId, "force")).toMatchObject({ ok: true, ran: true });
      expect(await cron.run(jobId, "force")).toMatchObject({
        ok: true,
        ran: false,
        reason: "no-signal",
      });
    }
    expect(taskCount()).toEqual({ count: 3 });
    expect(
      manager.getDatabase().prepare("SELECT sequence FROM bot_responsibility_signal_heads").get(),
    ).toEqual({ sequence: 3 });
    const rows = new TaskStore(manager.getDatabase()).findByStatus("completed");
    expect(rows.every((task) => task.agentConfig?.responsibilitySignal === undefined)).toBe(true);
    expect(
      rows.every((task) => task.agentConfig?.responsibilityRun?.agentRoleId === scope.agentRoleId),
    ).toBe(true);
  });
  it("does not consume a source change when task admission rolls back", async () => {
    fs.writeFileSync(path.join(dir, "evidence.md"), "A");
    manager
      .getDatabase()
      .exec(
        "CREATE TRIGGER reject_signal BEFORE INSERT ON bot_responsibility_signal_runs BEGIN SELECT RAISE(ABORT,'signal write unavailable'); END;",
      );
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: false,
      error: "signal write unavailable",
    });
    expect(taskCount()).toEqual({ count: 0 });
    expect(
      manager
        .getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM bot_responsibility_signal_heads")
        .get(),
    ).toEqual({ count: 0 });
    manager.getDatabase().exec("DROP TRIGGER reject_signal");
    expect(await cron.run(jobId, "force")).toMatchObject({ ok: true, ran: true });
    expect(taskCount()).toEqual({ count: 1 });
  });
  it("rechecks changed schedule context and blocks delivery outside the responsibility", async () => {
    fs.writeFileSync(path.join(dir, "evidence.md"), "A");
    await cron.update(jobId, {
      chatContext: { channelType: "slack", channelId: "unselected-chat" },
    });
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: false,
      error: "Scheduled chat context is outside the selected sources",
    });
    expect(createTask).not.toHaveBeenCalled();
    await expect(
      new BotResponsibilityRepository(manager.getDatabase()).assertCronJobMayDeliver(jobId),
    ).rejects.toThrow("delivery approval binding");
    expect(taskCount()).toEqual({ count: 0 });
  });
  it("rolls back competing sample proposals and rejects an older different snapshot", async () => {
    fs.writeFileSync(path.join(dir, "evidence.md"), "A");
    const db = manager.getDatabase();
    const job = (await cron.get(jobId))!;
    const proposalA = await prepareResponsibilitySchedule(db, job);
    fs.writeFileSync(path.join(dir, "evidence.md"), "B");
    const proposalB = await prepareResponsibilitySchedule(db, job);
    const tasks = new TaskStore(db);
    const input = {
      title: "Snapshot",
      prompt: "Fixture",
      workspaceId: scope.workspaceId,
      status: "pending" as const,
    };
    tasks.create({ ...input, agentConfig: proposalB!.agentConfig });
    expect(() => tasks.create({ ...input, agentConfig: proposalB!.agentConfig })).toThrow(
      "already admitted",
    );
    expect(() => tasks.create({ ...input, agentConfig: proposalA!.agentConfig })).toThrow(
      "version changed",
    );
    expect(taskCount()).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_signal_runs").get(),
    ).toEqual({ count: 1 });
  });
  it("samples only selected cached history and observes edits and removals without duplicate runs", async () => {
    const db = manager.getDatabase();
    db.prepare(
      "INSERT INTO channels(id,type,name,enabled,config,security_config,created_at,updated_at) VALUES('history','slack','Fixture',1,'{}','{}',0,0)",
    ).run();
    const current = (await service.list(scope))[0];
    await service.pause({
      scope,
      id: current.id,
      expectedRevision: current.revision,
      expectedControlVersion: current.controlVersion,
    });
    const revised = await service.revise({
      scope,
      id: current.id,
      expectedRevision: current.revision,
      definition: {
        ...current.definition,
        sources: [
          { connectorId: "gateway:slack", method: "channel_history", resourceId: "selected-chat" },
        ],
      },
    });
    await service.activate({
      scope,
      id: revised.id,
      expectedRevision: revised.revision,
      expectedControlVersion: revised.controlVersion,
    });
    expect((await cron.get(jobId))?.taskAgentConfig?.allowedTools).toEqual(["channel_history"]);
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: true,
      ran: false,
      reason: "no-signal",
    });
    db.prepare(
      "INSERT INTO channel_messages(id,channel_id,channel_message_id,chat_id,direction,content,timestamp) VALUES('m1','history','message','selected-chat','incoming','A',1),('foreign','history','other','unselected-chat','incoming','Private foreign source',1)",
    ).run();
    expect(await cron.run(jobId, "force")).toMatchObject({ ok: true, ran: true });
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: true,
      ran: false,
      reason: "no-signal",
    });
    db.prepare(
      "UPDATE channel_messages SET content='Changed unrelated chat' WHERE id='foreign'",
    ).run();
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: true,
      ran: false,
      reason: "no-signal",
    });
    db.prepare("UPDATE channel_messages SET content='B' WHERE id='m1'").run();
    expect(await cron.run(jobId, "force")).toMatchObject({ ok: true, ran: true });
    db.prepare("DELETE FROM channel_messages WHERE id='m1'").run();
    expect(await cron.run(jobId, "force")).toMatchObject({ ok: true, ran: true });
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: true,
      ran: false,
      reason: "no-signal",
    });
    expect(taskCount()).toEqual({ count: 3 });
  });
  it("fails closed before sampling when a schedule's named profile is unavailable", async () => {
    fs.writeFileSync(path.join(dir, "evidence.md"), "A");
    await cron.update(jobId, { accessProfileId: "missing-private-profile" });
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: false,
      error: "The selected access profile is unavailable.",
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(taskCount()).toEqual({ count: 0 });
    expect(
      manager
        .getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM bot_responsibility_signal_heads")
        .get(),
    ).toEqual({ count: 0 });
  });
  it("uses the current default profile when preparing new scheduled work", async () => {
    const job = (await cron.get(jobId))!;
    await expect(
      prepareResponsibilitySchedule(manager.getDatabase(), job, {
        settings: {
          version: 1,
          defaultMode: "dangerous_only",
          defaultShellEnabled: false,
          defaultPermissionAccess: "default",
          defaultAccessProfileId: "missing-current-default",
          accessProfiles: [],
          rules: [],
        },
      }),
    ).rejects.toThrow("selected access profile is unavailable");
    expect(createTask).not.toHaveBeenCalled();
    expect(taskCount()).toEqual({ count: 0 });
  });
  it("future pause skips due work and resume does not replay a consumed source", async () => {
    fs.writeFileSync(path.join(dir, "evidence.md"), "A");
    expect(await cron.run(jobId, "force")).toMatchObject({ ok: true, ran: true });
    const current = (await service.list(scope))[0];
    const request = {
      scope,
      id: current.id,
      expectedRevision: current.revision,
      expectedControlVersion: current.controlVersion,
    };
    await service.setFutureRuns({
      ...request,
      requestId: "future-pause",
      expectedFutureControlVersion: 0,
      paused: true,
    });
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: true,
      ran: false,
      reason: "future-paused",
    });
    expect((await cron.get(jobId))?.state.lastError).toBeUndefined();
    await service.setFutureRuns({
      ...request,
      requestId: "future-resume",
      expectedFutureControlVersion: 1,
      paused: false,
    });
    expect(await cron.run(jobId, "force")).toMatchObject({
      ok: true,
      ran: false,
      reason: "no-signal",
    });
    expect(taskCount()).toEqual({ count: 1 });
  });
  it("rolls back actual task admission when a sampled channel instance is replaced", async () => {
    const db = manager.getDatabase();
    db.prepare(
      "INSERT INTO channels(id,type,name,enabled,config,security_config,created_at,updated_at) VALUES('history-a','slack','Fixture A',1,'{}','{}',0,0)",
    ).run();
    const current = (await service.list(scope))[0];
    await service.pause({
      scope,
      id: current.id,
      expectedRevision: current.revision,
      expectedControlVersion: current.controlVersion,
    });
    const revised = await service.revise({
      scope,
      id: current.id,
      expectedRevision: current.revision,
      definition: {
        ...current.definition,
        sources: [
          { connectorId: "gateway:slack", method: "channel_history", resourceId: "selected-chat" },
        ],
      },
    });
    await service.activate({
      scope,
      id: revised.id,
      expectedRevision: revised.revision,
      expectedControlVersion: revised.controlVersion,
    });
    db.prepare(
      "INSERT INTO channel_messages(id,channel_id,channel_message_id,chat_id,direction,content,timestamp) VALUES('m1','history-a','remote-m1','selected-chat','incoming','Same cached source',1)",
    ).run();
    const proposal = await prepareResponsibilitySchedule(db, (await cron.get(jobId))!);
    expect(proposal?.agentConfig?.responsibilitySignal?.channelInstances).toEqual([
      { channelType: "slack", channelId: "history-a" },
    ]);

    db.prepare("DELETE FROM channel_messages WHERE channel_id='history-a'").run();
    db.prepare("DELETE FROM channels WHERE id='history-a'").run();
    db.prepare(
      "INSERT INTO channels(id,type,name,enabled,config,security_config,created_at,updated_at) VALUES('history-b','slack','Fixture B',1,'{}','{}',0,0)",
    ).run();
    db.prepare(
      "INSERT INTO channel_messages(id,channel_id,channel_message_id,chat_id,direction,content,timestamp) VALUES('m1','history-b','remote-m1','selected-chat','incoming','Same cached source',1)",
    ).run();

    expect(() =>
      new TaskStore(db).create({
        title: "Changed connector instance",
        prompt: "Inspect selected cached history",
        workspaceId: scope.workspaceId,
        status: "pending",
        agentConfig: proposal?.agentConfig,
      }),
    ).toThrow("changed after source sampling");
    expect(taskCount()).toEqual({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_signal_heads").get(),
    ).toEqual({
      count: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_signal_runs").get(),
    ).toEqual({
      count: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM bot_responsibility_run_channel_instances").get(),
    ).toEqual({ count: 0 });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { TaskAdmissionService } from "../../control-plane/task-admission-service";
import { RoutineService } from "../../routines/service";
import { BotResponsibilityService } from "../BotResponsibilityService";
import { BotWorkControlService } from "../BotWorkControlService";
import { BotWorkControlStore } from "../BotWorkControlStore";
import { SchedulerLeaseStore } from "../scheduler-lease-store";
import { assertResponsibilityTaskPolicy } from "../responsibility-task-policy";
import type {
  BotResponsibility,
  BotResponsibilityDefinition,
  BotResponsibilityScope,
} from "../../../shared/bot-responsibility";

describe("future run pause preserves admitted work", () => {
  let dir: string, manager: DatabaseManager, scope: BotResponsibilityScope;
  let routines: RoutineService, service: BotResponsibilityService;
  let definition: BotResponsibilityDefinition;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-responsibility-activation-"));
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
      name: "private-fixture",
      displayName: "Private fixture",
      description: "Custom",
      systemPrompt: "My private instructions",
      capabilities: [],
    });
    scope = { workspaceId: workspace.id, agentRoleId: bot.id };
    const admission = new TaskAdmissionService(db);
    routines = new RoutineService({
      db,
      getCronService: () => null,
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
      createTaskIdempotent: async ({ operationKey, requestIdentity, ...input }) =>
        (
          await admission.admit(
            operationKey,
            { ...input, resumeStrategy: "snapshot" },
            requestIdentity,
          )
        ).task,
    });
    const engine = await routines.create({
      name: "Manual",
      enabled: false,
      workspaceId: workspace.id,
      prompt: "Routine context",
      connectors: [],
      triggers: [{ id: "manual", type: "manual", enabled: true }],
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
    definition = {
      objective: "Inspect selected evidence",
      engine: { kind: "routine", id: engine.id },
      mode: "observe",
      sources: [{ connectorId: "workspace_files", method: "read_file", resourceId: "evidence.md" }],
      permittedActions: [],
      expectedOutput: "Internal report",
      reviewBoundary: "all_effects",
      destination: { channel: "internal", id: "results" },
      backend: "node",
      budget: { maxTokens: 1000, maxCost: 0 },
    };
  });
  afterEach(async () => {
    await routines.stopWorkflowRuntime();
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const control = (record: BotResponsibility) => ({
    scope,
    id: record.id,
    expectedRevision: record.revision,
    expectedControlVersion: record.controlVersion,
  });
  const count = () => manager.getDatabase().prepare("SELECT COUNT(*) AS count FROM tasks").get();
  it("blocks new roots but preserves existing tools and delegated lineage", async () => {
    const saved = await service.create({ scope, definition });
    const active = await service.activate(control(saved));
    const run = await service.run({ ...control(active), requestId: "before-pause" });
    const tasks = new TaskStore(manager.getDatabase());
    const task = tasks.findById(run!.backingTaskId!)!;
    const receipt = await service.setFutureRuns({
      ...control(active),
      requestId: "pause-future",
      expectedFutureControlVersion: 0,
      paused: true,
    });
    expect(receipt.stillActiveTaskIds).toEqual([task.id]);
    expect((await service.list(scope))[0]).toMatchObject({
      state: "active",
      controlVersion: active.controlVersion,
      futurePaused: true,
      futureControlVersion: 1,
    });
    expect(() =>
      assertResponsibilityTaskPolicy(
        manager.getDatabase(),
        task.id,
        scope.workspaceId,
        {
          connectorId: "workspace_files",
          method: "read_file",
          resourceId: "evidence.md",
          effect: "read",
        },
        "node",
      ),
    ).not.toThrow();
    expect(() =>
      tasks.create({
        title: "new",
        prompt: "new",
        workspaceId: scope.workspaceId,
        status: "queued",
        agentConfig: task.agentConfig,
      }),
    ).toThrow("future runs are paused");
    expect(() =>
      tasks.create({
        title: "child",
        prompt: "child",
        workspaceId: scope.workspaceId,
        status: "queued",
        parentTaskId: task.id,
        agentConfig: {},
      }),
    ).not.toThrow();
  });
  it("replays the exact control receipt and rejects identity or CAS changes", async () => {
    const active = await service.activate(control(await service.create({ scope, definition })));
    const request = {
      ...control(active),
      requestId: "receipt",
      expectedFutureControlVersion: 0,
      paused: true,
    };
    const first = await service.setFutureRuns(request);
    expect(await service.setFutureRuns(request)).toEqual(first);
    await expect(service.setFutureRuns({ ...request, paused: false })).rejects.toThrow(
      "identity changed",
    );
    await expect(service.setFutureRuns({ ...request, requestId: "new-stale" })).rejects.toThrow(
      "control changed",
    );
    expect(
      manager
        .getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM bot_responsibility_future_receipts")
        .get(),
    ).toEqual({ count: 1 });
  });
  it("resume permits new admission without replaying consumed manual requests", async () => {
    const active = await service.activate(control(await service.create({ scope, definition })));
    const run = await service.run({ ...control(active), requestId: "original" });
    await service.setFutureRuns({
      ...control(active),
      requestId: "pause",
      expectedFutureControlVersion: 0,
      paused: true,
    });
    await service.setFutureRuns({
      ...control(active),
      requestId: "resume",
      expectedFutureControlVersion: 1,
      paused: false,
    });
    const replay = await service.run({ ...control(active), requestId: "original" });
    expect(replay?.backingTaskId).toBe(run?.backingTaskId);
    expect(count()).toEqual({ count: 1 });
  });
  it("keeps independent responsibilities and foreign work outside the receipt", async () => {
    const active = await service.activate(control(await service.create({ scope, definition })));
    const task = new TaskStore(manager.getDatabase()).create({
      title: "Other",
      prompt: "Other",
      workspaceId: scope.workspaceId,
      status: "queued",
    });
    const receipt = await service.setFutureRuns({
      ...control(active),
      requestId: "scope",
      expectedFutureControlVersion: 0,
      paused: true,
    });
    expect(receipt.stillActiveTaskIds).not.toContain(task.id);
    await expect(
      service.setFutureRuns({
        ...control(active),
        scope: { ...scope, workspaceId: "foreign" },
        requestId: "foreign",
        expectedFutureControlVersion: 1,
        paused: false,
      }),
    ).rejects.toThrow();
  });
  it("persists future pause and receipts across database reopen", async () => {
    const active = await service.activate(control(await service.create({ scope, definition })));
    const request = {
      ...control(active),
      requestId: "restart",
      expectedFutureControlVersion: 0,
      paused: true,
    };
    const first = await service.setFutureRuns(request);
    await routines.stopWorkflowRuntime();
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(dir, "fixture.db") });
    const fence = new SchedulerLeaseStore(manager.getDatabase()).acquire({
      owner: "fixture",
      now: Date.now(),
      leaseMs: 300000,
    })!;
    service = new BotResponsibilityService(manager.getDatabase(), {
      runtime: () => "node",
      assertOwnership: async () => {},
      getSchedulerFence: () => fence,
    });
    expect((await service.list(scope))[0].futurePaused).toBe(true);
    expect(await service.setFutureRuns(request)).toEqual(first);
  });
  it("bot pause covers current and newly bound responsibilities while existing work continues", async () => {
    const saved = await service.create({ scope, definition });
    const active = await service.activate(control(saved));
    const run = await service.run({ ...control(active), requestId: "existing" });
    const tasks = new TaskStore(manager.getDatabase());
    const work = new BotWorkControlService(manager.getDatabase(), {
      cancel: vi.fn(),
      isStopped: () => false,
    });
    const paused = await work.stop({ scope, requestId: "bot-pause", action: "pause_bot" });
    expect(paused!.tasks).toEqual([]);
    expect(paused!.stillActiveTaskIds).toEqual([run!.backingTaskId]);
    expect(paused!.futureControl).toMatchObject({
      futurePaused: true,
      responsibilityIds: [saved.id],
    });
    await expect(service.run({ ...control(active), requestId: "new-root" })).rejects.toThrow(
      "Bot future runs are paused",
    );
    const current = tasks.findById(run!.backingTaskId!)!;
    expect(() =>
      assertResponsibilityTaskPolicy(
        manager.getDatabase(),
        current.id,
        scope.workspaceId,
        {
          connectorId: "workspace_files",
          method: "read_file",
          resourceId: "evidence.md",
          effect: "read",
        },
        "node",
      ),
    ).not.toThrow();
    expect(() =>
      tasks.create({
        title: "Child",
        prompt: "Continue",
        workspaceId: scope.workspaceId,
        parentTaskId: current.id,
        status: "queued",
      }),
    ).not.toThrow();
    const engine = await routines.create({
      name: "Later",
      enabled: false,
      workspaceId: scope.workspaceId,
      prompt: "Later",
      connectors: [],
      triggers: [{ id: "manual", type: "manual", enabled: true }],
    });
    const later = await service.create({
      scope,
      definition: { ...definition, engine: { kind: "routine", id: engine.id } },
    });
    const laterActive = await service.activate(control(later));
    expect(laterActive.botFuturePaused).toBe(true);
    await expect(service.run({ ...control(laterActive), requestId: "later-root" })).rejects.toThrow(
      "Bot future runs are paused",
    );
    // An independently paused responsibility remains paused after bot resume.
    await service.setFutureRuns({
      ...control(active),
      requestId: "individual",
      expectedFutureControlVersion: 0,
      paused: true,
    });
    await work.stop({
      scope,
      requestId: "bot-resume",
      action: "resume_bot",
      expectedFutureControlVersion: paused!.futureControl!.futureControlVersion,
    });
    await expect(
      service.run({ ...control(active), requestId: "still-individual" }),
    ).rejects.toThrow("Responsibility future runs are paused");
    expect((await service.list(scope)).find((item) => item.id === later.id)?.botFuturePaused).toBe(
      false,
    );
  });
});

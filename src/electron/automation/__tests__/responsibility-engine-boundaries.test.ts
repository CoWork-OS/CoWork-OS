import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { WorkspaceStore } from "../../database/repositories";
import { TaskRepository } from "../../database/repository-facades";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { BotResponsibilityRepository } from "../BotResponsibilityRepository";
import { RoutineService } from "../../routines/service";
import { EventTriggerService } from "../../triggers/EventTriggerService";
import { CronService } from "../../cron/service";
import { RoutineWorkflowRepository } from "../../routines/routine-repository-facades";
import type {
  BotResponsibilityDefinition,
  BotResponsibilityScope,
} from "../../../shared/bot-responsibility";
import type { RoutineWorkflowDefinition } from "../../../shared/routine-workflow";
import type { RoutineWorkflowEngine } from "../../routines/workflow/engine";

const workflow: RoutineWorkflowDefinition = {
  version: 2,
  starterNodeId: "start",
  nodes: [
    { id: "start", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
    {
      id: "summary",
      kind: "action",
      operation: "ai.summarize",
      name: "Summarize",
      config: { input: "Selected evidence" },
    },
  ],
  edges: [{ id: "edge", sourceNodeId: "start", targetNodeId: "summary" }],
};
const definition = (kind: "routine" | "trigger", id: string): BotResponsibilityDefinition => ({
  objective: "Inspect selected evidence",
  engine: { kind, id },
  mode: "observe",
  sources: [],
  permittedActions: [],
  expectedOutput: "Internal report",
  reviewBoundary: "all_effects",
  destination: { channel: "internal", id: "results" },
  backend: "node",
  budget: { maxTokens: 1000, maxCost: 1 },
});
describe("persisted responsibility execution boundaries", () => {
  let directory: string;
  let manager: DatabaseManager;
  let scope: BotResponsibilityScope;
  let repository: BotResponsibilityRepository;
  let routines: RoutineService;
  let triggers: EventTriggerService;
  let cron: CronService;
  let createTask: ReturnType<typeof vi.fn>;
  let deliver: ReturnType<typeof vi.fn>;
  let executeAction: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-responsibility-boundary-"));
    manager = new DatabaseManager({ dbPath: path.join(directory, "fixture.db") });
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("Fixture", directory, {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    });
    const bot = new AgentRoleStore(db).create({
      name: "custom",
      displayName: "Custom",
      description: "Private",
      systemPrompt: "Private instructions",
      capabilities: [],
    });
    scope = { workspaceId: workspace.id, agentRoleId: bot.id };
    repository = new BotResponsibilityRepository(db);
    createTask = vi.fn().mockResolvedValue({ id: "fixture-task" });
    deliver = vi.fn().mockResolvedValue(undefined);
    executeAction = vi.fn().mockResolvedValue({ text: "Unexpected" });
    cron = new CronService({
      storePath: path.join(directory, "cron.json"),
      cronEnabled: true,
      createTask,
      deliverToChannel: deliver,
      beforeExecuteJob: (job) => repository.assertCronJobMayExecute(job.id),
      beforeDeliverJob: (id) => repository.assertCronJobMayExecute(id),
    });
    await cron.start();
    triggers = new EventTriggerService(
      {
        createTask,
        deliverToChannel: deliver,
        getDefaultWorkspaceId: () => workspace.id,
        log: vi.fn(),
      },
      db,
    );
    await triggers.start();
    routines = new RoutineService({
      db,
      getCronService: () => cron,
      getEventTriggerService: () => triggers,
      loadHooksSettings: () => ({
        enabled: false,
        token: "fixture",
        path: "/hooks",
        maxBodyBytes: 1024,
        presets: [],
        mappings: [],
      }),
      saveHooksSettings: vi.fn(),
      createTask,
      executeWorkflowAction: executeAction,
    });
  });
  afterEach(async () => {
    await routines.stopWorkflowRuntime();
    await triggers.stop();
    await cron.stop();
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const createRoutine = () =>
    routines.create({
      name: "Observe",
      enabled: false,
      workspaceId: scope.workspaceId,
      prompt: "Inspect evidence",
      connectors: [],
      triggers: [{ id: "manual", type: "manual", enabled: true }],
    });
  it("blocks a manual run after its legacy routine is enabled without activating the responsibility", async () => {
    const routine = await createRoutine();
    await repository.create(scope, definition("routine", routine.id));
    await routines.update(routine.id, { enabled: true });
    const result = await routines.runNow(routine.id);
    expect(result).toMatchObject({
      status: "failed",
      errorSummary: "Responsibility execution is paused",
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
  it("blocks force-running a persisted scheduled job before task creation or error delivery", async () => {
    const routine = await routines.create({
      name: "Schedule",
      enabled: false,
      workspaceId: scope.workspaceId,
      prompt: "Observe",
      connectors: [],
      triggers: [
        {
          id: "schedule",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *" },
        },
      ],
    });
    await repository.create(scope, definition("routine", routine.id));
    const job = (await cron.list({ includeDisabled: true }))[0];
    expect(job).toBeDefined();
    await cron.update(job.id, {
      delivery: {
        enabled: true,
        channelType: "slack",
        channelId: "fixture-only",
        deliverOnError: true,
      },
    });
    await cron.run(job.id, "force");
    expect(createTask).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    const history = await cron.getRunHistory(job.id);
    expect(JSON.stringify(history)).toContain("Responsibility execution is paused");
    expect(JSON.stringify(history)).toContain('"deliverableStatus":"none"');
  });
  it("rechecks the binding before delivering a result after work has already been admitted", async () => {
    const routine = await routines.create({
      name: "Late result",
      enabled: false,
      workspaceId: scope.workspaceId,
      prompt: "Fixture",
      connectors: [],
      triggers: [
        {
          id: "schedule",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *" },
        },
      ],
    });
    const job = (await cron.list({ includeDisabled: true }))[0];
    await cron.update(job.id, {
      delivery: { enabled: true, channelType: "slack", channelId: "fixture-only" },
    });
    createTask.mockImplementationOnce(async () => {
      await repository.create(scope, definition("routine", routine.id));
      return { id: "admitted-fixture-task" };
    });
    await cron.run(job.id, "force");
    expect(createTask).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(JSON.stringify(await cron.getRunHistory(job.id))).toContain(
      '"deliverableStatus":"none"',
    );
  });
  it("parks queued delivery after binding without spending a transport retry", async () => {
    const routine = await routines.create({
      name: "Queued result",
      enabled: false,
      workspaceId: scope.workspaceId,
      prompt: "Fixture",
      connectors: [],
      triggers: [
        {
          id: "schedule",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *" },
        },
      ],
    });
    const job = (await cron.list({ includeDisabled: true }))[0];
    await cron.update(job.id, {
      delivery: { enabled: true, channelType: "slack", channelId: "fixture-only" },
    });
    deliver.mockRejectedValue(new Error("Fixture transport unavailable"));
    await cron.run(job.id, "force");
    expect(deliver).toHaveBeenCalledOnce();
    await repository.create(scope, definition("routine", routine.id));
    const internals = cron as unknown as {
      state: {
        store: {
          outbox: Array<{
            nextAttemptAtMs: number;
            attempts: number;
            state: string;
            lastError?: string;
          }>;
        };
      };
      processOutboxQueue: () => Promise<void>;
    };
    const entry = internals.state.store.outbox[0];
    expect(entry.state).toBe("queued");
    const attempts = entry.attempts;
    entry.nextAttemptAtMs = 0;
    await internals.processOutboxQueue();
    expect(deliver).toHaveBeenCalledOnce();
    expect(entry).toMatchObject({
      state: "queued",
      attempts,
      lastError: "Delivery blocked by runtime admission",
    });
    expect(entry.nextAttemptAtMs).toBeGreaterThan(Date.now());
  });
  it("blocks an enabled legacy trigger before its interceptor or channel action", async () => {
    const trigger = await triggers.addTrigger({
      name: "Observe",
      enabled: false,
      source: "channel_message",
      conditions: [],
      workspaceId: scope.workspaceId,
      action: {
        type: "send_message",
        config: { channelType: "slack", channelId: "fixture-only", message: "Unexpected" },
      },
    });
    await repository.create(scope, definition("trigger", trigger.id));
    const intercept = vi.fn().mockResolvedValue({ handled: false });
    triggers.setFireInterceptor(intercept);
    await triggers.updateTrigger(trigger.id, { enabled: true });
    await triggers.evaluateEvent({
      source: "channel_message",
      timestamp: Date.now(),
      fields: { text: "Fixture" },
    });
    expect(intercept).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });
  it("rejects task admission atomically, including a deactivated or deleted bot binding", async () => {
    const routine = await createRoutine();
    await repository.create(scope, definition("routine", routine.id));
    const tasks = new TaskRepository(manager.getDatabase());
    const attempt = () =>
      tasks.create({
        title: "Blocked",
        prompt: "Fixture",
        workspaceId: scope.workspaceId,
        status: "pending",
        agentConfig: { automationRoutineId: routine.id },
      });
    await expect(attempt()).rejects.toThrow("Responsibility execution is paused");
    new AgentRoleStore(manager.getDatabase()).update({ id: scope.agentRoleId, isActive: false });
    await expect(attempt()).rejects.toThrow("Responsibility execution is paused");
    // Removing identity must not turn the still-bound engine into ungoverned legacy work.
    manager.getDatabase().prepare("DELETE FROM agent_roles WHERE id = ?").run(scope.agentRoleId);
    await expect(attempt()).rejects.toThrow("Responsibility execution is paused");
    expect(manager.getDatabase().prepare("SELECT COUNT(*) total FROM tasks").get()).toEqual({
      total: 0,
    });
  });
  it("blocks a recovered workflow's action using the current persisted binding", async () => {
    const routine = await createRoutine();
    const db = manager.getDatabase();
    const workflowRepository = new RoutineWorkflowRepository(db);
    const version = await workflowRepository.createVersion(routine.id, workflow, "active");
    const run = await workflowRepository.createRun({
      routineId: routine.id,
      workflowVersionId: version.id,
      triggerNodeId: "start",
      context: {
        trigger: {},
        nodes: { start: {} },
        approvedStepIds: [],
        dryRun: false,
        executedOperationCount: 0,
      },
    });
    await workflowRepository.initializeSteps(run.id, routine.id, workflow.nodes);
    const starter = await workflowRepository.findStep(run.id, "start");
    await workflowRepository.updateStep(starter!.id, { status: "completed", output: {} });
    await repository.create(scope, definition("routine", routine.id));
    const engine = (routines as unknown as { workflowEngine: RoutineWorkflowEngine })
      .workflowEngine;
    const result = await engine.continueRun(routine, workflow, run.id);
    expect(result.status).toBe("failed");
    expect(executeAction).not.toHaveBeenCalled();
    expect(JSON.stringify(await workflowRepository.listSteps(run.id))).toContain(
      "Responsibility execution is paused",
    );
  });
  it("keeps unbound legacy routines and tasks executable without inventing a responsibility", async () => {
    const routine = await createRoutine();
    await routines.update(routine.id, { enabled: true });
    await routines.runNow(routine.id);
    expect(createTask).toHaveBeenCalledOnce();
    const task = await new TaskRepository(manager.getDatabase()).create({
      title: "Legacy",
      prompt: "Fixture",
      workspaceId: scope.workspaceId,
      status: "pending",
      agentConfig: { automationRoutineId: routine.id },
    });
    expect(task.agentConfig?.automationRoutineId).toBe(routine.id);
    expect(await repository.list(scope)).toEqual([]);
  });
});

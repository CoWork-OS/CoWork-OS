import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { TaskAdmissionService } from "../../control-plane/task-admission-service";
import { ChannelTools } from "../../agent/tools/channel-tools";
import type { AgentDaemon } from "../../agent/daemon";
import { RoutineService } from "../../routines/service";
import { EventTriggerService } from "../../triggers/EventTriggerService";
import { BotResponsibilityService } from "../BotResponsibilityService";
import { SchedulerLeaseStore } from "../scheduler-lease-store";
import {
  assertResponsibilityTaskPolicy,
  fileResponsibilityOperation,
} from "../responsibility-task-policy";
import type {
  BotResponsibility,
  BotResponsibilityDefinition,
  BotResponsibilityScope,
} from "../../../shared/bot-responsibility";

describe("governed responsibility activation and manual admission", () => {
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
  it("activates without creating work, then replays a manual request through the durable admission receipt", async () => {
    expect((await service.preview({ scope, definition })).activationAvailable).toBe(true);
    const paused = await service.create({ scope, definition });
    const active = await service.activate(control(paused));
    expect(active).toMatchObject({ state: "active", controlVersion: 1 });
    expect((await routines.get(definition.engine.id))?.enabled).toBe(true);
    expect(count()).toEqual({ count: 0 });
    const request = { ...control(active), requestId: "retry-same-request" };
    const first = await service.run(request);
    const replay = await service.run(request);
    expect(first?.errorSummary).toBeUndefined();
    expect(first?.status).toBe("queued");
    expect(replay?.backingTaskId).toBe(first?.backingTaskId);
    expect(count()).toEqual({ count: 1 });
    expect(
      manager.getDatabase().prepare("SELECT COUNT(*) AS count FROM task_admission_receipts").get(),
    ).toEqual({ count: 1 });
    const task = new TaskStore(manager.getDatabase()).findById(first!.backingTaskId!)!;
    expect(task).toMatchObject({
      assignedAgentRoleId: scope.agentRoleId,
      budgetTokens: 1000,
      budgetCost: 0,
      agentConfig: {
        responsibilityRun: { id: active.id, revision: 1, controlVersion: 1 },
        allowedTools: ["read_file"],
      },
    });
    expect(task.prompt).toContain("Objective: Inspect selected evidence");
    expect(task.userPrompt?.match(/Responsibility /g)).toHaveLength(1);
  });
  it("pausing and reactivation cannot restore an older task's authority", async () => {
    const active = await service.activate(control(await service.create({ scope, definition })));
    const run = await service.run({ ...control(active), requestId: "first" });
    expect(run?.errorSummary).toBeUndefined();
    const db = manager.getDatabase();
    const operation = fileResponsibilityOperation("read_file", { path: "evidence.md" }, dir);
    expect(() =>
      assertResponsibilityTaskPolicy(db, run!.backingTaskId!, scope.workspaceId, operation),
    ).not.toThrow();
    const paused = await service.pause(control(active));
    expect(paused).toMatchObject({ state: "paused", controlVersion: 2 });
    expect((await routines.get(definition.engine.id))?.enabled).toBe(false);
    expect(() =>
      assertResponsibilityTaskPolicy(db, run!.backingTaskId!, scope.workspaceId, operation),
    ).toThrow("paused");
    const resumed = await service.activate(control(paused));
    expect(resumed.controlVersion).toBe(3);
    expect(() =>
      assertResponsibilityTaskPolicy(db, run!.backingTaskId!, scope.workspaceId, operation),
    ).toThrow("revision changed");
    const fresh = await service.run({ ...control(resumed), requestId: "second" });
    expect(fresh?.status).toBe("queued");
    expect(count()).toEqual({ count: 2 });
    await expect(service.pause(control(active))).rejects.toThrow("control changed");
  });
  it("requires a source for scheduled activation and denies unsupported adapters or absent desktop", async () => {
    const db = manager.getDatabase();
    const scheduled = [
      {
        id: "scheduled",
        type: "schedule",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
      },
    ];
    const original = await routines.get(definition.engine.id);
    db.prepare("UPDATE automation_routines SET triggers_json=?,definition_json=? WHERE id=?").run(
      JSON.stringify(scheduled),
      JSON.stringify({ ...original, triggers: scheduled }),
      definition.engine.id,
    );
    let preview = await service.preview({ scope, definition: { ...definition, sources: [] } });
    expect(preview.activationIssues).toContain(
      "Scheduled responsibilities require a selected observable source.",
    );
    expect((await service.preview({ scope, definition })).activationAvailable).toBe(true);
    db.prepare("UPDATE automation_routines SET triggers_json=?,definition_json=? WHERE id=?").run(
      JSON.stringify(original!.triggers),
      JSON.stringify(original),
      definition.engine.id,
    );
    preview = await service.preview({ scope, definition: { ...definition, backend: "desktop" } });
    expect(preview.activationAvailable).toBe(false);
    expect(preview.backendPresence).toBe("requires_desktop");
    preview = await service.preview({
      scope,
      definition: {
        ...definition,
        sources: [{ connectorId: "untrusted", method: "read", resourceId: "all" }],
      },
    });
    expect(preview.activationAvailable).toBe(false);
    expect(count()).toEqual({ count: 0 });
  });
  it("requires a selected mailbox account and selected source before event activation", async () => {
    const db = manager.getDatabase();
    const original = await routines.get(definition.engine.id);
    const mailboxTrigger = {
      id: "mailbox-trigger",
      type: "mailbox_event",
      enabled: true,
      eventType: "thread_classified",
      provider: "gmail",
    };
    db.prepare("UPDATE automation_routines SET triggers_json=?,definition_json=? WHERE id=?").run(
      JSON.stringify([mailboxTrigger]),
      JSON.stringify({ ...original, triggers: [mailboxTrigger] }),
      definition.engine.id,
    );
    let preview = await service.preview({ scope, definition });
    expect(preview.activationIssues).toContain(
      "Mailbox event responsibilities require one explicitly selected account.",
    );
    db.prepare(
      "INSERT INTO mailbox_accounts (id,provider,address,status,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run("mailbox-1", "gmail", "fixture@example.test", "connected", Date.now(), Date.now());
    const selected = { ...mailboxTrigger, accountId: "mailbox-1" };
    db.prepare("UPDATE automation_routines SET triggers_json=?,definition_json=? WHERE id=?").run(
      JSON.stringify([selected]),
      JSON.stringify({ ...original, triggers: [selected] }),
      definition.engine.id,
    );
    preview = await service.preview({ scope, definition });
    expect(preview.activationAvailable).toBe(true);
    preview = await service.preview({ scope, definition: { ...definition, sources: [] } });
    expect(preview.activationIssues).toContain(
      "Mailbox event responsibilities require a selected observable source.",
    );
    db.prepare("UPDATE mailbox_accounts SET status='disconnected' WHERE id=?").run("mailbox-1");
    preview = await service.preview({ scope, definition });
    expect(preview.activationIssues).toContain("Selected mailbox event account is unavailable.");
  });
  it("runs a persisted selected-account mailbox event as a wake-only task and fences account revocation", async () => {
    const db = manager.getDatabase();
    fs.writeFileSync(path.join(dir, "evidence.md"), "Selected source revision one");
    db.prepare(
      "INSERT INTO mailbox_accounts (id,provider,address,status,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run("mailbox-1", "gmail", "fixture@example.test", "connected", Date.now(), Date.now());
    const paused = await service.create({ scope, definition });
    const active = await service.activate(control(paused));
    let revokeDuringPreparation = false;
    const access = Object.defineProperty({}, "settings", {
      get() {
        if (revokeDuringPreparation)
          db.prepare("UPDATE mailbox_accounts SET status='disconnected' WHERE id=?").run(
            "mailbox-1",
          );
        return {};
      },
    });
    const createTask = vi.fn().mockResolvedValue({ id: "mailbox-wake-task" });
    const eventService = new EventTriggerService(
      {
        createTask,
        getDefaultWorkspaceId: () => scope.workspaceId,
        getResponsibilityAccess: () => access as never,
        log: vi.fn(),
      },
      db,
    );
    await eventService.start();
    try {
      const managed = await eventService.addTrigger({
        name: "Selected inbox wake",
        enabled: true,
        source: "mailbox_event",
        conditions: [{ field: "accountId", operator: "equals", value: "mailbox-1" }],
        action: {
          type: "create_task",
          config: {
            title: "Review selected evidence",
            prompt: "Read the selected responsibility sources.",
            workspaceId: scope.workspaceId,
            agentConfig: {},
            runMode: "new_task",
          },
        },
        workspaceId: scope.workspaceId,
        cooldownMs: 0,
      });
      const currentRoutine = await routines.get(definition.engine.id);
      const mailboxTrigger = {
        id: "selected-mailbox-trigger",
        type: "mailbox_event",
        enabled: true,
        accountId: "mailbox-1",
        managedEventTriggerId: managed.id,
      };
      db.prepare("UPDATE automation_routines SET triggers_json=?,definition_json=? WHERE id=?").run(
        JSON.stringify([mailboxTrigger]),
        JSON.stringify({ ...currentRoutine, triggers: [mailboxTrigger] }),
        definition.engine.id,
      );

      const emit = (id: string, subject: string) => {
        const timestamp = Date.now();
        db.prepare(
          `INSERT INTO mailbox_events
           (id,fingerprint,workspace_id,event_type,account_id,provider,subject,payload_json,created_at,last_seen_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          `fingerprint-${id}`,
          scope.workspaceId,
          "thread_classified",
          "mailbox-1",
          "gmail",
          subject,
          JSON.stringify({ subject }),
          timestamp,
          timestamp,
        );
        return {
          source: "mailbox_event" as const,
          eventId: JSON.stringify([
            "mailbox-event-v1",
            scope.workspaceId,
            "gmail",
            "mailbox-1",
            id,
          ]),
          timestamp,
          fields: {
            mailboxEventId: id,
            workspaceId: scope.workspaceId,
            accountId: "mailbox-1",
            provider: "gmail",
            eventType: "thread_classified",
            subject,
            summary: "private event payload",
          },
        };
      };

      await eventService.evaluateEvent(emit("mail-event-1", "private subject one"));
      await eventService.drainPendingEvents();
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(createTask).toHaveBeenLastCalledWith(
        expect.objectContaining({
          prompt: "Read the selected responsibility sources.",
          agentConfig: expect.objectContaining({
            responsibilityRun: expect.objectContaining({
              id: active.id,
              workspaceId: scope.workspaceId,
            }),
          }),
        }),
      );
      expect(JSON.stringify(createTask.mock.calls[0]?.[0])).not.toContain("private subject one");

      revokeDuringPreparation = true;
      fs.writeFileSync(path.join(dir, "evidence.md"), "Selected source revision two");
      await eventService.evaluateEvent(emit("mail-event-2", "private subject two"));
      await eventService.drainPendingEvents();
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(
        db
          .prepare(
            "SELECT status,error FROM event_trigger_occurrences WHERE trigger_id=? ORDER BY created_at DESC LIMIT 1",
          )
          .get(managed.id),
      ).toMatchObject({ status: "failed" });
    } finally {
      await eventService.stop();
    }
  });
  it("rolls failed engine synchronization back to a new paused control version", async () => {
    const paused = await service.create({ scope, definition });
    vi.spyOn(routines, "update").mockRejectedValueOnce(new Error("sync unavailable"));
    await expect(service.activate(control(paused))).rejects.toThrow("sync unavailable");
    expect(await service.list(scope)).toMatchObject([
      { id: paused.id, state: "paused", controlVersion: 2 },
    ]);
    expect((await routines.get(definition.engine.id))?.enabled).toBe(false);
    expect(count()).toEqual({ count: 0 });
  });
  it("fences activation when ownership expires before the state transaction", async () => {
    const paused = await service.create({ scope, definition });
    manager.getDatabase().prepare("UPDATE automation_scheduler_lease SET expires_at=0").run();
    await expect(service.activate(control(paused))).rejects.toThrow("ownership expired");
    expect(await service.list(scope)).toMatchObject([{ state: "paused", controlVersion: 0 }]);
    expect(count()).toEqual({ count: 0 });
  });
  it("restricts the native cached-history handler to the exact selected chat and rechecks channel availability", async () => {
    const db = manager.getDatabase();
    db.prepare(
      "INSERT INTO channels(id,type,name,enabled,config,security_config,created_at,updated_at) VALUES('fixture-channel','slack','Fixture',1,'{}','{}',0,0)",
    ).run();
    db.prepare(
      "INSERT INTO channel_messages(id,channel_id,channel_message_id,chat_id,direction,content,timestamp) VALUES('selected','fixture-channel','m1','selected-chat','incoming','Selected evidence',1),('other','fixture-channel','m2','other-chat','incoming','Private other evidence',2)",
    ).run();
    definition.sources = [
      { connectorId: "gateway:slack", method: "channel_history", resourceId: "selected-chat" },
    ];
    const active = await service.activate(control(await service.create({ scope, definition })));
    const run = await service.run({ ...control(active), requestId: "history" });
    expect(run?.errorSummary).toBeUndefined();
    const tools = new ChannelTools(
      db,
      { logEvent: vi.fn() } as unknown as AgentDaemon,
      run!.backingTaskId!,
    );
    const result = await tools.channelHistory({ channel: "slack", chat_id: "selected-chat" });
    expect(result.messages).toMatchObject([{ content: "Selected evidence" }]);
    await expect(tools.channelHistory({ channel: "slack", chat_id: "other-chat" })).rejects.toThrow(
      "source_not_selected",
    );
    db.prepare("UPDATE channels SET enabled=0 WHERE id='fixture-channel'").run();
    await expect(
      tools.channelHistory({ channel: "slack", chat_id: "selected-chat" }),
    ).rejects.toThrow("not enabled");
  });
  it("serializes competing activation controls from separate service instances", async () => {
    const paused = await service.create({ scope, definition });
    const fence = new SchedulerLeaseStore(manager.getDatabase()).acquire({
      owner: "fixture",
      now: Date.now(),
      leaseMs: 300000,
    })!;
    const second = new BotResponsibilityService(manager.getDatabase(), {
      runtime: () => "node",
      getRoutineService: () => routines,
      assertOwnership: async () => {},
      getSchedulerFence: () => fence,
    });
    const outcomes = await Promise.allSettled([
      service.activate(control(paused)),
      second.activate(control(paused)),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await service.list(scope)).toMatchObject([{ state: "active", controlVersion: 1 }]);
    expect(count()).toEqual({ count: 0 });
  });
});

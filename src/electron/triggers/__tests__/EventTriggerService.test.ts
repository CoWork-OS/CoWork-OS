import { describe, expect, it, beforeEach, vi } from "vitest";
import { EventTriggerService } from "../EventTriggerService";
import { EventTriggerServiceDeps, TriggerEvent } from "../types";

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

function makeDeps(overrides: Partial<EventTriggerServiceDeps> = {}): EventTriggerServiceDeps {
  return {
    createTask: vi.fn().mockResolvedValue({ id: "new-task-1" }),
    getDefaultWorkspaceId: () => "ws-default",
    log: vi.fn(),
    ...overrides,
  };
}

function makeMessageEvent(text: string, extra: Record<string, string> = {}): TriggerEvent {
  return {
    source: "channel_message",
    timestamp: Date.now(),
    fields: { text, ...extra },
  };
}

describe("EventTriggerService", () => {
  let service: EventTriggerService;
  let deps: EventTriggerServiceDeps;

  beforeEach(() => {
    deps = makeDeps();
    service = new EventTriggerService(deps); // no DB
    service.start();
  });

  // ── CRUD ────────────────────────────────────────────────────────

  it("addTrigger creates a trigger with generated id", () => {
    const trigger = service.addTrigger({
      name: "Test Trigger",
      enabled: true,
      source: "channel_message",
      conditions: [{ field: "text", operator: "contains", value: "deploy" }],
      action: { type: "create_task", config: { prompt: "Deploy triggered" } },
      workspaceId: "ws-1",
    });

    expect(trigger.id).toBeDefined();
    expect(trigger.fireCount).toBe(0);
    expect(trigger.name).toBe("Test Trigger");
  });

  it("listTriggers returns all triggers", () => {
    service.addTrigger({
      name: "T1",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: {} },
      workspaceId: "ws-1",
    });
    service.addTrigger({
      name: "T2",
      enabled: true,
      source: "email",
      conditions: [],
      action: { type: "create_task", config: {} },
      workspaceId: "ws-2",
    });

    expect(service.listTriggers()).toHaveLength(2);
    expect(service.listTriggers("ws-1")).toHaveLength(1);
  });

  it("updateTrigger modifies an existing trigger", () => {
    const t = service.addTrigger({
      name: "Original",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: {} },
      workspaceId: "ws-1",
    });

    const updated = service.updateTrigger(t.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.id).toBe(t.id); // id is immutable
  });

  it("updateTrigger returns null for non-existent id", () => {
    expect(service.updateTrigger("fake-id", { name: "X" })).toBeNull();
  });

  it("removeTrigger deletes a trigger", () => {
    const t = service.addTrigger({
      name: "ToDelete",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: {} },
      workspaceId: "ws-1",
    });

    expect(service.removeTrigger(t.id)).toBe(true);
    expect(service.listTriggers()).toHaveLength(0);
    expect(service.removeTrigger(t.id)).toBe(false); // already gone
  });

  // ── Event evaluation ──────────────────────────────────────────

  it("fires a trigger when conditions match", async () => {
    service.addTrigger({
      name: "Deploy Watcher",
      enabled: true,
      source: "channel_message",
      conditions: [{ field: "text", operator: "contains", value: "deploy" }],
      action: { type: "create_task", config: { prompt: "Handle deployment" } },
      workspaceId: "ws-1",
    });

    await service.evaluateEvent(makeMessageEvent("please deploy to production"));

    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Handle deployment" }),
    );
  });

  it("allows Routine v2 to intercept a matched trigger before task creation", async () => {
    const interceptor = vi.fn().mockResolvedValue({ handled: true, actionResult: "workflow_queued" });
    service.setFireInterceptor(interceptor);
    const trigger = service.addTrigger({
      name: "Workflow",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: { prompt: "Legacy task" } },
      workspaceId: "ws-1",
    });

    await service.evaluateEvent(makeMessageEvent("run workflow"));

    expect(interceptor).toHaveBeenCalledTimes(1);
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(service.getHistory(trigger.id)[0]?.actionResult).toBe("workflow_queued");
  });

  (nativeSqliteAvailable ? it : it.skip)("queues events while task capacity is full and replays them later", async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    let activeCount = 4;
    const localDeps = makeDeps({ getActiveTaskCount: () => activeCount });
    const localService = new EventTriggerService(localDeps, db);
    localService.start();
    localService.addTrigger({
      name: "Queued",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: { prompt: "Queued event" } },
      workspaceId: "ws-1",
    });

    await localService.evaluateEvent(makeMessageEvent("queued"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM event_trigger_queue").get().count).toBe(1);
    expect(localDeps.createTask).not.toHaveBeenCalled();

    activeCount = 0;
    await localService.drainPendingEvents();

    expect(localDeps.createTask).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM event_trigger_queue").get().count).toBe(0);
    localService.stop();
    db.close();
  });

  it("does not fire disabled triggers", async () => {
    service.addTrigger({
      name: "Disabled",
      enabled: false,
      source: "channel_message",
      conditions: [{ field: "text", operator: "contains", value: "deploy" }],
      action: { type: "create_task", config: { prompt: "X" } },
      workspaceId: "ws-1",
    });

    await service.evaluateEvent(makeMessageEvent("deploy now"));
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it("does not fire when source doesn't match", async () => {
    service.addTrigger({
      name: "Email Only",
      enabled: true,
      source: "email",
      conditions: [],
      action: { type: "create_task", config: { prompt: "X" } },
      workspaceId: "ws-1",
    });

    await service.evaluateEvent(makeMessageEvent("anything"));
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it("treats email and mailbox_event as aliases and labels inbox fires", async () => {
    const trigger = service.addTrigger({
      name: "Inbox Automation",
      enabled: true,
      source: "mailbox_event",
      conditions: [],
      action: { type: "create_task", config: { prompt: "Inbox task" } },
      workspaceId: "ws-1",
    });

    await service.evaluateEvent({
      source: "email",
      timestamp: Date.now(),
      fields: {
        eventType: "thread_classified",
        subject: "Need a reply",
      },
    });

    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(service.getHistory(trigger.id)[0]?.sourceLabel).toBe("Inbox automation");
  });

  it("respects cooldown period", async () => {
    const _t = service.addTrigger({
      name: "Cooldown Test",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: { prompt: "X" } },
      workspaceId: "ws-1",
      cooldownMs: 60_000,
    });

    await service.evaluateEvent(makeMessageEvent("first"));
    expect(deps.createTask).toHaveBeenCalledTimes(1);

    // Second evaluation within cooldown period → should not fire
    await service.evaluateEvent(makeMessageEvent("second"));
    expect(deps.createTask).toHaveBeenCalledTimes(1);
  });

  it("does not fire when service is stopped", async () => {
    service.addTrigger({
      name: "Active",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: { prompt: "X" } },
      workspaceId: "ws-1",
    });

    service.stop();
    await service.evaluateEvent(makeMessageEvent("hello"));
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  // ── History ────────────────────────────────────────────────────

  it("records history when a trigger fires", async () => {
    const t = service.addTrigger({
      name: "History Test",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: { prompt: "X" } },
      workspaceId: "ws-1",
      cooldownMs: 0,
    });

    await service.evaluateEvent(makeMessageEvent("event 1"));
    const history = service.getHistory(t.id);
    expect(history).toHaveLength(1);
    expect(history[0].actionResult).toBe("task_created");
    expect(history[0].taskId).toBe("new-task-1");
  });

  it("sends create_task actions to an existing thread when configured", async () => {
    const sendTaskMessage = vi.fn().mockResolvedValue({ queued: true });
    const localDeps = makeDeps({ sendTaskMessage });
    const localService = new EventTriggerService(localDeps);
    localService.start();

    const trigger = localService.addTrigger({
      name: "Thread Follow-up",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: {
        type: "create_task",
        config: {
          prompt: "Follow up on {{event.text}}",
          runMode: "thread_follow_up",
          targetTaskId: "task-existing",
        },
      },
      workspaceId: "ws-1",
    });

    await localService.evaluateEvent(makeMessageEvent("deployment"));

    expect(localDeps.createTask).not.toHaveBeenCalled();
    expect(sendTaskMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-existing",
        message: "Follow up on deployment",
      }),
    );
    expect(localService.getHistory(trigger.id)[0]).toMatchObject({
      actionResult: "thread_follow_up_sent",
      taskId: "task-existing",
    });
  });

  it("fails thread follow-up actions that are missing a target task", async () => {
    const localDeps = makeDeps();
    const localService = new EventTriggerService(localDeps);
    localService.start();

    const trigger = localService.addTrigger({
      name: "Broken Thread Follow-up",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: {
        type: "create_task",
        config: {
          prompt: "Follow up on {{event.text}}",
          runMode: "thread_follow_up",
        },
      },
      workspaceId: "ws-1",
    });

    await localService.evaluateEvent(makeMessageEvent("deployment"));

    expect(localDeps.createTask).not.toHaveBeenCalled();
    expect(localService.getHistory(trigger.id)[0]?.actionResult).toBe(
      "error: Thread follow-up trigger is missing a target task",
    );
  });

  // ── send_message action ────────────────────────────────────────

  it("fires send_message action", async () => {
    const deliverToChannel = vi.fn().mockResolvedValue(undefined);
    const localDeps = makeDeps({ deliverToChannel });
    const localService = new EventTriggerService(localDeps);
    localService.start();

    localService.addTrigger({
      name: "Reply Bot",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: {
        type: "send_message",
        config: { channelType: "slack", channelId: "C123", message: "Got it: {{event.text}}" },
      },
      workspaceId: "ws-1",
    });

    await localService.evaluateEvent(makeMessageEvent("help me"));
    expect(deliverToChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "slack",
        channelId: "C123",
        text: "Got it: help me",
      }),
    );
  });

  // ── Condition eval error resilience ────────────────────────────

  it("survives condition evaluation errors and continues to next trigger", async () => {
    // This trigger has a field that triggers no crash, but tests the try-catch
    service.addTrigger({
      name: "Safe Trigger",
      enabled: true,
      source: "channel_message",
      conditions: [{ field: "text", operator: "contains", value: "safe" }],
      action: { type: "create_task", config: { prompt: "safe action" } },
      workspaceId: "ws-1",
    });

    await service.evaluateEvent(makeMessageEvent("safe message"));
    expect(deps.createTask).toHaveBeenCalled();
  });

  // ── Fire count ─────────────────────────────────────────────────

  it("increments fire count on each trigger firing", async () => {
    const t = service.addTrigger({
      name: "Counter",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: { prompt: "X" } },
      workspaceId: "ws-1",
      cooldownMs: 0,
    });

    await service.evaluateEvent(makeMessageEvent("a"));
    await service.evaluateEvent(makeMessageEvent("b"));

    const trigger = service.getTrigger(t.id);
    expect(trigger?.fireCount).toBe(2);
  });
});

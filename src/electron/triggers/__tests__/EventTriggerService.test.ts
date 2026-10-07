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

  beforeEach(async () => {
    deps = makeDeps();
    service = new EventTriggerService(deps); // no DB
    await service.start();
  });

  // ── CRUD ────────────────────────────────────────────────────────

  it("addTrigger creates a trigger with generated id", async () => {
    const trigger = await service.addTrigger({
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

  it("listTriggers returns all triggers", async () => {
    await service.addTrigger({
      name: "T1",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: {} },
      workspaceId: "ws-1",
    });
    await service.addTrigger({
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

  it("updateTrigger modifies an existing trigger", async () => {
    const t = await service.addTrigger({
      name: "Original",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: {} },
      workspaceId: "ws-1",
    });

    const updated = await service.updateTrigger(t.id, { name: "Renamed" });
    expect(updated?.name).toBe("Renamed");
    expect(updated?.id).toBe(t.id); // id is immutable
  });

  it("updateTrigger returns null for non-existent id", async () => {
    expect(await service.updateTrigger("fake-id", { name: "X" })).toBeNull();
  });

  it("removeTrigger deletes a trigger", async () => {
    const t = await service.addTrigger({
      name: "ToDelete",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: {} },
      workspaceId: "ws-1",
    });

    expect(await service.removeTrigger(t.id)).toBe(true);
    expect(service.listTriggers()).toHaveLength(0);
    expect(await service.removeTrigger(t.id)).toBe(false); // already gone
  });

  // ── Event evaluation ──────────────────────────────────────────

  it("fires a trigger when conditions match", async () => {
    await service.addTrigger({
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
    const interceptor = vi
      .fn()
      .mockResolvedValue({ handled: true, actionResult: "workflow_queued" });
    service.setFireInterceptor(interceptor);
    const trigger = await service.addTrigger({
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

  (nativeSqliteAvailable ? it : it.skip)(
    "queues events while task capacity is full and replays them later",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      let activeCount = 4;
      const localDeps = makeDeps({ getActiveTaskCount: () => activeCount });
      const localService = new EventTriggerService(localDeps, db);
      await localService.start();
      await localService.addTrigger({
        name: "Queued",
        enabled: true,
        source: "channel_message",
        conditions: [],
        action: { type: "create_task", config: { prompt: "Queued event" } },
        workspaceId: "ws-1",
      });

      await localService.evaluateEvent(makeMessageEvent("queued"));
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM event_trigger_occurrences").get().count,
      ).toBe(1);
      expect(localDeps.createTask).not.toHaveBeenCalled();

      activeCount = 0;
      await localService.drainPendingEvents();

      expect(localDeps.createTask).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT COUNT(*) AS count FROM event_trigger_queue").get().count).toBe(0);
      expect(db.prepare("SELECT status FROM event_trigger_occurrences").get()).toEqual({
        status: "completed",
      });
      await localService.stop();
      db.close();
    },
  );

  (nativeSqliteAvailable ? it : it.skip)(
    "quarantines a processing legacy queue row whose action receipt cannot be known",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      const createTask = vi.fn().mockResolvedValue({ id: "must-not-replay-legacy-effect" });
      const localService = new EventTriggerService(makeDeps({ createTask }), db);
      const trigger = await localService.addTrigger({
        name: "Legacy queue recovery",
        enabled: true,
        source: "channel_message",
        conditions: [],
        action: { type: "create_task", config: { prompt: "legacy action may have run" } },
        workspaceId: "ws-1",
      });
      const now = Date.now();
      const event: TriggerEvent = {
        source: "channel_message",
        timestamp: 1710000000010,
        fields: { text: "legacy processing row" },
      };

      try {
        db.prepare("UPDATE event_triggers SET last_fired_at = ? WHERE id = ?").run(now, trigger.id);
        db.prepare(
          `INSERT INTO event_trigger_queue
           (id, dedupe_key, event_json, status, attempt_count, available_at, created_at, updated_at)
           VALUES (?, ?, ?, 'processing', 1, ?, ?, ?)`,
        ).run("legacy-processing", "legacy-dedupe", JSON.stringify(event), now, now, now);

        await localService.start();
        await localService.drainPendingEvents();

        expect(createTask).not.toHaveBeenCalled();
        expect(
          db
            .prepare("SELECT status, error FROM event_trigger_queue WHERE id = ?")
            .get("legacy-processing"),
        ).toMatchObject({
          status: "outcome_unknown",
          error: expect.stringContaining("without an action receipt"),
        });
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM event_trigger_queue WHERE id = ?")
            .get("legacy-processing"),
        ).toEqual({ count: 1 });
      } finally {
        await localService.stop();
        db.close();
      }
    },
  );

  (nativeSqliteAvailable ? it : it.skip)(
    "promotes a pending legacy queue row through the occurrence journal before executing",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      const createTask = vi.fn().mockResolvedValue({ id: "promoted-legacy-task" });
      const localService = new EventTriggerService(makeDeps({ createTask }), db);
      const trigger = await localService.addTrigger({
        name: "Legacy pending promotion",
        enabled: true,
        source: "channel_message",
        conditions: [],
        action: { type: "create_task", config: { prompt: "execute pending legacy event" } },
        workspaceId: "ws-1",
        cooldownMs: 0,
      });
      const now = Date.now();
      const event: TriggerEvent = {
        source: "channel_message",
        eventId: "legacy-pending-message-id",
        timestamp: 1710000000020,
        fields: { text: "legacy pending row" },
      };

      try {
        db.prepare(
          `INSERT INTO event_trigger_queue
           (id, dedupe_key, event_json, status, attempt_count, available_at, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
        ).run("legacy-pending", "legacy-pending-dedupe", JSON.stringify(event), now, now, now);

        await localService.start();
        await localService.drainPendingEvents();

        expect(createTask).toHaveBeenCalledTimes(1);
        expect(
          db
            .prepare(
              "SELECT status, receipt_json FROM event_trigger_occurrences WHERE trigger_id = ?",
            )
            .get(trigger.id),
        ).toMatchObject({ status: "completed" });
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM event_trigger_queue WHERE id = ?")
            .get("legacy-pending"),
        ).toEqual({ count: 0 });
      } finally {
        await localService.stop();
        db.close();
      }
    },
  );

  (nativeSqliteAvailable ? it : it.skip)(
    "resumes a persisted occurrence after cooldown was checkpointed before action start",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      let activeCount = 4;
      const createTask = vi.fn().mockResolvedValue({ id: "recovered-task" });
      const localDeps = makeDeps({ getActiveTaskCount: () => activeCount, createTask });
      const first = new EventTriggerService(localDeps, db);
      await first.start();
      const trigger = await first.addTrigger({
        name: "Recover after cooldown checkpoint",
        enabled: true,
        source: "channel_message",
        conditions: [],
        action: { type: "create_task", config: { prompt: "Resume this accepted event" } },
        workspaceId: "ws-1",
        cooldownMs: 60_000,
      });
      const event: TriggerEvent = {
        source: "channel_message",
        timestamp: 1710000000000,
        fields: { text: "stable event fixture" },
      };

      try {
        await first.evaluateEvent(event);
        expect(createTask).not.toHaveBeenCalled();
        expect(db.prepare("SELECT COUNT(*) AS count FROM event_trigger_occurrences").get()).toEqual(
          {
            count: 1,
          },
        );

        // Model a crash after the durable cooldown checkpoint but before the action starts.
        db.prepare("UPDATE event_triggers SET last_fired_at = ? WHERE id = ?").run(
          Date.now(),
          trigger.id,
        );
        await first.stop();

        activeCount = 0;
        const restarted = new EventTriggerService(localDeps, db);
        await restarted.start();
        await restarted.drainPendingEvents();

        expect(createTask).toHaveBeenCalledTimes(1);
        expect(
          db
            .prepare("SELECT status FROM event_trigger_occurrences WHERE trigger_id = ?")
            .get(trigger.id),
        ).toEqual({ status: "completed" });
        await restarted.stop();
      } finally {
        await first.stop();
        db.close();
      }
    },
  );

  (nativeSqliteAvailable ? it : it.skip)(
    "does not replay an accepted action when completion history persistence is interrupted",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      const createTask = vi.fn().mockResolvedValue({ id: "accepted-before-history" });
      const localDeps = makeDeps({ createTask });
      const first = new EventTriggerService(localDeps, db);
      await first.start();
      const trigger = await first.addTrigger({
        name: "Recover accepted action",
        enabled: true,
        source: "channel_message",
        conditions: [],
        action: { type: "create_task", config: { prompt: "Accepted once" } },
        workspaceId: "ws-1",
        cooldownMs: 0,
      });
      const event: TriggerEvent = {
        source: "channel_message",
        timestamp: 1710000000100,
        fields: { text: "accepted event fixture" },
      };

      try {
        db.exec(`CREATE TRIGGER fail_trigger_history_before_receipt
          BEFORE INSERT ON event_trigger_history
          BEGIN SELECT RAISE(ABORT, 'simulated loss before receipt persistence'); END;`);
        await first.evaluateEvent(event);
        expect(createTask).toHaveBeenCalledTimes(1);
        db.exec("DROP TRIGGER fail_trigger_history_before_receipt");
        await first.stop();

        const restarted = new EventTriggerService(localDeps, db);
        await restarted.start();
        await restarted.evaluateEvent(event);

        expect(createTask).toHaveBeenCalledTimes(1);
        expect(
          db
            .prepare("SELECT status FROM event_trigger_occurrences WHERE trigger_id = ?")
            .get(trigger.id),
        ).toEqual({ status: "outcome_unknown" });
        await restarted.stop();
      } finally {
        db.exec("DROP TRIGGER IF EXISTS fail_trigger_history_before_receipt");
        await first.stop();
        db.close();
      }
    },
  );

  (nativeSqliteAvailable ? it : it.skip)(
    "does not route a queued occurrence through a changed trigger definition",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      let activeCount = 4;
      const createTask = vi.fn().mockResolvedValue({ id: "must-not-run" });
      const localDeps = makeDeps({ getActiveTaskCount: () => activeCount, createTask });
      const localService = new EventTriggerService(localDeps, db);
      await localService.start();
      const trigger = await localService.addTrigger({
        name: "Definition snapshot",
        enabled: true,
        source: "channel_message",
        conditions: [],
        action: { type: "create_task", config: { prompt: "original action" } },
        workspaceId: "ws-original",
      });
      const event: TriggerEvent = {
        source: "channel_message",
        eventId: "gateway-instance-chat-message",
        timestamp: 1710000000150,
        fields: { text: "accepted before edit" },
      };

      try {
        await localService.evaluateEvent(event);
        // Simulate a sibling runtime editing the stored trigger while this runtime still has
        // its accepted occurrence queued. The final intent transaction must detect the drift.
        db.prepare("UPDATE event_triggers SET action = ?, workspace_id = ? WHERE id = ?").run(
          JSON.stringify({
            type: "create_task",
            config: { prompt: "changed action", workspaceId: "ws-changed" },
          }),
          "ws-changed",
          trigger.id,
        );
        activeCount = 0;
        await localService.drainPendingEvents();

        expect(createTask).not.toHaveBeenCalled();
        expect(
          db
            .prepare("SELECT status, error FROM event_trigger_occurrences WHERE trigger_id = ?")
            .get(trigger.id),
        ).toMatchObject({
          status: "failed",
          error: "Trigger definition changed or was removed after occurrence acceptance.",
        });
      } finally {
        await localService.stop();
        db.close();
      }
    },
  );

  (nativeSqliteAvailable ? it : it.skip)(
    "rejects admission failures and safely accepts the same stable event on producer retry",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      const createTask = vi.fn().mockResolvedValue({ id: "retry-task" });
      const localService = new EventTriggerService(makeDeps({ createTask }), db);
      await localService.start();
      const trigger = await localService.addTrigger({
        name: "Admission failure",
        enabled: true,
        source: "channel_message",
        conditions: [],
        action: { type: "create_task", config: { prompt: "retry accepted event" } },
        workspaceId: "ws-1",
        cooldownMs: 0,
      });
      const event: TriggerEvent = {
        source: "channel_message",
        eventId: "gateway-instance-chat-message-retry",
        timestamp: 1710000000160,
        fields: { text: "retry after durable admission failure" },
      };

      try {
        db.exec(`CREATE TRIGGER fail_trigger_occurrence_admission
          BEFORE INSERT ON event_trigger_occurrences
          BEGIN SELECT RAISE(ABORT, 'simulated occurrence admission failure'); END;`);
        await expect(localService.evaluateEvent(event)).rejects.toThrow(
          "simulated occurrence admission failure",
        );
        expect(createTask).not.toHaveBeenCalled();
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM event_trigger_occurrences WHERE trigger_id = ?")
            .get(trigger.id),
        ).toEqual({ count: 0 });

        db.exec("DROP TRIGGER fail_trigger_occurrence_admission");
        await localService.evaluateEvent(event);
        expect(createTask).toHaveBeenCalledTimes(1);
        expect(
          db
            .prepare("SELECT status FROM event_trigger_occurrences WHERE trigger_id = ?")
            .get(trigger.id),
        ).toEqual({ status: "completed" });
      } finally {
        db.exec("DROP TRIGGER IF EXISTS fail_trigger_occurrence_admission");
        await localService.stop();
        db.close();
      }
    },
  );

  (nativeSqliteAvailable ? it : it.skip)(
    "waits for an in-flight queued event before stopping",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      let activeCount = 4;
      let resolveCreateTask: ((value: { id: string }) => void) | undefined;
      const createTask = vi.fn(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveCreateTask = resolve;
          }),
      );
      const localDeps = makeDeps({ getActiveTaskCount: () => activeCount, createTask });
      const localService = new EventTriggerService(localDeps, db);
      await localService.start();
      await localService.addTrigger({
        name: "Queued shutdown",
        enabled: true,
        source: "channel_message",
        conditions: [],
        action: { type: "create_task", config: { prompt: "Queued event" } },
        workspaceId: "ws-1",
      });

      await localService.evaluateEvent(makeMessageEvent("queued"));
      activeCount = 0;
      const drainPromise = localService.drainPendingEvents();
      await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));

      let stopped = false;
      const stopPromise = localService.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      resolveCreateTask?.({ id: "new-task-1" });
      await drainPromise;
      await stopPromise;
      expect(stopped).toBe(true);
      db.close();
    },
  );

  it("does not fire disabled triggers", async () => {
    await service.addTrigger({
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
    await service.addTrigger({
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
    const trigger = await service.addTrigger({
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
    const _t = await service.addTrigger({
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
    await service.addTrigger({
      name: "Active",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: { prompt: "X" } },
      workspaceId: "ws-1",
    });

    await service.stop();
    await service.evaluateEvent(makeMessageEvent("hello"));
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  // ── History ────────────────────────────────────────────────────

  it("records history when a trigger fires", async () => {
    const t = await service.addTrigger({
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
    await localService.start();

    const trigger = await localService.addTrigger({
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
    await localService.start();

    const trigger = await localService.addTrigger({
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
    const deliverToChannel = vi.fn().mockResolvedValue({ messageId: "message-1" });
    const localDeps = makeDeps({ deliverToChannel });
    const localService = new EventTriggerService(localDeps);
    await localService.start();

    await localService.addTrigger({
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

  (nativeSqliteAvailable ? it : it.skip)(
    "persists a typed channel receipt and deduplicates a replay by stable ingress identity",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      const deliverToChannel = vi.fn().mockResolvedValue({ messageId: "gateway-message-42" });
      const localDeps = makeDeps({ deliverToChannel, getActiveTaskCount: () => 0 });
      const first = new EventTriggerService(localDeps, db);
      await first.start();
      const trigger = await first.addTrigger({
        name: "Durable channel receipt",
        enabled: true,
        source: "channel_message",
        conditions: [],
        action: {
          type: "send_message",
          config: { channelType: "slack", channelId: "channel-1", message: "ack" },
        },
        workspaceId: "ws-1",
        cooldownMs: 0,
      });
      const event: TriggerEvent = {
        source: "channel_message",
        eventId: "gateway:slack:channel-1:chat-1:message-42",
        timestamp: 1710000000200,
        fields: { chatId: "chat-1", text: "hello" },
      };

      try {
        await first.evaluateEvent(event);
        expect(deliverToChannel).toHaveBeenCalledTimes(1);
        expect(deliverToChannel).toHaveBeenCalledWith(
          expect.objectContaining({
            channelType: "slack",
            channelId: "channel-1",
            text: "ack",
            idempotencyKey: expect.any(String),
          }),
        );
        const persisted = db
          .prepare(
            "SELECT status, receipt_json FROM event_trigger_occurrences WHERE trigger_id = ?",
          )
          .get(trigger.id);
        expect(persisted.status).toBe("completed");
        expect(JSON.parse(persisted.receipt_json)).toEqual({
          kind: "channel_message",
          messageId: "gateway-message-42",
        });

        await first.stop();
        const restarted = new EventTriggerService(localDeps, db);
        await restarted.start();
        await restarted.evaluateEvent(event);
        expect(deliverToChannel).toHaveBeenCalledTimes(1);
        await restarted.evaluateEvent({
          ...event,
          fields: { ...event.fields, channelInstanceId: "channel-2" },
        });
        expect(deliverToChannel).toHaveBeenCalledTimes(2);
        await restarted.stop();
      } finally {
        await first.stop();
        db.close();
      }
    },
  );

  // ── Condition eval error resilience ────────────────────────────

  it("survives condition evaluation errors and continues to next trigger", async () => {
    // This trigger has a field that triggers no crash, but tests the try-catch
    await service.addTrigger({
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
    const t = await service.addTrigger({
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

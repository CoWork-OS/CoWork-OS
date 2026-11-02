import { describe, expect, it, vi } from "vitest";
import { EventTriggerService } from "../EventTriggerService";
import type { EventTrigger, EventTriggerServiceDeps, TriggerEvent } from "../types";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

function makeDeps(overrides: Partial<EventTriggerServiceDeps> = {}): EventTriggerServiceDeps {
  return {
    createTask: vi.fn().mockResolvedValue({ id: "new-task" }),
    getDefaultWorkspaceId: () => "ws-default",
    log: vi.fn(),
    ...overrides,
  };
}

const PR_PAYLOAD = JSON.stringify({ pull_request: { number: 42 } });

function githubEvent(action: string, payload = PR_PAYLOAD): TriggerEvent {
  return {
    source: "github_event",
    timestamp: Date.now(),
    fields: { connectorId: "github", repository: "acme/app", action, payload },
  };
}

function messageEvent(text: string): TriggerEvent {
  return {
    source: "channel_message",
    timestamp: Date.now(),
    fields: { channelType: "slack", chatId: "C1", text },
  };
}

const githubTrigger: Omit<EventTrigger, "id" | "fireCount" | "createdAt" | "updatedAt"> = {
  name: "PR activity",
  enabled: true,
  source: "github_event",
  conditions: [],
  action: { type: "create_task", config: { prompt: "Handle {{event.action}}" } },
  workspaceId: "ws-1",
  cooldownMs: 0,
};

describe("EventTriggerService semantic gate", () => {
  it("creates the task when the gate says act and records the verdict", async () => {
    const runSemanticGate = vi.fn().mockResolvedValue({ decision: "act", reason: "Policy 1" });
    const deps = makeDeps({ resolveGateMode: () => "candidate", runSemanticGate });
    const service = new EventTriggerService(deps);
    await service.start();
    const trigger = await service.addTrigger({
      name: "Questions",
      enabled: true,
      source: "channel_message",
      conditions: [{ field: "text", operator: "contains", value: "?" }],
      action: { type: "create_task", config: { prompt: "Answer {{event.text}}" } },
      workspaceId: "ws-1",
    });

    await service.evaluateEvent(messageEvent("Can you ship today?"));

    expect(runSemanticGate).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: expect.objectContaining({ id: trigger.id }) }),
    );
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(service.getHistory(trigger.id)[0]).toMatchObject({
      actionResult: "task_created",
      gateDecision: "act",
      gateReason: "Policy 1",
    });
  });

  it("skips the action when the gate ignores, without using the cooldown", async () => {
    const runSemanticGate = vi
      .fn()
      .mockResolvedValueOnce({ decision: "ignore", reason: "Small talk" })
      .mockResolvedValueOnce({ decision: "act", reason: "Real question" });
    const deps = makeDeps({ resolveGateMode: () => "candidate", runSemanticGate });
    const service = new EventTriggerService(deps);
    await service.start();
    const trigger = await service.addTrigger({
      name: "Default cooldown",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: { prompt: "x" } },
      workspaceId: "ws-1",
    });

    await service.evaluateEvent(messageEvent("nice weather"));
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(service.getHistory(trigger.id)[0]).toMatchObject({
      actionResult: "gate_ignored",
      gateDecision: "ignore",
      gateReason: "Small talk",
    });
    expect(service.getTrigger(trigger.id)?.fireCount).toBe(0);

    // The ignored event did not start the one-minute cooldown.
    await service.evaluateEvent(messageEvent("can you look at the outage?"));
    expect(deps.createTask).toHaveBeenCalledTimes(1);
  });

  it("does not call the gate for explicit_only sources and fails closed without one", async () => {
    const explicitDeps = makeDeps({ resolveGateMode: () => "explicit_only" });
    const explicit = new EventTriggerService(explicitDeps);
    await explicit.start();
    await explicit.addTrigger({ ...githubTrigger });
    await explicit.evaluateEvent(githubEvent("opened"));
    expect(explicitDeps.createTask).toHaveBeenCalledTimes(1);

    const noGateDeps = makeDeps({ resolveGateMode: () => "candidate" });
    const noGate = new EventTriggerService(noGateDeps);
    await noGate.start();
    const trigger = await noGate.addTrigger({ ...githubTrigger });
    await noGate.evaluateEvent(githubEvent("opened"));
    expect(noGateDeps.createTask).not.toHaveBeenCalled();
    expect(noGate.getHistory(trigger.id)[0]?.actionResult).toBe("gate_ignored");
  });

  it("starts no work from an ignored source but still resumes a waiting task", async () => {
    const onEventWaitFired = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ resolveGateMode: () => "ignore", onEventWaitFired });
    const service = new EventTriggerService(deps);
    await service.start();
    const plain = await service.addTrigger({ ...githubTrigger });
    await service.addTrigger({
      ...githubTrigger,
      name: "wait",
      action: {
        type: "create_task",
        config: { eventWait: { taskId: "parked-task", expiresAt: Date.now() + 60_000 } },
      },
    });

    await service.evaluateEvent(githubEvent("closed"));

    expect(deps.createTask).not.toHaveBeenCalled();
    expect(service.getHistory(plain.id)).toEqual([]);
    expect(onEventWaitFired).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "parked-task" }),
    );
  });
});

describe("EventTriggerService thread subscriptions", () => {
  it("subscribes the task created for a thread's first event and replies GitHub-style", async () => {
    const subscribeThread = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findActiveThreadSubscribers: vi.fn().mockResolvedValue([]),
      deliverThreadEvent: vi.fn(),
      subscribeThread,
    });
    const service = new EventTriggerService(deps);
    await service.start();
    const trigger = await service.addTrigger({ ...githubTrigger });

    await service.evaluateEvent(githubEvent("opened"));

    expect(deps.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        // The task also carries its origin refs (Chain of Recall) next to the reply surface.
        agentConfig: expect.objectContaining({ replySurface: "github" }),
      }),
    );
    expect(subscribeThread).toHaveBeenCalledWith("github:acme/app:pr:42", "new-task");
    expect(service.getHistory(trigger.id)[0]).toMatchObject({
      actionResult: "task_created",
      threadKey: "github:acme/app:pr:42",
    });
  });

  it("delivers later thread events to the running subscriber once and creates no task", async () => {
    const deliverThreadEvent = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      findActiveThreadSubscribers: vi.fn().mockResolvedValue(["task-a", "task-b"]),
      deliverThreadEvent,
      subscribeThread: vi.fn(),
    });
    const service = new EventTriggerService(deps);
    await service.start();
    const first = await service.addTrigger({ ...githubTrigger });
    const second = await service.addTrigger({ ...githubTrigger, name: "Second trigger" });

    const reviewEvent = githubEvent("submitted");
    await service.evaluateEvent(reviewEvent);

    expect(deps.createTask).not.toHaveBeenCalled();
    // One delivery per subscriber, although two triggers matched.
    expect(deliverThreadEvent).toHaveBeenCalledTimes(2);
    expect(deliverThreadEvent).toHaveBeenCalledWith({
      taskId: "task-a",
      threadKey: "github:acme/app:pr:42",
      event: reviewEvent,
    });
    for (const trigger of [first, second]) {
      expect(service.getHistory(trigger.id)[0]).toMatchObject({
        actionResult: "thread_delivered",
        taskId: "task-a",
        threadKey: "github:acme/app:pr:42",
      });
    }

    // The same event again (a retry) is not delivered twice.
    await service.evaluateEvent(reviewEvent);
    expect(deliverThreadEvent).toHaveBeenCalledTimes(2);
  });

  it("checks thread subscribers before asking the gate", async () => {
    const runSemanticGate = vi.fn();
    const deps = makeDeps({
      resolveGateMode: () => "candidate",
      runSemanticGate,
      findActiveThreadSubscribers: vi.fn().mockResolvedValue(["task-a"]),
      deliverThreadEvent: vi.fn().mockResolvedValue(undefined),
    });
    const service = new EventTriggerService(deps);
    await service.start();
    await service.addTrigger({ ...githubTrigger });
    await service.evaluateEvent(githubEvent("synchronize"));
    expect(runSemanticGate).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it("does not deliver events from threads without a key or gateway messages", async () => {
    const deliverThreadEvent = vi.fn();
    const findActiveThreadSubscribers = vi.fn().mockResolvedValue(["task-a"]);
    const service = new EventTriggerService(
      makeDeps({ findActiveThreadSubscribers, deliverThreadEvent }),
    );
    await service.start();
    await service.evaluateEvent(githubEvent("pushed", JSON.stringify({ ref: "main" })));
    await service.evaluateEvent({
      ...messageEvent("hello"),
      fields: {
        channelType: "slack",
        channelInstanceId: "chan",
        chatId: "C1",
        threadId: "1.2",
        text: "hello",
      },
    });
    expect(deliverThreadEvent).not.toHaveBeenCalled();
  });

  (nativeSqliteAvailable ? it : it.skip)(
    "journals gate decisions and thread routing, and gives back the cooldown",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      let subscribers: string[] = [];
      const runSemanticGate = vi.fn().mockResolvedValue({ decision: "ignore", reason: "Noise" });
      const deps = makeDeps({
        resolveGateMode: (event) =>
          event.source === "channel_message" ? "candidate" : "explicit_only",
        runSemanticGate,
        findActiveThreadSubscribers: vi.fn(async () => subscribers),
        deliverThreadEvent: vi.fn().mockResolvedValue(undefined),
        subscribeThread: vi.fn().mockResolvedValue(undefined),
      });
      const service = new EventTriggerService(deps, db);
      try {
        await service.start();
        const chat = await service.addTrigger({
          name: "Chat",
          enabled: true,
          source: "channel_message",
          conditions: [],
          action: { type: "create_task", config: { prompt: "x" } },
          workspaceId: "ws-1",
        });
        const pr = await service.addTrigger({ ...githubTrigger, cooldownMs: 60_000 });

        await service.evaluateEvent(messageEvent("lunch?"));
        await service.drainPendingEvents();
        expect(deps.createTask).not.toHaveBeenCalled();
        const chatRow = db
          .prepare(
            "SELECT action_result, gate_decision, gate_reason FROM event_trigger_history WHERE trigger_id = ?",
          )
          .get(chat.id);
        expect(chatRow).toEqual({
          action_result: "gate_ignored",
          gate_decision: "ignore",
          gate_reason: "Noise",
        });
        expect(
          db
            .prepare("SELECT last_fired_at, fire_count FROM event_triggers WHERE id = ?")
            .get(chat.id),
        ).toEqual({ last_fired_at: null, fire_count: 0 });

        subscribers = ["task-a"];
        await service.evaluateEvent(githubEvent("submitted"));
        await service.drainPendingEvents();
        expect(deps.createTask).not.toHaveBeenCalled();
        expect(
          db
            .prepare(
              "SELECT action_result, task_id, thread_key FROM event_trigger_history WHERE trigger_id = ?",
            )
            .get(pr.id),
        ).toEqual({
          action_result: "thread_delivered",
          task_id: "task-a",
          thread_key: "github:acme/app:pr:42",
        });
        expect(
          db
            .prepare(
              "SELECT status, receipt_json FROM event_trigger_occurrences WHERE trigger_id = ?",
            )
            .get(pr.id),
        ).toEqual({
          status: "completed",
          receipt_json: JSON.stringify({
            kind: "thread_subscription",
            threadKey: "github:acme/app:pr:42",
            taskIds: ["task-a"],
          }),
        });

        // Its 60 s cooldown was given back, so the next PR's event starts work at once.
        subscribers = [];
        await service.evaluateEvent(
          githubEvent("opened", JSON.stringify({ pull_request: { number: 43 } })),
        );
        await service.drainPendingEvents();
        expect(deps.createTask).toHaveBeenCalledTimes(1);
        expect(deps.subscribeThread).toHaveBeenCalledWith("github:acme/app:pr:43", "new-task");
      } finally {
        await service.stop();
        db.close();
      }
    },
  );
});

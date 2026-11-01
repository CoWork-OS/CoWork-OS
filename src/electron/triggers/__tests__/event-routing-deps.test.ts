import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subscriptions: {
    findActiveSubscribers: vi.fn(),
    subscribe: vi.fn(),
    unsubscribeTask: vi.fn(),
  },
  tasks: { findById: vi.fn() },
  runSemanticGate: vi.fn(),
}));

vi.mock("../../database/repository-facades", () => ({
  ThreadSubscriptionRepository: vi.fn().mockImplementation(function () {
    return mocks.subscriptions;
  }),
  TaskRepository: vi.fn().mockImplementation(function () {
    return mocks.tasks;
  }),
}));

vi.mock("../../settings/event-gate-manager", () => ({
  EventGateSettingsManager: {
    resolveEventMode: vi.fn(() => "candidate"),
    enabledPolicyTexts: vi.fn(() => ["Act on review requests"]),
  },
}));

vi.mock("../semantic-gate", () => ({ runSemanticGate: mocks.runSemanticGate }));

import { attachThreadSubscriptionCleanup, createEventRoutingDeps } from "../event-routing-deps";
import type { EventTrigger, TriggerEvent } from "../types";

const EVENT: TriggerEvent = {
  source: "github_event",
  timestamp: 1,
  fields: { repository: "acme/app", action: "review_requested" },
};

describe("createEventRoutingDeps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers thread events as untrusted follow-ups after checking ownership", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const assertOwnership = vi.fn().mockResolvedValue(undefined);
    const deps = createEventRoutingDeps({
      db: {} as never,
      agentDaemon: { sendMessage },
      assertOwnership,
    });

    await deps.deliverThreadEvent!({
      taskId: "task-1",
      threadKey: "github:acme/app:pr:1",
      event: EVENT,
    });

    expect(assertOwnership).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("[Untrusted external event]"),
    );
    // Only the task id and text: no user_typed provenance.
    expect(sendMessage.mock.calls[0]).toHaveLength(2);
  });

  it("asks the gate with the enabled policies and stores subscriptions", async () => {
    mocks.runSemanticGate.mockResolvedValue({ decision: "act", reason: "Review request" });
    const deps = createEventRoutingDeps({ db: {} as never, agentDaemon: { sendMessage: vi.fn() } });
    const trigger = { id: "trigger-1", workspaceId: "ws-1" } as EventTrigger;

    expect(deps.resolveGateMode!(EVENT)).toBe("candidate");
    await expect(deps.runSemanticGate!({ trigger, event: EVENT })).resolves.toEqual({
      decision: "act",
      reason: "Review request",
    });
    expect(mocks.runSemanticGate).toHaveBeenCalledWith({
      source: "github_event",
      fields: EVENT.fields,
      policies: ["Act on review requests"],
      sourceId: "trigger-1",
      workspaceId: "ws-1",
    });

    await deps.subscribeThread!("github:acme/app:pr:1", "task-1");
    expect(mocks.subscriptions.subscribe).toHaveBeenCalledWith(
      "github:acme/app:pr:1",
      "task-1",
      expect.any(Number),
    );
  });
});

describe("attachThreadSubscriptionCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscriptions.unsubscribeTask.mockResolvedValue(1);
  });

  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("unsubscribes a task once it completes, fails or is cancelled", async () => {
    const daemon = new EventEmitter();
    const detach = attachThreadSubscriptionCleanup({ db: {} as never, daemon });

    mocks.tasks.findById.mockResolvedValue({ id: "task-1", status: "executing" });
    daemon.emit("task_status", { taskId: "task-1", status: "executing" });
    await settle();
    expect(mocks.subscriptions.unsubscribeTask).not.toHaveBeenCalled();

    mocks.tasks.findById.mockResolvedValue({ id: "task-1", status: "failed" });
    daemon.emit("task_status", { taskId: "task-1", status: "failed" });
    await settle();
    expect(mocks.subscriptions.unsubscribeTask).toHaveBeenCalledWith("task-1");

    mocks.tasks.findById.mockResolvedValue({ id: "task-2", status: "completed" });
    daemon.emit("task_completed", { taskId: "task-2" });
    await settle();
    expect(mocks.subscriptions.unsubscribeTask).toHaveBeenCalledWith("task-2");

    detach();
    daemon.emit("task_completed", { taskId: "task-3" });
    await settle();
    expect(mocks.subscriptions.unsubscribeTask).toHaveBeenCalledTimes(2);
  });

  it("tolerates daemons that emit no lifecycle events", () => {
    expect(() => attachThreadSubscriptionCleanup({ db: {} as never, daemon: {} })).not.toThrow();
  });
});

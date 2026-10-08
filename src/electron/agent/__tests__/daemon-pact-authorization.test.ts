import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import { PACT_AUTHORIZATION_QUESTION_ID } from "../../../shared/pact";

function createRepo() {
  const store = new Map<string, Any>();
  let next = 0;
  return {
    create: vi.fn(async (request: Any) => {
      const created = { id: `req-${++next}`, ...request };
      store.set(created.id, created);
      return created;
    }),
    findPendingByTaskId: vi.fn(async (taskId: string) =>
      [...store.values()].filter((item) => item.taskId === taskId && item.status === "pending"),
    ),
    findById: vi.fn(async (id: string) => store.get(id)),
    resolve: vi.fn(async (id: string, status: "submitted" | "dismissed", answers?: Any) => {
      const existing = store.get(id);
      if (!existing || existing.status !== "pending") return false;
      store.set(id, { ...existing, status, answers });
      return true;
    }),
    __store: store,
  };
}

const view = {
  id: "auth-1",
  businessId: "b",
  businessName: "Example Co.",
  purpose: "Cancel order A-1",
  requestedScopes: [{ id: "orders:cancel", description: "Cancel an order" }],
  state: "pending" as const,
  expiresAt: Date.now() + 600_000,
  createdAt: Date.now(),
};

function daemonLike(taskStatus = "executing") {
  const runtime = { onAuthorizationInputDismissed: vi.fn(async () => undefined) };
  const daemon = {
    inputRequestRepo: createRepo(),
    taskRepo: { findById: vi.fn(() => ({ id: "task-1", status: taskStatus })) },
    livePactAuthorizationWaits: new Set<string>(),
    pendingInputRequests: new Map(),
    updateTask: vi.fn(),
    logEvent: vi.fn(),
    resumeTaskAfterDurableWait: vi.fn(async () => undefined),
    getPactRuntime: () => runtime,
  } as Any;
  daemon.settlePactAuthorizationWait =
    AgentDaemon.prototype.settlePactAuthorizationWait.bind(daemon);
  return { daemon, runtime };
}

describe("PACT sign-in wait on the daemon", () => {
  it("opens a durable input request that pauses the task", async () => {
    const { daemon } = daemonLike();
    const requestId = await AgentDaemon.prototype.openPactAuthorizationWait.call(
      daemon,
      "task-1",
      view,
    );
    const stored = daemon.inputRequestRepo.__store.get(requestId);
    expect(stored.questions[0].id).toBe(PACT_AUTHORIZATION_QUESTION_ID);
    expect(daemon.updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ status: "paused", terminalStatus: "needs_user_action" }),
    );
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "task_paused",
      expect.objectContaining({ reason: "pact_authorization" }),
    );
  });

  it("never accepts a submitted answer as evidence of a grant", async () => {
    const { daemon } = daemonLike();
    const requestId = await AgentDaemon.prototype.openPactAuthorizationWait.call(
      daemon,
      "task-1",
      view,
    );
    const result = await AgentDaemon.prototype.respondToInputRequest.call(daemon, {
      requestId,
      status: "submitted",
      answers: { [PACT_AUTHORIZATION_QUESTION_ID]: { optionLabel: "Waiting for sign-in" } },
    });
    expect(result.status).toBe("in_progress");
    expect(daemon.inputRequestRepo.__store.get(requestId).status).toBe("pending");
  });

  it("cancels the sign-in when the user dismisses the card", async () => {
    const { daemon, runtime } = daemonLike();
    const requestId = await AgentDaemon.prototype.openPactAuthorizationWait.call(
      daemon,
      "task-1",
      view,
    );
    const result = await AgentDaemon.prototype.respondToInputRequest.call(daemon, {
      requestId,
      status: "dismissed",
    });
    expect(result.status).toBe("handled");
    expect(runtime.onAuthorizationInputDismissed).toHaveBeenCalledWith(requestId);
    expect(daemon.inputRequestRepo.__store.get(requestId).status).toBe("dismissed");
  });

  it("lets a live tool call continue, and resumes a restarted task with the outcome", async () => {
    const live = daemonLike();
    const liveId = await AgentDaemon.prototype.openPactAuthorizationWait.call(
      live.daemon,
      "task-1",
      view,
    );
    await live.daemon.settlePactAuthorizationWait(liveId, "granted", "approved");
    expect(live.daemon.updateTask).toHaveBeenLastCalledWith(
      "task-1",
      expect.objectContaining({ status: "executing" }),
    );
    expect(live.daemon.resumeTaskAfterDurableWait).not.toHaveBeenCalled();

    const restarted = daemonLike("paused");
    const restartedId = await AgentDaemon.prototype.openPactAuthorizationWait.call(
      restarted.daemon,
      "task-1",
      view,
    );
    restarted.daemon.livePactAuthorizationWaits.clear(); // as after a restart
    await restarted.daemon.settlePactAuthorizationWait(restartedId, "denied", "The user declined.");
    expect(restarted.daemon.inputRequestRepo.__store.get(restartedId).status).toBe("dismissed");
    expect(restarted.daemon.resumeTaskAfterDurableWait).toHaveBeenCalledWith(
      "task-1",
      expect.stringContaining("denied"),
    );
  });

  it("refuses a second wait while another input is pending", async () => {
    const { daemon } = daemonLike();
    await AgentDaemon.prototype.openPactAuthorizationWait.call(daemon, "task-1", view);
    await expect(
      AgentDaemon.prototype.openPactAuthorizationWait.call(daemon, "task-1", view),
    ).rejects.toThrow(/pending/);
  });
});

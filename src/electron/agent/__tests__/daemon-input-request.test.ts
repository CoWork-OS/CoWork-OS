import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import type { Task } from "../../../shared/types";

function createInMemoryInputRequestRepo(requestId: string) {
  const store = new Map<string, Any>();
  return {
    create: vi.fn((request: Any) => {
      const created = { id: requestId, ...request };
      store.set(requestId, created);
      return created;
    }),
    findPendingByTaskId: vi.fn((taskId: string) =>
      Array.from(store.values()).filter(
        (item) => item.taskId === taskId && item.status === "pending",
      ),
    ),
    findById: vi.fn((id: string) => store.get(id)),
    resolve: vi.fn((id: string, status: "submitted" | "dismissed", answers?: Any) => {
      const existing = store.get(id);
      if (!existing || existing.status !== "pending") return;
      store.set(id, {
        ...existing,
        status,
        answers,
        resolvedAt: Date.now(),
      });
    }),
    list: vi.fn(),
    __store: store,
  };
}

describe("AgentDaemon structured input requests", () => {
  it("creates a pending input request and resolves it on submit", async () => {
    const repo = createInMemoryInputRequestRepo("req-submit-1");
    const taskRepo = {
      findById: vi.fn().mockReturnValue({ id: "task-1", status: "paused" } satisfies Partial<Task>),
    };
    const daemonLike = {
      inputRequestRepo: repo,
      taskRepo,
      pendingInputRequests: new Map(),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
      sendMessage: vi.fn(),
    } as Any;

    const requestPromise = AgentDaemon.prototype.requestUserInput.call(daemonLike, "task-1", {
      questions: [
        {
          header: "Mode",
          id: "delivery_mode",
          question: "How should this be delivered?",
          options: [
            { label: "Desktop + API (Recommended)", description: "Keep parity." },
            { label: "Desktop only", description: "Ship UI first." },
          ],
        },
      ],
    });

    expect(daemonLike.updateTask).toHaveBeenCalledWith("task-1", {
      status: "paused",
      terminalStatus: "needs_user_action",
      failureClass: undefined,
    });
    expect(repo.create).toHaveBeenCalled();

    const response = await AgentDaemon.prototype.respondToInputRequest.call(daemonLike, {
      requestId: "req-submit-1",
      status: "submitted",
      answers: { delivery_mode: { optionLabel: "Desktop + API (Recommended)" } },
    });

    expect(response).toEqual({ status: "handled", requestId: "req-submit-1" });
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "assistant_message",
      expect.objectContaining({
        message: expect.stringContaining("User selected structured input options:"),
      }),
    );
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-1",
      "assistant_message",
      expect.objectContaining({
        message: expect.stringContaining("- Mode: Desktop + API (Recommended)"),
      }),
    );
    await expect(requestPromise).resolves.toEqual(
      expect.objectContaining({ status: "submitted", requestId: "req-submit-1" }),
    );
  });

  it("rejects the waiting promise when input request is dismissed", async () => {
    const repo = createInMemoryInputRequestRepo("req-dismiss-1");
    const taskRepo = {
      findById: vi.fn().mockReturnValue({ id: "task-2", status: "paused" } satisfies Partial<Task>),
    };
    const daemonLike = {
      inputRequestRepo: repo,
      taskRepo,
      pendingInputRequests: new Map(),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
      sendMessage: vi.fn(),
    } as Any;

    const requestPromise = AgentDaemon.prototype.requestUserInput.call(daemonLike, "task-2", {
      questions: [
        {
          header: "Scope",
          id: "scope_choice",
          question: "Select scope",
          options: [
            { label: "Wide (Recommended)", description: "Cover all surfaces." },
            { label: "Narrow", description: "Only desktop." },
          ],
        },
      ],
    });

    const response = await AgentDaemon.prototype.respondToInputRequest.call(daemonLike, {
      requestId: "req-dismiss-1",
      status: "dismissed",
    });

    expect(response).toEqual({ status: "handled", requestId: "req-dismiss-1" });
    await expect(requestPromise).rejects.toThrow(/dismissed/i);
  });

  it("does not update task status or replay input when task is already terminal", async () => {
    const repo = createInMemoryInputRequestRepo("req-terminal-1");
    const daemonLike = {
      inputRequestRepo: repo,
      taskRepo: {
        findById: vi
          .fn()
          .mockReturnValue({ id: "task-3", status: "cancelled" } satisfies Partial<Task>),
      },
      pendingInputRequests: new Map(),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
      sendMessage: vi.fn(),
    } as Any;

    const requestPromise = AgentDaemon.prototype.requestUserInput.call(daemonLike, "task-3", {
      questions: [
        {
          header: "Scope",
          id: "scope_choice",
          question: "Select scope",
          options: [
            { label: "Wide (Recommended)", description: "Cover all surfaces." },
            { label: "Narrow", description: "Only desktop." },
          ],
        },
      ],
    });

    const response = await AgentDaemon.prototype.respondToInputRequest.call(daemonLike, {
      requestId: "req-terminal-1",
      status: "submitted",
      answers: { scope_choice: { optionLabel: "Narrow" } },
    });

    expect(response).toEqual({ status: "handled", requestId: "req-terminal-1" });
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-3",
      "input_request_resolved",
      expect.objectContaining({
        requestId: "req-terminal-1",
        status: "submitted",
        terminalTask: true,
      }),
    );
    expect(daemonLike.updateTask).toHaveBeenCalledTimes(1);
    expect(daemonLike.updateTask).toHaveBeenCalledWith("task-3", {
      status: "paused",
      terminalStatus: "needs_user_action",
      failureClass: undefined,
    });
    expect(daemonLike.sendMessage).not.toHaveBeenCalled();
    await expect(requestPromise).rejects.toThrow(/already terminal/i);
  });

  it("replays a submitted durable input request through task recovery after restart", async () => {
    const repo = createInMemoryInputRequestRepo("req-restart-1");
    repo.__store.set("req-restart-1", {
      id: "req-restart-1",
      taskId: "task-restart",
      questions: [],
      status: "pending",
      requestedAt: Date.now(),
    });
    const daemonLike = {
      inputRequestRepo: repo,
      taskRepo: {
        findById: vi.fn().mockReturnValue({ id: "task-restart", status: "paused" }),
      },
      pendingInputRequests: new Map(),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
      resumeTaskAfterDurableWait: vi.fn().mockResolvedValue(undefined),
    } as Any;

    const response = await AgentDaemon.prototype.respondToInputRequest.call(daemonLike, {
      requestId: "req-restart-1",
      status: "submitted",
      answers: { choice: { optionLabel: "Continue" } },
    });

    expect(response).toEqual({ status: "handled", requestId: "req-restart-1" });
    expect(daemonLike.resumeTaskAfterDurableWait).toHaveBeenCalledWith(
      "task-restart",
      expect.stringContaining("Structured input response for request req-restart-1"),
    );
  });

  it("rehydrates pending approval and input rows into visible task wait states", () => {
    const daemonLike = {
      approvalRepo: {
        findPending: vi
          .fn()
          .mockReturnValue([{ id: "approval-1", taskId: "task-approval", status: "pending" }]),
      },
      inputRequestRepo: {
        list: vi
          .fn()
          .mockReturnValue([{ id: "request-1", taskId: "task-input", status: "pending" }]),
      },
      taskRepo: {
        findById: vi.fn((taskId: string) => ({
          id: taskId,
          status: "executing",
          terminalStatus: undefined,
        })),
        update: vi.fn(),
      },
      logEvent: vi.fn(),
    } as Any;

    AgentDaemon.prototype["reconcileDurableWaitsOnStartup"].call(daemonLike);

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-approval",
      expect.objectContaining({ status: "blocked", terminalStatus: "awaiting_approval" }),
    );
    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-input",
      expect.objectContaining({ status: "paused", terminalStatus: "needs_user_action" }),
    );
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-approval",
      "approval_wait_rehydrated",
      expect.anything(),
    );
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-input",
      "input_wait_rehydrated",
      expect.anything(),
    );
  });

  it("requeues verification-gated tasks after a restart", () => {
    const daemonLike = {
      taskRepo: {
        findByStatus: vi.fn().mockReturnValue([
          {
            id: "task-verification",
            status: "blocked",
            terminalStatus: "awaiting_verification",
          },
        ]),
        findById: vi.fn(),
        update: vi.fn(),
      },
      approvalRepo: { findPending: vi.fn().mockReturnValue([]) },
      inputRequestRepo: { list: vi.fn().mockReturnValue([]) },
      logEvent: vi.fn(),
    } as Any;

    AgentDaemon.prototype["reconcileDurableWaitsOnStartup"].call(daemonLike);

    expect(daemonLike.taskRepo.update).toHaveBeenCalledWith(
      "task-verification",
      expect.objectContaining({ status: "interrupted", terminalStatus: undefined }),
    );
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-verification",
      "verification_wait_rehydrated",
      expect.anything(),
    );
  });
});

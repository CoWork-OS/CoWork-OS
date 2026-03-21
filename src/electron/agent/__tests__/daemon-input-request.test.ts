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
      Array.from(store.values()).filter((item) => item.taskId === taskId && item.status === "pending"),
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
      findById: vi
        .fn()
        .mockReturnValue({ id: "task-1", status: "paused" } satisfies Partial<Task>),
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

    expect(daemonLike.updateTask).toHaveBeenCalledWith("task-1", { status: "paused", terminalStatus: "needs_user_action", failureClass: undefined });
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
      findById: vi
        .fn()
        .mockReturnValue({ id: "task-2", status: "paused" } satisfies Partial<Task>),
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
    expect(daemonLike.updateTask).toHaveBeenCalledWith("task-3", { status: "paused", terminalStatus: "needs_user_action", failureClass: undefined });
    expect(daemonLike.sendMessage).not.toHaveBeenCalled();
    await expect(requestPromise).rejects.toThrow(/already terminal/i);
  });
});

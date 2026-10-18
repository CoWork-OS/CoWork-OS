import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp") } }));

/** The calls running when a task is stopped are reported, and open ones become unknown. */
describe("stop report", () => {
  function daemonWithAttempts(attempts: unknown[], closed: unknown[]) {
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      orchestrationGraphEngine: { cancelRunForRootTask: vi.fn().mockResolvedValue(undefined) },
      cancelTaskRecord: vi.fn(),
      logEvent: vi.fn(),
      finishQueueSlot: vi.fn(),
      pendingTaskImages: new Map(),
      taskRepo: { findByParent: vi.fn().mockReturnValue([]) },
      getToolAttemptRepository: () => ({
        markStartedUnknown: vi.fn().mockResolvedValue(closed),
        listForTask: vi.fn().mockResolvedValue(attempts),
      }),
    }) as Any;
    return daemon;
  }

  it("lists the call in flight with an unknown outcome and names it in the reason", async () => {
    const inFlight = {
      id: "attempt-1",
      taskId: "task-1",
      toolName: "write_file",
      argsHash: "h",
      idempotencyKey: "key-1",
      effect: "write",
      target: "report.md",
      status: "unknown",
      reason: "stopped_while_running",
      startedAt: 100,
      finishedAt: 300,
    };
    const finishedEarlier = {
      ...inFlight,
      id: "attempt-0",
      startedAt: 10,
      finishedAt: 50,
      status: "completed",
    };
    const daemon = daemonWithAttempts([finishedEarlier, inFlight], [inFlight]);

    await daemon.settleRunningTaskCancellation("task-1", {
      message: "Task was stopped by user",
      actor: "user",
      requestedAt: 200,
    });

    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "agent_interrupt_confirmed",
      expect.objectContaining({
        inFlight: [
          {
            toolName: "write_file",
            attemptId: "attempt-1",
            idempotencyKey: "key-1",
            effect: "write",
            outcome: "unknown",
            target: "report.md",
          },
        ],
      }),
    );
    expect(daemon.cancelTaskRecord).toHaveBeenCalledWith(
      "task-1",
      "Task was stopped by user. 1 call was in flight and not verified: write_file on report.md",
    );
  });

  it("keeps the plain confirmation when nothing was running", async () => {
    const daemon = daemonWithAttempts([], []);
    await daemon.settleRunningTaskCancellation("task-1", {
      message: "Task was stopped by user",
      actor: "user",
      requestedAt: 200,
    });
    const payload = daemon.logEvent.mock.calls.find(
      (call: unknown[]) => call[1] === "agent_interrupt_confirmed",
    )[2];
    expect(payload.inFlight).toBeUndefined();
    expect(daemon.cancelTaskRecord).toHaveBeenCalledWith("task-1", "Task was stopped by user");
  });
});

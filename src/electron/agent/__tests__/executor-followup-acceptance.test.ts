import { describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor";

type AcceptanceHarness = {
  executor: Any;
  runtime: Any;
  message: Any;
  callOrder: string[];
  snapshots: Any[];
};

function createAcceptanceHarness(snapshotResults: boolean[]): AcceptanceHarness {
  const callOrder: string[] = [];
  const snapshots: Any[] = [];
  const message = {
    message: "Inspect the attached report",
    messageId: "follow-up-1",
    deliveryMode: "message",
    messageSource: "agent",
    images: [{ data: "ZmFrZQ==", mimeType: "image/png", filename: "report.png" }],
    quotedAssistantMessage: { eventId: "assistant-1", message: "Earlier context" },
  };
  const history: Any[] = [
    { role: "assistant", content: "Previous response" },
    { role: "user", content: "Previous user input" },
    { role: "user", content: message.message },
  ];
  const pendingFollowUps: Any[] = [message];
  const consumed = new Set<string>();

  const executor = Object.create(TaskExecutor.prototype) as Any;
  const runtime = {
    state: {
      transcript: { conversationHistory: history },
      queues: { pendingFollowUps, consumedFollowUpMessageIds: consumed },
    },
    markFollowUpMessageConsumed: vi.fn((messageId: string) => {
      callOrder.push("mark-consumed");
      consumed.add(messageId);
    }),
    hasPendingFollowUpMessage: vi.fn((messageId: string) =>
      pendingFollowUps.some((item) => item.messageId === messageId),
    ),
    unmarkFollowUpMessageConsumed: vi.fn((messageId: string) => {
      callOrder.push("unmark-consumed");
      consumed.delete(messageId);
    }),
    removeFollowUpAtTurnBoundary: vi.fn((messageId: string) => {
      callOrder.push("remove-pending");
      const index = pendingFollowUps.findIndex((item) => item.messageId === messageId);
      if (index < 0) return false;
      pendingFollowUps.splice(index, 1);
      return true;
    }),
    updateConversationHistory: vi.fn((nextHistory: Any[]) => {
      runtime.state.transcript.conversationHistory = nextHistory;
    }),
    requeueFollowUpAtTurnBoundary: vi.fn((followUp: Any) => {
      callOrder.push("requeue");
      if (!pendingFollowUps.some((item) => item.messageId === followUp.messageId)) {
        pendingFollowUps.unshift(followUp);
      }
      return executor.saveConversationSnapshot();
    }),
  };
  executor.getSessionRuntime = vi.fn(() => runtime);
  executor.saveConversationSnapshot = vi.fn(() => {
    callOrder.push("snapshot");
    snapshots.push({
      history: runtime.state.transcript.conversationHistory.map((item: Any) => ({ ...item })),
      pending: [...runtime.state.queues.pendingFollowUps],
      consumed: [...runtime.state.queues.consumedFollowUpMessageIds],
    });
    return snapshotResults.shift() ?? true;
  });

  return { executor, runtime, message, callOrder, snapshots };
}

describe("TaskExecutor queued follow-up acceptance", () => {
  it("rolls back before requeueing when the acceptance snapshot fails", async () => {
    const harness = createAcceptanceHarness([false, true]);
    const { executor, runtime, message, callOrder, snapshots } = harness;
    const messages = runtime.state.transcript.conversationHistory;

    await expect(
      (TaskExecutor.prototype as Any).persistFollowUpAcceptance.call(
        executor,
        message.messageId,
        vi.fn(),
        () =>
          (TaskExecutor.prototype as Any).rollbackLastFollowUpIncorporation.call(
            executor,
            messages,
          ),
        message,
      ),
    ).rejects.toThrow(/could not be durably incorporated/i);

    expect(runtime.unmarkFollowUpMessageConsumed).toHaveBeenCalledWith(message.messageId);
    expect(runtime.requeueFollowUpAtTurnBoundary).toHaveBeenCalledWith(message);
    expect(callOrder.indexOf("unmark-consumed")).toBeLessThan(callOrder.indexOf("requeue"));
    expect(callOrder.indexOf("requeue")).toBeLessThan(callOrder.lastIndexOf("snapshot"));
    expect(runtime.state.queues.consumedFollowUpMessageIds).not.toContain(message.messageId);
    expect(runtime.state.queues.pendingFollowUps).toEqual([message]);
    // The previous user turn survives; only the attempted incorporation is removed.
    expect(runtime.state.transcript.conversationHistory).toEqual([
      { role: "assistant", content: "Previous response" },
      { role: "user", content: "Previous user input" },
    ]);
    expect(snapshots.at(-1)).toMatchObject({
      pending: [message],
      consumed: [],
      history: [
        { role: "assistant", content: "Previous response" },
        { role: "user", content: "Previous user input" },
      ],
    });
  });

  it("keeps the consumed marker when the receipt callback fails after the snapshot", async () => {
    const harness = createAcceptanceHarness([true]);
    const { executor, runtime, message, snapshots } = harness;
    const onAccepted = vi.fn(async () => {
      throw new Error("receipt update unavailable");
    });
    const onPreAcceptanceFailure = vi.fn();

    await expect(
      (TaskExecutor.prototype as Any).persistFollowUpAcceptance.call(
        executor,
        message.messageId,
        onAccepted,
        onPreAcceptanceFailure,
        message,
      ),
    ).rejects.toThrow("receipt update unavailable");

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onPreAcceptanceFailure).not.toHaveBeenCalled();
    expect(runtime.state.queues.consumedFollowUpMessageIds).toContain(message.messageId);
    expect(runtime.state.queues.pendingFollowUps).toEqual([message]);
    expect(runtime.requeueFollowUpAtTurnBoundary).not.toHaveBeenCalled();
    expect(runtime.removeFollowUpAtTurnBoundary).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(1);
    // The first acceptance snapshot retains the full payload while the
    // consumed marker suppresses a second provider dispatch.
    expect(snapshots[0]).toMatchObject({
      pending: [message],
      consumed: [message.messageId],
    });
  });

  it("keeps the full payload pending during the receipt callback, then removes it", async () => {
    const harness = createAcceptanceHarness([true, true]);
    const { executor, runtime, message, snapshots } = harness;
    const onAccepted = vi.fn(async () => {
      expect(runtime.state.queues.pendingFollowUps).toEqual([message]);
      expect(runtime.state.queues.consumedFollowUpMessageIds).toContain(message.messageId);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        pending: [message],
        consumed: [message.messageId],
      });
    });

    await (TaskExecutor.prototype as Any).persistFollowUpAcceptance.call(
      executor,
      message.messageId,
      onAccepted,
      undefined,
      message,
    );

    expect(runtime.removeFollowUpAtTurnBoundary).toHaveBeenCalledWith(message.messageId);
    expect(runtime.state.queues.pendingFollowUps).toEqual([]);
    expect(runtime.state.queues.consumedFollowUpMessageIds).toContain(message.messageId);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({
      pending: [],
      consumed: [message.messageId],
    });
  });

  it("retries an accepted receipt under the mutex without replaying the provider turn", async () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const onAccepted = vi.fn(async () => undefined);
    const runtime = {
      isFollowUpMessageConsumed: vi.fn().mockReturnValue(true),
      removeFollowUpAtTurnBoundary: vi.fn(),
      saveSnapshot: vi.fn(),
    };
    executor.task = { id: "task-1" };
    executor.daemon = { getTask: vi.fn().mockReturnValue(undefined) };
    executor.getSessionRuntime = vi.fn(() => runtime);
    executor.getLifecycleMutex = vi.fn(() => ({
      runExclusive: async (operation: () => Promise<void>) => operation(),
    }));
    executor.sendMessageUnlocked = vi.fn(async () => undefined);

    await executor.sendMessage("already incorporated", undefined, undefined, {
      messageId: "follow-up-1",
      onAccepted,
    });

    expect(runtime.isFollowUpMessageConsumed).toHaveBeenCalledWith("follow-up-1");
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(runtime.removeFollowUpAtTurnBoundary).toHaveBeenCalledWith("follow-up-1");
    expect(runtime.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(executor.sendMessageUnlocked).not.toHaveBeenCalled();
  });
});

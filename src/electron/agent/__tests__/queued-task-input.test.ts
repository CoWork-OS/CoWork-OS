import { describe, expect, it, vi } from "vitest";
import { editQueuedFollowUp, listQueuedTaskInputs } from "../queued-task-input";
import type { Task, TaskEvent } from "../../../shared/types";
import type { SessionRuntime } from "../runtime/SessionRuntime";

function setup(payload = {}) {
  const receipt = {
    id: "event-1",
    taskId: "task-1",
    type: "user_message",
    timestamp: 1,
    payload: {
      messageId: "message-1",
      message: "old",
      deliveryMode: "follow_up",
      deliveryStatus: "queued",
      messageSource: "user",
      ...payload,
    },
  } as TaskEvent;
  const pending = {
    messageId: "message-1",
    message: "old",
    images: [{ id: "attachment" }],
    quotedAssistantMessage: { message: "quote" },
  };
  const runtime = {
    state: { queues: { pendingFollowUps: [pending] } },
    isFollowUpMessageConsumed: vi.fn(() => false),
    saveSnapshot: vi.fn(() => true),
  } as unknown as SessionRuntime;
  const input = {
    taskId: "task-1",
    id: "message-1",
    kind: "follow_up" as const,
    expectedMessage: "old",
    expectedRevision: 0,
    message: "new",
  };
  return { receipt, pending, runtime, input };
}

describe("server-owned queued inputs", () => {
  it("refuses edits whose text could be truncated in the recovery receipt", () => {
    const { receipt, runtime, input } = setup();
    expect(() =>
      editQueuedFollowUp({ ...input, message: "x".repeat(60_001) }, [receipt], runtime, vi.fn()),
    ).toThrow(/60,000/);
    const task = { status: "executing" } as Task;
    expect(
      listQueuedTaskInputs(task, false, [
        { ...receipt, payload: { ...receipt.payload, message: "x".repeat(60_001) } },
      ]),
    ).toEqual([]);
  });
  it("reads canonical timeline receipts through their legacy type", () => {
    const { receipt, runtime, input } = setup();
    const canonical = {
      ...receipt,
      type: "timeline_step_updated",
      legacyType: "user_message",
      payload: { ...receipt.payload, legacyType: "user_message" },
    } as TaskEvent;
    expect(editQueuedFollowUp(input, [canonical], runtime, vi.fn()).message).toBe("new");
  });
  it("updates the same queued object and preserves attachments and quote", () => {
    const { receipt, pending, runtime, input } = setup();
    const persist = vi.fn();
    expect(editQueuedFollowUp(input, [receipt], runtime, persist)).toMatchObject({
      message: "new",
      revision: 1,
    });
    expect(runtime.state.queues.pendingFollowUps[0]).toBe(pending);
    expect(pending).toMatchObject({
      message: "new",
      images: [{ id: "attachment" }],
      quotedAssistantMessage: { message: "quote" },
    });
    expect(persist.mock.calls[0][0].payload).toMatchObject({
      message: "new",
      deliveryStatus: "queued",
    });
  });
  it.each(["started", "accepted", "delivered"])(
    "refuses an edit after receipt becomes %s",
    (status) => {
      const { receipt, runtime, input } = setup({ deliveryStatus: status });
      const persist = vi.fn();
      expect(() => editQueuedFollowUp(input, [receipt], runtime, persist)).toThrow(
        /already started/,
      );
      expect(persist).not.toHaveBeenCalled();
    },
  );
  it("rejects a stale save from a second window", () => {
    const { receipt, runtime, input } = setup({ queuedEditRevision: 1 });
    expect(() => editQueuedFollowUp(input, [receipt], runtime, vi.fn())).toThrow(/another window/);
  });
  it("does not edit an item already consumed while its receipt is catching up", () => {
    const { receipt, runtime, input } = setup();
    vi.mocked(runtime.isFollowUpMessageConsumed).mockReturnValue(true);
    expect(() => editQueuedFollowUp(input, [receipt], runtime, vi.fn())).toThrow(/already started/);
  });
  it("does not mutate runtime text if receipt persistence fails", () => {
    const { receipt, pending, runtime, input } = setup();
    expect(() =>
      editQueuedFollowUp(input, [receipt], runtime, () => {
        throw new Error("disk unavailable");
      }),
    ).toThrow("disk unavailable");
    expect(pending.message).toBe("old");
  });
  it("can edit a durable waiting receipt when its runtime was evicted", () => {
    const { receipt, input } = setup();
    expect(editQueuedFollowUp(input, [receipt], undefined, vi.fn()).message).toBe("new");
  });
  it("lists only human waiting inputs and exposes the initial prompt only while queued", () => {
    const { receipt, runtime } = setup();
    const task = { id: "task-1", status: "executing", prompt: "initial", updatedAt: 1 } as Task;
    expect(listQueuedTaskInputs(task, false, [receipt], runtime)).toHaveLength(1);
    expect(
      listQueuedTaskInputs(
        task,
        false,
        [{ ...receipt, payload: { ...receipt.payload, messageSource: "agent" } }],
        runtime,
      ),
    ).toEqual([]);
    expect(listQueuedTaskInputs({ ...task, status: "queued" }, true, [receipt])[0]).toMatchObject({
      kind: "initial",
      message: "initial",
    });
    expect(listQueuedTaskInputs({ ...task, status: "cancelled" }, false, [receipt])).toEqual([]);
  });
});

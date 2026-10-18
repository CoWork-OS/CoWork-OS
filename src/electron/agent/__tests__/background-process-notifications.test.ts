import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import {
  canReceiveBackgroundCompletion,
  isFreshAgentHandoff,
  pendingBackgroundCompletionNotices,
} from "../background-process-notifications";
import { AgentDaemon } from "../daemon";

const task = { id: "task-1", source: "manual", status: "executing" } as Task;
describe("background completion delivery eligibility", () => {
  it("keeps process output in the existing conversation without treating it as a new bot handoff", () => {
    expect(
      isFreshAgentHandoff({ messageSource: "agent", notificationKind: "background_process" }),
    ).toBe(false);
    expect(isFreshAgentHandoff({ messageSource: "agent" })).toBe(true);
  });
  function harness(status: Task["status"] = "executing") {
    let current = { ...task, status };
    const events: Any[] = [];
    const work: Promise<unknown>[] = [];
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: { findById: () => current },
      canReceiveBackgroundProcessCompletion: () => canReceiveBackgroundCompletion(current),
      eventRepo: {
        findByTaskIdAndTypes: (_id: string, types: string[]) =>
          events.filter((e) => types.includes(e.type)),
      },
      getExecutorForTask: () => undefined,
      getExistingUserFollowUpResult: vi.fn(() => null),
      sendMessage: vi.fn(
        async (_id: string, _message: string, _images: unknown, _quoted: unknown, options: Any) => {
          options.admissionGuard();
          return { queued: false };
        },
      ),
      timelineRowsCommitted: vi.fn(async () => undefined),
      trackBackgroundWork: (promise: Promise<unknown>) => {
        work.push(promise);
        return promise;
      },
      logEvent: (_id: string, type: string, payload: Any) => events.push({ type, payload }),
    });
    return {
      daemon,
      events,
      work,
      setStatus: (status: Task["status"]) => {
        current = { ...current, status };
      },
    };
  }
  it("sends an internally tagged completion and rechecks admission if cancellation wins", async () => {
    const h = harness();
    h.daemon.notifyBackgroundProcessCompletion(
      "task-1",
      { process_id: "bg-1", exit_code: 0 },
      "final output",
    );
    await Promise.all(h.work);
    const options = h.daemon.sendMessage.mock.calls[0][4];
    expect(options).toMatchObject({
      notificationKind: "background_process",
      messageSource: "agent",
      messageId: "background-exit-bg-1",
    });
    h.setStatus("cancelled");
    expect(() => options.admissionGuard()).toThrow(/no longer admitted/);
  });
  it.each(["paused", "blocked"] as const)(
    "retains output while %s and admits it once after resume",
    async (status) => {
      const h = harness(status);
      h.daemon.notifyBackgroundProcessCompletion(
        "task-1",
        { process_id: "bg-1", exit_code: 7 },
        "final output",
      );
      await Promise.all(h.work);
      expect(h.daemon.sendMessage).not.toHaveBeenCalled();
      expect(pendingBackgroundCompletionNotices(h.events)[0].message).toContain("final output");
      h.setStatus("executing");
      await Promise.all([
        h.daemon.flushBackgroundProcessCompletions("task-1"),
        h.daemon.flushBackgroundProcessCompletions("task-1"),
      ]);
      await h.daemon.flushBackgroundProcessCompletions("task-1");
      expect(h.daemon.sendMessage).toHaveBeenCalledTimes(1);
      expect(pendingBackgroundCompletionNotices(h.events)).toEqual([]);
    },
  );
  it("retains a notice rejected at admission and retries on a later lifecycle event", async () => {
    const h = harness();
    h.daemon.sendMessage.mockRejectedValueOnce(new Error("temporarily unavailable"));
    h.daemon.notifyBackgroundProcessCompletion(
      "task-1",
      { process_id: "bg-1", exit_code: 0 },
      "final output",
    );
    await Promise.all(h.work);
    expect(pendingBackgroundCompletionNotices(h.events)).toHaveLength(1);
    await h.daemon.flushBackgroundProcessCompletions("task-1");
    expect(h.daemon.sendMessage).toHaveBeenCalledTimes(2);
    expect(pendingBackgroundCompletionNotices(h.events)).toEqual([]);
  });
  it("recovers the outbox from journal events and honours cancellation tombstones", async () => {
    const h = harness("paused");
    h.daemon.notifyBackgroundProcessCompletion(
      "task-1",
      { process_id: "bg-1", exit_code: 0 },
      "final output",
    );
    await Promise.all(h.work);
    const recovered = harness();
    recovered.events.push(...JSON.parse(JSON.stringify(h.events)));
    await recovered.daemon.flushBackgroundProcessCompletions("task-1");
    expect(recovered.daemon.sendMessage).toHaveBeenCalledTimes(1);
    h.events.push({ type: "log", payload: { backgroundCompletionsCancelled: true } });
    h.setStatus("executing");
    await h.daemon.flushBackgroundProcessCompletions("task-1");
    expect(h.daemon.sendMessage).not.toHaveBeenCalled();
  });
  it("supports a native interactive root session across turn completion", () => {
    expect(canReceiveBackgroundCompletion(task)).toBe(true);
    expect(canReceiveBackgroundCompletion({ ...task, status: "completed" })).toBe(true);
  });
  it.each(["cron", "api", "hook", "improvement"] as const)("keeps %s work on polling", (source) => {
    expect(canReceiveBackgroundCompletion({ ...task, source })).toBe(false);
  });
  it.each(["cancelled", "failed", "interrupted", "paused", "blocked"] as const)(
    "does not wake %s work",
    (status) => {
      expect(canReceiveBackgroundCompletion({ ...task, status })).toBe(false);
    },
  );
  it("excludes one-shot CLI, child agents, archived sessions and shutdown", () => {
    expect(
      canReceiveBackgroundCompletion({
        ...task,
        agentConfig: { cli: { owner: "cowork-run" } },
      } as Task),
    ).toBe(false);
    expect(canReceiveBackgroundCompletion({ ...task, parentTaskId: "parent" })).toBe(false);
    expect(canReceiveBackgroundCompletion({ ...task, sessionArchived: true })).toBe(false);
    expect(canReceiveBackgroundCompletion(task, true)).toBe(false);
  });
});

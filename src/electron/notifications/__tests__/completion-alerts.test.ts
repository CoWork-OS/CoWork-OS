import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import type { CompletionNotificationMode, Task } from "../../../shared/types";
import {
  attachCompletionAlerts,
  completionAlertContent,
  createCompletionAlertDeduper,
  isCompletionAlertCandidate,
  wantsCompletionAlert,
} from "../completion-alerts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Draft the report",
    workspaceId: "ws-1",
    status: "completed",
    promptProvenance: "user_typed",
    source: "manual",
    ...overrides,
  } as Task;
}

describe("isCompletionAlertCandidate", () => {
  it("accepts a task the person typed and one started from a suggestion", () => {
    expect(isCompletionAlertCandidate(task())).toBe(true);
    expect(
      isCompletionAlertCandidate(task({ promptProvenance: undefined, source: "suggested_task" })),
    ).toBe(true);
  });

  it.each([
    ["a sub-agent", { parentTaskId: "parent" }],
    ["a parallel agent", { agentType: "parallel" as const }],
    ["a scheduled task", { source: "cron" as const }],
    ["a task nobody typed", { promptProvenance: undefined }],
    ["a bot conversation", { agentConfig: { botConversation: true } }],
    ["a channel task", { agentConfig: { originChannel: "whatsapp" } }],
    ["a group chat task", { agentConfig: { gatewayContext: "group" } }],
    ["a speculative fix worker", { agentConfig: { speculative: true } }],
  ])("skips %s", (_label, overrides) => {
    expect(isCompletionAlertCandidate(task(overrides as Partial<Task>))).toBe(false);
  });

  it("skips a missing task", () => {
    expect(isCompletionAlertCandidate(undefined)).toBe(false);
  });
});

describe("wantsCompletionAlert", () => {
  it.each<[CompletionNotificationMode, boolean, boolean]>([
    ["never", false, false],
    ["never", true, false],
    ["unfocused", false, true],
    ["unfocused", true, false],
    ["always", false, true],
    ["always", true, true],
  ])("mode %s with focus %s is %s", (mode, focused, expected) => {
    expect(wantsCompletionAlert(mode, focused)).toBe(expected);
  });
});

describe("completionAlertContent", () => {
  it("uses the result summary for a finished task", () => {
    expect(
      completionAlertContent(task(), "completed", { resultSummary: " Report saved. " }),
    ).toEqual({
      type: "task_completed",
      title: "Finished · Draft the report",
      message: "Report saved.",
    });
  });

  it("uses the error for a failed task and a plain line when there is none", () => {
    expect(completionAlertContent(task(), "failed", { error: "Rate limited" })).toMatchObject({
      type: "task_failed",
      title: "Failed · Draft the report",
      message: "Rate limited",
    });
    expect(completionAlertContent(task(), "failed", {}).message).toBe(
      "The task stopped before it finished.",
    );
  });

  it("shortens a long summary", () => {
    const content = completionAlertContent(task(), "completed", { resultSummary: "x".repeat(900) });
    expect(content.message.length).toBeLessThanOrEqual(240);
    expect(content.message.endsWith("…")).toBe(true);
  });
});

describe("createCompletionAlertDeduper", () => {
  it("drops a repeat for the same task inside the window only", () => {
    let time = 0;
    const first = createCompletionAlertDeduper(3_000, () => time);
    expect(first("a")).toBe(true);
    expect(first("a")).toBe(false);
    expect(first("b")).toBe(true);
    time = 3_000;
    expect(first("a")).toBe(true);
  });
});

describe("attachCompletionAlerts", () => {
  function setup(options: {
    mode?: CompletionNotificationMode;
    focused?: boolean;
    showNotifications?: boolean;
    tasks?: Record<string, Task>;
    routedElsewhere?: boolean;
  }) {
    const emitter = new EventEmitter();
    const notify = vi.fn(async () => undefined);
    const tasks = options.tasks ?? { "task-1": task() };
    attachCompletionAlerts({
      daemon: {
        on: (event, listener) => emitter.on(event, listener),
        getTask: (taskId) => tasks[taskId],
      },
      getSettings: () => ({
        showNotifications: options.showNotifications ?? true,
        completionNotifications: options.mode ?? "unfocused",
      }),
      isAppFocused: () => options.focused ?? false,
      isRoutedElsewhere: () => options.routedElsewhere ?? false,
      notify,
    });
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    return { emitter, notify, settle };
  }

  it("alerts when a task finishes while the app is in the background", async () => {
    const { emitter, notify, settle } = setup({});
    emitter.emit("task_completed", { taskId: "task-1", resultSummary: "Done and saved." });
    await settle();
    expect(notify).toHaveBeenCalledWith({
      type: "task_completed",
      title: "Finished · Draft the report",
      message: "Done and saved.",
      taskId: "task-1",
      workspaceId: "ws-1",
    });
  });

  it("stays quiet while the app has focus, unless set to always", async () => {
    const quiet = setup({ focused: true });
    quiet.emitter.emit("task_completed", { taskId: "task-1" });
    await quiet.settle();
    expect(quiet.notify).not.toHaveBeenCalled();

    const loud = setup({ focused: true, mode: "always" });
    loud.emitter.emit("follow_up_completed", { taskId: "task-1" });
    await loud.settle();
    expect(loud.notify).toHaveBeenCalledOnce();
  });

  it.each([
    ["the mode is never", { mode: "never" as const }],
    ["desktop alerts are off", { showNotifications: false }],
    ["a bot route delivers it", { routedElsewhere: true }],
    ["the task is a sub-agent", { tasks: { "task-1": task({ parentTaskId: "p" }) } }],
    ["the task is unknown", { tasks: {} }],
  ])("stays quiet when %s", async (_label, options) => {
    const { emitter, notify, settle } = setup(options);
    emitter.emit("task_completed", { taskId: "task-1" });
    await settle();
    expect(notify).not.toHaveBeenCalled();
  });

  it("alerts once when one completion arrives under two event names", async () => {
    const { emitter, notify, settle } = setup({});
    emitter.emit("task_completed", { taskId: "task-1" });
    emitter.emit("follow_up_completed", { taskId: "task-1" });
    await settle();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("reports a failure from a failed follow-up or a failed status", async () => {
    const followUp = setup({});
    followUp.emitter.emit("follow_up_failed", { taskId: "task-1", error: "Model unavailable" });
    await followUp.settle();
    expect(followUp.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "task_failed", message: "Model unavailable" }),
    );

    const status = setup({});
    status.emitter.emit("task_status", { taskId: "task-1", status: "executing" });
    status.emitter.emit("task_status", { taskId: "task-1", payload: { status: "failed" } });
    await status.settle();
    expect(status.notify).toHaveBeenCalledOnce();
    expect(status.notify).toHaveBeenCalledWith(expect.objectContaining({ type: "task_failed" }));
  });
});

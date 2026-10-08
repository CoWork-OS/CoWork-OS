import { describe, expect, it, vi } from "vitest";

import { AgentDaemon } from "../daemon";
import { TaskExecutor } from "../executor";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

const ROOT_ID = "root-task";

function createDaemonLike(options: {
  rootConfig?: Record<string, unknown>;
  runStatus?: string | null;
  children?: Array<{ id: string; status: string }>;
  runningChildIds?: string[];
  userMessages?: Array<Record<string, unknown>>;
}) {
  const root = {
    id: ROOT_ID,
    title: "Plan a workshop",
    prompt: "Plan a workshop for 40 people with a €250 cash budget.",
    status: "executing",
    agentConfig: options.rootConfig ?? { collaborativeMode: true },
  };
  const children = (options.children ?? []).map((child) => ({
    ...child,
    parentTaskId: ROOT_ID,
  }));
  const tickRun = vi.fn().mockResolvedValue(undefined);
  const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
    taskRepo: {
      findById: vi.fn((id: string) => (id === ROOT_ID ? root : undefined)),
      findByParent: vi.fn(() => children),
    },
    eventRepo: {
      findByTaskIdAndTypes: vi.fn(() =>
        (options.userMessages ?? []).map((payload, index) => ({
          id: `event-${index}`,
          taskId: ROOT_ID,
          type: "user_message",
          timestamp: index,
          payload,
        })),
      ),
    },
    activeTasks: new Map(
      (options.runningChildIds ?? []).map((id) => [
        id,
        { executor: { isRunning: true }, lastAccessed: 0, status: "active" },
      ]),
    ),
    teamOrchestrator: { tickRun },
    findTeamRunByRootTaskId: vi.fn(() =>
      options.runStatus ? { id: "run-1", status: options.runStatus } : null,
    ),
    sendMessage: vi.fn().mockResolvedValue({ queued: true }),
  }) as Any;
  return { daemon, root, tickRun };
}

describe("collaborative root follow-ups", () => {
  it("defers a root follow-up's completion while its team run is running", () => {
    const { daemon, tickRun } = createDaemonLike({
      runStatus: "running",
      children: [
        { id: "lane-1", status: "executing" },
        { id: "lane-2", status: "completed" },
      ],
    });

    expect(daemon.reconcileCollaborativeRunBeforeFollowUpCompletion(ROOT_ID)).toEqual({
      deferred: true,
      activeChildCount: 1,
    });
    expect(tickRun).toHaveBeenCalledWith("run-1", "root_follow_up_deferred");
  });

  it.each([
    ["the team run has finished", { runStatus: "completed" }],
    ["there is no team run", { runStatus: null }],
    ["the task is not collaborative", { runStatus: "running", rootConfig: {} }],
    [
      "the run belongs to the parent's own executor",
      {
        runStatus: "running",
        rootConfig: { collaborativeMode: true, childAgentCollaborativeRun: true },
      },
    ],
  ])("does not defer when %s", (_label, options) => {
    const { daemon } = createDaemonLike(options);
    expect(daemon.reconcileCollaborativeRunBeforeFollowUpCompletion(ROOT_ID).deferred).toBe(false);
  });

  it("forwards a root update only to team lanes that are running", () => {
    const { daemon, root } = createDaemonLike({
      runStatus: "running",
      children: [
        { id: "lane-running", status: "executing" },
        { id: "lane-not-started", status: "pending" },
        { id: "lane-done", status: "completed" },
      ],
      runningChildIds: ["lane-running", "lane-done"],
    });

    daemon.forwardRootFollowUpToActiveTeamLanes(
      root,
      "Cap attendance at 20 people and the cash budget at €150.",
      "msg-1",
    );

    expect(daemon.sendMessage).toHaveBeenCalledTimes(1);
    expect(daemon.sendMessage).toHaveBeenCalledWith(
      "lane-running",
      expect.stringContaining("Cap attendance at 20 people and the cash budget at €150."),
      undefined,
      undefined,
      { deliveryMode: "follow_up", messageSource: "user", messageId: "msg-1:lane:lane-running" },
    );
  });

  it("lists user follow-ups after the original request, once each", () => {
    const { daemon } = createDaemonLike({
      userMessages: [
        { message: "Plan a workshop for 40 people with a €250 cash budget." },
        { message: "Cap attendance at 20 people.", messageSource: "user", messageId: "m1" },
        { message: "Cap attendance at 20 people.", messageSource: "user", messageId: "m1" },
        { message: "Lane note", messageSource: "agent", messageId: "m2" },
        { message: "Direct message", deliveryMode: "message", messageId: "m3" },
        { message: "Budget is €150.", messageSource: "user", messageId: "m4" },
      ],
    });

    expect(daemon.listUserFollowUpMessages(ROOT_ID)).toEqual([
      "Cap attendance at 20 people.",
      "Budget is €150.",
    ]);
  });

  it("keeps the root executing instead of completing it while the team works", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { id: ROOT_ID, status: "executing" };
    executor.lastAssistantText = "Updated draft for 20 people and €150.";
    executor.getContentFallback = vi.fn(() => "");
    executor.emitEvent = vi.fn();
    executor.daemon = {
      reconcileCollaborativeRunBeforeFollowUpCompletion: vi.fn(() => ({
        deferred: true,
        activeChildCount: 3,
      })),
      updateTask: vi.fn(),
      updateTaskStatus: vi.fn(),
    };

    executor.finalizeFollowUpCompletion("Follow-up completed (status safety net)");

    expect(executor.task.status).toBe("executing");
    expect(executor.daemon.updateTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTaskStatus).toHaveBeenCalledWith(ROOT_ID, "executing");
    expect(executor.emitEvent).not.toHaveBeenCalledWith("task_completed", expect.anything());
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "task_status",
      expect.objectContaining({ status: "executing", collaborativeRunWaiting: true }),
    );
  });
});

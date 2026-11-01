import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import {
  backgroundCompletionDropReason,
  buildAgentCompletionNotice,
  canReceiveBackgroundCompletion,
  canRetainBackgroundCompletion,
  continuesAfterTurn,
  isFreshAgentHandoff,
  pendingBackgroundCompletionNotices,
  runningTurnUpdateText,
} from "../background-process-notifications";
import { AgentDaemon } from "../daemon";
import { isHeadlessMode } from "../../utils/runtime-mode";

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
      setTask: (fields: Partial<Task>) => {
        current = { ...current, ...fields };
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
  const sessions: Array<[string, Task]> = [
    ["gateway", { ...task, agentConfig: { gatewayContext: "private" } } as Task],
    ["bot", { ...task, agentConfig: { botConversation: true } } as Task],
    ["child", { ...task, parentTaskId: "parent", agentType: "sub" } as Task],
    ["API", { ...task, source: "api" } as Task],
    ["cron", { ...task, source: "cron" } as Task],
    ["hook", { ...task, source: "hook" } as Task],
    ["one-shot CLI", { ...task, agentConfig: { cli: { owner: "cowork-run" } } } as Task],
  ];
  it.each(sessions)("delivers to a running %s session at its next iteration", (_kind, session) => {
    expect(canReceiveBackgroundCompletion(session)).toBe(true);
    expect(canReceiveBackgroundCompletion({ ...session, status: "planning" })).toBe(true);
  });
  it("wakes a finished conversation but not a finished child, automation or one-shot run", () => {
    const completed = (session: Task) => ({ ...session, status: "completed" as const });
    const [gateway, bot, child, api, cron, hook, cli] = sessions.map(([, session]) => session);
    for (const conversation of [gateway, bot, api, hook]) {
      expect(canReceiveBackgroundCompletion(completed(conversation))).toBe(true);
      expect(continuesAfterTurn(conversation)).toBe(true);
    }
    for (const ended of [child, cron, cli]) {
      expect(canReceiveBackgroundCompletion(completed(ended))).toBe(false);
      expect(canRetainBackgroundCompletion(completed(ended))).toBe(false);
      expect(backgroundCompletionDropReason(completed(ended))).toBe("task_completed");
    }
  });
  it.each(["interrupted", "paused", "blocked"] as const)(
    "retains but does not wake %s work",
    (status) => {
      expect(canReceiveBackgroundCompletion({ ...task, status })).toBe(false);
      expect(canRetainBackgroundCompletion({ ...task, status })).toBe(true);
      expect(canRetainBackgroundCompletion({ ...task, status, parentTaskId: "parent" })).toBe(true);
    },
  );
  it.each(["cancelled", "failed"] as const)("drops completions for %s work", (status) => {
    expect(canReceiveBackgroundCompletion({ ...task, status })).toBe(false);
    expect(backgroundCompletionDropReason({ ...task, status })).toBe(`task_${status}`);
  });
  it("excludes archived sessions, external runtimes and shutdown", () => {
    expect(canReceiveBackgroundCompletion({ ...task, sessionArchived: true })).toBe(false);
    expect(
      canReceiveBackgroundCompletion({
        ...task,
        agentConfig: { externalRuntime: { kind: "acpx" } },
      } as unknown as Task),
    ).toBe(false);
    expect(canReceiveBackgroundCompletion(task, true)).toBe(false);
  });
  it("records a completion for a task that has ended and drops it with the reason", async () => {
    const h = harness("completed");
    h.setTask({ parentTaskId: "parent", agentType: "sub" });
    h.daemon.notifyBackgroundProcessCompletion(
      "task-1",
      { process_id: "bg-1", exit_code: 0 },
      "final output",
    );
    await Promise.all(h.work);
    expect(h.daemon.sendMessage).not.toHaveBeenCalled();
    expect(pendingBackgroundCompletionNotices(h.events)).toEqual([]);
    expect(h.events).toContainEqual({
      type: "log",
      payload: expect.objectContaining({
        backgroundCompletionId: "background-exit-bg-1",
        backgroundCompletionDropped: "task_completed",
        droppedCompletionMessage: expect.stringContaining("final output"),
      }),
    });
  });
  it("drops a retained completion once its paused child task ends", async () => {
    const h = harness("paused");
    h.setTask({ parentTaskId: "parent", agentType: "sub" });
    h.daemon.notifyBackgroundProcessCompletion(
      "task-1",
      { process_id: "bg-1", exit_code: 0 },
      "final output",
    );
    await Promise.all(h.work);
    expect(pendingBackgroundCompletionNotices(h.events)).toHaveLength(1);
    h.setStatus("completed");
    await h.daemon.flushBackgroundProcessCompletions("task-1");
    expect(h.daemon.sendMessage).not.toHaveBeenCalled();
    expect(pendingBackgroundCompletionNotices(h.events)).toEqual([]);
    expect(
      h.events.filter((event) => event.payload?.backgroundCompletionDropped === "task_completed"),
    ).toHaveLength(1);
  });
  describe("in a headless daemon run", () => {
    const previous = process.env.COWORK_HEADLESS;
    beforeEach(() => {
      process.env.COWORK_HEADLESS = "1";
    });
    afterEach(() => {
      if (previous === undefined) delete process.env.COWORK_HEADLESS;
      else process.env.COWORK_HEADLESS = previous;
    });
    it("delivers the completion as a follow-up", async () => {
      expect(isHeadlessMode()).toBe(true);
      const h = harness();
      // The real eligibility check, as src/daemon/main.ts runs it.
      delete (h.daemon as Any).canReceiveBackgroundProcessCompletion;
      h.daemon.hasPendingUserDecisionForTask = () => false;
      h.daemon.shutdownRequested = false;
      h.daemon.notifyBackgroundProcessCompletion(
        "task-1",
        { process_id: "bg-1", exit_code: 0 },
        "final output",
      );
      await Promise.all(h.work);
      expect(h.daemon.sendMessage).toHaveBeenCalledTimes(1);
      expect(h.daemon.sendMessage.mock.calls[0][4]).toMatchObject({
        notificationKind: "background_process",
        messageSource: "agent",
      });
    });
  });
});

describe("spawned agent completion delivery", () => {
  function agentHarness(
    run: Record<string, unknown> = {
      kind: "delegation",
      rootTaskId: "task-1",
      metadata: { createdBy: "spawn_agent" },
    },
  ) {
    const h = (() => {
      const events: Any[] = [];
      const work: Promise<unknown>[] = [];
      const tasks = new Map<string, Task>([
        ["task-1", { ...task }],
        [
          "child-1",
          {
            ...task,
            id: "child-1",
            title: "Check the parser",
            parentTaskId: "task-1",
            status: "completed",
            resultSummary: "Parser handles all 12 fixtures.",
          } as Task,
        ],
      ]);
      const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
        taskRepo: { findById: (id: string) => tasks.get(id) },
        canReceiveBackgroundProcessCompletion: (id: string) =>
          canReceiveBackgroundCompletion(tasks.get(id)),
        eventRepo: {
          findByTaskIdAndTypes: (_id: string, types: string[]) =>
            events.filter((e) => types.includes(e.type)),
        },
        getOrchestrationGraphRepository: () => ({
          findSnapshotByRunId: async () => ({
            run,
            nodes: [
              {
                id: "node-1",
                title: "Check the parser",
                workerRole: "verifier",
                parentTaskId: "task-1",
              },
            ],
          }),
        }),
        getExecutorForTask: () => undefined,
        getExistingUserFollowUpResult: vi.fn(() => null),
        sendMessage: vi.fn(
          async (
            _id: string,
            _message: string,
            _images: unknown,
            _quoted: unknown,
            options: Any,
          ) => {
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
      return { daemon, events, work, tasks };
    })();
    const notify = async (notification: Record<string, unknown>) => {
      await h.daemon.notifySpawnedAgentCompletion({
        runId: "run-1",
        nodeId: "node-1",
        taskId: "child-1",
        publicHandle: "child-1",
        target: "local_task",
        summary: "Parser handles all 12 fixtures.",
        ...notification,
      });
      await Promise.all(h.work);
    };
    return { ...h, notify };
  }

  it("pushes the child's result to the parent as agent output, not user input", async () => {
    const h = agentHarness();
    await h.notify({ status: "completed" });
    expect(h.daemon.sendMessage).toHaveBeenCalledTimes(1);
    const [parentId, message, , , options] = h.daemon.sendMessage.mock.calls[0];
    expect(parentId).toBe("task-1");
    expect(options).toMatchObject({
      messageSource: "agent",
      notificationKind: "agent_output",
      messageId: "agent-result-child-1",
      deliveryMode: "follow_up",
    });
    expect(options.senderLabel).toContain("Check the parser");
    expect(isFreshAgentHandoff(options)).toBe(false);
    expect(message).toContain("(task child-1) finished with status completed");
    expect(message).toContain("Parser handles all 12 fixtures.");
    expect(message).toContain("not new user instructions");
    expect(h.events).toContainEqual({
      type: "agent_completed",
      payload: expect.objectContaining({ childTaskId: "child-1", childStatus: "completed" }),
    });
    expect(pendingBackgroundCompletionNotices(h.events)).toEqual([]);
  });

  it("adds a one-line error when the child failed", async () => {
    const h = agentHarness();
    h.tasks.set("child-1", { ...h.tasks.get("child-1")!, status: "failed", resultSummary: "" });
    await h.notify({ status: "failed", summary: "", error: "Build broke\n  at step 3\n" });
    const message: string = h.daemon.sendMessage.mock.calls[0][1];
    expect(message).toContain("finished with status failed");
    expect(message).toContain("Error: Build broke at step 3");
    expect(h.events.some((event) => event.type === "agent_failed")).toBe(true);
  });

  it("delivers once even when the node is reported twice", async () => {
    const h = agentHarness();
    await h.notify({ status: "completed" });
    await h.notify({ status: "completed" });
    expect(h.daemon.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "orchestrate_agents runs",
      { kind: "delegation", metadata: { createdBy: "orchestrate_agents" } },
    ],
    [
      "spawn_agent wait: true",
      { kind: "delegation", metadata: { createdBy: "spawn_agent", resultDelivery: "inline" } },
    ],
    ["team runs", { kind: "team", metadata: { createdBy: "spawn_agent" } }],
  ])("leaves %s to their own tool result", async (_name, run) => {
    const h = agentHarness({ rootTaskId: "task-1", ...run });
    await h.notify({ status: "completed" });
    expect(h.daemon.sendMessage).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("ignores a node that only started running", async () => {
    const h = agentHarness();
    await h.notify({ status: "running" });
    expect(h.daemon.sendMessage).not.toHaveBeenCalled();
  });

  it("builds a bounded notice", () => {
    const notice = buildAgentCompletionNotice({
      handle: "child-9",
      label: "Scout",
      status: "completed",
      resultSummary: "x".repeat(20_000),
    });
    expect(notice).toMatchObject({ id: "agent-result-child-9", kind: "agent_output" });
    expect(notice.message.length).toBeLessThan(13_000);
    expect(notice.message).toContain("[result truncated]");
  });

  it("tells the model a runtime notice is not a user update", () => {
    expect(runningTurnUpdateText({ message: "done", notificationKind: "agent_output" })).toBe(
      "RUNTIME NOTICE: done",
    );
    expect(runningTurnUpdateText({ message: "hi" })).toBe("USER UPDATE: hi");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeculativeRun, SpeculativeFixConfig } from "../../../shared/types";
import {
  SpeculativeFixService,
  type SpeculativeFixServiceDeps,
  type SpeculativeTaskView,
} from "../SpeculativeFixService";
import { MemorySpeculativeRunStore } from "../speculative-run-store";
import type { EventTrigger, TriggerEvent } from "../types";

const report = (overrides: Record<string, unknown> = {}) =>
  [
    "Done.",
    "```speculative-result",
    JSON.stringify({
      reproduced: true,
      fixed: true,
      summary: "Off-by-one in the due date; now uses the local day.",
      diffStat: "1 file, +5 -2",
      testEvidence: "due-date.test.ts: 3 passed",
      ...overrides,
    }),
    "```",
  ].join("\n");

function trigger(speculateFix: SpeculativeFixConfig = {}): EventTrigger {
  return {
    id: "trigger-1",
    name: "Bug reports",
    enabled: true,
    source: "channel_message",
    conditions: [],
    action: { type: "speculate_fix", config: { speculateFix } },
    workspaceId: "ws-1",
    fireCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

const event: TriggerEvent = {
  source: "channel_message",
  timestamp: 1,
  fields: {
    channelType: "slack",
    channelInstanceId: "chan-1",
    chatId: "C1",
    messageId: "m-1",
    text: "Due dates show one day early on the board",
    senderName: "Ana",
  },
};

function harness(
  overrides: Partial<SpeculativeFixServiceDeps> = {},
  initial: SpeculativeRun[] = [],
) {
  const tasks = new Map<string, SpeculativeTaskView>();
  let next = 0;
  const store = new MemorySpeculativeRunStore(initial);
  const deps = {
    createTask: vi.fn(async () => {
      const id = `task-${++next}`;
      tasks.set(id, { id, status: "executing" });
      return { id };
    }),
    getTask: vi.fn((id: string) => tasks.get(id)),
    cancelTask: vi.fn(async (id: string) => {
      const task = tasks.get(id);
      if (task) task.status = "cancelled";
    }),
    logTaskEvent: vi.fn(),
    canIsolate: vi.fn(async () => true),
    worktree: {
      commit: vi.fn(async () => {}),
      diffStats: vi.fn(async () => ({ filesChanged: 1, linesAdded: 5, linesRemoved: 2 })),
      branchName: vi.fn(async () => "cowork/speculative-fix-a1"),
      openPullRequest: vi.fn(async () => ({
        success: true,
        url: "https://github.com/acme/app/pull/7",
      })),
      discard: vi.fn(async () => {}),
    },
    postToThread: vi.fn(async () => {}),
    isOwnerSender: vi.fn(async () => true),
    store,
    settleDelayMs: 1,
    ...overrides,
  } satisfies SpeculativeFixServiceDeps;
  const service = new SpeculativeFixService(deps);
  const finish = (taskId: string, status: SpeculativeTaskView["status"], summary?: string) => {
    tasks.set(taskId, { id: taskId, status, resultSummary: summary });
    service.onTaskEvent(taskId, status === "completed" ? "task_completed" : "task_status");
  };
  return { service, deps, tasks, store, finish };
}

async function settled(service: SpeculativeFixService, runId: string): Promise<SpeculativeRun> {
  await vi.waitFor(() => expect(service.getRun(runId)?.status).not.toBe("running"));
  return service.getRun(runId)!;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SpeculativeFixService", () => {
  it("starts a flagged background worker in an isolated worktree", async () => {
    const { service, deps } = harness();
    await service.init();
    const result = await service.start({ trigger: trigger(), event, idempotencyKey: "occ-1" });

    expect(result).toMatchObject({ started: true, taskId: "task-1" });
    expect(deps.canIsolate).toHaveBeenCalledWith("ws-1");
    const created = deps.createTask.mock.calls[0] as unknown as [Record<string, Any>];
    expect(created[0]).toMatchObject({
      workspaceId: "ws-1",
      title: expect.stringMatching(/^Speculative fix: Due dates show one day early/),
      agentConfig: {
        speculative: true,
        speculativeRunId: result.runId,
        requireWorktree: true,
        maxTurns: 40,
        allowUserInput: false,
      },
    });
    expect(service.listRuns({ workspaceId: "ws-1" })).toEqual([
      expect.objectContaining({ id: result.runId, status: "running", outcome: "running" }),
    ]);
    service.dispose();
  });

  it("posts a draft in the reporting thread and keeps the worktree", async () => {
    const { service, deps, finish, store } = harness();
    await service.init();
    const { runId, taskId } = await service.start({ trigger: trigger(), event });
    finish(taskId!, "completed", report());

    const run = await settled(service, runId!);
    expect(run).toMatchObject({
      status: "delivered",
      outcome: "draft_ready",
      worktreeKept: true,
      branchName: "cowork/speculative-fix-a1",
      filesChanged: 1,
      linesAdded: 5,
      linesRemoved: 2,
    });
    expect(deps.worktree.commit).toHaveBeenCalledWith(taskId, expect.any(String));
    expect(deps.worktree.discard).not.toHaveBeenCalled();
    expect(deps.postToThread).toHaveBeenCalledTimes(1);
    const posted = deps.postToThread.mock.calls[0] as unknown as [Record<string, Any>];
    expect(posted[0].origin).toMatchObject({
      channelType: "slack",
      chatId: "C1",
      messageId: "m-1",
    });
    expect(posted[0].text).toMatch(
      /I reproduced ".*" and have a candidate fix: .*Say "open it" to get a PR\./,
    );
    expect(deps.logTaskEvent).toHaveBeenCalledTimes(1);
    expect(store.runs[0]).toMatchObject({ id: runId, outcome: "draft_ready" });
  });

  it.each([
    ["not reproduced", report({ reproduced: false, fixed: false }), "not_reproduced"],
    ["no fix", report({ fixed: false }), "not_fixed"],
    ["no report", "I looked around but could not tell.", "no_report"],
  ])("stays silent and discards the worktree when %s", async (_label, summary, outcome) => {
    const { service, deps, finish } = harness();
    await service.init();
    const { runId, taskId } = await service.start({ trigger: trigger(), event });
    finish(taskId!, "completed", summary);

    const run = await settled(service, runId!);
    expect(run).toMatchObject({ status: "discarded", outcome, worktreeKept: false });
    expect(deps.worktree.discard).toHaveBeenCalledWith(taskId);
    expect(deps.worktree.commit).not.toHaveBeenCalled();
    expect(deps.postToThread).not.toHaveBeenCalled();
    expect(deps.logTaskEvent).toHaveBeenCalledTimes(1);
    expect(deps.logTaskEvent).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ outcome, message: expect.stringMatching(/^Speculative run /) }),
    );
  });

  it("discards a fix whose real diff is over the line limit", async () => {
    const { service, deps, finish } = harness({
      worktree: {
        ...harness().deps.worktree,
        diffStats: vi.fn(async () => ({ filesChanged: 4, linesAdded: 40, linesRemoved: 20 })),
        discard: vi.fn(async () => {}),
      },
    });
    await service.init();
    const { runId, taskId } = await service.start({
      trigger: trigger({ maxDiffLines: 50 }),
      event,
    });
    finish(taskId!, "completed", report());

    const run = await settled(service, runId!);
    expect(run).toMatchObject({ status: "discarded", outcome: "diff_too_large" });
    expect(deps.worktree.discard).toHaveBeenCalledWith(taskId);
    expect(deps.postToThread).not.toHaveBeenCalled();
  });

  it("silently discards a failed worker", async () => {
    const { service, deps, finish } = harness();
    await service.init();
    const { runId, taskId } = await service.start({ trigger: trigger(), event });
    finish(taskId!, "failed", report());

    const run = await settled(service, runId!);
    expect(run).toMatchObject({ status: "failed", outcome: "task_failed" });
    expect(deps.postToThread).not.toHaveBeenCalled();
    expect(deps.worktree.discard).toHaveBeenCalledWith(taskId);
  });

  it("cancels the worker at the hard time budget and stays silent", async () => {
    vi.useFakeTimers();
    const { service, deps } = harness();
    await service.init();
    const { runId, taskId } = await service.start({ trigger: trigger({ maxMinutes: 5 }), event });

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(deps.cancelTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(service.getRun(runId!)?.status).not.toBe("running"));

    expect(deps.cancelTask).toHaveBeenCalledWith(taskId);
    expect(service.getRun(runId!)).toMatchObject({ status: "discarded", outcome: "timed_out" });
    expect(deps.worktree.discard).toHaveBeenCalledWith(taskId);
    expect(deps.postToThread).not.toHaveBeenCalled();
  });

  it("opens a pull request and links it in the thread for open_pr", async () => {
    const { service, deps, finish } = harness();
    await service.init();
    const { runId, taskId } = await service.start({
      trigger: trigger({ delivery: "open_pr" }),
      event,
    });
    finish(taskId!, "completed", report());

    const run = await settled(service, runId!);
    expect(run).toMatchObject({
      status: "delivered",
      outcome: "pr_opened",
      prUrl: "https://github.com/acme/app/pull/7",
    });
    const opened = deps.worktree.openPullRequest.mock.calls[0] as unknown as [
      string,
      { title: string; body: string },
    ];
    expect(opened[0]).toBe(taskId);
    expect(opened[1].body).toMatch(/## Background[\s\S]*## Change[\s\S]*## Verification/);
    const posted = deps.postToThread.mock.calls[0] as unknown as [{ text: string }];
    expect(posted[0].text).toContain("https://github.com/acme/app/pull/7");
  });

  it("never posts a failed delivery", async () => {
    const { service, deps, finish } = harness({
      worktree: {
        ...harness().deps.worktree,
        openPullRequest: vi.fn(async () => ({ success: false, error: "gh: not logged in" })),
      },
    });
    await service.init();
    const { runId, taskId } = await service.start({
      trigger: trigger({ delivery: "open_pr" }),
      event,
    });
    finish(taskId!, "completed", report());

    const run = await settled(service, runId!);
    expect(run).toMatchObject({ status: "failed", outcome: "delivery_failed", worktreeKept: true });
    expect(deps.postToThread).not.toHaveBeenCalled();
  });

  it("keeps a workspace_pr draft off the chat", async () => {
    const { service, deps, finish } = harness();
    await service.init();
    const { runId, taskId } = await service.start({
      trigger: trigger({ destination: "workspace_pr" }),
      event,
    });
    finish(taskId!, "completed", report());

    const run = await settled(service, runId!);
    expect(run).toMatchObject({ status: "delivered", outcome: "draft_ready" });
    expect(deps.postToThread).not.toHaveBeenCalled();
  });

  it("opens a delivered draft as a pull request when the owner says open it", async () => {
    const { service, deps, finish } = harness();
    await service.init();
    const { runId, taskId } = await service.start({ trigger: trigger(), event });
    finish(taskId!, "completed", report());
    await settled(service, runId!);

    const message = {
      channelType: "slack",
      channelInstanceId: "chan-1",
      chatId: "C1",
      userId: "U-owner",
      text: "open it",
    };
    expect(await service.handleChannelMessage({ ...message, text: "thanks!" })).toBe(false);
    expect(await service.handleChannelMessage({ ...message, chatId: "C2" })).toBe(false);
    expect(await service.handleChannelMessage(message)).toBe(true);

    expect(deps.isOwnerSender).toHaveBeenCalledWith({
      channelType: "slack",
      channelInstanceId: "chan-1",
      userId: "U-owner",
    });
    expect(deps.worktree.openPullRequest).toHaveBeenCalledWith(taskId, expect.any(Object));
    expect(service.getRun(runId!)).toMatchObject({
      outcome: "pr_opened",
      prUrl: "https://github.com/acme/app/pull/7",
    });
    expect(deps.postToThread).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining("pull/7") }),
    );
  });

  it("ignores open it from anyone but the owner", async () => {
    const { service, deps, finish } = harness({ isOwnerSender: vi.fn(async () => false) });
    await service.init();
    const { runId, taskId } = await service.start({ trigger: trigger(), event });
    finish(taskId!, "completed", report());
    await settled(service, runId!);

    expect(
      await service.handleChannelMessage({
        channelType: "slack",
        channelInstanceId: "chan-1",
        chatId: "C1",
        userId: "U-stranger",
        text: "open it",
      }),
    ).toBe(false);
    expect(deps.worktree.openPullRequest).not.toHaveBeenCalled();
    expect(service.getRun(runId!)?.outcome).toBe("draft_ready");
  });

  it("refuses runs it must not start", async () => {
    const { service, deps } = harness({ maxConcurrentRuns: 1 });
    await service.init();

    expect(
      await service.start({
        trigger: trigger(),
        event,
        agentConfig: { botContained: true },
      }),
    ).toMatchObject({ started: false, reason: "responsibility_bound" });
    expect(
      await service.start({ trigger: trigger(), event: { ...event, fields: { text: " " } } }),
    ).toMatchObject({ started: false, reason: "empty_report" });
    expect(
      await service.start({
        trigger: trigger(),
        event: { ...event, fields: { ...event.fields, text: "open it" } },
      }),
    ).toMatchObject({ started: false, reason: "open_it_reply" });

    const first = await service.start({ trigger: trigger(), event, idempotencyKey: "occ-1" });
    expect(first.started).toBe(true);
    expect(
      await service.start({ trigger: trigger(), event, idempotencyKey: "occ-1" }),
    ).toMatchObject({ started: false, reason: "duplicate", runId: first.runId });
    expect(await service.start({ trigger: trigger(), event })).toMatchObject({
      started: false,
      reason: "busy",
    });
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    service.dispose();

    const unavailable = harness({ canIsolate: vi.fn(async () => false) });
    await unavailable.service.init();
    expect(await unavailable.service.start({ trigger: trigger(), event })).toMatchObject({
      started: false,
      reason: "worktree_unavailable",
    });
    expect(unavailable.deps.createTask).not.toHaveBeenCalled();
  });

  it("holds the key and the capacity across concurrent starts", async () => {
    const { service, deps } = harness({ maxConcurrentRuns: 1 });
    await service.init();

    const [first, second, third] = await Promise.all([
      service.start({ trigger: trigger(), event, idempotencyKey: "occ-9" }),
      service.start({ trigger: trigger(), event, idempotencyKey: "occ-9" }),
      service.start({ trigger: trigger(), event, idempotencyKey: "occ-10" }),
    ]);

    expect(first.started).toBe(true);
    expect(second).toMatchObject({ started: false, reason: "duplicate" });
    expect(third).toMatchObject({ started: false, reason: "busy" });
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("finishes a run that a restart interrupted", async () => {
    const interrupted: SpeculativeRun = {
      id: "run-old",
      triggerId: "trigger-1",
      triggerName: "Bug reports",
      workspaceId: "ws-1",
      taskId: "task-old",
      status: "running",
      outcome: "running",
      delivery: "draft_only",
      destination: "origin_thread",
      maxDiffLines: 200,
      issueExcerpt: "Due dates show one day early",
      origin: { source: "channel_message", channelType: "slack", chatId: "C1" },
      startedAt: Date.now() - 60_000,
      deadlineAt: Date.now() + 60_000,
    };
    const { service, deps, tasks } = harness({}, [interrupted]);
    tasks.set("task-old", { id: "task-old", status: "completed", resultSummary: report() });
    await service.init();

    const run = await settled(service, "run-old");
    expect(run).toMatchObject({ status: "delivered", outcome: "draft_ready" });
    expect(deps.postToThread).toHaveBeenCalledTimes(1);
  });
});

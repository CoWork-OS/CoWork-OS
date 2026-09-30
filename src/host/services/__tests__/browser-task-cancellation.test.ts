import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStatus, Workspace } from "../../../shared/types";
import type { WebRequestContext } from "../../web/WebApplication";
import {
  createBrowserTaskCancellationMethods,
  type BrowserTaskCancellationReceipt,
  type BrowserTaskCancellationReceiptResult,
  type BrowserTaskCancellationReceipts,
  type BrowserTaskCancellationSources,
} from "../browser-task-cancellation";

const workspace = { id: "workspace-1", isTemp: false } as Workspace;
const request = {
  taskId: "task-1",
  workspaceId: workspace.id,
  expectedStatus: "executing" as TaskStatus,
  expectedUpdatedAt: 100,
};

function makeTask(status: TaskStatus = "executing", updatedAt = 100): Task {
  return {
    id: request.taskId,
    title: "Browser task",
    prompt: "private task prompt",
    workspaceId: workspace.id,
    status,
    createdAt: 50,
    updatedAt,
  } as Task;
}

function context(
  operationKey = "cancel-task-12345678",
  sessionId = "session-1",
): WebRequestContext {
  return {
    audience: "control-plane",
    identity: {
      installationId: "installation-1",
      profileId: "profile-1",
      generation: "generation-1",
      runtime: "node",
      platform: "linux",
      appVersion: "1.0.0",
    },
    sessionId,
    operationKey,
  };
}

function makeReceipts(): BrowserTaskCancellationReceipts & {
  rows: Map<string, BrowserTaskCancellationReceipt>;
} {
  const rows = new Map<string, BrowserTaskCancellationReceipt>();
  return {
    rows,
    reserve: vi.fn(
      async (key, fingerprint, taskId, workspaceId, expectedStatus, expectedUpdatedAt) => {
        const existing = rows.get(key);
        if (existing) return { created: false, receipt: existing };
        const receipt: BrowserTaskCancellationReceipt = {
          fingerprint,
          taskId,
          workspaceId,
          expectedStatus,
          expectedUpdatedAt,
          state: "pending",
        };
        rows.set(key, receipt);
        return { created: true, receipt };
      },
    ),
    complete: vi.fn(async (key, result: BrowserTaskCancellationReceiptResult) => {
      const existing = rows.get(key);
      if (existing) rows.set(key, { ...existing, state: "completed", result });
    }),
    get: vi.fn(async (key) => rows.get(key) ?? null),
  };
}

function makeSources(
  options: {
    task?: Task;
    receipts?: BrowserTaskCancellationReceipts;
    cancelTask?: BrowserTaskCancellationSources["cancelTask"];
  } = {},
): BrowserTaskCancellationSources & { currentTask: Task } {
  const currentTask = options.task ?? makeTask();
  return {
    currentTask,
    getTask: vi.fn(async (taskId: string) => (taskId === currentTask.id ? currentTask : null)),
    getWorkspace: vi.fn(async (workspaceId: string) =>
      workspaceId === workspace.id ? workspace : null,
    ),
    cancelTask:
      options.cancelTask ??
      vi.fn(async () => {
        currentTask.status = "cancelled";
        currentTask.updatedAt += 1;
      }),
    receipts: options.receipts ?? makeReceipts(),
  };
}

function getCancelMethod(sources: BrowserTaskCancellationSources) {
  const method = createBrowserTaskCancellationMethods(sources)["task.cancel"];
  expect(method).toBeDefined();
  expect(method.capability).toBe("tasks.cancel");
  expect(method.mutation).toBe(true);
  return method;
}

function parse(method: ReturnType<typeof getCancelMethod>, value: unknown = request) {
  return method.validateParams!(value);
}

describe("browser task cancellation methods", () => {
  it("checks workspace and expected task version before dispatch, then returns observed terminal state", async () => {
    const sources = makeSources();
    const method = getCancelMethod(sources);
    const params = parse(method);

    await expect(method.handler(context(), params)).resolves.toEqual({
      taskId: request.taskId,
      workspaceId: workspace.id,
      operationKey: context().operationKey,
      outcome: "observed_terminal",
      status: "cancelled",
      updatedAt: 101,
    });
    expect(sources.cancelTask).toHaveBeenCalledTimes(1);
    expect(sources.receipts.get).toHaveBeenCalledWith(expect.any(String));
  });

  it("rejects stale task state and cross-workspace requests without invoking the daemon", async () => {
    const changedTask = makeTask("executing", 101);
    const staleSources = makeSources({ task: changedTask });
    const staleMethod = getCancelMethod(staleSources);
    await expect(staleMethod.handler(context(), parse(staleMethod))).rejects.toMatchObject({
      code: "STALE_STATE",
    });
    expect(staleSources.cancelTask).not.toHaveBeenCalled();

    const scopeSources = makeSources();
    const scopeMethod = getCancelMethod(scopeSources);
    await expect(
      scopeMethod.handler(
        context(),
        parse(scopeMethod, { ...request, workspaceId: "workspace-other" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(scopeSources.cancelTask).not.toHaveBeenCalled();
  });

  it("requires an operation key and rejects unsupported request fields", async () => {
    const sources = makeSources();
    const method = getCancelMethod(sources);
    await expect(method.handler(context(""), parse(method))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(() => parse(method, { ...request, force: true })).toThrow();
    expect(sources.cancelTask).not.toHaveBeenCalled();
  });

  it("reconciles the same durable operation after service recreation without redispatching", async () => {
    const receipts = makeReceipts();
    const sources = makeSources({ receipts });
    const firstMethod = getCancelMethod(sources);
    const first = await firstMethod.handler(context(), parse(firstMethod));
    expect(first).toMatchObject({ outcome: "observed_terminal", status: "cancelled" });

    // A new service instance represents a host restart; durable receipts and task rows remain.
    const restartedMethod = getCancelMethod(sources);
    await expect(
      restartedMethod.handler(
        context("cancel-task-12345678", "session-after-restart"),
        parse(restartedMethod),
      ),
    ).resolves.toMatchObject({
      outcome: "observed_terminal",
      status: "cancelled",
      updatedAt: 101,
    });
    expect(sources.cancelTask).toHaveBeenCalledTimes(1);
  });

  it("reconciles a pending receipt after restart when the task is already terminal", async () => {
    const receipts = makeReceipts();
    const sources = makeSources({
      receipts,
      cancelTask: vi.fn(async () => {
        throw new Error("reply lost before task row changed");
      }),
    });
    const methodBeforeRestart = getCancelMethod(sources);
    await expect(
      methodBeforeRestart.handler(context(), parse(methodBeforeRestart)),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect([...receipts.rows.values()][0]?.state).toBe("pending");

    // The task became terminal after the original command's reply was lost.
    sources.currentTask.status = "cancelled";
    sources.currentTask.updatedAt = 101;
    const restartedMethod = getCancelMethod(sources);
    await expect(restartedMethod.handler(context(), parse(restartedMethod))).resolves.toMatchObject(
      {
        outcome: "observed_terminal",
        status: "cancelled",
      },
    );
    expect(sources.cancelTask).toHaveBeenCalledTimes(1);
  });

  it("conflicts when a different key supplies stale state or a key is reused with changed params", async () => {
    const sources = makeSources();
    const firstMethod = getCancelMethod(sources);
    await firstMethod.handler(context(), parse(firstMethod));

    const otherKeyMethod = firstMethod;
    await expect(
      otherKeyMethod.handler(context("cancel-task-other-key"), parse(otherKeyMethod)),
    ).rejects.toMatchObject({ code: "STALE_STATE" });

    const changedParams = parse(firstMethod, { ...request, expectedStatus: "queued" });
    await expect(firstMethod.handler(context(), changedParams)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(sources.cancelTask).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent same-key calls and serializes distinct keys per task", async () => {
    const sources = makeSources();
    let finishCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    vi.mocked(sources.cancelTask).mockImplementation(async () => {
      await cancellation;
      sources.currentTask.status = "cancelled";
      sources.currentTask.updatedAt += 1;
    });
    const method = getCancelMethod(sources);
    const params = parse(method);
    const first = method.handler(context(), params);
    await vi.waitFor(() => expect(sources.cancelTask).toHaveBeenCalledTimes(1));
    const duplicate = method.handler(context(), params);
    await Promise.resolve();
    expect(sources.cancelTask).toHaveBeenCalledTimes(1);
    finishCancellation();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(duplicateResult).toEqual(firstResult);
    expect(sources.cancelTask).toHaveBeenCalledTimes(1);

    const secondSources = makeSources();
    let finishFirst!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    vi.mocked(secondSources.cancelTask).mockImplementationOnce(async () => {
      await waiting;
      secondSources.currentTask.status = "cancelled";
      secondSources.currentTask.updatedAt += 1;
    });
    const secondMethod = getCancelMethod(secondSources);
    const one = secondMethod.handler(context(), parse(secondMethod));
    await vi.waitFor(() => expect(secondSources.cancelTask).toHaveBeenCalledTimes(1));
    const two = secondMethod.handler(context("cancel-task-distinct-key"), parse(secondMethod));
    finishFirst();
    await one;
    await expect(two).rejects.toMatchObject({ code: "STALE_STATE" });
    expect(secondSources.cancelTask).toHaveBeenCalledTimes(1);
  });

  it("observes an already-terminal task without asking the daemon to overwrite it", async () => {
    const sources = makeSources({ task: makeTask("completed", 105) });
    const method = getCancelMethod(sources);
    await expect(
      method.handler(
        context(),
        parse(method, { ...request, expectedStatus: "completed", expectedUpdatedAt: 105 }),
      ),
    ).resolves.toMatchObject({
      outcome: "observed_terminal",
      status: "completed",
      updatedAt: 105,
    });
    expect(sources.cancelTask).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { BotWorkControls, controlNeedsReconciliation } from "../bot-work-controls";
import type {
  BotWorkControlRequest,
  BotWorkControlReceipt,
} from "../../../shared/bot-work-control";
function setup() {
  const scope = { workspaceId: crypto.randomUUID(), agentRoleId: "private-bot" };
  const changed = vi.fn();
  const receipt = (request: BotWorkControlRequest, pending = false): BotWorkControlReceipt => ({
    scope,
    requestId: request.requestId,
    action: request.action,
    recordedAt: 1,
    updatedAt: 1,
    status: pending ? "pending" : "settled",
    stillActiveTaskIds: pending ? ["task"] : [],
    tasks: [{ taskId: "task", stopVersion: 1, status: pending ? "requested" : "stopped" }],
  });
  const api = {
    stopBotWork: vi.fn(async (request: BotWorkControlRequest) => receipt(request)),
    getBotWorkControl: vi.fn<(_raw: unknown) => Promise<BotWorkControlReceipt | null>>(
      async () => null,
    ),
  };
  return { scope, changed, api, receipt };
}
afterEach(() => vi.useRealTimers());
describe("bot work control request lifecycle", () => {
  it("retries a lost reply with exactly the same request across dialog reopen", async () => {
    const f = setup();
    f.api.stopBotWork.mockRejectedValueOnce(new Error("Lost reply"));
    const first = new BotWorkControls(f.api, f.scope, f.changed);
    await first.start("stop_turn", "task");
    const request = f.api.stopBotWork.mock.calls[0][0];
    first.dispose();
    const next = new BotWorkControls(f.api, f.scope, f.changed);
    await next.retry();
    expect(f.api.stopBotWork.mock.calls[1][0]).toEqual(request);
    expect(next.getSnapshot().receipt?.tasks[0].status).toBe("stopped");
    next.dispose();
  });
  it("polls pending and failed cleanup without issuing another stop", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.api.stopBotWork.mockImplementationOnce(async (request) => f.receipt(request, true));
    const controller = new BotWorkControls(f.api, f.scope, f.changed, 20);
    await controller.start("stop_bot");
    const request = f.api.stopBotWork.mock.calls[0][0];
    f.api.getBotWorkControl
      .mockResolvedValueOnce({
        ...f.receipt(request, true),
        status: "settled",
        tasks: [{ taskId: "task", stopVersion: 1, status: "failed", error: "Still running" }],
      })
      .mockResolvedValueOnce(f.receipt(request));
    await vi.advanceTimersByTimeAsync(20);
    expect(controller.getSnapshot().receipt?.stillActiveTaskIds).toEqual(["task"]);
    await vi.advanceTimersByTimeAsync(20);
    expect(controller.getSnapshot().receipt?.stillActiveTaskIds).toEqual([]);
    expect(f.api.stopBotWork).toHaveBeenCalledOnce();
    controller.dispose();
  });
  it("ignores a foreign response and retains the original retry identity", async () => {
    const f = setup();
    f.api.stopBotWork.mockImplementationOnce(async (request) => ({
      ...f.receipt(request),
      scope: { ...f.scope, workspaceId: crypto.randomUUID() },
    }));
    const controller = new BotWorkControls(f.api, f.scope, f.changed);
    await controller.start("stop_bot");
    expect(controller.getSnapshot().receipt).toBeNull();
    expect(f.changed).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toContain("another request");
    await controller.retry();
    expect(f.api.stopBotWork.mock.calls[1][0]).toEqual(f.api.stopBotWork.mock.calls[0][0]);
    controller.dispose();
  });
  it("does not overwrite a reopened controller with an old late response", async () => {
    const f = setup();
    let release!: (value: BotWorkControlReceipt) => void;
    f.api.stopBotWork.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const old = new BotWorkControls(f.api, f.scope, f.changed);
    const waiting = old.start("stop_bot");
    const request = f.api.stopBotWork.mock.calls[0][0];
    old.dispose();
    const next = new BotWorkControls(f.api, f.scope, f.changed);
    f.api.getBotWorkControl.mockResolvedValue({ ...f.receipt(request), updatedAt: 2 });
    await next.check();
    release(f.receipt(request, true));
    await waiting;
    const reopened = new BotWorkControls(f.api, f.scope, f.changed);
    expect(reopened.getSnapshot().receipt?.updatedAt).toBe(2);
    expect(reopened.getSnapshot().receipt?.status).toBe("settled");
    next.dispose();
    reopened.dispose();
  });
  it("keeps other confirmed turns available after releasing one for a follow-up", async () => {
    const f = setup();
    f.api.stopBotWork.mockImplementationOnce(async (request) => ({
      ...f.receipt(request),
      tasks: [
        { taskId: "one", stopVersion: 4, status: "stopped" },
        { taskId: "two", stopVersion: 7, status: "stopped" },
      ],
    }));
    const controller = new BotWorkControls(f.api, f.scope, f.changed);
    await controller.start("stop_bot");
    f.api.stopBotWork.mockImplementationOnce(async (request) => ({
      ...f.receipt(request),
      tasks: [{ taskId: "one", stopVersion: 5, status: "released" }],
    }));
    await controller.start("resume_turn", "one", 4);
    expect(controller.getSnapshot().stopped).toEqual([{ taskId: "two", stopVersion: 7 }]);
    expect(f.api.stopBotWork.mock.calls[1][0]).toMatchObject({
      action: "resume_turn",
      taskId: "one",
      expectedStopVersion: 4,
    });
    controller.dispose();
  });
});

describe("work control renderer restart recovery", () => {
  it("restores a lost-reply identity after the controller module is reloaded", async () => {
    const f = setup();
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    f.api.stopBotWork.mockRejectedValueOnce(Error("Lost after commit"));
    const first = new BotWorkControls(f.api, f.scope, f.changed, 2000, storage);
    await first.start("stop_bot");
    const original = f.api.stopBotWork.mock.calls[0][0];
    first.dispose();
    vi.resetModules();
    const { BotWorkControls: Reloaded } = await import("../bot-work-controls");
    const next = new Reloaded(f.api, f.scope, f.changed, 2000, storage);
    expect(next.getSnapshot().request).toEqual(original);
    expect(next.getSnapshot().receipt).toBeNull();
    f.api.getBotWorkControl.mockResolvedValue(f.receipt(original));
    await next.check();
    expect(f.api.stopBotWork).toHaveBeenCalledOnce();
    expect(next.getSnapshot().receipt?.tasks[0].status).toBe("stopped");
    next.dispose();
  });
  it("does not send a control when recovery storage refuses the write", async () => {
    const f = setup();
    const controller = new BotWorkControls(f.api, f.scope, f.changed, 2000, {
      getItem: () => null,
      setItem: () => {
        throw Error("Quota");
      },
    });
    await controller.start("stop_bot");
    expect(f.api.stopBotWork).not.toHaveBeenCalled();
    expect(controller.getSnapshot().recoveryWarning).toContain("not sent");
    expect(controller.getSnapshot().request).toBeNull();
    controller.dispose();
  });
  it("keeps confirmed cleanup truthful if saving the response fails", async () => {
    const f = setup();
    let writes = 0;
    const storage = {
      getItem: () => null,
      setItem: () => {
        if (++writes > 2) throw Error("Quota");
      },
    };
    const controller = new BotWorkControls(f.api, f.scope, f.changed, 2000, storage);
    await controller.start("stop_bot");
    expect(f.api.stopBotWork).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().receipt?.tasks[0].status).toBe("stopped");
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().recoveryWarning).toContain("latest recovery");
    controller.dispose();
  });
  it("treats pause as settled while existing work continues and resumes with the exact version", async () => {
    vi.useFakeTimers();
    const f = setup();
    const future = {
      scope: f.scope,
      futurePaused: true,
      futureControlVersion: 4,
      responsibilityIds: ["saved"],
    };
    const getFuture = vi.fn(async () => future);
    f.api.stopBotWork.mockImplementation(async (request) => ({
      ...f.receipt(request),
      tasks: [],
      stillActiveTaskIds: ["current"],
      futureControl: future,
    }));
    const controller = new BotWorkControls(
      { ...f.api, getBotFutureControl: getFuture },
      f.scope,
      f.changed,
      20,
    );
    await controller.start("pause_bot");
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.getSnapshot().future).toEqual(future);
    expect(f.api.getBotWorkControl).not.toHaveBeenCalled();
    await controller.start("resume_bot", undefined, undefined, 4);
    expect(f.api.stopBotWork.mock.calls[1][0]).toMatchObject({
      action: "resume_bot",
      expectedFutureControlVersion: 4,
    });
    controller.dispose();
  });
  it("rejects foreign future state and does not let an older refresh erase a newer version", async () => {
    const f = setup();
    const getFuture = vi.fn(async () => ({
      scope: f.scope,
      futurePaused: true,
      futureControlVersion: 5,
      responsibilityIds: [],
    }));
    const controller = new BotWorkControls(
      { ...f.api, getBotFutureControl: getFuture },
      f.scope,
      f.changed,
    );
    await controller.refreshFuture();
    getFuture.mockResolvedValueOnce({
      scope: f.scope,
      futurePaused: false,
      futureControlVersion: 4,
      responsibilityIds: [],
    });
    await controller.refreshFuture();
    expect(controller.getSnapshot().future?.futurePaused).toBe(true);
    getFuture.mockResolvedValueOnce({
      scope: { ...f.scope, workspaceId: crypto.randomUUID() },
      futurePaused: false,
      futureControlVersion: 6,
      responsibilityIds: [],
    });
    await controller.refreshFuture();
    expect(controller.getSnapshot().futureError).toContain("another bot");
    expect(controller.getSnapshot().future?.futureControlVersion).toBe(5);
    controller.dispose();
  });
  it("allows a new control when a newer durable version fences out an ambiguous old resume", async () => {
    const f = setup();
    const future = {
      scope: f.scope,
      futurePaused: true,
      futureControlVersion: 5,
      responsibilityIds: [],
    };
    const controller = new BotWorkControls(
      { ...f.api, getBotFutureControl: async () => future },
      f.scope,
      f.changed,
    );
    f.api.stopBotWork.mockRejectedValueOnce(new Error("Version changed"));
    await controller.start("resume_bot", undefined, undefined, 4);
    await controller.refreshFuture();
    expect(controlNeedsReconciliation(controller.getSnapshot())).toBe(false);
    await controller.start("pause_bot");
    expect(f.api.stopBotWork).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});

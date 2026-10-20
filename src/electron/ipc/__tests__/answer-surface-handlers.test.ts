import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel, handler) => registered.set(channel, handler)),
  },
}));
vi.mock("../../media", () => ({ createWebPreviewUrl: vi.fn() }));

import { IPC_CHANNELS } from "../../../shared/types";
import { setupAnswerSurfaceHandlers } from "../answer-surface-handlers";

const event = { senderFrame: { parent: null } } as IpcMainInvokeEvent;
const request = { taskId: "task-1", sources: { data: "report.csv" } };
const table = {
  file: "report.csv",
  columns: ["count"],
  rows: [[3]],
  totalRows: 1,
  truncated: false,
};

function setup(
  authorizeTask: (
    event: IpcMainInvokeEvent,
    taskId: string,
    capability: "view" | "contribute",
  ) => void | Promise<unknown>,
) {
  const taskExists = vi.fn(async () => true);
  const loadDataSource = vi.fn(async () => table);
  setupAnswerSurfaceHandlers({
    authorizeTask,
    taskExists,
    loadDataSource,
    resolveNetworkContext: vi.fn(async () => ({})),
    images: { resolve: vi.fn(async () => []) },
    store: { get: vi.fn(async () => []), save: vi.fn(async () => {}) },
    checkRateLimit: () => {},
  });
  return {
    handle: registered.get(IPC_CHANNELS.ANSWER_SURFACE_LOAD_DATA)!,
    loadDataSource,
    taskExists,
  };
}

beforeEach(() => registered.clear());

describe("answer surface desktop data authorization", () => {
  it("waits for membership authorization before reading task data", async () => {
    let allow!: () => void;
    const authorization = new Promise<void>((resolve) => {
      allow = resolve;
    });
    const authorizeTask = vi.fn(() => authorization);
    const { handle, taskExists, loadDataSource } = setup(authorizeTask);

    const pending = handle(event, request);
    await new Promise((resolve) => setImmediate(resolve));

    expect(authorizeTask).toHaveBeenCalledWith(event, "task-1", "view");
    expect(taskExists).not.toHaveBeenCalled();
    expect(loadDataSource).not.toHaveBeenCalled();
    allow();
    await expect(pending).resolves.toEqual({ data: table });
    expect(loadDataSource).toHaveBeenCalledOnce();
  });

  it("propagates an asynchronous membership denial without reading task data", async () => {
    const denied = Promise.reject(new Error("Principal is not a member"));
    // Keep a discarded rejection handled when running this regression against the old seam.
    void denied.catch(() => {});
    const { handle, taskExists, loadDataSource } = setup(() => denied);

    await expect(handle(event, request)).rejects.toThrow("Principal is not a member");
    expect(taskExists).not.toHaveBeenCalled();
    expect(loadDataSource).not.toHaveBeenCalled();
  });

  it("rejects framed callers before authorization or reading task data", async () => {
    const authorizeTask = vi.fn();
    const { handle, loadDataSource } = setup(authorizeTask);
    const framed = { senderFrame: { parent: {} } } as IpcMainInvokeEvent;

    await expect(Promise.resolve().then(() => handle(framed, request))).rejects.toThrow(
      "only available to the app window",
    );
    expect(authorizeTask).not.toHaveBeenCalled();
    expect(loadDataSource).not.toHaveBeenCalled();
  });

  it("continues to support synchronous authorization", async () => {
    const authorizeTask = vi.fn();
    const { handle } = setup(authorizeTask);

    await expect(handle(event, request)).resolves.toEqual({ data: table });
    expect(authorizeTask).toHaveBeenCalledWith(event, "task-1", "view");
  });

  it.each([
    [IPC_CHANNELS.ANSWER_SURFACE_GET_STATE, { taskId: "task-1", keys: ["s1-abc-0"] }],
    [
      IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE,
      { taskId: "task-1", key: "s1-abc-0", state: {}, summary: "" },
    ],
    [
      IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES,
      { taskId: "task-1", requests: [{ query: "private" }] },
    ],
  ])("checks membership before the related answer operation %s", async (channel, raw) => {
    const { taskExists, loadDataSource } = setup(async () => {
      throw new Error("Principal is not a member");
    });
    await expect(registered.get(channel)!(event, raw)).rejects.toThrow("not a member");
    expect(taskExists).not.toHaveBeenCalled();
    expect(loadDataSource).not.toHaveBeenCalled();
  });

  it("requires contribution authority before saving shared answer controls", async () => {
    const authorizeTask = vi.fn(async (_event, _taskId, capability) => {
      if (capability === "contribute") throw new Error("A viewer cannot contribute");
    });
    const { taskExists } = setup(authorizeTask);
    const save = registered.get(IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE)!;
    const raw = { taskId: "task-1", key: "s1-abc-0", state: {}, summary: "" };
    await expect(save(event, raw)).rejects.toThrow("viewer cannot contribute");
    expect(authorizeTask).toHaveBeenCalledWith(event, "task-1", "contribute");
    expect(taskExists).not.toHaveBeenCalled();
    authorizeTask.mockResolvedValue(undefined);
    await expect(save(event, raw)).resolves.toEqual({ ok: true });
  });
});

import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/types";
import {
  createAnswerSurfaceIpcHandlers,
  type AnswerSurfaceIpcDeps,
} from "../answer-surface-operations";

function setup(overrides: Partial<AnswerSurfaceIpcDeps> = {}) {
  const deps: AnswerSurfaceIpcDeps = {
    taskExists: vi.fn(async (taskId: string) => taskId === "task-1"),
    resolveNetworkContext: vi.fn(async () => ({ networkEnabled: true })),
    images: { resolve: vi.fn(async (requests) => requests.map(() => null)) },
    store: {
      get: vi.fn(async () => [{ key: "s1-abc-0", state: { people: 8 }, updatedAt: 1 }]),
      save: vi.fn(async () => {}),
    },
    checkRateLimit: () => {},
    ...overrides,
  };
  return { deps, handlers: createAnswerSurfaceIpcHandlers(deps) };
}

describe("answer surface operations", () => {
  it("reads saved state for an existing task", async () => {
    const { handlers, deps } = setup();
    await expect(
      handlers[IPC_CHANNELS.ANSWER_SURFACE_GET_STATE]({ taskId: "task-1", keys: ["s1-abc-0"] }),
    ).resolves.toEqual({ "s1-abc-0": { people: 8 } });
    expect(deps.store.get).toHaveBeenCalledWith("task-1", ["s1-abc-0"]);
  });

  it("saves state with its summary", async () => {
    const { handlers, deps } = setup();
    await handlers[IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE]({
      taskId: "task-1",
      key: "s1-abc-0",
      state: { people: 8, steps: ["item_1"], vegetarian: true },
      summary: "People: 8",
    });
    expect(deps.store.save).toHaveBeenCalledWith(
      "task-1",
      "s1-abc-0",
      { people: 8, steps: ["item_1"], vegetarian: true },
      "People: 8",
    );
  });

  it.each([
    [IPC_CHANNELS.ANSWER_SURFACE_GET_STATE, { taskId: "task-1", keys: ["../etc"] }],
    [IPC_CHANNELS.ANSWER_SURFACE_GET_STATE, { taskId: "task-1", keys: [] }],
    [
      IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE,
      { taskId: "task-1", key: "s1-abc-0", state: { a: { nested: 1 } }, summary: "" },
    ],
    [
      IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE,
      { taskId: "task-1", key: "s1-abc-0", state: {}, summary: "", extra: 1 },
    ],
    [
      IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES,
      { requests: [{ src: "http://example.com/a.png" }] },
    ],
    [
      IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES,
      { requests: [{ query: "a", src: "https://example.com/a.png" }] },
    ],
    [
      IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES,
      { requests: Array.from({ length: 13 }, () => ({ query: "a" })) },
    ],
  ])("rejects invalid %s payloads", async (channel, payload) => {
    const { handlers, deps } = setup();
    await expect(handlers[channel](payload)).rejects.toThrow(/Invalid/);
    expect(deps.store.save).not.toHaveBeenCalled();
  });

  it("refuses unknown tasks", async () => {
    const { handlers, deps } = setup();
    await expect(
      handlers[IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE]({
        taskId: "task-2",
        key: "s1-abc-0",
        state: {},
        summary: "",
      }),
    ).rejects.toThrow("Task not found");
    expect(deps.store.save).not.toHaveBeenCalled();
  });

  it("resolves images under the task's network policy", async () => {
    const { handlers, deps } = setup();
    await handlers[IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES]({
      taskId: "task-1",
      requests: [{ query: "roast lamb" }],
    });
    expect(deps.resolveNetworkContext).toHaveBeenCalledWith("task-1");
    expect(deps.images.resolve).toHaveBeenCalledWith([{ query: "roast lamb" }], {
      networkEnabled: true,
    });
  });
});

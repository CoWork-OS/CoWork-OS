import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/types";
import type { MemoryReviewService } from "../../memory/MemoryReviewService";
import { createMemoryReviewIpcHandlers } from "../memory-review-handlers";

const WS = "7b0f8e4c-3a52-4d8e-9b1a-2f6c1d9e0a11";
const OTHER_WS = "0c6f2b1e-8d4a-4f3b-a2c9-5e7d1b3a9f22";

function setup() {
  const service = {
    state: vi.fn(async () => ({ pending: [], recent: [], pendingCount: 0 })),
    count: vi.fn(async () => 2),
    accept: vi.fn(async () => ({ success: true })),
    reject: vi.fn(async () => ({ success: true })),
    undo: vi.fn(async () => ({ success: true })),
    runNow: vi.fn(async () => ({ success: true, status: "completed", applied: 0, queued: 0 })),
    setLlmEnabled: vi.fn(() => ({ success: true })),
  };
  const workspaceExists = vi.fn(async (id: string) => id === WS);
  const checkRateLimit = vi.fn();
  const handlers = createMemoryReviewIpcHandlers({
    service: service as unknown as MemoryReviewService,
    workspaceExists,
    checkRateLimit,
  });
  return { service, handlers, workspaceExists, checkRateLimit };
}

describe("memory review IPC", () => {
  it("registers one handler per review channel", () => {
    const { handlers } = setup();
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC_CHANNELS.MEMORY_REVIEW_GET,
        IPC_CHANNELS.MEMORY_REVIEW_COUNT,
        IPC_CHANNELS.MEMORY_REVIEW_ACCEPT,
        IPC_CHANNELS.MEMORY_REVIEW_REJECT,
        IPC_CHANNELS.MEMORY_REVIEW_UNDO,
        IPC_CHANNELS.MEMORY_REVIEW_RUN_NOW,
        IPC_CHANNELS.MEMORY_REVIEW_SET_LLM,
      ].sort(),
    );
    expect(
      Object.values(IPC_CHANNELS).filter((channel) => channel.startsWith("memoryReview:")),
    ).toHaveLength(7);
  });

  it("passes validated requests to the service", async () => {
    const { handlers, service } = setup();
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_GET]({ workspaceId: WS });
    expect(service.state).toHaveBeenCalledWith(WS);
    expect(await handlers[IPC_CHANNELS.MEMORY_REVIEW_COUNT]({ workspaceId: WS })).toBe(2);
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_ACCEPT]({ workspaceId: WS, id: "cand-1" });
    expect(service.accept).toHaveBeenCalledWith(WS, "cand-1");
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_REJECT]({ workspaceId: WS, id: "cand-2" });
    expect(service.reject).toHaveBeenCalledWith(WS, "cand-2");
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_UNDO]({ workspaceId: WS, id: "log-1" });
    expect(service.undo).toHaveBeenCalledWith(WS, "log-1");
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_SET_LLM]({ workspaceId: WS, enabled: true });
    expect(service.setLlmEnabled).toHaveBeenCalledWith(true);
  });

  it("refuses malformed payloads before touching the service", async () => {
    const { handlers, service } = setup();
    const bad: Array<[string, unknown]> = [
      [IPC_CHANNELS.MEMORY_REVIEW_GET, undefined],
      [IPC_CHANNELS.MEMORY_REVIEW_GET, { workspaceId: "not a workspace id" }],
      [IPC_CHANNELS.MEMORY_REVIEW_ACCEPT, { workspaceId: WS }],
      [IPC_CHANNELS.MEMORY_REVIEW_ACCEPT, { workspaceId: WS, id: "" }],
      [IPC_CHANNELS.MEMORY_REVIEW_ACCEPT, { workspaceId: WS, id: "x".repeat(101) }],
      [IPC_CHANNELS.MEMORY_REVIEW_UNDO, { workspaceId: WS, id: "log-1", force: true }],
      [IPC_CHANNELS.MEMORY_REVIEW_SET_LLM, { workspaceId: WS, enabled: "yes" }],
      [IPC_CHANNELS.MEMORY_REVIEW_RUN_NOW, { workspaceId: WS, budget: 1 }],
    ];
    for (const [channel, payload] of bad) {
      await expect(handlers[channel](payload)).rejects.toThrow();
    }
    expect(service.state).not.toHaveBeenCalled();
    expect(service.accept).not.toHaveBeenCalled();
    expect(service.undo).not.toHaveBeenCalled();
    expect(service.setLlmEnabled).not.toHaveBeenCalled();
    expect(service.runNow).not.toHaveBeenCalled();
  });

  it("requires an existing workspace", async () => {
    const { handlers, service } = setup();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_REVIEW_ACCEPT]({ workspaceId: OTHER_WS, id: "cand-1" }),
    ).rejects.toThrow(/Workspace not found/);
    expect(service.accept).not.toHaveBeenCalled();
  });

  it("rate-limits mutations only", async () => {
    const { handlers, checkRateLimit } = setup();
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_GET]({ workspaceId: WS });
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_COUNT]({ workspaceId: WS });
    expect(checkRateLimit).not.toHaveBeenCalled();
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_RUN_NOW]({ workspaceId: WS });
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_REVIEW_RUN_NOW);
  });
});

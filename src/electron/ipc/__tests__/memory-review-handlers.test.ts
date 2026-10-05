import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/types";
import type { MemoryReviewService } from "../../memory/MemoryReviewService";
import { createMemoryReviewIpcHandlers } from "../memory-review-handlers";

const WS = "7b0f8e4c-3a52-4d8e-9b1a-2f6c1d9e0a11";
const OTHER_WS = "0c6f2b1e-8d4a-4f3b-a2c9-5e7d1b3a9f22";

function setup() {
  const service = {
    state: vi.fn(async () => ({ recent: [] })),
    undo: vi.fn(async () => ({ success: true })),
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
      [IPC_CHANNELS.MEMORY_REVIEW_GET, IPC_CHANNELS.MEMORY_REVIEW_UNDO].sort(),
    );
    expect(
      Object.values(IPC_CHANNELS).filter((channel) => channel.startsWith("memoryReview:")),
    ).toHaveLength(2);
  });

  it("passes validated requests to the service", async () => {
    const { handlers, service } = setup();
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_GET]({ workspaceId: WS });
    expect(service.state).toHaveBeenCalledWith(WS);
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_UNDO]({ workspaceId: WS, id: "log-1" });
    expect(service.undo).toHaveBeenCalledWith(WS, "log-1");
  });

  it("refuses malformed payloads before touching the service", async () => {
    const { handlers, service } = setup();
    const bad: Array<[string, unknown]> = [
      [IPC_CHANNELS.MEMORY_REVIEW_GET, undefined],
      [IPC_CHANNELS.MEMORY_REVIEW_GET, { workspaceId: "not a workspace id" }],
      [IPC_CHANNELS.MEMORY_REVIEW_GET, { workspaceId: WS, extra: 1 }],
      [IPC_CHANNELS.MEMORY_REVIEW_UNDO, { workspaceId: WS }],
      [IPC_CHANNELS.MEMORY_REVIEW_UNDO, { workspaceId: WS, id: "" }],
      [IPC_CHANNELS.MEMORY_REVIEW_UNDO, { workspaceId: WS, id: "x".repeat(101) }],
      [IPC_CHANNELS.MEMORY_REVIEW_UNDO, { workspaceId: WS, id: "log-1", force: true }],
    ];
    for (const [channel, payload] of bad) {
      await expect(handlers[channel](payload)).rejects.toThrow();
    }
    expect(service.state).not.toHaveBeenCalled();
    expect(service.undo).not.toHaveBeenCalled();
  });

  it("requires an existing workspace", async () => {
    const { handlers, service } = setup();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_REVIEW_UNDO]({ workspaceId: OTHER_WS, id: "log-1" }),
    ).rejects.toThrow(/Workspace not found/);
    expect(service.undo).not.toHaveBeenCalled();
  });

  it("rate-limits undo only", async () => {
    const { handlers, checkRateLimit } = setup();
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_GET]({ workspaceId: WS });
    expect(checkRateLimit).not.toHaveBeenCalled();
    await handlers[IPC_CHANNELS.MEMORY_REVIEW_UNDO]({ workspaceId: WS, id: "log-1" });
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_REVIEW_UNDO);
  });
});

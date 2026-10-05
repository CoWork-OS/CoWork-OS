import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/types";
import { createMemoryHealthIpcHandlers } from "../memory-health-handlers";
import { MemoryHubWorkspaceRequestSchema } from "../memory-health-ipc-validation";

const WS = "7b0f8e4c-3a52-4d8e-9b1a-2f6c1d9e0a11";
const OTHER_WS = "0c6f2b1e-8d4a-4f3b-a2c9-5e7d1b3a9f22";

function setup() {
  const service = {
    sources: vi.fn(async (workspaceId: string) => ({ workspaceId })),
    health: vi.fn(async () => ({ generatedAt: 1, checks: [], ok: true })),
  };
  const workspaceExists = vi.fn(async (id: string) => id === WS);
  const checkRateLimit = vi.fn();
  const handlers = createMemoryHealthIpcHandlers({
    service: service as never,
    workspaceExists,
    checkRateLimit,
  });
  return { service, handlers, workspaceExists, checkRateLimit };
}

describe("memory hub sources and health IPC", () => {
  it("registers one handler per channel", () => {
    const { handlers } = setup();
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC_CHANNELS.MEMORY_HUB_SOURCES, IPC_CHANNELS.MEMORY_HUB_HEALTH].sort(),
    );
    expect(
      Object.values(IPC_CHANNELS).filter((channel) => channel.startsWith("memoryHub:")),
    ).toHaveLength(2);
  });

  it("passes validated requests to the service and rate-limits each channel", async () => {
    const { handlers, service, checkRateLimit } = setup();
    expect(await handlers[IPC_CHANNELS.MEMORY_HUB_SOURCES]({ workspaceId: WS })).toEqual({
      workspaceId: WS,
    });
    expect(service.sources).toHaveBeenCalledWith(WS);
    await handlers[IPC_CHANNELS.MEMORY_HUB_HEALTH]({ workspaceId: WS });
    expect(service.health).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_HUB_SOURCES);
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_HUB_HEALTH);
  });

  it("refuses malformed payloads before reaching the service", async () => {
    const { handlers, service, workspaceExists } = setup();
    for (const channel of [IPC_CHANNELS.MEMORY_HUB_SOURCES, IPC_CHANNELS.MEMORY_HUB_HEALTH]) {
      for (const payload of [
        undefined,
        null,
        "ws",
        {},
        { workspaceId: "" },
        { workspaceId: "../etc" },
        { workspaceId: 42 },
        { workspaceId: WS, extra: true },
      ]) {
        await expect(handlers[channel](payload)).rejects.toThrow(/Invalid memory hub request/);
      }
    }
    expect(workspaceExists).not.toHaveBeenCalled();
    expect(service.sources).not.toHaveBeenCalled();
    expect(service.health).not.toHaveBeenCalled();
  });

  it("refuses an unknown workspace", async () => {
    const { handlers, service } = setup();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_HUB_SOURCES]({ workspaceId: OTHER_WS }),
    ).rejects.toThrow("Workspace not found");
    await expect(
      handlers[IPC_CHANNELS.MEMORY_HUB_HEALTH]({ workspaceId: OTHER_WS }),
    ).rejects.toThrow("Workspace not found");
    expect(service.sources).not.toHaveBeenCalled();
    expect(service.health).not.toHaveBeenCalled();
  });

  it("stops at the rate limit", async () => {
    const { handlers, service, checkRateLimit } = setup();
    checkRateLimit.mockImplementation(() => {
      throw new Error("Rate limit exceeded. Try again in 5 seconds.");
    });
    await expect(handlers[IPC_CHANNELS.MEMORY_HUB_HEALTH]({ workspaceId: WS })).rejects.toThrow(
      /Rate limit/,
    );
    expect(service.health).not.toHaveBeenCalled();
  });

  it("schema accepts only a workspace id", () => {
    expect(MemoryHubWorkspaceRequestSchema.safeParse({ workspaceId: WS }).success).toBe(true);
    expect(MemoryHubWorkspaceRequestSchema.safeParse({ workspaceId: WS, id: "x" }).success).toBe(
      false,
    );
  });
});

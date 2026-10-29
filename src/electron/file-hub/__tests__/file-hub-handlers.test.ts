import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import { IPC_CHANNELS } from "../../../shared/types";
import { setupFileHubHandlers } from "../../ipc/file-hub-handlers";
import type { FileHubService } from "../FileHubService";

function setup() {
  const service = {
    listFiles: vi.fn(async () => []),
    searchFiles: vi.fn(async () => []),
    getRecentFiles: vi.fn(async () => []),
    getAvailableSources: vi.fn(() => ["local", "artifacts"]),
  };
  setupFileHubHandlers(service as unknown as FileHubService);
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = registeredHandlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({}, ...args);
  };
  return { service, invoke };
}

describe("file hub IPC handlers", () => {
  beforeEach(() => {
    registeredHandlers.clear();
  });

  it("passes a valid list request through without unknown fields", async () => {
    const { service, invoke } = setup();
    await invoke(IPC_CHANNELS.FILEHUB_LIST, {
      source: "local",
      path: "/workspace/docs",
      injected: true,
    });
    expect(service.listFiles).toHaveBeenCalledWith({ source: "local", path: "/workspace/docs" });
  });

  it("passes the selected workspace id through", async () => {
    const { service, invoke } = setup();
    await invoke(IPC_CHANNELS.FILEHUB_LIST, { source: "local", workspaceId: "ws-1" });
    expect(service.listFiles).toHaveBeenCalledWith({ source: "local", workspaceId: "ws-1" });

    await invoke(IPC_CHANNELS.FILEHUB_SEARCH, {
      query: "plan",
      sources: ["local"],
      workspaceId: "ws-1",
    });
    expect(service.searchFiles).toHaveBeenCalledWith("plan", ["local"], "ws-1");
  });

  it("rejects a workspace id that is not a short string", async () => {
    const { service, invoke } = setup();
    for (const workspaceId of [42, { id: "ws-1" }, "w".repeat(257)]) {
      await expect(
        invoke(IPC_CHANNELS.FILEHUB_LIST, { source: "local", workspaceId }),
      ).rejects.toThrow(/Invalid file hub list options/);
      await expect(
        invoke(IPC_CHANNELS.FILEHUB_SEARCH, { query: "plan", workspaceId }),
      ).rejects.toThrow(/Invalid file hub search/);
    }
    expect(service.listFiles).not.toHaveBeenCalled();
    expect(service.searchFiles).not.toHaveBeenCalled();
  });

  it("rejects malformed list requests from the renderer", async () => {
    const { service, invoke } = setup();
    await expect(invoke(IPC_CHANNELS.FILEHUB_LIST, { source: "elsewhere" })).rejects.toThrow(
      /Invalid file hub list options/,
    );
    await expect(invoke(IPC_CHANNELS.FILEHUB_LIST, { source: "local", path: 42 })).rejects.toThrow(
      /Invalid file hub list options/,
    );
    await expect(invoke(IPC_CHANNELS.FILEHUB_LIST, undefined)).rejects.toThrow();
    expect(service.listFiles).not.toHaveBeenCalled();
  });

  it("validates search and recent requests", async () => {
    const { service, invoke } = setup();
    await invoke(IPC_CHANNELS.FILEHUB_SEARCH, { query: "report", sources: ["local"] });
    expect(service.searchFiles).toHaveBeenCalledWith("report", ["local"], undefined);

    await expect(
      invoke(IPC_CHANNELS.FILEHUB_SEARCH, { query: "report", sources: ["nowhere"] }),
    ).rejects.toThrow(/Invalid file hub search/);

    await invoke(IPC_CHANNELS.FILEHUB_RECENT, 10);
    await invoke(IPC_CHANNELS.FILEHUB_RECENT);
    expect(service.getRecentFiles).toHaveBeenNthCalledWith(1, 10);
    expect(service.getRecentFiles).toHaveBeenNthCalledWith(2, undefined);
    await expect(invoke(IPC_CHANNELS.FILEHUB_RECENT, "ten")).rejects.toThrow(
      /Invalid file hub recent limit/,
    );
  });
});

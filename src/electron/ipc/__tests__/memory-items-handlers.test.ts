import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { IPC_CHANNELS } from "../../../shared/types";
import type { MemoryItemsHubService } from "../../memory/MemoryItemsHubService";
import { createMemoryItemsIpcHandlers } from "../memory-items-handlers";
import {
  MemoryItemAddRequestSchema,
  MemoryItemsClearGlobalRequestSchema,
  MemoryItemsListRequestSchema,
} from "../memory-ipc-validation";

const WS = "7b0f8e4c-3a52-4d8e-9b1a-2f6c1d9e0a11";
const OTHER_WS = "0c6f2b1e-8d4a-4f3b-a2c9-5e7d1b3a9f22";

function setup(options: { exists?: (id: string) => boolean } = {}) {
  const service = {
    list: vi.fn(async () => ({ items: [], total: 0, offset: 0, hasMore: false })),
    get: vi.fn(async () => ({ item: {}, previous: [], supersededBy: null })),
    why: vi.fn(async () => ({ summary: "You said this." })),
    add: vi.fn(async () => ({ success: true, item: null })),
    update: vi.fn(async () => ({ success: true, item: null })),
    setPinned: vi.fn(async () => ({ success: true, item: null })),
    delete: vi.fn(async () => ({ success: true, item: null })),
    clearGlobal: vi.fn(async () => ({ success: true, deleted: 0, legacyRecords: 0 })),
  };
  const workspaceExists = vi.fn(async (id: string) => (options.exists ?? ((v) => v === WS))(id));
  const checkRateLimit = vi.fn();
  const handlers = createMemoryItemsIpcHandlers({
    service: service as unknown as MemoryItemsHubService,
    workspaceExists,
    checkRateLimit,
  });
  return { service, handlers, workspaceExists, checkRateLimit };
}

describe("memory items IPC", () => {
  it("registers one handler per memory item channel", () => {
    const { handlers } = setup();
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC_CHANNELS.MEMORY_ITEMS_LIST,
        IPC_CHANNELS.MEMORY_ITEMS_GET,
        IPC_CHANNELS.MEMORY_ITEMS_ADD,
        IPC_CHANNELS.MEMORY_ITEMS_UPDATE,
        IPC_CHANNELS.MEMORY_ITEMS_SET_PINNED,
        IPC_CHANNELS.MEMORY_ITEMS_DELETE,
        IPC_CHANNELS.MEMORY_ITEMS_WHY,
        IPC_CHANNELS.MEMORY_ITEMS_CLEAR_GLOBAL,
      ].sort(),
    );
  });

  it("validates list filters and caps the page size", async () => {
    const { handlers, service } = setup();
    await handlers[IPC_CHANNELS.MEMORY_ITEMS_LIST]({
      workspaceId: WS,
      kinds: ["preference"],
      sources: ["user_stated"],
      query: "tea",
      limit: 10_000,
    });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, limit: 200, kinds: ["preference"] }),
    );
    for (const bad of [
      { workspaceId: "not-a-workspace" },
      { workspaceId: WS, kinds: ["password"] },
      { workspaceId: WS, sources: ["admin"] },
      { workspaceId: WS, query: "x".repeat(501) },
      { workspaceId: WS, offset: -1 },
      { workspaceId: WS, includePrivate: false },
      null,
    ]) {
      await expect(handlers[IPC_CHANNELS.MEMORY_ITEMS_LIST](bad)).rejects.toThrow();
    }
    expect(service.list).toHaveBeenCalledTimes(1);
  });

  it("refuses requests for a workspace that does not exist", async () => {
    const { handlers, service } = setup();
    for (const [channel, payload] of [
      [IPC_CHANNELS.MEMORY_ITEMS_LIST, { workspaceId: OTHER_WS }],
      [IPC_CHANNELS.MEMORY_ITEMS_GET, { workspaceId: OTHER_WS, id: "item-1" }],
      [IPC_CHANNELS.MEMORY_ITEMS_DELETE, { workspaceId: OTHER_WS, id: "item-1" }],
    ] as const) {
      await expect(handlers[channel](payload)).rejects.toThrow("Workspace not found");
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(service.get).not.toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
  });

  it("never lets the renderer choose the source, status or another scope of an added item", async () => {
    const { handlers, service } = setup();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_ITEMS_ADD]({
        workspaceId: WS,
        content: "Prefers tea",
        kind: "preference",
        scope: "global",
        source: "user_confirmed",
      }),
    ).rejects.toThrow();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_ITEMS_ADD]({
        workspaceId: WS,
        content: "Prefers tea",
        kind: "preference",
        scope: "contact",
      }),
    ).rejects.toThrow();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_ITEMS_ADD]({
        workspaceId: WS,
        content: "x".repeat(1001),
        kind: "preference",
        scope: "global",
      }),
    ).rejects.toThrow();
    await handlers[IPC_CHANNELS.MEMORY_ITEMS_ADD]({
      workspaceId: WS,
      content: "  Prefers tea  ",
      kind: "preference",
      scope: "global",
    });
    expect(service.add).toHaveBeenCalledWith({
      workspaceId: WS,
      content: "Prefers tea",
      kind: "preference",
      scope: "global",
    });
  });

  it("rate-limits mutations but not reads", async () => {
    const { handlers, checkRateLimit } = setup();
    await handlers[IPC_CHANNELS.MEMORY_ITEMS_WHY]({ workspaceId: WS, id: "item-1" });
    expect(checkRateLimit).not.toHaveBeenCalled();
    await handlers[IPC_CHANNELS.MEMORY_ITEMS_SET_PINNED]({
      workspaceId: WS,
      id: "item-1",
      pinned: true,
    });
    await handlers[IPC_CHANNELS.MEMORY_ITEMS_UPDATE]({
      workspaceId: WS,
      id: "item-1",
      content: "New text",
    });
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_ITEMS_SET_PINNED);
    expect(checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.MEMORY_ITEMS_UPDATE);
  });

  it("passes the Hub's workspace to item operations so ownership is checked in main", async () => {
    const { handlers, service } = setup();
    await handlers[IPC_CHANNELS.MEMORY_ITEMS_GET]({ workspaceId: WS, id: "item-1" });
    await handlers[IPC_CHANNELS.MEMORY_ITEMS_DELETE]({ workspaceId: WS, id: "item-1" });
    expect(service.get).toHaveBeenCalledWith(WS, "item-1");
    expect(service.delete).toHaveBeenCalledWith({ workspaceId: WS, id: "item-1" });
    await expect(
      handlers[IPC_CHANNELS.MEMORY_ITEMS_GET]({ workspaceId: WS, id: "" }),
    ).rejects.toThrow();
  });

  it("requires an explicit confirmation to clear global items", async () => {
    const { handlers, service } = setup();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_ITEMS_CLEAR_GLOBAL]({ workspaceId: WS }),
    ).rejects.toThrow();
    await expect(
      handlers[IPC_CHANNELS.MEMORY_ITEMS_CLEAR_GLOBAL]({ workspaceId: WS, confirm: "yes" }),
    ).rejects.toThrow();
    expect(service.clearGlobal).not.toHaveBeenCalled();
    await handlers[IPC_CHANNELS.MEMORY_ITEMS_CLEAR_GLOBAL]({ workspaceId: WS, confirm: true });
    expect(service.clearGlobal).toHaveBeenCalledTimes(1);
  });

  it("schemas reject unknown keys", () => {
    expect(
      MemoryItemsListRequestSchema.safeParse({ workspaceId: WS, workspaceIds: [OTHER_WS] }).success,
    ).toBe(false);
    expect(
      MemoryItemAddRequestSchema.safeParse({
        workspaceId: WS,
        content: "x y z",
        kind: "outcome",
        scope: "global",
      }).success,
    ).toBe(false);
    expect(
      MemoryItemsClearGlobalRequestSchema.safeParse({ workspaceId: WS, confirm: true }).success,
    ).toBe(true);
  });
});

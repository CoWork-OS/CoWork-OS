import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  buildPromptContext: vi.fn(),
  remember: vi.fn(),
  forget: vi.fn(),
}));

vi.mock("../SupermemoryService", () => ({
  SupermemoryService: {
    isConfigured: mocks.isConfigured,
    buildPromptContext: mocks.buildPromptContext,
    remember: mocks.remember,
    forget: mocks.forget,
  },
}));

import {
  ExternalMemoryProviderRegistry,
  SupermemoryExternalProvider,
} from "../ExternalMemoryProvider";

const workspace: Pick<Workspace, "id" | "name"> = {
  id: "ws1",
  name: "Workspace",
};

describe("ExternalMemoryProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isConfigured.mockReturnValue(true);
    mocks.buildPromptContext.mockResolvedValue("external profile");
  });

  it("prefetches Supermemory through the provider abstraction", async () => {
    const result = await new SupermemoryExternalProvider().prefetch({ workspace });

    expect(result?.providerId).toBe("supermemory");
    expect(result?.context).toBe("external profile");
    expect(mocks.buildPromptContext).toHaveBeenCalledWith({
      workspace,
      query: "",
    });
  });

  it("syncs trimmed turn memories and maps forget text to content", async () => {
    const provider = new SupermemoryExternalProvider();

    await provider.syncTurn({
      workspace,
      taskId: "task-1",
      sessionId: "session-1",
      memories: ["  prefers concise summaries  ", ""],
    });
    await provider.forget({ workspace, text: "old preference" });

    expect(mocks.remember).toHaveBeenCalledTimes(1);
    expect(mocks.remember).toHaveBeenCalledWith({
      workspace,
      content: "prefers concise summaries",
      metadata: {
        taskId: "task-1",
        sessionId: "session-1",
        source: "turn_sync",
      },
      origin: "background",
      taskId: "task-1",
    });
    expect(mocks.forget).toHaveBeenCalledWith({
      workspace,
      memoryId: undefined,
      content: "old preference",
    });
  });

  it("prefetchAll drops disabled providers and provider failures", async () => {
    const registry = new ExternalMemoryProviderRegistry([
      {
        id: "disabled",
        isEnabled: () => false,
        prefetch: vi.fn(),
        syncTurn: vi.fn(),
        extractSession: vi.fn(),
        forget: vi.fn(),
      },
      {
        id: "failing",
        isEnabled: () => true,
        prefetch: vi.fn().mockRejectedValue(new Error("offline")),
        syncTurn: vi.fn(),
        extractSession: vi.fn(),
        forget: vi.fn(),
      },
      {
        id: "ok",
        isEnabled: () => true,
        prefetch: vi.fn().mockResolvedValue({ providerId: "ok", context: "profile" }),
        syncTurn: vi.fn(),
        extractSession: vi.fn(),
        forget: vi.fn(),
      },
    ]);

    await expect(registry.prefetchAll({ workspace, query: "ship" })).resolves.toEqual([
      { providerId: "ok", context: "profile" },
    ]);
  });
});

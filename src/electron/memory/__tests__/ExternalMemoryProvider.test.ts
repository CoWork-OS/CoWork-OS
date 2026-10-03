import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  buildPromptContext: vi.fn(),
}));

vi.mock("../SupermemoryService", () => ({
  SupermemoryService: {
    isConfigured: mocks.isConfigured,
    buildPromptContext: mocks.buildPromptContext,
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

  it("prefetchAll drops disabled providers and provider failures", async () => {
    const registry = new ExternalMemoryProviderRegistry([
      {
        id: "disabled",
        isEnabled: () => false,
        prefetch: vi.fn(),
      },
      {
        id: "failing",
        isEnabled: () => true,
        prefetch: vi.fn().mockRejectedValue(new Error("offline")),
      },
      {
        id: "ok",
        isEnabled: () => true,
        prefetch: vi.fn().mockResolvedValue({ providerId: "ok", context: "profile" }),
      },
    ]);

    await expect(registry.prefetchAll({ workspace, query: "ship" })).resolves.toEqual([
      { providerId: "ok", context: "profile" },
    ]);
  });
});

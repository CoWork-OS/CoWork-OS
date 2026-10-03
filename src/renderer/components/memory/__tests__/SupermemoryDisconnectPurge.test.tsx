import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SupermemoryConfigStatus } from "../../../../shared/types";
import {
  SupermemoryDisconnectPurge,
  purgeConfirmMessage,
  runSupermemoryPurge,
} from "../SupermemoryDisconnectPurge";

const status = (overrides: Partial<SupermemoryConfigStatus> = {}): SupermemoryConfigStatus => ({
  enabled: true,
  apiKeyConfigured: true,
  baseUrl: "https://api.supermemory.ai",
  containerTagTemplate: "cowork:{workspaceId}",
  includeProfileInPrompt: true,
  mirrorMemoryWrites: true,
  searchMode: "hybrid",
  rerank: true,
  threshold: 0.55,
  customContainers: [],
  isConfigured: true,
  ...overrides,
});

describe("Supermemory Disconnect & purge", () => {
  it("shows the button and recorded copies only while enabled", () => {
    const html = renderToStaticMarkup(
      <SupermemoryDisconnectPurge status={status({ mirroredCopies: 3 })} />,
    );
    expect(html).toContain("Disconnect &amp; purge");
    expect(html).toContain("3 copies on record");
    expect(
      renderToStaticMarkup(<SupermemoryDisconnectPurge status={status({ enabled: false })} />),
    ).toBe("");
    expect(renderToStaticMarkup(<SupermemoryDisconnectPurge status={null} />)).toBe("");
  });

  it("asks first and does nothing when the user cancels", async () => {
    const purge = vi.fn();
    const confirm = vi.fn((_message: string) => false);
    expect(await runSupermemoryPurge({ recorded: 2, confirm, purge })).toBeNull();
    expect(confirm.mock.calls[0][0]).toContain("delete 2 copies CoWork recorded");
    expect(purge).not.toHaveBeenCalled();
    expect(purgeConfirmMessage(null)).toContain("every memory copy CoWork recorded");
  });

  it("reports the outcome of the purge", async () => {
    const ok = await runSupermemoryPurge({
      recorded: 1,
      confirm: () => true,
      purge: async () => ({
        success: true,
        disabled: true,
        forgotten: 1,
        failed: 0,
        errors: [],
      }),
    });
    expect(ok).toMatchObject({ tone: "success", text: expect.stringContaining("Deleted 1 copy") });

    const failed = await runSupermemoryPurge({
      recorded: 1,
      confirm: () => true,
      purge: async () => ({
        success: false,
        disabled: false,
        forgotten: 0,
        failed: 1,
        errors: [],
        error: "1 remote copy could not be deleted",
      }),
    });
    expect(failed).toMatchObject({ tone: "error", text: "1 remote copy could not be deleted" });

    const thrown = await runSupermemoryPurge({
      recorded: 1,
      confirm: () => true,
      purge: async () => {
        throw new Error("IPC down");
      },
    });
    expect(thrown).toMatchObject({ tone: "error", text: "IPC down", result: null });
  });
});

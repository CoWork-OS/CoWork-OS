import { afterEach, describe, expect, it, vi } from "vitest";

const handle = vi.fn();
vi.mock("electron", () => ({ ipcMain: { handle: (...args: unknown[]) => handle(...args) } }));

import { IPC_CHANNELS } from "../../../shared/types";
import {
  parseSpeculativeRunListQuery,
  setupSpeculativeRunHandlers,
} from "../speculative-run-handlers";
import type { SpeculativeFixService } from "../../triggers/SpeculativeFixService";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

afterEach(() => handle.mockReset());

describe("speculative run IPC", () => {
  it("uses the shared channel constant", () => {
    expect(IPC_CHANNELS.SPECULATIVE_RUNS_LIST).toBe("speculativeRuns:list");
  });

  it("validates the renderer's query", () => {
    expect(parseSpeculativeRunListQuery(undefined)).toEqual({});
    expect(parseSpeculativeRunListQuery({ workspaceId: WORKSPACE, limit: 5 })).toEqual({
      workspaceId: WORKSPACE,
      limit: 5,
    });
    for (const bad of [
      { limit: 0 },
      { limit: 1000 },
      { limit: 2.5 },
      { workspaceId: "../etc" },
      { workspaceId: WORKSPACE, extra: true },
      "ws-1",
    ]) {
      expect(() => parseSpeculativeRunListQuery(bad)).toThrow();
    }
  });

  it("lists runs through the active service and returns none without one", async () => {
    const listRuns = vi.fn(() => [{ id: "run-1" }]);
    let service: Pick<SpeculativeFixService, "listRuns"> | null = { listRuns };
    setupSpeculativeRunHandlers(() => service as SpeculativeFixService | null);
    const [channel, handler] = handle.mock.calls[0] as [
      string,
      (event: unknown, raw: unknown) => Promise<unknown>,
    ];
    expect(channel).toBe(IPC_CHANNELS.SPECULATIVE_RUNS_LIST);

    await expect(handler({}, { workspaceId: WORKSPACE, limit: 3 })).resolves.toEqual([
      { id: "run-1" },
    ]);
    expect(listRuns).toHaveBeenCalledWith({ workspaceId: WORKSPACE, limit: 3 });
    await expect(handler({}, { limit: "all" })).rejects.toThrow();

    service = null;
    await expect(handler({}, {})).resolves.toEqual([]);
  });
});

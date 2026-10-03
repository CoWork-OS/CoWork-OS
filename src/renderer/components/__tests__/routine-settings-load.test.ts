import { describe, expect, it, vi } from "vitest";
import { loadRoutineSettingsData } from "../routine-settings-load";
import { getRoutineListDisplayState } from "../routine-list-state";

function loaders() {
  return {
    routines: vi.fn(async () => [{ id: "test-routine" }]),
    runs: vi.fn(async () => [{ routineId: "test-routine" }]),
    workspaces: vi.fn(async () => [{ id: "test-workspace" }]),
    hooks: vi.fn(async () => ({ status: null, settings: null })),
    servers: vi.fn(async () => []),
    cron: vi.fn(async () => null),
  };
}

describe("routine settings loading", () => {
  it("retains routines and runs when workspace listing times out, then recovers on retry", async () => {
    const calls = loaders();
    const error = new Error("Deadline passed before statements.readUnit started");
    calls.workspaces.mockRejectedValueOnce(error);
    const result = await loadRoutineSettingsData(calls);
    expect(result.routines).toEqual({ status: "fulfilled", value: [{ id: "test-routine" }] });
    expect(result.runs).toEqual({ status: "fulfilled", value: [{ routineId: "test-routine" }] });
    expect(result.workspaces).toEqual({ status: "rejected", reason: error });
    expect((await loadRoutineSettingsData(calls)).workspaces).toEqual({
      status: "fulfilled",
      value: [{ id: "test-workspace" }],
    });
  });

  it("keeps a failed routine read unavailable instead of showing an empty list", async () => {
    const calls = loaders();
    calls.routines.mockRejectedValueOnce(new Error("Host unavailable"));
    const result = await loadRoutineSettingsData(calls);
    expect(result.routines.status).toBe("rejected");
    expect(getRoutineListDisplayState(result.routines.status === "fulfilled", 0)).toBe(
      "unavailable",
    );
    expect(result.workspaces.status).toBe("fulfilled");
  });

  it("isolates optional metadata failures including synchronous host API errors", async () => {
    const calls = loaders();
    calls.hooks.mockRejectedValueOnce(new Error("Hooks unavailable"));
    calls.servers.mockImplementationOnce(() => {
      throw new Error("Connector API unavailable");
    });
    const result = await loadRoutineSettingsData(calls);
    expect(result.routines.status).toBe("fulfilled");
    expect(result.workspaces.status).toBe("fulfilled");
    expect(result.hooks.status).toBe("rejected");
    expect(result.servers.status).toBe("rejected");
    expect(calls.cron).toHaveBeenCalledOnce();
  });
});

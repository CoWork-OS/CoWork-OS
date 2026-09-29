import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp") } }));
vi.mock("../../database/async/runtime", () => ({
  getDatabaseClient: vi.fn(async () => runtime.client),
}));

import { AgentDaemon } from "../daemon";
import { TaskEventRepository } from "../../database/repositories";

// DB2 pilot: which backend daemon maintenance uses, fixed per run.
describe("AgentDaemon database maintenance backend", () => {
  afterEach(() => {
    runtime.client = null;
    vi.restoreAllMocks();
  });

  const createDaemon = () =>
    Object.assign(Object.create(AgentDaemon.prototype), {
      dbManager: { getDatabase: () => ({}) },
      vacuumWhenIdle: vi.fn(),
      runSessionAutoPrune: vi.fn(async () => undefined),
    }) as Any;

  it("prunes through the worker in batches and reads storage stats when it is running", async () => {
    const hostPrune = vi.spyOn(TaskEventRepository.prototype, "pruneOldEvents");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ deleted: 500 })
      .mockResolvedValueOnce({ deleted: 12 })
      .mockResolvedValueOnce({ pageSize: 4096, pageCount: 10, freelistCount: 0, freelistBytes: 0 });
    runtime.client = { execute };
    const daemon = createDaemon();

    await daemon.runDatabaseMaintenance();

    expect(hostPrune).not.toHaveBeenCalled();
    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      "maintenance.pruneTaskEventsBatch",
      "maintenance.pruneTaskEventsBatch",
      "maintenance.storageStats",
    ]);
    expect(daemon.vacuumWhenIdle).toHaveBeenCalledWith(500);
  });

  it("does not fall back to host pruning when the worker fails mid-run", async () => {
    const hostPrune = vi.spyOn(TaskEventRepository.prototype, "pruneOldEvents");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtime.client = { execute: vi.fn().mockRejectedValue(new Error("worker exited")) };

    await createDaemon().runDatabaseMaintenance();

    expect(hostPrune).not.toHaveBeenCalled();
    expect(
      errors.mock.calls.some(([message]) => String(message).includes("DB maintenance failed")),
    ).toBe(true);
  });

  it("uses the host backend when this run has no worker", async () => {
    const hostPrune = vi
      .spyOn(TaskEventRepository.prototype, "pruneOldEvents")
      .mockResolvedValue(3);

    await createDaemon().runDatabaseMaintenance();

    expect(hostPrune).toHaveBeenCalledWith(90);
  });
});

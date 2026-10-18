import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storageStatements: vi.fn(),
  getReportingReader: vi.fn(),
}));

vi.mock("../../database/repository-facades", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../database/repository-facades")>()),
  storageStatements: mocks.storageStatements,
}));
vi.mock("../../database/async/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../database/async/runtime")>()),
  getReportingReader: mocks.getReportingReader,
}));

import { AgentDaemon } from "../daemon";

afterEach(() => vi.clearAllMocks());

function scanWith(port: { usesWorker: () => boolean; unit: ReturnType<typeof vi.fn> }) {
  mocks.storageStatements.mockReturnValue(port);
  const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
    getDatabase: () => ({}),
  }) as Any;
  return AgentDaemon.prototype["scanUnstartedUserFollowUps"].call(daemonLike) as () => Promise<
    string[] | null
  >;
}

describe("AgentDaemon startup follow-up recovery scan", () => {
  it("starts the worker scan once the reporting reader is up, without waiting for its consumer", async () => {
    let readerReady: (reader: unknown) => void = () => undefined;
    mocks.getReportingReader.mockReturnValue(new Promise((resolve) => (readerReady = resolve)));
    const port = { usesWorker: () => true, unit: vi.fn().mockResolvedValue(["task-1"]) };

    const candidates = scanWith(port);
    await Promise.resolve();
    expect(port.unit).not.toHaveBeenCalled();

    readerReady({});
    await vi.waitFor(() =>
      expect(port.unit).toHaveBeenCalledWith("taskEvent_findUnstartedFollowUpTaskIds", []),
    );
    await expect(candidates()).resolves.toEqual(["task-1"]);
    await expect(candidates()).resolves.toEqual(["task-1"]);
    expect(port.unit).toHaveBeenCalledTimes(1);
  });

  it("defers the scan on the host backend until the delayed resume consumes it", async () => {
    const port = { usesWorker: () => false, unit: vi.fn().mockResolvedValue(["task-1"]) };

    const candidates = scanWith(port);
    await Promise.resolve();

    expect(mocks.getReportingReader).not.toHaveBeenCalled();
    expect(port.unit).not.toHaveBeenCalled();
    await expect(candidates()).resolves.toEqual(["task-1"]);
  });

  it("reports a failed scan as unavailable so startup falls back to the full host check", async () => {
    mocks.getReportingReader.mockResolvedValue(null);
    const port = {
      usesWorker: () => true,
      unit: vi.fn().mockRejectedValue(new Error("worker unavailable")),
    };

    await expect(scanWith(port)()).resolves.toBeNull();
  });
});

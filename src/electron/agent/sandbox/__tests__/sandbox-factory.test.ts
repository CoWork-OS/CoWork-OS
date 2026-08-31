import { EventEmitter } from "events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

import { isMacOSSandboxAvailable, resetMacOSSandboxCache } from "../sandbox-factory";

function makeChildProcess(
  options: {
    closeCode?: number;
    stdout?: string;
    stderr?: string;
    errorMessage?: string;
    stayOpen?: boolean;
  } = {},
): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new EventEmitter() as ChildProcess["stdout"];
  proc.stderr = new EventEmitter() as ChildProcess["stderr"];
  proc.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  if (!options.stayOpen) {
    queueMicrotask(() => {
      if (options.stdout) proc.stdout?.emit("data", Buffer.from(options.stdout));
      if (options.stderr) proc.stderr?.emit("data", Buffer.from(options.stderr));
      if (options.errorMessage) {
        proc.emit("error", new Error(options.errorMessage));
        return;
      }
      proc.emit("close", options.closeCode ?? 0, null);
    });
  }
  return proc;
}

describe("sandbox factory macOS probe", () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMacOSSandboxCache();
    spawnMock.mockReset();
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });

  afterEach(() => {
    resetMacOSSandboxCache();
    platformSpy.mockRestore();
    vi.useRealTimers();
  });

  it("reports macOS sandbox-exec available after a successful probe", async () => {
    spawnMock.mockReturnValueOnce(makeChildProcess({ closeCode: 0, stdout: "ok\n" }));

    await expect(isMacOSSandboxAvailable()).resolves.toBe(true);

    expect(spawnMock).toHaveBeenCalledWith(
      "sandbox-exec",
      ["-p", "(version 1)\n(allow default)", "/bin/echo", "ok"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("reports macOS sandbox-exec unavailable when sandbox_apply fails", async () => {
    spawnMock.mockReturnValueOnce(
      makeChildProcess({ closeCode: 134, stderr: "sandbox_apply: Operation not permitted\n" }),
    );

    await expect(isMacOSSandboxAvailable()).resolves.toBe(false);
  });

  it("reports macOS sandbox-exec unavailable after spawn errors", async () => {
    spawnMock.mockReturnValueOnce(makeChildProcess({ errorMessage: "spawn sandbox-exec ENOENT" }));

    await expect(isMacOSSandboxAvailable()).resolves.toBe(false);
  });

  it("reports macOS sandbox-exec unavailable after probe timeout", async () => {
    vi.useFakeTimers();
    const proc = makeChildProcess({ stayOpen: true });
    spawnMock.mockReturnValueOnce(proc);

    const available = isMacOSSandboxAvailable();
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(available).resolves.toBe(false);
    expect(proc.kill).toHaveBeenCalled();
  });
});

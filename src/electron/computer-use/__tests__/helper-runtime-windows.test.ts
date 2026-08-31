import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUseHelperRuntime } from "../helper-runtime";

const existsSyncMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    mkdir: mkdirMock,
    readFile: readFileMock,
    writeFile: writeFileMock,
  };
});

vi.mock("../utils/user-data-dir", () => ({
  getUserDataDir: () => "/tmp/cowork-user-data",
}));

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

describe("ComputerUseHelperRuntime Windows helper integrity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform("win32");
    ComputerUseHelperRuntime.resetForTesting();
    mkdirMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    ComputerUseHelperRuntime.resetForTesting();
  });

  it("rewrites the installed helper when its content hash differs from the bundled source", async () => {
    const runtime = ComputerUseHelperRuntime.getInstance();
    const sourcePath = "/repo/resources/computer-use/bridge.ps1";
    const helperPath = runtime.getHelperPath();

    existsSyncMock.mockImplementation((target: unknown) => {
      const value = String(target);
      return (
        value.endsWith("resources/computer-use/bridge.ps1") ||
        value === helperPath ||
        value.endsWith("bridge.sha256")
      );
    });
    readFileMock.mockImplementation(async (target: unknown) => {
      const value = String(target);
      if (value.endsWith("resources/computer-use/bridge.ps1")) return Buffer.from("bundled-helper");
      if (value === helperPath) return Buffer.from("tampered-helper");
      if (value.endsWith("bridge.sha256")) {
        return "a9625693407f1961dce752a588924d898995be6d58cf164d52516fcc32bfb005\n";
      }
      throw new Error(`Unexpected read: ${value}`);
    });

    await (runtime as { ensureHelperInstalled: () => Promise<void> }).ensureHelperInstalled();

    expect(writeFileMock).toHaveBeenCalledWith(helperPath, Buffer.from("bundled-helper"), "utf8");
  });
});

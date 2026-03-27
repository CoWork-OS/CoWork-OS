import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accessSyncMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("fs", () => ({
  accessSync: accessSyncMock,
  existsSync: vi.fn(() => true),
  constants: { X_OK: 1 },
}));

vi.mock("child_process", () => ({
  spawn: spawnMock,
}));

let platformSpy: ReturnType<typeof vi.spyOn> | null = null;
let directLaunchEnv: string | undefined;

function createBridgeProcess(response: unknown, exitCode = 0, stderrText = "") {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (encoding: string) => void };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void };
    stdin: { end: (chunk: string) => void };
  };
  child.stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  child.stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
  child.stdout.setEncoding = vi.fn();
  child.stderr.setEncoding = vi.fn();
  child.stdin = {
    end: (chunk: string) => {
      void chunk;
      process.nextTick(() => {
        if (stderrText) {
          child.stderr.emit("data", stderrText);
        }
        child.stdout.emit("data", `${JSON.stringify(response)}\n`);
        child.emit("close", exitCode);
      });
    },
  };
  return child;
}

describe("AppleHealthBridge", () => {
  beforeEach(() => {
    vi.resetModules();
    accessSyncMock.mockReset();
    spawnMock.mockReset();
    accessSyncMock.mockImplementation(() => undefined);
    platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    directLaunchEnv = process.env.COWORK_HEALTHKIT_BRIDGE_DIRECT;
    process.env.COWORK_HEALTHKIT_BRIDGE_DIRECT = "1";
  });

  afterEach(() => {
    platformSpy?.mockRestore();
    platformSpy = null;
    if (directLaunchEnv === undefined) {
      delete process.env.COWORK_HEALTHKIT_BRIDGE_DIRECT;
    } else {
      process.env.COWORK_HEALTHKIT_BRIDGE_DIRECT = directLaunchEnv;
    }
  });

  it("parses status, authorization, sync, and write responses from the helper", async () => {
    spawnMock.mockImplementation(() => createBridgeProcess({
      ok: true,
      data: {
        available: true,
        executablePath: "/tmp/HealthKitBridge",
        authorizationStatus: "authorized",
        readableTypes: ["steps", "sleep"],
        writableTypes: ["steps", "sleep"],
        sourceMode: "native",
        lastSyncedAt: 123,
        lastError: undefined,
      },
    }));
    const { AppleHealthBridge } = await import("../apple-health-bridge");

    const status = await AppleHealthBridge.getStatus("native");
    expect(status.available).toBe(true);
    expect(spawnMock).toHaveBeenCalled();

    spawnMock.mockImplementation(() =>
      createBridgeProcess({
        ok: true,
        data: {
          granted: true,
          authorizationStatus: "authorized",
          readableTypes: ["steps"],
          writableTypes: ["steps"],
          sourceMode: "native",
        },
      }),
    );
    const auth = await AppleHealthBridge.authorize("native", ["steps"], ["steps"]);
    expect(auth.granted).toBe(true);

    spawnMock.mockImplementation(() =>
      createBridgeProcess({
        ok: true,
        data: {
          permissions: { read: true, write: true },
          readableTypes: ["steps"],
          writableTypes: ["steps"],
          metrics: [
            {
              key: "steps",
              value: 1234,
              unit: "steps",
              label: "Steps",
              recordedAt: 123,
            },
          ],
          records: [],
          sourceMode: "native",
          lastSyncedAt: 123,
        },
      }),
    );
    const sync = await AppleHealthBridge.sync("source-1", "native", ["steps"], ["steps"], 1);
    expect(sync?.metrics).toHaveLength(1);

    spawnMock.mockImplementation(() =>
      createBridgeProcess({
        ok: true,
        data: {
          writtenCount: 1,
          warnings: [],
        },
      }),
    );
    const write = await AppleHealthBridge.write("source-1", "native", [
      {
        id: "item-1",
        type: "steps",
        label: "Steps",
        value: "1234",
      },
    ]);
    expect(write?.writtenCount).toBe(1);
  });

  it("maps helper failures to unavailable status", async () => {
    spawnMock.mockImplementation(() =>
      createBridgeProcess(
        {
          ok: false,
          error: { code: "AUTH", message: "Denied" },
        },
        0,
      ),
    );
    const { AppleHealthBridge } = await import("../apple-health-bridge");
    const status = await AppleHealthBridge.getStatus("native");
    expect(status.available).toBe(false);
    expect(status.lastError).toContain("Denied");
  });

  it("surfaces a provisioning guidance error before bundle launch when the embedded profile is missing", async () => {
    vi.resetModules();
    accessSyncMock.mockReset();
    spawnMock.mockReset();
    accessSyncMock.mockImplementation(() => undefined);
    vi.doMock("fs", () => ({
      accessSync: accessSyncMock,
      existsSync: vi.fn((candidate: string) => !candidate.endsWith("embedded.provisionprofile")),
      constants: { X_OK: 1 },
      mkdtempSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(),
      rmSync: vi.fn(),
    }));
    delete process.env.COWORK_HEALTHKIT_BRIDGE_DIRECT;

    const { AppleHealthBridge } = await import("../apple-health-bridge");
    const status = await AppleHealthBridge.getStatus("native");

    expect(status.available).toBe(false);
    expect(status.lastError).toContain("embedded provisioning profile");
    expect(status.lastError).toContain("com.cowork.healthkitbridge");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

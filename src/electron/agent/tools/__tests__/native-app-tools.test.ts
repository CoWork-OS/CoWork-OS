import { describe, it, expect, vi, afterEach } from "vitest";
import { NativeAppTools, NativeAppInputSchema, NATIVE_APP_TOOL } from "../native-app-tools";
import { beginPrivateSurface } from "../../../browser/credentials/private-capture-guard";
import { HelperTransportError, HelperCommandError } from "../../../computer-use/helper-runtime";
import {
  normalizeNativeComputerUseMode,
  isComputerUseToolName,
} from "../../../../shared/computer-use-contract";
import { buildNormalizedToolResult } from "../../executor-tool-execution-utils";
vi.mock("../../../applications/native-desktop-session", () => ({
  requireNativeDesktopSession: vi.fn(async () => {}),
}));
vi.mock("../../../computer-use/session-manager", () => ({
  ComputerUseSessionManager: {
    getInstance: () => ({
      acquire: vi.fn(),
      acquireOrWait: vi.fn(async () => undefined),
      checkNotAborted: vi.fn(),
    }),
  },
}));
const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  vi.restoreAllMocks();
});
const snapshotId = "12345678-1234-4123-8123-123456789abc",
  token = "12345678-1234-4123-8123-123456789abd";
const action = {
  action: "set_value",
  pid: 42,
  windowId: 100,
  snapshotId,
  token,
  expectedValue: "old",
  value: "new",
};
function fixture(events: Array<{ type: string; payload: Record<string, unknown> }> = []) {
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  const runtime = {
    ensureReadyWithInteractivePermissions: vi.fn(async () => {}),
    background: vi.fn(async () => ({ dispatch: "acknowledged", effect: "unverified" })),
    listApps: vi.fn(async () => [{ pid: 42, bundleId: "com.example.target" }]),
    listWindows: vi.fn(async (): Promise<Array<{ title?: string }>> => []),
  };
  const daemon = {
    getTaskConsentAuthority: vi.fn(async () => "authority-1"),
    timelineRowsCommitted: vi.fn(async () => {}),
    getTaskEvents: () => events,
    requestApproval: vi.fn(async () => true),
    logEvent: vi.fn((_taskId: string, type: string, payload: Record<string, unknown>) =>
      events.push({ type, payload }),
    ),
  };
  const files = { authorizeApplicationPath: vi.fn(async () => "/tmp/fixture.psd") };
  const tools = new NativeAppTools(files as never, daemon as never, "task", runtime as never);
  return { runtime, daemon, files, tools, events };
}
describe("strict background native app control", () => {
  it("uses existing desktop permission and exclusive tool boundaries", () => {
    expect(isComputerUseToolName("native_app")).toBe(true);
    expect(NATIVE_APP_TOOL.input_schema.type).toBe("object");
    expect(NATIVE_APP_TOOL.input_schema.properties).toHaveProperty("windowId");
    expect(NATIVE_APP_TOOL.runtime?.concurrencyClass).toBe("exclusive");
    expect(normalizeNativeComputerUseMode(undefined)).toBe("background");
    expect(normalizeNativeComputerUseMode("background_first")).toBe("background");
    expect(normalizeNativeComputerUseMode("visible")).toBe("visible");
  });
  it("accepts confirm as a token-scoped semantic action", () => {
    expect(
      NativeAppInputSchema.parse({ action: "confirm", pid: 42, windowId: 100, snapshotId, token }),
    ).toMatchObject({ action: "confirm" });
    expect(() =>
      NativeAppInputSchema.parse({ action: "confirm", pid: 42, windowId: 100, snapshotId }),
    ).toThrow();
  });
  it("rejects model-supplied session and foreground fields", () => {
    expect(() => NativeAppInputSchema.parse({ ...action, session: "forged" })).toThrow();
    expect(() => NativeAppInputSchema.parse({ ...action, foreground: true })).toThrow();
    expect(() => NativeAppInputSchema.parse({ ...action, expectedValue: undefined })).toThrow();
  });
  it("rediscovers running windows by bundleId without launching", async () => {
    const f = fixture();
    expect(() => NativeAppInputSchema.parse({ action: "windows" })).toThrow();
    expect(() =>
      NativeAppInputSchema.parse({ action: "windows", pid: 42, bundleId: "com.example.target" }),
    ).toThrow();
    expect(await f.tools.run({ action: "windows", bundleId: "com.example.target" })).toMatchObject({
      running: true,
      processes: [{ pid: 42, windows: [] }],
    });
    expect(await f.tools.run({ action: "windows", bundleId: "com.example.absent" })).toMatchObject({
      running: false,
      processes: [],
    });
    expect(f.runtime.background).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });
  it("persists before dispatch and never treats acknowledgement as verification", async () => {
    const f = fixture();
    f.runtime.background.mockImplementation(async () => {
      expect(f.daemon.timelineRowsCommitted).toHaveBeenCalled();
      expect(f.events.at(-1)?.payload.status).toBe("dispatching");
      return { dispatch: "acknowledged", effect: "unverified" };
    });
    expect(await f.tools.run(action)).toMatchObject({ effect: "unverified" });
    expect(f.events.map((e) => e.payload.status)).toEqual(["dispatching", "acknowledged"]);
    expect(f.runtime.background).toHaveBeenCalledTimes(2);
  });
  it("denied app consent does not dispatch", async () => {
    const f = fixture();
    f.daemon.requestApproval.mockResolvedValue(false);
    await expect(f.tools.run(action)).rejects.toThrow(/denied/);
    expect(f.runtime.background).not.toHaveBeenCalled();
  });
  it("reevaluates app consent when task authority changes", async () => {
    const f = fixture();
    await f.tools.run({ action: "windows", pid: 42 });
    await f.tools.run({ action: "windows", pid: 42 });
    expect(f.daemon.requestApproval).toHaveBeenCalledTimes(1);
    f.daemon.getTaskConsentAuthority.mockResolvedValue("authority-2");
    f.daemon.requestApproval.mockResolvedValue(false);
    await expect(f.tools.run(action)).rejects.toThrow(/denied/);
    expect(f.daemon.requestApproval).toHaveBeenCalledTimes(2);
    expect(f.runtime.background).not.toHaveBeenCalled();
  });
  it("refuses dispatch if the durable intent cannot commit", async () => {
    const f = fixture();
    f.daemon.timelineRowsCommitted.mockRejectedValue(new Error("journal unavailable"));
    await expect(f.tools.run(action)).rejects.toThrow(/journal unavailable/);
    expect(f.runtime.background).not.toHaveBeenCalled();
  });
  it("admits document read authority before any launch effects", async () => {
    const f = fixture();
    f.files.authorizeApplicationPath.mockRejectedValue(new Error("outside workspace"));
    await expect(
      f.tools.run({
        action: "launch",
        bundleId: "com.adobe.Photoshop",
        documentPath: "/tmp/source.psd",
      }),
    ).rejects.toThrow(/outside/);
    expect(f.runtime.background).not.toHaveBeenCalled();
  });
  it("blocks mutation after a lost reply across tool instances, retaining observation", async () => {
    const f = fixture();
    f.runtime.background.mockRejectedValueOnce(new HelperTransportError("lost reply"));
    await expect(f.tools.run(action)).rejects.toThrow(/lost reply/);
    const restarted = new NativeAppTools(
      f.files as never,
      f.daemon as never,
      "task",
      f.runtime as never,
    );
    await expect(restarted.run(action)).rejects.toThrow(/outcome_unknown/);
    await restarted.run({ action: "observe", pid: 42, windowId: 100, screenshot: false });
    expect(f.runtime.background).toHaveBeenCalledTimes(2);
    expect(f.events.at(-1)?.payload.status).toBe("outcome_unknown");
  });
  it("keeps stale pre-dispatch refusal distinct from unknown mutations", async () => {
    const f = fixture();
    f.runtime.background.mockRejectedValueOnce(new HelperCommandError("stale", "stale_snapshot"));
    await expect(f.tools.run(action)).rejects.toThrow(/stale/);
    expect(f.events.at(-1)?.payload.status).toBe("not_dispatched");
    await f.tools.run({ ...action, snapshotId: "12345678-1234-4123-8123-123456789abe" });
  });
  it("retains element tokens when attaching the native screenshot to the model", () => {
    const result = buildNormalizedToolResult({
      toolName: "native_app",
      result: {
        snapshotId,
        captureId: snapshotId,
        pid: 42,
        windowId: 100,
        elements: [{ token, role: "AXButton" }],
        imageBase64: "cG5n",
        mediaType: "image/png",
        width: 10,
        height: 10,
      },
      toolUseId: "tool",
      rawResult: "{}",
      sanitizeToolResult: (_t: string, r: string) => r,
      getToolFailureReason: () => "",
    });
    expect(JSON.stringify(result)).toContain(token);
  });
});

describe("native app private input races", () => {
  it("refuses an already active private surface before asking for app consent", async () => {
    const f = fixture();
    const close = beginPrivateSurface();
    try {
      await expect(f.tools.run(action)).rejects.toThrow(/private/i);
    } finally {
      close();
    }
    expect(f.runtime.ensureReadyWithInteractivePermissions).not.toHaveBeenCalled();
    expect(f.daemon.requestApproval).not.toHaveBeenCalled();
    expect(f.runtime.background).not.toHaveBeenCalled();
  });

  it("refuses dispatch if private input opens and closes while app consent waits", async () => {
    const f = fixture();
    let approve!: (value: boolean) => void;
    f.daemon.requestApproval.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
    );
    const operation = f.tools.run(action);
    await vi.waitFor(() => expect(approve).toBeDefined());
    beginPrivateSurface()();
    approve(true);
    await expect(operation).rejects.toThrow(/private/i);
    expect(f.runtime.background).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });

  it("discards an observation that crosses private input", async () => {
    const f = fixture();
    let finish!: (
      value: Awaited<ReturnType<typeof f.runtime.background>> & Record<string, unknown>,
    ) => void;
    f.runtime.background.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = f.tools.run({ action: "observe", pid: 42, windowId: 100 });
    await vi.waitFor(() => expect(finish).toBeDefined());
    beginPrivateSurface()();
    finish({
      dispatch: "acknowledged",
      effect: "unverified",
      capture: { pngBase64: "private pixels" },
      elements: [{ value: "private field" }],
    });
    await expect(operation).rejects.toThrow(/private/i);
    expect(f.events).toEqual([]);
  });

  it("records an interrupted dispatched action as unknown and blocks replay", async () => {
    const f = fixture();
    let finish!: (
      value: Awaited<ReturnType<typeof f.runtime.background>> & Record<string, unknown>,
    ) => void;
    f.runtime.background.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = f.tools.run(action);
    await vi.waitFor(() => expect(finish).toBeDefined());
    beginPrivateSurface()();
    finish({
      dispatch: "acknowledged",
      effect: "unverified",
      preservation: { secret: "private field" },
    });
    await expect(operation).rejects.toThrow(/outcome_unknown/);
    expect(f.events.map((event) => event.payload.status)).toEqual([
      "dispatching",
      "outcome_unknown",
    ]);
    expect(JSON.stringify(f.events)).not.toContain("private field");
    expect(f.runtime.background).toHaveBeenCalledTimes(1);
    await expect(f.tools.run(action)).rejects.toThrow(/outcome_unknown/);
  });

  it("discards mandatory post-action readback that crosses private input", async () => {
    const f = fixture();
    let finish!: (
      value: Awaited<ReturnType<typeof f.runtime.background>> & Record<string, unknown>,
    ) => void;
    f.runtime.background.mockImplementationOnce(async () => ({
      dispatch: "acknowledged",
      effect: "unverified",
    }));
    f.runtime.background.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = f.tools.run(action);
    await vi.waitFor(() => expect(finish).toBeDefined());
    beginPrivateSurface()();
    finish({
      dispatch: "acknowledged",
      effect: "unverified",
      capture: { pngBase64: "private pixels" },
    });
    await expect(operation).rejects.toThrow(/readback failed/);
    expect(f.events.map((event) => event.payload.status)).toEqual([
      "dispatching",
      "outcome_unknown",
    ]);
    expect(JSON.stringify(f.events)).not.toContain("private pixels");
  });

  it.each([
    { action: "windows", pid: 42 },
    { action: "windows", bundleId: "com.example.target" },
  ])("discards private window titles during discovery: %j", async (input) => {
    const f = fixture();
    let finish!: (value: Awaited<ReturnType<typeof f.runtime.listWindows>>) => void;
    f.runtime.listWindows.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = f.tools.run(input);
    await vi.waitFor(() => expect(finish).toBeDefined());
    beginPrivateSurface()();
    finish([{ title: "private field" }]);
    await expect(operation).rejects.toThrow(/private/i);
    expect(f.events).toEqual([]);
  });
});

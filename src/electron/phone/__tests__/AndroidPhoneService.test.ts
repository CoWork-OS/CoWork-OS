import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AndroidPhoneService, type PhoneProcessRunner } from "../AndroidPhoneService";
import { AndroidPhoneInputSchema } from "../../../shared/android-phone";
import { AndroidPhoneTools } from "../../agent/tools/android-phone-tools";
import { buildNormalizedToolResult } from "../../agent/executor-tool-execution-utils";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-phone-test-"));
  roots.push(root);
  const observation = {
    deviceId: "selected",
    createdAt: Date.now(),
    width: 1080,
    height: 2220,
    package: "com.android.settings",
    stateDigest: "digest",
    texts: ["Settings"],
    elements: [],
    secure: false,
    treeAvailable: true,
    securityKnown: true,
    imageBase64: Buffer.from("fixture").toString("base64"),
  };
  const runner = vi.fn<PhoneProcessRunner>(async (_file, args, _input) =>
    args[0] === "devices"
      ? "List of devices attached\nselected device model:Pixel_8\nother unauthorized model:Other\noffline-id offline\n"
      : JSON.stringify({
          observation,
          receipt: {
            status: "completed",
            deviceId: "selected",
            requestDigest: "digest",
          },
        }),
  );
  const service = new AndroidPhoneService(root, runner);
  await fs.mkdir(path.dirname(service.pythonPath), { recursive: true });
  await fs.writeFile(service.pythonPath, "");
  await service.install();
  runner.mockClear();
  await service.saveSettings({ enabled: true, deviceId: "selected" });
  return { root, service, runner, observation };
}
describe("Android selected-device boundaries", () => {
  it("does not report a partial runtime as installed when dependency installation fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-phone-partial-"));
    roots.push(root);
    const runner = vi.fn<PhoneProcessRunner>(async (_file, args) => {
      if (args[0] === "devices") return "selected device model:Pixel\n";
      if (args.includes("pip")) throw new Error("Dependency download failed");
      return "";
    });
    const service = new AndroidPhoneService(root, runner);
    await fs.mkdir(path.dirname(service.pythonPath), { recursive: true });
    await fs.writeFile(service.pythonPath, "");
    expect((await service.status()).runtimeInstalled).toBe(false);
    await expect(service.install()).rejects.toThrow(/Dependency download failed/);
    expect((await service.status()).runtimeInstalled).toBe(false);
  });

  it("keeps Stop last when it overlaps an earlier settings write", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return rename(...args);
    });
    try {
      const enabling = f.service.saveSettings({ enabled: true, deviceId: "selected" });
      await waiting;
      const stopping = f.service.saveSettings({ enabled: false, deviceId: "selected" });
      release();
      await Promise.all([enabling, stopping]);
      expect(await f.service.settings()).toEqual({ enabled: false, deviceId: "selected" });
    } finally {
      spy.mockRestore();
    }
  });

  it("does not dispatch if Stop is pressed during device discovery", async () => {
    const f = await fixture();
    const shot = await f.service.observe("task", "selected");
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.runner.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "selected device model:Pixel\n";
    });
    const pending = f.service.action("task", "operation", {
      deviceId: "selected",
      snapshotId: shot.captureId,
      action: { kind: "home" },
    });
    const rejected = expect(pending).rejects.toThrow(/stopped or changed/);
    await waiting;
    await f.service.saveSettings({ enabled: false, deviceId: "selected" });
    release();
    await rejected;
    expect(
      f.runner.mock.calls.filter((c) => c[2] && JSON.parse(c[2]).mode === "action"),
    ).toHaveLength(0);
  });

  it("invalidates approved input across Stop and re-enable, while preserving receipt readback", async () => {
    const f = await fixture();
    const input = AndroidPhoneInputSchema.parse({
      deviceId: "selected",
      snapshotId: "12345678-1234-4123-8123-123456789abc",
      action: { kind: "home" },
    });
    await f.service.recordActionApproval("task", "operation", input);
    await f.service.saveSettings({ enabled: false, deviceId: "selected" });
    await f.service.saveSettings({ enabled: true, deviceId: "selected" });
    await expect(f.service.requireActionApproval("task", "operation", input, true)).rejects.toThrow(
      /stopped or changed/,
    );
    await f.service.requireActionApproval("task", "operation", input);
    const restarted = new AndroidPhoneService(f.root, f.runner);
    await expect(restarted.requireActionApproval("task", "operation", input, true)).rejects.toThrow(
      /interrupted runtime/,
    );
    await restarted.requireActionApproval("task", "operation", input);
  });

  it("keeps screenshot-only observations read-only when security or accessibility is unknown", async () => {
    const f = await fixture();
    f.observation.treeAvailable = false;
    f.observation.securityKnown = false;
    const shot = await f.service.observe("task", "selected");
    expect(shot.imageBase64).toBeTruthy();
    await expect(
      f.service.snapshot("task", {
        deviceId: "selected",
        snapshotId: shot.captureId,
        action: { kind: "tap", x: 10, y: 10 },
      }),
    ).rejects.toThrow(/user handoff/);
  });
  it("starts disabled, lists authorization state and never silently selects a device", async () => {
    const f = await fixture();
    await f.service.saveSettings({ enabled: false });
    const status = await f.service.status();
    expect(status.devices.map((d) => d.state)).toEqual(["device", "unauthorized", "offline"]);
    await expect(f.service.observe("task", "selected")).rejects.toThrow(/Enable phone control/);
    expect(f.runner.mock.calls.every((c) => c[1][0] === "devices")).toBe(true);
  });
  it("never substitutes another connected device", async () => {
    const f = await fixture();
    await expect(f.service.observe("task", "other")).rejects.toThrow(/exact Android/);
    f.runner.mockResolvedValueOnce("List of devices attached\nother device\n");
    await expect(f.service.observe("task", "selected")).rejects.toThrow(/disconnected/);
  });
  it("persists task-owned snapshots and rejects cross-task or expired input", async () => {
    const f = await fixture();
    const shot = await f.service.observe("task", "selected");
    const input = AndroidPhoneInputSchema.parse({
      deviceId: "selected",
      snapshotId: shot.captureId,
      action: { kind: "home" },
    });
    await expect(f.service.snapshot("other-task", input)).rejects.toThrow(/stale_snapshot/);
    expect((await f.service.savedObservation("task", shot.captureId)).imageBase64).toBe(
      shot.imageBase64,
    );
    await expect(f.service.savedObservation("other-task", shot.captureId)).rejects.toThrow(
      /another task/,
    );
    f.observation.createdAt = Date.now() - 121_000;
    const old = await f.service.observe("task", "selected");
    await expect(
      f.service.snapshot("task", { ...input, snapshotId: old.captureId }),
    ).rejects.toThrow(/stale_snapshot/);
  });
  it("rejects unsupported scripts, invalid serials and Unicode instead of corrupting input", () => {
    for (const value of [
      { deviceId: "-s other", action: { kind: "home" } },
      { deviceId: "selected", action: { kind: "exec", code: "print(1)" } },
      { deviceId: "selected", action: { kind: "type_text", text: "Olá" } },
    ])
      expect(
        AndroidPhoneInputSchema.safeParse({
          snapshotId: "12345678-1234-4123-8123-123456789abc",
          ...value,
        }).success,
      ).toBe(false);
  });
  it("passes only the selected serial, structured action and original request identity", async () => {
    const f = await fixture();
    const shot = await f.service.observe("task", "selected");
    await f.service.action("task", "operation", {
      deviceId: "selected",
      snapshotId: shot.captureId,
      action: { kind: "home" },
    });
    const call = JSON.parse(f.runner.mock.calls.at(-1)![2]);
    expect(call).toMatchObject({
      deviceId: "selected",
      operationId: "operation",
      snapshotId: shot.captureId,
      action: { kind: "home" },
      stateDigest: "digest",
    });
    expect(call.code).toBeUndefined();
  });
});
describe("Android tool approval and image delivery", () => {
  it("cancels an open approval immediately when phone activity is stopped", async () => {
    const f = await fixture();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const tools = new AndroidPhoneTools(
      {
        getTask: () => ({}),
        requestApproval: (...args: unknown[]) =>
          new Promise<boolean>((_resolve, reject) => {
            const options = args[4] as { signal: AbortSignal };
            options.signal.addEventListener("abort", () => reject(new Error("Approval canceled")), {
              once: true,
            });
            entered();
          }),
      } as never,
      "task",
      f.service,
    );
    const pending = tools.run("android_phone_observe", { deviceId: "selected" });
    const rejected = expect(pending).rejects.toThrow(/Approval canceled/);
    await waiting;
    f.service.stop();
    await rejected;
    expect(f.runner.mock.calls.every((call) => call[1][0] === "devices")).toBe(true);
  });

  it("does not take an approved screenshot after Stop and re-enable during review", async () => {
    const f = await fixture();
    let approve!: (value: boolean) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const tools = new AndroidPhoneTools(
      {
        getTask: () => ({}),
        requestApproval: () => {
          entered();
          return new Promise<boolean>((resolve) => {
            approve = resolve;
          });
        },
      } as never,
      "task",
      f.service,
    );
    const pending = tools.run("android_phone_observe", { deviceId: "selected" });
    const rejected = expect(pending).rejects.toThrow(/stopped or changed/);
    await waiting;
    await f.service.saveSettings({ enabled: true, deviceId: "selected" });
    approve(true);
    await rejected;
    expect(f.runner.mock.calls.every((c) => c[1][0] === "devices")).toBe(true);
  });
  it("does not read back an unapproved action, including after restart", async () => {
    const f = await fixture();
    const input = AndroidPhoneInputSchema.parse({
      deviceId: "selected",
      snapshotId: "12345678-1234-4123-8123-123456789abc",
      action: { kind: "home" },
    });
    await expect(f.service.requireActionApproval("task", "operation", input)).rejects.toThrow(
      /not approved/,
    );
    await f.service.recordActionApproval("task", "operation", input);
    const restarted = new AndroidPhoneService(f.root, f.runner);
    await restarted.requireActionApproval("task", "operation", input);
    await expect(restarted.requireActionApproval("other-task", "operation", input)).rejects.toThrow(
      /not approved/,
    );
    await expect(
      restarted.requireActionApproval("task", "operation", { ...input, action: { kind: "back" } }),
    ).rejects.toThrow(/not approved/);
    expect(f.runner).not.toHaveBeenCalled();
  });

  it("approval denial performs no observation and cannot create a standing grant", async () => {
    const f = await fixture();
    const daemon = {
      getTask: () => ({}),
      requestApproval: vi.fn(async () => false),
    };
    const tools = new AndroidPhoneTools(daemon as never, "task", f.service);
    await expect(tools.run("android_phone_observe", { deviceId: "selected" })).rejects.toThrow(
      /denied/,
    );
    expect(f.runner.mock.calls.every((c) => c[1][0] === "devices")).toBe(true);
    expect(daemon.requestApproval.mock.calls[0][4]).toMatchObject({
      allowAutoApprove: false,
      requireExplicitApproval: true,
      noStandingApproval: true,
    });
  });
  it("refuses direct mutations and third-party gateway access", async () => {
    const f = await fixture();
    const daemon = {
      getTask: () => ({
        agentConfig: { originChannel: "telegram", gatewaySenderIsOwner: false },
      }),
    };
    await expect(
      new AndroidPhoneTools(daemon as never, "task", f.service).run("android_phone_devices", {}),
    ).rejects.toThrow(/third-party/);
    await expect(
      new AndroidPhoneTools({ getTask: () => ({}) } as never, "task", f.service).run(
        "android_phone_dispatch",
        {},
      ),
    ).rejects.toThrow(/durable/);
  });
  it("attaches the actual screenshot while retaining device and snapshot information", async () => {
    const f = await fixture();
    const shot = await f.service.observe("task", "selected");
    const { toolResult } = buildNormalizedToolResult({
      toolName: "android_phone_observe",
      toolUseId: "shot",
      result: shot,
      rawResult: JSON.stringify(shot),
      sanitizeToolResult: (_n, text) => text,
      getToolFailureReason: (_r, text) => text,
    });
    expect(toolResult.companion_user_content).toContainEqual({
      type: "image",
      data: shot.imageBase64,
      mimeType: "image/png",
    });
    expect(toolResult.content).toContain('"deviceId":"selected"');
    expect(toolResult.content).toContain(shot.captureId);
    expect(toolResult.content).not.toContain(shot.imageBase64);
    const operationScreen = {
      ...shot,
      phoneOperation: {
        operationId: "operation",
        execution: "completed",
        verification: "verified",
      },
    };
    const normalized = buildNormalizedToolResult({
      toolName: "application_operation",
      toolUseId: "action",
      result: operationScreen,
      rawResult: JSON.stringify(operationScreen),
      sanitizeToolResult: (_n, text) => text,
      getToolFailureReason: (_r, text) => text,
    });
    expect(JSON.parse(normalized.toolResult.content).phoneOperation).toEqual(
      operationScreen.phoneOperation,
    );
    expect(normalized.toolResult.companion_user_content).toContainEqual({
      type: "image",
      data: shot.imageBase64,
      mimeType: "image/png",
    });
  });
});

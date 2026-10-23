import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseTools } from "../computer-use-tools";
import { setComputerUseProviderFactoryForTesting } from "../../../computer-use/provider";
import { ComputerUseSessionManager } from "../../../computer-use/session-manager";
import { CuaSpaceProvider } from "../../../computer-use/cua-space/provider";
import { CuaSpaceSettingsManager } from "../../../computer-use/cua-space/settings";
import type { CuaSpaceClientLike, CuaToolResult } from "../../../computer-use/cua-space/client";

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  setComputerUseProviderFactoryForTesting(null);
  ComputerUseSessionManager.resetForTesting();
  ComputerUseTools.resetForTesting();
  vi.restoreAllMocks();
});

function pngBase64(width: number, height: number): string {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString("base64");
}

function spaceProvider(clickEffect: string) {
  const structured = (value: Record<string, unknown>): CuaToolResult => ({
    content: [],
    structuredContent: value,
  });
  const handlers: Record<string, () => CuaToolResult> = {
    list_apps: () => structured({ apps: [{ name: "TextEdit", pid: 42, active: true }] }),
    list_windows: () =>
      structured({
        windows: [
          { window_id: 8, pid: 42, title: "Doc", bounds: { x: 0, y: 0, width: 300, height: 200 } },
        ],
      }),
    get_window_state: () => ({
      content: [{ type: "image", data: pngBase64(300, 200), mimeType: "image/png" }],
      structuredContent: { elements: [] },
    }),
    bring_to_front: () => structured({}),
    click: () => structured({ effect: clickEffect }),
    press_key: () => structured({}),
  };
  const callTool = vi.fn(async (name: string) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected tool ${name}`);
    return handler();
  });
  const client: CuaSpaceClientLike = {
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    checkHealth: vi.fn().mockResolvedValue(true),
    callTool,
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { provider: new CuaSpaceProvider(client, "http://127.0.0.1:3211"), callTool };
}

function makeTools(daemon: Record<string, unknown>): ComputerUseTools {
  return new ComputerUseTools(
    { id: "w", name: "W", path: "/tmp", createdAt: 0, permissions: {} } as never,
    daemon as never,
    `task-${Math.random()}`,
  );
}

describe("ComputerUseTools with a Cua Space backend", () => {
  it("falls back to a pointer click inside the Space without asking or redirecting to native_app", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const { provider, callTool } = spaceProvider("suspected_noop");
    setComputerUseProviderFactoryForTesting(() => provider);
    const daemon = { logEvent: vi.fn(), requestApproval: vi.fn() };
    const tools = makeTools(daemon);

    const capture = await tools.screenshot();
    await tools.click(10, 10, "left", capture.captureId);

    expect(daemon.requestApproval).not.toHaveBeenCalled();
    const clicks = callTool.mock.calls.filter(([name]) => name === "click");
    expect(clicks.map(([, args]) => (args as { delivery_mode: string }).delivery_mode)).toEqual([
      "background",
      "foreground",
    ]);
  });

  it("allows keypresses in the Space even when native control is background-only", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const { provider, callTool } = spaceProvider("confirmed");
    setComputerUseProviderFactoryForTesting(() => provider);
    const tools = makeTools({ logEvent: vi.fn(), requestApproval: vi.fn() });

    await tools.screenshot();
    await tools.pressKeys(["return"]);

    expect(callTool).toHaveBeenCalledWith("press_key", {
      key: "return",
      target: { kind: "window", pid: 42, window_id: 8 },
    });
  });

  it("tells the model when the tools act in the Space", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const describeScreenshot = () =>
      ComputerUseTools.getToolDefinitions().find((tool) => tool.name === "screenshot")?.description;

    expect(describeScreenshot()).not.toContain("Cua Space");
    vi.spyOn(CuaSpaceSettingsManager, "load").mockReturnValue({
      enabled: true,
      url: "http://127.0.0.1:3211",
    });
    expect(describeScreenshot()).toContain("Cua Space");
  });

  it("fails the next action and forgets the target when the backend switches", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const space = spaceProvider("confirmed");
    let active: unknown = space.provider;
    setComputerUseProviderFactoryForTesting(() => active as never);
    const tools = makeTools({ logEvent: vi.fn(), requestApproval: vi.fn() });
    await tools.screenshot();

    const host = { ensureReadyWithInteractivePermissions: vi.fn(), pressKeys: vi.fn() };
    active = host;
    await expect(tools.screenshot()).rejects.toThrow(
      /switched between this computer and a Cua Space/,
    );
    expect(host.ensureReadyWithInteractivePermissions).not.toHaveBeenCalled();
    expect(host.pressKeys).not.toHaveBeenCalled();
  });
});

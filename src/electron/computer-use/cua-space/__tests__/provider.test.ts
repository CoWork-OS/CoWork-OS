import { describe, expect, it, vi } from "vitest";
import { CuaSpaceProvider } from "../provider";
import type { CuaSpaceClientLike, CuaToolResult } from "../client";

// 1x1 PNG with IHDR width=4, height=2 patched in.
function fakePngBase64(width: number, height: number): string {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString("base64");
}

function structured(value: Record<string, unknown>): CuaToolResult {
  return { content: [], structuredContent: value };
}

function makeClient(handlers: Record<string, (args: Record<string, unknown>) => CuaToolResult>) {
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected tool ${name}`);
    return handler(args);
  });
  const client: CuaSpaceClientLike = {
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    checkHealth: vi.fn().mockResolvedValue(true),
    callTool,
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { client, callTool };
}

const WINDOW_HANDLERS = {
  list_apps: () =>
    structured({
      apps: [
        { name: "Finder", bundle_id: "com.apple.finder", pid: 10, running: true },
        { name: "Safari", bundle_id: "com.apple.Safari", pid: 42, running: true, active: true },
        { name: "Notes", pid: 0, running: false },
      ],
    }),
  list_windows: () =>
    structured({
      windows: [
        {
          window_id: 7,
          pid: 42,
          title: "Background",
          bounds: { x: 0, y: 0, width: 400, height: 300 },
          z_index: 1,
          is_on_screen: true,
        },
        {
          window_id: 8,
          pid: 42,
          title: "Front",
          bounds: { x: 10, y: 20, width: 800, height: 600 },
          z_index: 5,
          is_on_screen: true,
        },
      ],
    }),
};

describe("CuaSpaceProvider", () => {
  it("maps apps, windows, and the frontmost target from Cua Driver records", async () => {
    const { client } = makeClient(WINDOW_HANDLERS);
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");

    const apps = await provider.listApps();
    expect(apps.map((app) => app.pid)).toEqual([10, 42]);

    const frontmost = await provider.getFrontmost();
    expect(frontmost).toMatchObject({
      appName: "Safari",
      pid: 42,
      windowId: 8,
      windowTitle: "Front",
    });

    const windows = await provider.listWindows(42);
    expect(windows.find((window) => window.isMain)?.windowId).toBe(8);
    expect(windows[1].framePoints).toEqual({ x: 10, y: 20, w: 800, h: 600 });
  });

  it("captures a window via get_window_state and binds later clicks to the capture", async () => {
    const png = fakePngBase64(1600, 1200);
    const { client, callTool } = makeClient({
      ...WINDOW_HANDLERS,
      get_window_state: () => ({
        content: [{ type: "image", data: png, mimeType: "image/png" }],
        structuredContent: {
          capture_id: "cap-1",
          elements: [
            { element_index: 0, element_token: "tok-search", role: "AXTextField", label: "Search" },
            {
              element_index: 1,
              element_token: "tok-pass",
              role: "AXTextField",
              subrole: "AXSecureTextField",
            },
          ],
        },
      }),
      click: () => structured({ effect: "confirmed" }),
      set_value: () => structured({ ok: true }),
    });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await provider.listWindows(42);

    const shot = await provider.screenshot(8);
    expect(shot).toEqual({ pngBase64: png, width: 1600, height: 1200, scaleFactor: 2 });

    const press = await provider.axPressAtPoint({
      windowId: 8,
      pid: 42,
      x: 100,
      y: 50,
      captureWidth: 1600,
      captureHeight: 1200,
    });
    expect(press.pressed).toBe(true);
    expect(callTool).toHaveBeenCalledWith("click", {
      target: { kind: "window", pid: 42, window_id: 8 },
      x: 100,
      y: 50,
      button: "left",
      count: 1,
      delivery_mode: "background",
      capture_id: "cap-1",
    });

    // The secure field is excluded, leaving one unambiguous text input.
    const input = await provider.axFocusTextInput({ pid: 42, windowId: 8 });
    expect(input).toMatchObject({ focused: true, canSetValue: true, isSecure: false });
    await provider.setValue(input.elementRef!, "hello");
    expect(callTool).toHaveBeenCalledWith("set_value", {
      pid: 42,
      element_token: "tok-search",
      value: "hello",
    });
  });

  it("never offers a secure field as a settable text input", async () => {
    const png = fakePngBase64(10, 10);
    const { client } = makeClient({
      ...WINDOW_HANDLERS,
      get_window_state: () => ({
        content: [{ type: "image", data: png, mimeType: "image/png" }],
        structuredContent: {
          elements: [{ element_token: "tok-pass", role: "AXSecureTextField", focused: true }],
        },
      }),
    });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await provider.listWindows(42);
    await provider.screenshot(8);

    const focused = await provider.focusedElement(42);
    expect(focused).toMatchObject({ exists: true, isSecure: true, canSetValue: false });
    await expect(provider.setValue(focused.elementRef!, "hunter2")).rejects.toThrow(/secure/);
    expect(await provider.axFocusTextInput({ pid: 42, windowId: 8 })).toMatchObject({
      focused: false,
    });
  });

  it("refuses to type while the captured focus is a secure field", async () => {
    const { client, callTool } = makeClient({
      ...WINDOW_HANDLERS,
      get_window_state: () => ({
        content: [{ type: "image", data: fakePngBase64(10, 10), mimeType: "image/png" }],
        structuredContent: {
          elements: [{ element_token: "tok-pass", role: "AXSecureTextField", focused: true }],
        },
      }),
      type_text: () => structured({}),
    });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await provider.listWindows(42);
    await provider.screenshot(8);
    await expect(provider.typeText("hunter2", 42, 8)).rejects.toThrow(/secure/);
    expect(callTool).not.toHaveBeenCalledWith("type_text", expect.anything());
  });

  it("refuses oversized screenshots before decoding them", async () => {
    const { client } = makeClient({
      ...WINDOW_HANDLERS,
      get_window_state: () => ({
        content: [{ type: "image", data: "A".repeat(45 * 1024 * 1024), mimeType: "image/png" }],
      }),
    });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await provider.listWindows(42);
    await expect(provider.screenshot(8)).rejects.toThrow(/larger than 32 MB/);
  });

  it("reports a suspected no-op press so the tools can escalate", async () => {
    const { client } = makeClient({ click: () => structured({ effect: "suspected_noop" }) });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    const press = await provider.axPressAtPoint({
      windowId: 8,
      pid: 42,
      x: 1,
      y: 1,
      captureWidth: 10,
      captureHeight: 10,
    });
    expect(press).toEqual({ pressed: false, reason: "cua_suspected_noop" });
  });

  it("sends combinations through hotkey and single keys through press_key", async () => {
    const { client, callTool } = makeClient({
      press_key: () => structured({}),
      hotkey: () => structured({}),
    });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await provider.pressKeys({ pid: 42, keyCode: 8, modifiers: ["command"], windowId: 8 });
    expect(callTool).toHaveBeenCalledWith("hotkey", {
      keys: ["cmd", "c"],
      target: { kind: "window", pid: 42, window_id: 8 },
    });
    await provider.pressKeys({ pid: 42, keyCode: 36 });
    expect(callTool).toHaveBeenLastCalledWith("press_key", { key: "return", pid: 42 });
    await provider.pressKeys({ pid: 42, keyCode: 116 });
    expect(callTool).toHaveBeenLastCalledWith("press_key", { key: "page_up", pid: 42 });
    await expect(provider.pressKeys({ pid: 42, keyCode: 999 })).rejects.toThrow(/key code 999/);
  });

  it("types into the last captured window, or by pid when none was captured", async () => {
    const png = fakePngBase64(10, 10);
    const { client, callTool } = makeClient({
      ...WINDOW_HANDLERS,
      get_window_state: () => ({
        content: [{ type: "image", data: png, mimeType: "image/png" }],
        structuredContent: { elements: [] },
      }),
      type_text: () => structured({}),
    });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await provider.typeText("hi", 42);
    expect(callTool).toHaveBeenLastCalledWith("type_text", {
      text: "hi",
      pid: 42,
      delivery_mode: "foreground",
    });
    await provider.listWindows(42);
    await provider.screenshot(8);
    await provider.typeText("hi", 42);
    expect(callTool).toHaveBeenLastCalledWith("type_text", {
      text: "hi",
      target: { kind: "window", pid: 42, window_id: 8 },
      delivery_mode: "foreground",
    });
  });

  it("hit-tests elements by screenshot_frame, never by screen-space frame", async () => {
    const png = fakePngBase64(200, 100);
    const { client } = makeClient({
      ...WINDOW_HANDLERS,
      get_window_state: () => ({
        content: [{ type: "image", data: png, mimeType: "image/png" }],
        structuredContent: {
          elements: [
            {
              element_token: "tok-screen-only",
              role: "AXButton",
              frame: { x: 0, y: 0, width: 50, height: 50 },
            },
            {
              element_token: "tok-ok",
              role: "AXButton",
              label: "OK",
              frame: { x: 900, y: 900, width: 40, height: 20 },
              screenshot_frame: { x: 100, y: 40, width: 40, height: 20 },
            },
            {
              element_token: "tok-invalid",
              role: "AXButton",
              screenshot_frame: { x: 0, y: 0, width: 200, height: 100 },
              screenshot_frame_valid: false,
            },
          ],
        },
      }),
    });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await provider.listWindows(42);
    await provider.screenshot(8);
    const base = { windowId: 8, pid: 42, captureWidth: 200, captureHeight: 100 };
    expect(await provider.axDescribeAtPoint({ ...base, x: 10, y: 10 })).toEqual({ found: false });
    expect(await provider.axDescribeAtPoint({ ...base, x: 110, y: 45 })).toMatchObject({
      found: true,
      title: "OK",
      x: 120,
      y: 50,
    });
  });

  it("surfaces screenshot_error when the Space returns no image", async () => {
    const { client } = makeClient({
      ...WINDOW_HANDLERS,
      get_window_state: () => structured({ screenshot_error: "permission_required" }),
    });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await provider.listWindows(42);
    await expect(provider.screenshot(8)).rejects.toThrow(/no screenshot: permission_required/);
  });

  it("moves the cursor in screenshot pixels with an exact window target", async () => {
    const { client, callTool } = makeClient({ move_cursor: () => structured({}) });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await provider.mouseMove({
      windowId: 8,
      pid: 42,
      x: 30,
      y: 40,
      captureWidth: 100,
      captureHeight: 100,
    });
    expect(callTool).toHaveBeenCalledWith("move_cursor", {
      target: { kind: "window", pid: 42, window_id: 8 },
      x: 30,
      y: 40,
    });
  });

  it("converts signed line deltas into Cua scroll directions", async () => {
    const { client, callTool } = makeClient({ scroll: () => structured({}) });
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    const base = { windowId: 8, pid: 42, x: 5, y: 5, captureWidth: 10, captureHeight: 10 };
    await provider.scrollAtPoint({ ...base, scrollX: 0, scrollY: -3 });
    expect(callTool).toHaveBeenLastCalledWith("scroll", {
      target: { kind: "window", pid: 42, window_id: 8 },
      direction: "up",
      amount: 3,
      by: "line",
    });
    await provider.scrollAtPoint({ ...base, scrollX: 500, scrollY: 2 });
    expect(callTool).toHaveBeenLastCalledWith(
      "scroll",
      expect.objectContaining({ direction: "right", amount: 50 }),
    );
  });

  it("fails readiness with an actionable error when the Space is down", async () => {
    const { client } = makeClient({});
    vi.mocked(client.checkHealth).mockResolvedValue(false);
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await expect(provider.ensureReadyWithInteractivePermissions()).rejects.toThrow(/not reachable/);
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("refuses element refs that did not come from this provider", async () => {
    const { client } = makeClient({});
    const provider = new CuaSpaceProvider(client, "http://127.0.0.1:3211");
    await expect(provider.setValue("ax-123", "x")).rejects.toThrow(/Cua Space provider/);
  });
});

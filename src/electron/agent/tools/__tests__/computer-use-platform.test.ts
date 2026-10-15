import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerUseTools } from "../computer-use-tools";
import { BuiltinToolsSettingsManager } from "../builtin-settings";
import { beginPrivateSurface } from "../../../browser/credentials/private-capture-guard";
import { setComputerUseProviderFactoryForTesting } from "../../../computer-use/provider";
import { ComputerUseSessionManager } from "../../../computer-use/session-manager";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  setPlatform(originalPlatform);
  setComputerUseProviderFactoryForTesting(null);
  ComputerUseSessionManager.resetForTesting();
  ComputerUseTools.resetForTesting();
  vi.restoreAllMocks();
});

function makeProvider(overrides: Record<string, Any> = {}): Any {
  return {
    ensureReadyWithInteractivePermissions: vi.fn().mockResolvedValue(undefined),
    getFrontmost: vi.fn().mockResolvedValue({ appName: "Notes", pid: 42, windowId: 100 }),
    listApps: vi.fn().mockResolvedValue([{ appName: "Notes", pid: 42, isFrontmost: true }]),
    listWindows: vi.fn().mockResolvedValue([
      {
        windowId: 100,
        title: "Note",
        framePoints: { x: 0, y: 0, w: 300, h: 200 },
        scaleFactor: 1,
        isMinimized: false,
        isOnscreen: true,
        isMain: true,
        isFocused: true,
      },
    ]),
    unminimizeWindow: vi.fn().mockResolvedValue(undefined),
    activateApp: vi.fn().mockResolvedValue(undefined),
    raiseWindow: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue({
      pngBase64: Buffer.from("png").toString("base64"),
      width: 300,
      height: 200,
      scaleFactor: 1,
    }),
    axPressAtPoint: vi.fn().mockResolvedValue({ pressed: true }),
    axFocusAtPoint: vi.fn().mockResolvedValue({ focused: false }),
    mouseClick: vi.fn().mockResolvedValue(undefined),
    mouseMove: vi.fn().mockResolvedValue(undefined),
    mouseDrag: vi.fn().mockResolvedValue(undefined),
    scrollAtPoint: vi.fn().mockResolvedValue(undefined),
    focusedElement: vi.fn().mockResolvedValue({ exists: false }),
    axFocusTextInput: vi.fn().mockResolvedValue({ focused: false }),
    setValue: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    pressKeys: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTools(
  daemon: Any = { logEvent: vi.fn() },
  taskId = `task-${Math.random()}`,
): ComputerUseTools {
  return new ComputerUseTools(
    { id: "w", name: "W", path: "/tmp", createdAt: 0, permissions: {} } as Any,
    daemon as Any,
    taskId,
  );
}

describe("ComputerUseTools platform exposure", () => {
  it("exposes computer-use tools on macOS", () => {
    setPlatform("darwin");
    const tools = ComputerUseTools.getToolDefinitions({ headless: false }).map((tool) => tool.name);
    expect(tools).toContain("screenshot");
    expect(tools).toContain("click");
    expect(tools).toContain("type_text");
  });

  it("exposes computer-use tools on Windows", () => {
    setPlatform("win32");
    const tools = ComputerUseTools.getToolDefinitions({ headless: false }).map((tool) => tool.name);
    expect(tools).toContain("screenshot");
    expect(tools).toContain("click");
    expect(tools).toContain("type_text");
  });

  it("hides computer-use tools in headless mode", () => {
    setPlatform("win32");
    expect(ComputerUseTools.getToolDefinitions({ headless: true })).toEqual([]);
  });

  it("hides computer-use tools on unsupported desktop platforms", () => {
    setPlatform("linux");
    expect(ComputerUseTools.getToolDefinitions({ headless: false })).toEqual([]);
  });

  it("resolves the helper through the provider interface", async () => {
    setPlatform("win32");
    const provider = makeProvider({
      getFrontmost: vi.fn().mockResolvedValue({ appName: "Notepad", pid: 42, windowId: 100 }),
      listWindows: vi.fn().mockResolvedValue([
        {
          windowId: 100,
          title: "Untitled - Notepad",
          framePoints: { x: 0, y: 0, w: 300, h: 200 },
          scaleFactor: 1,
          isMinimized: false,
          isOnscreen: true,
          isMain: true,
          isFocused: true,
        },
      ]),
    });
    setComputerUseProviderFactoryForTesting(() => provider as Any);
    const daemon = { logEvent: vi.fn() };
    const tools = makeTools(daemon, "task-1");

    await tools.screenshot();

    expect(provider.ensureReadyWithInteractivePermissions).toHaveBeenCalled();
    expect(provider.screenshot).toHaveBeenCalledWith(100);
  });

  it("does not foreground the target for default background-first screenshots", async () => {
    setPlatform("darwin");
    const provider = makeProvider();
    setComputerUseProviderFactoryForTesting(() => provider);
    const tools = makeTools();

    await tools.screenshot();

    expect(provider.activateApp).not.toHaveBeenCalled();
    expect(provider.raiseWindow).not.toHaveBeenCalled();
    expect(provider.screenshot).toHaveBeenCalledWith(100);
  });

  it("uses AX press for background-first left clicks without posting mouse events", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
      browserAutomationMode: "background",
      nativeComputerUseMode: "ask_visible",
    });
    setPlatform("darwin");
    const provider = makeProvider({
      axPressAtPoint: vi.fn().mockResolvedValue({ pressed: true }),
    });
    setComputerUseProviderFactoryForTesting(() => provider);
    const tools = makeTools();
    const capture = await tools.screenshot();

    await tools.click(10, 10, "left", capture.captureId);

    expect(provider.axPressAtPoint).toHaveBeenCalled();
    expect(provider.mouseClick).not.toHaveBeenCalled();
    expect(provider.activateApp).not.toHaveBeenCalled();
  });

  it("requires visible-control approval before falling back to a real mouse click", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
      browserAutomationMode: "background",
      nativeComputerUseMode: "ask_visible",
    });
    setPlatform("darwin");
    const provider = makeProvider({
      axPressAtPoint: vi.fn().mockResolvedValue({ pressed: false }),
      axFocusAtPoint: vi.fn().mockResolvedValue({ focused: false }),
    });
    setComputerUseProviderFactoryForTesting(() => provider);
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(false),
    };
    const tools = makeTools(daemon);
    const capture = await tools.screenshot();

    await expect(tools.click(10, 10, "left", capture.captureId)).rejects.toThrow(
      /needs visible control/i,
    );

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      expect.any(String),
      "computer_use",
      expect.stringContaining("Allow visible Computer Use"),
      expect.objectContaining({ kind: "computer_use_foreground_control", tool: "click" }),
      { allowAutoApprove: false },
    );
    expect(provider.mouseClick).not.toHaveBeenCalled();
    expect(provider.activateApp).not.toHaveBeenCalled();
  });

  it("strict background refuses foreground fallback without asking or activating", async () => {
    setPlatform("darwin");
    const provider = makeProvider({
      axPressAtPoint: vi.fn().mockResolvedValue({ pressed: false }),
      axFocusAtPoint: vi.fn().mockResolvedValue({ focused: false }),
    });
    setComputerUseProviderFactoryForTesting(() => provider);
    const daemon = { logEvent: vi.fn(), requestApproval: vi.fn() };
    const tools = makeTools(daemon);
    const capture = await tools.screenshot();
    await expect(tools.click(10, 10, "left", capture.captureId)).rejects.toThrow(
      /foreground fallback is disabled/,
    );
    expect(daemon.requestApproval).not.toHaveBeenCalled();
    expect(provider.activateApp).not.toHaveBeenCalled();
  });

  it("does not expose model-controlled foreground bypass fields in native tool schemas", () => {
    setPlatform("darwin");
    const tools = ComputerUseTools.getToolDefinitions({ headless: false });

    for (const tool of tools) {
      const properties = (tool.input_schema as Any).properties || {};
      expect(properties.control_mode).toBeUndefined();
      expect(properties.allow_visible_control).toBeUndefined();
    }
  });

  it("persists visible-control approval for the current task and window", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
      browserAutomationMode: "background",
      nativeComputerUseMode: "ask_visible",
    });
    setPlatform("darwin");
    const provider = makeProvider({
      axPressAtPoint: vi.fn().mockResolvedValue({ pressed: false }),
      axFocusAtPoint: vi.fn().mockResolvedValue({ focused: false }),
    });
    setComputerUseProviderFactoryForTesting(() => provider);
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
    };
    const tools = makeTools(daemon, "task-visible-grant");
    const capture = await tools.screenshot();

    await tools.click(10, 10, "left", capture.captureId);
    await tools.click(20, 10, "left");

    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
    expect(provider.mouseClick).toHaveBeenCalledTimes(2);
    expect(provider.activateApp).toHaveBeenCalledTimes(2);
  });

  it("reports AX focus as partial progress instead of treating it as a completed click", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
      browserAutomationMode: "background",
      nativeComputerUseMode: "ask_visible",
    });
    setPlatform("darwin");
    const provider = makeProvider({
      axPressAtPoint: vi.fn().mockResolvedValue({ pressed: false }),
      axFocusAtPoint: vi.fn().mockResolvedValue({ focused: true }),
    });
    setComputerUseProviderFactoryForTesting(() => provider);
    const daemon = {
      logEvent: vi.fn(),
      requestApproval: vi.fn(),
    };
    const tools = makeTools(daemon);
    const capture = await tools.screenshot();

    const result = await tools.click(10, 10, "left", capture.captureId);

    expect(result.note).toContain("focused the target");
    expect(provider.mouseClick).not.toHaveBeenCalled();
    expect(provider.activateApp).not.toHaveBeenCalled();
    expect(daemon.requestApproval).not.toHaveBeenCalled();
  });
});

describe("ComputerUseTools private capture races", () => {
  it("stops after permissions initialize if a private flow opened and closed meanwhile", async () => {
    setPlatform("darwin");
    let ready!: () => void;
    const provider = makeProvider({
      ensureReadyWithInteractivePermissions: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            ready = resolve;
          }),
      ),
    });
    setComputerUseProviderFactoryForTesting(() => provider);
    const tools = makeTools();
    const operation = tools.screenshot();
    await vi.waitFor(() => expect(ready).toBeDefined());
    beginPrivateSurface()();
    ready();
    await expect(operation).rejects.toThrow(/private/i);
    expect(provider.getFrontmost).not.toHaveBeenCalled();
    expect(provider.screenshot).not.toHaveBeenCalled();
  });

  it("discards pixels captured across a private flow before saving capture state", async () => {
    setPlatform("darwin");
    let finishCapture!: (value: unknown) => void;
    const provider = makeProvider({
      screenshot: vi.fn(
        () =>
          new Promise((resolve) => {
            finishCapture = resolve;
          }),
      ),
    });
    setComputerUseProviderFactoryForTesting(() => provider);
    const tools = makeTools();
    const operation = tools.screenshot();
    await vi.waitFor(() => expect(finishCapture).toBeDefined());
    beginPrivateSurface()();
    finishCapture({ pngBase64: "private pixels", width: 300, height: 200, scaleFactor: 1 });
    await expect(operation).rejects.toThrow(/private/i);
    expect((tools as Any).currentCapture).toBeNull();
  });

  it("does not activate or click after a private flow starts while visible control approval waits", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
      browserAutomationMode: "background",
      nativeComputerUseMode: "ask_visible",
    });
    setPlatform("darwin");
    let approve!: (value: boolean) => void;
    const provider = makeProvider({
      axPressAtPoint: vi.fn().mockResolvedValue({ pressed: false }),
      axFocusAtPoint: vi.fn().mockResolvedValue({ focused: false }),
    });
    setComputerUseProviderFactoryForTesting(() => provider);
    const tools = makeTools({
      logEvent: vi.fn(),
      requestApproval: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            approve = resolve;
          }),
      ),
    });
    await tools.screenshot();
    const operation = tools.click(10, 10);
    await vi.waitFor(() => expect(approve).toBeDefined());
    beginPrivateSurface()();
    approve(true);
    await expect(operation).rejects.toThrow(/private/i);
    expect(provider.unminimizeWindow).not.toHaveBeenCalled();
    expect(provider.activateApp).not.toHaveBeenCalled();
    expect(provider.mouseClick).not.toHaveBeenCalled();
  });

  it("does not swallow private-flow invalidation in the text focus fallback", async () => {
    vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
      browserAutomationMode: "background",
      nativeComputerUseMode: "ask_visible",
    });
    setPlatform("darwin");
    const provider = makeProvider({
      axFocusTextInput: vi.fn(async () => {
        beginPrivateSurface()();
        throw new Error("focus failed");
      }),
    });
    setComputerUseProviderFactoryForTesting(() => provider);
    const daemon = { logEvent: vi.fn(), requestApproval: vi.fn().mockResolvedValue(true) };
    const tools = makeTools(daemon);
    await tools.screenshot();
    await expect(tools.typeText("example")).rejects.toThrow(/private/i);
    expect(daemon.requestApproval).not.toHaveBeenCalled();
    expect(provider.typeText).not.toHaveBeenCalled();
  });
});

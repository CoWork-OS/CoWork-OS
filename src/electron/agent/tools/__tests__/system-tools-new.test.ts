import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryFeatureMocks = vi.hoisted(() => ({
  loadSettings: vi.fn().mockReturnValue({
    sessionRecallEnabled: true,
  }),
  getCurrentLocation: vi.fn(),
}));

const memoryServiceMocks = vi.hoisted(() => ({
  searchAsync: vi.fn().mockResolvedValue([]),
  searchWorkspaceMarkdown: vi.fn().mockReturnValue([]),
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/app",
    getPath: (name: string) => `/electron/${name}`,
  },
  clipboard: { readText: () => "", writeText: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock("../../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: {
    loadSettings: memoryFeatureMocks.loadSettings,
  },
}));

vi.mock("../../../location/DesktopLocationService", () => ({
  getDesktopLocationService: () => ({
    getCurrentLocation: memoryFeatureMocks.getCurrentLocation,
  }),
}));

vi.mock("../../../memory/MemoryService", () => ({
  MemoryService: memoryServiceMocks,
}));

import { SystemTools } from "../system-tools";
import { shell } from "electron";

beforeEach(() => {
  vi.clearAllMocks();
  memoryFeatureMocks.getCurrentLocation.mockReset();
  memoryFeatureMocks.loadSettings.mockReturnValue({
    sessionRecallEnabled: true,
  });
  memoryServiceMocks.searchAsync.mockReset().mockResolvedValue([]);
  memoryServiceMocks.searchWorkspaceMarkdown.mockReset().mockReturnValue([]);
  memoryServiceMocks.searchAsync.mockReset().mockResolvedValue([]);
  memoryServiceMocks.searchWorkspaceMarkdown.mockReset().mockReturnValue([]);
});

describe("SystemTools.normalizeAppleScript", () => {
  function makeSystemTools(): SystemTools {
    return new SystemTools(
      {
        id: "ws-1",
        name: "test",
        path: "/tmp",
        createdAt: 0,
        permissions: { read: true, write: true, delete: false, network: false, shell: false },
      },
      { logEvent: vi.fn(), requestApproval: vi.fn() } as Any,
      "task-1",
    );
  }

  // Access the private method through a test-only technique
  function callNormalize(input: string): { script: string; modified: boolean } {
    const instance = makeSystemTools();
    // Access private method for testing
    return (instance as Any).normalizeAppleScript(input);
  }

  it("returns unmodified script as-is", () => {
    const result = callNormalize('tell application "Finder" to get name');
    expect(result.script).toBe('tell application "Finder" to get name');
    expect(result.modified).toBe(false);
  });

  it("strips fenced code blocks", () => {
    const result = callNormalize('```applescript\ntell app "Finder" to beep\n```');
    expect(result.script).toBe('tell app "Finder" to beep');
    expect(result.modified).toBe(true);
  });

  it("strips fenced code blocks without language tag", () => {
    const result = callNormalize('```\ntell app "Finder" to beep\n```');
    expect(result.script).toBe('tell app "Finder" to beep');
    expect(result.modified).toBe(true);
  });

  it("replaces smart double quotes", () => {
    const result = callNormalize("tell application \u201CFinder\u201D to beep");
    expect(result.script).toBe('tell application "Finder" to beep');
    expect(result.modified).toBe(true);
  });

  it("replaces smart single quotes", () => {
    const result = callNormalize("it\u2019s a test");
    expect(result.script).toBe("it's a test");
    expect(result.modified).toBe(true);
  });

  it("removes non-breaking spaces", () => {
    const result = callNormalize('tell\u00A0application "Finder"');
    expect(result.script).toBe('tell application "Finder"');
    expect(result.modified).toBe(true);
  });

  it("handles multiple normalizations at once", () => {
    const result = callNormalize("```applescript\ntell\u00A0app \u201CFinder\u201D\n```");
    expect(result.script).toBe('tell app "Finder"');
    expect(result.modified).toBe(true);
  });

  it("adds a discovery hint for unresolved application ids", () => {
    const instance = makeSystemTools();
    const result = (instance as Any).formatAppleScriptFailure({
      stderr: '899:929: syntax error: Can\u2019t get application id "ai.perplexity". (-1728)',
    });

    expect(result).toContain('The bundle identifier "ai.perplexity" was not resolvable.');
    expect(result).toContain(`osascript -e 'id of app "App Name"'`);
  });

  it("rejects non-web URL schemes before opening external handlers", async () => {
    const instance = makeSystemTools();

    await expect(
      instance.openUrl("x-apple.systempreferences:com.apple.preference.security"),
    ).rejects.toThrow("Only http and https URLs are allowed");
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe("SystemTools.getToolDefinitions", () => {
  it("returns all tools in non-headless mode", () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
    });
    const tools = SystemTools.getToolDefinitions();
    expect(tools.length).toBeGreaterThan(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("system_info");
    expect(names).toContain("get_current_location");
    expect(names).toContain("read_clipboard");
    expect(names).toContain("run_applescript");
    // Memory tools live in MemoryTools (memory_recall, …), not in SystemTools.
    for (const legacy of ["search_memories", "search_quotes", "search_sessions"]) {
      expect(names).not.toContain(legacy);
    }
  });

  it("returns only safe tools in headless mode", () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
    });
    const tools = SystemTools.getToolDefinitions({ headless: true });
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain("system_info");
    expect(names).toContain("get_env");
    expect(names).toContain("get_app_paths");
    // Desktop-only tools should be excluded
    expect(names).not.toContain("read_clipboard");
    expect(names).not.toContain("get_current_location");
    expect(names).not.toContain("take_screenshot");
    expect(names).not.toContain("open_application");
    expect(names).not.toContain("open_url");
    expect(names).not.toContain("run_applescript");
  });

  it("returns full tools when headless is false", () => {
    memoryFeatureMocks.loadSettings.mockReturnValue({
      sessionRecallEnabled: true,
    });
    const tools = SystemTools.getToolDefinitions({ headless: false });
    expect(tools.length).toBeGreaterThan(4);
  });
});

describe("SystemTools.getCurrentLocation", () => {
  it("returns a desktop location snapshot without logging exact coordinates", async () => {
    const logEvent = vi.fn();
    memoryFeatureMocks.getCurrentLocation.mockResolvedValueOnce({
      latitude: 37.7749,
      longitude: -122.4194,
      accuracyMeters: 12.3,
      timestamp: Date.parse("2026-05-20T12:00:00Z"),
      source: "macos_core_location",
    });
    const instance = new SystemTools(
      {
        id: "ws-1",
        name: "test",
        path: "/tmp",
        createdAt: 0,
        permissions: { read: true, write: true, delete: false, network: true, shell: false },
      },
      { logEvent, requestApproval: vi.fn() } as Any,
      "task-1",
    );

    const result = await instance.getCurrentLocation({ accuracy: "precise" });

    expect(result).toMatchObject({
      latitude: 37.7749,
      longitude: -122.4194,
      accuracyMeters: 12.3,
      timestamp: "2026-05-20T12:00:00.000Z",
      source: "macos_core_location",
    });
    expect(result.mapsUrl).toContain("37.7749,-122.4194");
    expect(logEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ latitude: 37.7749 }),
    );
  });

  it("converts desktop geolocation timeouts into a non-retryable fast failure", async () => {
    const logEvent = vi.fn();
    memoryFeatureMocks.getCurrentLocation.mockRejectedValueOnce(
      new Error("Timed out while getting current location."),
    );
    const instance = new SystemTools(
      {
        id: "ws-1",
        name: "test",
        path: "/tmp",
        createdAt: 0,
        permissions: { read: true, write: true, delete: false, network: true, shell: false },
      },
      { logEvent, requestApproval: vi.fn() } as Any,
      "task-1",
    );

    await expect(instance.getCurrentLocation({ accuracy: "precise" })).rejects.toThrow(
      "Do not retry get_current_location",
    );
    await expect(instance.getCurrentLocation({ accuracy: "coarse" })).rejects.toThrow(
      "Do not retry get_current_location",
    );

    expect(memoryFeatureMocks.getCurrentLocation).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      "task-1",
      "tool_result",
      expect.objectContaining({
        tool: "get_current_location",
        success: false,
        error: expect.stringContaining("Location Services"),
      }),
    );
  });
});

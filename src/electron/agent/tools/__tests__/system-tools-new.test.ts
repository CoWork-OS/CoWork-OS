import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/app",
    getPath: (name: string) => `/electron/${name}`,
  },
  clipboard: { readText: () => "", writeText: vi.fn() },
  desktopCapturer: { getSources: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { SystemTools } from "../system-tools";

describe("SystemTools.normalizeAppleScript", () => {
  // Access the private method through a test-only technique
  function callNormalize(input: string): { script: string; modified: boolean } {
    const instance = new SystemTools(
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
});

describe("SystemTools.getToolDefinitions", () => {
  it("returns all tools in non-headless mode", () => {
    const tools = SystemTools.getToolDefinitions();
    expect(tools.length).toBeGreaterThan(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain("system_info");
    expect(names).toContain("read_clipboard");
    expect(names).toContain("run_applescript");
    expect(names).toContain("search_memories");
  });

  it("returns only safe tools in headless mode", () => {
    const tools = SystemTools.getToolDefinitions({ headless: true });
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain("system_info");
    expect(names).toContain("get_env");
    expect(names).toContain("get_app_paths");
    expect(names).toContain("search_memories");
    // Desktop-only tools should be excluded
    expect(names).not.toContain("read_clipboard");
    expect(names).not.toContain("take_screenshot");
    expect(names).not.toContain("open_application");
    expect(names).not.toContain("open_url");
    expect(names).not.toContain("run_applescript");
  });

  it("returns full tools when headless is false", () => {
    const tools = SystemTools.getToolDefinitions({ headless: false });
    expect(tools.length).toBeGreaterThan(4);
  });
});

describe("SystemTools.searchMemories", () => {
  it("returns empty results on error", async () => {
    vi.mock("../../memory/MemoryService", () => ({
      MemoryService: {
        search: vi.fn(() => {
          throw new Error("DB not initialized");
        }),
      },
    }));

    const instance = new SystemTools(
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

    const result = await instance.searchMemories({ query: "test" });
    expect(result.results).toEqual([]);
    expect(result.totalFound).toBe(0);
  });
});

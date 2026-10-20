import { describe, expect, it, vi } from "vitest";

// Mock MentionTools to avoid DatabaseManager dependency during ToolRegistry construction.
vi.mock("../mention-tools", () => {
  return {
    MentionTools: class MockMentionTools {
      static getToolDefinitions() {
        return [];
      }
    },
  };
});

vi.mock("../../../mcp/client/MCPClientManager", () => ({
  MCPClientManager: {
    getInstance: vi.fn().mockImplementation(() => {
      throw new Error("MCP not initialized");
    }),
  },
}));

vi.mock("../../../mcp/settings", () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({ toolNamePrefix: "mcp_" }),
    updateServer: vi.fn().mockReturnValue({}),
  },
}));

vi.mock("../../../mcp/registry/MCPRegistryManager", () => ({
  MCPRegistryManager: {
    installServer: vi.fn(),
  },
}));

vi.mock("../../../hooks/settings", () => ({
  HooksSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({
      enabled: false,
      token: "",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    }),
    enableHooks: vi.fn().mockReturnValue({
      enabled: true,
      token: "token",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    }),
    updateConfig: vi.fn().mockImplementation((cfg: Any) => cfg),
  },
}));

import { ToolRegistry } from "../registry";

describe("ToolRegistry tool restrictions", () => {
  it('denies all tools when restrictions include "*"', () => {
    const workspace: Any = {
      id: "test-workspace",
      name: "Test Workspace",
      path: "/mock/workspace",
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      },
      createdAt: Date.now(),
    };

    const daemon: Any = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
    };

    const registry = new ToolRegistry(workspace, daemon, "test-task", "private", ["*"]);

    expect(registry.isToolAllowed("read_file")).toBe(false);
    expect(registry.isToolAllowed("web_search")).toBe(false);
    expect(registry.isToolAllowed("spawn_agent")).toBe(false);
  });

  it("takes computer tools away according to the bot's Works on setting", () => {
    const workspace: Any = {
      id: "test-workspace",
      name: "Test Workspace",
      path: "/mock/workspace",
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
      createdAt: Date.now(),
    };
    const daemon: Any = { logEvent: vi.fn(), registerArtifact: vi.fn() };
    const registry = new ToolRegistry(workspace, daemon, "test-task", "private", []);
    let worksOn: Any = "browser";
    registry.setBotWorksOnSource(() => worksOn);

    expect(registry.isToolAllowed("click")).toBe(false);
    expect(registry.isToolAllowed("open_application")).toBe(false);
    expect(registry.isToolAllowed("browser_navigate")).toBe(true);
    expect(registry.isToolAllowed("read_file")).toBe(true);
    expect((registry as Any).isDeniedByTaskRestrictions("native_app")).toBe(true);

    // A change applies on the next check.
    worksOn = "off";
    expect(registry.isToolAllowed("browser_navigate")).toBe(false);
    expect(registry.isToolAllowed("read_file")).toBe(true);

    worksOn = "this_computer";
    expect(registry.isToolAllowed("browser_navigate")).toBe(true);
    expect((registry as Any).isDeniedByTaskRestrictions("click")).toBe(false);

    // A setting that cannot be read takes the computer away.
    registry.setBotWorksOnSource(() => {
      throw new Error("role store unavailable");
    });
    expect(registry.isToolAllowed("browser_navigate")).toBe(false);
  });

  it("takes host-escape tools and workspace switching away from a run in a bot's own folder", async () => {
    const workspace: Any = {
      id: "__bot_workspace__:bot-1",
      name: "Scout (own folder)",
      path: "/mock/bot-folder",
      permissions: { read: true, write: true, delete: true, network: true, shell: true },
      createdAt: Date.now(),
    };
    let task: Any = { id: "test-task", agentConfig: { botContained: true } };
    const daemon: Any = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
      getTask: vi.fn(() => task),
      createWorkspace: vi.fn(),
    };
    const registry = new ToolRegistry(workspace, daemon, "test-task", "private", []);
    const handler = vi.fn();
    registry.setWorkspaceSwitchHandler(handler, () =>
      task.agentConfig?.botContained ? "own folder" : undefined,
    );

    for (const name of [
      "get_env",
      "terminate_macos_app_processes",
      "disable_macos_launch_agents",
    ]) {
      expect((registry as Any).isDeniedByTaskRestrictions(name)).toBe(true);
    }
    expect((registry as Any).isDeniedByTaskRestrictions("read_file")).toBe(false);
    expect(await registry.switchWorkspace({ path: "/Users/someone" })).toEqual({
      success: false,
      error: "own folder",
    });
    expect(daemon.createWorkspace).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    task = { id: "test-task", agentConfig: {} };
    expect((registry as Any).isDeniedByTaskRestrictions("get_env")).toBe(false);

    // An own-desktop bot's contained run runs commands in its desktop, not on this computer.
    task = { id: "test-task", agentConfig: { botContained: true } };
    let worksOn: Any = "own_desktop";
    registry.setBotWorksOnSource(() => worksOn);
    for (const name of ["run_command", "execute_code", "git_commit", "stop_process"]) {
      expect((registry as Any).isDeniedByTaskRestrictions(name)).toBe(true);
    }
    expect((registry as Any).isDeniedByTaskRestrictions("desktop_run")).toBe(false);
    worksOn = "auto";
    expect((registry as Any).isDeniedByTaskRestrictions("run_command")).toBe(false);
    worksOn = "own_desktop";
    task = { id: "test-task", agentConfig: {} };
    expect((registry as Any).isDeniedByTaskRestrictions("run_command")).toBe(false);

    // A task that cannot be read is treated as contained.
    daemon.getTask = vi.fn(() => {
      throw new Error("task store unavailable");
    });
    expect((registry as Any).isDeniedByTaskRestrictions("get_env")).toBe(true);
  });
});

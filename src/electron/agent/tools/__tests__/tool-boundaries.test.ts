import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Mock MentionTools to avoid DatabaseManager dependency during ToolRegistry construction.
vi.mock("../mention-tools", () => ({
  MentionTools: class MockMentionTools {
    static getToolDefinitions() {
      return [];
    }
  },
}));

const mcpServers = vi.hoisted(() => ({
  serverIdForTool: {} as Record<string, string>,
  servers: [] as Array<{ id: string; transport: string }>,
}));

vi.mock("../../../mcp/client/MCPClientManager", () => ({
  MCPClientManager: {
    getInstance: vi.fn().mockImplementation(() => ({
      getServerIdForTool: (rawName: string) => mcpServers.serverIdForTool[rawName] ?? null,
    })),
  },
}));

vi.mock("../../../mcp/settings", () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockImplementation(() => ({
      toolNamePrefix: "mcp_",
      servers: mcpServers.servers,
    })),
    updateServer: vi.fn().mockReturnValue({}),
  },
}));

vi.mock("../../../mcp/registry/MCPRegistryManager", () => ({
  MCPRegistryManager: { installServer: vi.fn() },
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
    enableHooks: vi.fn(),
    updateConfig: vi.fn().mockImplementation((cfg: Any) => cfg),
  },
}));

import { ToolRegistry } from "../registry";
import {
  isToolBoundaryAllowedForContainedRun,
  toolBoundaryClass,
} from "../../../../shared/tool-boundaries";

const ELECTRON_SRC = path.resolve(__dirname, "../../..");

/**
 * Tool names defined anywhere in the main process: a `name: "..."` line followed shortly by
 * an `input_schema`. Catches tools the registry only offers when an integration is set up.
 */
function scanDefinedToolNames(): Set<string> {
  const names = new Set<string>();
  const nameLine = /^\s*name:\s*"([A-Za-z][A-Za-z0-9_]*)"/;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const lines = fs.readFileSync(full, "utf8").split("\n");
        lines.forEach((line, index) => {
          const match = nameLine.exec(line);
          if (match && lines.slice(index + 1, index + 14).some((l) => l.includes("input_schema"))) {
            names.add(match[1]);
          }
        });
      }
    }
  };
  walk(ELECTRON_SRC);
  return names;
}

function makeRegistry(task: Any, worksOn?: string) {
  const workspace: Any = {
    id: "__bot_workspace__:bot-1",
    name: "Scout (own folder)",
    path: "/mock/bot-folder",
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
    createdAt: Date.now(),
  };
  const daemon: Any = { logEvent: vi.fn(), registerArtifact: vi.fn(), getTask: () => task };
  const registry = new ToolRegistry(workspace, daemon, "test-task", "private", []);
  if (worksOn) registry.setBotWorksOnSource(() => worksOn as Any);
  return registry;
}

const denied = (registry: ToolRegistry, name: string): boolean =>
  (registry as Any).isDeniedByTaskRestrictions(name);

describe("tool boundary classes", () => {
  it("classifies every tool the main process defines or the registry offers", () => {
    const registry = makeRegistry({ id: "test-task", agentConfig: {} });
    const names = new Set([
      ...scanDefinedToolNames(),
      ...registry.getTools().map((tool) => tool.name),
    ]);
    expect(names.size).toBeGreaterThan(200);
    const unclassified = [...names].filter((name) => toolBoundaryClass(name) === undefined).sort();
    // A new tool needs a class in src/shared/tool-boundaries.ts. Until it has one, a run in a
    // bot's own folder never gets it.
    expect(unclassified).toEqual([]);
  });

  it("gives a run in a bot's own folder only what stays inside it", () => {
    const allowed = (name: string, context: Any = {}) =>
      isToolBoundaryAllowedForContainedRun(toolBoundaryClass(name), context);
    for (const name of ["read_file", "web_fetch", "memory_recall", "gmail_action", "spawn_agent"]) {
      expect(allowed(name)).toBe(true);
    }
    for (const name of [
      "get_env",
      "qa_navigate",
      "android_phone_observe",
      "brand_new_tool",
      "set_clipboard",
    ]) {
      expect(allowed(name)).toBe(false);
    }
    expect(allowed("run_command")).toBe(true);
    expect(allowed("run_command", { worksOn: "own_desktop" })).toBe(false);
    expect(allowed("mcp_search", { localConnector: false })).toBe(true);
    expect(allowed("mcp_read_files", { localConnector: true })).toBe(false);
  });
});

describe("the registry's boundary for a run in a bot's own folder", () => {
  const contained = { id: "test-task", agentConfig: { botContained: true } };

  it("refuses unclassified tools and tools that reach past the bot's folder", () => {
    const registry = makeRegistry(contained, "auto");
    for (const name of ["brand_new_tool", "get_env", "qa_navigate", "android_phone_dispatch"]) {
      expect(denied(registry, name)).toBe(true);
    }
    for (const name of ["read_file", "write_file", "web_search", "run_command", "memory_recall"]) {
      expect(denied(registry, name)).toBe(false);
    }
  });

  it("runs an own-desktop bot's commands only in its desktop", () => {
    const registry = makeRegistry(contained, "own_desktop");
    expect(denied(registry, "run_command")).toBe(true);
    expect(denied(registry, "compile_latex")).toBe(true);
    expect(denied(registry, "desktop_run")).toBe(false);
  });

  it("refuses connectors that run as programs on this computer, and unknown ones", () => {
    mcpServers.servers = [
      { id: "local-fs", transport: "stdio" },
      { id: "remote-crm", transport: "streamable-http" },
    ];
    mcpServers.serverIdForTool = { read_text_file: "local-fs", find_customer: "remote-crm" };
    const registry = makeRegistry(contained, "auto");
    expect(denied(registry, "mcp_read_text_file")).toBe(true);
    expect(denied(registry, "mcp_find_customer")).toBe(false);
    expect(denied(registry, "mcp_not_from_any_server")).toBe(true);
  });

  it("applies the boundary as soon as the daemon contains a running task", async () => {
    const task: Any = { id: "test-task", agentConfig: {} };
    const registry = makeRegistry(task, "auto");
    expect(denied(registry, "get_env")).toBe(false);
    task.agentConfig = { botContained: true };
    await Promise.resolve();
    expect(denied(registry, "get_env")).toBe(true);
  });

  it("leaves runs outside a bot's folder as they were", () => {
    const registry = makeRegistry({ id: "test-task", agentConfig: {} }, "auto");
    for (const name of ["brand_new_tool", "get_env", "qa_navigate", "mcp_read_text_file"]) {
      expect(denied(registry, name)).toBe(false);
    }
  });
});

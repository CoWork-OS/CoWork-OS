import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  addServerMock: vi.fn(),
  execFileMock: vi.fn(),
  loadSettingsMock: vi.fn(),
  mockInstalledServers: [] as Any[],
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
  },
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
  },
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("child_process", () => ({
  execFile: mockState.execFileMock,
}));

vi.mock("../settings", () => ({
  MCPSettingsManager: {
    loadSettings: mockState.loadSettingsMock,
    addServer: mockState.addServerMock,
    updateServer: vi.fn(),
    removeServer: vi.fn(),
  },
}));

import { MCPRegistryManager } from "../registry/MCPRegistryManager";

describe("MCPRegistryManager install defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.mockInstalledServers = [];
    mockState.execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: Any, callback: Any) =>
        callback(null, "2026.1.14\n", ""),
    );
    mockState.loadSettingsMock.mockImplementation(() => ({
      servers: mockState.mockInstalledServers,
      autoConnect: true,
      toolNamePrefix: "mcp_",
      maxReconnectAttempts: 5,
      reconnectDelayMs: 1000,
      registryEnabled: false,
      registryUrl: "https://registry.modelcontextprotocol.io/servers.json",
      hostEnabled: false,
    }));
    MCPRegistryManager.clearCache();
  });

  it("installs manual connectors as disabled by default", async () => {
    const config = await MCPRegistryManager.installServer("salesforce");

    expect(config.enabled).toBe(false);
    expect(config.args).not.toContain("--runAsNode");
    expect(config.args?.[0]).toContain("/connectors/salesforce-mcp/dist/index.js");
    expect(mockState.addServerMock).toHaveBeenCalledTimes(1);
    expect(mockState.addServerMock.mock.calls[0][0].enabled).toBe(false);
  });

  it("installs npm servers as enabled by default", async () => {
    const verifySpy = vi
      .spyOn(MCPRegistryManager, "verifyNpmPackage")
      .mockResolvedValue({ exists: true, version: "2026.1.14" });

    const config = await MCPRegistryManager.installServer("postgres");

    expect(config.enabled).toBe(true);
    expect(mockState.addServerMock).toHaveBeenCalledTimes(1);
    expect(mockState.addServerMock.mock.calls[0][0].enabled).toBe(true);

    verifySpy.mockRestore();
  });

  it("curates overlapping official MCP servers out of the built-in registry", async () => {
    const registry = await MCPRegistryManager.fetchRegistry();
    const ids = registry.servers.map((server) => server.id);

    expect(ids).not.toContain("filesystem");
    expect(ids).not.toContain("github");
    expect(ids).not.toContain("puppeteer");
    expect(ids).not.toContain("memory");
    expect(ids).toContain("postgres");
  });

  it("only exposes shipped local connectors and the consolidated google-workspace connector", async () => {
    const registry = await MCPRegistryManager.fetchRegistry();
    const ids = registry.servers.map((server) => server.id);
    const googleWorkspace = registry.servers.find((server) => server.id === "google-workspace");
    const googleWorkspaceTools = googleWorkspace?.tools.map((tool) => tool.name) ?? [];

    expect(ids).toContain("google-workspace");
    expect(ids).toContain("maps");
    expect(ids).toContain("factset");
    expect(ids).toContain("daloopa");
    expect(ids).toContain("egnyte");
    expect(googleWorkspaceTools).toEqual(
      expect.arrayContaining([
        "google-workspace.calendar_events_list",
        "google-workspace.calendar_availability_get",
        "google-workspace.calendar_event_create",
        "google-workspace.tasks_create",
        "google-workspace.tasks_complete",
        "google-workspace.slides_create",
        "google-workspace.slides_batch_update",
      ]),
    );
    expect(ids).not.toContain("google-calendar");
    expect(ids).not.toContain("google-drive");
    expect(ids).not.toContain("gmail");
    expect(ids).not.toContain("slack");
    expect(ids).not.toContain("docusign");
    expect(ids).not.toContain("outreach");
  });

  it("installs finance presets through the shared finance-data connector", async () => {
    const config = await MCPRegistryManager.installServer("pitchbook");

    expect(config.enabled).toBe(false);
    expect(config.args?.some((arg) => arg.includes("finance-data-mcp"))).toBe(true);
    expect(config.args).toEqual(expect.arrayContaining(["--provider", "pitchbook"]));
    expect(config.env).toMatchObject({
      PITCHBOOK_API_KEY: "",
      PITCHBOOK_BASE_URL: "",
    });
  });

  it("exposes only read-only tools for finance connector presets", async () => {
    const registry = await MCPRegistryManager.fetchRegistry();
    const financeServers = registry.servers.filter((server) =>
      ["daloopa", "morningstar", "spglobal", "factset", "moodys", "mtnewswires", "aiera", "lseg", "pitchbook", "chronograph", "egnyte"].includes(server.id),
    );

    expect(financeServers).toHaveLength(11);
    for (const server of financeServers) {
      expect(server.category).toBe("finance");
      expect(server.tools.every((tool) => !/^(create|update|delete|post|send|approve|trade|execute)/i.test(tool.name))).toBe(true);
    }
  });

  it("verifies npm packages with fixed argv instead of a shell command", async () => {
    const result = await MCPRegistryManager.verifyNpmPackage(
      "@modelcontextprotocol/server-postgres",
    );

    expect(result).toEqual({ exists: true, version: "2026.1.14" });
    expect(mockState.execFileMock).toHaveBeenCalledTimes(1);
    expect(mockState.execFileMock).toHaveBeenCalledWith(
      "npm",
      ["view", "@modelcontextprotocol/server-postgres", "version"],
      { timeout: 15000 },
      expect.any(Function),
    );
  });

  it("rejects malicious npm package names before spawning npm", async () => {
    const result = await MCPRegistryManager.verifyNpmPackage(
      "--version; printf COWORK_INJECTED",
    );

    expect(result.exists).toBe(false);
    expect(result.error).toContain("Invalid npm package name");
    expect(mockState.execFileMock).not.toHaveBeenCalled();
  });
});

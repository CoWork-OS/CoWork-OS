import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  addServerMock: vi.fn(),
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
    expect(mockState.addServerMock).toHaveBeenCalledTimes(1);
    expect(mockState.addServerMock.mock.calls[0][0].enabled).toBe(false);
  });

  it("installs npm servers as enabled by default", async () => {
    const verifySpy = vi
      .spyOn(MCPRegistryManager, "verifyNpmPackage")
      .mockResolvedValue({ exists: true, version: "2026.1.14" });

    const config = await MCPRegistryManager.installServer("filesystem");

    expect(config.enabled).toBe(true);
    expect(mockState.addServerMock).toHaveBeenCalledTimes(1);
    expect(mockState.addServerMock.mock.calls[0][0].enabled).toBe(true);

    verifySpy.mockRestore();
  });
});

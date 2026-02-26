/**
 * Tests for MCP Settings Manager - batch mode for startup optimization
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

let writeCount = 0;
let mockStoredSettings: Record<string, unknown> | undefined = undefined;

const mockRepositorySave = vi.fn().mockImplementation((_category: string, settings: unknown) => {
  mockStoredSettings = settings as Record<string, unknown>;
  writeCount++;
});
const mockRepositoryLoad = vi.fn().mockImplementation(() => mockStoredSettings);
const mockRepositoryExists = vi.fn().mockImplementation(() => mockStoredSettings !== undefined);

// Mock SecureSettingsRepository
vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn().mockReturnValue(true),
    getInstance: vi.fn().mockImplementation(() => ({
      save: mockRepositorySave,
      load: mockRepositoryLoad,
      exists: mockRepositoryExists,
    })),
  },
}));

// Mock fs module (legacy migration path)
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue("{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

// Import after mocking
import { MCPSettingsManager } from "../settings";

describe("MCPSettingsManager batch mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeCount = 0;
    mockStoredSettings = undefined;
    MCPSettingsManager.clearCache();
    (MCPSettingsManager as Any).migrationCompleted = false;
  });

  it("should defer saves when in batch mode", () => {
    MCPSettingsManager.beginBatch();

    const settings = MCPSettingsManager.loadSettings();
    settings.autoConnect = false;
    MCPSettingsManager.saveSettings(settings);

    // Should not have written to disk yet
    expect(writeCount).toBe(0);
  });

  it("should save once when ending batch mode with pending changes", () => {
    MCPSettingsManager.beginBatch();

    const settings = MCPSettingsManager.loadSettings();
    MCPSettingsManager.saveSettings(settings);
    MCPSettingsManager.saveSettings(settings);
    MCPSettingsManager.saveSettings(settings);

    // Still no writes yet
    expect(writeCount).toBe(0);

    MCPSettingsManager.endBatch();

    // Should have written exactly once
    expect(writeCount).toBe(1);
  });

  it("should not save when ending batch mode without changes", () => {
    MCPSettingsManager.beginBatch();
    MCPSettingsManager.endBatch();

    expect(writeCount).toBe(0);
  });

  it("should update cache immediately even in batch mode", () => {
    MCPSettingsManager.beginBatch();

    const settings = MCPSettingsManager.loadSettings();
    settings.autoConnect = false;
    MCPSettingsManager.saveSettings(settings);

    // Cache should be updated immediately
    const cached = MCPSettingsManager.loadSettings();
    expect(cached.autoConnect).toBe(false);

    MCPSettingsManager.endBatch();
  });

  it("should save normally after batch mode ends", () => {
    MCPSettingsManager.beginBatch();
    MCPSettingsManager.endBatch();

    writeCount = 0; // Reset counter

    const settings = MCPSettingsManager.loadSettings();
    MCPSettingsManager.saveSettings(settings);

    expect(writeCount).toBe(1);
  });

  it("should normalize local connector command paths to current runtime", () => {
    mockStoredSettings = {
      servers: [
        {
          id: "salesforce-1",
          name: "Salesforce",
          enabled: true,
          transport: "stdio",
          command:
            "/Users/example/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
          args: ["--runAsNode", "/Users/example/project/connectors/salesforce-mcp/dist/index.js"],
        },
      ],
      autoConnect: true,
      toolNamePrefix: "mcp_",
      maxReconnectAttempts: 5,
      reconnectDelayMs: 1000,
      registryEnabled: true,
      registryUrl: "https://registry.modelcontextprotocol.io/servers.json",
      hostEnabled: false,
    };

    const settings = MCPSettingsManager.loadSettings();
    const server = settings.servers[0];

    expect(server.command).toBe(process.execPath);
    expect(server.args?.[0]).toBe("--runAsNode");
    expect(server.args?.[1]).toContain("/connectors/salesforce-mcp/dist/index.js");
    expect(writeCount).toBe(1);
  });
});

/**
 * Tests for Control Plane Settings Manager
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

let mockStoredSettings: Record<string, unknown> | undefined = undefined;
let writeCount = 0;

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
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue("{}"),
  writeFileSync: vi.fn(),
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
import {
  ControlPlaneSettingsManager,
  generateControlPlaneToken,
  DEFAULT_CONTROL_PLANE_SETTINGS,
  DEFAULT_REMOTE_GATEWAY_CONFIG,
} from "../settings";

describe("generateControlPlaneToken", () => {
  it("should generate a token of default length", () => {
    const token = generateControlPlaneToken();
    // Default is 32 bytes = 64 hex characters
    expect(token).toHaveLength(64);
  });

  it("should generate a token of specified length", () => {
    const token = generateControlPlaneToken(16);
    // 16 bytes = 32 hex characters
    expect(token).toHaveLength(32);
  });

  it("should generate different tokens each time", () => {
    const token1 = generateControlPlaneToken();
    const token2 = generateControlPlaneToken();
    expect(token1).not.toBe(token2);
  });

  it("should generate valid hex string", () => {
    const token = generateControlPlaneToken();
    expect(token).toMatch(/^[0-9a-f]+$/);
  });
});

describe("DEFAULT_CONTROL_PLANE_SETTINGS", () => {
  it("should have expected default values", () => {
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.port).toBe(18789);
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.host).toBe("127.0.0.1");
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.token).toBe("");
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.handshakeTimeoutMs).toBe(10000);
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.heartbeatIntervalMs).toBe(30000);
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.maxPayloadBytes).toBe(10 * 1024 * 1024);
  });

  it("should have expected Tailscale defaults", () => {
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.tailscale.mode).toBe("off");
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.tailscale.resetOnExit).toBe(true);
  });

  it("should have expected connection mode defaults", () => {
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.connectionMode).toBe("local");
    expect(DEFAULT_CONTROL_PLANE_SETTINGS.remote).toBeUndefined();
  });
});

describe("ControlPlaneSettingsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = undefined;
    writeCount = 0;
    ControlPlaneSettingsManager.clearCache();
    (ControlPlaneSettingsManager as Any).migrationCompleted = false;
  });

  describe("loadSettings", () => {
    it("should return defaults when no settings file exists", () => {
      const settings = ControlPlaneSettingsManager.loadSettings();

      expect(settings.enabled).toBe(false);
      expect(settings.port).toBe(18789);
      expect(settings.host).toBe("127.0.0.1");
      expect(settings.token).toBe("");
      expect(settings.tailscale.mode).toBe("off");
    });

    it("should load existing settings", () => {
      mockStoredSettings = {
        enabled: true,
        port: 9999,
        host: "0.0.0.0",
        token: "test-token",
        tailscale: {
          mode: "serve",
          resetOnExit: false,
        },
      };

      const settings = ControlPlaneSettingsManager.loadSettings();

      expect(settings.enabled).toBe(true);
      expect(settings.port).toBe(9999);
      expect(settings.host).toBe("0.0.0.0");
      expect(settings.token).toBe("test-token");
      expect(settings.tailscale.mode).toBe("serve");
      expect(settings.tailscale.resetOnExit).toBe(false);
    });

    it("should merge with defaults for missing fields", () => {
      mockStoredSettings = {
        enabled: true,
      };

      const settings = ControlPlaneSettingsManager.loadSettings();

      expect(settings.enabled).toBe(true);
      expect(settings.port).toBe(18789); // from defaults
      expect(settings.tailscale.mode).toBe("off"); // from defaults
    });

    it("should cache loaded settings", () => {
      mockStoredSettings = { enabled: true };

      const _settings1 = ControlPlaneSettingsManager.loadSettings();
      mockStoredSettings = { enabled: false }; // Change mock
      const settings2 = ControlPlaneSettingsManager.loadSettings();

      // Should return cached value
      expect(settings2.enabled).toBe(true);
    });
  });

  describe("saveSettings", () => {
    it("should save settings to disk", () => {
      const settings = ControlPlaneSettingsManager.loadSettings();
      settings.enabled = true;
      settings.port = 8080;

      ControlPlaneSettingsManager.saveSettings(settings);

      expect(writeCount).toBe(1);
      expect((mockStoredSettings as Any).enabled).toBe(true);
      expect((mockStoredSettings as Any).port).toBe(8080);
    });

    it("should update cache after save", () => {
      const settings = ControlPlaneSettingsManager.loadSettings();
      settings.enabled = true;
      ControlPlaneSettingsManager.saveSettings(settings);

      const cached = ControlPlaneSettingsManager.loadSettings();
      expect(cached.enabled).toBe(true);
    });
  });

  describe("updateSettings", () => {
    it("should update and save settings", () => {
      ControlPlaneSettingsManager.updateSettings({ enabled: true, port: 9999 });

      expect((mockStoredSettings as Any).enabled).toBe(true);
      expect((mockStoredSettings as Any).port).toBe(9999);
    });

    it("should merge with existing settings", () => {
      mockStoredSettings = { enabled: false, port: 8080 };
      ControlPlaneSettingsManager.clearCache();

      ControlPlaneSettingsManager.updateSettings({ enabled: true });

      expect((mockStoredSettings as Any).enabled).toBe(true);
      expect((mockStoredSettings as Any).port).toBe(8080); // preserved
    });

    it("should handle nested tailscale updates", () => {
      mockStoredSettings = {
        tailscale: { mode: "off", resetOnExit: true },
      };
      ControlPlaneSettingsManager.clearCache();

      ControlPlaneSettingsManager.updateSettings({
        tailscale: { mode: "funnel", resetOnExit: true },
      });

      expect(((mockStoredSettings as Any).tailscale as Any).mode).toBe("funnel");
    });
  });

  describe("enable", () => {
    it("should enable and generate token if missing", () => {
      const settings = ControlPlaneSettingsManager.enable();

      expect(settings.enabled).toBe(true);
      expect(settings.token).toBeDefined();
      expect(settings.token.length).toBe(64);
    });

    it("should preserve existing token", () => {
      mockStoredSettings = { token: "existing-token" };
      ControlPlaneSettingsManager.clearCache();

      const settings = ControlPlaneSettingsManager.enable();

      expect(settings.token).toBe("existing-token");
    });
  });

  describe("disable", () => {
    it("should disable settings", () => {
      mockStoredSettings = { enabled: true, token: "test" };
      ControlPlaneSettingsManager.clearCache();

      const settings = ControlPlaneSettingsManager.disable();

      expect(settings.enabled).toBe(false);
    });

    it("should preserve token when disabling", () => {
      mockStoredSettings = { enabled: true, token: "test-token" };
      ControlPlaneSettingsManager.clearCache();

      const settings = ControlPlaneSettingsManager.disable();

      expect(settings.token).toBe("test-token");
    });
  });

  describe("regenerateToken", () => {
    it("should generate a new token", () => {
      mockStoredSettings = { token: "old-token" };
      ControlPlaneSettingsManager.clearCache();

      const newToken = ControlPlaneSettingsManager.regenerateToken();

      expect(newToken).not.toBe("old-token");
      expect(newToken.length).toBe(64);
    });

    it("should save the new token", () => {
      const newToken = ControlPlaneSettingsManager.regenerateToken();
      const settings = ControlPlaneSettingsManager.loadSettings();

      expect(settings.token).toBe(newToken);
    });
  });

  describe("getSettingsForDisplay", () => {
    it("should mask token", () => {
      mockStoredSettings = { token: "secret-token" };
      ControlPlaneSettingsManager.clearCache();

      const display = ControlPlaneSettingsManager.getSettingsForDisplay();

      expect(display.token).toBe("***configured***");
    });

    it("should show empty string for missing token", () => {
      mockStoredSettings = { token: "" };
      ControlPlaneSettingsManager.clearCache();

      const display = ControlPlaneSettingsManager.getSettingsForDisplay();

      expect(display.token).toBe("");
    });
  });

  describe("isConfigured", () => {
    it("should return true when properly configured", () => {
      mockStoredSettings = { enabled: true, token: "test-token" };
      ControlPlaneSettingsManager.clearCache();

      expect(ControlPlaneSettingsManager.isConfigured()).toBe(true);
    });

    it("should return false when disabled", () => {
      mockStoredSettings = { enabled: false, token: "test-token" };
      ControlPlaneSettingsManager.clearCache();

      expect(ControlPlaneSettingsManager.isConfigured()).toBe(false);
    });

    it("should return false when no token", () => {
      mockStoredSettings = { enabled: true, token: "" };
      ControlPlaneSettingsManager.clearCache();

      expect(ControlPlaneSettingsManager.isConfigured()).toBe(false);
    });
  });

  describe("clearCache", () => {
    it("should clear the cached settings", () => {
      mockStoredSettings = { enabled: true };
      ControlPlaneSettingsManager.loadSettings();

      ControlPlaneSettingsManager.clearCache();
      mockStoredSettings = { enabled: false };

      const settings = ControlPlaneSettingsManager.loadSettings();
      expect(settings.enabled).toBe(false);
    });
  });

  describe("getDefaults", () => {
    it("should return default settings", () => {
      const defaults = ControlPlaneSettingsManager.getDefaults();

      expect(defaults.enabled).toBe(false);
      expect(defaults.port).toBe(18789);
      expect(defaults.host).toBe("127.0.0.1");
      expect(defaults.tailscale.mode).toBe("off");
      expect(defaults.connectionMode).toBe("local");
    });

    it("should return a copy, not the original", () => {
      const defaults1 = ControlPlaneSettingsManager.getDefaults();
      defaults1.enabled = true;
      const defaults2 = ControlPlaneSettingsManager.getDefaults();

      expect(defaults2.enabled).toBe(false);
    });
  });

  describe("connectionMode", () => {
    it("should default to local mode", () => {
      const settings = ControlPlaneSettingsManager.loadSettings();
      expect(settings.connectionMode).toBe("local");
    });

    it("should update connection mode", () => {
      ControlPlaneSettingsManager.updateSettings({ connectionMode: "remote" });

      const settings = ControlPlaneSettingsManager.loadSettings();
      expect(settings.connectionMode).toBe("remote");
    });

    it("should preserve connection mode when loading existing settings", () => {
      mockStoredSettings = {
        connectionMode: "remote",
      };
      ControlPlaneSettingsManager.clearCache();

      const settings = ControlPlaneSettingsManager.loadSettings();
      expect(settings.connectionMode).toBe("remote");
    });
  });

  describe("remote gateway config", () => {
    it("should have no remote config by default", () => {
      const settings = ControlPlaneSettingsManager.loadSettings();
      expect(settings.remote).toBeUndefined();
    });

    it("should save remote config", () => {
      const remoteConfig = {
        url: "ws://remote-host:18789",
        token: "remote-token",
        deviceName: "Test Client",
      };

      ControlPlaneSettingsManager.updateSettings({ remote: remoteConfig });

      expect((mockStoredSettings as Any).remote).toBeDefined();
      expect(((mockStoredSettings as Any).remote as Any).url).toBe("ws://remote-host:18789");
      expect(((mockStoredSettings as Any).remote as Any).deviceName).toBe("Test Client");
    });

    it("should load remote config", () => {
      mockStoredSettings = {
        remote: {
          url: "ws://saved-host:18789",
          token: "saved-token",
          deviceName: "Saved Client",
        },
      };
      ControlPlaneSettingsManager.clearCache();

      const settings = ControlPlaneSettingsManager.loadSettings();

      expect(settings.remote).toBeDefined();
      expect(settings.remote!.url).toBe("ws://saved-host:18789");
      expect(settings.remote!.token).toBe("saved-token");
      expect(settings.remote!.deviceName).toBe("Saved Client");
    });

    it("should merge remote config with defaults", () => {
      mockStoredSettings = {
        remote: {
          url: "ws://host:8080",
          token: "token",
        },
      };
      ControlPlaneSettingsManager.clearCache();

      const settings = ControlPlaneSettingsManager.loadSettings();

      expect(settings.remote!.url).toBe("ws://host:8080");
      expect(settings.remote!.token).toBe("token");
      // Should have defaults for missing fields
      expect(settings.remote!.autoReconnect).toBe(true);
      expect(settings.remote!.reconnectIntervalMs).toBe(5000);
      expect(settings.remote!.maxReconnectAttempts).toBe(10);
    });

    it("should mask remote token in display settings", () => {
      mockStoredSettings = {
        remote: {
          url: "ws://host:18789",
          token: "secret-remote-token",
          deviceName: "My Device",
        },
      };
      ControlPlaneSettingsManager.clearCache();

      const display = ControlPlaneSettingsManager.getSettingsForDisplay();

      expect(display.remote).toBeDefined();
      expect(display.remote!.token).toBe("***configured***");
      expect(display.remote!.url).toBe("ws://host:18789");
      expect(display.remote!.deviceName).toBe("My Device");
    });

    it("should show empty string for missing remote token in display", () => {
      mockStoredSettings = {
        remote: {
          url: "ws://host:18789",
          token: "",
        },
      };
      ControlPlaneSettingsManager.clearCache();

      const display = ControlPlaneSettingsManager.getSettingsForDisplay();

      expect(display.remote!.token).toBe("");
    });

    it("should update nested remote config fields", () => {
      mockStoredSettings = {
        remote: {
          url: "ws://old-host:18789",
          token: "old-token",
          deviceName: "Old Name",
        },
      };
      ControlPlaneSettingsManager.clearCache();

      ControlPlaneSettingsManager.updateSettings({
        remote: { url: "ws://new-host:18789", token: "new-token", deviceName: "New Name" },
      });

      expect(((mockStoredSettings as Any).remote as Any).url).toBe("ws://new-host:18789");
      expect(((mockStoredSettings as Any).remote as Any).deviceName).toBe("New Name");
    });
  });
});

describe("DEFAULT_REMOTE_GATEWAY_CONFIG", () => {
  it("should have expected default values", () => {
    expect(DEFAULT_REMOTE_GATEWAY_CONFIG.url).toBe("ws://127.0.0.1:18789");
    expect(DEFAULT_REMOTE_GATEWAY_CONFIG.token).toBe("");
    expect(DEFAULT_REMOTE_GATEWAY_CONFIG.deviceName).toBe("CoWork Remote Client");
    expect(DEFAULT_REMOTE_GATEWAY_CONFIG.autoReconnect).toBe(true);
    expect(DEFAULT_REMOTE_GATEWAY_CONFIG.reconnectIntervalMs).toBe(5000);
    expect(DEFAULT_REMOTE_GATEWAY_CONFIG.maxReconnectAttempts).toBe(10);
  });
});

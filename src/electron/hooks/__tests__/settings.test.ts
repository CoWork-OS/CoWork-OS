/**
 * Tests for hooks settings manager
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
    isEncryptionAvailable: vi.fn().mockReturnValue(true),
    encryptString: vi.fn().mockImplementation((value: string) => Buffer.from(value, "utf-8")),
    decryptString: vi.fn().mockImplementation((buffer: Buffer) => buffer.toString("utf-8")),
  },
}));

// Import after mocking
import { HooksSettingsManager, generateHookToken } from "../settings";

describe("generateHookToken", () => {
  it("should generate a token of default length", () => {
    const token = generateHookToken();
    // Default is 24 bytes = 48 hex characters
    expect(token).toHaveLength(48);
  });

  it("should generate a token of specified length", () => {
    const token = generateHookToken(16);
    // 16 bytes = 32 hex characters
    expect(token).toHaveLength(32);
  });

  it("should generate different tokens each time", () => {
    const token1 = generateHookToken();
    const token2 = generateHookToken();
    expect(token1).not.toBe(token2);
  });

  it("should generate valid hex string", () => {
    const token = generateHookToken();
    expect(token).toMatch(/^[0-9a-f]+$/);
  });
});

describe("HooksSettingsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = undefined;
    writeCount = 0;
    HooksSettingsManager.clearCache();
    (HooksSettingsManager as Any).migrationCompleted = false;
  });

  describe("loadSettings", () => {
    it("should return defaults when no settings file exists", () => {
      const settings = HooksSettingsManager.loadSettings();

      expect(settings.enabled).toBe(false);
      expect(settings.token).toBe("");
      expect(settings.path).toBe("/hooks");
      expect(settings.maxBodyBytes).toBe(256 * 1024);
      expect(settings.presets).toEqual([]);
      expect(settings.mappings).toEqual([]);
    });

    it("should load existing settings", () => {
      mockStoredSettings = {
        enabled: true,
        token: "test-token",
        path: "/webhooks",
        presets: ["gmail"],
      };

      const settings = HooksSettingsManager.loadSettings();

      expect(settings.enabled).toBe(true);
      expect(settings.token).toBe("test-token");
      expect(settings.path).toBe("/webhooks");
      expect(settings.presets).toEqual(["gmail"]);
    });

    it("should cache loaded settings", () => {
      mockStoredSettings = { enabled: true };

      const _settings1 = HooksSettingsManager.loadSettings();
      mockStoredSettings = { enabled: false }; // Change mock
      const settings2 = HooksSettingsManager.loadSettings();

      // Should return cached value
      expect(settings2.enabled).toBe(true);
    });
  });

  describe("saveSettings", () => {
    it("should save settings to disk", () => {
      const settings = HooksSettingsManager.loadSettings();
      settings.enabled = true;
      settings.token = "new-token";

      HooksSettingsManager.saveSettings(settings);

      expect(writeCount).toBe(1);
      expect(mockStoredSettings.enabled).toBe(true);
    });

    it("should update cache after save", () => {
      const settings = HooksSettingsManager.loadSettings();
      settings.enabled = true;
      HooksSettingsManager.saveSettings(settings);

      const cached = HooksSettingsManager.loadSettings();
      expect(cached.enabled).toBe(true);
    });
  });

  describe("clearCache", () => {
    it("should clear the cached settings", () => {
      mockStoredSettings = { enabled: true };
      HooksSettingsManager.loadSettings();

      HooksSettingsManager.clearCache();
      mockStoredSettings = { enabled: false };

      const settings = HooksSettingsManager.loadSettings();
      expect(settings.enabled).toBe(false);
    });
  });

  describe("getDefaults", () => {
    it("should return default settings", () => {
      const defaults = HooksSettingsManager.getDefaults();

      expect(defaults.enabled).toBe(false);
      expect(defaults.token).toBe("");
      expect(defaults.path).toBe("/hooks");
    });
  });

  describe("updateConfig", () => {
    it("should update and save config", () => {
      HooksSettingsManager.updateConfig({ enabled: true });

      expect(mockStoredSettings.enabled).toBe(true);
    });

    it("should merge with existing config", () => {
      mockStoredSettings = { enabled: false, path: "/custom" };
      HooksSettingsManager.clearCache();

      HooksSettingsManager.updateConfig({ enabled: true });

      expect(mockStoredSettings.enabled).toBe(true);
      expect(mockStoredSettings.path).toBe("/custom");
    });
  });

  describe("enableHooks", () => {
    it("should enable hooks and generate token if missing", () => {
      const settings = HooksSettingsManager.enableHooks();

      expect(settings.enabled).toBe(true);
      expect(settings.token).toBeDefined();
      expect(settings.token.length).toBeGreaterThan(0);
    });

    it("should preserve existing token", () => {
      mockStoredSettings = { token: "existing-token" };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.enableHooks();

      expect(settings.token).toBe("existing-token");
    });
  });

  describe("disableHooks", () => {
    it("should disable hooks", () => {
      mockStoredSettings = { enabled: true, token: "test" };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.disableHooks();

      expect(settings.enabled).toBe(false);
    });

    it("should preserve token when disabling", () => {
      mockStoredSettings = { enabled: true, token: "test" };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.disableHooks();

      expect(settings.token).toBe("test");
    });
  });

  describe("regenerateToken", () => {
    it("should generate a new token", () => {
      mockStoredSettings = { token: "old-token" };
      HooksSettingsManager.clearCache();

      const newToken = HooksSettingsManager.regenerateToken();

      expect(newToken).not.toBe("old-token");
      expect(newToken.length).toBe(48);
    });

    it("should save the new token", () => {
      const newToken = HooksSettingsManager.regenerateToken();
      const settings = HooksSettingsManager.loadSettings();

      expect(settings.token).toBe(newToken);
    });
  });

  describe("presets", () => {
    it("should add a preset", () => {
      const settings = HooksSettingsManager.addPreset("gmail");

      expect(settings.presets).toContain("gmail");
    });

    it("should not duplicate presets", () => {
      HooksSettingsManager.addPreset("gmail");
      const settings = HooksSettingsManager.addPreset("gmail");

      expect(settings.presets.filter((p) => p === "gmail")).toHaveLength(1);
    });

    it("should remove a preset", () => {
      mockStoredSettings = { presets: ["gmail", "slack"] };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.removePreset("gmail");

      expect(settings.presets).not.toContain("gmail");
      expect(settings.presets).toContain("slack");
    });
  });

  describe("mappings", () => {
    it("should add a mapping", () => {
      const settings = HooksSettingsManager.addMapping({
        id: "test",
        match: { path: "test" },
        action: "agent",
      });

      expect(settings.mappings).toHaveLength(1);
      expect(settings.mappings[0].id).toBe("test");
    });

    it("should update a mapping by id", () => {
      mockStoredSettings = {
        mappings: [{ id: "test", action: "agent" }],
      };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.updateMapping("test", {
        action: "wake",
      });

      expect(settings?.mappings[0].action).toBe("wake");
    });

    it("should return null when updating non-existent mapping", () => {
      const settings = HooksSettingsManager.updateMapping("non-existent", {
        action: "wake",
      });

      expect(settings).toBeNull();
    });

    it("should remove a mapping by id", () => {
      mockStoredSettings = {
        mappings: [
          { id: "test1", action: "agent" },
          { id: "test2", action: "wake" },
        ],
      };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.removeMapping("test1");

      expect(settings.mappings).toHaveLength(1);
      expect(settings.mappings[0].id).toBe("test2");
    });
  });

  describe("Gmail configuration", () => {
    it("should configure Gmail hooks", () => {
      const settings = HooksSettingsManager.configureGmail({
        account: "test@gmail.com",
        topic: "projects/test/topics/gmail-watch",
      });

      expect(settings.gmail?.account).toBe("test@gmail.com");
      expect(settings.gmail?.topic).toBe("projects/test/topics/gmail-watch");
    });

    it("should auto-add gmail preset when configuring account", () => {
      const settings = HooksSettingsManager.configureGmail({
        account: "test@gmail.com",
      });

      expect(settings.presets).toContain("gmail");
    });

    it("should merge Gmail config with existing", () => {
      mockStoredSettings = {
        gmail: { account: "old@gmail.com", label: "INBOX" },
      };
      HooksSettingsManager.clearCache();

      const settings = HooksSettingsManager.configureGmail({
        account: "new@gmail.com",
      });

      expect(settings.gmail?.account).toBe("new@gmail.com");
      expect(settings.gmail?.label).toBe("INBOX");
    });

    it("should get Gmail config with defaults", () => {
      mockStoredSettings = {
        gmail: { account: "test@gmail.com" },
      };
      HooksSettingsManager.clearCache();

      const gmail = HooksSettingsManager.getGmailConfig();

      expect(gmail.account).toBe("test@gmail.com");
      expect(gmail.label).toBe("INBOX");
      expect(gmail.includeBody).toBe(true);
      expect(gmail.maxBytes).toBe(20_000);
      expect(gmail.renewEveryMinutes).toBe(12 * 60);
      expect(gmail.serve?.bind).toBe("127.0.0.1");
      expect(gmail.serve?.port).toBe(8788);
      expect(gmail.serve?.path).toBe("/gmail-pubsub");
    });
  });

  describe("status checks", () => {
    it("should return true when properly configured", () => {
      mockStoredSettings = { enabled: true, token: "test" };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isConfigured()).toBe(true);
    });

    it("should return false when disabled", () => {
      mockStoredSettings = { enabled: false, token: "test" };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isConfigured()).toBe(false);
    });

    it("should return false when no token", () => {
      mockStoredSettings = { enabled: true, token: "" };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isConfigured()).toBe(false);
    });

    it("should check Gmail configuration", () => {
      mockStoredSettings = {
        gmail: {
          account: "test@gmail.com",
          topic: "projects/test/topics/test",
          pushToken: "token123",
        },
      };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isGmailConfigured()).toBe(true);
    });

    it("should return false for incomplete Gmail config", () => {
      mockStoredSettings = {
        gmail: { account: "test@gmail.com" },
      };
      HooksSettingsManager.clearCache();

      expect(HooksSettingsManager.isGmailConfigured()).toBe(false);
    });
  });

  describe("getSettingsForDisplay", () => {
    it("should mask token", () => {
      mockStoredSettings = { token: "secret-token" };
      HooksSettingsManager.clearCache();

      const display = HooksSettingsManager.getSettingsForDisplay();

      expect(display.token).toBe("***configured***");
    });

    it("should show empty string for missing token", () => {
      mockStoredSettings = { token: "" };
      HooksSettingsManager.clearCache();

      const display = HooksSettingsManager.getSettingsForDisplay();

      expect(display.token).toBe("");
    });

    it("should mask Gmail push token", () => {
      mockStoredSettings = {
        gmail: { pushToken: "secret-push-token" },
      };
      HooksSettingsManager.clearCache();

      const display = HooksSettingsManager.getSettingsForDisplay();

      expect(display.gmail?.pushToken).toBe("***configured***");
    });
  });
});

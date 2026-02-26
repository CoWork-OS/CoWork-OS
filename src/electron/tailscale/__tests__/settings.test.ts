/**
 * Tests for Tailscale Settings Manager
 *
 * Now tests the SecureSettingsRepository-based implementation
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock repository storage
let mockStoredSettings: Record<string, unknown> | undefined = undefined;
const mockRepositorySave = vi.fn().mockImplementation((category: string, settings: unknown) => {
  mockStoredSettings = settings as Record<string, unknown>;
});
const mockRepositoryLoad = vi.fn().mockImplementation(() => mockStoredSettings);
const mockRepositoryExists = vi.fn().mockImplementation(() => mockStoredSettings !== undefined);

// Mock SecureSettingsRepository
vi.mock("../../database/SecureSettingsRepository", () => {
  return {
    SecureSettingsRepository: {
      isInitialized: vi.fn().mockReturnValue(true),
      getInstance: vi.fn().mockImplementation(() => ({
        save: mockRepositorySave,
        load: mockRepositoryLoad,
        exists: mockRepositoryExists,
      })),
    },
  };
});

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Mock fs module (for legacy migration - not used but imported)
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

// Import after mocking
import { TailscaleSettingsManager, DEFAULT_TAILSCALE_SETTINGS } from "../settings";

describe("DEFAULT_TAILSCALE_SETTINGS", () => {
  it("should have expected default values", () => {
    expect(DEFAULT_TAILSCALE_SETTINGS.mode).toBe("off");
    expect(DEFAULT_TAILSCALE_SETTINGS.resetOnExit).toBe(true);
  });
});

describe("TailscaleSettingsManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = undefined;
    TailscaleSettingsManager.clearCache();
    // Reset migration flag
    (TailscaleSettingsManager as Any).migrationCompleted = false;
  });

  describe("loadSettings", () => {
    it("should return defaults when no settings exist", () => {
      mockRepositoryLoad.mockReturnValue(undefined);
      mockRepositoryExists.mockReturnValue(false);

      const settings = TailscaleSettingsManager.loadSettings();

      expect(settings.mode).toBe("off");
      expect(settings.resetOnExit).toBe(true);
    });

    it("should load existing settings from repository", () => {
      mockStoredSettings = {
        mode: "funnel",
        resetOnExit: false,
        lastHostname: "my-machine.tail1234.ts.net",
      };
      mockRepositoryLoad.mockReturnValue(mockStoredSettings);

      const settings = TailscaleSettingsManager.loadSettings();

      expect(settings.mode).toBe("funnel");
      expect(settings.resetOnExit).toBe(false);
      expect(settings.lastHostname).toBe("my-machine.tail1234.ts.net");
    });

    it("should merge with defaults for missing fields", () => {
      mockStoredSettings = {
        mode: "serve",
      };
      mockRepositoryLoad.mockReturnValue(mockStoredSettings);

      const settings = TailscaleSettingsManager.loadSettings();

      expect(settings.mode).toBe("serve");
      expect(settings.resetOnExit).toBe(true); // from defaults
    });

    it("should cache loaded settings", () => {
      mockStoredSettings = { mode: "serve" };
      mockRepositoryLoad.mockReturnValue(mockStoredSettings);

      const _settings1 = TailscaleSettingsManager.loadSettings();
      mockStoredSettings = { mode: "funnel" }; // Change mock
      mockRepositoryLoad.mockReturnValue(mockStoredSettings);
      const settings2 = TailscaleSettingsManager.loadSettings();

      // Should return cached value
      expect(settings2.mode).toBe("serve");
    });
  });

  describe("saveSettings", () => {
    it("should save settings to repository", () => {
      const settings = { ...DEFAULT_TAILSCALE_SETTINGS, mode: "funnel" as const };
      settings.lastHostname = "test.ts.net";

      TailscaleSettingsManager.saveSettings(settings);

      expect(mockRepositorySave).toHaveBeenCalledWith(
        "tailscale",
        expect.objectContaining({
          mode: "funnel",
          lastHostname: "test.ts.net",
        }),
      );
    });

    it("should update cache after save", () => {
      mockRepositoryLoad.mockReturnValue(undefined);
      const settings = TailscaleSettingsManager.loadSettings();
      settings.mode = "serve";
      TailscaleSettingsManager.saveSettings(settings);

      mockRepositoryLoad.mockClear();
      const cached = TailscaleSettingsManager.loadSettings();

      expect(cached.mode).toBe("serve");
      expect(mockRepositoryLoad).not.toHaveBeenCalled(); // Should use cache
    });
  });

  describe("updateSettings", () => {
    it("should update and save settings", () => {
      mockRepositoryLoad.mockReturnValue(undefined);

      TailscaleSettingsManager.updateSettings({
        mode: "funnel",
        lastHostname: "test.ts.net",
      });

      expect(mockRepositorySave).toHaveBeenCalledWith(
        "tailscale",
        expect.objectContaining({
          mode: "funnel",
          lastHostname: "test.ts.net",
        }),
      );
    });

    it("should merge with existing settings", () => {
      mockStoredSettings = { mode: "serve", resetOnExit: false };
      mockRepositoryLoad.mockReturnValue(mockStoredSettings);

      TailscaleSettingsManager.updateSettings({ mode: "funnel" });

      expect(mockRepositorySave).toHaveBeenCalledWith(
        "tailscale",
        expect.objectContaining({
          mode: "funnel",
          resetOnExit: false, // preserved
        }),
      );
    });
  });

  describe("setMode", () => {
    it("should update mode setting", () => {
      mockRepositoryLoad.mockReturnValue(undefined);

      const settings = TailscaleSettingsManager.setMode("funnel");

      expect(settings.mode).toBe("funnel");
      expect(mockRepositorySave).toHaveBeenCalledWith(
        "tailscale",
        expect.objectContaining({
          mode: "funnel",
        }),
      );
    });

    it("should preserve other settings", () => {
      mockStoredSettings = {
        mode: "off",
        resetOnExit: false,
        lastHostname: "test.ts.net",
      };
      mockRepositoryLoad.mockReturnValue(mockStoredSettings);

      TailscaleSettingsManager.setMode("serve");

      expect(mockRepositorySave).toHaveBeenCalledWith(
        "tailscale",
        expect.objectContaining({
          mode: "serve",
          resetOnExit: false,
          lastHostname: "test.ts.net",
        }),
      );
    });
  });

  describe("clearCache", () => {
    it("should clear the cached settings", () => {
      mockStoredSettings = { mode: "serve" };
      mockRepositoryLoad.mockReturnValue(mockStoredSettings);
      TailscaleSettingsManager.loadSettings();

      TailscaleSettingsManager.clearCache();
      mockStoredSettings = { mode: "funnel" };
      mockRepositoryLoad.mockReturnValue(mockStoredSettings);

      const settings = TailscaleSettingsManager.loadSettings();
      expect(settings.mode).toBe("funnel");
    });
  });

  describe("getDefaults", () => {
    it("should return default settings", () => {
      const defaults = TailscaleSettingsManager.getDefaults();

      expect(defaults.mode).toBe("off");
      expect(defaults.resetOnExit).toBe(true);
    });

    it("should return a copy, not the original", () => {
      const defaults1 = TailscaleSettingsManager.getDefaults();
      defaults1.mode = "funnel";
      const defaults2 = TailscaleSettingsManager.getDefaults();

      expect(defaults2.mode).toBe("off");
    });
  });
});

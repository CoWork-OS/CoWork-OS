import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSettings } from "../../../shared/types";

const mocks = vi.hoisted(() => {
  let storedSettings: Partial<AppearanceSettings> | undefined;
  let userDataDir = "";

  return {
    get storedSettings() {
      return storedSettings;
    },
    set storedSettings(value: Partial<AppearanceSettings> | undefined) {
      storedSettings = value;
    },
    repositorySave: vi.fn().mockImplementation((_key: string, settings: unknown) => {
      storedSettings = settings as Partial<AppearanceSettings>;
    }),
    repositoryLoad: vi.fn().mockImplementation(() => storedSettings),
    repositoryExists: vi.fn().mockImplementation(() => storedSettings !== undefined),
    get userDataDir() {
      return userDataDir;
    },
    set userDataDir(value: string) {
      userDataDir = value;
    },
  };
});

vi.mock("../../utils/user-data-dir", () => ({
  getUserDataDir: () => mocks.userDataDir,
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn().mockReturnValue(true),
    getInstance: vi.fn().mockReturnValue({
      save: mocks.repositorySave,
      load: mocks.repositoryLoad,
      exists: mocks.repositoryExists,
    }),
  },
}));

import { AppearanceManager } from "../appearance-manager";

describe("AppearanceManager settings", () => {
  let originalCwd: string;
  let originalNodeEnv: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedSettings = undefined;
    AppearanceManager.clearCache();
    (AppearanceManager as unknown as { migrationCompleted: boolean }).migrationCompleted = false;

    originalCwd = process.cwd();
    originalNodeEnv = process.env.NODE_ENV;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-appearance-"));
    mocks.userDataDir = tempDir;
    process.chdir(tempDir);
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    AppearanceManager.clearCache();
  });

  it("repairs a stale dev log sidecar when loading stored settings", () => {
    const sidecarPath = path.join(tempDir, ".cowork", "dev-log-settings.json");
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({ captureEnabled: false, updatedAt: "stale" }),
      "utf-8",
    );
    mocks.storedSettings = {
      themeMode: "system",
      visualTheme: "warm",
      accentColor: "cyan",
      devRunLoggingEnabled: true,
    };

    const settings = AppearanceManager.loadSettings();

    expect(settings.devRunLoggingEnabled).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidecarPath, "utf-8"))).toMatchObject({
      captureEnabled: true,
    });
  });

  it("keeps the dev log sidecar in sync when returning cached settings", () => {
    const sidecarPath = path.join(tempDir, ".cowork", "dev-log-settings.json");
    mocks.storedSettings = {
      themeMode: "system",
      visualTheme: "warm",
      accentColor: "cyan",
      devRunLoggingEnabled: true,
    };

    AppearanceManager.loadSettings();
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({ captureEnabled: false, updatedAt: "stale" }),
      "utf-8",
    );
    AppearanceManager.loadSettings();

    expect(JSON.parse(fs.readFileSync(sidecarPath, "utf-8"))).toMatchObject({
      captureEnabled: true,
    });
  });

  it("recovers completed onboarding state from the legacy appearance file", () => {
    fs.writeFileSync(
      path.join(tempDir, "appearance-settings.json"),
      JSON.stringify({
        themeMode: "light",
        accentColor: "orange",
        disclaimerAccepted: true,
        onboardingCompleted: true,
        onboardingCompletedAt: "2026-02-01T22:32:08.325Z",
      }),
      "utf-8",
    );
    mocks.storedSettings = {
      themeMode: "system",
      visualTheme: "warm",
      accentColor: "cyan",
      disclaimerAccepted: false,
      onboardingCompleted: false,
    };

    AppearanceManager.initialize();
    const settings = AppearanceManager.loadSettings();

    expect(settings).toMatchObject({
      themeMode: "system",
      accentColor: "cyan",
      disclaimerAccepted: true,
      onboardingCompleted: true,
      onboardingCompletedAt: "2026-02-01T22:32:08.325Z",
    });
    expect(mocks.repositorySave).toHaveBeenCalledWith(
      "appearance",
      expect.objectContaining({
        disclaimerAccepted: true,
        onboardingCompleted: true,
        onboardingCompletedAt: "2026-02-01T22:32:08.325Z",
      }),
    );
  });

  it("persists power density across a cache reset", () => {
    AppearanceManager.saveSettings({ uiDensity: "power" });
    AppearanceManager.clearCache();

    expect(AppearanceManager.loadSettings().uiDensity).toBe("power");
  });
});

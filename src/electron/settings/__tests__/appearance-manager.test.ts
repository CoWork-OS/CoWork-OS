import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSettings } from "../../../shared/types";

const mocks = vi.hoisted(() => {
  let storedSettings: Partial<AppearanceSettings> | undefined;

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
  };
});

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

describe("AppearanceManager developer logging settings", () => {
  let originalCwd: string;
  let originalNodeEnv: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedSettings = undefined;
    AppearanceManager.clearCache();

    originalCwd = process.cwd();
    originalNodeEnv = process.env.NODE_ENV;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-appearance-"));
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
});

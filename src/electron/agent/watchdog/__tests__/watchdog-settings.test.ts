import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  initialized: true,
  saved: undefined as unknown,
  accept: true,
}));

vi.mock("../../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => store.initialized,
    getInstance: () => ({
      load: () => store.saved,
      save: (_category: string, value: unknown) => {
        if (!store.accept) return false;
        store.saved = value;
        return true;
      },
    }),
  },
}));

import { DEFAULT_WATCHDOG_SETTINGS } from "../../../../shared/types";
import {
  normalizeWatchdogSettings,
  watchdogForcedOnByEnv,
  WatchdogSettingsManager,
  WatchdogSettingsPatchSchema,
} from "../watchdog-settings";

afterEach(() => {
  store.initialized = true;
  store.saved = undefined;
  store.accept = true;
  WatchdogSettingsManager.clearCache();
});

describe("watchdog settings", () => {
  it("is off by default", () => {
    expect(DEFAULT_WATCHDOG_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_WATCHDOG_SETTINGS.allowCancel).toBe(false);
    expect(WatchdogSettingsManager.loadSettings()).toEqual(DEFAULT_WATCHDOG_SETTINGS);
  });

  it("normalizes stored values into range", () => {
    expect(
      normalizeWatchdogSettings({
        enabled: "yes",
        intervalMinutes: 0,
        stallMinutes: 99_999,
        progressCheckAfterMinutes: 14.6,
        allowCancel: true,
        extra: 1,
      }),
    ).toEqual({
      enabled: false,
      intervalMinutes: 1,
      stallMinutes: 24 * 60,
      progressCheckAfterMinutes: 15,
      allowCancel: true,
    });
    expect(normalizeWatchdogSettings(null)).toEqual(DEFAULT_WATCHDOG_SETTINGS);
  });

  it("saves a patch over the stored settings", () => {
    const saved = WatchdogSettingsManager.saveSettings({ enabled: true });
    expect(saved).toEqual({ ...DEFAULT_WATCHDOG_SETTINGS, enabled: true });
    WatchdogSettingsManager.clearCache();
    expect(WatchdogSettingsManager.loadSettings().enabled).toBe(true);
  });

  it("refuses to report a save secure storage refused", () => {
    store.accept = false;
    expect(() => WatchdogSettingsManager.saveSettings({ enabled: true })).toThrow(/refused/);
    expect(WatchdogSettingsManager.loadSettings().enabled).toBe(false);
  });

  it("lets COWORK_WATCHDOG turn it on for the headless daemon", () => {
    expect(watchdogForcedOnByEnv({ COWORK_WATCHDOG: "1" })).toBe(true);
    expect(watchdogForcedOnByEnv({ COWORK_WATCHDOG: "off" })).toBe(false);
    expect(WatchdogSettingsManager.loadEffectiveSettings({ COWORK_WATCHDOG: "true" }).enabled).toBe(
      true,
    );
    // The stored value is not changed by the env flag.
    expect(WatchdogSettingsManager.loadSettings().enabled).toBe(false);
  });

  it("validates IPC patches strictly", () => {
    expect(WatchdogSettingsPatchSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(WatchdogSettingsPatchSchema.safeParse({ enabled: "true" }).success).toBe(false);
    expect(WatchdogSettingsPatchSchema.safeParse({ intervalMinutes: 0 }).success).toBe(false);
    expect(WatchdogSettingsPatchSchema.safeParse({ intervalMinutes: 2.5 }).success).toBe(false);
    expect(WatchdogSettingsPatchSchema.safeParse({ unknownKey: 1 }).success).toBe(false);
  });
});

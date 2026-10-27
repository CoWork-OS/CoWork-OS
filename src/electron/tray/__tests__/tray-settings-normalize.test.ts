import { describe, expect, it } from "vitest";
import {
  normalizeTraySettings,
  traySettingsForStorage,
  traySettingsFromStorage,
  type TraySettings,
} from "../TrayManager";

describe("normalizeTraySettings", () => {
  it("drops the retired notification style key from persisted settings", () => {
    expect(
      normalizeTraySettings({ notificationStyle: "near-dock" } as Partial<TraySettings>),
    ).not.toHaveProperty("notificationStyle");
  });
  it("defaults enabled to false when stored value is null", () => {
    expect(
      normalizeTraySettings({
        enabled: null as unknown as boolean,
        showDockIcon: true,
        startMinimized: false,
        closeToTray: true,
        showNotifications: true,
        showApprovalSavedNotifications: true,
      }).enabled,
    ).toBe(false);
  });

  it("preserves explicit enabled: false", () => {
    expect(normalizeTraySettings({ enabled: false }).enabled).toBe(false);
  });

  it("preserves explicit enabled: true", () => {
    expect(normalizeTraySettings({ enabled: true }).enabled).toBe(true);
  });

  it("fills missing keys from defaults", () => {
    const s = normalizeTraySettings({});
    expect(s.enabled).toBe(false);
    expect(s.showDockIcon).toBe(true);
    expect(s.closeToTray).toBe(true);
    expect(s.showNotifications).toBe(true);
    expect(s.showApprovalSavedNotifications).toBe(false);
    expect(s.startMinimized).toBe(false);
  });
});

describe("tray icon opt-in storage", () => {
  it("keeps the icon off when nothing is stored", () => {
    expect(traySettingsFromStorage(null).enabled).toBe(false);
  });

  it("turns off an icon stored before it became opt-in", () => {
    const settings = traySettingsFromStorage({ enabled: true, closeToTray: false });
    expect(settings.enabled).toBe(false);
    expect(settings.closeToTray).toBe(false);
  });

  it("keeps an icon the user turned on after it became opt-in", () => {
    const stored = traySettingsForStorage({ ...normalizeTraySettings({}), enabled: true });
    expect(traySettingsFromStorage(stored).enabled).toBe(true);
  });

  it("does not leak the storage marker into the settings the app uses", () => {
    const stored = traySettingsForStorage(normalizeTraySettings({ enabled: true }));
    expect(traySettingsFromStorage(stored)).not.toHaveProperty("iconOptInVersion");
  });
});

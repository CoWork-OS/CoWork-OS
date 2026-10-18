import { describe, expect, it } from "vitest";
import { normalizeTraySettings, type TraySettings } from "../TrayManager";

describe("normalizeTraySettings", () => {
  it("drops the retired notification style key from persisted settings", () => {
    expect(
      normalizeTraySettings({ notificationStyle: "near-dock" } as Partial<TraySettings>),
    ).not.toHaveProperty("notificationStyle");
  });
  it("defaults enabled to true when stored value is null", () => {
    expect(
      normalizeTraySettings({
        enabled: null as unknown as boolean,
        showDockIcon: true,
        startMinimized: false,
        closeToTray: true,
        showNotifications: true,
        showApprovalSavedNotifications: true,
      }).enabled,
    ).toBe(true);
  });

  it("preserves explicit enabled: false", () => {
    expect(normalizeTraySettings({ enabled: false }).enabled).toBe(false);
  });

  it("preserves explicit enabled: true", () => {
    expect(normalizeTraySettings({ enabled: true }).enabled).toBe(true);
  });

  it("fills missing keys from defaults", () => {
    const s = normalizeTraySettings({});
    expect(s.enabled).toBe(true);
    expect(s.showDockIcon).toBe(true);
    expect(s.closeToTray).toBe(true);
    expect(s.showNotifications).toBe(true);
    expect(s.showApprovalSavedNotifications).toBe(false);
    expect(s.startMinimized).toBe(false);
  });
});

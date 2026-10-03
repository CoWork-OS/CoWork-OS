import { describe, expect, it } from "vitest";
import { normalizeTraySettings } from "../TrayManager";

describe("normalizeTraySettings", () => {
  it("preserves the Dock style and defaults missing or invalid styles to system", () => {
    expect(normalizeTraySettings({ notificationStyle: "near-dock" }).notificationStyle).toBe(
      "near-dock",
    );
    expect(normalizeTraySettings({}).notificationStyle).toBe("system");
    expect(normalizeTraySettings({ notificationStyle: "invalid" as never }).notificationStyle).toBe(
      "system",
    );
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

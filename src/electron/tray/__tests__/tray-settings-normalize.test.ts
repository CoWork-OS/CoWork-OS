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
    expect(s.showApprovalNotifications).toBe(true);
    expect(s.showQuestionNotifications).toBe(true);
    expect(s.completionNotifications).toBe("unfocused");
    expect(s.notificationSound).toBe("default");
    expect(s.preventSleepWhileRunning).toBe(true);
    expect(s.confirmQuitWhileRunning).toBe(true);
    expect(s.windowCaptureShortcut).toBe(true);
    expect(s.dictationShortcut).toBe(false);
  });

  it("keeps the dictation shortcut on once turned on, and ignores non-booleans", () => {
    expect(normalizeTraySettings({ dictationShortcut: true }).dictationShortcut).toBe(true);
    expect(
      normalizeTraySettings({ dictationShortcut: "yes" } as unknown as Partial<TraySettings>)
        .dictationShortcut,
    ).toBe(false);
  });

  it("keeps the window-capture shortcut off once turned off, and ignores non-booleans", () => {
    expect(normalizeTraySettings({ windowCaptureShortcut: false }).windowCaptureShortcut).toBe(
      false,
    );
    expect(
      normalizeTraySettings({ windowCaptureShortcut: "no" } as unknown as Partial<TraySettings>)
        .windowCaptureShortcut,
    ).toBe(true);
  });

  it("keeps valid alert, sleep and quit choices", () => {
    const s = normalizeTraySettings({
      showApprovalNotifications: false,
      showQuestionNotifications: false,
      completionNotifications: "always",
      notificationSound: "Glass",
      preventSleepWhileRunning: false,
      confirmQuitWhileRunning: false,
    });
    expect(s).toMatchObject({
      showApprovalNotifications: false,
      showQuestionNotifications: false,
      completionNotifications: "always",
      notificationSound: "Glass",
      preventSleepWhileRunning: false,
      confirmQuitWhileRunning: false,
    });
  });

  it("replaces values the renderer could send but the app does not offer", () => {
    const s = normalizeTraySettings({
      completionNotifications: "sometimes",
      notificationSound: "../../etc/passwd",
      preventSleepWhileRunning: "yes",
      confirmQuitWhileRunning: null,
      showApprovalNotifications: 1,
    } as unknown as Partial<TraySettings>);
    expect(s.completionNotifications).toBe("unfocused");
    expect(s.notificationSound).toBe("default");
    expect(s.preventSleepWhileRunning).toBe(true);
    expect(s.confirmQuitWhileRunning).toBe(true);
    expect(s.showApprovalNotifications).toBe(true);
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

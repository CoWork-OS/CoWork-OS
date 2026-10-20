import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { nativeTheme } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BROWSER_SETTINGS,
  resolveBrowserColorScheme,
  type BrowserColorScheme,
} from "../../../shared/browser-settings";
import type { AppearanceSettings, ThemeMode } from "../../../shared/types";
import { AppearanceManager } from "../../settings/appearance-manager";
import { BrowserSettingsManager } from "../../settings/browser-settings-manager";
import { attachBrowserColorScheme } from "../browser-color-scheme";
import { BrowserSessionManager } from "../browser-session-manager";

const mocks = vi.hoisted(() => {
  let themeSource = "dark";
  const stored = new Map<string, unknown>();
  return {
    stored,
    load: vi.fn((category: string) => structuredClone(stored.get(category))),
    save: vi.fn((category: string, settings: unknown) => {
      stored.set(category, structuredClone(settings));
    }),
    nativeTheme: {
      get themeSource() {
        return themeSource;
      },
      set themeSource(value: string) {
        themeSource = value;
      },
    },
  };
});

vi.mock("electron", () => ({ nativeTheme: mocks.nativeTheme }));
vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => true,
    getInstance: () => ({ load: mocks.load, save: mocks.save }),
  },
}));
vi.mock("../../admin/policies", () => ({
  getBrowserPolicy: () => ({ developerMode: "user", blockedSitePermissions: [] }),
}));

class Guest extends EventEmitter {
  readonly id: number;
  private destroyed = false;
  private attached = false;
  readonly debugger = {
    isAttached: () => this.attached,
    attach: vi.fn(() => {
      this.attached = true;
    }),
    sendCommand: vi.fn(async (_method: string, _params: unknown) => ({})),
  };

  constructor(id: number) {
    super();
    this.id = id;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }
}

let guests: Guest[];

function createGuest(
  overrides: { apply?: (scheme: BrowserColorScheme | null) => Promise<void> } = {},
) {
  const contents = new Guest(guests.length + 1);
  guests.push(contents);
  const manager = new BrowserSessionManager();
  const apply = vi.fn(
    overrides.apply ??
      ((scheme: BrowserColorScheme | null) => manager.setContentsColorScheme(contents, scheme)),
  );
  // Same wiring as attachBrowserWorkbenchGuest in main.ts.
  attachBrowserColorScheme(contents as unknown as Parameters<typeof attachBrowserColorScheme>[0], {
    getPreference: () =>
      resolveBrowserColorScheme(
        BrowserSettingsManager.loadSettings().colorScheme,
        AppearanceManager.loadSettings().themeMode,
      ),
    subscribe: (listener) => {
      const stopBrowser = BrowserSettingsManager.onChange(listener);
      const stopAppearance = AppearanceManager.onChange(listener);
      return () => {
        stopBrowser();
        stopAppearance();
      };
    },
    apply,
  });
  return { contents, apply };
}

/** A complete stored appearance record, so loading it never rewrites defaults. */
function appearance(themeMode: ThemeMode): AppearanceSettings {
  return {
    themeMode,
    visualTheme: "warm",
    accentColor: "cyan",
    transparencyEffectsEnabled: true,
    uiDensity: "focused",
    timelineVerbosity: "summary",
    commandOutputStyle: "terminal",
    devRunLoggingEnabled: false,
    homeResearchVaultEnabled: false,
    homeNextActionsEnabled: false,
    costReceiptEnabled: false,
    subAgentStatsEnabled: false,
    autoOpenTurnOutput: false,
  };
}

function resetCaches() {
  BrowserSettingsManager.resetCache();
  AppearanceManager.clearCache();
}

function expectScheme(contents: Guest, scheme: BrowserColorScheme | null) {
  expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith("Emulation.setEmulatedMedia", {
    features: scheme ? [{ name: "prefers-color-scheme", value: scheme }] : [],
  });
}

beforeEach(() => {
  guests = [];
  mocks.stored.clear();
  mocks.load.mockClear();
  mocks.save.mockClear();
  resetCaches();
});

afterEach(() => {
  guests.forEach((guest) => guest.destroy());
  resetCaches();
  vi.restoreAllMocks();
});

describe("browser appearance persistence", () => {
  it.each(["light", "dark"] as const)(
    "persists %s in browser settings across cache resets",
    (colorScheme) => {
      BrowserSettingsManager.saveSettings({ searchEngine: "duckduckgo", colorScheme });
      expect(mocks.save).toHaveBeenCalledWith("browser", {
        ...DEFAULT_BROWSER_SETTINGS,
        searchEngine: "duckduckgo",
        colorScheme,
      });
      BrowserSettingsManager.resetCache();
      expect(BrowserSettingsManager.loadSettings()).toMatchObject({
        searchEngine: "duckduckgo",
        colorScheme,
      });
      expect(mocks.load).toHaveBeenLastCalledWith("browser");

      // Saving unrelated preferences must not reset the chosen appearance.
      BrowserSettingsManager.saveSettings({ historyEnabled: false });
      BrowserSettingsManager.resetCache();
      expect(BrowserSettingsManager.loadSettings()).toMatchObject({
        colorScheme,
        historyEnabled: false,
      });
    },
  );

  it("does not invent an explicit choice for older stored preferences", () => {
    mocks.stored.set("browser", { searchEngine: "bing" });
    expect(BrowserSettingsManager.loadSettings().colorScheme).toBeNull();
    BrowserSettingsManager.saveSettings({ restoreTabs: false });
    BrowserSettingsManager.resetCache();
    expect(BrowserSettingsManager.loadSettings().colorScheme).toBeNull();
  });
});

describe("browser guest appearance lifecycle", () => {
  it("leaves pages on the OS appearance while the app follows the system and no choice is saved", async () => {
    const { contents, apply } = createGuest();
    contents.emit("did-navigate");
    contents.emit("dom-ready");
    BrowserSettingsManager.saveSettings({ historyEnabled: false });
    await setImmediate();
    expect(apply).not.toHaveBeenCalled();
    expect(contents.debugger.attach).not.toHaveBeenCalled();
    expect(contents.debugger.sendCommand).not.toHaveBeenCalled();

    BrowserSettingsManager.saveSettings({ colorScheme: "light" });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledExactlyOnceWith("light"));
    expectScheme(contents, "light");
  });

  it.each(["light", "dark"] as const)(
    "applies %s initially, after navigation, and after browser recreation",
    async (colorScheme) => {
      BrowserSettingsManager.saveSettings({ colorScheme });
      const first = createGuest();
      await vi.waitFor(() => expect(first.contents.debugger.sendCommand).toHaveBeenCalledTimes(1));
      expectScheme(first.contents, colorScheme);
      first.contents.emit("did-navigate", {}, "https://example.test/next");
      await vi.waitFor(() => expect(first.contents.debugger.sendCommand).toHaveBeenCalledTimes(2));
      expectScheme(first.contents, colorScheme);
      first.contents.emit("dom-ready");
      await vi.waitFor(() => expect(first.contents.debugger.sendCommand).toHaveBeenCalledTimes(3));
      expectScheme(first.contents, colorScheme);

      first.contents.destroy();
      BrowserSettingsManager.resetCache();
      const recreated = createGuest();
      await vi.waitFor(() =>
        expect(recreated.contents.debugger.sendCommand).toHaveBeenCalledTimes(1),
      );
      expectScheme(recreated.contents, colorScheme);
      BrowserSettingsManager.saveSettings({
        colorScheme: colorScheme === "light" ? "dark" : "light",
      });
      await vi.waitFor(() =>
        expect(recreated.contents.debugger.sendCommand).toHaveBeenCalledTimes(2),
      );
      expectScheme(recreated.contents, colorScheme === "light" ? "dark" : "light");
      expect(first.contents.debugger.sendCommand).toHaveBeenCalledTimes(3);
    },
  );

  it.each(["light", "dark", "system"] as const)(
    "leaves the global app theme %s unchanged when switching browser appearance",
    async (appTheme) => {
      nativeTheme.themeSource = appTheme;
      const themeSetter = vi.spyOn(nativeTheme, "themeSource", "set");
      const appAppearance = appearance(appTheme);
      mocks.stored.set("appearance", structuredClone(appAppearance));
      const { contents } = createGuest();
      for (const colorScheme of ["light", "dark"] as const) {
        BrowserSettingsManager.saveSettings({ colorScheme });
        await vi.waitFor(() => expectScheme(contents, colorScheme));
        expect(nativeTheme.themeSource).toBe(appTheme);
        expect(mocks.stored.get("appearance")).toEqual(appAppearance);
      }
      expect(themeSetter).not.toHaveBeenCalled();
      expect(mocks.save.mock.calls.every(([category]) => category === "browser")).toBe(true);
    },
  );

  it.each(["light", "dark"] as const)(
    "follows the app's %s theme on first open when no browser choice is saved",
    async (appTheme) => {
      mocks.stored.set("appearance", appearance(appTheme));
      const { contents, apply } = createGuest();
      await vi.waitFor(() => expect(apply).toHaveBeenCalledExactlyOnceWith(appTheme));
      expectScheme(contents, appTheme);
      contents.emit("did-navigate");
      await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
      expectScheme(contents, appTheme);
      expect(BrowserSettingsManager.loadSettings().colorScheme).toBeNull();
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it("follows app theme changes until the user picks a browser appearance, then keeps it", async () => {
    mocks.stored.set("appearance", appearance("light"));
    const { contents, apply } = createGuest();
    await vi.waitFor(() => expectScheme(contents, "light"));

    AppearanceManager.saveSettings({ themeMode: "dark" });
    await vi.waitFor(() => expectScheme(contents, "dark"));

    BrowserSettingsManager.saveSettings({ colorScheme: "light" });
    await vi.waitFor(() => expectScheme(contents, "light"));
    expect(mocks.stored.get("browser")).toMatchObject({ colorScheme: "light" });

    const applied = apply.mock.calls.length;
    AppearanceManager.saveSettings({ themeMode: "dark" });
    await vi.waitFor(() => expect(apply.mock.calls.length).toBeGreaterThan(applied));
    expectScheme(contents, "light");

    // A restart reads the saved choice back from the database.
    contents.destroy();
    resetCaches();
    const recreated = createGuest();
    await vi.waitFor(() => expect(recreated.apply).toHaveBeenCalledExactlyOnceWith("light"));
    expectScheme(recreated.contents, "light");

    // Match app clears the saved choice; pages follow the (dark) app again.
    BrowserSettingsManager.saveSettings({ colorScheme: null });
    await vi.waitFor(() => expectScheme(recreated.contents, "dark"));
    expect(mocks.stored.get("browser")).toMatchObject({ colorScheme: null });
    AppearanceManager.saveSettings({ themeMode: "light" });
    await vi.waitFor(() => expectScheme(recreated.contents, "light"));
  });

  it("clears the app-theme override when the app switches back to the system theme", async () => {
    mocks.stored.set("appearance", appearance("light"));
    const { contents } = createGuest();
    await vi.waitFor(() => expectScheme(contents, "light"));
    AppearanceManager.saveSettings({ themeMode: "system" });
    await vi.waitFor(() => expectScheme(contents, null));
  });

  it("updates all live guests, not just the currently visible tab", async () => {
    const first = createGuest();
    const second = createGuest();
    BrowserSettingsManager.saveSettings({ colorScheme: "dark" });
    await vi.waitFor(() => {
      expectScheme(first.contents, "dark");
      expectScheme(second.contents, "dark");
    });
  });

  it("clears a previous override when the stored preference returns to null", async () => {
    BrowserSettingsManager.saveSettings({ colorScheme: "dark" });
    const { contents } = createGuest();
    await vi.waitFor(() => expectScheme(contents, "dark"));
    BrowserSettingsManager.saveSettings({ colorScheme: null });
    await vi.waitFor(() => expectScheme(contents, null));
  });

  it("uses the newest saved preference after an in-flight application completes", async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    BrowserSettingsManager.saveSettings({ colorScheme: "dark" });
    const apply = vi
      .fn<(scheme: BrowserColorScheme | null) => Promise<void>>()
      .mockImplementationOnce(() => inFlight)
      .mockResolvedValue(undefined);
    const guest = createGuest({ apply });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledExactlyOnceWith("dark"));
    guest.contents.emit("did-navigate");
    BrowserSettingsManager.saveSettings({ colorScheme: "light" });
    expect(apply).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(3));
    expect(apply.mock.calls.map(([scheme]) => scheme)).toEqual(["dark", "light", "light"]);
  });

  it("retries a transient CDP failure on the next navigation", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    BrowserSettingsManager.saveSettings({ colorScheme: "dark" });
    const apply = vi
      .fn<(scheme: BrowserColorScheme | null) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Target replaced during navigation"))
      .mockResolvedValue(undefined);
    const guest = createGuest({ apply });
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
    guest.contents.emit("dom-ready");
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply).toHaveBeenLastCalledWith("dark");
  });

  it("unsubscribes from preference changes when the guest is destroyed", () => {
    const contents = new Guest(99);
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    attachBrowserColorScheme(
      contents as unknown as Parameters<typeof attachBrowserColorScheme>[0],
      { getPreference: () => null, subscribe, apply: vi.fn().mockResolvedValue(undefined) },
    );
    expect(subscribe).toHaveBeenCalledOnce();
    contents.destroy();
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith();
  });

  it("drops queued applications when the guest is destroyed", async () => {
    BrowserSettingsManager.saveSettings({ colorScheme: "dark" });
    const { contents, apply } = createGuest();
    // The initial application is queued, but the target disappears before it runs.
    contents.destroy();
    BrowserSettingsManager.saveSettings({ colorScheme: "light" });
    contents.emit("did-navigate");
    contents.emit("dom-ready");
    await setImmediate();
    expect(apply).not.toHaveBeenCalled();
  });
});

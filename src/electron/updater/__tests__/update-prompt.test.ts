import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.5.60", isPackaged: true, getAppPath: () => "/Applications/x.app" },
  net: { fetch: vi.fn() },
  BrowserWindow: class {},
}));

import type { UpdateInfo, UpdatePreferences, UpdateProgress } from "../../../shared/types";
import { UpdateCancelledError } from "../update-manager";
import { UpdatePrompt, type UpdatePromptDeps } from "../update-prompt";
import type { UpdateWindowState } from "../update-window-html";

function release(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    available: true,
    currentVersion: "0.5.60",
    latestVersion: "0.5.61",
    updateMode: "electron-updater",
    supported: true,
    provenance: { source: "live", checkedAt: 1 },
    ...overrides,
  };
}

function setup(options: { check?: UpdateInfo; preferences?: UpdatePreferences } = {}) {
  const shown: UpdateWindowState[] = [];
  let open = false;
  let ready = false;
  let progressListener: ((progress: UpdateProgress) => void) | null = null;
  let preferences: UpdatePreferences = options.preferences ?? { autoDownload: false };

  const manager = {
    checkForUpdates: vi.fn(async () => options.check ?? release()),
    downloadAndInstallUpdate: vi.fn(async () => {
      ready = true;
    }),
    installUpdateAndRestart: vi.fn(async () => undefined),
    cancelDownload: vi.fn(() => true),
    onProgress: vi.fn((listener: (progress: UpdateProgress) => void) => {
      progressListener = listener;
      return () => {
        progressListener = null;
      };
    }),
    isUpdateInProgress: vi.fn(() => false),
    isUpdateReadyToInstall: vi.fn(() => ready),
    getPendingUpdateInfo: vi.fn(() => (ready ? release() : null)),
  };
  const view = {
    show: vi.fn((state: UpdateWindowState) => {
      open = true;
      shown.push(state);
    }),
    close: vi.fn(() => {
      open = false;
    }),
    isOpen: vi.fn(() => open),
  };
  const store = {
    load: vi.fn(() => preferences),
    save: vi.fn((patch: Partial<UpdatePreferences>) => {
      preferences = { ...preferences, ...patch };
      return preferences;
    }),
  };
  const prompt = new UpdatePrompt({
    manager: manager as unknown as UpdatePromptDeps["manager"],
    preferences: store,
    view,
    appName: "CoWork OS",
    locale: () => "en-US",
  });
  return {
    prompt,
    manager,
    view,
    store,
    shown,
    emit: (progress: UpdateProgress) => progressListener?.(progress),
    last: () => shown[shown.length - 1],
  };
}

describe("UpdatePrompt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prompts after a background check finds a release", async () => {
    const t = setup();
    await t.prompt.runBackgroundCheck();
    expect(t.manager.checkForUpdates).toHaveBeenCalledWith("background");
    expect(t.last()).toEqual({
      view: "available",
      currentVersion: "0.5.60",
      latestVersion: "0.5.61",
      showAutoDownload: true,
      autoDownload: false,
    });
  });

  it("stays quiet for a skipped version, a deferred one, and source checkouts", async () => {
    const skipped = setup({ preferences: { autoDownload: false, skippedVersion: "0.5.61" } });
    await skipped.prompt.runBackgroundCheck();
    expect(skipped.view.show).not.toHaveBeenCalled();

    const source = setup({ check: release({ updateMode: "git" }) });
    await source.prompt.runBackgroundCheck();
    expect(source.view.show).not.toHaveBeenCalled();

    const later = setup();
    await later.prompt.runBackgroundCheck();
    await later.prompt.handleAction("later");
    expect(later.view.close).toHaveBeenCalled();
    later.view.show.mockClear();
    await later.prompt.runBackgroundCheck();
    expect(later.view.show).not.toHaveBeenCalled();
  });

  it("remembers Skip This Version", async () => {
    const t = setup();
    await t.prompt.runBackgroundCheck();
    await t.prompt.handleAction("skip");
    expect(t.store.save).toHaveBeenCalledWith({ skippedVersion: "0.5.61" });
    expect(t.view.close).toHaveBeenCalled();
  });

  it("installs through a fresh manual check, shows MB progress, then Ready to Install", async () => {
    const t = setup();
    await t.prompt.runBackgroundCheck();
    t.manager.downloadAndInstallUpdate.mockImplementationOnce(async () => {
      t.emit({
        phase: "downloading",
        percent: 50,
        message: "Downloading update... 50%",
        bytesDownloaded: 50_200_000,
        bytesTotal: 100_400_000,
      });
      expect(t.last()).toEqual({
        view: "progress",
        title: "Downloading update...",
        percent: 50,
        detail: "50.2 MB of 100.4 MB",
        cancellable: true,
      });
      t.emit({ phase: "verifying", percent: 100, message: "Verifying update..." });
      expect(t.last()).toEqual({
        view: "progress",
        title: "Verifying update...",
        cancellable: false,
      });
      t.manager.isUpdateReadyToInstall.mockReturnValue(true);
    });

    await t.prompt.handleAction("install");

    expect(t.manager.checkForUpdates).toHaveBeenLastCalledWith("manual");
    expect(t.manager.downloadAndInstallUpdate).toHaveBeenCalledWith(release());
    expect(t.last()).toEqual({ view: "ready", latestVersion: "0.5.61" });

    await t.prompt.handleAction("relaunch");
    expect(t.manager.installUpdateAndRestart).toHaveBeenCalled();
  });

  it("closes quietly when the download is cancelled", async () => {
    const t = setup();
    await t.prompt.runBackgroundCheck();
    t.manager.downloadAndInstallUpdate.mockRejectedValueOnce(new UpdateCancelledError());
    await t.prompt.handleAction("install");
    expect(t.view.close).toHaveBeenCalled();
    expect(t.shown.some((state) => state.view === "error")).toBe(false);
  });

  it("shows the error when the install fails", async () => {
    const t = setup();
    await t.prompt.runBackgroundCheck();
    t.manager.downloadAndInstallUpdate.mockRejectedValueOnce(new Error("signature failed"));
    await t.prompt.handleAction("install");
    expect(t.last()).toEqual({ view: "error", title: "Update Error!", detail: "signature failed" });
  });

  it("auto-downloads in the background and only shows the window when ready", async () => {
    const t = setup({ preferences: { autoDownload: true } });
    t.manager.downloadAndInstallUpdate.mockImplementationOnce(async () => {
      t.emit({
        phase: "downloading",
        percent: 10,
        message: "x",
        bytesDownloaded: 1,
        bytesTotal: 10,
      });
      t.manager.isUpdateReadyToInstall.mockReturnValue(true);
    });
    await t.prompt.runBackgroundCheck();
    expect(t.shown).toEqual([{ view: "ready", latestVersion: "0.5.61" }]);
  });

  it("keeps a download going when its window is closed, and reopens when ready", async () => {
    const t = setup();
    await t.prompt.runBackgroundCheck();
    t.manager.downloadAndInstallUpdate.mockImplementationOnce(async () => {
      t.prompt.handleClosed();
      expect(t.view.close).toHaveBeenCalled();
      const before = t.shown.length;
      t.emit({
        phase: "downloading",
        percent: 80,
        message: "x",
        bytesDownloaded: 8,
        bytesTotal: 10,
      });
      expect(t.shown.length).toBe(before);
      t.manager.isUpdateReadyToInstall.mockReturnValue(true);
    });
    await t.prompt.handleAction("install");
    expect(t.last()).toEqual({ view: "ready", latestVersion: "0.5.61" });
  });

  it("answers Check for Updates when current, ignoring a skipped version when not", async () => {
    const current = setup({ check: release({ available: false, latestVersion: "0.5.60" }) });
    await current.prompt.checkNow();
    expect(current.shown[0]).toEqual({
      view: "progress",
      title: "Checking for updates...",
      cancellable: false,
    });
    expect(current.last()).toEqual({
      view: "up-to-date",
      title: "You're up to date!",
      detail: "CoWork OS 0.5.60 is currently the newest version available.",
    });

    const skipped = setup({ preferences: { autoDownload: false, skippedVersion: "0.5.61" } });
    await skipped.prompt.checkNow();
    expect(skipped.last()).toMatchObject({ view: "available", latestVersion: "0.5.61" });
  });

  it("hides the auto-download option for npm installs", async () => {
    const t = setup({ check: release({ updateMode: "npm" }) });
    await t.prompt.runBackgroundCheck();
    expect(t.last()).toMatchObject({ view: "available", showAutoDownload: false });
  });

  it("saves the auto-download checkbox", async () => {
    const t = setup();
    await t.prompt.runBackgroundCheck();
    await t.prompt.handleAction("auto-download-on");
    expect(t.store.save).toHaveBeenCalledWith({ autoDownload: true });
  });
});

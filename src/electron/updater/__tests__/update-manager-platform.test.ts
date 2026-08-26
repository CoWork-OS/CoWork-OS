import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  updaterOn: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.5.51",
    isPackaged: true,
    getAppPath: () => "/Applications/CoWork OS.app",
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  net: { fetch: mocks.fetch },
  BrowserWindow: class {},
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    autoDownload: true,
    on: mocks.updaterOn,
    checkForUpdates: mocks.checkForUpdates,
    downloadUpdate: mocks.downloadUpdate,
    quitAndInstall: vi.fn(),
  },
}));

import { UpdateManager } from "../update-manager";

function updateInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    available: true,
    currentVersion: "0.5.51",
    latestVersion: "0.5.52",
    updateMode: "electron-updater",
    supported: false,
    ...overrides,
  };
}

describe("UpdateManager platform compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.5.52",
        name: "0.5.52",
        body: "Electron 44",
        html_url: "https://example.com/release",
        published_at: "2026-08-27T00:00:00Z",
        assets: [],
      }),
    });
    mocks.checkForUpdates.mockResolvedValue({ updateInfo: { version: "0.5.52" } });
    mocks.downloadUpdate.mockResolvedValue([]);
  });

  it("reports a newer release without offering it on Monterey", async () => {
    const manager = new UpdateManager("darwin", () => "21.6.0");

    await expect(manager.checkForUpdates()).resolves.toMatchObject({
      available: true,
      latestVersion: "0.5.52",
      supported: false,
      minimumSystemLabel: "macOS 13 Ventura",
      lastCompatibleVersion: "0.5.51",
    });
  });

  it("re-checks compatibility before invoking any update mechanism", async () => {
    const manager = new UpdateManager("darwin", () => "21.6.0");
    const checked = await manager.checkForUpdates();

    await expect(manager.downloadAndInstallUpdate(checked)).rejects.toThrow(
      "requires macOS 13 Ventura",
    );
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
  });

  it("checks packaged metadata before explicitly downloading a compatible update", async () => {
    const manager = new UpdateManager("darwin", () => "22.0.0");
    const checked = await manager.checkForUpdates();

    await manager.downloadAndInstallUpdate(checked);

    expect(mocks.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.downloadUpdate).toHaveBeenCalledOnce();
    expect(mocks.checkForUpdates.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.downloadUpdate.mock.invocationCallOrder[0],
    );
  });

  it("does not trust a renderer-supplied update that was not checked", async () => {
    const manager = new UpdateManager("darwin", () => "22.0.0");

    await expect(manager.downloadAndInstallUpdate(updateInfo({ supported: true }))).rejects.toThrow(
      "Check for updates again",
    );
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.downloadUpdate).not.toHaveBeenCalled();
  });

  it("pins npm installation to the version returned by the checked release", async () => {
    const manager = new UpdateManager("linux", () => "6.8.0");
    vi.spyOn(manager, "getVersionInfo").mockResolvedValue({
      version: "0.5.51",
      isDev: false,
      isGitRepo: false,
      isNpmGlobal: true,
    });
    const runNpmGlobalUpdate = vi
      .spyOn(manager as never, "runNpmGlobalUpdate")
      .mockResolvedValue(undefined);
    const checked = await manager.checkForUpdates();

    await manager.downloadAndInstallUpdate(checked);

    expect(runNpmGlobalUpdate).toHaveBeenCalledWith("0.5.52");
  });

  it("uses the exact Git target version for platform compatibility", async () => {
    const manager = new UpdateManager("darwin", () => "21.6.0");
    vi.spyOn(manager, "getVersionInfo").mockResolvedValue({
      version: "0.5.51",
      isDev: true,
      isGitRepo: true,
      isNpmGlobal: false,
      gitCommit: "1111111",
    });
    vi.spyOn(manager as never, "checkForNewCommits").mockResolvedValue({
      commit: "a".repeat(40),
      version: "0.5.52",
    });

    const checked = await manager.checkForUpdates();

    expect(checked).toMatchObject({
      available: true,
      latestVersion: `0.5.52 (${"a".repeat(7)})`,
      supported: false,
    });
    await expect(manager.downloadAndInstallUpdate(checked)).rejects.toThrow(
      "requires macOS 13 Ventura",
    );
  });

  it("merges the exact Git commit captured during the update check", async () => {
    const manager = new UpdateManager("darwin", () => "22.0.0");
    const commit = "b".repeat(40);
    vi.spyOn(manager, "getVersionInfo").mockResolvedValue({
      version: "0.5.51",
      isDev: true,
      isGitRepo: true,
      isNpmGlobal: false,
      gitCommit: "1111111",
    });
    vi.spyOn(manager as never, "checkForNewCommits").mockResolvedValue({
      commit,
      version: "0.5.52",
    });
    const runGitCommand = vi
      .spyOn(manager as never, "runGitCommand")
      .mockResolvedValue({ stdout: "", stderr: "" });
    vi.spyOn(manager as never, "runNpmInstall").mockResolvedValue(undefined);
    vi.spyOn(manager as never, "runNpmBuild").mockResolvedValue(undefined);
    const checked = await manager.checkForUpdates();

    await manager.downloadAndInstallUpdate(checked);

    expect(runGitCommand).toHaveBeenCalledWith(`git merge --ff-only ${commit}`, {
      cwd: "/Applications/CoWork OS.app",
    });
    expect(runGitCommand).not.toHaveBeenCalledWith(
      expect.stringContaining("git pull"),
      expect.anything(),
    );
  });
});

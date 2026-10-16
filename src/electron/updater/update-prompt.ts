/**
 * The software update prompt: a Sparkle-style flow in its own small window.
 *
 *   background check finds a release → "A new version is available" (Skip / Later / Install)
 *   Install → "Updating CoWork OS": downloading (MB of MB, Cancel) → verifying → Ready to Install
 *   Install and Relaunch → the existing verified install path.
 *
 * The window only drives UpdateManager; the install guards (a fresh manual check
 * names the target, the signature check gates installation) stay where they are.
 * Source checkouts never pop the prompt on their own: they update to every new
 * commit on main. They still get it from "Check for Updates…".
 */

import type { UpdateInfo, UpdatePreferences, UpdateProgress } from "../../shared/types";
import { createLogger } from "../utils/logger";
import { UpdateCancelledError, type UpdateManager } from "./update-manager";
import {
  formatUpdateBytes,
  type UpdateWindowAction,
  type UpdateWindowState,
} from "./update-window-html";

const log = createLogger("UpdatePrompt");

/** First background check after launch, then one a day, like Sparkle's default. */
export const FIRST_BACKGROUND_CHECK_DELAY_MS = 5_000;
export const BACKGROUND_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateWindowView {
  show(state: UpdateWindowState): void;
  close(): void;
  isOpen(): boolean;
}

export interface UpdatePromptDeps {
  manager: Pick<
    UpdateManager,
    | "checkForUpdates"
    | "downloadAndInstallUpdate"
    | "installUpdateAndRestart"
    | "cancelDownload"
    | "onProgress"
    | "isUpdateInProgress"
    | "isUpdateReadyToInstall"
    | "getPendingUpdateInfo"
  >;
  preferences: {
    load(): UpdatePreferences;
    save(patch: Partial<UpdatePreferences>): UpdatePreferences;
  };
  view: UpdateWindowView;
  appName: string;
  locale?: () => string | undefined;
}

type FlowPhase = "idle" | "prompting" | "checking" | "installing" | "ready" | "message";

export class UpdatePrompt {
  private phase: FlowPhase = "idle";
  /** The release the window is about. */
  private target: UpdateInfo | null = null;
  /** "Remind Me Later" for this release, until the app restarts. */
  private remindLaterVersion: string | null = null;
  /** A background auto-download shows nothing until the update is ready. */
  private silent = false;
  private progressDetached: (() => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly deps: UpdatePromptDeps) {}

  /** Schedule the background checks. Safe to call once per launch. */
  start(): void {
    if (this.timers.length > 0) return;
    const first = setTimeout(() => void this.runBackgroundCheck(), FIRST_BACKGROUND_CHECK_DELAY_MS);
    const daily = setInterval(() => void this.runBackgroundCheck(), BACKGROUND_CHECK_INTERVAL_MS);
    first.unref?.();
    daily.unref?.();
    this.timers.push(first, daily);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.progressDetached?.();
    this.progressDetached = null;
  }

  /** A quiet check: prompts only for a release the user has not skipped or deferred. */
  async runBackgroundCheck(): Promise<void> {
    if (
      this.phase !== "idle" ||
      this.deps.view.isOpen() ||
      this.deps.manager.isUpdateInProgress() ||
      // Already downloaded: Settings and "Check for Updates…" offer the relaunch.
      this.deps.manager.isUpdateReadyToInstall()
    ) {
      return;
    }
    let info: UpdateInfo;
    try {
      info = await this.deps.manager.checkForUpdates("background");
    } catch (error) {
      log.debug("Background update check failed", error);
      return;
    }
    // Something else may have opened the window while the check ran.
    if (this.phase !== "idle" || this.deps.view.isOpen()) return;
    if (!info.available || info.supported === false || info.updateMode === "git") return;
    const preferences = this.deps.preferences.load();
    if (preferences.skippedVersion === info.latestVersion) return;
    if (this.remindLaterVersion === info.latestVersion) return;

    if (preferences.autoDownload && info.updateMode === "electron-updater") {
      await this.install(info, { silent: true });
      return;
    }
    this.showAvailable(info);
  }

  /** "Check for Updates…": always answers, and ignores a skipped version. */
  async checkNow(): Promise<void> {
    if (this.phase === "installing" && this.silent) {
      // A quiet download is running: show it instead of starting another.
      this.silent = false;
      this.deps.view.show({ view: "progress", title: "Downloading update...", cancellable: true });
      return;
    }
    if (this.phase === "installing" || this.phase === "checking") {
      this.showCurrent();
      return;
    }
    if (this.deps.manager.isUpdateReadyToInstall()) {
      this.target = this.deps.manager.getPendingUpdateInfo();
      this.showReady();
      return;
    }
    this.phase = "checking";
    this.deps.view.show({ view: "progress", title: "Checking for updates...", cancellable: false });
    let info: UpdateInfo;
    try {
      info = await this.deps.manager.checkForUpdates("manual");
    } catch (error) {
      this.showMessage("error", "Update Error!", this.describeError(error));
      return;
    }
    if (this.phase !== "checking") return;
    if (info.available && info.supported === false) {
      this.showMessage(
        "error",
        `This update requires ${info.minimumSystemLabel || "a newer system"}.`,
        info.unsupportedReason || "This version can't be installed on this computer.",
      );
      return;
    }
    if (info.available) {
      this.showAvailable(info);
      return;
    }
    if (info.provenance.source === "unavailable") {
      this.showMessage(
        "error",
        "Couldn't check for updates.",
        info.provenance.networkError || "Check your connection and try again.",
      );
      return;
    }
    this.showMessage(
      "up-to-date",
      "You're up to date!",
      `${this.deps.appName} ${info.currentVersion} is currently the newest version available.`,
    );
  }

  /** A click in the window. */
  async handleAction(action: UpdateWindowAction): Promise<void> {
    switch (action) {
      case "install":
        if (this.phase === "prompting" && this.target) await this.install(this.target);
        return;
      case "skip":
        if (this.target) this.deps.preferences.save({ skippedVersion: this.target.latestVersion });
        this.dismiss();
        return;
      case "later":
        if (this.target) this.remindLaterVersion = this.target.latestVersion;
        this.dismiss();
        return;
      case "auto-download-on":
      case "auto-download-off":
        this.deps.preferences.save({ autoDownload: action === "auto-download-on" });
        return;
      case "cancel":
        this.deps.manager.cancelDownload();
        return;
      case "relaunch":
        if (this.phase !== "ready") return;
        try {
          await this.deps.manager.installUpdateAndRestart();
        } catch (error) {
          this.showMessage("error", "Update Error!", this.describeError(error));
        }
        return;
      case "close":
        this.handleClosed();
        return;
    }
  }

  /** The window went away (its close button, Escape, or OK). */
  handleClosed(): void {
    if (this.phase === "installing") {
      // The download keeps going; the window comes back when it is ready.
      this.silent = true;
      this.deps.view.close();
      return;
    }
    if (this.phase === "prompting" && this.target) {
      // Closing the prompt is a "later", as in Sparkle.
      this.remindLaterVersion = this.target.latestVersion;
    }
    this.dismiss();
  }

  private async install(info: UpdateInfo, options: { silent?: boolean } = {}): Promise<void> {
    this.phase = "installing";
    this.silent = Boolean(options.silent);
    this.target = info;
    if (!this.silent) {
      this.deps.view.show({ view: "progress", title: "Preparing update...", cancellable: false });
    }
    this.progressDetached?.();
    this.progressDetached = this.deps.manager.onProgress((progress) => this.onProgress(progress));
    try {
      // Installing needs a manual check: that is what names the install target.
      const checked = await this.deps.manager.checkForUpdates("manual");
      if (!checked.available || checked.supported === false) {
        throw new Error("This update is no longer available. Check for updates again.");
      }
      this.target = checked;
      await this.deps.manager.downloadAndInstallUpdate(checked);
      if (!this.deps.manager.isUpdateReadyToInstall()) {
        throw new Error("The update did not finish downloading. Try again.");
      }
      this.showReady();
    } catch (error) {
      if (error instanceof UpdateCancelledError) {
        this.dismiss();
        return;
      }
      log.warn("Update failed", error);
      if (this.silent) {
        this.dismiss();
        return;
      }
      this.showMessage("error", "Update Error!", this.describeError(error));
    } finally {
      this.progressDetached?.();
      this.progressDetached = null;
    }
  }

  private onProgress(progress: UpdateProgress): void {
    if (this.phase !== "installing" || this.silent) return;
    const state = this.progressState(progress);
    if (state) this.deps.view.show(state);
  }

  private progressState(progress: UpdateProgress): UpdateWindowState | null {
    switch (progress.phase) {
      case "downloading": {
        const packaged = this.target?.updateMode === "electron-updater";
        const hasBytes =
          typeof progress.bytesTotal === "number" &&
          progress.bytesTotal > 0 &&
          typeof progress.bytesDownloaded === "number";
        return {
          view: "progress",
          title: packaged ? "Downloading update..." : progress.message,
          percent: progress.percent,
          detail: hasBytes
            ? formatUpdateBytes(
                progress.bytesDownloaded as number,
                progress.bytesTotal as number,
                this.deps.locale?.(),
              )
            : undefined,
          cancellable: packaged,
        };
      }
      case "verifying":
      case "extracting":
        return { view: "progress", title: "Verifying update...", cancellable: false };
      case "installing":
        return {
          view: "progress",
          title: progress.message || "Installing update...",
          percent: progress.percent,
          cancellable: false,
        };
      default:
        // complete, cancelled and error are settled by install() itself.
        return null;
    }
  }

  private showAvailable(info: UpdateInfo): void {
    this.phase = "prompting";
    this.target = info;
    const preferences = this.deps.preferences.load();
    this.deps.view.show({
      view: "available",
      currentVersion: info.currentVersion,
      latestVersion: info.latestVersion,
      showAutoDownload: info.updateMode === "electron-updater",
      autoDownload: preferences.autoDownload,
    });
  }

  private showReady(): void {
    this.phase = "ready";
    this.silent = false;
    this.deps.view.show({ view: "ready", latestVersion: this.target?.latestVersion ?? "" });
  }

  private showCurrent(): void {
    if (this.phase === "checking") {
      this.deps.view.show({
        view: "progress",
        title: "Checking for updates...",
        cancellable: false,
      });
    } else if (this.phase === "installing") {
      this.silent = false;
      this.deps.view.show({ view: "progress", title: "Downloading update...", cancellable: true });
    }
  }

  private showMessage(kind: "up-to-date" | "error", title: string, detail: string): void {
    this.phase = "message";
    this.deps.view.show({ view: kind, title, detail });
  }

  private dismiss(): void {
    this.phase = "idle";
    this.silent = false;
    this.deps.view.close();
  }

  private describeError(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
  }
}

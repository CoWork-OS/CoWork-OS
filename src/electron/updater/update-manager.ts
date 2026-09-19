import { app, BrowserWindow, net } from "electron";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as _path from "path";
import * as _fs from "fs";
import { UpdateInfo, UpdateProgress, AppVersionInfo, IPC_CHANNELS } from "../../shared/types";
import { compareVersions, getUpdatePlatformCompatibility } from "../../shared/platform-support";
import {
  fetchArtifactSignature,
  isReleaseSignatureEnforced,
  verifyReleaseArtifact,
  type ReleaseSignatureResult,
} from "./release-signature";
import { createLogger } from "../utils/logger";
import { isPulseConsentGranted } from "../telemetry/pulse-service";

const log = createLogger("UpdateManager");
const execAsync = promisify(exec);

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  published_at: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

interface GitUpdateTarget {
  commit: string;
  version: string;
}

export class UpdateManager {
  private mainWindow: BrowserWindow | null = null;
  private repoOwner = "CoWork-OS";
  private repoName = "CoWork-OS";
  private isUpdating = false;
  private updaterEventsConfigured = false;
  /** Signature check started by the update-downloaded handler, awaited by electronUpdaterUpdate. */
  private pendingVerification: Promise<void> | null = null;
  private pendingUpdateInfo: UpdateInfo | null = null;
  private checkedGitTarget: GitUpdateTarget | null = null;
  private pendingGitTarget: GitUpdateTarget | null = null;
  private lastCheckedUpdateInfo: UpdateInfo | null = null;
  private updateReadyToInstall = false;

  constructor(
    private readonly runtimePlatform: NodeJS.Platform | string = process.platform,
    private readonly runtimeRelease: () => string = os.release,
  ) {}

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  private sendProgress(progress: UpdateProgress): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_PROGRESS, progress);
    }
  }

  private sendError(error: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_ERROR, { error });
    }
  }

  async getVersionInfo(): Promise<AppVersionInfo> {
    const version = app.getVersion();
    const isDev = !app.isPackaged;
    let isGitRepo = false;
    let isNpmGlobal = false;
    let gitBranch: string | undefined;
    let gitCommit: string | undefined;

    const appPath = app.getAppPath();

    // Check if installed via npm global
    isNpmGlobal = this.detectNpmGlobalInstall(appPath);

    if (isDev && !isNpmGlobal) {
      try {
        const { stdout: branchOut } = await this.runGitCommand("git rev-parse --abbrev-ref HEAD", {
          cwd: appPath,
        });
        gitBranch = branchOut.trim();

        const { stdout: commitOut } = await this.runGitCommand("git rev-parse --short HEAD", {
          cwd: appPath,
        });
        gitCommit = commitOut.trim();

        isGitRepo = true;
      } catch {
        isGitRepo = false;
      }
    }

    return {
      version,
      isDev,
      isGitRepo,
      isNpmGlobal,
      gitBranch,
      gitCommit,
    };
  }

  private detectNpmGlobalInstall(appPath: string): boolean {
    // Check common npm global installation paths
    const npmGlobalPatterns = [
      "/usr/local/lib/node_modules",
      "/usr/lib/node_modules",
      "/opt/homebrew/lib/node_modules",
      "node_modules/cowork-os",
      ".nvm/versions/node",
      ".npm-global",
      "AppData/Roaming/npm/node_modules", // Windows (user-level)
      "Program Files/nodejs/node_modules", // Windows (system-level)
    ];

    const normalizedPath = appPath.replace(/\\/g, "/");
    return npmGlobalPatterns.some((pattern) => normalizedPath.includes(pattern));
  }

  /**
   * Verify the detached Ed25519 signature of the artifact electron-updater just
   * downloaded, using the public key embedded in this build.
   *
   * The `update-downloaded` event carries the local path of the downloaded file
   * (`downloadedFile`); the signature is published as `<asset>.sig` on the same
   * release. A missing key means enforcement is off and this returns verified
   * with a reason the caller logs.
   *
   * The asset name is derived from `downloadedFile` and NOT from `event.files`:
   * a release can publish several artifacts for one platform (macOS ships both
   * a .zip and a .dmg), and `files[0]` is not necessarily the one
   * electron-updater chose. Verifying one asset's signature against another
   * asset's bytes always fails, which would block every update once a signing
   * key is embedded.
   */
  private async verifyDownloadedArtifact(event: Any): Promise<ReleaseSignatureResult> {
    if (!isReleaseSignatureEnforced()) {
      return { status: "unverified", reason: "no_public_key_configured" };
    }

    const artifactPath: string | undefined =
      typeof event?.downloadedFile === "string" ? event.downloadedFile : undefined;
    if (!artifactPath) {
      return { status: "failed", reason: "downloaded_artifact_path_unavailable" };
    }

    const assetName = _path.basename(artifactPath);
    const version = event?.version || this.pendingUpdateInfo?.latestVersion;
    if (!assetName || !version) {
      return { status: "failed", reason: "release_asset_url_unavailable" };
    }

    const signature = await fetchArtifactSignature(
      `https://github.com/${this.repoOwner}/${this.repoName}/releases/download/v${version}/${encodeURIComponent(
        assetName,
      )}`,
    );
    return verifyReleaseArtifact(artifactPath, signature);
  }

  async checkForUpdates(): Promise<UpdateInfo> {
    const versionInfo = await this.getVersionInfo();
    const currentVersion = versionInfo.version;
    this.lastCheckedUpdateInfo = null;
    this.checkedGitTarget = null;

    this.sendProgress({ phase: "checking", message: "Checking for updates..." });

    try {
      const release = await this.fetchLatestRelease(currentVersion);

      // Determine update mode based on installation type
      const updateMode = this.getUpdateMode(versionInfo);

      if (!release) {
        // The repository has no published release to compare against. Report
        // "up to date" rather than an error — this is not a failed check.
        return this.recordCheckedUpdate({
          available: false,
          currentVersion,
          latestVersion: currentVersion,
          updateMode,
          supported: true,
        });
      }

      const latestVersion = release.tag_name.replace(/^v/, "");
      const available = this.isNewerVersion(latestVersion, currentVersion);

      if (versionInfo.isGitRepo) {
        // A source checkout updates from origin/main, so validate that exact
        // commit instead of assuming it matches the latest release tag.
        const localIsNewer = this.isNewerVersion(currentVersion, latestVersion);
        if (!localIsNewer) {
          const gitTarget = await this.checkForNewCommits();
          if (gitTarget) {
            this.checkedGitTarget = gitTarget;
            return this.recordCheckedUpdate({
              available: true,
              currentVersion: `${currentVersion} (${versionInfo.gitCommit})`,
              latestVersion: `${gitTarget.version} (${gitTarget.commit.slice(0, 7)})`,
              releaseNotes: "New commits available on the main branch.",
              releaseUrl: `https://github.com/${this.repoOwner}/${this.repoName}`,
              updateMode: "git",
              ...this.getCompatibility(gitTarget.version),
            });
          }
        }
      }

      return this.recordCheckedUpdate({
        // Git updates are offered only when an exact fetched commit was captured above.
        available: updateMode === "git" ? false : available,
        currentVersion,
        latestVersion,
        releaseNotes: typeof release.body === "string" ? release.body : undefined,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        updateMode,
        ...this.getCompatibility(latestVersion),
      });
    } catch (error: Any) {
      this.sendError(error.message);
      throw error;
    }
  }

  private recordCheckedUpdate(updateInfo: UpdateInfo): UpdateInfo {
    this.lastCheckedUpdateInfo = updateInfo;
    return updateInfo;
  }

  /**
   * Resolve the latest published release.
   *
   * Returns `null` when the release endpoint reports that there is no release
   * to compare against (HTTP 404: repository has none published yet, or was
   * renamed/made private). That is "you are up to date", not an error, and the
   * caller must not surface it as a failed check.
   *
   * The Pulse collector is consulted only when the user has explicitly opted
   * into Pulse. It is an adoption-reporting side channel that carries version,
   * platform, arch and surface, so it is subject to the same consent gate as
   * the rest of Pulse — a user who declined must not be fingerprinted by the
   * update check. GitHub is always the fallback, so update discovery never
   * depends on Pulse being reachable or enabled.
   *
   * The on-disk copy is a *fallback for an unreachable network*, not a
   * short-circuit: serving it ahead of the network made an explicit "Check for
   * updates" unable to see a release published in the last 24 hours.
   */
  private async fetchLatestRelease(currentVersion: string): Promise<GitHubRelease | null> {
    const cachePath =
      typeof app.getPath === "function"
        ? _path.join(app.getPath("userData"), "update-check-cache.json")
        : null;

    let release: GitHubRelease | null = null;
    if (isPulseConsentGranted() && !process.env.CI && process.env.NODE_ENV !== "test") {
      try {
        const params = new URLSearchParams({
          version: currentVersion,
          platform:
            this.runtimePlatform === "darwin"
              ? "macos"
              : this.runtimePlatform === "win32"
                ? "windows"
                : this.runtimePlatform === "linux"
                  ? "linux"
                  : "other",
          arch: process.arch === "arm64" || process.arch === "x64" ? process.arch : "other",
          surface: "desktop",
        });
        const pulseResponse = await net.fetch(
          `https://pulse.coworkosapp.com/v1/latest-version?${params.toString()}`,
          { headers: { Accept: "application/json" } },
        );
        if (pulseResponse.ok) {
          const candidate = (await pulseResponse.json()) as GitHubRelease;
          if (this.isReleaseShape(candidate)) release = candidate;
        }
      } catch {
        // The public collector is optional; use GitHub directly below.
      }
    }

    if (!release) {
      let response: Awaited<ReturnType<typeof net.fetch>>;
      try {
        response = await net.fetch(
          `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "CoWork-OS-Updater",
            },
          },
        );
      } catch (error) {
        // Offline or DNS failure: fall back to the last known release rather
        // than failing the check outright.
        const cached = await this.readCachedRelease(cachePath);
        if (cached) return cached;
        throw error;
      }

      // No published release is a valid answer, not a failure.
      if (response.status === 404) return null;
      if (!response.ok) {
        const cached = await this.readCachedRelease(cachePath);
        if (cached) return cached;
        throw new Error(`GitHub API error: ${response.status}`);
      }
      release = (await response.json()) as GitHubRelease;
    }

    if (cachePath) {
      try {
        await _fs.promises.mkdir(_path.dirname(cachePath), { recursive: true });
        await _fs.promises.writeFile(
          cachePath,
          JSON.stringify({ checkedAt: Date.now(), release }),
          {
            mode: 0o600,
          },
        );
      } catch {
        // Cache failures must not make updates fail.
      }
    }
    return release;
  }

  private async readCachedRelease(cachePath: string | null): Promise<GitHubRelease | null> {
    if (!cachePath) return null;
    try {
      const cached = JSON.parse(await _fs.promises.readFile(cachePath, "utf8")) as {
        checkedAt?: number;
        release?: GitHubRelease;
      };
      if (cached.release && this.isReleaseShape(cached.release)) return cached.release;
    } catch {
      // No cache, or an interrupted write.
    }
    return null;
  }

  private isReleaseShape(value: GitHubRelease): value is GitHubRelease {
    return Boolean(
      value &&
      typeof value.tag_name === "string" &&
      typeof value.html_url === "string" &&
      Array.isArray(value.assets),
    );
  }

  private runGitCommand(command: string, options: { cwd: string }) {
    return execAsync(command, options);
  }

  private async checkForNewCommits(): Promise<GitUpdateTarget | null> {
    try {
      const appPath = app.getAppPath();

      // Fetch latest from remote
      await this.runGitCommand("git fetch origin", { cwd: appPath });

      const { stdout: commitOut } = await this.runGitCommand("git rev-parse origin/main", {
        cwd: appPath,
      });
      const commit = commitOut.trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) return null;

      // Check if there are commits ahead on the exact fetched target.
      const { stdout } = await this.runGitCommand(`git rev-list HEAD..${commit} --count`, {
        cwd: appPath,
      });
      const commitsAhead = parseInt(stdout.trim(), 10);
      if (commitsAhead <= 0) return null;

      const { stdout: packageJsonText } = await this.runGitCommand(
        `git show ${commit}:package.json`,
        { cwd: appPath },
      );
      const version = JSON.parse(packageJsonText)?.version;
      if (typeof version !== "string" || !version.trim()) return null;

      return { commit, version: version.trim() };
    } catch {
      return null;
    }
  }

  private isNewerVersion(latest: string, current: string): boolean {
    return compareVersions(latest, current) > 0;
  }

  private getCompatibility(targetVersion: string) {
    return getUpdatePlatformCompatibility({
      platform: this.runtimePlatform,
      release: this.runtimeRelease(),
      targetVersion,
    });
  }

  private assertUpdateSupported(targetVersion: string): void {
    const compatibility = this.getCompatibility(targetVersion);
    if (compatibility.supported) return;

    const recovery = compatibility.recoveryCommand
      ? ` To keep using this Mac, install the last compatible release with: ${compatibility.recoveryCommand}`
      : "";
    throw new Error(
      `${compatibility.unsupportedReason || "This update is not supported."}${recovery}`,
    );
  }

  private getUpdateMode(versionInfo: AppVersionInfo): "git" | "npm" | "electron-updater" {
    if (versionInfo.isNpmGlobal) {
      return "npm";
    }
    if (versionInfo.isGitRepo) {
      return "git";
    }
    return "electron-updater";
  }

  async downloadAndInstallUpdate(updateInfo: UpdateInfo): Promise<void> {
    if (this.isUpdating) {
      throw new Error("Update already in progress");
    }

    const checkedUpdate = this.lastCheckedUpdateInfo;
    if (
      !checkedUpdate ||
      !checkedUpdate.available ||
      checkedUpdate.latestVersion !== updateInfo.latestVersion ||
      checkedUpdate.updateMode !== updateInfo.updateMode
    ) {
      throw new Error("Check for updates again before starting the update.");
    }

    const checkedTargetVersion =
      checkedUpdate.updateMode === "git"
        ? this.checkedGitTarget?.version
        : checkedUpdate.latestVersion;
    if (!checkedTargetVersion) {
      throw new Error("The checked Git update target is no longer available. Check again.");
    }
    this.assertUpdateSupported(checkedTargetVersion);
    this.isUpdating = true;
    this.updateReadyToInstall = false;
    this.pendingUpdateInfo = checkedUpdate;
    this.pendingGitTarget =
      checkedUpdate.updateMode === "git" && this.checkedGitTarget
        ? { ...this.checkedGitTarget }
        : null;

    try {
      if (checkedUpdate.updateMode === "npm") {
        await this.npmUpdate(checkedUpdate.latestVersion);
      } else if (checkedUpdate.updateMode === "git") {
        await this.gitUpdate();
      } else {
        await this.electronUpdaterUpdate();
      }
    } catch (error) {
      this.pendingUpdateInfo = null;
      this.pendingGitTarget = null;
      this.updateReadyToInstall = false;
      throw error;
    } finally {
      this.isUpdating = false;
    }
  }

  private async gitUpdate(): Promise<void> {
    const appPath = app.getAppPath();
    const target = this.pendingGitTarget;
    if (!target || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(target.commit)) {
      throw new Error("The verified Git update target is unavailable. Check for updates again.");
    }
    this.assertUpdateSupported(target.version);

    try {
      // Step 1: Stash any local changes
      this.sendProgress({
        phase: "downloading",
        percent: 10,
        message: "Stashing local changes...",
      });
      try {
        await this.runGitCommand("git stash", { cwd: appPath });
      } catch {
        // Ignore if nothing to stash
      }

      // Step 2: Merge the exact commit captured and validated during update check.
      this.sendProgress({
        phase: "downloading",
        percent: 30,
        message: "Applying verified changes from GitHub...",
      });
      await this.runGitCommand(`git merge --ff-only ${target.commit}`, { cwd: appPath });

      // Step 3: Install dependencies
      this.sendProgress({
        phase: "installing",
        percent: 50,
        message: "Installing dependencies (npm install)...",
      });
      await this.runNpmInstall(appPath);

      // Step 4: Rebuild
      this.sendProgress({
        phase: "installing",
        percent: 80,
        message: "Building application (npm run build)...",
      });
      await this.runNpmBuild(appPath);

      // Step 5: Complete
      this.sendProgress({
        phase: "complete",
        percent: 100,
        message: "Update complete! Please restart the application.",
      });

      this.updateReadyToInstall = true;
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, {
          requiresRestart: true,
          message: "Update complete! Please restart the application to apply changes.",
        });
      }
    } catch (error: Any) {
      this.sendProgress({ phase: "error", message: `Update failed: ${error.message}` });
      this.sendError(error.message);
      throw error;
    }
  }

  private async npmUpdate(targetVersion: string): Promise<void> {
    try {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
        throw new Error(`Invalid checked npm update version: ${targetVersion}`);
      }
      // Step 1: Run npm update
      this.sendProgress({ phase: "downloading", percent: 20, message: "Updating via npm..." });
      await this.runNpmGlobalUpdate(targetVersion);

      // Step 2: Complete
      this.sendProgress({
        phase: "complete",
        percent: 100,
        message: "Update complete! Please restart the application.",
      });

      this.updateReadyToInstall = true;
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, {
          requiresRestart: true,
          message: "Update complete! Please restart the application to apply changes.",
        });
      }
    } catch (error: Any) {
      this.sendProgress({ phase: "error", message: `Update failed: ${error.message}` });
      this.sendError(error.message);
      throw error;
    }
  }

  private runNpmGlobalUpdate(targetVersion: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(npm, ["install", "-g", `cowork-os@${targetVersion}`], {
        shell: true,
      });

      let stderr = "";

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm update failed with code ${code}: ${stderr}`));
        }
      });

      child.on("error", reject);
    });
  }

  private runNpmInstall(cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(npm, ["install"], { cwd, shell: true });

      let stderr = "";

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm install failed with code ${code}: ${stderr}`));
        }
      });

      child.on("error", reject);
    });
  }

  private runNpmBuild(cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(npm, ["run", "build"], { cwd, shell: true });

      let stderr = "";

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm run build failed with code ${code}: ${stderr}`));
        }
      });

      child.on("error", reject);
    });
  }

  private async electronUpdaterUpdate(): Promise<void> {
    // For packaged apps, we'll use electron-updater
    // This requires electron-updater to be installed and configured
    try {
      // Dynamic import to avoid issues when running in dev mode
      const electronUpdater = await import("electron-updater").catch(() => null);
      if (!electronUpdater) {
        throw new Error("electron-updater not available");
      }
      const { autoUpdater } = electronUpdater;
      autoUpdater.autoDownload = false;

      if (!this.updaterEventsConfigured) {
        this.updaterEventsConfigured = true;
        autoUpdater.on("checking-for-update", () => {
          this.sendProgress({ phase: "checking", message: "Checking for updates..." });
        });

        autoUpdater.on("update-available", () => {
          this.sendProgress({
            phase: "downloading",
            percent: 0,
            message: "Update available, starting download...",
          });
        });

        autoUpdater.on(
          "download-progress",
          (progress: { percent: number; transferred: number; total: number }) => {
            this.sendProgress({
              phase: "downloading",
              percent: Math.round(progress.percent),
              message: `Downloading update... ${Math.round(progress.percent)}%`,
              bytesDownloaded: progress.transferred,
              bytesTotal: progress.total,
            });
          },
        );

        autoUpdater.on("update-downloaded", (event: Any) => {
          // Verify the detached release signature before marking the update
          // installable. Neither shipped platform is code-signed, so without
          // this the only integrity control is the sha512 in latest.yml, which
          // is published to the same release as the artifact it describes.
          //
          // The promise is handed to electronUpdaterUpdate() so downloadUpdate()
          // cannot resolve — and report success to the caller — while
          // verification is still running. A rejection here must be able to
          // reach downloadUpdate()'s catch, which is what clears
          // pendingUpdateInfo.
          const verification = this.verifyDownloadedArtifact(event).then((result) => {
            if (result.status === "failed") {
              this.updateReadyToInstall = false;
              const message = `Update rejected: release signature could not be verified (${result.reason}). Download the release manually from GitHub instead.`;
              log.error(message);
              this.sendProgress({ phase: "error", message });
              this.sendError(message);
              throw new Error(message);
            }
            if (result.status === "unverified") {
              log.warn(
                "Installing an update without signature verification: no release signing key is embedded in this build. See src/electron/updater/release-signing-key.ts.",
              );
            }
            this.updateReadyToInstall = true;
            this.sendProgress({
              phase: "complete",
              percent: 100,
              message: "Update downloaded. Ready to install.",
            });
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, {
                requiresRestart: true,
                message: 'Update downloaded. Click "Install & Restart" to apply.',
              });
            }
          });
          // Keep a settled rejection from becoming an unhandled rejection if
          // downloadUpdate() throws first and nothing ever awaits this.
          this.pendingVerification = verification;
          void verification.catch(() => undefined);
        });

        autoUpdater.on("error", (error: Error) => {
          this.sendProgress({ phase: "error", message: `Update error: ${error.message}` });
          this.sendError(error.message);
        });
      }

      const updateCheck = await autoUpdater.checkForUpdates();
      if (!updateCheck) {
        throw new Error("No compatible packaged update is available for this system.");
      }
      const checkedVersion = updateCheck.updateInfo?.version;
      if (
        this.pendingUpdateInfo &&
        checkedVersion &&
        compareVersions(checkedVersion, this.pendingUpdateInfo.latestVersion) !== 0
      ) {
        throw new Error(
          `Packaged updater resolved ${checkedVersion}, but ${this.pendingUpdateInfo.latestVersion} was checked. Check for updates again.`,
        );
      }
      this.pendingVerification = null;
      await autoUpdater.downloadUpdate();
      // downloadUpdate() resolves as soon as the bytes land; the signature
      // check runs in the update-downloaded handler. Await it here so a
      // verification failure surfaces as a rejection from this method rather
      // than after the caller has already been told the download succeeded.
      if (this.pendingVerification) {
        const verification = this.pendingVerification;
        this.pendingVerification = null;
        await verification;
      }
    } catch (error: Any) {
      this.sendProgress({
        phase: "error",
        message: `Automatic update failed: ${error.message}`,
      });
      throw new Error(
        `${error.message} You can download a compatible release manually from GitHub.`,
      );
    }
  }

  async installUpdateAndRestart(): Promise<void> {
    const versionInfo = await this.getVersionInfo();
    // `updateReadyToInstall` is cleared when signature verification fails, so
    // this single guard is what keeps an unverified artifact away from
    // quitAndInstall. Do not relax it without replacing the check downstream.
    if (!this.pendingUpdateInfo || !this.updateReadyToInstall) {
      throw new Error(
        "No verified update is ready to install. Download the release manually from GitHub.",
      );
    }
    this.assertUpdateSupported(
      this.pendingUpdateInfo.updateMode === "git" && this.pendingGitTarget
        ? this.pendingGitTarget.version
        : this.pendingUpdateInfo.latestVersion,
    );

    if (versionInfo.isGitRepo) {
      // For git-based updates, just restart the app
      app.relaunch();
      app.exit(0);
    } else {
      // For electron-updater, quit and install
      try {
        const electronUpdater = await import("electron-updater").catch(() => null);
        if (electronUpdater) {
          electronUpdater.autoUpdater.quitAndInstall();
        } else {
          // Fallback: just restart
          app.relaunch();
          app.exit(0);
        }
      } catch {
        // Fallback: just restart
        app.relaunch();
        app.exit(0);
      }
    }
  }
}

export const updateManager = new UpdateManager();

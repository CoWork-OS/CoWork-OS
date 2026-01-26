import { app, BrowserWindow } from 'electron';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { UpdateInfo, UpdateProgress, AppVersionInfo, IPC_CHANNELS } from '../../shared/types';

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

export class UpdateManager {
  private mainWindow: BrowserWindow | null = null;
  private repoOwner = 'mesutfelat';
  private repoName = 'cowork-oss';
  private isUpdating = false;

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
    let gitBranch: string | undefined;
    let gitCommit: string | undefined;

    if (isDev) {
      try {
        const appPath = app.getAppPath();
        const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: appPath });
        gitBranch = branchOut.trim();

        const { stdout: commitOut } = await execAsync('git rev-parse --short HEAD', { cwd: appPath });
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
      gitBranch,
      gitCommit,
    };
  }

  async checkForUpdates(): Promise<UpdateInfo> {
    const versionInfo = await this.getVersionInfo();
    const currentVersion = versionInfo.version;

    this.sendProgress({ phase: 'checking', message: 'Checking for updates...' });

    try {
      // Fetch latest release from GitHub
      const response = await fetch(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`,
        {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'CoWork-OSS-Updater',
          },
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return {
            available: false,
            currentVersion,
            latestVersion: currentVersion,
            updateMode: versionInfo.isGitRepo ? 'git' : 'electron-updater',
          };
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const release = await response.json() as GitHubRelease;
      const latestVersion = release.tag_name.replace(/^v/, '');
      const available = this.isNewerVersion(latestVersion, currentVersion);

      // If in dev mode with git, also check if there are new commits
      let updateMode: 'git' | 'electron-updater' = versionInfo.isGitRepo ? 'git' : 'electron-updater';

      if (versionInfo.isGitRepo && !available) {
        // Check for new commits even if version tag is same
        const hasNewCommits = await this.checkForNewCommits();
        if (hasNewCommits) {
          return {
            available: true,
            currentVersion: `${currentVersion} (${versionInfo.gitCommit})`,
            latestVersion: `${latestVersion} (new commits)`,
            releaseNotes: 'New commits available on the main branch.',
            releaseUrl: `https://github.com/${this.repoOwner}/${this.repoName}`,
            updateMode: 'git',
          };
        }
      }

      return {
        available,
        currentVersion,
        latestVersion,
        releaseNotes: release.body,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        updateMode,
      };
    } catch (error: any) {
      this.sendError(error.message);
      throw error;
    }
  }

  private async checkForNewCommits(): Promise<boolean> {
    try {
      const appPath = app.getAppPath();

      // Fetch latest from remote
      await execAsync('git fetch origin', { cwd: appPath });

      // Check if there are commits ahead on remote
      const { stdout } = await execAsync('git rev-list HEAD..origin/main --count', { cwd: appPath });
      const commitsAhead = parseInt(stdout.trim(), 10);

      return commitsAhead > 0;
    } catch {
      return false;
    }
  }

  private isNewerVersion(latest: string, current: string): boolean {
    const latestParts = latest.split('.').map(n => parseInt(n, 10));
    const currentParts = current.split('.').map(n => parseInt(n, 10));

    for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
      const l = latestParts[i] || 0;
      const c = currentParts[i] || 0;
      if (l > c) return true;
      if (l < c) return false;
    }
    return false;
  }

  async downloadAndInstallUpdate(updateInfo: UpdateInfo): Promise<void> {
    if (this.isUpdating) {
      throw new Error('Update already in progress');
    }

    this.isUpdating = true;

    try {
      if (updateInfo.updateMode === 'git') {
        await this.gitUpdate();
      } else {
        await this.electronUpdaterUpdate();
      }
    } finally {
      this.isUpdating = false;
    }
  }

  private async gitUpdate(): Promise<void> {
    const appPath = app.getAppPath();

    try {
      // Step 1: Stash any local changes
      this.sendProgress({ phase: 'downloading', percent: 10, message: 'Stashing local changes...' });
      try {
        await execAsync('git stash', { cwd: appPath });
      } catch {
        // Ignore if nothing to stash
      }

      // Step 2: Fetch and pull latest
      this.sendProgress({ phase: 'downloading', percent: 30, message: 'Pulling latest changes from GitHub...' });
      await execAsync('git fetch origin', { cwd: appPath });
      await execAsync('git pull origin main', { cwd: appPath });

      // Step 3: Install dependencies
      this.sendProgress({ phase: 'installing', percent: 50, message: 'Installing dependencies (npm install)...' });
      await this.runNpmInstall(appPath);

      // Step 4: Rebuild
      this.sendProgress({ phase: 'installing', percent: 80, message: 'Building application (npm run build)...' });
      await this.runNpmBuild(appPath);

      // Step 5: Complete
      this.sendProgress({ phase: 'complete', percent: 100, message: 'Update complete! Please restart the application.' });

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, {
          requiresRestart: true,
          message: 'Update complete! Please restart the application to apply changes.',
        });
      }
    } catch (error: any) {
      this.sendProgress({ phase: 'error', message: `Update failed: ${error.message}` });
      this.sendError(error.message);
      throw error;
    }
  }

  private runNpmInstall(cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(npm, ['install'], { cwd, shell: true });

      let stderr = '';

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm install failed with code ${code}: ${stderr}`));
        }
      });

      child.on('error', reject);
    });
  }

  private runNpmBuild(cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(npm, ['run', 'build'], { cwd, shell: true });

      let stderr = '';

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`npm run build failed with code ${code}: ${stderr}`));
        }
      });

      child.on('error', reject);
    });
  }

  private async electronUpdaterUpdate(): Promise<void> {
    // For packaged apps, we'll use electron-updater
    // This requires electron-updater to be installed and configured
    try {
      // Dynamic import to avoid issues when running in dev mode
      // @ts-ignore - electron-updater may not be installed in dev
      const electronUpdater = await import('electron-updater').catch(() => null);
      if (!electronUpdater) {
        throw new Error('electron-updater not available');
      }
      const { autoUpdater } = electronUpdater;

      autoUpdater.on('checking-for-update', () => {
        this.sendProgress({ phase: 'checking', message: 'Checking for updates...' });
      });

      autoUpdater.on('update-available', () => {
        this.sendProgress({ phase: 'downloading', percent: 0, message: 'Update available, starting download...' });
      });

      autoUpdater.on('download-progress', (progress: { percent: number; transferred: number; total: number }) => {
        this.sendProgress({
          phase: 'downloading',
          percent: Math.round(progress.percent),
          message: `Downloading update... ${Math.round(progress.percent)}%`,
          bytesDownloaded: progress.transferred,
          bytesTotal: progress.total,
        });
      });

      autoUpdater.on('update-downloaded', () => {
        this.sendProgress({ phase: 'complete', percent: 100, message: 'Update downloaded. Ready to install.' });
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, {
            requiresRestart: true,
            message: 'Update downloaded. Click "Install & Restart" to apply.',
          });
        }
      });

      autoUpdater.on('error', (error: Error) => {
        this.sendProgress({ phase: 'error', message: `Update error: ${error.message}` });
        this.sendError(error.message);
      });

      await autoUpdater.downloadUpdate();
    } catch (error: any) {
      // If electron-updater is not available, fall back to manual download
      this.sendProgress({ phase: 'error', message: 'electron-updater not available. Please download manually from GitHub.' });
      throw new Error('Auto-update not available for packaged builds. Please download the latest release from GitHub.');
    }
  }

  async installUpdateAndRestart(): Promise<void> {
    const versionInfo = await this.getVersionInfo();

    if (versionInfo.isGitRepo) {
      // For git-based updates, just restart the app
      app.relaunch();
      app.exit(0);
    } else {
      // For electron-updater, quit and install
      try {
        // @ts-ignore - electron-updater may not be installed in dev
        const electronUpdater = await import('electron-updater').catch(() => null);
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

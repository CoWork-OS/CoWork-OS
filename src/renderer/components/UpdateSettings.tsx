import { useState, useEffect } from "react";
import { Download, CheckCircle, XCircle } from "lucide-react";

interface VersionInfo {
  version: string;
  isDev: boolean;
  isGitRepo: boolean;
  isNpmGlobal: boolean;
  gitBranch?: string;
  gitCommit?: string;
}

interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  updateMode: "git" | "npm" | "electron-updater";
}

interface UpdateProgress {
  phase: "checking" | "downloading" | "extracting" | "installing" | "complete" | "error";
  percent?: number;
  message: string;
}

export function UpdateSettings() {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    loadVersionInfo();

    // Subscribe to update events
    const unsubProgress = window.electronAPI.onUpdateProgress((prog) => {
      setProgress(prog);
      if (prog.phase === "error") {
        setError(prog.message);
        setUpdating(false);
      }
    });

    const unsubDownloaded = window.electronAPI.onUpdateDownloaded(() => {
      setUpdateReady(true);
      setUpdating(false);
    });

    const unsubError = window.electronAPI.onUpdateError((err) => {
      setError(err.error);
      setUpdating(false);
    });

    return () => {
      unsubProgress();
      unsubDownloaded();
      unsubError();
    };
  }, []);

  const loadVersionInfo = async () => {
    try {
      setLoading(true);
      const info = await window.electronAPI.getAppVersion();
      setVersionInfo(info);
    } catch (err: Any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCheckForUpdates = async () => {
    try {
      setChecking(true);
      setError(null);
      setUpdateInfo(null);
      const info = await window.electronAPI.checkForUpdates();
      setUpdateInfo(info);
    } catch (err: Any) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  };

  const handleDownloadUpdate = async () => {
    if (!updateInfo) return;

    try {
      setUpdating(true);
      setError(null);
      await window.electronAPI.downloadUpdate(updateInfo);
    } catch (err: Any) {
      setError(err.message);
      setUpdating(false);
    }
  };

  const handleInstallUpdate = async () => {
    try {
      await window.electronAPI.installUpdate();
    } catch (err: Any) {
      setError(err.message);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading version info...</div>;
  }

  return (
    <div className="update-settings">
      <div className="settings-section">
        <h3>Current Version</h3>
        <div className="version-info">
          <div className="version-number">v{versionInfo?.version || "Unknown"}</div>
          {versionInfo?.isDev && <span className="version-badge dev">Development Mode</span>}
          {versionInfo?.isNpmGlobal && <span className="version-badge npm">Installed via npm</span>}
          {versionInfo?.isGitRepo && (
            <div className="git-info">
              <span className="git-branch">{versionInfo.gitBranch}</span>
              {versionInfo.gitCommit && (
                <span className="git-commit">@ {versionInfo.gitCommit}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="settings-section">
        <h3>Check for Updates</h3>
        <p className="settings-description">
          {versionInfo?.isNpmGlobal
            ? "Updates will be installed via npm."
            : versionInfo?.isGitRepo
              ? "Updates will be pulled from GitHub and rebuilt automatically."
              : "Updates will be downloaded and installed automatically."}
        </p>

        <div className="update-actions">
          <button
            className="button-primary"
            onClick={handleCheckForUpdates}
            disabled={checking || updating}
          >
            {checking ? "Checking..." : "Check for Updates"}
          </button>
        </div>

        {updateInfo && (
          <div className={`update-status ${updateInfo.available ? "available" : "up-to-date"}`}>
            {updateInfo.available ? (
              <>
                <div className="update-header">
                  <Download size={20} strokeWidth={2} />
                  <span>Update Available!</span>
                </div>
                <div className="update-versions">
                  <span className="current">Current: {updateInfo.currentVersion}</span>
                  <span className="arrow">→</span>
                  <span className="latest">Latest: {updateInfo.latestVersion}</span>
                </div>
                {updateInfo.publishedAt && (
                  <div className="update-date">
                    Released: {new Date(updateInfo.publishedAt).toLocaleDateString()}
                  </div>
                )}
                {updateInfo.releaseNotes && (
                  <div className="release-notes">
                    <h4>Release Notes</h4>
                    <div className="release-notes-content">
                      {updateInfo.releaseNotes.split("\n").slice(0, 10).join("\n")}
                      {updateInfo.releaseNotes.split("\n").length > 10 && "..."}
                    </div>
                  </div>
                )}
                {updateInfo.releaseUrl && (
                  <a
                    href={updateInfo.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="release-link"
                  >
                    View on GitHub →
                  </a>
                )}
                <div className="update-mode">
                  Update method:{" "}
                  <strong>
                    {updateInfo.updateMode === "npm"
                      ? "npm update"
                      : updateInfo.updateMode === "git"
                        ? "Git Pull + Rebuild"
                        : "Auto-download"}
                  </strong>
                </div>
              </>
            ) : (
              <div className="update-header up-to-date">
                <CheckCircle size={20} strokeWidth={2} />
                <span>You're up to date!</span>
              </div>
            )}
          </div>
        )}

        {progress && (
          <div className="update-progress">
            <div className="progress-message">{progress.message}</div>
            {progress.percent !== undefined && (
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="update-error">
            <XCircle size={16} strokeWidth={2} />
            {error}
          </div>
        )}

        {updateInfo?.available && !updating && !updateReady && (
          <button
            className="button-primary update-button"
            onClick={handleDownloadUpdate}
            disabled={updating}
          >
            {versionInfo?.isNpmGlobal
              ? "Update Now (npm install)"
              : versionInfo?.isGitRepo
                ? "Update Now (Git Pull + Rebuild)"
                : "Download & Install Update"}
          </button>
        )}

        {updateReady && (
          <button className="button-primary update-button restart" onClick={handleInstallUpdate}>
            Restart to Apply Update
          </button>
        )}
      </div>

      <div className="settings-section">
        <h3>Manual Update</h3>
        <p className="settings-description">
          You can also manually update by running{" "}
          {versionInfo?.isNpmGlobal ? "this command" : "these commands"} in the terminal:
        </p>
        <div className="manual-update-commands">
          {versionInfo?.isNpmGlobal ? (
            <code>npm update -g cowork-os</code>
          ) : (
            <code>
              git fetch origin{"\n"}
              git pull origin main{"\n"}
              npm install{"\n"}
              npm run build
            </code>
          )}
        </div>
        <p className="settings-hint">After updating, restart the application to apply changes.</p>
      </div>
    </div>
  );
}

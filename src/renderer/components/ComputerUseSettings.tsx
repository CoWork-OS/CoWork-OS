import { useCallback, useEffect, useState } from "react";
import { MousePointer2, RefreshCw } from "lucide-react";

type ScreenStatus = "granted" | "denied" | "not-determined" | "unknown";

interface ComputerUseStatus {
  activeTaskId: string | null;
  platform: string;
  helperPath: string;
  sourcePath: string | null;
  installed: boolean;
  accessibilityTrusted: boolean;
  screenCaptureStatus: ScreenStatus;
  error: string | null;
}

function statusLabel(ok: boolean): string {
  return ok ? "Granted" : "Not granted";
}

function screenStatusLabel(s: ScreenStatus): string {
  switch (s) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "not-determined":
      return "Not determined — open System Settings to allow";
    default:
      return "Unknown";
  }
}

export function ComputerUseSettings() {
  const [platform, setPlatform] = useState<string>("");
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMac = platform === "darwin";
  const isWindows = platform === "win32";

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const plat = await window.electronAPI.getPlatform();
      setPlatform(plat);
      const s = await window.electronAPI.getComputerUseStatus();
      setStatus({
        ...s,
        screenCaptureStatus: s.screenCaptureStatus as ScreenStatus,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load computer use status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const off = window.electronAPI.onComputerUseEvent(() => {
      void refresh();
    });
    return off;
  }, [refresh]);

  const openAccessibility = async () => {
    try {
      await window.electronAPI.openComputerUseAccessibilitySettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open settings");
    }
  };

  const openScreen = async () => {
    try {
      await window.electronAPI.openComputerUseScreenRecordingSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open settings");
    }
  };

  const endSession = async () => {
    try {
      setEnding(true);
      await window.electronAPI.endComputerUseSession();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not end session");
    } finally {
      setEnding(false);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading computer use…</div>;
  }

  return (
    <div className="computer-use-settings">
      <div className="settings-section computer-use-settings-heading">
        <h3>
          <span className="computer-use-settings-heading-icon" aria-hidden="true">
            <MousePointer2 size={18} strokeWidth={1.5} />
          </span>
          Computer use
        </h3>
        <p className="settings-description">
          Pi-style native desktop control for macOS and Windows. The agent targets one controlled
          window at a time through `screenshot()`, then uses screenshot-relative mouse, keyboard,
          scroll, and typing actions.
        </p>
      </div>

      {error ? <div className="settings-error">{error}</div> : null}

      {!isMac && !isWindows ? (
        <div className="computer-use-platform-note">
          Computer use is available on <strong>macOS</strong> and <strong>Windows</strong> desktop
          builds only. On this platform the controls below reflect limited or unavailable permission
          APIs.
        </div>
      ) : null}

      {isWindows ? (
        <div className="computer-use-platform-note">
          Windows computer use supports visible, non-minimized native windows in v1. It may fall
          back to foreground input for apps that block background capture or control.
        </div>
      ) : null}

      <div className="computer-use-status-grid">
        <div className="computer-use-status-card">
          <div className="computer-use-status-title">Helper</div>
          <div className={`computer-use-status-value ${status?.installed ? "ok" : "bad"}`}>
            {status?.installed ? "Installed" : "Not installed yet"}
          </div>
          <div className="computer-use-session-id">
            <code>{status?.helperPath}</code>
          </div>
        </div>

        <div className="computer-use-status-card">
          <div className="computer-use-status-title">
            {isWindows ? "Input control" : "Accessibility"}
          </div>
          <div
            className={`computer-use-status-value ${status?.accessibilityTrusted ? "ok" : "bad"}`}
          >
            {statusLabel(Boolean(status?.accessibilityTrusted))}
          </div>
          {isMac ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => void openAccessibility()}
            >
              Open Accessibility settings
            </button>
          ) : null}
        </div>

        <div className="computer-use-status-card">
          <div className="computer-use-status-title">
            {isWindows ? "Window capture" : "Screen Recording"}
          </div>
          <div
            className={`computer-use-status-value ${
              status?.screenCaptureStatus === "granted" ? "ok" : "bad"
            }`}
          >
            {screenStatusLabel(status?.screenCaptureStatus ?? "unknown")}
          </div>
          {isMac ? (
            <button type="button" className="button-secondary" onClick={() => void openScreen()}>
              Open Screen Recording settings
            </button>
          ) : null}
        </div>
      </div>

      {isMac ? (
        <p className="computer-use-restart-hint">
          Inline bootstrap will prompt for missing helper permissions at first use. After changing
          Screen Recording, macOS may still require <strong>restarting CoWork</strong> before
          capture works reliably.
        </p>
      ) : null}

      {status?.sourcePath ? (
        <div className="computer-use-platform-note">
          Helper source bundle: <code>{status.sourcePath}</code>
        </div>
      ) : null}

      {status?.error ? <div className="settings-error">{status.error}</div> : null}

      <div className="computer-use-active-row">
        <div>
          <div className="computer-use-status-title">Active session</div>
          <div className="computer-use-session-id">
            {status?.activeTaskId ? (
              <>
                Task <code>{status.activeTaskId}</code>
              </>
            ) : (
              "None"
            )}
          </div>
        </div>
        <div className="computer-use-active-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={() => void refresh()}
            title="Refresh status"
          >
            <RefreshCw size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={!status?.activeTaskId || ending}
            onClick={() => void endSession()}
          >
            {ending ? "Ending…" : "End session"}
          </button>
        </div>
      </div>
    </div>
  );
}

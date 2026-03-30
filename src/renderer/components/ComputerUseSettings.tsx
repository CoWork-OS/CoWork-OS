import { useCallback, useEffect, useState } from "react";
import { MousePointer2, RefreshCw } from "lucide-react";

type ScreenStatus = "granted" | "denied" | "not-determined" | "unknown";

interface ComputerUseStatus {
  activeTaskId: string | null;
  accessibilityTrusted: boolean;
  screenCaptureStatus: ScreenStatus;
  approvedApps: Array<{ appName: string; bundleId?: string; accessLevel: string }>;
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
      return "Unknown (macOS only)";
  }
}

export function ComputerUseSettings() {
  const [platform, setPlatform] = useState<string>("");
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMac = platform === "darwin";

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
          Native desktop control (mouse, keyboard, screenshots) for macOS. The agent asks for{" "}
          <strong>per-app</strong> access each session. Use browser and shell tools first for web and
          file tasks.
        </p>
      </div>

      {error ? <div className="settings-error">{error}</div> : null}

      {!isMac ? (
        <div className="computer-use-platform-note">
          Computer use is available on <strong>macOS</strong> only. On this platform the controls
          below reflect limited or unavailable permission APIs.
        </div>
      ) : null}

      <div className="computer-use-status-grid">
        <div className="computer-use-status-card">
          <div className="computer-use-status-title">Accessibility</div>
          <div
            className={`computer-use-status-value ${status?.accessibilityTrusted ? "ok" : "bad"}`}
          >
            {statusLabel(Boolean(status?.accessibilityTrusted))}
          </div>
          <button type="button" className="button-secondary" onClick={() => void openAccessibility()}>
            Open Accessibility settings
          </button>
        </div>

        <div className="computer-use-status-card">
          <div className="computer-use-status-title">Screen Recording</div>
          <div
            className={`computer-use-status-value ${
              status?.screenCaptureStatus === "granted" ? "ok" : "bad"
            }`}
          >
            {screenStatusLabel(status?.screenCaptureStatus ?? "unknown")}
          </div>
          <button type="button" className="button-secondary" onClick={() => void openScreen()}>
            Open Screen Recording settings
          </button>
        </div>
      </div>

      {isMac ? (
        <p className="computer-use-restart-hint">
          After changing Screen Recording, macOS may require <strong>restarting CoWork</strong> before
          capture works reliably.
        </p>
      ) : null}

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

      {status && status.approvedApps.length > 0 ? (
        <div className="computer-use-approved-apps">
          <div className="computer-use-status-title">Approved apps (this session)</div>
          <ul>
            {status.approvedApps.map((a) => (
              <li key={`${a.appName}-${a.bundleId ?? ""}-${a.accessLevel}`}>
                <strong>{a.appName}</strong>
                {a.bundleId ? (
                  <>
                    {" "}
                    <code>{a.bundleId}</code>
                  </>
                ) : null}{" "}
                — {a.accessLevel.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

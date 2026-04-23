import { useCallback, useEffect, useState } from "react";
import { History, PauseCircle, PlayCircle, RefreshCw } from "lucide-react";
import type {
  ChronicleCaptureScope,
  ChronicleCaptureStatus,
  ChronicleSettings,
} from "../../shared/types";

const INTERVAL_OPTIONS = [10, 15, 30, 60];
const RETENTION_OPTIONS = [5, 10, 15, 30];
const MAX_FRAME_OPTIONS = [30, 60, 90, 120];

const DEFAULT_SETTINGS: ChronicleSettings = {
  enabled: false,
  mode: "hybrid",
  paused: false,
  captureIntervalSeconds: 10,
  retentionMinutes: 5,
  maxFrames: 60,
  captureScope: "frontmost_display",
  backgroundGenerationEnabled: true,
  respectWorkspaceMemory: true,
  consentAcceptedAt: null,
};

function formatScreenStatus(status: ChronicleCaptureStatus["screenCaptureStatus"]): string {
  switch (status) {
    case "granted":
      return "Granted";
    case "denied":
      return "Denied";
    case "not-determined":
      return "Not determined";
    default:
      return "Unknown";
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(timestamp?: number | null): string {
  if (!timestamp) return "Never";
  return new Date(timestamp).toLocaleString();
}

function captureScopeLabel(scope: ChronicleCaptureScope): string {
  return scope === "all_displays" ? "All displays" : "Frontmost display";
}

export function ChronicleSettingsCard() {
  const [settings, setSettings] = useState<ChronicleSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<ChronicleCaptureStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [loadedSettings, loadedStatus] = await Promise.all([
        window.electronAPI.getChronicleSettings(),
        window.electronAPI.getChronicleStatus(),
      ]);
      setSettings(loadedSettings);
      setStatus(loadedStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load Chronicle settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = async (patch: Partial<ChronicleSettings>) => {
    let next = { ...settings, ...patch };
    if (patch.enabled && !settings.enabled && !settings.consentAcceptedAt) {
      const accepted = window.confirm(
        "Chronicle captures recent on-screen context on this desktop. Keep it off before opening sensitive content you do not want used as context. Screen-derived text is untrusted and can contain prompt-injection attempts. Enable Chronicle?",
      );
      if (!accepted) {
        return;
      }
      next = {
        ...next,
        enabled: true,
        paused: false,
        consentAcceptedAt: Date.now(),
      };
    }
    setSettings(next);
    try {
      setSaving(true);
      setError(null);
      const result = await window.electronAPI.saveChronicleSettings(next);
      setSettings(result.settings);
      setStatus(await window.electronAPI.getChronicleStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save Chronicle settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading Chronicle…</div>;
  }

  return (
    <div className="computer-use-settings">
      <div className="settings-section computer-use-settings-heading">
        <h3>
          <span className="computer-use-settings-heading-icon" aria-hidden="true">
            <History size={18} strokeWidth={1.5} />
          </span>
          Chronicle
        </h3>
        <p className="settings-description">
          Research preview for local passive screen context. Chronicle keeps a short recent-screen
          buffer on this desktop and promotes only task-used observations into recall and memories.
        </p>
      </div>

      {error ? <div className="settings-error">{error}</div> : null}

      <div className="computer-use-status-grid">
        <div className="computer-use-status-card">
          <div className="computer-use-status-title">Preview status</div>
          <div
            className={`computer-use-status-value ${
              settings.enabled && !settings.paused ? "ok" : "bad"
            }`}
          >
            {!settings.enabled ? "Disabled" : settings.paused ? "Paused" : "Enabled"}
          </div>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={saving}
              onChange={(event) => void persist({ enabled: event.target.checked })}
            />
            <span>Turn on Chronicle (Research Preview)</span>
          </label>
          {settings.enabled ? (
            <button
              type="button"
              className="button-secondary"
              disabled={saving}
              onClick={() => void persist({ paused: !settings.paused })}
            >
              {settings.paused ? (
                <>
                  <PlayCircle size={16} strokeWidth={2} /> Resume Chronicle
                </>
              ) : (
                <>
                  <PauseCircle size={16} strokeWidth={2} /> Pause Chronicle
                </>
              )}
            </button>
          ) : null}
        </div>

        <div className="computer-use-status-card">
          <div className="computer-use-status-title">Screen Recording</div>
          <div
            className={`computer-use-status-value ${
              status?.screenCaptureStatus === "granted" ? "ok" : "bad"
            }`}
          >
            {formatScreenStatus(status?.screenCaptureStatus || "unknown")}
          </div>
          <button
            type="button"
            className="button-secondary"
            onClick={() => void window.electronAPI.openComputerUseScreenRecordingSettings()}
          >
            Open Screen Recording settings
          </button>
        </div>

        <div className="computer-use-status-card">
          <div className="computer-use-status-title">Accessibility</div>
          <div
            className={`computer-use-status-value ${
              status?.accessibilityTrusted ? "ok" : "bad"
            }`}
          >
            {status?.accessibilityTrusted ? "Trusted" : "Not granted"}
          </div>
          <button
            type="button"
            className="button-secondary"
            onClick={() => void window.electronAPI.openComputerUseAccessibilitySettings()}
          >
            Open Accessibility settings
          </button>
        </div>

        <div className="computer-use-status-card">
          <div className="computer-use-status-title">OCR</div>
          <div className={`computer-use-status-value ${status?.ocrAvailable ? "ok" : "bad"}`}>
            {status?.ocrAvailable ? "Available" : "Unavailable"}
          </div>
          <div className="computer-use-session-id">
            {status?.ocrAvailable
              ? "Local OCR will enrich Chronicle matches."
              : "Install tesseract for OCR-backed Chronicle matches."}
          </div>
        </div>
      </div>

      {status?.reason ? <p className="computer-use-restart-hint">{status.reason}</p> : null}

      <div className="settings-section">
        <div className="computer-use-active-row">
          <div>
            <div className="computer-use-status-title">Recent-screen buffer</div>
            <div className="computer-use-session-id">
              {status?.frameCount ?? 0} frame(s) • {formatBytes(status?.bufferBytes || 0)} •{" "}
              {captureScopeLabel(status?.captureScope || settings.captureScope)}
            </div>
            <div className="computer-use-session-id">
              Last capture: {formatTimestamp(status?.lastCaptureAt)} • Last memory generation:{" "}
              {formatTimestamp(status?.lastGeneratedAt)}
            </div>
          </div>
          <div className="computer-use-active-actions">
            <button type="button" className="button-secondary" onClick={() => void refresh()}>
              <RefreshCw size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="settings-grid">
          <label className="settings-field">
            <span>Capture interval</span>
            <select
              value={settings.captureIntervalSeconds}
              disabled={saving}
              onChange={(event) =>
                void persist({ captureIntervalSeconds: Number(event.target.value) })
              }
            >
              {INTERVAL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} seconds
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>Retention window</span>
            <select
              value={settings.retentionMinutes}
              disabled={saving}
              onChange={(event) => void persist({ retentionMinutes: Number(event.target.value) })}
            >
              {RETENTION_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} minutes
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>Frame cap</span>
            <select
              value={settings.maxFrames}
              disabled={saving}
              onChange={(event) => void persist({ maxFrames: Number(event.target.value) })}
            >
              {MAX_FRAME_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} frames
                </option>
              ))}
            </select>
          </label>

          <label className="settings-field">
            <span>Capture scope</span>
            <select
              value={settings.captureScope}
              disabled={saving}
              onChange={(event) =>
                void persist({ captureScope: event.target.value as ChronicleCaptureScope })
              }
            >
              <option value="frontmost_display">Frontmost display</option>
              <option value="all_displays">All displays</option>
            </select>
          </label>
        </div>

        <div className="settings-grid" style={{ marginTop: "12px" }}>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={settings.backgroundGenerationEnabled}
              disabled={saving}
              onChange={(event) =>
                void persist({ backgroundGenerationEnabled: event.target.checked })
              }
            />
            <span>Generate Chronicle-backed memories in the background</span>
          </label>

          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={settings.respectWorkspaceMemory}
              disabled={saving}
              onChange={(event) => void persist({ respectWorkspaceMemory: event.target.checked })}
            />
            <span>Respect workspace memory privacy and auto-capture settings</span>
          </label>
        </div>

        <p className="settings-description">
          Passive frames stay local and are aggressively pruned. Chronicle does not send screenshots
          to external providers by itself. Screen-derived text is untrusted and may contain prompt
          injection attempts, so verify it before acting on it.
        </p>
      </div>
    </div>
  );
}

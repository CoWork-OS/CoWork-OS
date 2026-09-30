import { useState, useEffect } from "react";
import {
  QueueSettings as QueueSettingsType,
  DEFAULT_QUEUE_SETTINGS,
  MAX_QUEUE_TASK_TIMEOUT_MINUTES,
} from "../../shared/types";

export function QueueSettings() {
  const [settings, setSettings] = useState<QueueSettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const loaded = await window.electronAPI.getQueueSettings();
      setSettings(loaded);
    } catch (error) {
      console.error("Failed to load queue settings:", error);
      setSettings(null);
      setLoadError(error instanceof Error ? error.message : "Queue settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    try {
      setSaving(true);
      setSaveError(null);
      setSaved(false);
      const result = await window.electronAPI.saveQueueSettings(settings);
      if (!result?.success) throw new Error("The host did not confirm the queue settings save.");
      const confirmed = await window.electronAPI.getQueueSettings();
      if (
        confirmed.maxConcurrentTasks !== settings.maxConcurrentTasks ||
        confirmed.taskTimeoutMinutes !== settings.taskTimeoutMinutes
      ) {
        throw new Error("The saved queue settings did not match the values you entered.");
      }
      setSettings(confirmed);
      setSaved(true);
    } catch (error) {
      console.error("Failed to save queue settings:", error);
      setSaveError(error instanceof Error ? error.message : "Queue settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setSettings({ ...DEFAULT_QUEUE_SETTINGS });
    setSaveError(null);
    setSaved(false);
  };

  if (loading) {
    return <div className="settings-loading">Loading queue settings...</div>;
  }

  if (!settings) {
    return (
      <QueueSettingsLoadFailure
        message={loadError || "Queue settings could not be loaded."}
        onRetry={() => void loadSettings()}
      />
    );
  }

  const timeoutHours = Math.max(1, Math.round(settings.taskTimeoutMinutes / 60));

  return (
    <>
      {/* Parallel Execution Section */}
      <div className="settings-section">
        <h3>Parallel Task Execution</h3>
        <p className="settings-description">
          Control how many tasks can run simultaneously. Higher values allow more parallel work but
          use more system resources.
        </p>

        <div className="settings-slider-group">
          <label>Maximum concurrent tasks:</label>
          <div className="slider-with-value">
            <input
              type="range"
              className="settings-slider"
              min={1}
              max={20}
              value={settings.maxConcurrentTasks}
              disabled={saving}
              onChange={(e) => {
                setSaved(false);
                setSaveError(null);
                setSettings({ ...settings, maxConcurrentTasks: parseInt(e.target.value) });
              }}
            />
            <span className="slider-value">{settings.maxConcurrentTasks}</span>
          </div>
        </div>

        <p className="settings-hint">
          Default: 8. Tasks beyond this limit will be queued and start automatically when a slot
          becomes available.
        </p>
      </div>

      <div className="settings-section">
        <h3>Task Session Watchdog</h3>
        <p className="settings-description">
          This timeout is a last-resort watchdog for genuinely stuck task sessions. It is not a
          per-step or per-message limit.
        </p>

        <div className="settings-slider-group">
          <label>Watchdog timeout:</label>
          <div className="slider-with-value">
            <input
              type="range"
              className="settings-slider"
              min={1}
              max={24}
              value={timeoutHours}
              disabled={saving}
              onChange={(e) => {
                setSaved(false);
                setSaveError(null);
                setSettings({
                  ...settings,
                  taskTimeoutMinutes: Math.min(
                    MAX_QUEUE_TASK_TIMEOUT_MINUTES,
                    parseInt(e.target.value) * 60,
                  ),
                });
              }}
            />
            <span className="slider-value">
              {timeoutHours} {timeoutHours === 1 ? "hour" : "hours"}
            </span>
          </div>
        </div>

        <p className="settings-hint">
          Default: 24 hours. Long-running interactive tasks can continue across multiple follow-ups
          without being cut off by the old 60-minute timeout.
        </p>
      </div>

      {/* Queue Behavior Info Section */}
      <div className="settings-section">
        <h3>Queue Behavior</h3>
        <p className="settings-description">
          When you create more tasks than the concurrency limit allows, extra tasks are placed in a
          queue.
        </p>

        <ul className="settings-info-list">
          <li>
            <strong>FIFO Order:</strong> Tasks are processed in the order they were created
            (first-in, first-out).
          </li>
          <li>
            <strong>Auto-Start:</strong> Queued tasks automatically start when a running task
            completes.
          </li>
          <li>
            <strong>Persistence:</strong> Queued tasks are saved and will resume after app restart.
          </li>
          <li>
            <strong>Cancel Anytime:</strong> You can cancel queued tasks from the queue panel before
            they start.
          </li>
          <li>
            <strong>Stuck-Task Recovery:</strong> The session watchdog only exists to clean up runs
            that hang for an unusually long time.
          </li>
        </ul>
      </div>

      {/* Actions */}
      <div className="settings-actions">
        <button className="button-secondary" onClick={handleReset} disabled={saving}>
          Reset to Default
        </button>
        <button className="button-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
      {(saveError || saved) && <QueueSettingsSaveFeedback error={saveError} saved={saved} />}
    </>
  );
}

export function QueueSettingsLoadFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="settings-section" role="alert">
      <p className="settings-error">Could not load queue settings: {message}</p>
      <button className="button-secondary" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function QueueSettingsSaveFeedback({
  error,
  saved,
}: {
  error: string | null;
  saved: boolean;
}) {
  if (error)
    return (
      <p role="alert" className="settings-error">
        {error}
      </p>
    );
  if (saved)
    return (
      <p role="status" className="settings-description">
        Queue settings saved.
      </p>
    );
  return null;
}

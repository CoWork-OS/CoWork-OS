import { useState, useEffect } from "react";
import { QueueSettings as QueueSettingsType, DEFAULT_QUEUE_SETTINGS } from "../../shared/types";

export function QueueSettings() {
  const [settings, setSettings] = useState<QueueSettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const loaded = await window.electronAPI.getQueueSettings();
      setSettings(loaded);
    } catch (error) {
      console.error("Failed to load queue settings:", error);
      // Fall back to defaults if loading fails
      setSettings(DEFAULT_QUEUE_SETTINGS);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    try {
      setSaving(true);
      await window.electronAPI.saveQueueSettings(settings);
    } catch (error) {
      console.error("Failed to save queue settings:", error);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setSettings(DEFAULT_QUEUE_SETTINGS);
  };

  if (loading || !settings) {
    return <div className="settings-loading">Loading queue settings...</div>;
  }

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
              onChange={(e) =>
                setSettings({ ...settings, maxConcurrentTasks: parseInt(e.target.value) })
              }
            />
            <span className="slider-value">{settings.maxConcurrentTasks}</span>
          </div>
        </div>

        <p className="settings-hint">
          Default: 8. Tasks beyond this limit will be queued and start automatically when a slot
          becomes available.
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
    </>
  );
}

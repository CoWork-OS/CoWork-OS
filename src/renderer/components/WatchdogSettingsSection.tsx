import { useEffect, useState } from "react";
import type { WatchdogSettings } from "../../shared/types";

/**
 * Settings > Automations > Queue: the watchdog control loop. Each toggle saves at once; the
 * section stays hidden on hosts that do not offer the watchdog settings.
 */
export function WatchdogSettingsSection() {
  const api = window.electronAPI;
  const supported =
    typeof api?.getWatchdogSettings === "function" &&
    typeof api?.saveWatchdogSettings === "function";
  const [settings, setSettings] = useState<WatchdogSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    api
      .getWatchdogSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Watchdog settings could not be loaded.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, supported]);

  if (!supported) return null;

  const save = async (patch: Partial<WatchdogSettings>) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveWatchdogSettings(patch);
      if (!result?.success) throw new Error("The host did not confirm the watchdog settings save.");
      setSettings(result.settings);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Watchdog settings could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-section">
      <h3>Progress Watchdog</h3>
      <p className="settings-description">
        A separate check that runs every {settings?.intervalMinutes ?? 5} minutes. It recovers tasks
        stalled by infrastructure problems (lost executors, stuck retries, provider outages) and
        asks your cheapest model whether long-running tasks still make progress. A task that drifts
        gets a steering note first; if it keeps drifting, it is paused and you are notified. Every
        decision is written to the task&apos;s activity log.
      </p>

      {settings && (
        <>
          <div className="settings-field">
            <div className="settings-checkbox-label">
              <span>Watch running tasks</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  aria-label="Watch running tasks"
                  checked={settings.enabled}
                  disabled={saving}
                  onChange={(event) => void save({ enabled: event.target.checked })}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <p className="settings-hint">
              Off by default. Checks start {settings.progressCheckAfterMinutes} minutes into a task;
              a task silent for {settings.stallMinutes} minutes counts as stalled.
            </p>
          </div>

          <div className="settings-field">
            <div className="settings-checkbox-label">
              <span>Allow cancelling a task that keeps drifting</span>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  aria-label="Allow cancelling a task that keeps drifting"
                  checked={settings.allowCancel}
                  disabled={saving || !settings.enabled}
                  onChange={(event) => void save({ allowCancel: event.target.checked })}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <p className="settings-hint">
              Without this, the watchdog only nudges and pauses. With it, a task that drifts again
              after being paused once is cancelled.
            </p>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
    </div>
  );
}

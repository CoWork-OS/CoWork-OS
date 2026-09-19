import { useCallback, useEffect, useState } from "react";
import type { PulseMutationResult, PulsePublicSettings } from "../../shared/pulse";

function formatDate(value: number | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function PulseSettingsPanel() {
  const [settings, setSettings] = useState<PulsePublicSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setSettings(await window.electronAPI.getPulseSettings());
  }, []);

  useEffect(() => {
    void reload().catch((value) =>
      setError(value instanceof Error ? value.message : String(value)),
    );
  }, [reload]);

  const mutate = async (operation: () => Promise<PulseMutationResult>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      setSettings(result.settings);
      if (!result.success) setError(result.error || "Pulse operation failed");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <div className="settings-loading">Loading CoWork Pulse…</div>;

  return (
    <div className="pulse-settings">
      <div className="settings-section">
        <h3>CoWork Pulse</h3>
        <p className="settings-description">
          Help us understand whether installations reach value and return to useful work. Pulse is
          off by default and sends at most one content-free aggregate for a fully consented UTC day.
        </p>
        <p className="settings-description">
          It never sends prompts, responses, file names or contents, commands, URLs, workspace or
          task IDs, custom tool names, model/provider routes, account data, hostnames, or raw
          errors.
        </p>
        <p className="settings-description">
          Separate update discovery may send only your version, operating-system family, CPU family,
          and app surface; it has no Pulse ID and is cached for 24 hours.
        </p>
        <div className="update-actions">
          <button
            className={settings.enabled ? "button-secondary" : "button-primary"}
            disabled={busy}
            onClick={() => void mutate(() => window.electronAPI.setPulseEnabled(!settings.enabled))}
          >
            {settings.enabled ? "Turn off Pulse" : "Opt in to Pulse"}
          </button>
          {settings.enabled && (
            <button
              className="button-secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setSettings(await window.electronAPI.flushPulse());
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send now
            </button>
          )}
        </div>
        {error && <div className="settings-error">{error}</div>}
      </div>

      <div className="settings-section">
        <h3>What would be sent</h3>
        <p className="settings-description">
          This is the exact pending or next daily payload. The deletion credential is encrypted
          locally and is never displayed here.
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>
          {settings.pendingPackage
            ? JSON.stringify(settings.pendingPackage, null, 2)
            : "Nothing. Pulse is disabled."}
        </pre>
      </div>

      <div className="settings-section">
        <h3>Status and control</h3>
        <p className="settings-description">
          Consent: {settings.consentState} · Last sent: {formatDate(settings.lastSentAt)} · Last
          error: {settings.lastErrorCode || "None"}
        </p>
        <p className="settings-description">
          Installation ID: {settings.installationId || "Created only after opt-in"}
        </p>
        <p className="settings-description">Collector: {settings.endpoint}</p>
        <div className="update-actions">
          <button
            className="button-secondary"
            disabled={busy || !settings.installationId}
            onClick={() => {
              if (
                window.confirm(
                  "Rotate this installation ID? Existing server data will not be deleted.",
                )
              ) {
                void mutate(() => window.electronAPI.resetPulseIdentity());
              }
            }}
          >
            Rotate installation ID
          </button>
          <button
            className="button-secondary"
            disabled={busy || !settings.installationId}
            onClick={() => {
              if (
                window.confirm("Permanently delete this installation's Pulse data from the server?")
              ) {
                void mutate(() => window.electronAPI.deletePulseRemoteData());
              }
            }}
          >
            Delete remote Pulse data
          </button>
        </div>
      </div>
    </div>
  );
}

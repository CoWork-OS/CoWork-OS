import { useCallback, useEffect, useState } from "react";
import type {
  MeetingArtifactSummary,
  TeamsMeetingSettingsView,
  TeamsMeetingStatus,
} from "../../shared/types";

const STATE_LABELS: Record<TeamsMeetingStatus["state"], string> = {
  disconnected: "Not connected",
  idle: "Connected",
  syncing: "Syncing",
  error: "Last sync failed",
  auth_expired: "Sign-in expired",
  blocked: "Blocked by tenant policy",
};

function formatTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : "never";
}

export function TeamsMeetingSettings() {
  const [settings, setSettings] = useState<TeamsMeetingSettingsView | null>(null);
  const [status, setStatus] = useState<TeamsMeetingStatus | null>(null);
  const [artifacts, setArtifacts] = useState<MeetingArtifactSummary[]>([]);
  const [clientId, setClientId] = useState("");
  const [tenant, setTenant] = useState("");
  const [pollInterval, setPollInterval] = useState("15");
  const [lookback, setLookback] = useState("48");
  const [notificationUrl, setNotificationUrl] = useState("");
  const [notificationPort, setNotificationPort] = useState("3984");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const [nextSettings, nextStatus, nextArtifacts] = await Promise.all([
      window.electronAPI.getTeamsMeetingSettings(),
      window.electronAPI.getTeamsMeetingStatus(),
      window.electronAPI.listMeetingArtifacts({ provider: "teams", limit: 25 }),
    ]);
    setSettings(nextSettings);
    setStatus(nextStatus);
    setArtifacts(nextArtifacts);
    setClientId((current) => current || nextSettings.clientId || "");
    setTenant((current) => current || nextSettings.tenant || "");
    setPollInterval(String(nextSettings.pollIntervalMinutes));
    setLookback(String(nextSettings.lookbackHours));
    setNotificationUrl(nextSettings.notificationPublicUrl || "");
    setNotificationPort(String(nextSettings.notificationPort));
  }, []);

  useEffect(() => {
    void load().catch((error) => setMessage({ ok: false, text: String(error?.message || error) }));
    return window.electronAPI.onMeetingArtifactsChanged(() => void load().catch(() => undefined));
  }, [load]);

  const run = async (label: string, action: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    setMessage(null);
    try {
      await action();
      await load();
      if (success) setMessage({ ok: true, text: success });
    } catch (error: Any) {
      setMessage({ ok: false, text: error?.message || String(error) });
    } finally {
      setBusy(null);
    }
  };

  if (!settings || !status) {
    return <div className="settings-loading">Loading Teams meeting settings...</div>;
  }

  const connected = settings.connected;

  return (
    <div className="googlechat-settings">
      <div className="settings-section">
        <h3>Teams meeting transcripts</h3>
        <p className="settings-description">
          Saves transcripts of Teams meetings you organize as local Markdown notes that the agent
          can read. Recordings are listed but only downloaded when you ask. Requires an Azure app
          registration with delegated <code>Calendars.Read</code>, <code>OnlineMeetings.Read</code>,{" "}
          <code>OnlineMeetingTranscript.Read.All</code> and{" "}
          <code>OnlineMeetingRecording.Read.All</code> (admin consent), a redirect URI of{" "}
          <code>http://localhost:18767</code>, and tenant transcript API access enabled.
        </p>

        <div className="settings-status-row">
          <span
            className={`settings-badge status-${status.state === "idle" ? "connected" : status.state === "syncing" ? "connecting" : status.state === "disconnected" ? "disconnected" : "error"}`}
          >
            {STATE_LABELS[status.state]}
          </span>
          {status.account && <span className="settings-muted">{status.account}</span>}
        </div>
        {status.lastError && status.state !== "idle" && (
          <div className="settings-status error">{status.lastError}</div>
        )}

        {!connected ? (
          <>
            <div className="settings-field">
              <label>Application (client) ID</label>
              <input
                className="settings-input"
                value={clientId}
                placeholder="00000000-0000-0000-0000-000000000000"
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="settings-field">
              <label>Tenant (Optional)</label>
              <input
                className="settings-input"
                value={tenant}
                placeholder="organizations or your tenant ID"
                onChange={(e) => setTenant(e.target.value)}
              />
            </div>
            <button
              className="settings-button settings-button-primary"
              disabled={!clientId.trim() || busy !== null}
              onClick={() =>
                run(
                  "connect",
                  () =>
                    window.electronAPI.connectTeamsMeetings({
                      clientId: clientId.trim(),
                      tenant: tenant.trim() || undefined,
                    }),
                  "Connected. Recent meetings are being checked for transcripts.",
                )
              }
            >
              {busy === "connect"
                ? "Waiting for Microsoft sign-in..."
                : "Connect Microsoft account"}
            </button>
          </>
        ) : (
          <>
            <div className="settings-hint">
              Last sync: {formatTime(status.lastSyncAt)} · Next: {formatTime(status.nextSyncAt)} ·{" "}
              {status.artifactCount} transcript(s) saved
              {status.pendingJobs > 0 ? ` · ${status.pendingJobs} waiting` : ""}
            </div>
            {status.failedJobs.length > 0 && (
              <div className="settings-status error">
                {status.failedJobs.length} transcript(s) could not be fetched:{" "}
                {status.failedJobs[0].lastError}
              </div>
            )}
            <div className="settings-actions">
              <button
                className="settings-button"
                disabled={busy !== null}
                onClick={() => run("sync", () => window.electronAPI.syncTeamsMeetingsNow())}
              >
                {busy === "sync" ? "Syncing..." : "Sync now"}
              </button>
              {status.failedJobs.length > 0 && (
                <button
                  className="settings-button"
                  disabled={busy !== null}
                  onClick={() => run("retry", () => window.electronAPI.retryFailedTeamsMeetings())}
                >
                  Retry failed
                </button>
              )}
              {(status.state === "auth_expired" || status.state === "blocked") && (
                <button
                  className="settings-button"
                  disabled={busy !== null}
                  onClick={() =>
                    run("connect", () =>
                      window.electronAPI.connectTeamsMeetings({
                        clientId: settings.clientId || clientId,
                        tenant: settings.tenant,
                      }),
                    )
                  }
                >
                  Reconnect
                </button>
              )}
              <button
                className="settings-button settings-button-danger"
                disabled={busy !== null}
                onClick={() => {
                  if (!confirm("Disconnect Teams meeting capture? Saved transcripts stay on disk."))
                    return;
                  void run("disconnect", () => window.electronAPI.disconnectTeamsMeetings());
                }}
              >
                Disconnect
              </button>
            </div>
          </>
        )}
        {message && (
          <div className={`settings-status ${message.ok ? "success" : "error"}`}>
            {message.text}
          </div>
        )}
      </div>

      {connected && (
        <div className="settings-section">
          <h3>Sync options</h3>
          <div className="settings-field">
            <label>Check for new transcripts every (minutes)</label>
            <input
              type="number"
              className="settings-input"
              value={pollInterval}
              onChange={(e) => setPollInterval(e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label>Look back over (hours)</label>
            <input
              type="number"
              className="settings-input"
              value={lookback}
              onChange={(e) => setLookback(e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label>Public notification URL (Optional)</label>
            <input
              className="settings-input"
              value={notificationUrl}
              placeholder="https://your-tunnel.example.com"
              onChange={(e) => setNotificationUrl(e.target.value)}
            />
            <p className="settings-hint">
              Optional. When set, CoWork subscribes to Graph change notifications on port{" "}
              {notificationPort} so new transcripts arrive sooner. The subscription is renewed
              automatically; polling keeps running either way.
            </p>
            {status.subscription && (
              <p className="settings-hint">
                Subscription active until {formatTime(status.subscription.expiresAt)}; last
                notification {formatTime(status.subscription.lastNotificationAt)}.
              </p>
            )}
            {status.subscriptionError && (
              <div className="settings-status error">{status.subscriptionError}</div>
            )}
          </div>
          <div className="settings-field">
            <label>Notification port</label>
            <input
              type="number"
              className="settings-input"
              value={notificationPort}
              onChange={(e) => setNotificationPort(e.target.value)}
            />
          </div>
          <button
            className="settings-button"
            disabled={busy !== null}
            onClick={() =>
              run(
                "save",
                () =>
                  window.electronAPI.updateTeamsMeetingSettings({
                    pollIntervalMinutes: Number.parseInt(pollInterval, 10) || 15,
                    lookbackHours: Number.parseInt(lookback, 10) || 48,
                    notificationPublicUrl: notificationUrl.trim(),
                    notificationPort: Number.parseInt(notificationPort, 10) || 3984,
                  }),
                "Saved.",
              )
            }
          >
            Save options
          </button>
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="settings-section">
          <h3>Saved transcripts</h3>
          <div className="settings-list">
            {artifacts.map((artifact) => (
              <div key={artifact.id} className="settings-list-item">
                <div>
                  <strong>{artifact.title}</strong>
                  <div className="settings-hint">
                    {formatTime(artifact.startTime)} · {artifact.cueCount} turn(s)
                    {artifact.organizer ? ` · ${artifact.organizer}` : ""}
                  </div>
                </div>
                <div className="settings-actions">
                  <button
                    className="settings-button"
                    onClick={() => void window.electronAPI.revealMeetingArtifact(artifact.id)}
                  >
                    Show file
                  </button>
                  {artifact.recordings.map((recording, index) => (
                    <button
                      key={recording.id}
                      className="settings-button"
                      disabled={busy !== null}
                      onClick={() =>
                        run(
                          `recording-${recording.id}`,
                          () =>
                            window.electronAPI.downloadMeetingRecording(artifact.id, recording.id),
                          "Recording downloaded.",
                        )
                      }
                    >
                      {recording.localPath
                        ? `Recording ${index + 1} saved`
                        : busy === `recording-${recording.id}`
                          ? "Downloading..."
                          : `Download recording ${index + 1}`}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

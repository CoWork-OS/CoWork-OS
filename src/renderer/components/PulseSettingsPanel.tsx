import { useCallback, useEffect, useState } from "react";
import type {
  PulseMutationResult,
  PulsePreviewState,
  PulsePublicSettings,
  PulseSendOutcome,
} from "../../shared/pulse";

function formatDate(value: number | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

const SEND_OUTCOME_MESSAGES: Record<PulseSendOutcome, string | null> = {
  sent: "Sent. The collector acknowledged this day's record.",
  busy: "Another CoWork process for this profile is sending right now. Try again shortly.",
  already_sent: "This day was already acknowledged; it was not sent again.",
  no_eligible_day: "Nothing to send yet: no fully consented UTC day is waiting.",
  cancelled_by_state_change: "Not sent: Pulse settings changed while sending.",
  error: null,
};

function previewHeading(preview: PulsePreviewState): string {
  switch (preview.state) {
    case "queued":
      return `Queued for ${formatDay(preview.package.period.start)}: this exact payload is attempted next, provided Pulse stays on.`;
    case "candidate":
      return `Estimate for ${formatDay(preview.package.period.start)}. Nothing has been queued yet; the final record is built when it is sent.`;
    case "already_sent":
      return `The record for ${formatDay(preview.periodStart)} was acknowledged at ${formatDate(preview.acknowledgedAt)}. Send now will not resend it.`;
    case "ineligible":
      if (preview.reason === "deletion_pending") {
        return "Nothing can be sent: reporting is off and remote deletion is pending.";
      }
      if (preview.reason === "disabled") return "Nothing. Pulse is off.";
      return preview.eligibleFrom
        ? `Nothing yet. Only fully consented UTC days are sent; the first one is ${formatDay(preview.eligibleFrom)}.`
        : "Nothing yet. Only fully consented UTC days are sent.";
  }
}

function describeError(code: string | undefined): string {
  if (code === "deletion_pending") {
    return "Remote deletion is still pending. Retry deletion before opting in or rotating the ID.";
  }
  return code || "Pulse operation failed";
}

export function PulseSettingsPanel() {
  const [settings, setSettings] = useState<PulsePublicSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    setNotice(null);
    try {
      const result = await operation();
      setSettings(result.settings);
      if (!result.success) setError(describeError(result.error));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const sendNow = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.electronAPI.flushPulse();
      setSettings(result.settings);
      if (result.outcome === "error")
        setError(`Send failed (${result.error || "unknown error"}); it will be retried.`);
      else setNotice(SEND_OUTCOME_MESSAGES[result.outcome]);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <div className="settings-loading">Loading CoWork Pulse…</div>;

  const deletionPending = settings.deletion.state === "pending";
  const preview = settings.preview;
  const previewPackage =
    preview.state === "queued" || preview.state === "candidate" ? preview.package : null;
  const canSend = settings.enabled && (preview.state === "queued" || preview.state === "candidate");

  return (
    <div className="pulse-settings">
      <div className="settings-section">
        <h3>CoWork Pulse</h3>
        <p className="settings-description">
          Help us understand whether installations reach value and return to useful work. Pulse is
          off by default and keeps one content-free daily aggregate record per fully consented UTC
          day; failed or unconfirmed requests may be retried with the same record.
        </p>
        <p className="settings-description">
          It never sends prompts, responses, file names or contents, commands, URLs, workspace or
          task IDs, custom tool names, model/provider routes, account data, hostnames, or raw
          errors.
        </p>
        <p className="settings-description">
          Separately, automatic update checks may ask CoWork's update endpoint first, sending only
          your version, operating-system family, CPU family, and app surface, with no Pulse ID.
          Checking manually goes directly to GitHub.
        </p>
        <div className="update-actions">
          {deletionPending ? (
            <button
              className="button-primary"
              disabled={busy}
              onClick={() => void mutate(() => window.electronAPI.deletePulseRemoteData())}
            >
              Retry remote deletion
            </button>
          ) : (
            <button
              className={settings.enabled ? "button-secondary" : "button-primary"}
              disabled={busy}
              onClick={() =>
                void mutate(() => window.electronAPI.setPulseEnabled(!settings.enabled))
              }
            >
              {settings.enabled ? "Turn off Pulse" : "Opt in to Pulse"}
            </button>
          )}
          {settings.enabled && (
            <button
              className="button-secondary"
              disabled={busy || !canSend}
              title={canSend ? undefined : "No eligible day is waiting to be sent"}
              onClick={() => void sendNow()}
            >
              Send now
            </button>
          )}
        </div>
        {deletionPending && (
          <div className="settings-error">
            Reporting off; deletion pending. The collector has not confirmed deletion
            {settings.deletion.lastErrorCode ? ` (${settings.deletion.lastErrorCode})` : ""}. Retry
            when you are online; opting in again is blocked until deletion is confirmed.
          </div>
        )}
        {error && <div className="settings-error">{error}</div>}
        {notice && <p className="settings-description">{notice}</p>}
      </div>

      <div className="settings-section">
        <h3>What would be sent</h3>
        <p className="settings-description">
          {previewHeading(preview)} The deletion credential is encrypted locally and is never
          displayed here.
        </p>
        {previewPackage && (
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>
            {JSON.stringify(previewPackage, null, 2)}
          </pre>
        )}
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
            disabled={busy || !settings.installationId || deletionPending}
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
            disabled={busy || !settings.installationId || deletionPending}
            onClick={() => {
              if (
                window.confirm(
                  "Turn off Pulse and ask the server to delete this installation's Pulse data? Reporting stops immediately; deletion is confirmed only when the server acknowledges it.",
                )
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

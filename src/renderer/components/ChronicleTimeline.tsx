import { useCallback, useEffect, useState } from "react";
import { EyeOff, RefreshCw, Trash2 } from "lucide-react";
import type {
  ChronicleExcludedApp,
  ChronicleSettings,
  ChronicleTimelineFrame,
} from "../../shared/types";
import { ConfirmDialog } from "./ConfirmDialog";

function formatFrameTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isExcluded(apps: readonly ChronicleExcludedApp[], bundleId: string | undefined): boolean {
  if (!bundleId) return false;
  const key = bundleId.toLowerCase();
  return apps.some((app) => app.bundleId.toLowerCase() === key);
}

/** Apps Chronicle never captures; removing one lets Chronicle capture it again. */
export function ChronicleExcludedApps({
  apps,
  disabled,
  onRemove,
}: {
  apps: readonly ChronicleExcludedApp[];
  disabled: boolean;
  onRemove: (bundleId: string) => void;
}) {
  return (
    <div className="settings-section chronicle-excluded" aria-label="Apps Chronicle never captures">
      <div className="computer-use-status-title">Never capture these apps</div>
      <p className="settings-description">
        While one of these apps is in front, Chronicle skips the capture. Other windows visible at
        the same time can still appear in captures taken while a different app is in front. Add an
        app from the timeline below.
      </p>
      {apps.length === 0 ? (
        <div className="chronicle-excluded-empty">No apps excluded.</div>
      ) : (
        <ul className="chronicle-excluded-list">
          {apps.map((app) => (
            <li key={app.bundleId} className="chronicle-excluded-app">
              <span className="chronicle-excluded-app-text">
                <span className="chronicle-excluded-app-name">{app.name}</span>
                <span className="chronicle-excluded-app-id">{app.bundleId}</span>
              </span>
              <button
                type="button"
                className="button-secondary chronicle-small-button"
                onClick={() => onRemove(app.bundleId)}
                disabled={disabled}
                aria-label={`Let Chronicle capture ${app.name} again`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The recent-screen buffer as a timeline, newest first: what Chronicle has seen in the last
 * few minutes, with Delete for one frame and "Don't capture" for the app it shows.
 */
export function ChronicleTimeline({
  settings,
  onSettingsChange,
}: {
  settings: ChronicleSettings;
  onSettingsChange: (next: ChronicleSettings) => void;
}) {
  const [frames, setFrames] = useState<ChronicleTimelineFrame[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setFrames(await window.electronAPI.listChronicleTimeline({ limit: 60 }));
    } catch {
      setFrames([]);
      setError("Couldn't load the timeline.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, settings.enabled, settings.paused]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch {
      setError("That didn't work. Try again.");
    } finally {
      setBusy(null);
      void load();
    }
  };

  const exclude = (frame: ChronicleTimelineFrame) =>
    run(`exclude:${frame.bundleId}`, async () => {
      if (!frame.bundleId) return;
      const result = await window.electronAPI.excludeChronicleApp({
        bundleId: frame.bundleId,
        name: frame.appName,
      });
      onSettingsChange(result.settings);
    });

  return (
    <div className="settings-section chronicle-timeline" aria-label="Chronicle timeline">
      <div className="computer-use-active-row">
        <div>
          <div className="computer-use-status-title">Recent timeline</div>
          <div className="computer-use-session-id">
            What Chronicle captured in the last {settings.retentionMinutes} minutes, newest first.
            Frames are deleted as they age out.
          </div>
        </div>
        <div className="computer-use-active-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={() => void load()}
            aria-label="Refresh the Chronicle timeline"
            title="Refresh"
          >
            <RefreshCw size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="button-secondary"
            onClick={() => setConfirmClear(true)}
            disabled={!frames || frames.length === 0 || busy !== null}
          >
            Clear timeline
          </button>
        </div>
      </div>

      {error ? <p className="chronicle-timeline-error">{error}</p> : null}

      {frames === null ? null : frames.length === 0 ? (
        <div className="chronicle-timeline-empty">
          {settings.enabled && !settings.paused
            ? "Nothing captured yet."
            : "Chronicle is off or paused, so nothing is being captured."}
        </div>
      ) : (
        <ol className="chronicle-timeline-list">
          {frames.map((frame) => {
            const excluded = isExcluded(settings.excludedApps, frame.bundleId);
            return (
              <li key={frame.id} className="chronicle-timeline-frame">
                {frame.thumbnailDataUrl ? (
                  <img
                    className="chronicle-timeline-thumb"
                    src={frame.thumbnailDataUrl}
                    alt={`Screen with ${frame.appName} in front`}
                  />
                ) : (
                  <div className="chronicle-timeline-thumb chronicle-timeline-thumb-missing" />
                )}
                <div className="chronicle-timeline-text">
                  <div className="chronicle-timeline-app">{frame.appName}</div>
                  <div className="chronicle-timeline-title" title={frame.windowTitle}>
                    {frame.windowTitle}
                  </div>
                  <time
                    className="chronicle-timeline-time"
                    dateTime={new Date(frame.capturedAt).toISOString()}
                  >
                    {formatFrameTime(frame.capturedAt)}
                  </time>
                </div>
                <div className="chronicle-timeline-actions">
                  {frame.bundleId && !excluded ? (
                    <button
                      type="button"
                      className="button-secondary chronicle-small-button"
                      onClick={() => void exclude(frame)}
                      disabled={busy !== null}
                      title={`Never capture ${frame.appName}, and delete its frames`}
                    >
                      <EyeOff size={14} strokeWidth={2} aria-hidden="true" />
                      Don&apos;t capture {frame.appName}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button-secondary chronicle-small-button"
                    onClick={() =>
                      void run(`delete:${frame.id}`, async () => {
                        await window.electronAPI.deleteChronicleFrame(frame.id);
                      })
                    }
                    disabled={busy !== null}
                    aria-label={`Delete the ${formatFrameTime(frame.capturedAt)} frame`}
                  >
                    <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {confirmClear ? (
        <ConfirmDialog
          title="Clear the timeline?"
          message="Every frame Chronicle is holding is deleted. Capture goes on as set."
          confirmLabel="Clear timeline"
          onConfirm={() => {
            setConfirmClear(false);
            void run("clear", async () => {
              await window.electronAPI.clearChronicleTimeline();
            });
          }}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}
    </div>
  );
}

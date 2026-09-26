import { useEffect, useMemo, useState } from "react";
import type { Task } from "../../shared/types";

/**
 * Ask for CoWork Pulse consent once, right after the user's first successful real task,
 * instead of during onboarding before they have seen CoWork do anything. Shown only
 * while consent is still "unset"; either answer is recorded so it never appears again.
 */
export function PulseConsentPrompt({ tasks }: { tasks: Task[] }) {
  const [consentUnset, setConsentUnset] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);

  const hasFirstSuccess = useMemo(
    () =>
      tasks.some(
        (task) =>
          task.status === "completed" &&
          !task.parentTaskId &&
          task.source !== "sample" &&
          (task.terminalStatus === undefined ||
            task.terminalStatus === null ||
            task.terminalStatus === "ok" ||
            task.terminalStatus === "partial_success"),
      ),
    [tasks],
  );

  useEffect(() => {
    if (!hasFirstSuccess || dismissed) return;
    const getPulseSettings = window.electronAPI?.getPulseSettings;
    if (typeof getPulseSettings !== "function") return;
    let cancelled = false;
    void getPulseSettings()
      .then((settings) => {
        if (!cancelled) setConsentUnset(settings.consentState === "unset");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hasFirstSuccess, dismissed]);

  if (!hasFirstSuccess || !consentUnset || dismissed) return null;

  const answer = async (enabled: boolean) => {
    setSaving(true);
    try {
      await window.electronAPI?.setPulseEnabled?.(enabled);
    } catch {
      // Leave consent unset if saving failed; the user can choose in Settings.
    } finally {
      setSaving(false);
      setDismissed(true);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Help improve CoWork"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        zIndex: 1000,
        maxWidth: 360,
        padding: "14px 16px",
        borderRadius: "var(--radius-lg, 12px)",
        border: "1px solid var(--color-border-subtle)",
        background: "var(--color-bg-elevated)",
        boxShadow: "var(--shadow-md)",
        color: "var(--color-text-primary)",
      }}
    >
      <strong style={{ display: "block", marginBottom: 6, fontSize: 13 }}>
        Nice, your first task is done. Help improve CoWork?
      </strong>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--color-text-secondary)" }}>
        Share content-free daily counts (tasks started and completed, tool categories, errors).
        Never prompts, responses, files, commands, URLs or account data. You can change this any
        time in Settings → CoWork Pulse.
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          className="button-secondary button-small"
          disabled={saving}
          onClick={() => void answer(false)}
        >
          No thanks
        </button>
        <button
          type="button"
          className="button-primary button-small"
          disabled={saving}
          onClick={() => void answer(true)}
        >
          Share counts
        </button>
      </div>
    </div>
  );
}

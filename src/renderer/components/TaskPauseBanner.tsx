import { useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { buildPauseBannerPreview } from "../utils/pause-banner-summary";

type TaskPauseBannerProps = {
  message?: string | null;
  reasonCode?: string | null;
  markdownComponents?: Any;
  onStopTask?: (() => void) | undefined;
  onEnableShell?: (() => void | Promise<void>) | undefined;
  onContinueWithoutShell?: (() => void | Promise<void>) | undefined;
};

export function TaskPauseBannerDetailsContent({
  message,
  markdownComponents,
}: {
  message: string;
  markdownComponents?: Any;
}) {
  return (
    <div className="task-pause-details-text markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {message}
      </ReactMarkdown>
    </div>
  );
}

export function TaskPauseBanner({
  message,
  reasonCode,
  markdownComponents,
  onStopTask,
  onEnableShell,
  onContinueWithoutShell,
}: TaskPauseBannerProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [pendingAction, setPendingAction] = useState<"enable_shell" | "continue_without_shell" | null>(
    null,
  );
  const detailsTitleId = useId();
  const normalizedMessage = typeof message === "string" ? message.trim() : "";
  const preview = useMemo(() => buildPauseBannerPreview(normalizedMessage), [normalizedMessage]);
  const waitingForSkillParameter = reasonCode === "skill_parameters";
  const waitingForShellPermission =
    reasonCode === "shell_permission_required" || reasonCode === "shell_permission_still_disabled";

  useEffect(() => {
    setShowDetails(false);
  }, [normalizedMessage]);

  useEffect(() => {
    setPendingAction(null);
  }, [reasonCode, normalizedMessage]);

  useEffect(() => {
    if (!showDetails) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowDetails(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showDetails]);

  const runBannerAction = async (
    action: "enable_shell" | "continue_without_shell",
    handler?: (() => void | Promise<void>) | undefined,
  ) => {
    if (!handler || pendingAction) return;
    setPendingAction(action);
    try {
      await handler();
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <>
      <div className="task-status-banner task-status-banner-paused">
        <div className="task-status-banner-content">
          <strong>
            {waitingForShellPermission
              ? "Shell access is needed to continue."
              : waitingForSkillParameter
              ? "Skill needs one more detail."
              : "Quick check-in - I'm at a decision point."}
          </strong>
          {normalizedMessage && (
            <span className="task-status-banner-detail task-status-banner-summary">
              {preview.summary}
            </span>
          )}
          <span className="task-status-banner-detail">
            {waitingForShellPermission
              ? "Enable shell to let me run commands, or continue without it and I’ll use a limited path."
              : waitingForSkillParameter
              ? "Reply below with the requested value, or stop this task here."
              : "Type anything below to continue, or stop this task here."}
          </span>
        </div>
        {(waitingForShellPermission || preview.showDetails || onStopTask) && (
          <div className="task-status-banner-actions">
            {waitingForShellPermission && onEnableShell && (
              <button
                type="button"
                className="task-status-banner-primary-btn"
                onClick={() => void runBannerAction("enable_shell", onEnableShell)}
                disabled={pendingAction !== null}
              >
                {pendingAction === "enable_shell" ? "Enabling shell..." : "Enable shell"}
              </button>
            )}
            {waitingForShellPermission && onContinueWithoutShell && (
              <button
                type="button"
                className="task-status-banner-secondary-btn"
                onClick={() =>
                  void runBannerAction("continue_without_shell", onContinueWithoutShell)
                }
                disabled={pendingAction !== null}
              >
                {pendingAction === "continue_without_shell"
                  ? "Continuing..."
                  : "Continue without shell"}
              </button>
            )}
            {preview.showDetails && (
              <button
                type="button"
                className="task-status-banner-secondary-btn"
                onClick={() => setShowDetails(true)}
                disabled={pendingAction !== null}
              >
                View details
              </button>
            )}
            {onStopTask && (
              <button
                type="button"
                className="task-status-banner-stop-btn"
                onClick={onStopTask}
                title="Stop task"
                disabled={pendingAction !== null}
              >
                Stop task
              </button>
            )}
          </div>
        )}
      </div>

      {showDetails && preview.showDetails && (
        <div className="modal-overlay" onClick={() => setShowDetails(false)}>
          <div
            className="modal task-pause-details-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={detailsTitleId}
          >
            <div className="modal-header">
              <h2 id={detailsTitleId}>Quick check-in details</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowDetails(false)}
                aria-label="Close details"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <TaskPauseBannerDetailsContent
                message={preview.fullText}
                markdownComponents={markdownComponents}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

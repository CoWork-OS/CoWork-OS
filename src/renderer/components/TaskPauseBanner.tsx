import { useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { fixUnclosedBold } from "../utils/markdown-inline-lists";
import { buildPauseBannerPreview } from "../utils/pause-banner-summary";

type TaskPauseBannerProps = {
  message?: string | null;
  reasonCode?: string | null;
  markdownComponents?: Any;
  onStopTask?: (() => void) | undefined;
  onEnableShell?: (() => void | Promise<void>) | undefined;
  onContinueWithoutShell?: (() => void | Promise<void>) | undefined;
};

const LOW_SIGNAL_REASON_CODES = new Set([
  "required_decision",
  "required_decision_followup",
  "input_request",
  "skill_parameters",
  "user_action_required_failure",
  "user_action_required_tool",
  "user_action_required_disabled",
  "shell_permission_required",
  "shell_permission_still_disabled",
  "missing_required_workspace_artifact",
]);

const REQUIRED_DECISION_REASON_CODES = new Set(["required_decision", "required_decision_followup"]);

function isLowSignalPauseMessage(message: string, reasonCode?: string | null): boolean {
  const lower = message.trim().toLowerCase();
  if (!lower) return true;
  if (reasonCode && lower === reasonCode.trim().toLowerCase()) return true;
  return LOW_SIGNAL_REASON_CODES.has(lower) || lower === "paused - awaiting user input";
}

function hasConcreteDecisionRequest(message: string): boolean {
  const lower = message.trim().toLowerCase();
  if (!lower) return false;
  if (/[?]/u.test(lower)) return true;
  return (
    /\b(?:reply|respond)\s+with\b/i.test(lower) ||
    /\bneed\s+your\s+(?:input|approval|confirmation|decision|choice|answer)\b/i.test(lower) ||
    /\b(?:choose|pick|select|confirm|specify|provide|clarify)\b/i.test(lower) ||
    /\b(?:tell me|let me know)\b/i.test(lower) ||
    /\b(?:should i|do you want|would you like|which option|which path|which file|which approach)\b/i.test(
      lower,
    ) ||
    /\b(?:before i can|cannot continue|can't continue|unable to continue)\b/i.test(lower)
  );
}

function getPauseBannerCopy(
  reasonCode?: string | null,
  displayMessage: string = "",
): { title: string; instruction: string } {
  if (
    reasonCode === "shell_permission_required" ||
    reasonCode === "shell_permission_still_disabled"
  ) {
    return {
      title: "Shell access is needed to continue.",
      instruction:
        "Enable shell to let me run commands, or continue without it and I’ll use a limited path.",
    };
  }
  if (reasonCode === "skill_parameters") {
    return {
      title: "Skill needs one more detail.",
      instruction: "Reply below with the requested value, or stop this task here.",
    };
  }
  if (reasonCode === "missing_required_workspace_artifact") {
    return {
      title: "A required file is missing.",
      instruction: "Attach the missing file or tell me where to find it, or stop this task here.",
    };
  }
  if (reasonCode === "user_action_required_failure" || reasonCode === "user_action_required_tool") {
    return {
      title: "I need your decision to continue.",
      instruction: "Reply with what you want me to do next, or stop this task here.",
    };
  }
  if (reasonCode && REQUIRED_DECISION_REASON_CODES.has(reasonCode)) {
    if (displayMessage && !hasConcreteDecisionRequest(displayMessage)) {
      return {
        title: "Paused after an update.",
        instruction:
          "I don't see a specific decision request here. Reply with changes to guide the task, or type continue to let it proceed.",
      };
    }
    return {
      title: "Decision needed to continue.",
      instruction: "Reply with your choice or answer, or stop this task here.",
    };
  }
  return {
    title: "Quick check-in - I'm at a decision point.",
    instruction: "Type anything below to continue, or stop this task here.",
  };
}

function buildInlineMarkdownComponents(markdownComponents?: Any): Any {
  return {
    ...markdownComponents,
    p: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
    h1: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
    h2: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
    h3: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
    h4: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
    h5: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
    h6: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
    ul: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
    ol: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
    li: ({ children, ...props }: Any) => <span {...props}>{children}</span>,
  };
}

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
  const displayMessage = isLowSignalPauseMessage(normalizedMessage, reasonCode)
    ? ""
    : normalizedMessage;
  const preview = useMemo(() => buildPauseBannerPreview(displayMessage), [displayMessage]);
  const inlineMarkdownComponents = useMemo(
    () => buildInlineMarkdownComponents(markdownComponents),
    [markdownComponents],
  );
  const copy = getPauseBannerCopy(reasonCode, displayMessage);
  const title =
    displayMessage &&
    reasonCode !== "shell_permission_required" &&
    reasonCode !== "shell_permission_still_disabled" &&
    reasonCode !== "skill_parameters" &&
    reasonCode !== "missing_required_workspace_artifact"
      ? copy.title
      : copy.title;
  const waitingForShellPermission =
    reasonCode === "shell_permission_required" || reasonCode === "shell_permission_still_disabled";

  useEffect(() => {
    setShowDetails(false);
  }, [displayMessage]);

  useEffect(() => {
    setPendingAction(null);
  }, [reasonCode, displayMessage]);

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
          <strong>{title}</strong>
          {displayMessage && (
            <span className="task-status-banner-detail task-status-banner-summary">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={inlineMarkdownComponents}>
                {fixUnclosedBold(preview.summary)}
              </ReactMarkdown>
            </span>
          )}
          <span className="task-status-banner-detail">{copy.instruction}</span>
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

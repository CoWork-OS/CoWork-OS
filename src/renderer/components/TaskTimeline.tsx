import { useState, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TaskEvent, DEFAULT_QUIRKS } from "../../shared/types";
import { isVerificationStepDescription } from "../../shared/plan-utils";
import { ThemeIcon } from "./ThemeIcon";
import {
  AlertTriangleIcon,
  BanIcon,
  BookIcon,
  CheckIcon,
  ClipboardIcon,
  DotIcon,
  ShieldIcon,
  FileIcon,
  MessageIcon,
  PackageIcon,
  PauseIcon,
  PlayIcon,
  SlidersIcon,
  StopIcon,
  TargetIcon,
  TrashIcon,
  XIcon,
  ZapIcon,
} from "./LineIcons";
import type { AgentContext } from "../hooks/useAgentContext";
import { getUiCopy, type UiCopyKey } from "../utils/agentMessages";
import { formatDuration } from "../hooks/useTaskDuration";

/**
 * Maps raw system/API errors to human-readable messages.
 * Returns the original message if no mapping matches.
 */
function humanizeError(raw: string): string {
  if (!raw || typeof raw !== "string") return raw;
  const mappings: Array<[RegExp, string]> = [
    // Auth
    [/401|unauthorized/i, "Your API key was rejected — double-check it in Settings."],
    [/403|forbidden/i, "Access denied — your key may not have permission for this model."],
    // Rate limits / quota
    [/429|too many requests|rate.limit/i, "Rate limited — wait a moment and try again."],
    [
      /quota.*exceeded|exceeded.*quota|resource.*exhausted/i,
      "Your usage quota is reached. Check billing at your provider.",
    ],
    [
      /billing|payment.*required|upgrade your plan/i,
      "Billing issue with your AI provider — check your payment method.",
    ],
    // Network
    [/ECONNRESET/i, "Connection was interrupted. Check your internet and try again."],
    [/ETIMEDOUT|timed?\s*out/i, "Request timed out. Try again in a moment."],
    [/ENOTFOUND/i, "Could not reach the server. Check your internet connection."],
    [/ECONNREFUSED/i, "Connection refused — the service may be down. Try again shortly."],
    [
      /fetch.*failed|network.*error/i,
      "Network error. Check your internet connection and try again.",
    ],
    // Server errors
    [/500|internal server error/i, "The AI provider had an internal error — try again."],
    [/502|bad gateway/i, "The AI provider is temporarily unreachable. Try again shortly."],
    [/503|service unavailable|overloaded/i, "The AI service is overloaded. Try again in a minute."],
    // Model / context
    [
      /context.*length|too.*long|max.*tokens.*exceeded/i,
      "Conversation too long for this model. Start a new task or switch models.",
    ],
    [
      /model.*not found|no endpoints found|invalid.*model/i,
      "The selected model is not available. Try a different model in Settings.",
    ],
  ];
  for (const [pattern, message] of mappings) {
    if (pattern.test(raw)) return message;
  }
  return raw;
}

interface TaskTimelineProps {
  events: TaskEvent[];
  agentContext?: AgentContext;
  taskId?: string;
  taskStatus?: string;
}

const ACTIVE_TASK_STATUSES = new Set(["executing", "planning", "interrupted"]);
const GLOB_TOKEN_REGEX = /(?<![`\\])\*\*\/\*[^\s,;()]+/g;
const TIMELINE_TITLE_MARKDOWN_COMPONENTS = {
  // Keep timeline titles inline; avoid wrapping plain text in <p> blocks.
  p: ({ children }: Any) => <>{children}</>,
};

function protectGlobTokens(text: string): string {
  return String(text || "").replace(GLOB_TOKEN_REGEX, (token) => `\`${token}\``);
}

export function TaskTimeline({ events, agentContext, taskId, taskStatus }: TaskTimelineProps) {
  const isTaskActive = taskStatus ? ACTIVE_TASK_STATUSES.has(taskStatus) : false;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isTaskActive) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isTaskActive]);

  const fallbackContext = {
    agentName: "CoWork",
    userName: undefined,
    personality: "professional" as const,
    persona: undefined,
    emojiUsage: "minimal" as const,
    quirks: DEFAULT_QUIRKS,
  };
  const uiCopy = (key: UiCopyKey) =>
    agentContext?.getUiCopy ? agentContext.getUiCopy(key) : getUiCopy(key, fallbackContext);
  const isCompanion = agentContext?.persona === "companion";
  // Filter out internal events that don't provide value to end users
  const internalEventTypes = [
    "tool_blocked", // deduplication blocks
    "follow_up_completed", // internal follow-up tracking
    "follow_up_failed", // internal follow-up tracking
  ];

  const isVerificationNoiseEvent = (event: TaskEvent): boolean => {
    if (event.type === "assistant_message") return event.payload?.internal === true;
    if (event.type === "step_started" || event.type === "step_completed") {
      return isVerificationStepDescription(event.payload?.step?.description);
    }
    if (event.type === "verification_started" || event.type === "verification_passed") return true;
    return false;
  };

  const blockedEvents = events.filter((e) => e.type === "tool_blocked");
  const visibleEvents = events.filter(
    (e) => !internalEventTypes.includes(e.type) && !isVerificationNoiseEvent(e),
  );

  // Determine the currently active step (step_started with no matching completion)
  const activeStepId = useMemo(() => {
    let active: string | null = null;
    for (const e of events) {
      if (e.type === "step_started" && e.payload.step?.id) {
        active = e.payload.step.id;
      } else if (
        (e.type === "step_completed" || e.type === "step_failed" || e.type === "step_skipped") &&
        e.payload.step?.id === active
      ) {
        active = null;
      }
    }
    return active;
  }, [events]);

  // Step feedback state
  const [feedbackOpen, setFeedbackOpen] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);

  const handleStepFeedback = async (
    stepId: string,
    action: "retry" | "skip" | "stop" | "drift",
    message?: string,
  ) => {
    if (!taskId || feedbackSending) return;
    setFeedbackSending(true);
    try {
      await window.electronAPI.sendStepFeedback(taskId, stepId, action, message);
      setFeedbackOpen(null);
      setFeedbackText("");
    } catch (err) {
      console.error("Failed to send step feedback:", err);
    } finally {
      setFeedbackSending(false);
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const getEventIcon = (type: TaskEvent["type"]) => {
    switch (type) {
      case "task_created":
        return <ThemeIcon emoji="🎯" icon={<TargetIcon size={16} />} />;
      case "plan_created":
        return <ThemeIcon emoji="📋" icon={<ClipboardIcon size={16} />} />;
      case "step_started":
        return <ThemeIcon emoji="▶️" icon={<PlayIcon size={16} />} />;
      case "step_completed":
        return <ThemeIcon emoji="✅" icon={<CheckIcon size={16} />} />;
      case "tool_call":
        return <ThemeIcon emoji="🔧" icon={<SlidersIcon size={16} />} />;
      case "tool_result":
        return <ThemeIcon emoji="📦" icon={<PackageIcon size={16} />} />;
      case "file_created":
      case "file_modified":
        return <ThemeIcon emoji="📄" icon={<FileIcon size={16} />} />;
      case "file_deleted":
        return <ThemeIcon emoji="🗑️" icon={<TrashIcon size={16} />} />;
      case "error":
        return <ThemeIcon emoji="❌" icon={<XIcon size={16} />} />;
      case "task_cancelled":
        return <ThemeIcon emoji="🛑" icon={<StopIcon size={16} />} />;
      case "approval_requested":
        return <ThemeIcon emoji="⚠️" icon={<AlertTriangleIcon size={16} />} />;
      case "approval_granted":
        return <ThemeIcon emoji="✅" icon={<CheckIcon size={16} />} />;
      case "approval_denied":
        return <ThemeIcon emoji="⛔" icon={<BanIcon size={16} />} />;
      case "task_paused":
        return <ThemeIcon emoji="⏸️" icon={<PauseIcon size={16} />} />;
      case "task_resumed":
        return <ThemeIcon emoji="▶️" icon={<PlayIcon size={16} />} />;
      case "executing":
        return <ThemeIcon emoji="⚡" icon={<ZapIcon size={16} />} />;
      case "task_completed":
        return <ThemeIcon emoji="✅" icon={<CheckIcon size={16} />} />;
      case "follow_up_completed":
        return <ThemeIcon emoji="✅" icon={<CheckIcon size={16} />} />;
      case "context_summarized":
        return <ThemeIcon emoji="📝" icon={<BookIcon size={16} />} />;
      case "worktree_created":
        return <ThemeIcon emoji="🌿" icon={<DotIcon size={8} />} />;
      case "worktree_committed":
        return <ThemeIcon emoji="💾" icon={<CheckIcon size={16} />} />;
      case "worktree_merge_start":
        return <ThemeIcon emoji="🔀" icon={<DotIcon size={8} />} />;
      case "worktree_merged":
        return <ThemeIcon emoji="✅" icon={<CheckIcon size={16} />} />;
      case "worktree_conflict":
        return <ThemeIcon emoji="⚠️" icon={<AlertTriangleIcon size={16} />} />;
      case "worktree_cleaned":
        return <ThemeIcon emoji="🧹" icon={<DotIcon size={8} />} />;
      case "comparison_started":
        return <ThemeIcon emoji="⚔️" icon={<ZapIcon size={16} />} />;
      case "comparison_completed":
        return <ThemeIcon emoji="📊" icon={<CheckIcon size={16} />} />;
      case "step_feedback":
        return <ThemeIcon emoji="💬" icon={<MessageIcon size={16} />} />;
      case "step_skipped":
        return <ThemeIcon emoji="⏭️" icon={<ZapIcon size={16} />} />;
      case "progress_journal":
        return <ThemeIcon emoji="📓" icon={<ClipboardIcon size={16} />} />;
      case "research_recovery_started":
        return <ThemeIcon emoji="🔍" icon={<ZapIcon size={16} />} />;
      default:
        return <ThemeIcon emoji="•" icon={<DotIcon size={8} />} />;
    }
  };

  const getEventTitle = (event: TaskEvent) => {
    switch (event.type) {
      case "task_created":
        return isCompanion ? "Session started - I'm here." : "Session started";
      case "plan_created":
        return isCompanion ? "Here's the path I'm taking" : "Here's our approach";
      case "step_started":
        return `Working on: ${event.payload.step?.description || "Getting started"}`;
      case "step_completed":
        return event.payload.step?.description || event.payload.message || "Done";
      case "tool_call":
        return `Using: ${event.payload.tool}`;
      case "tool_result":
        return `${event.payload.tool} done`;
      case "file_created":
        return `Created: ${event.payload.path}`;
      case "file_modified":
        return `Updated: ${event.payload.path || event.payload.from}`;
      case "file_deleted":
        return `Removed: ${event.payload.path}`;
      case "error":
        return isCompanion ? "I ran into a snag" : "Hit a snag";
      case "task_cancelled":
        return "Session stopped";
      case "approval_requested":
        return event.payload?.autoApproved === true
          ? isCompanion
            ? `Auto-approved: ${event.payload.approval?.description}`
            : `Auto-approved: ${event.payload.approval?.description}`
          : isCompanion
            ? `I need your input: ${event.payload.approval?.description}`
            : `Need your input: ${event.payload.approval?.description}`;
      case "approval_granted":
        return "Approval granted";
      case "approval_denied":
        return "Approval denied";
      case "task_paused":
        return (
          event.payload.message ||
          (isCompanion ? "I paused to check with you before moving on" : "Paused to get your call")
        );
      case "task_resumed":
        return isCompanion ? "Back in motion" : "Resumed";
      case "executing":
        return event.payload.message || "Working on it";
      case "task_completed":
        return isCompanion ? "All done." : "All done!";
      case "follow_up_completed":
        return "All done!";
      case "context_summarized": {
        const count = event.payload.removedCount || 0;
        const freed =
          event.payload.tokensBefore && event.payload.tokensAfter
            ? event.payload.tokensBefore - event.payload.tokensAfter
            : 0;
        const freedLabel = freed > 0 ? ` \u2014 ${freed.toLocaleString()} tokens freed` : "";
        return `Session context compacted \u2014 ${count} message${count !== 1 ? "s" : ""} summarized${freedLabel}`;
      }
      case "log":
        return event.payload.message;
      case "worktree_created":
        return event.payload.message || `Created worktree branch: ${event.payload.branch || ""}`;
      case "worktree_committed":
        return event.payload.message || "Changes committed";
      case "worktree_merge_start":
        return event.payload.message || "Merging to base branch...";
      case "worktree_merged":
        return event.payload.message || "Branch merged successfully";
      case "worktree_conflict":
        return event.payload.message || "Merge conflict detected";
      case "worktree_cleaned":
        return event.payload.message || "Worktree cleaned up";
      case "comparison_started":
        return event.payload.message || "Comparison session started";
      case "comparison_completed":
        return event.payload.message || "Comparison session completed";
      case "step_feedback": {
        const action = event.payload.action || "feedback";
        const desc = event.payload.step?.description || "step";
        const msg = event.payload.message ? ` \u2014 ${event.payload.message}` : "";
        return `Feedback: ${action} on "${desc}"${msg}`;
      }
      case "step_skipped":
        return `Skipped: ${event.payload.step?.description || event.payload.reason || "step"}`;
      case "progress_journal":
        return event.payload.message || "Progress update";
      case "research_recovery_started":
        return event.payload.message || "Researching solution...";
      default:
        return event.type;
    }
  };

  /**
   * Parse a structured compaction summary into collapsible sections.
   * Sections are identified by numbered headings like "1. **Title**" or "**1. Title**".
   * Falls back to plain pre-wrap rendering if no sections are found.
   */
  const renderCompactionSummary = (summary: string) => {
    // Try to split on numbered section headings
    const sectionPattern = /^(\d+)\.\s+\*\*(.+?)\*\*/gm;
    const matches: { index: number; num: string; title: string }[] = [];
    let match;
    while ((match = sectionPattern.exec(summary)) !== null) {
      matches.push({ index: match.index, num: match[1], title: match[2] });
    }

    if (matches.length < 3) {
      // Not enough structure detected; fall back to plain text
      return <div className="context-summary-body">{summary}</div>;
    }

    // Auto-expand these section numbers for quick scanning
    const autoExpand = new Set(["1", "7", "8", "9"]);

    const sections = matches.map((m, i) => {
      const start = m.index;
      const end = i + 1 < matches.length ? matches[i + 1].index : summary.length;
      // Extract section body (everything after the heading line)
      const fullText = summary.slice(start, end).trim();
      const headingEnd = fullText.indexOf("\n");
      const body = headingEnd >= 0 ? fullText.slice(headingEnd + 1).trim() : "";
      return { num: m.num, title: m.title, body };
    });

    // Include any preamble text before the first section
    const preamble = summary.slice(0, matches[0].index).trim();

    return (
      <div className="context-summary-body">
        {preamble && <div className="context-summary-preamble">{preamble}</div>}
        {sections.map((s) => (
          <details
            key={s.num}
            className="context-summary-section"
            open={autoExpand.has(s.num) || undefined}
          >
            <summary>
              {s.num}. {s.title}
            </summary>
            <div className="context-summary-section-content">{s.body}</div>
          </details>
        ))}
      </div>
    );
  };

  const renderEventDetails = (event: TaskEvent) => {
    switch (event.type) {
      case "plan_created":
        return (
          <div className="event-details">
            <div className="plan-description markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {protectGlobTokens(String(event.payload.plan?.description || ""))}
              </ReactMarkdown>
            </div>
            {event.payload.plan?.steps && (
              <ul className="plan-steps">
                {event.payload.plan.steps
                  .filter((step: Any) => !isVerificationStepDescription(step?.description))
                  .map((step: Any, i: number) => (
                    <li key={i}>
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={TIMELINE_TITLE_MARKDOWN_COMPONENTS}
                      >
                        {protectGlobTokens(String(step?.description || ""))}
                      </ReactMarkdown>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        );
      case "tool_call":
        return (
          <div className="event-details">
            <pre>{JSON.stringify(event.payload.input, null, 2)}</pre>
          </div>
        );
      case "tool_result":
        return (
          <div className="event-details">
            <pre>{JSON.stringify(event.payload.result, null, 2)}</pre>
          </div>
        );
      case "error": {
        const errorMessage = humanizeError(
          String(event.payload.error || event.payload.message || ""),
        );
        const actionHint = event.payload.actionHint;
        // Turn URLs in the error text into clickable links
        const renderWithLinks = (text: string) => {
          const parts = text.split(/(https?:\/\/[^\s)]+)/g);
          return parts.map((part, i) =>
            part.startsWith("http://") || part.startsWith("https://") ? (
              <a
                key={i}
                href={part}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent-color)", textDecoration: "underline" }}
              >
                {part}
              </a>
            ) : (
              part
            ),
          );
        };
        return (
          <div className="event-details error">
            <div>
              {typeof errorMessage === "string" ? renderWithLinks(errorMessage) : errorMessage}
            </div>
            {actionHint?.type === "open_settings" && (
              <button
                className="button-primary button-small"
                onClick={() => window.dispatchEvent(new CustomEvent("open-settings"))}
              >
                {actionHint.label || "Open Settings"}
              </button>
            )}
            {actionHint?.type === "continue_task" && taskId && taskStatus === "failed" && (
              <button
                className="button-primary button-small"
                onClick={() => window.electronAPI.continueTask(taskId)}
              >
                {actionHint.label || "Continue"}
              </button>
            )}
          </div>
        );
      }
      case "task_cancelled":
        return (
          <div className="event-details cancelled">
            {event.payload.message || "Session was stopped"}
          </div>
        );
      case "context_summarized":
        return event.payload.summary ? (
          <div className="event-details context-summary">
            <div className="context-summary-header">
              Session context compacted. The summary below captures all prior work so the agent
              can continue seamlessly.
            </div>
            {renderCompactionSummary(event.payload.summary)}
            {event.payload.tokensBefore > 0 && (
              <div className="context-summary-stats">
                {(event.payload.tokensBefore - (event.payload.tokensAfter || 0)).toLocaleString()}{" "}
                tokens freed &middot; {event.payload.removedCount || 0} messages compacted
                {event.payload.proactive ? " (proactive)" : ""}
              </div>
            )}
          </div>
        ) : null;
      default:
        return null;
    }
  };

  if (visibleEvents.length === 0 && blockedEvents.length === 0) {
    return (
      <div className="timeline-empty">
        <p>{uiCopy("timelineEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="timeline">
      <h3>{uiCopy("timelineTitle")}</h3>
      <div className="timeline-events">
        {visibleEvents.map((event) => {
          const isActiveStep =
            event.type === "step_started" && event.payload.step?.id === activeStepId;
          const stepId = event.payload?.step?.id;
          return (
            <div
              key={event.id}
              className={`timeline-event${isActiveStep ? " timeline-event-active-step" : ""}`}
            >
              <div className="event-icon">{getEventIcon(event.type)}</div>
              <div className="event-content">
                <div className="event-header">
                  <div className="event-title">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={TIMELINE_TITLE_MARKDOWN_COMPONENTS}
                    >
                      {protectGlobTokens(getEventTitle(event))}
                    </ReactMarkdown>
                  </div>
                  <div className="event-time">
                    {formatTime(event.timestamp)}
                    {isActiveStep && (
                      <button
                        className="timeline-step-feedback-toggle"
                        onClick={() => setFeedbackOpen(feedbackOpen === stepId ? null : stepId)}
                        title="Give feedback on this step"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="1" />
                          <circle cx="19" cy="12" r="1" />
                          <circle cx="5" cy="12" r="1" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                {isActiveStep && feedbackOpen === stepId && (
                  <div className="timeline-step-feedback-panel">
                    <div className="timeline-step-feedback-actions">
                      <button
                        className="timeline-step-feedback-btn skip"
                        onClick={() => handleStepFeedback(stepId, "skip")}
                        disabled={feedbackSending}
                      >
                        Skip
                      </button>
                      <button
                        className="timeline-step-feedback-btn retry"
                        onClick={() =>
                          handleStepFeedback(stepId, "retry", feedbackText || undefined)
                        }
                        disabled={feedbackSending}
                      >
                        Retry
                      </button>
                      <button
                        className="timeline-step-feedback-btn stop"
                        onClick={() => handleStepFeedback(stepId, "stop")}
                        disabled={feedbackSending}
                      >
                        Stop
                      </button>
                    </div>
                    <div className="timeline-step-feedback-drift">
                      <input
                        className="timeline-step-feedback-input"
                        type="text"
                        placeholder="Adjust direction..."
                        value={feedbackText}
                        onChange={(e) => setFeedbackText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && feedbackText.trim()) {
                            handleStepFeedback(stepId, "drift", feedbackText.trim());
                          }
                          if (e.key === "Escape") {
                            setFeedbackOpen(null);
                          }
                        }}
                        disabled={feedbackSending}
                        autoFocus
                      />
                      <button
                        className="timeline-step-feedback-btn send"
                        onClick={() => {
                          if (feedbackText.trim()) {
                            handleStepFeedback(stepId, "drift", feedbackText.trim());
                          }
                        }}
                        disabled={feedbackSending || !feedbackText.trim()}
                      >
                        Send
                      </button>
                    </div>
                  </div>
                )}
                {renderEventDetails(event)}
              </div>
            </div>
          );
        })}
        {/* Show summary of blocked events if any - collapsed for cleaner UI */}
        {blockedEvents.length > 0 && (
          <div className="timeline-event timeline-event-muted">
            <div className="event-icon">
              <ThemeIcon emoji="🛡️" icon={<ShieldIcon size={16} />} />
            </div>
            <div className="event-content">
              <div className="event-header">
                <div className="event-title">
                  {blockedEvents.length} duplicate tool call{blockedEvents.length > 1 ? "s" : ""}{" "}
                  prevented
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Duration summary divider */}
      {visibleEvents.length > 0 && (() => {
        const firstTs = visibleEvents[0].timestamp;
        const lastTs = isTaskActive ? now : visibleEvents[visibleEvents.length - 1].timestamp;
        const elapsed = lastTs - firstTs;
        // Only show if at least 1 second has passed
        if (elapsed < 1000) return null;
        return (
          <div className="timeline-duration-divider">
            <span className="timeline-duration-line" />
            <span className="timeline-duration-label">
              Worked for {formatDuration(elapsed)}
            </span>
            <span className="timeline-duration-line" />
          </div>
        );
      })()}
    </div>
  );
}

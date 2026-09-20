import { memo, useEffect, useMemo, useRef } from "react";
import { ArrowUp, ExternalLink, Loader2, MessageSquarePlus, X } from "lucide-react";
import type { ComposerDraft } from "../../shared/composer-drafts";
import type { Task, TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "../utils/task-event-compat";
import { MarkdownRenderer } from "./MarkdownRenderer";
import "./side-chat-panel.css";

type SideChatPanelProps = {
  parentTask?: Task | null;
  sideTask?: Task | null;
  events: TaskEvent[];
  loading?: boolean;
  sending?: boolean;
  onSendMessage: (message: string) => void | boolean | Promise<void | boolean>;
  draftValue?: string;
  draftRevision?: number;
  draftSnapshot?: ComposerDraft | null;
  onDraftValueChange?: (value: string) => ComposerDraft | void;
  onDraftAccepted?: (
    revision: number,
    submittedDraft?: ComposerDraft | null,
  ) => void | boolean | Promise<void | boolean>;
  onClose: () => void;
  onOpenSideTask?: (taskId: string) => void;
};

type SideChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

function getEventMessage(event: TaskEvent): string {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.content === "string") return payload.content;
  return "";
}

function isForkedParentTranscriptEvent(event: TaskEvent): boolean {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : undefined;
  if (!payload || Array.isArray(payload)) return false;
  return (
    typeof payload.forkedFromTaskId === "string" || typeof payload.forkedFromEventId === "string"
  );
}

function deriveMessages(events: TaskEvent[]): SideChatMessage[] {
  return events.flatMap((event) => {
    if (isForkedParentTranscriptEvent(event)) return [];
    const type = getEffectiveTaskEventType(event);
    if (type !== "user_message" && type !== "assistant_message") return [];
    const text = getEventMessage(event).trim();
    if (!text) return [];
    return [
      {
        id: event.id || event.eventId || `${event.taskId}:${event.timestamp}:${type}`,
        role: type === "user_message" ? "user" : "assistant",
        text,
        timestamp: event.timestamp,
      },
    ];
  });
}

function getTaskStatusLabel(task?: Task | null): string {
  if (!task) return "Unavailable";
  switch (task.status) {
    case "executing":
    case "planning":
      return "Running";
    case "paused":
      return "Paused";
    case "blocked":
    case "interrupted":
      return "Needs input";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "pending":
    case "queued":
      return "Queued";
    default:
      return task.status;
  }
}

function formatSideChatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export const SideChatPanel = memo(function SideChatPanel({
  parentTask,
  sideTask,
  events,
  loading = false,
  sending = false,
  onSendMessage,
  draftValue = "",
  draftRevision = 0,
  draftSnapshot = null,
  onDraftValueChange,
  onDraftAccepted,
  onClose,
  onOpenSideTask,
}: SideChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const draftRevisionRef = useRef(draftRevision);
  const draftSnapshotRef = useRef<ComposerDraft | null>(draftSnapshot);
  if (draftSnapshotRef.current?.draftKey !== draftSnapshot?.draftKey) {
    draftRevisionRef.current = draftRevision;
    draftSnapshotRef.current = draftSnapshot;
  } else {
    draftRevisionRef.current = Math.max(draftRevisionRef.current, draftRevision);
    if (draftSnapshot && draftSnapshot.revision >= (draftSnapshotRef.current?.revision ?? -1)) {
      draftSnapshotRef.current = draftSnapshot;
    }
  }
  const messages = useMemo(() => deriveMessages(events), [events]);
  const parentStatus = getTaskStatusLabel(parentTask);
  const sideStatus = getTaskStatusLabel(sideTask);
  const canSend = draftValue.trim().length > 0 && !sending && !!sideTask;
  const headerStatus = sideTask ? sideStatus : loading ? "Opening" : "Unavailable";

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [messages.length, loading, sending]);

  const submit = () => {
    const message = draftValue.trim();
    if (!message || !sideTask || sending) return;
    const submittedRevision = draftRevisionRef.current;
    const submittedDraft = draftSnapshotRef.current;
    void Promise.resolve(onSendMessage(message))
      .then(async (sent) => {
        if (sent === false || draftRevisionRef.current !== submittedRevision) return;
        const accepted = await onDraftAccepted?.(submittedRevision, submittedDraft);
        if (accepted === false) return;
        // The accepted callback owns the durable draft deletion. Its store
        // emission drives the controlled value to empty; updating it again
        // here would recreate a new empty draft row.
        if (!onDraftAccepted) onDraftValueChange?.("");
      })
      .catch(() => {
        // Keep the controlled draft intact so a failed side send is retryable.
      });
  };

  return (
    <aside className="side-chat-panel" aria-label="Side conversation">
      <header className="side-chat-header">
        <div className="side-chat-title-row">
          <div className="side-chat-title">
            <MessageSquarePlus size={17} aria-hidden="true" />
            <div className="side-chat-title-copy">
              <span>Side chat</span>
              {parentTask?.title ? (
                <span className="side-chat-parent-title" title={parentTask.title}>
                  {parentTask.title}
                </span>
              ) : null}
            </div>
          </div>
          <div className="side-chat-header-actions">
            {sideTask?.id && onOpenSideTask ? (
              <button
                type="button"
                className="side-chat-icon-btn"
                onClick={() => onOpenSideTask(sideTask.id)}
                title="Open side conversation as a full thread"
                aria-label="Open side conversation as a full thread"
              >
                <ExternalLink size={15} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className="side-chat-icon-btn"
              onClick={onClose}
              title="Close side conversation"
              aria-label="Close side conversation"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="side-chat-meta-row">
          <span className={`side-chat-status side-chat-status-${sideTask?.status || "unknown"}`}>
            {headerStatus}
          </span>
          <span className="side-chat-meta-separator" aria-hidden="true" />
          <span
            className={`side-chat-parent-status side-chat-status-${parentTask?.status || "unknown"}`}
          >
            Parent {parentStatus}
          </span>
        </div>
      </header>

      <div className="side-chat-messages" ref={scrollRef}>
        {loading ? (
          <div className="side-chat-empty">
            <Loader2 size={18} className="side-chat-spin" aria-hidden="true" />
            <span>Opening side conversation...</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="side-chat-empty">
            <MessageSquarePlus size={20} aria-hidden="true" />
            <span>Ask about this session without changing the active task.</span>
          </div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`side-chat-message side-chat-message-${message.role}`}>
              <div className="side-chat-message-role">
                {message.role === "user" ? "You" : "Side"}
              </div>
              <div className="side-chat-message-text markdown-content">
                <MarkdownRenderer>{message.text}</MarkdownRenderer>
              </div>
              <div className="side-chat-message-time">{formatSideChatTime(message.timestamp)}</div>
            </div>
          ))
        )}
        {sending ? (
          <div className="side-chat-thinking">
            <Loader2 size={15} className="side-chat-spin" aria-hidden="true" />
            <span>Thinking</span>
          </div>
        ) : null}
      </div>

      <footer className="side-chat-composer">
        <textarea
          value={draftValue}
          onChange={(event) => {
            const draft = onDraftValueChange?.(event.target.value);
            if (draft) {
              draftRevisionRef.current = draft.revision;
              draftSnapshotRef.current = draft;
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Ask a side question"
          aria-label="Ask a side question"
          rows={2}
          disabled={!sideTask}
        />
        <button
          type="button"
          className="side-chat-send"
          onClick={submit}
          disabled={!canSend}
          title="Send side question"
          aria-label="Send side question"
        >
          {sending ? (
            <Loader2 size={16} className="side-chat-spin" aria-hidden="true" />
          ) : (
            <ArrowUp size={17} aria-hidden="true" />
          )}
        </button>
      </footer>
    </aside>
  );
});

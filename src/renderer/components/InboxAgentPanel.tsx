import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  Calendar,
  CheckSquare,
  Clock,
  Inbox,
  MailSearch,
  MailOpen,
  Mic,
  MicOff,
  RefreshCcw,
  Reply,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  MailboxActionProposal,
  MailboxCommitment,
  MailboxPriorityBand,
  MailboxSyncStatus,
  MailboxThreadDetail,
  MailboxThreadListItem,
  MailboxThreadMailboxView,
} from "../../shared/mailbox";
import { useVoiceInput } from "../hooks/useVoiceInput";

type QueueMode = "cleanup" | "follow_up" | null;
type ThreadSortOrder = "recent" | "priority";
const MAILBOX_AUTO_SYNC_MAX_AGE_MS = 15 * 60 * 1000;
const MAILBOX_CLASSIFICATION_WARNING_KEY = "mailboxClassificationWarningAcknowledged";
type FocusFilter = "unread" | "needsReply" | "queue" | "commitments" | null;
type ThreadMailboxView = MailboxThreadMailboxView;

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatTime(timestamp?: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / 86400000);
  if (diffDays === 0) {
    return date.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (diffDays < 7) {
    return date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleString(undefined, { month: "short", day: "numeric" });
}

function formatFullTime(timestamp?: number): string {
  if (!timestamp) return "n/a";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function priorityBadge(band: MailboxPriorityBand): { color: string; bg: string; label: string } {
  switch (band) {
    case "critical":
      return { color: "#fb7185", bg: "rgba(251,113,133,0.12)", label: "Critical" };
    case "high":
      return { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", label: "High" };
    case "medium":
      return { color: "var(--color-accent)", bg: "var(--color-accent-subtle)", label: "Medium" };
    default:
      return { color: "var(--color-text-muted)", bg: "var(--color-bg-secondary)", label: "Low" };
  }
}

function proposalActionLabel(proposal: MailboxActionProposal): string {
  switch (proposal.type) {
    case "cleanup": return "Apply cleanup";
    case "reply": return "Draft reply";
    case "schedule": return "Create event";
    case "follow_up": return "Open follow-up";
    default: return "Review";
  }
}

function previewStringList(preview: Record<string, unknown> | undefined, key: string): string[] {
  const value = preview?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function initials(name?: string, email?: string): string {
  if (name) {
    const parts = name.trim().split(" ");
    return parts.length >= 2
      ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
      : name.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return "??";
}

/** Strip RFC 2822 angle-bracket URLs and collapse long link text for readable display. */
function formatEmailBody(raw: string): string {
  return raw
    // Replace <https://...> with just the domain + ellipsis for readability
    .replace(/<(https?:\/\/[^>]+)>/g, (_match, url: string) => {
      try {
        const { hostname, pathname } = new URL(url);
        const short = pathname.length > 1 ? `${hostname}/\u2026` : hostname;
        return short;
      } catch {
        return url;
      }
    })
    // Collapse any remaining bare long URLs (no angle brackets)
    .replace(/(https?:\/\/\S{80,})/g, (url: string) => {
      try {
        const { hostname, pathname } = new URL(url);
        const short = pathname.length > 1 ? `${hostname}/\u2026` : hostname;
        return short;
      } catch {
        return url;
      }
    });
}

// ─── sub-components ───────────────────────────────────────────────────────────

/**
 * Sanitize email HTML to remove external resources that would trigger CSP
 * violations (external stylesheets, fonts, scripts, tracking pixels).
 * Images are converted to placeholder alt-text blocks.
 */
function sanitizeEmailHtml(raw: string): string {
  return raw
    // Remove <script> tags and content
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // Remove <link> tags (external stylesheets / fonts)
    .replace(/<link\b[^>]*>/gi, "")
    // Remove <meta http-equiv="Content-Security-Policy" ...> to avoid parse errors
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, "")
    // Replace <img> with a styled placeholder showing alt text (avoids CSP image blocks)
    .replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
      const altMatch = attrs.match(/alt\s*=\s*["']([^"']*?)["']/i);
      const alt = altMatch?.[1];
      if (!alt) return "";
      return `<span style="display:inline-block;color:#888;font-size:12px;">[${alt}]</span>`;
    })
    // Remove any remaining external resource references in <style> blocks (@import, url() pointing to http)
    .replace(/@import\s+url\([^)]*\)\s*;?/gi, "")
    .replace(/@import\s+['"][^'"]*['"]\s*;?/gi, "")
    // Neutralize <form> elements — remove action/method so they cannot submit to remote URLs
    .replace(/<form\b([^>]*)\>/gi, (_match, attrs: string) => {
      const sanitizedAttrs = attrs
        .replace(/\baction\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "")
        .replace(/\bmethod\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "");
      return `<form${sanitizedAttrs} action="javascript:void(0)" onsubmit="return false;">`;
    });
}

/**
 * Renders email HTML inside a sandboxed iframe that auto-sizes to its content.
 */
function EmailHtmlBody({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  const wrappedHtml = useMemo(() => {
    const clean = sanitizeEmailHtml(html);
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: 100%; max-width: 100%; overflow-x: hidden; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a2e; word-wrap: break-word; overflow-wrap: break-word; }
  #cowork-email-root { width: 100%; max-width: 100%; }
  img { max-width: 100%; height: auto; }
  a { color: #7c5cbf; }
  pre, code { white-space: pre-wrap; word-break: break-word; }
  /* Keep email layouts from widening the app pane. */
  table, div, td, th, center, [class] {
    max-width: 100% !important;
    min-width: 0 !important;
  }
  /* Stretch the outer email wrapper so every message uses the same center pane width. */
  #cowork-email-root > table,
  #cowork-email-root > div,
  #cowork-email-root > center,
  body > table,
  body > div,
  body > center {
    width: 100% !important;
    max-width: 100% !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
  td, th { word-break: break-word; }
</style>
</head><body><div id="cowork-email-root">${clean}</div></body></html>`;
  }, [html]);

  const handleLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument?.body) return;
    const contentHeight = iframe.contentDocument.body.scrollHeight;
    if (contentHeight > 0) {
      setHeight(contentHeight + 16);
    }
  }, []);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={wrappedHtml}
      onLoad={handleLoad}
      sandbox="allow-same-origin"
      style={{
        width: "100%",
        height,
        border: "none",
        display: "block",
        borderRadius: "var(--radius-sm, 6px)",
      }}
      title="Email content"
    />
  );
}

function Avatar({ name, email, size = 32 }: { name?: string; email?: string; size?: number }) {
  const letters = initials(name, email);
  const hue = ((name || email || "").split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `hsl(${hue}, 55%, 42%)`,
        display: "grid",
        placeItems: "center",
        fontSize: size * 0.34,
        fontWeight: 700,
        color: "#fff",
        flexShrink: 0,
        letterSpacing: "0.02em",
      }}
    >
      {letters}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "0.7rem",
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--color-text-muted)",
        marginBottom: "10px",
      }}
    >
      {children}
    </div>
  );
}

function ActionBtn({
  onClick,
  icon,
  label,
  variant = "default",
  disabled,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  const styles: Record<string, CSSProperties> = {
    default: {
      background: hovered ? "var(--color-bg-hover)" : "var(--color-bg-secondary)",
      border: "1px solid var(--color-border)",
      color: "var(--color-text-primary)",
    },
    primary: {
      background: hovered ? "var(--color-accent-hover, var(--color-accent))" : "var(--color-accent)",
      border: "1px solid var(--color-accent)",
      color: "#fff",
    },
    danger: {
      background: hovered ? "rgba(248,113,113,0.18)" : "rgba(248,113,113,0.1)",
      border: "1px solid rgba(248,113,113,0.25)",
      color: "#fb7185",
    },
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "8px 14px",
        borderRadius: "var(--radius-md, 10px)",
        fontSize: "0.82rem",
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "all 0.15s ease",
        whiteSpace: "nowrap",
        fontFamily: "var(--font-ui)",
        ...styles[variant],
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function IconBtn({
  onClick,
  icon,
  title,
  active,
  disabled,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  title?: string;
  active?: boolean;
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const interactive = !disabled;
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => {
        if (interactive) setHovered(true);
      }}
      onMouseLeave={() => {
        if (interactive) setHovered(false);
      }}
      style={{
        width: 32,
        height: 32,
        borderRadius: "var(--radius-sm, 8px)",
        display: "grid",
        placeItems: "center",
        border: active ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
        background: active
          ? "var(--color-accent-subtle)"
          : hovered && interactive
          ? "var(--color-bg-hover)"
          : "var(--color-bg-secondary)",
        color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "all 0.15s ease",
        flexShrink: 0,
      }}
    >
      {icon}
    </button>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export function InboxAgentPanel() {
  const [status, setStatus] = useState<MailboxSyncStatus | null>(null);
  const [threads, setThreads] = useState<MailboxThreadListItem[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<MailboxThreadDetail | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | "priority" | "calendar" | "follow_up" | "promotions" | "updates">("all");
  const [focusFilter, setFocusFilter] = useState<FocusFilter>(null);
  const [queueMode, setQueueMode] = useState<QueueMode>(null);
  const [queueProposals, setQueueProposals] = useState<MailboxActionProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageSortOrder, setMessageSortOrder] = useState<"newest" | "oldest">("newest");
  const [threadSortOrder, setThreadSortOrder] = useState<ThreadSortOrder>("recent");
  const [mailboxView, setMailboxView] = useState<ThreadMailboxView>("inbox");
  const [googleWorkspaceEnabled, setGoogleWorkspaceEnabled] = useState(false);
  const [classificationWarningAcknowledged, setClassificationWarningAcknowledged] = useState(() =>
    typeof window !== "undefined" &&
      window.localStorage.getItem(MAILBOX_CLASSIFICATION_WARNING_KEY) === "1",
  );

  const loadStatus = async () => {
    const next = await window.electronAPI.getMailboxSyncStatus();
    setStatus(next);
  };

  const loadThreads = async (opts?: {
    query?: string;
    category?: string;
    mailboxView?: ThreadMailboxView | undefined;
    focusFilter?: FocusFilter | undefined;
    sortBy?: ThreadSortOrder | undefined;
  }) => {
    const hasFocusFilter = opts && Object.prototype.hasOwnProperty.call(opts, "focusFilter");
    const nextFocus = hasFocusFilter ? opts?.focusFilter ?? null : focusFilter;
    const hasMailboxView = opts && Object.prototype.hasOwnProperty.call(opts, "mailboxView");
    const nextMailboxView = hasMailboxView ? opts?.mailboxView ?? mailboxView : mailboxView;
    const hasSortBy = opts && Object.prototype.hasOwnProperty.call(opts, "sortBy");
    const nextSort = hasSortBy ? opts?.sortBy ?? threadSortOrder : threadSortOrder;
    const list = await window.electronAPI.listMailboxThreads({
      query: opts?.query ?? query,
      category: (opts?.category as Any) ?? category,
      mailboxView: nextMailboxView,
      unreadOnly: nextFocus === "unread" ? true : undefined,
      needsReply: nextFocus === "needsReply" ? true : undefined,
      hasSuggestedProposal: nextFocus === "queue" ? true : undefined,
      hasOpenCommitment: nextFocus === "commitments" ? true : undefined,
      sortBy: nextSort,
      limit: 40,
    });
    setThreads(list);
    setSelectedThreadId((current) =>
      current && list.some((thread) => thread.id === current) ? current : (list[0]?.id || null),
    );
  };

  const loadThread = async (threadId: string) => {
    const detail = await window.electronAPI.getMailboxThread(threadId);
    setSelectedThread(detail);
  };

  const reloadAll = async (threadId?: string) => {
    await Promise.all([loadStatus(), loadThreads()]);
    const nextId = threadId || selectedThreadId;
    if (nextId) await loadThread(nextId);
  };

  useEffect(() => {
    void (async () => {
      setBusy(true);
      try {
        const googleSettings = await window.electronAPI.getGoogleWorkspaceSettings().catch(() => null);
        setGoogleWorkspaceEnabled(Boolean(googleSettings?.enabled));
        await loadStatus();
        const nextStatus = await window.electronAPI.getMailboxSyncStatus();
        setStatus(nextStatus);
        await loadThreads();
        const shouldAutoSync =
          nextStatus.connected &&
          !nextStatus.syncInFlight &&
          (!nextStatus.threadCount ||
            !nextStatus.lastSyncedAt ||
            Date.now() - nextStatus.lastSyncedAt > MAILBOX_AUTO_SYNC_MAX_AGE_MS);
        if (shouldAutoSync) {
          void syncMailboxWithProgress();
        }
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedThreadId) return;
    void loadThread(selectedThreadId);
  }, [selectedThreadId]);

  const voice = useVoiceInput({
    transcriptionMode: "local_preferred",
    onTranscript: (text) => {
      const lower = text.toLowerCase();
      if (lower.includes("archive") || lower.includes("cleanup")) {
        void reviewQueue("cleanup");
        return;
      }
      if (lower.includes("follow up") || lower.includes("follow-up")) {
        void reviewQueue("follow_up");
        return;
      }
      setQuery(text);
      void loadThreads({ query: text });
    },
    onError: (message) => setError(message),
  });

  const metrics = useMemo<Array<{ id: Exclude<FocusFilter, null>; label: string; value: number; accent: boolean }>>(
    () => [
      { id: "unread", label: "Unread", value: status?.unreadCount ?? 0, accent: true },
      { id: "needsReply", label: "Action Needed", value: status?.needsReplyCount ?? 0, accent: true },
      { id: "queue", label: "Suggested Actions", value: status?.proposalCount ?? 0, accent: false },
      { id: "commitments", label: "Open Commitments", value: status?.commitmentCount ?? 0, accent: false },
    ],
    [status],
  );

  const runAction = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const syncMailboxWithProgress = async () => {
    setBusy(true);
    setError(null);
    const timer = window.setInterval(() => {
      void loadStatus();
    }, 600);
    try {
      await window.electronAPI.syncMailbox(25);
      await Promise.all([loadStatus(), loadThreads()]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      window.clearInterval(timer);
      setBusy(false);
      await loadStatus();
    }
  };

  const reviewQueue = async (type: QueueMode) => {
    if (!type) return;
    await runAction(async () => {
      const result = await window.electronAPI.reviewMailboxBulkAction({ type, limit: 20 });
      setQueueMode(type);
      setQueueProposals(result.proposals);
      await loadStatus();
    });
  };

  const acknowledgeMailboxClassificationWarning = () => {
    window.localStorage.setItem(MAILBOX_CLASSIFICATION_WARNING_KEY, "1");
    setClassificationWarningAcknowledged(true);
  };

  const reclassifySelectedThread = async () => {
    if (!selectedThread) return;
    await runAction(async () => {
      await window.electronAPI.reclassifyMailboxThread(selectedThread.id);
      await reloadAll(selectedThread.id);
    });
  };

  const reclassifyMailboxBackfill = async () => {
    const accountId = status?.accounts[0]?.id;
    if (!accountId) return;
    await runAction(async () => {
      await window.electronAPI.reclassifyMailboxAccount({
        accountId,
        scope: "backfill",
        limit: 50,
      });
      await reloadAll();
    });
  };

  const handleApplyProposal = async (proposal: MailboxActionProposal) => {
    await runAction(async () => {
      if (proposal.type === "cleanup") {
        const suggested = String(proposal.preview?.suggestedAction || "archive");
        await window.electronAPI.applyMailboxAction({
          proposalId: proposal.id,
          threadId: proposal.threadId,
          type: suggested === "trash" ? "trash" : "archive",
        });
      } else if (proposal.type === "schedule") {
        await window.electronAPI.applyMailboxAction({
          proposalId: proposal.id,
          threadId: proposal.threadId,
          type: "schedule_event",
        });
      } else if (proposal.type === "reply" || proposal.type === "follow_up") {
        await window.electronAPI.generateMailboxDraft(proposal.threadId, {
          tone: "concise",
          includeAvailability: true,
        });
      }
      await reloadAll(proposal.threadId);
      if (queueMode) {
        const result = await window.electronAPI.reviewMailboxBulkAction({ type: queueMode, limit: 20 });
        setQueueProposals(result.proposals);
      }
    });
  };

  const handleCommitmentState = async (
    commitment: MailboxCommitment,
    state: MailboxCommitment["state"],
  ) => {
    await runAction(async () => {
      await window.electronAPI.updateMailboxCommitmentState(commitment.id, state);
      await reloadAll(commitment.threadId);
    });
  };

  const handleThreadAction = async (type: "archive" | "trash" | "mark_read") => {
    if (!selectedThread) return;
    await runAction(async () => {
      await window.electronAPI.applyMailboxAction({
        threadId: selectedThread.id,
        type,
      });
      await reloadAll(selectedThread.id);
    });
  };

  const runThreadWorkflow = async () => {
    if (!selectedThread) return;
    await runAction(async () => {
      await window.electronAPI.summarizeMailboxThread(selectedThread.id);
      await window.electronAPI.extractMailboxCommitments(selectedThread.id);
      if (selectedThread.needsReply) {
        await window.electronAPI.generateMailboxDraft(selectedThread.id, {
          tone: "concise",
          includeAvailability: true,
        });
      }
      if (selectedThread.category === "calendar") {
        await window.electronAPI.scheduleMailboxReply(selectedThread.id);
      }
      await window.electronAPI.researchMailboxContact(selectedThread.id);
      await reloadAll(selectedThread.id);
    });
  };

  const refreshThreadIntel = async () => {
    if (!selectedThread) return;
    await runAction(async () => {
      await window.electronAPI.summarizeMailboxThread(selectedThread.id);
      await window.electronAPI.reclassifyMailboxThread(selectedThread.id);
      await window.electronAPI.extractMailboxCommitments(selectedThread.id);
      await window.electronAPI.researchMailboxContact(selectedThread.id);
      await reloadAll(selectedThread.id);
      if (queueMode) {
        const result = await window.electronAPI.reviewMailboxBulkAction({ type: queueMode, limit: 20 });
        setQueueProposals(result.proposals);
      }
    });
  };

  const categories = [
    { id: "all", label: "All" },
    { id: "priority", label: "Priority" },
    { id: "calendar", label: "Calendar" },
    { id: "follow_up", label: "Follow-up" },
    { id: "promotions", label: "Promo" },
    { id: "updates", label: "Updates" },
  ] as const;

  const sortedThreadMessages = useMemo(() => {
    const messages = selectedThread?.messages || [];
    const compare = messageSortOrder === "newest"
      ? (a: MailboxThreadDetail["messages"][number], b: MailboxThreadDetail["messages"][number]) => b.receivedAt - a.receivedAt
      : (a: MailboxThreadDetail["messages"][number], b: MailboxThreadDetail["messages"][number]) => a.receivedAt - b.receivedAt;
    return [...messages].sort(compare);
  }, [selectedThread?.messages, messageSortOrder]);

  const displayedThreads = useMemo(() => {
    const compare =
      threadSortOrder === "recent"
        ? (a: MailboxThreadListItem, b: MailboxThreadListItem) => {
            if (b.lastMessageAt !== a.lastMessageAt) return b.lastMessageAt - a.lastMessageAt;
            if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
            return b.urgencyScore - a.urgencyScore;
          }
        : (a: MailboxThreadListItem, b: MailboxThreadListItem) => {
            if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
            if (b.urgencyScore !== a.urgencyScore) return b.urgencyScore - a.urgencyScore;
            return b.lastMessageAt - a.lastMessageAt;
          };
    return [...threads].sort(compare);
  }, [threads, threadSortOrder]);

  const receivedMessages = useMemo(
    () => sortedThreadMessages.filter((message) => message.direction === "incoming"),
    [sortedThreadMessages],
  );

  const renderMessageCard = (message: MailboxThreadDetail["messages"][number]) => {
    const isOutgoing = message.direction === "outgoing";
    const hasHtml = Boolean(message.bodyHtml);

    const messageHeader = (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginBottom: hasHtml ? "8px" : "5px",
        }}
      >
        {!isOutgoing && (
          <Avatar name={message.from?.name} email={message.from?.email} size={hasHtml ? 24 : 28} />
        )}
        <strong
          style={{
            fontSize: "0.78rem",
            color: isOutgoing ? "var(--color-accent)" : "var(--color-text-secondary)",
          }}
        >
          {isOutgoing ? "You" : message.from?.name || message.from?.email || "Unknown"}
        </strong>
        <span style={{ fontSize: "0.68rem", color: "var(--color-text-muted)", flexShrink: 0, marginLeft: "auto" }}>
          {formatTime(message.receivedAt)}
        </span>
      </div>
    );

    if (hasHtml) {
      return (
        <article key={message.id} style={{ marginBottom: "14px" }}>
          {messageHeader}
          <div
            style={{
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-lg, 14px)",
              overflow: "hidden",
              background: "#fff",
            }}
          >
            <EmailHtmlBody html={message.bodyHtml!} />
          </div>
        </article>
      );
    }

    return (
      <article
        key={message.id}
        style={{
          marginBottom: "10px",
          display: "flex",
          flexDirection: isOutgoing ? "row-reverse" : "row",
          gap: "8px",
          alignItems: "flex-start",
        }}
      >
        {!isOutgoing && <Avatar name={message.from?.name} email={message.from?.email} size={28} />}
        <div
          style={{
            maxWidth: "100%",
            width: "100%",
            padding: "10px 14px",
            borderRadius: isOutgoing
              ? "var(--radius-lg, 14px) var(--radius-sm, 8px) var(--radius-lg, 14px) var(--radius-lg, 14px)"
              : "var(--radius-sm, 8px) var(--radius-lg, 14px) var(--radius-lg, 14px) var(--radius-lg, 14px)",
            background: isOutgoing ? "var(--color-accent-subtle)" : "var(--color-bg-secondary)",
            border: `1px solid ${isOutgoing ? "var(--color-accent)" : "var(--color-border-subtle)"}`,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "12px",
              marginBottom: "5px",
            }}
          >
            <strong
              style={{
                fontSize: "0.78rem",
                color: isOutgoing ? "var(--color-accent)" : "var(--color-text-secondary)",
              }}
            >
              {isOutgoing ? "You" : message.from?.name || message.from?.email || "Unknown"}
            </strong>
            <span style={{ fontSize: "0.68rem", color: "var(--color-text-muted)", flexShrink: 0 }}>
              {formatTime(message.receivedAt)}
            </span>
          </div>
          <div
            style={{
              fontSize: "0.84rem",
              lineHeight: 1.6,
              color: "var(--color-text-primary)",
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word",
              wordBreak: "break-word",
            }}
          >
            {formatEmailBody(message.body || message.snippet)}
          </div>
        </div>
      </article>
    );
  };

  // ─── render ───────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "300px minmax(0, 1fr) 340px",
        gap: "12px",
        padding: "16px",
        paddingTop: "40px",
        height: "100%",
        minHeight: 0,
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      {/* ── LEFT: Thread List ──────────────────────────────────────────── */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl, 18px)",
          background: "var(--color-bg-elevated)",
          boxShadow: "var(--shadow-md)",
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          maxWidth: "100%",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 16px 12px",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "var(--radius-md, 10px)",
                  display: "grid",
                  placeItems: "center",
                  background: "var(--color-accent-subtle)",
                  color: "var(--color-accent)",
                  flexShrink: 0,
                }}
              >
                <Inbox size={17} />
              </div>
              <div>
                <div
                  style={{
                    fontSize: "0.92rem",
                    fontWeight: 700,
                    color: "var(--color-text-primary)",
                    lineHeight: 1.2,
                  }}
                >
                  Inbox Agent
                </div>
                <div style={{ fontSize: "0.73rem", color: "var(--color-text-muted)", marginTop: "2px" }}>
                  {status?.statusLabel || "Mailbox intelligence"}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              <IconBtn
                onClick={() => void syncMailboxWithProgress()}
                icon={<RefreshCcw size={13} style={busy ? { animation: "spin 1s linear infinite" } : {}} />}
                title="Sync mailbox"
              />
              <IconBtn
                onClick={() => void reclassifyMailboxBackfill()}
                icon={<Sparkles size={13} />}
                title="Reclassify backlog"
                disabled={busy || !status?.accounts[0]?.id}
              />
            </div>
          </div>

          {/* Metrics row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: "8px",
              marginBottom: "12px",
            }}
          >
            {metrics.map((metric) => {
              const active = focusFilter === metric.id;
              return (
                <button
                  type="button"
                  key={metric.label}
                  onClick={() => {
                    const nextFocus = focusFilter === metric.id ? null : metric.id;
                    setFocusFilter(nextFocus);
                    void loadThreads({ focusFilter: nextFocus });
                  }}
                  style={{
                    appearance: "none",
                    WebkitAppearance: "none",
                    padding: "10px 8px",
                    minHeight: 86,
                    borderRadius: "var(--radius-md, 12px)",
                    background: active ? "var(--color-accent-subtle)" : "var(--color-bg-secondary)",
                    border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border-subtle)"}`,
                    textAlign: "center" as const,
                    cursor: "pointer",
                    fontFamily: "var(--font-ui)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "6px",
                    width: "100%",
                    minWidth: 0,
                    boxSizing: "border-box",
                    boxShadow: active ? "0 0 0 1px var(--color-accent) inset" : "none",
                  }}
                  aria-pressed={active}
                >
                  <div
                    style={{
                      fontSize: "1.9rem",
                      fontWeight: 800,
                      color: active ? "var(--color-accent)" : "var(--color-text-primary)",
                      lineHeight: 1,
                      letterSpacing: "-0.03em",
                    }}
                  >
                    {metric.value}
                  </div>
                  <div
                    style={{
                      fontSize: "0.68rem",
                      color: active ? "var(--color-accent)" : "var(--color-text-muted)",
                      fontWeight: 700,
                      lineHeight: 1.15,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      whiteSpace: "normal",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {metric.label}
                  </div>
                </button>
              );
            })}
          </div>

          {status &&
            !classificationWarningAcknowledged &&
            (status.classificationPendingCount > 0 || !status.lastSyncedAt) && (
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "var(--radius-md, 10px)",
                  marginBottom: "12px",
                  background: "rgba(124, 92, 191, 0.08)",
                  border: "1px solid rgba(124, 92, 191, 0.28)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.8rem",
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: "4px" }}>
                  LLM classification is enabled for mailbox triage.
                </div>
                <div style={{ color: "var(--color-text-muted)", marginBottom: "10px" }}>
                  It will use the configured model, can consume API credits, and is currently
                  classifying {status.classificationPendingCount || 0} thread
                  {status.classificationPendingCount === 1 ? "" : "s"}.
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={acknowledgeMailboxClassificationWarning}
                    style={{
                      border: "1px solid var(--color-accent)",
                      background: "var(--color-accent-subtle)",
                      color: "var(--color-accent)",
                      borderRadius: "999px",
                      padding: "6px 10px",
                      cursor: "pointer",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                    }}
                  >
                    Dismiss
                  </button>
                  <span style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>
                    Configure cheaper models in Settings if needed.
                  </span>
                </div>
              </div>
            )}

          {/* Search */}
          <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
            <div style={{ position: "relative", flex: 1 }}>
              <MailSearch
                size={13}
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--color-text-muted)",
                  pointerEvents: "none",
                }}
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void loadThreads({ query: e.currentTarget.value });
                }}
                placeholder="Search threads…"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  paddingLeft: "28px",
                  paddingRight: "10px",
                  paddingTop: "7px",
                  paddingBottom: "7px",
                  borderRadius: "var(--radius-sm, 8px)",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.82rem",
                  outline: "none",
                  fontFamily: "var(--font-ui)",
                }}
              />
            </div>
            <IconBtn
              onClick={() => void voice.toggleRecording()}
              icon={voice.state === "recording" ? <MicOff size={13} /> : <Mic size={13} />}
              active={voice.state === "recording"}
              title={voice.state === "recording" ? "Stop recording" : "Voice search"}
            />
          </div>

          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginBottom: "8px" }}>
            {[
              { id: "inbox" as const, label: "Inbox" },
              { id: "sent" as const, label: "Sent" },
              { id: "all" as const, label: "All" },
            ].map((view) => {
              const active = mailboxView === view.id;
              return (
                <button
                  key={view.id}
                  type="button"
                  onClick={() => {
                    setMailboxView(view.id);
                    void loadThreads({ mailboxView: view.id });
                  }}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "20px",
                    fontSize: "0.74rem",
                    fontWeight: active ? 700 : 500,
                    border: active
                      ? "1px solid var(--color-accent)"
                      : "1px solid var(--color-border-subtle)",
                    background: active ? "var(--color-accent-subtle)" : "transparent",
                    color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                    cursor: "pointer",
                    transition: "all 0.12s ease",
                    fontFamily: "var(--font-ui)",
                  }}
                  aria-pressed={active}
                >
                  {view.label}
                </button>
              );
            })}
          </div>

          {/* Category filters */}
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {categories.map((cat) => {
              const active = category === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => {
                    setCategory(cat.id as Any);
                    void loadThreads({ category: cat.id });
                  }}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "20px",
                    fontSize: "0.74rem",
                    fontWeight: active ? 700 : 500,
                    border: active
                      ? "1px solid var(--color-accent)"
                      : "1px solid var(--color-border-subtle)",
                    background: active ? "var(--color-accent-subtle)" : "transparent",
                    color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                    cursor: "pointer",
                    transition: "all 0.12s ease",
                    fontFamily: "var(--font-ui)",
                  }}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              marginTop: "10px",
              marginBottom: "6px",
            }}
          >
            <div
              style={{
                fontSize: "0.65rem",
                fontWeight: 700,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: "var(--color-text-muted)",
              }}
            >
              Sort
            </div>
            <div style={{ display: "flex", gap: "4px" }}>
              {[
                { id: "recent" as const, label: "Recent" },
                { id: "priority" as const, label: "Priority" },
              ].map((sort) => {
                const active = threadSortOrder === sort.id;
                return (
                  <button
                    key={sort.id}
                    type="button"
                    onClick={() => {
                      setThreadSortOrder(sort.id);
                      void loadThreads({ sortBy: sort.id });
                    }}
                    style={{
                      padding: "4px 10px",
                      borderRadius: "20px",
                      fontSize: "0.74rem",
                      fontWeight: active ? 700 : 500,
                      border: active
                        ? "1px solid var(--color-accent)"
                        : "1px solid var(--color-border-subtle)",
                      background: active ? "var(--color-accent-subtle)" : "transparent",
                      color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                      cursor: "pointer",
                      transition: "all 0.12s ease",
                      fontFamily: "var(--font-ui)",
                    }}
                    aria-pressed={active}
                  >
                    {sort.label}
                  </button>
                );
              })}
            </div>
          </div>

          {status?.syncProgress?.label && (
            <div
              style={{
                marginTop: "8px",
                fontSize: "0.68rem",
                color:
                  status.syncProgress.phase === "error"
                    ? "#ef4444"
                    : "var(--color-text-muted)",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <Clock size={10} />
              {status.syncProgress.label}
            </div>
          )}

          {status?.lastSyncedAt && !status.syncInFlight && (
            <div
              style={{
                marginTop: "8px",
                fontSize: "0.68rem",
                color: "var(--color-text-muted)",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <Clock size={10} />
              Synced {formatFullTime(status.lastSyncedAt)}
            </div>
          )}
        </div>

        {/* Thread list */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px" }}>
          {threads.length === 0 && !busy && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
                padding: "40px 16px",
                color: "var(--color-text-muted)",
                textAlign: "center",
              }}
            >
              <Inbox size={32} strokeWidth={1.25} />
              <div style={{ fontSize: "0.82rem" }}>
                No threads yet.
                <br />
                Click the sync button to populate the inbox.
              </div>
            </div>
          )}
          {displayedThreads.map((thread) => {
            const selected = selectedThreadId === thread.id;
            const badge = priorityBadge(thread.priorityBand);
            const sender = thread.participants[0];
            return (
              <button
                key={thread.id}
                onClick={() => setSelectedThreadId(thread.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  marginBottom: "4px",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md, 10px)",
                  border: selected
                    ? "1px solid var(--color-accent)"
                    : "1px solid transparent",
                  background: selected
                    ? "var(--color-accent-subtle)"
                    : "transparent",
                  color: "var(--color-text-primary)",
                  cursor: "pointer",
                  transition: "all 0.12s ease",
                  display: "block",
                  fontFamily: "var(--font-ui)",
                }}
                onMouseEnter={(e) => {
                  if (!selected) {
                    (e.currentTarget as HTMLElement).style.background = "var(--color-bg-hover)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!selected) {
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                  }
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                  <Avatar name={sender?.name} email={sender?.email} size={28} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "6px",
                        marginBottom: "2px",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.8rem",
                          fontWeight: thread.unreadCount > 0 ? 700 : 500,
                          color: "var(--color-text-secondary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {sender?.name || sender?.email || "Unknown"}
                      </span>
                      <span
                        style={{
                          fontSize: "0.68rem",
                          color: "var(--color-text-muted)",
                          flexShrink: 0,
                        }}
                      >
                        {formatTime(thread.lastMessageAt)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: "0.82rem",
                        fontWeight: thread.unreadCount > 0 ? 700 : 500,
                        color: "var(--color-text-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        marginBottom: "3px",
                      }}
                    >
                      {thread.subject}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "6px",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.74rem",
                          color: "var(--color-text-muted)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                      >
                        {thread.snippet}
                      </span>
                      {thread.priorityBand !== "low" && (
                        <span
                          style={{
                            fontSize: "0.64rem",
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: "8px",
                            background: badge.bg,
                            color: badge.color,
                            flexShrink: 0,
                          }}
                        >
                          {badge.label}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── MIDDLE: Thread Detail ──────────────────────────────────────── */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl, 18px)",
          background: "var(--color-bg-elevated)",
          boxShadow: "var(--shadow-md)",
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          maxWidth: "100%",
          overflow: "hidden",
        }}
      >
        {/* Thread header */}
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--color-border-subtle)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          {selectedThread ? (
            <>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: "0.95rem",
                    fontWeight: 700,
                    color: "var(--color-text-primary)",
                    marginBottom: "4px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {selectedThread.subject}
                </div>
                <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)" }}>
                  {selectedThread.participants
                    .map((p) => p.name || p.email)
                    .join(", ")}
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                <IconBtn
                  onClick={() =>
                    setMessageSortOrder((current) => (current === "newest" ? "oldest" : "newest"))
                  }
                  icon={<Clock size={13} />}
                  title={messageSortOrder === "newest" ? "Newest first" : "Oldest first"}
                  active={messageSortOrder === "newest"}
                />
                <IconBtn
                  onClick={() =>
                    runAction(async () => {
                      await window.electronAPI.summarizeMailboxThread(selectedThread.id);
                      await loadThread(selectedThread.id);
                    })
                  }
                  icon={<Sparkles size={13} />}
                  title="Generate AI summary"
                />
                <IconBtn
                  onClick={() => void reclassifySelectedThread()}
                  icon={<RefreshCcw size={13} />}
                  title="Reclassify thread"
                  disabled={busy}
                />
                <IconBtn
                  onClick={() =>
                    runAction(async () => {
                      await window.electronAPI.generateMailboxDraft(selectedThread.id, {
                        tone: "concise",
                        includeAvailability: true,
                      });
                      await loadThread(selectedThread.id);
                    })
                  }
                  icon={<Reply size={13} />}
                  title="Draft reply"
                />
              </div>
            </>
          ) : (
            <div style={{ color: "var(--color-text-muted)", fontSize: "0.9rem" }}>
              Select a thread
            </div>
          )}
        </div>

        {/* Thread body */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "16px" }}>
          {!selectedThread && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                gap: "12px",
                color: "var(--color-text-muted)",
                textAlign: "center",
              }}
            >
              <MailSearch size={40} strokeWidth={1.2} />
              <div style={{ fontSize: "0.85rem", lineHeight: 1.5 }}>
                Choose a thread to inspect
                <br />
                summaries, drafts, and commitments.
              </div>
            </div>
          )}

          {/* AI summary card */}
          {selectedThread?.summary && (
            <div
              style={{
                padding: "14px 16px",
                borderRadius: "var(--radius-lg, 14px)",
                background: "var(--color-accent-subtle)",
                border: "1px solid var(--color-accent)",
                marginBottom: "14px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  marginBottom: "8px",
                  color: "var(--color-accent)",
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                <Sparkles size={11} />
                AI Summary
              </div>
              <div
                style={{
                  color: "var(--color-text-primary)",
                  lineHeight: 1.6,
                  fontSize: "0.86rem",
                }}
              >
                {selectedThread.summary.summary}
              </div>
              {!!selectedThread.summary.keyAsks.length && (
                <div
                  style={{
                    marginTop: "10px",
                    fontSize: "0.8rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  <strong>Key asks:</strong>{" "}
                  {selectedThread.summary.keyAsks.join(" · ")}
                </div>
              )}
            </div>
          )}

          {/* Draft preview */}
          {selectedThread?.drafts[0] && (
            <div
              style={{
                padding: "14px 16px",
                borderRadius: "var(--radius-lg, 14px)",
                background: "rgba(251,191,36,0.06)",
                border: "1px solid rgba(251,191,36,0.22)",
                marginBottom: "14px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: "10px",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "0.72rem",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "#d97706",
                      marginBottom: "2px",
                    }}
                  >
                    Draft ready
                  </div>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "0.86rem",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {selectedThread.drafts[0].subject}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                  <ActionBtn
                    onClick={() =>
                      runAction(async () => {
                        await window.electronAPI.applyMailboxAction({
                          threadId: selectedThread.id,
                          draftId: selectedThread.drafts[0].id,
                          type: "discard_draft",
                        });
                        await reloadAll(selectedThread.id);
                      })
                    }
                    icon={<Trash2 size={13} />}
                    label="Discard"
                    variant="danger"
                  />
                  <ActionBtn
                    onClick={() =>
                      runAction(async () => {
                        await window.electronAPI.applyMailboxAction({
                          threadId: selectedThread.id,
                          draftId: selectedThread.drafts[0].id,
                          type: "send_draft",
                        });
                        await reloadAll(selectedThread.id);
                      })
                    }
                    icon={<Reply size={13} />}
                    label="Send"
                    variant="primary"
                  />
                </div>
              </div>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "break-word",
                  wordBreak: "break-word",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.8rem",
                  lineHeight: 1.6,
                  color: "var(--color-text-secondary)",
                  background: "rgba(0,0,0,0.04)",
                  borderRadius: "var(--radius-sm, 8px)",
                  padding: "10px 12px",
                }}
              >
                {selectedThread.drafts[0].body}
              </pre>
            </div>
          )}

          {/* Messages */}
          {selectedThread?.messages.length ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
                gap: "12px",
              }}
            >
              <div
                style={{
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: "var(--radius-lg, 14px)",
                  background: "var(--color-bg-secondary)",
                  padding: "12px",
                  minWidth: 0,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                  <SectionLabel>Received Emails</SectionLabel>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      padding: "2px 8px",
                      borderRadius: "10px",
                      background: "var(--color-bg-elevated)",
                      color: "var(--color-text-muted)",
                      border: "1px solid var(--color-border-subtle)",
                    }}
                  >
                    {receivedMessages.length}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {receivedMessages.length ? (
                    receivedMessages.map((message) => renderMessageCard(message))
                  ) : (
                    <div
                      style={{
                        padding: "14px",
                        textAlign: "center",
                        color: "var(--color-text-muted)",
                        fontSize: "0.82rem",
                        borderRadius: "var(--radius-md, 10px)",
                        background: "var(--color-bg-elevated)",
                        border: "1px solid var(--color-border-subtle)",
                      }}
                    >
                      No received emails
                    </div>
                  )}
                </div>
              </div>

            </div>
          ) : (
            <div
              style={{
                padding: "16px",
                textAlign: "center",
                color: "var(--color-text-muted)",
                fontSize: "0.82rem",
                borderRadius: "var(--radius-md, 10px)",
                background: "var(--color-bg-secondary)",
                border: "1px solid var(--color-border-subtle)",
              }}
            >
              No messages in this thread
            </div>
          )}
        </div>
      </section>

      {/* ── RIGHT: Agent Rail ──────────────────────────────────────────── */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-xl, 18px)",
          background: "var(--color-bg-elevated)",
          boxShadow: "var(--shadow-md)",
          minHeight: 0,
          minWidth: 0,
          width: "100%",
          maxWidth: "100%",
          overflow: "hidden",
        }}
      >
        {/* Agent Rail header */}
        <div
          style={{
            padding: "14px 16px 12px",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <div style={{ marginBottom: "12px" }}>
            <div
              style={{
                fontSize: "0.92rem",
                fontWeight: 700,
                color: "var(--color-text-primary)",
                marginBottom: "2px",
              }}
            >
              Agent Rail
            </div>
            <div style={{ fontSize: "0.74rem", color: "var(--color-text-muted)" }}>
              Drafts, approvals, commitments &amp; queues
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
            <ActionBtn
              onClick={() => void reviewQueue("cleanup")}
              icon={<Trash2 size={13} />}
              label="Cleanup"
              disabled={busy}
            />
            <ActionBtn
              onClick={() => void reviewQueue("follow_up")}
              icon={<Reply size={13} />}
              label="Follow-up"
              disabled={busy}
            />
            <ActionBtn
              onClick={() => void runThreadWorkflow()}
              icon={<Sparkles size={13} />}
              label="Prep thread"
              disabled={busy || !selectedThread}
            />
            <ActionBtn
              onClick={() =>
                selectedThread &&
                void runAction(async () => {
                  await window.electronAPI.extractMailboxCommitments(selectedThread.id);
                  await reloadAll(selectedThread.id);
                })
              }
              icon={<CheckSquare size={13} />}
              label="Extract todos"
              disabled={busy || !selectedThread}
            />
            <ActionBtn
              onClick={() =>
                selectedThread &&
                void runAction(async () => {
                  await window.electronAPI.applyMailboxAction({
                    threadId: selectedThread.id,
                    type: "schedule_event",
                  });
                  await reloadAll(selectedThread.id);
                })
              }
              icon={<Calendar size={13} />}
              label="Schedule"
              disabled={busy || !selectedThread || !googleWorkspaceEnabled}
            />
            <ActionBtn
              onClick={() => void refreshThreadIntel()}
              icon={<RefreshCcw size={13} />}
              label="Refresh intel"
              disabled={busy || !selectedThread}
            />
          </div>
        </div>

        {/* Rail content */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 14px 18px" }}>
          {/* Error */}
          {error && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "10px",
                padding: "12px 14px",
                borderRadius: "var(--radius-md, 10px)",
                background: "var(--color-error-subtle)",
                border: "1px solid rgba(248,113,113,0.3)",
                marginBottom: "14px",
              }}
            >
              <AlertCircle size={15} style={{ color: "var(--color-error)", flexShrink: 0, marginTop: "1px" }} />
              <div style={{ flex: 1, fontSize: "0.8rem", color: "var(--color-text-primary)", lineHeight: 1.5 }}>
                {error}
              </div>
              <button
                onClick={() => setError(null)}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-text-muted)",
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* Busy indicator */}
          {busy && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "10px 14px",
                borderRadius: "var(--radius-md, 10px)",
                background: "var(--color-bg-secondary)",
                border: "1px solid var(--color-border-subtle)",
                marginBottom: "14px",
                fontSize: "0.8rem",
                color: "var(--color-text-muted)",
              }}
            >
              <RefreshCcw size={13} style={{ animation: "spin 1s linear infinite", color: "var(--color-accent)" }} />
              Working…
            </div>
          )}

          {selectedThread && (
            <div style={{ marginBottom: "16px" }}>
              <SectionLabel>Quick Actions</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                <ActionBtn
                  onClick={() => void handleThreadAction("mark_read")}
                  icon={<MailOpen size={13} />}
                  label="Mark read"
                  disabled={busy || selectedThread.unreadCount === 0}
                />
                <ActionBtn
                  onClick={() => void handleThreadAction("archive")}
                  icon={<Archive size={13} />}
                  label="Archive"
                  disabled={busy || selectedThread.provider !== "gmail"}
                />
                <ActionBtn
                  onClick={() => void handleThreadAction("trash")}
                  icon={<Trash2 size={13} />}
                  label="Trash"
                  variant="danger"
                  disabled={busy || selectedThread.provider !== "gmail"}
                />
              </div>
            </div>
          )}

          {/* Queue proposals */}
          {queueMode && (
            <div style={{ marginBottom: "18px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "10px",
                }}
              >
                <SectionLabel>
                  {queueMode === "cleanup" ? "Cleanup Suggestions" : "Follow-up Suggestions"}
                </SectionLabel>
                <span
                  style={{
                    fontSize: "0.7rem",
                    padding: "2px 8px",
                    borderRadius: "10px",
                    background: "var(--color-bg-secondary)",
                    color: "var(--color-text-muted)",
                    border: "1px solid var(--color-border-subtle)",
                  }}
                >
                  {queueProposals.length}
                </span>
              </div>
              {queueProposals.map((proposal) => (
                <div
                  key={proposal.id}
                  style={{
                    padding: "12px 14px",
                    borderRadius: "var(--radius-md, 10px)",
                    border: "1px solid var(--color-border-subtle)",
                    background: "var(--color-bg-secondary)",
                    marginBottom: "8px",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "0.84rem",
                      color: "var(--color-text-primary)",
                      marginBottom: "4px",
                    }}
                  >
                    {proposal.title}
                  </div>
                  <div
                    style={{
                      fontSize: "0.78rem",
                      color: "var(--color-text-muted)",
                      lineHeight: 1.5,
                      marginBottom: "10px",
                    }}
                  >
                    {proposal.reasoning}
                  </div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <ActionBtn
                      onClick={() => void handleApplyProposal(proposal)}
                      icon={<CheckSquare size={12} />}
                      label={proposalActionLabel(proposal)}
                      variant="primary"
                      disabled={busy}
                    />
                    <ActionBtn
                      onClick={() =>
                        void runAction(async () => {
                          await window.electronAPI.applyMailboxAction({
                            proposalId: proposal.id,
                            threadId: proposal.threadId,
                            type: "dismiss_proposal",
                          });
                          if (queueMode) {
                            const result = await window.electronAPI.reviewMailboxBulkAction({
                              type: queueMode,
                              limit: 20,
                            });
                            setQueueProposals(result.proposals);
                          }
                          await loadStatus();
                        })
                      }
                      icon={<X size={12} />}
                      label="Dismiss"
                      disabled={busy}
                    />
                  </div>
                </div>
              ))}
              {queueProposals.length === 0 && (
                <div
                  style={{
                    padding: "16px",
                    textAlign: "center",
                    color: "var(--color-text-muted)",
                    fontSize: "0.82rem",
                    borderRadius: "var(--radius-md, 10px)",
                    background: "var(--color-bg-secondary)",
                    border: "1px solid var(--color-border-subtle)",
                  }}
                >
                  No suggested actions
                </div>
              )}
            </div>
          )}

          {/* Selected thread proposals */}
          {!!selectedThread?.proposals.filter((proposal) => proposal.status === "suggested").length && (
            <div style={{ marginBottom: "16px" }}>
              <SectionLabel>Suggestions</SectionLabel>
              {selectedThread.proposals
                .filter((proposal) => proposal.status === "suggested")
                .map((proposal) => {
                  const suggestedAction = String(proposal.preview?.suggestedAction || "");
                  const scheduleSuggestions = previewStringList(proposal.preview, "suggestions");
                  const draftSubject = typeof proposal.preview?.subject === "string"
                    ? proposal.preview.subject
                    : null;
                  return (
                    <div
                      key={proposal.id}
                      style={{
                        padding: "12px 14px",
                        borderRadius: "var(--radius-md, 10px)",
                        border: "1px solid var(--color-border-subtle)",
                        background: "var(--color-bg-secondary)",
                        marginBottom: "8px",
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: "0.84rem",
                          color: "var(--color-text-primary)",
                          marginBottom: "4px",
                        }}
                      >
                        {proposal.title}
                      </div>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          color: "var(--color-text-muted)",
                          lineHeight: 1.5,
                        }}
                      >
                        {proposal.reasoning}
                      </div>
                      {draftSubject && (
                        <div
                          style={{
                            marginTop: "8px",
                            fontSize: "0.76rem",
                            color: "var(--color-text-secondary)",
                          }}
                        >
                          Draft: {draftSubject}
                        </div>
                      )}
                      {suggestedAction && (
                        <div
                          style={{
                            marginTop: "8px",
                            fontSize: "0.76rem",
                            color: "var(--color-text-secondary)",
                          }}
                        >
                          Suggested action: {suggestedAction}
                        </div>
                      )}
                      {!!scheduleSuggestions.length && (
                        <div
                          style={{
                            marginTop: "8px",
                            fontSize: "0.76rem",
                            color: "var(--color-text-secondary)",
                            lineHeight: 1.5,
                          }}
                        >
                          {scheduleSuggestions.join(" · ")}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: "6px", marginTop: "10px" }}>
                        <ActionBtn
                          onClick={() => void handleApplyProposal(proposal)}
                          icon={<CheckSquare size={12} />}
                          label={proposalActionLabel(proposal)}
                          variant="primary"
                          disabled={busy}
                        />
                        <ActionBtn
                          onClick={() =>
                            void runAction(async () => {
                              await window.electronAPI.applyMailboxAction({
                                proposalId: proposal.id,
                                threadId: proposal.threadId,
                                type: "dismiss_proposal",
                              });
                              await reloadAll(selectedThread.id);
                            })
                          }
                          icon={<X size={12} />}
                          label="Dismiss"
                          disabled={busy}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

          {/* Contact memory */}
          {selectedThread?.contactMemory && (
            <div style={{ marginBottom: "16px" }}>
              <SectionLabel>Contact</SectionLabel>
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "var(--radius-md, 10px)",
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-secondary)",
                  display: "flex",
                  gap: "10px",
                  alignItems: "flex-start",
                }}
              >
                <Avatar
                  name={selectedThread.contactMemory.name}
                  email={selectedThread.contactMemory.email}
                  size={32}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "0.84rem",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {selectedThread.contactMemory.name || selectedThread.contactMemory.email}
                  </div>
                  <div style={{ fontSize: "0.76rem", color: "var(--color-text-muted)", marginTop: "2px" }}>
                    {selectedThread.contactMemory.company || "Independent contact"}
                  </div>
                  {selectedThread.contactMemory.responseTendency && (
                    <div
                      style={{
                        marginTop: "6px",
                        fontSize: "0.76rem",
                        color: "var(--color-text-secondary)",
                        lineHeight: 1.5,
                      }}
                    >
                      {selectedThread.contactMemory.responseTendency}
                    </div>
                  )}
                  {!!selectedThread.contactMemory.learnedFacts.length && (
                    <div
                      style={{
                        marginTop: "6px",
                        fontSize: "0.76rem",
                        color: "var(--color-text-secondary)",
                        lineHeight: 1.5,
                      }}
                    >
                      {selectedThread.contactMemory.learnedFacts.join(" · ")}
                    </div>
                  )}
                  {!!selectedThread.contactMemory.styleSignals?.length && (
                    <div
                      style={{
                        marginTop: "8px",
                        fontSize: "0.74rem",
                        color: "var(--color-text-muted)",
                        lineHeight: 1.5,
                      }}
                    >
                      {selectedThread.contactMemory.styleSignals.join(" · ")}
                    </div>
                  )}
                  {[
                    selectedThread.contactMemory.totalThreads
                      ? `${selectedThread.contactMemory.totalThreads} thread${selectedThread.contactMemory.totalThreads === 1 ? "" : "s"}`
                      : null,
                    selectedThread.contactMemory.totalMessages
                      ? `${selectedThread.contactMemory.totalMessages} messages`
                      : null,
                    typeof selectedThread.contactMemory.averageResponseHours === "number"
                      ? `${selectedThread.contactMemory.averageResponseHours.toFixed(1)}h avg response`
                      : null,
                  ].filter((entry): entry is string => Boolean(entry)).length > 0 && (
                    <div
                      style={{
                        marginTop: "8px",
                        fontSize: "0.72rem",
                        color: "var(--color-text-muted)",
                        lineHeight: 1.5,
                      }}
                    >
                      {[
                        selectedThread.contactMemory.totalThreads
                          ? `${selectedThread.contactMemory.totalThreads} thread${selectedThread.contactMemory.totalThreads === 1 ? "" : "s"}`
                          : null,
                        selectedThread.contactMemory.totalMessages
                          ? `${selectedThread.contactMemory.totalMessages} messages`
                          : null,
                        typeof selectedThread.contactMemory.averageResponseHours === "number"
                          ? `${selectedThread.contactMemory.averageResponseHours.toFixed(1)}h avg response`
                          : null,
                      ]
                        .filter((entry): entry is string => Boolean(entry))
                        .join(" · ")}
                    </div>
                  )}
                  {!!selectedThread.contactMemory.recentSubjects?.length && (
                    <div
                      style={{
                        marginTop: "8px",
                        fontSize: "0.72rem",
                        color: "var(--color-text-muted)",
                        lineHeight: 1.5,
                      }}
                    >
                      Recent: {selectedThread.contactMemory.recentSubjects.join(" · ")}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Commitments */}
          {!!selectedThread?.commitments.length && (
            <div style={{ marginBottom: "16px" }}>
              <SectionLabel>Open Commitments</SectionLabel>
              {selectedThread.commitments.map((commitment) => (
                <div
                  key={commitment.id}
                  style={{
                    padding: "12px 14px",
                    borderRadius: "var(--radius-md, 10px)",
                    border: "1px solid var(--color-border-subtle)",
                    background: "var(--color-bg-secondary)",
                    marginBottom: "8px",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "0.84rem",
                      color: "var(--color-text-primary)",
                      marginBottom: "4px",
                    }}
                  >
                    {commitment.title}
                  </div>
                  <div
                    style={{
                      fontSize: "0.74rem",
                      color: "var(--color-text-muted)",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      marginBottom: "10px",
                    }}
                  >
                    <Clock size={10} />
                    {commitment.dueAt
                      ? `Due ${formatFullTime(commitment.dueAt)}`
                      : "No due date"}
                    <span
                      style={{
                        padding: "1px 6px",
                        borderRadius: "6px",
                        background: "var(--color-bg-tertiary)",
                        color: "var(--color-text-muted)",
                        fontSize: "0.68rem",
                        fontWeight: 600,
                      }}
                    >
                      {commitment.state}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                    <ActionBtn
                      onClick={() => void handleCommitmentState(commitment, "accepted")}
                      icon={<CheckSquare size={11} />}
                      label={
                        commitment.state === "accepted"
                          ? commitment.followUpTaskId
                            ? "Accepted"
                            : "Create follow-up"
                          : "Accept"
                      }
                      variant={commitment.state === "accepted" && commitment.followUpTaskId ? "default" : "primary"}
                      disabled={busy || (commitment.state === "accepted" && Boolean(commitment.followUpTaskId))}
                    />
                    <ActionBtn
                      onClick={() => void handleCommitmentState(commitment, "done")}
                      icon={<CheckSquare size={11} />}
                      label="Done"
                      disabled={busy}
                    />
                    <ActionBtn
                      onClick={() => void handleCommitmentState(commitment, "dismissed")}
                      icon={<X size={11} />}
                      label="Dismiss"
                      variant="danger"
                      disabled={busy}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Research */}
          {selectedThread?.research && (
            <div>
              <SectionLabel>Research</SectionLabel>
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "var(--radius-md, 10px)",
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-secondary)",
                  fontSize: "0.82rem",
                  lineHeight: 1.6,
                  color: "var(--color-text-secondary)",
                }}
              >
                <div style={{ display: "flex", gap: "6px", marginBottom: "4px" }}>
                  <User size={13} style={{ flexShrink: 0, marginTop: "2px", color: "var(--color-text-muted)" }} />
                  <span>{selectedThread.research.primaryContact?.email || "Unknown contact"}</span>
                </div>
                {selectedThread.research.company && (
                  <div style={{ color: "var(--color-text-muted)", paddingLeft: "19px", marginBottom: "6px" }}>
                    {selectedThread.research.company}
                  </div>
                )}
                {selectedThread.research.relationshipSummary && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      fontSize: "0.76rem",
                      color: "var(--color-text-secondary)",
                      marginBottom: "6px",
                    }}
                  >
                    {selectedThread.research.relationshipSummary}
                  </div>
                )}
                {!!selectedThread.research.recommendedQueries.length && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      fontSize: "0.76rem",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    {selectedThread.research.recommendedQueries.join(" · ")}
                  </div>
                )}
                {!!selectedThread.research.styleSignals?.length && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      marginTop: "8px",
                      fontSize: "0.76rem",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    Style: {selectedThread.research.styleSignals.join(" · ")}
                  </div>
                )}
                {!!selectedThread.research.recentSubjects?.length && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      marginTop: "8px",
                      fontSize: "0.76rem",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    Recent threads: {selectedThread.research.recentSubjects.join(" · ")}
                  </div>
                )}
                {selectedThread.research.recentOutboundExample && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      marginTop: "8px",
                      fontSize: "0.76rem",
                      color: "var(--color-text-muted)",
                      lineHeight: 1.5,
                    }}
                  >
                    Last outbound: {selectedThread.research.recentOutboundExample}
                  </div>
                )}
                {!!selectedThread.research.nextSteps?.length && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      marginTop: "10px",
                      fontSize: "0.76rem",
                      color: "var(--color-text-secondary)",
                      lineHeight: 1.5,
                    }}
                  >
                    Next: {selectedThread.research.nextSteps.join(" · ")}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Empty rail state */}
          {!queueMode &&
            !selectedThread?.commitments.length &&
            !selectedThread?.contactMemory &&
            !selectedThread?.research &&
            !error &&
            !busy && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: "10px",
                  padding: "32px 16px",
                  color: "var(--color-text-muted)",
                  textAlign: "center",
                }}
              >
                <Sparkles size={30} strokeWidth={1.25} />
                <div style={{ fontSize: "0.8rem", lineHeight: 1.5 }}>
                  Select a thread and use the
                  <br />
                  actions above to analyse it.
                </div>
              </div>
            )}
        </div>
      </section>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  Calendar,
  CheckSquare,
  ChevronDown,
  Clock,
  Inbox,
  MailSearch,
  MailOpen,
  Mic,
  MicOff,
  RefreshCcw,
  Reply,
  Send,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  MailboxActionProposal,
  MailboxAutomationRecord,
  MailboxCommitment,
  MailboxCompanyCandidate,
  MailboxDigestSnapshot,
  MailboxConditionOperator,
  MailboxMissionControlHandoffPreview,
  MailboxMissionControlHandoffRecord,
  MailboxPriorityBand,
  MailboxSavedViewRecord,
  MailboxSnippetRecord,
  MailboxSyncStatus,
  MailboxThreadDetail,
  MailboxThreadListItem,
  MailboxThreadMailboxView,
  getMailboxNoReplySender,
  stripMailboxSummaryHtmlArtifacts,
} from "../../shared/mailbox";
import type { AgentRoleData } from "../../electron/preload";
import type { Company } from "../../shared/types";
import { GOOGLE_SCOPE_GMAIL_MODIFY, hasScope } from "../../shared/google-workspace";
import { useVoiceInput } from "../hooks/useVoiceInput";

type QueueMode = "cleanup" | "follow_up" | null;
type ThreadSortOrder = "recent" | "priority";
const MAILBOX_AUTO_SYNC_MAX_AGE_MS = 15 * 60 * 1000;
const MAILBOX_CLASSIFICATION_WARNING_KEY = "mailboxClassificationWarningAcknowledged";
const MAILBOX_SERVER_ACTION_WARNING_KEY = "mailboxServerActionWarningAcknowledged";
const ALL_MAILBOX_ACCOUNTS_FILTER = "__all__";
type FocusFilter = "unread" | "needsReply" | "queue" | "commitments" | null;
type ThreadMailboxView = MailboxThreadMailboxView;
type ThreadGroup = {
  id: string;
  label: string;
  description: string;
  threads: MailboxThreadListItem[];
};

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

function formatDateTimeLocalValue(timestamp?: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

function formatChannelLabel(channelType: string): string {
  if (channelType === "whatsapp") return "WhatsApp";
  if (channelType === "imessage") return "iMessage";
  if (channelType === "signal") return "Signal";
  if (channelType === "feishu") return "Feishu / Lark";
  if (channelType === "wecom") return "WeCom";
  return channelType.charAt(0).toUpperCase() + channelType.slice(1);
}

function formatMailboxAccountLabel(account: MailboxSyncStatus["accounts"][number]): string {
  return account.displayName || account.address || account.id;
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
    // Keep <img> so HTTPS previews load (renderer CSP allows img-src https:). Strip event handlers.
    .replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
      const clean = attrs.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "");
      return `<img${clean}>`;
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
  /* Prevent newsletter CSS (height:100%, min-height:100vh) from stretching the document to the iframe height — that inflates scrollHeight and leaves a huge blank band under the message. */
  html, body { margin: 0; padding: 0; width: 100%; max-width: 100%; overflow-x: hidden; height: auto !important; min-height: 0 !important; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a2e; word-wrap: break-word; overflow-wrap: break-word; }
  #cowork-email-viewport { width: 100%; max-width: 100%; overflow: hidden; }
  #cowork-email-root { display: block; width: 100%; max-width: 100%; transform-origin: top left; }
  /* Shrink wide images without collapsing table column widths (min-width:0 on td broke marketing layouts). */
  img { max-width: 100% !important; height: auto !important; }
  a { color: #7c5cbf; }
  pre, code { white-space: pre-wrap; overflow-wrap: break-word; }
</style>
</head><body><div id="cowork-email-viewport"><div id="cowork-email-root">${clean}</div></div></body></html>`;
  }, [html]);

  const updateIframeLayout = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const root = doc?.getElementById("cowork-email-root") as HTMLDivElement | null;
    if (!iframe || !doc?.body || !root) return;

    const docEl = doc.documentElement;
    root.style.transform = "none";
    root.style.width = "auto";
    root.style.maxWidth = "none";

    const availableWidth = iframe.clientWidth;
    const contentWidth = Math.max(root.scrollWidth, doc.body.scrollWidth, docEl.scrollWidth);

    let scale = 1;
    if (availableWidth > 0 && contentWidth > availableWidth) {
      scale = availableWidth / contentWidth;
    }

    if (scale < 0.999) {
      root.style.width = `${contentWidth}px`;
      root.style.maxWidth = "none";
      root.style.transform = `scale(${scale})`;
    } else {
      root.style.width = "100%";
      root.style.maxWidth = "100%";
      root.style.transform = "none";
    }

    // scrollHeight on html/body is often wrong here (100%/100vh email CSS, transform doesn't shrink layout size). Use the root's painted box — includes scale().
    void root.offsetHeight;
    const visualHeight = root.getBoundingClientRect().height;
    if (visualHeight > 0) {
      setHeight(Math.ceil(visualHeight) + 16);
    }
  }, []);

  const handleLoad = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        updateIframeLayout();
      });
    });
  }, [updateIframeLayout]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let rafId = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        updateIframeLayout();
      });
    };

    scheduleUpdate();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        scheduleUpdate();
      });
      observer.observe(iframe);
      return () => {
        observer.disconnect();
        cancelAnimationFrame(rafId);
      };
    }

    window.addEventListener("resize", scheduleUpdate);
    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      cancelAnimationFrame(rafId);
    };
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
  title,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  title?: string;
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
      title={title}
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
  const buttonStyle: CSSProperties = {
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
    ...(disabled && title ? { pointerEvents: "none" as const } : {}),
  };

  const button = (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? undefined : title}
      aria-label={title}
      onMouseEnter={() => {
        if (interactive) setHovered(true);
      }}
      onMouseLeave={() => {
        if (interactive) setHovered(false);
      }}
      style={buttonStyle}
    >
      {icon}
    </button>
  );

  if (disabled && title) {
    return (
      <span
        title={title}
        style={{ display: "inline-flex", lineHeight: 0, cursor: "not-allowed" }}
      >
        {button}
      </span>
    );
  }

  return button;
}

export type InboxAgentPanelProps = {
  /** Open Mission Control focused on a company issue (e.g. from an inbox handoff). */
  onOpenMissionControlIssue?: (companyId: string, issueId: string) => void;
};

// ─── main component ───────────────────────────────────────────────────────────

export function InboxAgentPanel(props: InboxAgentPanelProps = {}) {
  const { onOpenMissionControlIssue } = props;
  const [status, setStatus] = useState<MailboxSyncStatus | null>(null);
  const [digest, setDigest] = useState<MailboxDigestSnapshot | null>(null);
  const [threads, setThreads] = useState<MailboxThreadListItem[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThreadIds, setSelectedThreadIds] = useState<string[]>([]);
  const [selectedThread, setSelectedThread] = useState<MailboxThreadDetail | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | "priority" | "calendar" | "follow_up" | "promotions" | "updates">("all");
  const [focusFilter, setFocusFilter] = useState<FocusFilter>(null);
  const [queueMode, setQueueMode] = useState<QueueMode>(null);
  const [queueProposals, setQueueProposals] = useState<MailboxActionProposal[]>([]);
  const [automations, setAutomations] = useState<MailboxAutomationRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageSortOrder, setMessageSortOrder] = useState<"newest" | "oldest">("newest");
  const [threadSortOrder, setThreadSortOrder] = useState<ThreadSortOrder>("recent");
  const [mailboxView, setMailboxView] = useState<ThreadMailboxView>("inbox");
  const [selectedAccountId, setSelectedAccountId] = useState<string>(ALL_MAILBOX_ACCOUNTS_FILTER);
  const [googleWorkspaceEnabled, setGoogleWorkspaceEnabled] = useState(false);
  const [googleWorkspaceScopes, setGoogleWorkspaceScopes] = useState<string[] | null>(null);
  const [editingCommitmentId, setEditingCommitmentId] = useState<string | null>(null);
  const [editingCommitmentTitle, setEditingCommitmentTitle] = useState("");
  const [editingCommitmentDueAt, setEditingCommitmentDueAt] = useState("");
  const [editingCommitmentOwnerEmail, setEditingCommitmentOwnerEmail] = useState("");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [agentRoles, setAgentRoles] = useState<AgentRoleData[]>([]);
  const [handoffPreview, setHandoffPreview] = useState<MailboxMissionControlHandoffPreview | null>(null);
  const [handoffRecords, setHandoffRecords] = useState<MailboxMissionControlHandoffRecord[]>([]);
  const [handoffPanelOpen, setHandoffPanelOpen] = useState(false);
  const [handoffCompanyId, setHandoffCompanyId] = useState("");
  const [handoffCompanyConfirmed, setHandoffCompanyConfirmed] = useState(false);
  const [handoffOperatorRoleId, setHandoffOperatorRoleId] = useState("");
  const [handoffIssueTitle, setHandoffIssueTitle] = useState("");
  const [handoffIssueSummary, setHandoffIssueSummary] = useState("");
  const [replyChannelType, setReplyChannelType] = useState<"slack" | "teams" | "whatsapp" | "signal" | "imessage" | null>(null);
  const [replyTargetHandleId, setReplyTargetHandleId] = useState<string | null>(null);
  const [replyMessage, setReplyMessage] = useState("");
  const [classificationWarningAcknowledged, setClassificationWarningAcknowledged] = useState(() =>
    typeof window !== "undefined" &&
      window.localStorage.getItem(MAILBOX_CLASSIFICATION_WARNING_KEY) === "1",
  );
  const [mailboxServerActionWarningAcknowledged, setMailboxServerActionWarningAcknowledged] = useState(() =>
    typeof window !== "undefined" &&
      window.localStorage.getItem(MAILBOX_SERVER_ACTION_WARNING_KEY) === "1",
  );

  const [savedViews, setSavedViews] = useState<MailboxSavedViewRecord[]>([]);
  const [selectedSavedViewId, setSelectedSavedViewId] = useState<string | null>(null);
  const [snippets, setSnippets] = useState<MailboxSnippetRecord[]>([]);
  const [quickReplySuggestions, setQuickReplySuggestions] = useState<string[]>([]);
  const [labelSimilarOpen, setLabelSimilarOpen] = useState(false);
  const [labelSimilarName, setLabelSimilarName] = useState("");
  const [labelSimilarInstructions, setLabelSimilarInstructions] = useState("");
  const [labelSimilarPreviewIds, setLabelSimilarPreviewIds] = useState<string[]>([]);
  const [labelSimilarRationale, setLabelSimilarRationale] = useState<string | null>(null);
  const [labelSimilarError, setLabelSimilarError] = useState<string | null>(null);
  const [labelSimilarShowInInbox, setLabelSimilarShowInInbox] = useState(true);
  const [labelSimilarDidPreview, setLabelSimilarDidPreview] = useState(false);
  const [labelSimilarBusy, setLabelSimilarBusy] = useState(false);
  const [quickReplyError, setQuickReplyError] = useState<string | null>(null);
  const [quickReplySettled, setQuickReplySettled] = useState(false);
  const [snippetModalOpen, setSnippetModalOpen] = useState(false);
  const [snippetShortcutDraft, setSnippetShortcutDraft] = useState("");
  const [snippetBodyDraft, setSnippetBodyDraft] = useState("");

  const loadSavedViewsAndSnippets = async () => {
    const [views, snip] = await Promise.all([
      window.electronAPI.listMailboxSavedViews().catch(() => []),
      window.electronAPI.listMailboxSnippets().catch(() => []),
    ]);
    setSavedViews(views);
    setSnippets(snip);
  };

  const loadStatus = async () => {
    const next = await window.electronAPI.getMailboxSyncStatus();
    setStatus(next);
  };

  const loadMissionControlOptions = async () => {
    const [nextCompanies, nextRoles] = await Promise.all([
      window.electronAPI.listCompanies().catch(() => []),
      window.electronAPI.getAgentRoles(true).catch(() => []),
    ]);
    setCompanies(nextCompanies);
    setAgentRoles(nextRoles);
  };

  const loadDigest = async () => {
    const next = await window.electronAPI.getMailboxDigest().catch(() => null);
    setDigest(next);
  };

  const loadAutomations = async (threadId?: string) => {
    const next = await window.electronAPI.listMailboxAutomations({
      threadId,
    }).catch(() => []);
    setAutomations(next);
  };

  const loadThreads = async (opts?: {
    accountId?: string | undefined;
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
    const hasAccountId = opts && Object.prototype.hasOwnProperty.call(opts, "accountId");
    const nextAccountId = hasAccountId ? opts?.accountId ?? selectedAccountId : selectedAccountId;
    const list = await window.electronAPI.listMailboxThreads({
      accountId: nextAccountId !== ALL_MAILBOX_ACCOUNTS_FILTER ? nextAccountId : undefined,
      query: opts?.query ?? query,
      category: (opts?.category as Any) ?? category,
      mailboxView: nextMailboxView,
      savedViewId: selectedSavedViewId || undefined,
      unreadOnly: nextFocus === "unread" ? true : undefined,
      needsReply: nextFocus === "needsReply" ? true : undefined,
      hasSuggestedProposal: nextFocus === "queue" ? true : undefined,
      hasOpenCommitment: nextFocus === "commitments" ? true : undefined,
      sortBy: nextSort,
      limit: 40,
    });
    setThreads(list);
    setSelectedThreadIds((current) => current.filter((id) => list.some((thread) => thread.id === id)));
    setSelectedThreadId((current) =>
      current && list.some((thread) => thread.id === current) ? current : (list[0]?.id || null),
    );
  };

  const loadThread = async (threadId: string) => {
    const detail = await window.electronAPI.getMailboxThread(threadId);
    setSelectedThread(detail);
  };

  const loadHandoffContext = async (threadId: string) => {
    const [preview, records] = await Promise.all([
      window.electronAPI.previewMailboxMissionControlHandoff(threadId).catch(() => null),
      window.electronAPI.listMailboxMissionControlHandoffs(threadId).catch(() => []),
    ]);
    setHandoffPreview(preview);
    setHandoffRecords(records);
    if (preview) {
      const nextCompanyId = preview.recommendedCompanyId || preview.companyCandidates[0]?.companyId || "";
      const nextOperatorRoleId =
        preview.recommendedOperatorRoleId || preview.operatorRecommendations[0]?.agentRoleId || "";
      setHandoffCompanyId(nextCompanyId);
      setHandoffCompanyConfirmed(false);
      setHandoffOperatorRoleId(nextOperatorRoleId);
      setHandoffIssueTitle(preview.issueTitle);
      setHandoffIssueSummary(preview.issueSummary);
    } else {
      setHandoffCompanyId("");
      setHandoffCompanyConfirmed(false);
      setHandoffOperatorRoleId("");
      setHandoffIssueTitle("");
      setHandoffIssueSummary("");
    }
  };

  const reloadAll = async (threadId?: string) => {
    await Promise.all([loadStatus(), loadDigest(), loadThreads(), loadAutomations(threadId || selectedThreadId || undefined)]);
    const nextId = threadId || selectedThreadId;
    if (nextId) {
      await loadThread(nextId);
      if (handoffPanelOpen) {
        await loadHandoffContext(nextId);
      }
    }
  };

  const selectedBulkThreadIds = selectedThreadIds.length
    ? selectedThreadIds
    : selectedThreadId
      ? [selectedThreadId]
      : [];

  const selectedThreadAutomations = useMemo(() => {
    const threadId = selectedThread?.id || selectedThreadId || null;
    if (!threadId) return automations;
    return automations.filter(
      (automation) => automation.threadId === threadId || !automation.threadId,
    );
  }, [automations, selectedThread?.id, selectedThreadId]);

  const selectedThreadReplyTargets = useMemo(() => {
    const replyTargets = selectedThread?.research?.replyTargets || [];
    const primaryReplyTargets = replyTargets.filter((target) =>
      ["slack", "whatsapp", "teams"].includes(target.channelType),
    );
    const nextTargets = primaryReplyTargets.length ? primaryReplyTargets : replyTargets;
    const preferredChannel = selectedThread?.research?.channelPreference?.preferredChannel || null;
    return [...nextTargets].sort((left, right) => {
      const leftPreferred = preferredChannel && left.channelType === preferredChannel ? 1 : 0;
      const rightPreferred = preferredChannel && right.channelType === preferredChannel ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;

      const leftLastMessageAt = left.lastMessageAt || 0;
      const rightLastMessageAt = right.lastMessageAt || 0;
      if (leftLastMessageAt !== rightLastMessageAt) return rightLastMessageAt - leftLastMessageAt;

      const leftLabel = `${left.displayValue || ""} ${left.channelType || ""}`.trim().toLowerCase();
      const rightLabel = `${right.displayValue || ""} ${right.channelType || ""}`.trim().toLowerCase();
      return leftLabel.localeCompare(rightLabel);
    });
  }, [selectedThread?.research?.replyTargets, selectedThread?.research?.channelPreference?.preferredChannel]);

  const recommendedReplyTarget = selectedThreadReplyTargets[0] || null;

  const companyCandidates = useMemo<MailboxCompanyCandidate[]>(() => {
    if (handoffPreview?.companyCandidates?.length) return handoffPreview.companyCandidates;
    return companies.map((company) => ({
      companyId: company.id,
      name: company.name,
      slug: company.slug,
      confidence: 0,
      reason: "manual selection",
      defaultWorkspaceId: company.defaultWorkspaceId,
    }));
  }, [companies, handoffPreview?.companyCandidates]);

  const selectedCompanyRoles = useMemo(
    () => agentRoles.filter((role) => role.companyId === handoffCompanyId && role.isActive !== false),
    [agentRoles, handoffCompanyId],
  );

  const mailboxAccounts = status?.accounts || [];
  const mailboxAccountById = useMemo(
    () => new Map(mailboxAccounts.map((account) => [account.id, account])),
    [mailboxAccounts],
  );
  const activeAccount = selectedAccountId === ALL_MAILBOX_ACCOUNTS_FILTER
    ? null
    : mailboxAccountById.get(selectedAccountId) || null;
  const selectedThreadAccount = selectedThread
    ? mailboxAccountById.get(selectedThread.accountId) || null
    : null;

  const gmailScopesKnown = googleWorkspaceScopes !== null;
  const gmailModifyScopeGranted =
    !gmailScopesKnown || hasScope(googleWorkspaceScopes ?? undefined, GOOGLE_SCOPE_GMAIL_MODIFY);
  const gmailCleanupDisabledReason = !googleWorkspaceEnabled
    ? "Enable Google Workspace in Settings > Integrations > Google Workspace to use Gmail cleanup actions."
    : gmailScopesKnown && !gmailModifyScopeGranted
      ? "Reconnect Google Workspace with the Gmail modify scope to archive, trash, or mark Gmail threads."
      : null;
  const gmailCleanupActionsEnabled = googleWorkspaceEnabled && gmailModifyScopeGranted;
  const selectedThreadNeedsGmailCleanupAttention =
    selectedThread?.provider === "gmail" && Boolean(gmailCleanupDisabledReason);

  const clearThreadSelection = () => {
    setSelectedThreadIds([]);
  };

  const toggleThreadSelection = (threadId: string) => {
    setSelectedThreadIds((current) =>
      current.includes(threadId)
        ? current.filter((entry) => entry !== threadId)
        : [...current, threadId],
    );
  };

  const beginCommitmentEdit = (commitment: MailboxCommitment) => {
    setEditingCommitmentId(commitment.id);
    setEditingCommitmentTitle(commitment.title);
    setEditingCommitmentDueAt(formatDateTimeLocalValue(commitment.dueAt));
    setEditingCommitmentOwnerEmail(commitment.ownerEmail || "");
  };

  const cancelCommitmentEdit = () => {
    setEditingCommitmentId(null);
    setEditingCommitmentTitle("");
    setEditingCommitmentDueAt("");
    setEditingCommitmentOwnerEmail("");
  };

  const saveCommitmentEdit = async (commitment: MailboxCommitment) => {
    if (!selectedThread) return;
    await runAction(async () => {
      const dueAt = editingCommitmentDueAt.trim()
        ? new Date(editingCommitmentDueAt).getTime()
        : null;
      await window.electronAPI.updateMailboxCommitmentDetails(commitment.id, {
        title: editingCommitmentTitle.trim() || commitment.title,
        dueAt: Number.isFinite(dueAt || NaN) ? dueAt : null,
        ownerEmail: editingCommitmentOwnerEmail.trim() || null,
      });
      cancelCommitmentEdit();
      await reloadAll(selectedThread.id);
    });
  };

  useEffect(() => {
    void (async () => {
      setBusy(true);
      try {
        const googleSettings = await window.electronAPI.getGoogleWorkspaceSettings().catch(() => null);
        setGoogleWorkspaceEnabled(Boolean(googleSettings?.enabled));
        setGoogleWorkspaceScopes(googleSettings?.scopes ?? null);
        await loadMissionControlOptions();
        await loadStatus();
        const nextStatus = await window.electronAPI.getMailboxSyncStatus();
        setStatus(nextStatus);
        await loadDigest();
        await loadSavedViewsAndSnippets();
        await loadThreads();
        await loadAutomations();
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
    cancelCommitmentEdit();
    setReplyChannelType(null);
    setReplyTargetHandleId(null);
    setReplyMessage("");
    void loadThread(selectedThreadId);
    if (handoffPanelOpen) {
      void loadHandoffContext(selectedThreadId);
    }
  }, [selectedThreadId]);

  useEffect(() => {
    if (!selectedThread?.id) {
      setQuickReplySuggestions([]);
      setQuickReplyError(null);
      setQuickReplySettled(false);
      return;
    }
    let cancelled = false;
    setQuickReplySettled(false);
    setQuickReplyError(null);
    void window.electronAPI.getMailboxQuickReplySuggestions(selectedThread.id)
      .then((res) => {
        if (cancelled) return;
        setQuickReplySuggestions(res.suggestions);
        setQuickReplyError(res.error || null);
        setQuickReplySettled(true);
      })
      .catch(() => {
        if (cancelled) return;
        setQuickReplySuggestions([]);
        setQuickReplyError("Could not load quick reply suggestions right now.");
        setQuickReplySettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedThread?.id]);

  useEffect(() => {
    const unsubscribe = window.electronAPI.onMailboxEvent((event) => {
      if (event.threadId && event.threadId === selectedThreadId) {
        void reloadAll(event.threadId);
      } else {
        void loadStatus();
        void loadDigest();
        void loadThreads();
      }
    });
    return unsubscribe;
  }, [selectedThreadId, query, category, mailboxView, focusFilter, threadSortOrder, selectedAccountId, selectedSavedViewId]);

  useEffect(() => {
    if (!handoffPanelOpen || !handoffCompanyId) return;
    if (selectedCompanyRoles.some((role) => role.id === handoffOperatorRoleId)) return;
    const recommendedForCompany = handoffPreview?.operatorRecommendations.find(
      (recommendation) =>
        selectedCompanyRoles.some((role) => role.id === recommendation.agentRoleId),
    );
    setHandoffOperatorRoleId(
      recommendedForCompany?.agentRoleId || selectedCompanyRoles[0]?.id || "",
    );
  }, [
    handoffCompanyId,
    handoffOperatorRoleId,
    handoffPanelOpen,
    handoffPreview?.operatorRecommendations,
    selectedCompanyRoles,
  ]);

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

  const pulseCards = useMemo(
    () => [
      {
        id: "unread" as const,
        label: "Unread",
        value: digest?.unreadCount ?? status?.unreadCount ?? 0,
      },
      {
        id: "needsReply" as const,
        label: "Needs reply",
        value: digest?.needsReplyCount ?? status?.needsReplyCount ?? 0,
      },
      {
        id: "queue" as const,
        label: "Suggested actions",
        value: digest?.proposalCount ?? status?.proposalCount ?? 0,
      },
      {
        id: "commitments" as const,
        label: "Open commitments",
        value: digest?.commitmentCount ?? status?.commitmentCount ?? 0,
      },
    ],
    [digest, status],
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

  const copyTextToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Clipboard access failed. Paste from the composer or allow clipboard permissions in your system settings.");
    }
  };

  const resetLabelSimilarPreview = () => {
    setLabelSimilarPreviewIds([]);
    setLabelSimilarRationale(null);
    setLabelSimilarError(null);
    setLabelSimilarDidPreview(false);
  };

  const getThreadDetailForDraft = useCallback(
    async (threadId: string): Promise<MailboxThreadDetail | null> => {
      if (selectedThread?.id === threadId) {
        return selectedThread;
      }
      return window.electronAPI.getMailboxThread(threadId);
    },
    [selectedThread],
  );

  const generateDraftForThread = useCallback(
    async (
      threadId: string,
      options: {
        tone?: "concise" | "warm" | "direct" | "executive";
        includeAvailability?: boolean;
        manual?: boolean;
      } = {},
    ) => {
      const detail = await getThreadDetailForDraft(threadId);
      const noReplySender = detail ? getMailboxNoReplySender(detail.messages, detail.participants) : null;

      if (noReplySender) {
        if (!options.manual) {
          return null;
        }
        const confirmed = window.confirm(
          `This email appears to come from a no-reply sender (${noReplySender.email}). Automatic drafts are disabled for no-reply senders.\n\nGenerate a reply draft anyway?`,
        );
        if (!confirmed) {
          return null;
        }
      }

      return window.electronAPI.generateMailboxDraft(threadId, {
        tone: options.tone,
        includeAvailability: options.includeAvailability,
        allowNoreplySender: noReplySender ? true : undefined,
      });
    },
    [getThreadDetailForDraft],
  );

  const syncMailboxWithProgress = async () => {
    setBusy(true);
    setError(null);
    const timer = window.setInterval(() => {
      void loadStatus();
    }, 600);
    try {
      await window.electronAPI.syncMailbox(25);
      await Promise.all([loadStatus(), loadDigest(), loadThreads()]);
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

  const confirmServerMailboxAction = (type: "archive" | "trash" | "mark_read", threadCount = 1): boolean => {
    if (type === "mark_read" || mailboxServerActionWarningAcknowledged) {
      return true;
    }
    const actionLabel = type === "archive" ? "archive" : "trash";
    const targetLabel = threadCount === 1 ? "this email thread" : `${threadCount} email threads`;
    const confirmed = window.confirm(
      `This will ${actionLabel} ${targetLabel} on the mail server, not just inside Cowork.\n\nUse Apply cleanup to hide threads only in Cowork.\n\nContinue?`,
    );
    if (!confirmed) {
      return false;
    }
    window.localStorage.setItem(MAILBOX_SERVER_ACTION_WARNING_KEY, "1");
    setMailboxServerActionWarningAcknowledged(true);
    return true;
  };

  const reclassifySelectedThread = async () => {
    if (!selectedThread) return;
    await runAction(async () => {
      await window.electronAPI.reclassifyMailboxThread(selectedThread.id);
      await reloadAll(selectedThread.id);
    });
  };

  const reclassifyMailboxBackfill = async () => {
    const accountIds =
      selectedAccountId !== ALL_MAILBOX_ACCOUNTS_FILTER
        ? [selectedAccountId]
        : (status?.accounts || []).map((account) => account.id);
    if (!accountIds.length) return;
    await runAction(async () => {
      for (const accountId of accountIds) {
        await window.electronAPI.reclassifyMailboxAccount({
          accountId,
          scope: "backfill",
          limit: 50,
        });
      }
      await reloadAll();
    });
  };

  const handleApplyProposal = async (proposal: MailboxActionProposal) => {
    await runAction(async () => {
      let reloadThreadId: string | undefined = proposal.threadId;
      if (proposal.type === "cleanup") {
        await window.electronAPI.applyMailboxAction({
          proposalId: proposal.id,
          threadId: proposal.threadId,
          type: "cleanup_local",
        });
        reloadThreadId = undefined;
      } else if (proposal.type === "schedule") {
        await window.electronAPI.applyMailboxAction({
          proposalId: proposal.id,
          threadId: proposal.threadId,
          type: "schedule_event",
        });
      } else if (proposal.type === "reply" || proposal.type === "follow_up") {
        await generateDraftForThread(proposal.threadId, {
          tone: "concise",
          includeAvailability: true,
          manual: true,
        });
      }
      await reloadAll(reloadThreadId);
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
    if (!confirmServerMailboxAction(type, 1)) return;
    await runAction(async () => {
      await window.electronAPI.applyMailboxAction({
        threadId: selectedThread.id,
        type,
      });
      await reloadAll(type === "mark_read" ? selectedThread.id : undefined);
    });
  };

  const getCrossChannelReplySeed = (): string => {
    if (!selectedThread) return "";
    const draftBody = selectedThread.drafts[0]?.body?.trim();
    if (draftBody) return draftBody;
    const summary = stripMailboxSummaryHtmlArtifacts(selectedThread.summary?.summary || "");
    if (summary) {
      return `Thanks for the update. I reviewed the thread and will follow up shortly.\n\nContext: ${summary.slice(0, 300)}`;
    }
    return `Thanks for the update. I’ll follow up shortly.`;
  };

  const openReplyComposer = (handleId: string) => {
    const target = selectedThreadReplyTargets.find((entry) => entry.handleId === handleId) || null;
    setReplyTargetHandleId(handleId);
    setReplyChannelType(target?.channelType || null);
    setReplyMessage((current) => current.trim() ? current : getCrossChannelReplySeed());
  };

  const sendReplyViaChannel = async () => {
    const target = selectedThreadReplyTargets.find((entry) => entry.handleId === replyTargetHandleId) || null;
    if (!selectedThread || !target || !replyMessage.trim()) return;
    await runAction(async () => {
      await window.electronAPI.replyViaChannel({
        threadId: selectedThread.id,
        handleId: target.handleId,
        channelType: target.channelType,
        message: replyMessage.trim(),
        parseMode: "text",
      });
      setReplyChannelType(null);
      setReplyTargetHandleId(null);
      setReplyMessage("");
      await reloadAll(selectedThread.id);
    });
  };

  const handleBulkThreadAction = async (type: "archive" | "trash" | "mark_read") => {
    if (!selectedBulkThreadIds.length) return;
    if (type !== "mark_read") {
      if (!gmailCleanupActionsEnabled) {
        setError(gmailCleanupDisabledReason || "Reconnect Google Workspace to archive or trash Gmail threads.");
        return;
      }
      const selectedThreads = threads.filter((thread) => selectedBulkThreadIds.includes(thread.id));
      if (selectedThreads.some((thread) => thread.provider !== "gmail")) {
        setError("Archive and Trash are currently supported only for Gmail threads.");
        return;
      }
    }
    if (!confirmServerMailboxAction(type, selectedBulkThreadIds.length)) return;
    await runAction(async () => {
      for (const threadId of selectedBulkThreadIds) {
        await window.electronAPI.applyMailboxAction({ threadId, type });
      }
      clearThreadSelection();
      await reloadAll(type === "mark_read" ? selectedBulkThreadIds[0] : undefined);
    });
  };

  const createRuleFromCurrentContext = async () => {
    await runAction(async () => {
      const thread = selectedThread;
      const ruleLabel = selectedThread?.subject || query.trim() || "Inbox view";
      const summaryText = thread?.summary?.summary;
      const participantText = thread?.participants.length
        ? `Participants: ${thread.participants.map((participant) => participant.email).join(", ")}`
        : null;
      const conditions: Array<{ field: string; operator: MailboxConditionOperator; value: string }> = [
        { field: "eventType", operator: "equals", value: "thread_classified" },
      ];

      if (thread) {
        conditions.push({ field: "threadId", operator: "equals", value: thread.id });
      } else {
        if (query.trim()) {
          conditions.push({ field: "subject", operator: "contains", value: query.trim() });
        }
        if (focusFilter === "needsReply") {
          conditions.push({ field: "needsReply", operator: "equals", value: "true" });
        }
      }

      await window.electronAPI.createMailboxRule({
        name: `${ruleLabel} follow-up`,
        description: "Create a follow-up task when this thread needs attention.",
        threadId: thread?.id,
        source: "mailbox_event",
        conditions,
        conditionLogic: "all",
        actionType: "create_task",
        actionTitle: `Follow up: ${ruleLabel}`,
        actionPrompt: [
          `Create a follow-up task for this inbox context: ${ruleLabel}.`,
          summaryText ? `Summary: ${stripMailboxSummaryHtmlArtifacts(summaryText)}` : null,
          participantText,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n"),
        enabled: true,
        cooldownMs: 30 * 60 * 1000,
      });
      await reloadAll(thread?.id);
    });
  };

  const snoozeSelectedThread = async () => {
    if (!selectedThread) return;
    await runAction(async () => {
      const summaryText = selectedThread.summary?.summary;
      const participantText = selectedThread.participants.length
        ? `Participants: ${selectedThread.participants.map((participant) => participant.email).join(", ")}`
        : null;
      const reminder = new Date();
      reminder.setDate(reminder.getDate() + 1);
      reminder.setHours(9, 0, 0, 0);
      await window.electronAPI.createMailboxSchedule({
        name: `Inbox reminder: ${selectedThread.subject || "Thread"}`,
        description: `Remind about ${selectedThread.subject || "this thread"}`,
        threadId: selectedThread.id,
        kind: "reminder",
        schedule: { kind: "at", atMs: reminder.getTime() },
        taskTitle: `Inbox reminder: ${selectedThread.subject || "Thread"}`,
        taskPrompt: [
          `Remind the user about this inbox thread: ${selectedThread.subject || "Untitled thread"}.`,
          participantText,
          summaryText ? `Summary: ${stripMailboxSummaryHtmlArtifacts(summaryText)}` : null,
        ]
          .filter((entry): entry is string => Boolean(entry))
          .join("\n"),
        enabled: true,
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
        await generateDraftForThread(selectedThread.id, {
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

  const openHandoffPanel = async () => {
    if (!selectedThread) return;
    await runAction(async () => {
      await loadMissionControlOptions();
      await loadHandoffContext(selectedThread.id);
      setHandoffPanelOpen(true);
    });
  };

  const createMissionControlHandoff = async () => {
    if (!selectedThread || !handoffPreview) return;
    if (!handoffCompanyId || !handoffOperatorRoleId || !handoffIssueTitle.trim()) {
      setError("Company, operator, and issue title are required for inbox handoff.");
      return;
    }
    if (!handoffCompanyConfirmed) {
      setError("Confirm the target company before creating the Mission Control handoff.");
      return;
    }
    await runAction(async () => {
      await window.electronAPI.createMailboxMissionControlHandoff({
        threadId: selectedThread.id,
        companyId: handoffCompanyId,
        operatorRoleId: handoffOperatorRoleId,
        issueTitle: handoffIssueTitle.trim(),
        issueSummary: handoffIssueSummary.trim(),
      });
      await loadHandoffContext(selectedThread.id);
      await reloadAll(selectedThread.id);
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

  const threadGroups = useMemo<ThreadGroup[]>(() => {
    if (!displayedThreads.length) return [];
    const hasNarrowFilter = Boolean(
      query.trim() ||
      focusFilter ||
      category !== "all" ||
      mailboxView !== "inbox" ||
      selectedAccountId !== ALL_MAILBOX_ACCOUNTS_FILTER,
    );
    if (hasNarrowFilter) {
      return [
        {
          id: "all",
          label: "Matching threads",
          description: `${displayedThreads.length} thread${displayedThreads.length === 1 ? "" : "s"}`,
          threads: displayedThreads,
        },
      ];
    }

    const needsReply = displayedThreads.filter((thread) => thread.needsReply);
    const rest = displayedThreads.filter(
      (thread) => !thread.needsReply && thread.priorityBand !== "critical" && thread.priorityBand !== "high",
    );

    const groups: ThreadGroup[] = [];
    if (needsReply.length) {
      groups.push({
        id: "needs-reply",
        label: "Needs reply",
        description: "Threads waiting on your response",
        threads: needsReply,
      });
    }
    if (rest.length) {
      groups.push({
        id: "rest",
        label: "",
        description: "",
        threads: rest,
      });
    }
    return groups;
  }, [category, displayedThreads, focusFilter, mailboxView, query, selectedAccountId]);

  useEffect(() => {
    if (selectedAccountId === ALL_MAILBOX_ACCOUNTS_FILTER) return;
    if (mailboxAccounts.some((account) => account.id === selectedAccountId)) return;
    setSelectedAccountId(ALL_MAILBOX_ACCOUNTS_FILTER);
    void loadThreads({ accountId: ALL_MAILBOX_ACCOUNTS_FILTER });
  }, [mailboxAccounts, selectedAccountId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (isTyping || busy) return;

      const currentIndex = displayedThreads.findIndex((thread) => thread.id === selectedThreadId);
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        if (!displayedThreads.length) return;
        const delta = event.key === "j" ? 1 : -1;
        const nextIndex = currentIndex >= 0 ? currentIndex + delta : 0;
        const boundedIndex = Math.max(0, Math.min(displayedThreads.length - 1, nextIndex));
        setSelectedThreadId(displayedThreads[boundedIndex]?.id || null);
        return;
      }

      if (event.key === "e") {
        event.preventDefault();
        void handleBulkThreadAction("archive");
        return;
      }

      if (event.key === "#") {
        event.preventDefault();
        void handleBulkThreadAction("trash");
        return;
      }

      if (event.key.toLowerCase() === "d" && selectedThread) {
        event.preventDefault();
        void runAction(async () => {
          await generateDraftForThread(selectedThread.id, {
            tone: "concise",
            includeAvailability: true,
            manual: true,
          });
          await reloadAll(selectedThread.id);
        });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, displayedThreads, generateDraftForThread, selectedThread, selectedThreadId, selectedBulkThreadIds.join("|")]);

  const incomingMessages = useMemo(
    () => sortedThreadMessages.filter((message) => message.direction === "incoming"),
    [sortedThreadMessages],
  );

  const outgoingMessages = useMemo(
    () => sortedThreadMessages.filter((message) => message.direction === "outgoing"),
    [sortedThreadMessages],
  );

  const messageSections = useMemo(
    () => {
      if (!selectedThread) return [];

      const sections: Array<{
        title: string;
        messages: MailboxThreadDetail["messages"];
      }> = [];

      const pushSection = (title: string, messages: MailboxThreadDetail["messages"]) => {
        if (messages.length > 0) sections.push({ title, messages });
      };

      if (mailboxView === "sent") {
        pushSection("Sent Emails", outgoingMessages);
        pushSection("Received Emails", incomingMessages);
      } else {
        pushSection("Received Emails", incomingMessages);
        pushSection("Sent Emails", outgoingMessages);
      }

      if (!sections.length && selectedThread.messages.length > 0) {
        sections.push({
          title: mailboxView === "sent" ? "Sent Emails" : "Received Emails",
          messages: selectedThread.messages,
        });
      }

      return sections;
    },
    [incomingMessages, mailboxView, outgoingMessages, selectedThread],
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
        gridTemplateColumns: "340px minmax(0, 1fr) 340px",
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

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              marginBottom: "12px",
            }}
          >
            <div
              role="tablist"
              aria-label="Mailbox folder"
              style={{
                display: "flex",
                padding: "3px",
                gap: "2px",
                borderRadius: "11px",
                background: "var(--color-bg-secondary)",
                border: "1px solid var(--color-border-subtle)",
                boxSizing: "border-box",
              }}
            >
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
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setMailboxView(view.id);
                      setSelectedSavedViewId(null);
                      void loadThreads({ mailboxView: view.id });
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: "6px 6px",
                      borderRadius: "8px",
                      fontSize: "0.7rem",
                      fontWeight: active ? 600 : 500,
                      border: "none",
                      background: active ? "var(--color-bg-elevated)" : "transparent",
                      color: active ? "var(--color-text-primary)" : "var(--color-text-muted)",
                      cursor: "pointer",
                      transition: "background 0.14s ease, color 0.14s ease, box-shadow 0.14s ease",
                      fontFamily: "var(--font-ui)",
                      boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                    }}
                  >
                    {view.label}
                  </button>
                );
              })}
            </div>

            <div style={{ width: "100%" }}>
              <label
                style={{
                  fontSize: "0.68rem",
                  color: "var(--color-text-muted)",
                  display: "block",
                  marginBottom: "4px",
                }}
              >
                Saved view
              </label>
              <select
                aria-label="Saved inbox view"
                value={selectedSavedViewId || ""}
                onChange={(event) => {
                  const next = event.target.value;
                  setSelectedSavedViewId(next || null);
                  void loadThreads();
                }}
                style={{
                  width: "100%",
                  margin: 0,
                  padding: "7px 10px",
                  borderRadius: "10px",
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-secondary)",
                  fontSize: "0.72rem",
                  fontWeight: 500,
                  fontFamily: "var(--font-ui)",
                  color: "var(--color-text-primary)",
                  cursor: "pointer",
                  boxSizing: "border-box",
                  lineHeight: 1.25,
                }}
              >
                <option value="">None</option>
                {savedViews.map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.name}
                  </option>
                ))}
              </select>
            </div>

            {mailboxAccounts.length > 1 && (
              <div style={{ position: "relative", width: "100%" }}>
                <select
                  aria-label="Mailbox account"
                  value={selectedAccountId}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSelectedAccountId(next);
                    void loadThreads({ accountId: next });
                  }}
                  style={{
                    width: "100%",
                    margin: 0,
                    padding: "7px 32px 7px 10px",
                    borderRadius: "10px",
                    border: "1px solid var(--color-border-subtle)",
                    background: "var(--color-bg-secondary)",
                    fontSize: "0.72rem",
                    fontWeight: 500,
                    fontFamily: "var(--font-ui)",
                    color: "var(--color-text-primary)",
                    cursor: "pointer",
                    appearance: "none",
                    WebkitAppearance: "none",
                    MozAppearance: "none",
                    boxSizing: "border-box",
                    lineHeight: 1.25,
                  }}
                >
                  <option value={ALL_MAILBOX_ACCOUNTS_FILTER}>All accounts</option>
                  {mailboxAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {formatMailboxAccountLabel(account)}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  aria-hidden
                  style={{
                    position: "absolute",
                    right: "10px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    pointerEvents: "none",
                    color: "var(--color-text-muted)",
                  }}
                />
              </div>
            )}
          </div>

          {/* Inbox pulse */}
            <div
              style={{
                marginBottom: "8px",
                padding: "6px",
                borderRadius: "var(--radius-md, 12px)",
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border-subtle)",
                boxShadow: "var(--shadow-sm)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                marginBottom: "6px",
              }}
            >
              <div>
                <div
                style={{
                  fontSize: "0.62rem",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--color-text-muted)",
                  marginBottom: "0",
                }}
                >
                  Inbox pulse
                </div>
              </div>
            </div>

            <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: "4px",
                }}
              >
                {pulseCards.map((card) => {
                  const active = focusFilter === card.id;
                  const filterable = card.id === "unread" || card.id === "needsReply" || card.id === "queue" || card.id === "commitments";
                  return (
                  <button
                    type="button"
                    key={card.label}
                    onClick={() => {
                      if (!filterable) return;
                      const nextFocus = focusFilter === card.id ? null : card.id;
                      setFocusFilter(nextFocus);
                      void loadThreads({ focusFilter: nextFocus });
                    }}
                    style={{
                      appearance: "none",
                      WebkitAppearance: "none",
                      minHeight: 54,
                      borderRadius: "var(--radius-sm, 8px)",
                      background: active ? "var(--color-bg-secondary)" : "var(--color-bg-elevated)",
                      border: `1px solid ${active ? "var(--color-text-primary)" : "var(--color-border-subtle)"}`,
                      textAlign: "left" as const,
                      cursor: filterable ? "pointer" : "default",
                      fontFamily: "var(--font-ui)",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "center",
                      gap: "3px",
                      width: "100%",
                      minWidth: 0,
                      boxSizing: "border-box",
                      padding: "6px 6px 5px",
                      boxShadow: active ? "0 0 0 1px var(--color-text-primary) inset" : "none",
                    }}
                    aria-pressed={active}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: "4px" }}>
                      <div
                        style={{
                          fontSize: "1.55rem",
                          fontWeight: 800,
                          color: "var(--color-text-primary)",
                          lineHeight: 1,
                          letterSpacing: "-0.04em",
                        }}
                      >
                        {card.value}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: "0.58rem",
                        color: "var(--color-text-muted)",
                        fontWeight: 700,
                        lineHeight: 1.05,
                        textTransform: "uppercase",
                        letterSpacing: "0.07em",
                        textAlign: "center",
                      }}
                    >
                      {card.label}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {status &&
            !classificationWarningAcknowledged &&
            (status.classificationPendingCount > 0 || !status.lastSyncedAt) && (
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "var(--radius-md, 10px)",
                  marginBottom: "12px",
                  background: "rgba(34, 211, 238, 0.08)",
                  border: "1px solid rgba(34, 211, 238, 0.28)",
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

          {!!selectedThreadIds.length && (
            <div
              style={{
                marginBottom: "10px",
                padding: "12px",
                borderRadius: "var(--radius-md, 10px)",
                background:
                  "linear-gradient(180deg, rgba(34, 211, 238, 0.10) 0%, var(--color-bg-elevated) 100%)",
                border: "1px solid rgba(34, 211, 238, 0.18)",
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ fontSize: "0.74rem", color: "var(--color-text-secondary)", lineHeight: 1.4 }}>
                <div style={{ fontWeight: 700, color: "var(--color-text-primary)", marginBottom: "2px" }}>
                  {selectedThreadIds.length} thread{selectedThreadIds.length === 1 ? "" : "s"} selected
                </div>
                <div>
                  Use bulk actions to clear the queue faster. Selection stays visible while you browse.
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                <ActionBtn
                  onClick={() => setSelectedThreadIds(displayedThreads.map((thread) => thread.id))}
                  icon={<CheckSquare size={11} />}
                  label="Select all visible"
                  disabled={busy || displayedThreads.length === 0}
                />
                <ActionBtn
                  onClick={() => void handleBulkThreadAction("archive")}
                  icon={<Archive size={11} />}
                  label="Archive"
                  disabled={busy}
                />
                <ActionBtn
                  onClick={() => void handleBulkThreadAction("mark_read")}
                  icon={<MailOpen size={11} />}
                  label="Mark read"
                  disabled={busy}
                />
                <ActionBtn
                  onClick={() => void handleBulkThreadAction("trash")}
                  icon={<Trash2 size={11} />}
                  label="Trash"
                  variant="danger"
                  disabled={busy}
                />
                <ActionBtn
                  onClick={clearThreadSelection}
                  icon={<X size={11} />}
                  label="Clear"
                  disabled={busy}
                />
              </div>
            </div>
          )}

          {/* Search */}
          <div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}>
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

          {/* Categories (horizontal scroll) + compact sort segment — one row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginBottom: "8px",
              minWidth: 0,
            }}
          >
            <div
              aria-label="Filter by category"
              style={
                {
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  flexWrap: "nowrap",
                  overflowX: "auto",
                  flex: 1,
                  minWidth: 0,
                  scrollbarWidth: "thin",
                  paddingBottom: "2px",
                  WebkitOverflowScrolling: "touch",
                } as CSSProperties
              }
            >
              {categories.map((cat) => {
                const active = category === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      setCategory(cat.id as Any);
                      void loadThreads({ category: cat.id });
                    }}
                    style={{
                      padding: "3px 9px",
                      borderRadius: "999px",
                      fontSize: "0.72rem",
                      fontWeight: active ? 700 : 500,
                      border: active
                        ? "1px solid var(--color-accent)"
                        : "1px solid var(--color-border-subtle)",
                      background: active ? "var(--color-accent-subtle)" : "transparent",
                      color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                      cursor: "pointer",
                      transition: "background 0.12s ease, border-color 0.12s ease",
                      fontFamily: "var(--font-ui)",
                      flexShrink: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
            <div
              role="group"
              aria-label="Sort threads"
              style={{
                display: "flex",
                flexShrink: 0,
                borderRadius: "var(--radius-sm, 8px)",
                border: "1px solid var(--color-border-subtle)",
                overflow: "hidden",
                background: "var(--color-bg-secondary)",
              }}
            >
              {[
                { id: "recent" as const, label: "Recent" },
                { id: "priority" as const, label: "Priority" },
              ].map((sort, sortIndex) => {
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
                      padding: "4px 8px",
                      fontSize: "0.72rem",
                      fontWeight: active ? 700 : 600,
                      border: "none",
                      borderLeft:
                        sortIndex > 0 ? "1px solid var(--color-border-subtle)" : "none",
                      background: active ? "var(--color-accent-subtle)" : "transparent",
                      color: active ? "var(--color-accent)" : "var(--color-text-secondary)",
                      cursor: "pointer",
                      transition: "background 0.12s ease, color 0.12s ease",
                      fontFamily: "var(--font-ui)",
                      whiteSpace: "nowrap",
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
        </div>

        {/* Thread list */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px" }}>
          {displayedThreads.length === 0 && !busy && (
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
                {activeAccount ? "No threads yet for this account." : "No threads yet."}
                <br />
                Click the sync button to populate the inbox.
              </div>
            </div>
          )}
          {displayedThreads.length > 0 &&
            threadGroups.map((group) => (
              <div
                key={group.id}
                style={{
                  marginBottom: "10px",
                  padding: "10px",
                  borderRadius: "var(--radius-lg, 14px)",
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-secondary)",
                }}
              >
                {(group.label || group.description) && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: "12px",
                      marginBottom: "8px",
                      padding: "0 2px",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: "0.76rem",
                          fontWeight: 800,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                          color: "var(--color-text-primary)",
                        }}
                      >
                        {group.label}
                      </div>
                      <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", marginTop: "2px" }}>
                        {group.description}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: "0.7rem",
                        padding: "3px 8px",
                        borderRadius: "999px",
                        background: "var(--color-bg-elevated)",
                        color: "var(--color-text-muted)",
                        border: "1px solid var(--color-border-subtle)",
                      }}
                    >
                      {group.threads.length}
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {group.threads.map((thread) => {
                    const selected = selectedThreadId === thread.id;
                    const selectedForBulk = selectedThreadIds.includes(thread.id);
                    const badge = priorityBadge(thread.priorityBand);
                    const sender = thread.participants[0];
                    const accountLabel =
                      mailboxAccountById.get(thread.accountId)
                        ? formatMailboxAccountLabel(mailboxAccountById.get(thread.accountId)!)
                        : thread.accountId;
                    const summaryLabel = thread.summary?.suggestedNextAction || thread.snippet;
                    return (
                      <button
                        key={thread.id}
                        onClick={() => setSelectedThreadId(thread.id)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: "12px 12px 11px",
                          borderRadius: "var(--radius-md, 10px)",
                          border: selected
                            ? "1px solid var(--color-accent)"
                            : selectedForBulk
                              ? "1px solid rgba(34, 211, 238, 0.5)"
                              : "1px solid var(--color-border-subtle)",
                          background: selected
                            ? "linear-gradient(180deg, rgba(34, 211, 238, 0.12) 0%, var(--color-bg-elevated) 100%)"
                            : selectedForBulk
                              ? "rgba(34, 211, 238, 0.08)"
                              : "var(--color-bg-elevated)",
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
                          if (!selected && !selectedForBulk) {
                            (e.currentTarget as HTMLElement).style.background = "var(--color-bg-elevated)";
                          }
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                          <input
                            type="checkbox"
                            checked={selectedForBulk}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => toggleThreadSelection(thread.id)}
                            style={{
                              marginTop: "7px",
                              accentColor: "var(--color-accent)",
                              flexShrink: 0,
                            }}
                          />
                          <Avatar name={sender?.name} email={sender?.email} size={30} />
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
                                  fontWeight: thread.unreadCount > 0 ? 700 : 600,
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
                                fontSize: "0.84rem",
                                fontWeight: thread.unreadCount > 0 ? 700 : 600,
                                color: "var(--color-text-primary)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                marginBottom: "4px",
                              }}
                            >
                              {thread.subject}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "8px",
                                marginBottom: "6px",
                                flexWrap: "wrap",
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
                                  minWidth: 0,
                                }}
                              >
                                {summaryLabel}
                              </span>
                            </div>
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                              {mailboxAccounts.length > 1 && (
                                <span
                                  style={{
                                    fontSize: "0.64rem",
                                    padding: "2px 6px",
                                    borderRadius: "999px",
                                    background: "rgba(16,185,129,0.08)",
                                    color: "#0f766e",
                                    border: "1px solid rgba(16,185,129,0.16)",
                                    maxWidth: "160px",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={accountLabel}
                                >
                                  {accountLabel}
                                </span>
                              )}
                              <span
                                style={{
                                  fontSize: "0.64rem",
                                  padding: "2px 6px",
                                  borderRadius: "999px",
                                  background: "rgba(34, 211, 238, 0.08)",
                                  color: "var(--color-text-muted)",
                                  border: "1px solid var(--color-border-subtle)",
                                }}
                              >
                                {thread.messageCount} msg{thread.messageCount === 1 ? "" : "s"}
                              </span>
                              {thread.unreadCount > 0 && (
                                <span
                                  style={{
                                    fontSize: "0.64rem",
                                    padding: "2px 6px",
                                    borderRadius: "999px",
                                    background: "rgba(34, 211, 238, 0.12)",
                                    color: "var(--color-accent)",
                                    border: "1px solid rgba(34, 211, 238, 0.16)",
                                  }}
                                >
                                  {thread.unreadCount} unread
                                </span>
                              )}
                              {thread.needsReply && (
                                <span
                                  style={{
                                    fontSize: "0.64rem",
                                    padding: "2px 6px",
                                    borderRadius: "999px",
                                    background: "rgba(245,158,11,0.12)",
                                    color: "#b45309",
                                    border: "1px solid rgba(245,158,11,0.16)",
                                  }}
                                >
                                  Needs reply
                                </span>
                              )}
                              {thread.cleanupCandidate && (
                                <span
                                  style={{
                                    fontSize: "0.64rem",
                                    padding: "2px 6px",
                                    borderRadius: "999px",
                                    background: "rgba(148,163,184,0.12)",
                                    color: "var(--color-text-muted)",
                                    border: "1px solid rgba(148,163,184,0.16)",
                                  }}
                                >
                                  Cleanup
                                </span>
                              )}
                              {thread.hasSensitiveContent && (
                                <span
                                  style={{
                                    fontSize: "0.64rem",
                                    padding: "2px 6px",
                                    borderRadius: "999px",
                                    background: "rgba(239,68,68,0.12)",
                                    color: "#ef4444",
                                    border: "1px solid rgba(239,68,68,0.16)",
                                  }}
                                >
                                  Sensitive
                                </span>
                              )}
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
              </div>
            ))}
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
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
                  {mailboxAccounts.length > 1 && selectedThreadAccount && (
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "999px",
                        background: "rgba(16,185,129,0.08)",
                        color: "#0f766e",
                        fontSize: "0.68rem",
                        border: "1px solid rgba(16,185,129,0.16)",
                      }}
                    >
                      {formatMailboxAccountLabel(selectedThreadAccount)}
                    </span>
                  )}
                  <span
                    style={{
                      padding: "3px 8px",
                      borderRadius: "999px",
                      background: "var(--color-bg-secondary)",
                      color: "var(--color-text-secondary)",
                      fontSize: "0.68rem",
                      border: "1px solid var(--color-border-subtle)",
                    }}
                  >
                    {selectedThread.provider}
                  </span>
                  <span
                    style={{
                      padding: "3px 8px",
                      borderRadius: "999px",
                      background: selectedThread.needsReply
                        ? "rgba(245,158,11,0.12)"
                        : "var(--color-bg-secondary)",
                      color: selectedThread.needsReply ? "#b45309" : "var(--color-text-secondary)",
                      fontSize: "0.68rem",
                      border: "1px solid var(--color-border-subtle)",
                    }}
                  >
                    {selectedThread.needsReply ? "Needs reply" : "No reply needed"}
                  </span>
                  <span
                    style={{
                      padding: "3px 8px",
                      borderRadius: "999px",
                      background: "var(--color-bg-secondary)",
                      color: "var(--color-text-secondary)",
                      fontSize: "0.68rem",
                      border: "1px solid var(--color-border-subtle)",
                    }}
                  >
                    {selectedThread.messageCount} message{selectedThread.messageCount === 1 ? "" : "s"}
                  </span>
                  {selectedThread.commitments.length > 0 && (
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "999px",
                        background: "var(--color-bg-secondary)",
                        color: "var(--color-text-secondary)",
                        fontSize: "0.68rem",
                        border: "1px solid var(--color-border-subtle)",
                      }}
                    >
                      {selectedThread.commitments.length} commitment{selectedThread.commitments.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {selectedThread.sensitiveContent?.hasSensitiveContent && (
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "999px",
                        background: "rgba(239,68,68,0.12)",
                        color: "#ef4444",
                        fontSize: "0.68rem",
                        border: "1px solid rgba(239,68,68,0.16)",
                      }}
                    >
                      Sensitive content
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                <IconBtn
                  onClick={() =>
                    setMessageSortOrder((current) => (current === "newest" ? "oldest" : "newest"))
                  }
                  icon={<Clock size={13} />}
                  title={
                    messageSortOrder === "newest"
                      ? "Message order: newest first (click for oldest first)"
                      : "Message order: oldest first (click for newest first)"
                  }
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
                  title="Summarize thread with AI"
                />
                <IconBtn
                  onClick={() => void reclassifySelectedThread()}
                  icon={<RefreshCcw size={13} />}
                  title="Reclassify thread (triage labels)"
                  disabled={busy}
                />
                <IconBtn
                  onClick={() => void snoozeSelectedThread()}
                  icon={<Clock size={13} />}
                  title="Snooze or remind later"
                  disabled={busy}
                />
                <IconBtn
                  onClick={() =>
                    runAction(async () => {
                      await generateDraftForThread(selectedThread.id, {
                        tone: "concise",
                        includeAvailability: true,
                        manual: true,
                      });
                      await loadThread(selectedThread.id);
                    })
                  }
                  icon={<Reply size={13} />}
                  title="Draft a reply with AI"
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
                {stripMailboxSummaryHtmlArtifacts(selectedThread.summary.summary)}
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
              {selectedThread.sensitiveContent?.hasSensitiveContent && (
                <div
                  style={{
                    marginBottom: "10px",
                    padding: "8px 10px",
                    borderRadius: "var(--radius-sm, 8px)",
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.2)",
                    color: "var(--color-text-secondary)",
                    fontSize: "0.76rem",
                    lineHeight: 1.5,
                  }}
                >
                  Sensitive content detected. Review carefully before sending or automating this thread.
                </div>
              )}
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
                gridTemplateColumns: "1fr",
                gap: "12px",
              }}
            >
              {messageSections.map((section) => (
                <div
                  key={section.title}
                  style={{
                    border: "1px solid var(--color-border-subtle)",
                    borderRadius: "var(--radius-lg, 14px)",
                    background: "var(--color-bg-secondary)",
                    padding: "12px",
                    minWidth: 0,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <SectionLabel>{section.title}</SectionLabel>
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
                      {section.messages.length}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                    {section.messages.map((message) => renderMessageCard(message))}
                  </div>
                </div>
              ))}
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
            <ActionBtn
              onClick={() => void openHandoffPanel()}
              icon={<User size={13} />}
              label="Handoff"
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
            <div
              style={{
                marginBottom: "16px",
                padding: "14px",
                borderRadius: "var(--radius-lg, 14px)",
                background: "linear-gradient(180deg, rgba(34, 211, 238, 0.08) 0%, var(--color-bg-elevated) 100%)",
                border: "1px solid rgba(34, 211, 238, 0.18)",
              }}
            >
              <div
                style={{
                  fontSize: "0.68rem",
                  fontWeight: 800,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "var(--color-accent)",
                  marginBottom: "6px",
                }}
              >
                Next best action
              </div>
              <div
                style={{
                  fontSize: "0.84rem",
                  lineHeight: 1.55,
                  color: "var(--color-text-primary)",
                  marginBottom: "10px",
                  fontWeight: 600,
                }}
              >
                {selectedThread.summary?.suggestedNextAction ||
                  (selectedThread.drafts[0]
                    ? "Review the draft, then send or discard."
                    : selectedThread.needsReply
                      ? "Draft a response and check the commitments."
                      : selectedThread.commitments.length
                        ? "Review the commitments and decide what to accept."
                        : "Review the thread and decide whether it can be archived.")
                }
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                <span
                  style={{
                    padding: "4px 8px",
                    borderRadius: "999px",
                    background: "var(--color-bg-elevated)",
                    border: "1px solid var(--color-border-subtle)",
                    fontSize: "0.7rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {selectedThread.provider}
                </span>
                <span
                  style={{
                    padding: "4px 8px",
                    borderRadius: "999px",
                    background: "var(--color-bg-elevated)",
                    border: "1px solid var(--color-border-subtle)",
                    fontSize: "0.7rem",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {selectedThread.messageCount} message{selectedThread.messageCount === 1 ? "" : "s"}
                </span>
                <span
                  style={{
                    padding: "4px 8px",
                    borderRadius: "999px",
                    background: selectedThread.needsReply
                      ? "rgba(245,158,11,0.12)"
                      : "var(--color-bg-elevated)",
                    border: "1px solid var(--color-border-subtle)",
                    fontSize: "0.7rem",
                    color: selectedThread.needsReply ? "#b45309" : "var(--color-text-secondary)",
                  }}
                >
                  {selectedThread.needsReply ? "Needs reply" : "No reply needed"}
                </span>
              </div>
              {selectedThread.sensitiveContent?.hasSensitiveContent && (
                <div
                  style={{
                    marginTop: "10px",
                    padding: "9px 10px",
                    borderRadius: "var(--radius-sm, 8px)",
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.18)",
                    color: "var(--color-text-secondary)",
                    fontSize: "0.76rem",
                    lineHeight: 1.45,
                  }}
                >
                  Sensitive content detected. Review before forwarding or automating this thread.
                </div>
              )}
            </div>
          )}

          {selectedThread && (quickReplySuggestions.length > 0 || quickReplyError || quickReplySettled) && (
            <div style={{ marginBottom: "14px" }}>
              <SectionLabel>Quick replies</SectionLabel>
              {quickReplyError && (
                <div
                  style={{
                    marginTop: "6px",
                    fontSize: "0.72rem",
                    color: "#b45309",
                    lineHeight: 1.45,
                  }}
                >
                  {quickReplyError}
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px" }}>
                {quickReplySuggestions.map((text, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      if (selectedThreadReplyTargets.length > 0) {
                        setReplyMessage(text);
                        openReplyComposer(selectedThreadReplyTargets[0].handleId);
                      } else {
                        void copyTextToClipboard(text);
                      }
                    }}
                    style={{
                      textAlign: "left",
                      maxWidth: "100%",
                      padding: "8px 10px",
                      borderRadius: "var(--radius-sm, 8px)",
                      border: "1px solid var(--color-border-subtle)",
                      background: "var(--color-bg-secondary)",
                      color: "var(--color-text-primary)",
                      fontSize: "0.74rem",
                      lineHeight: 1.4,
                      cursor: "pointer",
                    }}
                  >
                    {text.length > 120 ? `${text.slice(0, 120)}…` : text}
                  </button>
                ))}
              </div>
              {quickReplySettled && !quickReplyError && quickReplySuggestions.length === 0 && (
                <div
                  style={{
                    marginTop: "6px",
                    fontSize: "0.72rem",
                    color: "var(--color-text-muted)",
                    lineHeight: 1.45,
                  }}
                >
                  No quick reply suggestions for this thread.
                </div>
              )}
              {!selectedThreadReplyTargets.length && quickReplySuggestions.length > 0 && (
                <div
                  style={{
                    marginTop: "6px",
                    fontSize: "0.7rem",
                    color: "var(--color-text-muted)",
                  }}
                >
                  Tip: click to copy to clipboard, then paste into your mail client or a generated draft.
                </div>
              )}
            </div>
          )}

          {selectedThreadReplyTargets.length ? (
            <div style={{ marginBottom: "16px" }}>
              <SectionLabel>Reply via</SectionLabel>
              <div style={{ display: "grid", gap: "8px" }}>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {selectedThreadReplyTargets.map((target) => (
                    <ActionBtn
                      key={target.handleId}
                      onClick={() => openReplyComposer(target.handleId)}
                      icon={<Reply size={11} />}
                      label={`Reply via ${formatChannelLabel(target.channelType)}`}
                      variant={recommendedReplyTarget?.handleId === target.handleId ? "primary" : "default"}
                      title={
                        recommendedReplyTarget?.handleId === target.handleId
                          ? "Recommended target based on recent activity"
                          : target.lastMessageAt
                            ? `Last active ${formatFullTime(target.lastMessageAt)}`
                            : target.displayValue
                      }
                      disabled={busy}
                    />
                    ))}
                </div>
                {replyChannelType && (
                  <div
                    style={{
                      padding: "12px 14px",
                      borderRadius: "var(--radius-md, 10px)",
                      border: "1px solid var(--color-border-subtle)",
                      background: "var(--color-bg-secondary)",
                    }}
                  >
                    <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--color-text-primary)" }}>
                      Reply via {formatChannelLabel(replyChannelType)}
                    </div>
                    <div style={{ marginTop: "4px", fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
                      Choose the channel target, write the reply, then send it.
                    </div>
                    <textarea
                      value={replyMessage}
                      onChange={(event) => setReplyMessage(event.target.value)}
                      rows={5}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        marginTop: "10px",
                        padding: "10px 12px",
                        borderRadius: "var(--radius-sm, 8px)",
                        border: "1px solid var(--color-border)",
                        background: "var(--color-bg-input)",
                        color: "var(--color-text-primary)",
                        fontSize: "0.78rem",
                        resize: "vertical",
                        lineHeight: 1.5,
                      }}
                    />
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }}>
                      <ActionBtn
                        onClick={() => void sendReplyViaChannel()}
                        icon={<Send size={11} />}
                        label="Send reply"
                        variant="primary"
                        disabled={busy || !replyMessage.trim()}
                      />
                      <ActionBtn
                        onClick={() => {
                          setReplyChannelType(null);
                          setReplyTargetHandleId(null);
                          setReplyMessage("");
                        }}
                        icon={<X size={11} />}
                        label="Cancel"
                        disabled={busy}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {selectedThread && handoffPanelOpen && (
            <div style={{ marginBottom: "16px" }}>
              <SectionLabel>Mission Control Handoff</SectionLabel>
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "var(--radius-md, 10px)",
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-secondary)",
                }}
              >
                <div
                  style={{
                    fontSize: "0.76rem",
                    color: "var(--color-text-muted)",
                    lineHeight: 1.5,
                    marginBottom: "10px",
                  }}
                >
                  Create a company issue from this thread, assign the operator, then wake them immediately.
                </div>

                <div style={{ display: "grid", gap: "8px", marginBottom: "10px" }}>
                  <label style={{ display: "grid", gap: "4px" }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
                      Company
                    </span>
                    <select
                      value={handoffCompanyId}
                      onChange={(event) => {
                        setHandoffCompanyId(event.target.value);
                        setHandoffCompanyConfirmed(false);
                      }}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "7px 10px",
                        borderRadius: "var(--radius-sm, 8px)",
                        border: "1px solid var(--color-border)",
                        background: "var(--color-bg-input)",
                        color: "var(--color-text-primary)",
                        fontSize: "0.78rem",
                      }}
                    >
                      <option value="">Select company</option>
                      {companyCandidates.map((candidate) => (
                        <option key={candidate.companyId} value={candidate.companyId}>
                          {candidate.name}
                          {candidate.confidence >= 0.7 ? " · recommended" : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  {handoffCompanyId && (
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "0.74rem",
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={handoffCompanyConfirmed}
                        onChange={(event) => setHandoffCompanyConfirmed(event.target.checked)}
                      />
                      Confirm target company
                    </label>
                  )}

                  <label style={{ display: "grid", gap: "4px" }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
                      Operator
                    </span>
                    <select
                      value={handoffOperatorRoleId}
                      onChange={(event) => setHandoffOperatorRoleId(event.target.value)}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "7px 10px",
                        borderRadius: "var(--radius-sm, 8px)",
                        border: "1px solid var(--color-border)",
                        background: "var(--color-bg-input)",
                        color: "var(--color-text-primary)",
                        fontSize: "0.78rem",
                      }}
                    >
                      <option value="">Select operator</option>
                      {selectedCompanyRoles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.displayName}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={{ display: "grid", gap: "4px" }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
                      Issue title
                    </span>
                    <input
                      value={handoffIssueTitle}
                      onChange={(event) => setHandoffIssueTitle(event.target.value)}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "7px 10px",
                        borderRadius: "var(--radius-sm, 8px)",
                        border: "1px solid var(--color-border)",
                        background: "var(--color-bg-input)",
                        color: "var(--color-text-primary)",
                        fontSize: "0.78rem",
                      }}
                    />
                  </label>

                  <label style={{ display: "grid", gap: "4px" }}>
                    <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>
                      Issue summary
                    </span>
                    <textarea
                      value={handoffIssueSummary}
                      onChange={(event) => setHandoffIssueSummary(event.target.value)}
                      rows={6}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "8px 10px",
                        borderRadius: "var(--radius-sm, 8px)",
                        border: "1px solid var(--color-border)",
                        background: "var(--color-bg-input)",
                        color: "var(--color-text-primary)",
                        fontSize: "0.76rem",
                        resize: "vertical",
                        lineHeight: 1.45,
                      }}
                    />
                  </label>
                </div>

                {handoffPreview?.sensitiveContentRedacted && (
                  <div
                    style={{
                      marginBottom: "10px",
                      padding: "9px 10px",
                      borderRadius: "var(--radius-sm, 8px)",
                      background: "rgba(239,68,68,0.08)",
                      border: "1px solid rgba(239,68,68,0.18)",
                      color: "var(--color-text-secondary)",
                      fontSize: "0.74rem",
                      lineHeight: 1.45,
                    }}
                  >
                    Sensitive content detected. The handoff uses summary-level context and mailbox evidence refs only.
                  </div>
                )}

                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: handoffRecords.length ? "12px" : 0 }}>
                  <ActionBtn
                    onClick={() => void createMissionControlHandoff()}
                    icon={<CheckSquare size={11} />}
                    label="Create issue & wake operator"
                    variant="primary"
                    disabled={busy || !handoffCompanyId || !handoffOperatorRoleId || !handoffIssueTitle.trim()}
                  />
                  <ActionBtn
                    onClick={() => setHandoffPanelOpen(false)}
                    icon={<X size={11} />}
                    label="Close"
                    disabled={busy}
                  />
                </div>

                {handoffRecords.length > 0 && (
                  <div style={{ display: "grid", gap: "8px", marginTop: "10px" }}>
                    {handoffRecords.map((record) => (
                      <div
                        key={record.id}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "var(--radius-sm, 8px)",
                          background: "var(--color-bg-elevated)",
                          border: "1px solid var(--color-border-subtle)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "8px",
                            marginBottom: "4px",
                          }}
                        >
                          <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--color-text-primary)" }}>
                            {record.issueTitle}
                          </div>
                          <span className="mc-v2-ops-pill">{record.issueStatus}</span>
                        </div>
                        <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", lineHeight: 1.45 }}>
                          {record.companyName} · {record.operatorDisplayName}
                          {record.latestOutcome ? ` · ${record.latestOutcome}` : ""}
                        </div>
                        {onOpenMissionControlIssue && (
                          <div style={{ marginTop: "8px" }}>
                            <button
                              type="button"
                              className="mc-v2-icon-btn"
                              onClick={() => onOpenMissionControlIssue(record.companyId, record.issueId)}
                              style={{ fontSize: "0.72rem" }}
                            >
                              Open in Mission Control
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {selectedThread && (
            <div style={{ marginBottom: "16px" }}>
              <SectionLabel>Automations</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", marginBottom: "10px" }}>
                <ActionBtn
                  onClick={() => void createRuleFromCurrentContext()}
                  icon={<Sparkles size={13} />}
                  label="Rule from context"
                  disabled={busy}
                />
                <ActionBtn
                  onClick={() => void snoozeSelectedThread()}
                  icon={<Clock size={13} />}
                  label="Remind later"
                  disabled={busy}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", marginBottom: "10px" }}>
                <ActionBtn
                  onClick={() => {
                    if (!selectedThread) return;
                    setLabelSimilarName(selectedThread.subject?.slice(0, 120) || "My saved view");
                    setLabelSimilarInstructions(
                      "Threads similar to this conversation (topic, sender type, or action requested).",
                    );
                    setLabelSimilarShowInInbox(true);
                    resetLabelSimilarPreview();
                    setLabelSimilarOpen(true);
                  }}
                  icon={<MailSearch size={13} />}
                  label="Label similar…"
                  disabled={busy || !selectedThread}
                />
                <ActionBtn
                  onClick={() =>
                    runAction(async () => {
                      if (!selectedSavedViewId) {
                        setError("Select a saved view in the sidebar first.");
                        return;
                      }
                      await window.electronAPI.createMailboxSavedViewReviewSchedule(selectedSavedViewId);
                      await loadAutomations(selectedThread?.id);
                    })
                  }
                  icon={<Calendar size={13} />}
                  label="Weekly view review"
                  disabled={busy || !selectedSavedViewId}
                />
              </div>
              <div style={{ marginBottom: "10px" }}>
                <SectionLabel>Snippets</SectionLabel>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <select
                    aria-label="Insert snippet"
                    defaultValue=""
                    onChange={(event) => {
                      const id = event.target.value;
                      event.target.value = "";
                      if (!id) return;
                      const sn = snippets.find((entry) => entry.id === id);
                      if (!sn) return;
                      if (selectedThreadReplyTargets.length > 0) {
                        openReplyComposer(selectedThreadReplyTargets[0].handleId);
                        setReplyMessage((prev) => (prev.trim() ? `${prev}\n\n${sn.body}` : sn.body));
                      } else {
                        void copyTextToClipboard(sn.body);
                      }
                    }}
                    style={{
                      flex: 1,
                      minWidth: "140px",
                      padding: "6px 8px",
                      borderRadius: "8px",
                      border: "1px solid var(--color-border-subtle)",
                      background: "var(--color-bg-input)",
                      color: "var(--color-text-primary)",
                      fontSize: "0.72rem",
                    }}
                  >
                    <option value="">Insert snippet…</option>
                    {snippets.map((sn) => (
                      <option key={sn.id} value={sn.id}>
                        {sn.shortcut}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="mc-v2-icon-btn"
                    onClick={() => {
                      setSnippetShortcutDraft("");
                      setSnippetBodyDraft("");
                      setSnippetModalOpen(true);
                    }}
                    style={{ fontSize: "0.72rem" }}
                  >
                    New snippet
                  </button>
                </div>
              </div>
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: "var(--radius-md, 10px)",
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-secondary)",
                }}
              >
                {selectedThreadAutomations.length ? (
                  <div style={{ display: "grid", gap: "8px" }}>
                    {selectedThreadAutomations.map((automation) => (
                      <div
                        key={automation.id}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "var(--radius-sm, 8px)",
                          background: "var(--color-bg-elevated)",
                          border: "1px solid var(--color-border-subtle)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", justifyContent: "space-between" }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: "0.82rem",
                                fontWeight: 600,
                                color: "var(--color-text-primary)",
                                marginBottom: "3px",
                              }}
                            >
                              {automation.name}
                            </div>
                            <div
                              style={{
                                fontSize: "0.72rem",
                                color: "var(--color-text-muted)",
                                lineHeight: 1.45,
                              }}
                            >
                              {automation.kind}
                              {" · "}
                              {automation.status}
                              {automation.latestOutcome ? ` · ${automation.latestOutcome}` : ""}
                              {automation.nextRunAt ? ` · Next ${formatFullTime(automation.nextRunAt)}` : ""}
                              {automation.latestFireAt ? ` · Fired ${formatFullTime(automation.latestFireAt)}` : ""}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              void runAction(async () => {
                                if (automation.kind === "rule") {
                                  await window.electronAPI.deleteMailboxRule(automation.id);
                                } else {
                                  await window.electronAPI.deleteMailboxSchedule(automation.id);
                                }
                                await reloadAll(selectedThread.id);
                              })
                            }
                            style={{
                              border: "1px solid var(--color-border-subtle)",
                              background: "var(--color-bg-secondary)",
                              borderRadius: "999px",
                              color: "var(--color-text-muted)",
                              fontSize: "0.68rem",
                              padding: "2px 8px",
                              cursor: "pointer",
                              flexShrink: 0,
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    style={{
                      fontSize: "0.78rem",
                      color: "var(--color-text-muted)",
                      lineHeight: 1.5,
                    }}
                  >
                    No automations are attached to this thread yet.
                  </div>
                )}
              </div>
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
                  disabled={
                    busy ||
                    selectedThread.unreadCount === 0 ||
                    (selectedThread.provider === "gmail" && !gmailCleanupActionsEnabled)
                  }
                  title={
                    selectedThread.provider === "gmail" && gmailCleanupDisabledReason
                      ? gmailCleanupDisabledReason
                      : undefined
                  }
                />
                <ActionBtn
                  onClick={() => void handleThreadAction("archive")}
                  icon={<Archive size={13} />}
                  label="Archive"
                  disabled={
                    busy ||
                    selectedThread.provider !== "gmail" ||
                    !gmailCleanupActionsEnabled
                  }
                  title={
                    selectedThread.provider === "gmail" && gmailCleanupDisabledReason
                      ? gmailCleanupDisabledReason
                      : undefined
                  }
                />
                <ActionBtn
                  onClick={() => void handleThreadAction("trash")}
                  icon={<Trash2 size={13} />}
                  label="Trash"
                  variant="danger"
                  disabled={
                    busy ||
                    selectedThread.provider !== "gmail" ||
                    !gmailCleanupActionsEnabled
                  }
                  title={
                    selectedThread.provider === "gmail" && gmailCleanupDisabledReason
                      ? gmailCleanupDisabledReason
                      : undefined
                  }
                />
              </div>
              {selectedThreadNeedsGmailCleanupAttention && (
                <div
                  style={{
                    marginTop: "8px",
                    fontSize: "0.74rem",
                    lineHeight: 1.45,
                    color: "var(--color-text-muted)",
                  }}
                >
                  {gmailCleanupDisabledReason}
                </div>
              )}
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
              {queueProposals.map((proposal) => {
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
                );
              })}
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
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "8px", justifyContent: "space-between" }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: "0.84rem",
                        color: "var(--color-text-primary)",
                        marginBottom: "4px",
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      {commitment.title}
                    </div>
                    <button
                      type="button"
                      onClick={() => beginCommitmentEdit(commitment)}
                      style={{
                        border: "1px solid var(--color-border-subtle)",
                        background: "var(--color-bg-elevated)",
                        borderRadius: "999px",
                        color: "var(--color-text-secondary)",
                        fontSize: "0.68rem",
                        padding: "2px 8px",
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      Edit
                    </button>
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
                  {editingCommitmentId === commitment.id ? (
                    <div
                      style={{
                        display: "grid",
                        gap: "8px",
                        marginTop: "8px",
                        padding: "10px",
                        borderRadius: "var(--radius-md, 10px)",
                        background: "var(--color-bg-elevated)",
                        border: "1px solid var(--color-border-subtle)",
                      }}
                    >
                      <input
                        value={editingCommitmentTitle}
                        onChange={(event) => setEditingCommitmentTitle(event.target.value)}
                        placeholder="Commitment title"
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "7px 10px",
                          borderRadius: "var(--radius-sm, 8px)",
                          border: "1px solid var(--color-border)",
                          background: "var(--color-bg-input)",
                          color: "var(--color-text-primary)",
                          fontSize: "0.78rem",
                        }}
                      />
                      <input
                        type="datetime-local"
                        value={editingCommitmentDueAt}
                        onChange={(event) => setEditingCommitmentDueAt(event.target.value)}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "7px 10px",
                          borderRadius: "var(--radius-sm, 8px)",
                          border: "1px solid var(--color-border)",
                          background: "var(--color-bg-input)",
                          color: "var(--color-text-primary)",
                          fontSize: "0.78rem",
                        }}
                      />
                      <input
                        value={editingCommitmentOwnerEmail}
                        onChange={(event) => setEditingCommitmentOwnerEmail(event.target.value)}
                        placeholder="Owner email"
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "7px 10px",
                          borderRadius: "var(--radius-sm, 8px)",
                          border: "1px solid var(--color-border)",
                          background: "var(--color-bg-input)",
                          color: "var(--color-text-primary)",
                          fontSize: "0.78rem",
                        }}
                      />
                      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        <ActionBtn
                          onClick={() => void saveCommitmentEdit(commitment)}
                          icon={<CheckSquare size={11} />}
                          label="Save"
                          variant="primary"
                          disabled={busy}
                        />
                        <ActionBtn
                          onClick={cancelCommitmentEdit}
                          icon={<X size={11} />}
                          label="Cancel"
                          disabled={busy}
                        />
                      </div>
                    </div>
                  ) : (
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
                        variant={
                          commitment.state === "accepted" && commitment.followUpTaskId ? "default" : "primary"
                        }
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
                  )}
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
                {selectedThread.research.contactIdentityId && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      fontSize: "0.74rem",
                      color: "var(--color-text-muted)",
                      marginBottom: "6px",
                    }}
                  >
                    Identity confidence: {Math.round((selectedThread.research.identityConfidence || 0) * 100)}%
                  </div>
                )}
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
                {!!selectedThread.research.relatedEntities?.length && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      marginTop: "8px",
                      fontSize: "0.76rem",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    Related: {selectedThread.research.relatedEntities.join(" · ")}
                  </div>
                )}
                {!!selectedThread.research.linkedChannels?.length && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      marginTop: "8px",
                      fontSize: "0.76rem",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    Linked channels:{" "}
                    {selectedThread.research.linkedChannels
                      .map((channel) => channel.channelType || channel.handleType)
                      .join(" · ")}
                  </div>
                )}
                {!!selectedThread.research.identityCandidates?.length &&
                  !selectedThread.research.linkedChannels?.length && (
                    <div
                      style={{
                        paddingLeft: "19px",
                        marginTop: "8px",
                        fontSize: "0.76rem",
                        color: "var(--color-warning, #c47f00)",
                        lineHeight: 1.5,
                      }}
                    >
                      Possible matches:{" "}
                      {selectedThread.research.identityCandidates
                        .slice(0, 3)
                        .map((candidate) => candidate.sourceLabel)
                        .join(" · ")}
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
                {selectedThread.research.channelPreference?.recommendedReason && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      marginTop: "8px",
                      fontSize: "0.76rem",
                      color: "var(--color-text-secondary)",
                      lineHeight: 1.5,
                    }}
                  >
                    Channel recommendation: {selectedThread.research.channelPreference.recommendedReason}
                  </div>
                )}
                {!!selectedThread.research.unifiedTimeline?.length && (
                  <div
                    style={{
                      paddingLeft: "19px",
                      marginTop: "10px",
                      display: "grid",
                      gap: "8px",
                    }}
                  >
                    <div style={{ fontSize: "0.74rem", color: "var(--color-text-muted)" }}>
                      Unified timeline
                    </div>
                    {selectedThread.research.unifiedTimeline.slice(0, 5).map((event) => (
                      <div
                        key={event.id}
                        style={{
                          padding: "8px 10px",
                          borderRadius: "8px",
                          border: "1px solid var(--color-border-subtle)",
                          background: "var(--color-bg-elevated)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: "8px",
                            fontSize: "0.72rem",
                            color: "var(--color-text-muted)",
                          }}
                        >
                          <span>{event.sourceLabel}</span>
                          <span>{formatTime(event.timestamp)}</span>
                        </div>
                        <div
                          style={{
                            marginTop: "3px",
                            fontSize: "0.76rem",
                            color: "var(--color-text-primary)",
                            fontWeight: 600,
                          }}
                        >
                          {event.title}
                        </div>
                        <div
                          style={{
                            marginTop: "2px",
                            fontSize: "0.74rem",
                            color: "var(--color-text-secondary)",
                            lineHeight: 1.45,
                          }}
                        >
                          {event.summary}
                        </div>
                      </div>
                    ))}
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

      {labelSimilarOpen && selectedThread && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 1200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
          onClick={() => {
            if (!labelSimilarBusy) setLabelSimilarOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mailbox-label-similar-title"
            onClick={(event) => event.stopPropagation()}
            style={{
              maxWidth: 520,
              width: "100%",
              maxHeight: "90vh",
              overflow: "auto",
              padding: "20px",
              borderRadius: "14px",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <h3 id="mailbox-label-similar-title" style={{ margin: "0 0 12px", fontSize: "1rem" }}>
              Saved view (similar threads)
            </h3>
            <label style={{ display: "grid", gap: 4, marginBottom: 10 }}>
              <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>Name</span>
              <input
                value={labelSimilarName}
                onChange={(event) => {
                  setLabelSimilarName(event.target.value);
                  resetLabelSimilarPreview();
                }}
                style={{
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.8rem",
                }}
              />
            </label>
            <label style={{ display: "grid", gap: 4, marginBottom: 12 }}>
              <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>Instructions</span>
              <textarea
                value={labelSimilarInstructions}
                onChange={(event) => {
                  setLabelSimilarInstructions(event.target.value);
                  resetLabelSimilarPreview();
                }}
                rows={3}
                style={{
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.8rem",
                  resize: "vertical",
                }}
              />
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 12,
                fontSize: "0.78rem",
                color: "var(--color-text-secondary)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={labelSimilarShowInInbox}
                onChange={(event) => setLabelSimilarShowInInbox(event.target.checked)}
              />
              Show matching threads in the main inbox list
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <button
                type="button"
                className="mc-v2-icon-btn"
                disabled={labelSimilarBusy}
                onClick={() =>
                  runAction(async () => {
                    if (!selectedThread) return;
                    setLabelSimilarBusy(true);
                    setLabelSimilarError(null);
                    try {
                      const r = await window.electronAPI.previewMailboxSavedViewSimilar({
                        seedThreadId: selectedThread.id,
                        name: labelSimilarName,
                        instructions: labelSimilarInstructions,
                      });
                      setLabelSimilarPreviewIds(r.threadIds);
                      setLabelSimilarRationale(r.rationale || null);
                      setLabelSimilarError(r.error || null);
                      setLabelSimilarDidPreview(true);
                    } finally {
                      setLabelSimilarBusy(false);
                    }
                  })
                }
              >
                Preview matches
              </button>
              <button
                type="button"
                className="mc-v2-icon-btn"
                disabled={labelSimilarBusy || !labelSimilarPreviewIds.length}
                onClick={() =>
                  runAction(async () => {
                    if (!selectedThread) return;
                    setLabelSimilarBusy(true);
                    try {
                      await window.electronAPI.createMailboxSavedView({
                        name: labelSimilarName,
                        instructions: labelSimilarInstructions,
                        seedThreadId: selectedThread.id,
                        threadIds: labelSimilarPreviewIds,
                        showInInbox: labelSimilarShowInInbox,
                      });
                      await loadSavedViewsAndSnippets();
                      setLabelSimilarOpen(false);
                    } finally {
                      setLabelSimilarBusy(false);
                    }
                  })
                }
              >
                Save view
              </button>
              <button
                type="button"
                className="mc-v2-icon-btn"
                disabled={labelSimilarBusy}
                onClick={() => setLabelSimilarOpen(false)}
              >
                Cancel
              </button>
            </div>
            {labelSimilarError && (
              <p style={{ fontSize: "0.74rem", color: "#b45309", lineHeight: 1.45, marginBottom: 8 }}>
                {labelSimilarError}
              </p>
            )}
            {labelSimilarRationale && (
              <p style={{ fontSize: "0.74rem", color: "var(--color-text-muted)", lineHeight: 1.45 }}>
                {labelSimilarRationale}
              </p>
            )}
            {labelSimilarPreviewIds.length > 0 && (
              <p style={{ fontSize: "0.72rem", color: "var(--color-text-secondary)" }}>
                {labelSimilarPreviewIds.length} thread{labelSimilarPreviewIds.length === 1 ? "" : "s"} will be linked
                to this view.
              </p>
            )}
            {!labelSimilarBusy && !labelSimilarError && !labelSimilarDidPreview && (
              <p style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", lineHeight: 1.45 }}>
                Run Preview matches to find similar threads from your current mailbox (recent slice). If none appear,
                try a clearer name and instructions.
              </p>
            )}
            {!labelSimilarBusy &&
              !labelSimilarError &&
              labelSimilarDidPreview &&
              labelSimilarPreviewIds.length === 0 && (
              <p style={{ fontSize: "0.72rem", color: "var(--color-text-muted)", lineHeight: 1.45 }}>
                No similar threads in the current preview slice. Adjust instructions or sync more mail and try again.
              </p>
            )}
          </div>
        </div>
      )}

      {snippetModalOpen && (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1200,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
          onMouseDown={() => setSnippetModalOpen(false)}
        >
          <div
            role="dialog"
            aria-labelledby="mailbox-snippet-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "420px",
              padding: "20px",
              borderRadius: "14px",
              background: "var(--color-bg-elevated)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <h3 id="mailbox-snippet-modal-title" style={{ margin: "0 0 12px", fontSize: "1rem" }}>
              New snippet
            </h3>
            <label style={{ display: "grid", gap: 4, marginBottom: 10 }}>
              <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>Label (menu)</span>
              <input
                value={snippetShortcutDraft}
                onChange={(event) => setSnippetShortcutDraft(event.target.value)}
                style={{
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.8rem",
                }}
              />
            </label>
            <label style={{ display: "grid", gap: 4, marginBottom: 12 }}>
              <span style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>Body</span>
              <textarea
                value={snippetBodyDraft}
                onChange={(event) => setSnippetBodyDraft(event.target.value)}
                rows={5}
                style={{
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: "1px solid var(--color-border)",
                  background: "var(--color-bg-input)",
                  color: "var(--color-text-primary)",
                  fontSize: "0.8rem",
                  resize: "vertical",
                }}
              />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="mc-v2-icon-btn" onClick={() => setSnippetModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="mc-v2-icon-btn"
                onClick={() => {
                  const shortcut = snippetShortcutDraft.trim();
                  const body = snippetBodyDraft.trim();
                  if (!shortcut || !body) return;
                  void runAction(async () => {
                    await window.electronAPI.upsertMailboxSnippet({ shortcut, body });
                    await loadSavedViewsAndSnippets();
                    setSnippetModalOpen(false);
                  });
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
